'use strict';
/* ChatGraphic · install.js 单元测试（全部针对临时 settings 文件，不碰真实配置） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../install.js');

const USER_SETTINGS = path.join(os.homedir(), '.codely-cli', 'settings.json');

/** 造一个虚拟项目：<root>/proj/.codely-cli/extensions/chatgraphic/chatgraphic（hookDir 仅做路径运算，无需真实文件） */
function mkProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-proj-'));
  const projectRoot = path.join(root, 'proj');
  const hookDir = path.join(projectRoot, '.codely-cli', 'extensions', 'chatgraphic', 'chatgraphic');
  const settings = path.join(projectRoot, '.codely-cli', 'settings.json');
  return { root, projectRoot, hookDir, settings };
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('项目级注册：写入 $CODELY_PROJECT_DIR 可移植命令；幂等；卸载完全还原', () => {
  const { hookDir, settings, projectRoot } = mkProject();
  const r1 = I.installTo(settings, hookDir);
  assert.strictEqual(r1.changed, true);
  assert.strictEqual(r1.scope, '项目级');
  const s1 = read(settings);
  const expected = 'node $CODELY_PROJECT_DIR/' + path.relative(projectRoot, path.join(hookDir, 'hook.js')).split(path.sep).join('/');
  assert.strictEqual(s1.hooks.AfterAgent[0].hooks[0].command, expected, '项目级应为项目根锚定的可移植命令');

  const r2 = I.installTo(settings, hookDir);
  assert.strictEqual(r2.changed, false, '幂等跳过');
  assert.strictEqual(read(settings).hooks.AfterAgent[0].hooks.length, 1);

  I.uninstallFrom(settings, hookDir);
  assert.strictEqual(read(settings).hooks, undefined, 'hooks 空壳应整体还原');
});

test('幂等安装时清理重复注册（旧版 Windows 缺陷遗留场景）', () => {
  const { hookDir, settings } = mkProject();
  I.installTo(settings, hookDir);
  const s = read(settings);
  s.hooks.AfterAgent.push(JSON.parse(JSON.stringify(s.hooks.AfterAgent[0]))); // 模拟旧版缺陷产物：同命令两条
  fs.writeFileSync(settings, JSON.stringify(s));
  const r = I.installTo(settings, hookDir);
  assert.strictEqual(r.changed, false, '仍识别为已安装');
  const ours = read(settings).hooks.AfterAgent.flatMap(g => g.hooks || []).filter(h => I.isOurs(h, hookDir, settings));
  assert.strictEqual(ours.length, 1, '重复条目应被清理，仅保留一条');
  I.uninstallFrom(settings, hookDir);
  assert.strictEqual(read(settings).hooks, undefined, '清理后仍可完全卸载');
});

test('幂等安装时迁移旧格式命令（引号写法 → 无引号规范写法）', () => {
  const { hookDir, settings, projectRoot } = mkProject();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  const rel = path.relative(projectRoot, path.join(hookDir, 'hook.js')).split(path.sep).join('/');
  // v0.2.5 及更早的引号写法：Codely 展开占位符时自动 shell 转义，引号进入路径 → 运行时找不到模块
  fs.writeFileSync(settings, JSON.stringify({
    hooks: { enabled: true, AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: 'node "$CODELY_PROJECT_DIR/' + rel + '"', timeout: 10000 }] }] }
  }));
  const r = I.installTo(settings, hookDir);
  assert.strictEqual(r.changed, false, '识别为已安装');
  assert.strictEqual(read(settings).hooks.AfterAgent[0].hooks[0].command, 'node $CODELY_PROJECT_DIR/' + rel, '应迁移为无引号规范写法');
});

test('hookCmdOf：用户级用绝对路径，项目级用 $CODELY_PROJECT_DIR（纯函数，不写文件）', () => {
  const userDir = path.join('/x', 'chatgraphic');
  assert.strictEqual(I.hookCmdOf(USER_SETTINGS, userDir), 'node "' + path.join(userDir, 'hook.js') + '"');
  assert.strictEqual(
    I.hookCmdOf('/x/proj/.codely-cli/settings.json', '/x/proj/.codely-cli/extensions/chatgraphic/chatgraphic'),
    'node $CODELY_PROJECT_DIR/.codely-cli/extensions/chatgraphic/chatgraphic/hook.js'
  );
});

test('兼容旧版绝对路径写法：识别、不重复注册、可卸载', () => {
  const { hookDir, settings } = mkProject();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    hooks: { enabled: true, AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: 'node "' + path.join(hookDir, 'hook.js') + '"' }] }] }
  }));
  const r = I.installTo(settings, hookDir);
  assert.strictEqual(r.changed, false, '旧绝对路径写法应被识别为已安装');
  assert.strictEqual(read(settings).hooks.AfterAgent[0].hooks.length, 1, '不得重复注册');
  I.uninstallFrom(settings, hookDir);
  assert.strictEqual(read(settings).hooks, undefined);
});

