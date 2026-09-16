#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic · install.js —— 注册 / 移除用户级 AfterAgent Hook
 * 用法：
 *   node install.js              # 注册 Hook（幂等；写入 ~/.codely-cli/settings.json）
 *   node install.js --uninstall  # 移除 Hook
 *   node install.js --status     # 查看安装状态
 *
 * 设计：Hook 注册到用户级 settings.json，一次注册对所有项目生效；
 *      每个项目首次使用时需在 Codely 里执行一次 /hooks trust-project（CLI 的
 *      安全信任机制，按项目存指纹，见 ~/.codely-cli/trusted_hooks.json）。
 * 注：Codely 1.0.0-rc.60 的扩展 manifest 尚不注册 hooks 字段（文档与实现存在差异，
 *     已实测验证），故 Hook 注册由本脚本完成；未来版本支持后可迁移至 manifest。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;
const DEFAULT_SETTINGS = path.join(os.homedir(), '.codely-cli', 'settings.json');

/* ---------- 核心逻辑（参数化，可测试） ---------- */
const HOOK_CONFIG_KEYS = ['enabled', 'enableUI', 'disabled', 'notifications', 'maxTotalDurationPerTurn', 'mode', 'environmentSanitization'];

function hookCmdOf(hookDir) { return 'node "' + path.join(hookDir, 'hook.js') + '"'; }
function isOurs(h, hookDir) {
  return String((h && h.command) || '').includes(path.join(hookDir, 'hook.js'));
}
function loadSettings(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return {}; }
}
function saveSettings(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
}
function findOurs(s, hookDir) {
  const groups = (s.hooks && s.hooks.AfterAgent) || [];
  for (const g of groups) {
    for (const h of (g && g.hooks) || []) {
      if (isOurs(h, hookDir)) return true;
    }
  }
  return false;
}

function installTo(settingsPath, hookDir) {
  const s = loadSettings(settingsPath);
  s.hooks = s.hooks || {};
  s.hooks.enabled = true;
  s.hooks.AfterAgent = Array.isArray(s.hooks.AfterAgent) ? s.hooks.AfterAgent : [];
  if (findOurs(s, hookDir)) {
    console.log('✓ Hook 已安装（幂等跳过）：\n  ' + hookCmdOf(hookDir));
    return { changed: false };
  }
  s.hooks.AfterAgent.push({
    matcher: '',
    hooks: [{ type: 'command', command: hookCmdOf(hookDir), timeout: 10000 }]
  });
  if (fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath + '.chatgraphic-backup', fs.readFileSync(settingsPath));
  }
  saveSettings(settingsPath, s);
  console.log('✓ 已注册用户级 AfterAgent Hook（一次注册，所有项目可用）：');
  console.log('  ' + hookCmdOf(hookDir));
  console.log('  → 写入 ' + settingsPath + '（原文件备份为 settings.json.chatgraphic-backup）');
  console.log('注意：每个项目首次使用时，需在该项目的 Codely 会话里执行一次 /hooks trust-project');
  console.log('      （CLI 安全机制，信任指纹按项目记录，之后该项目永久生效）');
  console.log('下一步：node ' + path.join(hookDir, 'serve.js') + ' 打开导图视图，然后在任意项目里和 Codely 对话。');
  return { changed: true };
}

function uninstallFrom(settingsPath, hookDir) {
  const s = loadSettings(settingsPath);
  if (!findOurs(s, hookDir)) { console.log('✓ 未安装（无需移除）'); return { changed: false }; }
  s.hooks.AfterAgent = s.hooks.AfterAgent
    .map(g => {
      if (!g || !Array.isArray(g.hooks)) return g;
      g.hooks = g.hooks.filter(h => !isOurs(h, hookDir));
      return g;
    })
    .filter(g => g && (!Array.isArray(g.hooks) || g.hooks.length > 0)); // 丢弃空组
  if (s.hooks.AfterAgent.length === 0) delete s.hooks.AfterAgent;
  // 若 hooks 下已无任何事件配置，整体还原（移除我们引入的空壳）
  const eventKeys = Object.keys(s.hooks).filter(k => !HOOK_CONFIG_KEYS.includes(k));
  if (eventKeys.length === 0) delete s.hooks;
  saveSettings(settingsPath, s);
  console.log('✓ 已移除 ChatGraphic Hook（' + settingsPath + '）');
  return { changed: true };
}

function statusOf(settingsPath, hookDir) {
  const s = loadSettings(settingsPath);
  const installed = findOurs(s, hookDir);
  console.log(installed ? '✓ 已安装：' : '✗ 未安装');
  if (installed) console.log('  ' + hookCmdOf(hookDir));
  return { installed };
}

/* ---------- CLI 入口 ---------- */
if (require.main === module) {
  const arg = process.argv[2] || '';
  if (arg === '--uninstall') uninstallFrom(DEFAULT_SETTINGS, DIR);
  else if (arg === '--status') statusOf(DEFAULT_SETTINGS, DIR);
  else installTo(DEFAULT_SETTINGS, DIR);
}

module.exports = { installTo, uninstallFrom, statusOf, findOurs, hookCmdOf };
