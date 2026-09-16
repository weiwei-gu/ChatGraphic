'use strict';
/* ChatGraphic · install.js 单元测试（全部针对临时 settings 文件，不碰真实配置） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../install.js');

const HOOK_DIR = path.join(__dirname, '..');
function mkSettingsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inst-')), 'settings.json');
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('全新安装 → 幂等 → 卸载后完全还原（无 hooks 残留）', () => {
  const sp = mkSettingsPath();
  const r1 = I.installTo(sp, HOOK_DIR);
  assert.strictEqual(r1.changed, true);
  let s = read(sp);
  assert.strictEqual(s.hooks.enabled, true);
  assert.strictEqual(s.hooks.AfterAgent.length, 1);
  assert.ok(s.hooks.AfterAgent[0].hooks[0].command.includes(path.join(HOOK_DIR, 'hook.js')));

  const r2 = I.installTo(sp, HOOK_DIR); // 幂等
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(read(sp).hooks.AfterAgent.length, 1);

  const r3 = I.uninstallFrom(sp, HOOK_DIR);
  assert.strictEqual(r3.changed, true);
  s = read(sp);
  assert.strictEqual(s.hooks, undefined, 'hooks 空壳应整体还原');
});

test('保留已有 hooks 配置与他人 Hook、无关顶层键', () => {
  const sp = mkSettingsPath();
  fs.writeFileSync(sp, JSON.stringify({
    unityInsight: { enabled: true },
    hooks: { enabled: true, AfterAgent: [{ matcher: 'x', hooks: [{ type: 'command', command: 'node other.js' }] }] }
  }));
  I.installTo(sp, HOOK_DIR);
  assert.strictEqual(read(sp).hooks.AfterAgent.length, 2, '应追加而非覆盖');

  I.uninstallFrom(sp, HOOK_DIR);
  const s = read(sp);
  assert.strictEqual(s.hooks.AfterAgent.length, 1, '只移除自己的条目');
  assert.strictEqual(s.hooks.AfterAgent[0].hooks[0].command, 'node other.js', '他人 Hook 不受影响');
  assert.strictEqual(s.hooks.enabled, true, 'hooks 配置键保留');
  assert.deepStrictEqual(s.unityInsight, { enabled: true }, '无关顶层键保留');
});

test('未安装时卸载为 no-op（不创建文件）', () => {
  const sp = mkSettingsPath();
  const r = I.uninstallFrom(sp, HOOK_DIR);
  assert.strictEqual(r.changed, false);
  assert.ok(!fs.existsSync(sp), '未安装时不得创建 settings 文件');
});

test('statusOf 报告安装状态', () => {
  const sp = mkSettingsPath();
  assert.strictEqual(I.statusOf(sp, HOOK_DIR).installed, false);
  I.installTo(sp, HOOK_DIR);
  assert.strictEqual(I.statusOf(sp, HOOK_DIR).installed, true);
  I.uninstallFrom(sp, HOOK_DIR);
  assert.strictEqual(I.statusOf(sp, HOOK_DIR).installed, false);
});

/* ---------- 注册位置解析（作用域跟随安装位置） ---------- */
test('resolveSettingsPath：workspace 作用域 → 项目级；用户作用域 → 用户级', () => {
  const ws = '/Users/dev/MyProject/.codely-cli/extensions/chatgraphic/chatgraphic';
  const us = path.join(os.homedir(), '.codely-cli', 'extensions', 'chatgraphic', 'chatgraphic');
  assert.strictEqual(I.resolveSettingsPath(ws), '/Users/dev/MyProject/.codely-cli/settings.json', 'workspace → 项目 settings');
  assert.strictEqual(I.resolveSettingsPath(us), path.join(os.homedir(), '.codely-cli', 'settings.json'), '用户作用域 → 用户 settings');
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
    path.join(os.homedir(), '.codely-cli', 'settings.json'),
    '无项目结构 → 兜底用户级'
  );
});

test('conflictWarning：项目级注册时检测用户级的另一份注册（参数化，不碰真机配置）', () => {
  const projSettings = path.join(mkSettingsDirOnly(), 'settings.json'); // 任意非用户级路径
  const userSim = path.join(mkSettingsDirOnly(), 'settings.json');
  const otherDir = '/somewhere/other-chatgraphic';
  fs.writeFileSync(userSim, JSON.stringify({
    hooks: { AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: 'node "' + otherDir + '/hook.js"' }] }] }
  }));
  const w = I.conflictWarning(projSettings, HOOK_DIR, userSim);
  assert.ok(w && w.includes('另一份'), '存在指向其他目录的注册时应告警');

  // 指向自身 → 不告警
  fs.writeFileSync(userSim, JSON.stringify({
    hooks: { AfterAgent: [{ matcher: '', hooks: [{ type: 'command', command: I.hookCmdOf(HOOK_DIR) }] }] }
  }));
  assert.strictEqual(I.conflictWarning(projSettings, HOOK_DIR, userSim), null, '指向同一 hook.js 时不应告警');

  // 用户级注册 → 永不告警
  assert.strictEqual(I.conflictWarning(userSim, HOOK_DIR, userSim), null, '用户级注册不检查冲突');
});

/** 只建目录不建文件（settings 路径必须不存在，避免被当作用户级） */
function mkSettingsDirOnly() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-scope-'));
}
