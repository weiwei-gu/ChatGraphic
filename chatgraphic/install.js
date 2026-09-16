#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic · install.js —— 注册 / 移除 AfterAgent Hook（作用域跟随安装位置）
 * 用法：
 *   node install.js              # 注册 Hook（幂等）
 *   node install.js --uninstall  # 移除 Hook
 *   node install.js --status     # 查看安装状态与作用域
 *
 * 注册位置规则（与扩展安装作用域一致）：
 *   install.js 位于 <X>/.codely-cli/extensions/chatgraphic/chatgraphic/ 时 → <X>/.codely-cli/settings.json
 *     - workspace 作用域（--scope workspace）→ 项目级 settings.json，仅本项目生效
 *     - 用户作用域（默认）→ ~/.codely-cli/settings.json，所有项目可用
 *   普通克隆：向上查找含 .codely-cli 目录的最近项目 → 该项目 settings.json（本地文件，勿入库）
 *   兜底：~/.codely-cli/settings.json
 *
 * 命令写法：
 *   项目级 → node "$CODELY_PROJECT_DIR/<hook.js 相对项目根路径>"（Codely 官方占位符，
 *            hook 执行时展开，跨机器/跨克隆位置可移植）
 *   用户级 → node "<绝对路径>"（本机文件，无官方 home 占位符）
 *   兼容：旧版绝对路径写法仍被识别（不重复注册、卸载可清理）。
 *
 * 每个项目首次使用时需在 Codely 里执行一次 /hooks trust-project（CLI 安全信任机制，
 * 按项目记录指纹于 ~/.codely-cli/trusted_hooks.json）。
 * 注：Codely 1.0.0-rc.60 的扩展 manifest 尚不注册 hooks 字段（文档与实现存在差异，
 *     已实测验证），故 Hook 注册由本脚本完成；未来版本支持后可迁移至 manifest。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;
const USER_SETTINGS = path.join(os.homedir(), '.codely-cli', 'settings.json');

/* ---------- 注册位置解析 ---------- */
function resolveSettingsPath(hookDir) {
  // 1) 路径中含 .codely-cli 段（扩展安装态：user / workspace 作用域通用）
  const segs = path.resolve(hookDir).split(path.sep);
  const i = segs.lastIndexOf('.codely-cli');
  if (i > 0) return path.join(segs.slice(0, i + 1).join(path.sep), 'settings.json');
  // 2) 普通克隆：向上找含 .codely-cli 目录的最近项目（最多 10 层，触达 tmp/home 顶层即止损，
  //    防止被系统目录中的遗留 .codely-cli 误命中）
  const stop = new Set([path.resolve(os.tmpdir()), path.resolve(os.homedir())]);
  let cur = path.resolve(hookDir);
  for (let d = 0; d < 10; d++) {
    if (stop.has(cur)) break;
    try {
      if (fs.statSync(path.join(cur, '.codely-cli')).isDirectory()) {
        return path.join(cur, '.codely-cli', 'settings.json');
      }
    } catch (e) { /* 不存在则继续向上 */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  // 3) 兜底：用户级
  return USER_SETTINGS;
}
function isUserSettings(p) { return path.resolve(p) === path.resolve(USER_SETTINGS); }
function scopeLabel(p) { return isUserSettings(p) ? '用户级' : '项目级'; }
function projectRootOf(settingsPath) { return path.dirname(path.dirname(path.resolve(settingsPath))); }

/* ---------- 核心逻辑（参数化，可测试） ---------- */
const HOOK_CONFIG_KEYS = ['enabled', 'enableUI', 'disabled', 'notifications', 'maxTotalDurationPerTurn', 'mode', 'environmentSanitization'];

function hookCmdOf(settingsPath, hookDir) {
  const hookPath = path.join(hookDir, 'hook.js');
  if (isUserSettings(settingsPath)) return 'node "' + hookPath + '"'; // 用户级：本机绝对路径
  // 项目级：$CODELY_PROJECT_DIR 锚定（hook 执行时由 Codely 展开，跨机器可移植）
  const rel = path.relative(projectRootOf(settingsPath), hookPath);
  return 'node "$CODELY_PROJECT_DIR/' + rel + '"';
}
/* 命中判定：绝对路径形式（旧版兼容）或 $CODELY_PROJECT_DIR 展开后指向同一 hook.js */
function isOurs(h, hookDir, settingsPath) {
  return !!findOursCmd(h, hookDir, settingsPath);
}
function findOursCmd(h, hookDir, settingsPath) {
  const cmd = String((h && h.command) || '');
  if (!cmd.includes('hook.js')) return null;
  if (cmd.includes(path.join(hookDir, 'hook.js'))) return cmd; // 旧版绝对路径形式
  if (settingsPath && !isUserSettings(settingsPath) && cmd.includes('$CODELY_PROJECT_DIR')) {
    const expanded = cmd.split('$CODELY_PROJECT_DIR').join(projectRootOf(settingsPath));
    if (expanded.includes(path.join(hookDir, 'hook.js'))) return cmd;
  }
  return null;
}
function loadSettings(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return {}; }
}
function saveSettings(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
}
function findOurs(s, hookDir, settingsPath) {
  const groups = (s.hooks && s.hooks.AfterAgent) || [];
  for (const g of groups) {
    for (const h of (g && g.hooks) || []) {
      const cmd = findOursCmd(h, hookDir, settingsPath);
      if (cmd) return cmd;
    }
  }
  return null;
}

function installTo(settingsPath, hookDir) {
  const scope = scopeLabel(settingsPath);
  const s = loadSettings(settingsPath);
  s.hooks = s.hooks || {};
  s.hooks.enabled = true;
  s.hooks.AfterAgent = Array.isArray(s.hooks.AfterAgent) ? s.hooks.AfterAgent : [];
  const existing = findOurs(s, hookDir, settingsPath);
  if (existing) {
    console.log('✓ Hook 已安装（幂等跳过，' + scope + '）：\n  ' + existing);
    return { changed: false, scope };
  }
  const cmd = hookCmdOf(settingsPath, hookDir);
  s.hooks.AfterAgent.push({
    matcher: '',
    hooks: [{ type: 'command', command: cmd, timeout: 10000 }]
  });
  if (fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath + '.chatgraphic-backup', fs.readFileSync(settingsPath));
  }
  saveSettings(settingsPath, s);
  console.log('✓ 已注册 AfterAgent Hook（' + scope + (scope === '用户级' ? '，一次注册所有项目可用' : '，仅本项目生效') + '）：');
  console.log('  ' + cmd);
  console.log('  → 写入 ' + settingsPath + (fs.existsSync(settingsPath + '.chatgraphic-backup') ? '（原文件备份为 *.chatgraphic-backup）' : ''));
  return { changed: true, scope };
}

