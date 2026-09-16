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
const SETTINGS = path.join(os.homedir(), '.codely-cli', 'settings.json');
const hookPath = () => path.join(DIR, 'hook.js');
const hookCmd = () => 'node "' + hookPath() + '"';

function load() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) { return {}; }
}
function save(s, backup) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  if (backup && fs.existsSync(SETTINGS)) {
    fs.writeFileSync(SETTINGS + '.chatgraphic-backup', fs.readFileSync(SETTINGS));
  }
  fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');
}
function isOurs(h) {
  return String((h && h.command) || '').includes(hookPath());
}
function findOurs(s) {
  const groups = (s.hooks && s.hooks.AfterAgent) || [];
  for (const g of groups) {
    for (const h of (g && g.hooks) || []) {
      if (isOurs(h)) return true;
    }
  }
  return false;
}

function install() {
  const s = load();
  s.hooks = s.hooks || {};
  s.hooks.enabled = true;
  s.hooks.AfterAgent = Array.isArray(s.hooks.AfterAgent) ? s.hooks.AfterAgent : [];
  if (findOurs(s)) {
    console.log('✓ Hook 已安装（幂等跳过）：\n  ' + hookCmd());
    return;
  }
  s.hooks.AfterAgent.push({
    matcher: '',
    hooks: [{ type: 'command', command: hookCmd(), timeout: 10000 }]
  });
  save(s, true);
  console.log('✓ 已注册用户级 AfterAgent Hook（一次注册，所有项目可用）：');
  console.log('  ' + hookCmd());
  console.log('  → 写入 ' + SETTINGS + '（原文件备份为 settings.json.chatgraphic-backup）');
  console.log('注意：每个项目首次使用时，需在该项目的 Codely 会话里执行一次 /hooks trust-project');
  console.log('      （CLI 安全机制，信任指纹按项目记录，之后该项目永久生效）');
  console.log('下一步：node ' + path.join(DIR, 'serve.js') + ' 打开导图视图，然后在任意项目里和 Codely 对话。');
}

function uninstall() {
  const s = load();
  if (!findOurs(s)) { console.log('✓ 未安装（无需移除）'); return; }
  s.hooks.AfterAgent = s.hooks.AfterAgent
    .map(g => {
      if (!g || !Array.isArray(g.hooks)) return g;
      g.hooks = g.hooks.filter(h => !isOurs(h));
      return g;
    })
    .filter(g => g && (!Array.isArray(g.hooks) || g.hooks.length > 0)); // 丢弃空组
  if (s.hooks.AfterAgent.length === 0) delete s.hooks.AfterAgent;
  // 若 hooks 下已无任何事件配置，整体还原（移除我们引入的空壳）
  const eventKeys = Object.keys(s.hooks).filter(k => !['enabled', 'enableUI', 'disabled', 'notifications', 'maxTotalDurationPerTurn', 'mode', 'environmentSanitization'].includes(k));
  if (eventKeys.length === 0) delete s.hooks;
  save(s, false);
  console.log('✓ 已移除 ChatGraphic Hook（' + SETTINGS + '）');
}

function status() {
  const s = load();
  const installed = findOurs(s);
  console.log(installed ? '✓ 已安装：' : '✗ 未安装');
  if (installed) console.log('  ' + hookCmd());
  console.log('  数据目录：' + (process.env.CHATGRAPHIC_HOME
    ? path.join(process.env.CHATGRAPHIC_HOME, 'work')
    : (DIR.startsWith(path.join(os.homedir(), '.codely-cli', 'extensions') + path.sep)
      ? path.join(os.homedir(), '.chatgraphic')
      : path.join(DIR, 'work'))));
}

const arg = process.argv[2] || '';
if (arg === '--uninstall') uninstall();
else if (arg === '--status') status();
else install();