test('保留已有 hooks 配置与他人 Hook、无关顶层键', () => {
  const { hookDir, settings } = mkProject();
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({
    unityInsight: { enabled: true },
    hooks: { enabled: true, AfterAgent: [{ matcher: 'x', hooks: [{ type: 'command', command: 'node other.js' }] }] }
  }));
  I.installTo(settings, hookDir);
  assert.strictEqual(read(settings).hooks.AfterAgent.length, 2, '应追加而非覆盖');
  I.uninstallFrom(settings, hookDir);
  const s = read(settings);
  assert.strictEqual(s.hooks.AfterAgent.length, 1, '只移除自己的条目');
  assert.strictEqual(s.hooks.AfterAgent[0].hooks[0].command, 'node other.js', '他人 Hook 不受影响');
  assert.strictEqual(s.hooks.enabled, true, 'hooks 配置键保留');
  assert.deepStrictEqual(s.unityInsight, { enabled: true }, '无关顶层键保留');
});

test('未安装时卸载为 no-op（不创建文件）', () => {
  const { hookDir, settings } = mkProject();
  const r = I.uninstallFrom(settings, hookDir);
  assert.strictEqual(r.changed, false);
  assert.ok(!fs.existsSync(settings), '未安装时不得创建 settings 文件');
});

test('statusOf 报告安装状态与作用域', () => {
  const { hookDir, settings } = mkProject();
  assert.strictEqual(I.statusOf(settings, hookDir).installed, false);
  I.installTo(settings, hookDir);
  const st = I.statusOf(settings, hookDir);
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.scope, '项目级');
  I.uninstallFrom(settings, hookDir);
  assert.strictEqual(I.statusOf(settings, hookDir).installed, false);
});

/* ---------- 注册位置解析（作用域跟随安装位置） ---------- */
test('resolveSettingsPath：workspace 作用域 → 项目级；用户作用域 → 用户级', () => {
  const proj = path.join(os.tmpdir(), 'cg-ws', 'MyProject'); // 平台原生路径，避免 POSIX 字面路径在 Windows 失真
  const ws = path.join(proj, '.codely-cli', 'extensions', 'chatgraphic', 'chatgraphic');
  const us = path.join(os.homedir(), '.codely-cli', 'extensions', 'chatgraphic', 'chatgraphic');
  assert.strictEqual(I.resolveSettingsPath(ws), path.join(proj, '.codely-cli', 'settings.json'), 'workspace → 项目 settings');
  assert.strictEqual(I.resolveSettingsPath(us), USER_SETTINGS, '用户作用域 → 用户 settings');
});

test('resolveSettingsPath：普通克隆向上找项目；无项目则兜底用户级', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-'));
  fs.mkdirSync(path.join(root, '.codely-cli'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'chatgraphic'), { recursive: true });
  assert.strictEqual(
    I.resolveSettingsPath(path.join(root, 'src', 'chatgraphic')),
    path.join(root, '.codely-cli', 'settings.json'),
    '克隆：向上找到含 .codely-cli 的最近项目'
  );
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphan-'));
  fs.mkdirSync(path.join(orphan, 'chatgraphic'), { recursive: true });
  assert.strictEqual(
    I.resolveSettingsPath(path.join(orphan, 'chatgraphic')),
    USER_SETTINGS,
    '无项目结构 → 兜底用户级（tmp 顶层止损）'
  );
});

/* ---------- 双注册冲突告警 ---------- */
test('conflictWarning：项目级注册时检测用户级的另一份注册（参数化，不碰真机配置）', () => {
  const projSettings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-')), 'settings.json');
  const userSim = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-')), 'settings.json');
  const hookDir = '/another/proj/chatgraphic';
  const otherDir = '/somewhere/other-chatgraphic';
  fs.writeFileSync(userSim, JSON.stringify({
    hooks: { AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: 'node "' + otherDir + '/hook.js"' }] }] }
  }));
  const w = I.conflictWarning(projSettings, hookDir, userSim);
  assert.ok(w && w.includes('另一份'), '存在指向其他目录的注册时应告警');

  fs.writeFileSync(userSim, JSON.stringify({
    hooks: { AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: 'node "' + hookDir + '/hook.js"' }] }] }
  }));
  assert.strictEqual(I.conflictWarning(projSettings, hookDir, userSim), null, '指向同一 hook.js 时不应告警');
  assert.strictEqual(I.conflictWarning(userSim, hookDir, userSim), null, '注册到用户级文件时不自检冲突');
});