function uninstallFrom(settingsPath, hookDir) {
  const s = loadSettings(settingsPath);
  if (!findOurs(s, hookDir, settingsPath)) { console.log('✓ 未安装（无需移除，' + scopeLabel(settingsPath) + '）'); return { changed: false }; }
  s.hooks.AfterAgent = s.hooks.AfterAgent
    .map(g => {
      if (!g || !Array.isArray(g.hooks)) return g;
      g.hooks = g.hooks.filter(h => !findOursCmd(h, hookDir, settingsPath));
      return g;
    })
    .filter(g => g && (!Array.isArray(g.hooks) || g.hooks.length > 0)); // 丢弃空组
  if (s.hooks.AfterAgent.length === 0) delete s.hooks.AfterAgent;
  // 若 hooks 下已无任何事件配置，整体还原（移除我们引入的空壳）
  const eventKeys = Object.keys(s.hooks).filter(k => !HOOK_CONFIG_KEYS.includes(k));
  if (eventKeys.length === 0) delete s.hooks;
  saveSettings(settingsPath, s);
  console.log('✓ 已移除 ChatGraphic Hook（' + scopeLabel(settingsPath) + '，' + settingsPath + '）');
  return { changed: true };
}

function statusOf(settingsPath, hookDir) {
  const s = loadSettings(settingsPath);
  const stored = findOurs(s, hookDir, settingsPath);
  const scope = scopeLabel(settingsPath);
  console.log((stored ? '✓ 已安装' : '✗ 未安装') + '（' + scope + '）');
  console.log('  注册文件：' + settingsPath);
  if (stored) console.log('  ' + stored); // 显示实际存储的命令（兼容旧写法如实呈现）
  return { installed: !!stored, scope };
}

/* ---------- 双注册冲突告警：项目级注册时检查用户级是否另有 ChatGraphic Hook ---------- */
function conflictWarning(settingsPath, hookDir, userSettingsPath) {
  const user = userSettingsPath || USER_SETTINGS;
  if (path.resolve(settingsPath) === path.resolve(user)) return null; // 注册的就是用户级文件，无需自检冲突
  try {
    const s = loadSettings(user);
    const groups = (s.hooks && s.hooks.AfterAgent) || [];
    for (const g of groups) {
      for (const h of (g && g.hooks) || []) {
        const cmd = String((h && h.command) || '');
        if (cmd.includes('chatgraphic') && cmd.includes('hook.js') && !cmd.includes(path.join(hookDir, 'hook.js'))) {
          return '⚠ 检测到用户级已注册另一份 ChatGraphic Hook（' + cmd + '）——两份并存会双重解析（双倍成本），建议 node <对应目录>/install.js --uninstall 移除其中一份';
        }
      }
    }
  } catch (e) {}
  return null;
}

/* ---------- CLI 入口 ---------- */
if (require.main === module) {
  const settings = resolveSettingsPath(DIR);
  const arg = process.argv[2] || '';
  if (arg === '--uninstall') uninstallFrom(settings, DIR);
  else if (arg === '--status') statusOf(settings, DIR);
  else {
    const r = installTo(settings, DIR);
    const warn = r.changed ? conflictWarning(settings, DIR) : null;
    if (warn) console.log(warn);
    if (r.changed) {
      console.log('注意：本项目首次使用时，在 Codely 会话里执行一次 /hooks trust-project（信任指纹按项目记录）');
      console.log('下一步：node ' + path.join(DIR, 'serve.js') + ' 打开导图视图，然后和 Codely 对话。');
    }
  }
}

module.exports = { installTo, uninstallFrom, statusOf, findOurs, isOurs, hookCmdOf, resolveSettingsPath, conflictWarning };
