#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · install-claude.js — 把 ChatGraphic 注册为 Claude Code 的 Stop Hook
 * 用法：
 *   node install-claude.js              # 注册（幂等）
 *   node install-claude.js --uninstall  # 移除
 *   node install-claude.js --status     # 查看状态
 *
 * 写入 <Claude home>/settings.json（默认 ~/.claude/settings.json，用户级、全局生效）的
 * hooks.Stop：主代理每轮响应结束时，Claude Code 以 JSON 经 stdin 调用本命令。
 * 规则：
 *   - Claude 的 hooks 是数组结构：已存在的他人 Stop Hook 保留（并存追加），不像 Codex notify 单槽
 *   - 命令含 claude-hook.js 视为我们：幂等；路径变化自动迁移
 *   - 原文件备份为 settings.json.chatgraphic-backup
 * 环境覆盖：CLAUDE_CONFIG_DIR（默认 ~/.claude，测试用）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;

function claudeSettingsPath(claudeHomeDir) {
  const home = claudeHomeDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(home, 'settings.json');
}
function hookScriptPath(dir) { return path.join(dir || DIR, 'claude-hook.js'); }
function buildHookEntry(cmd) {
  return { matcher: '', hooks: [{ type: 'command', command: cmd, timeout: 10 }] };
}
function buildCommand(hookPath) { return 'node "' + hookPath + '"'; }
const isOurEntry = g => !!(g && Array.isArray(g.hooks) && g.hooks.some(h => h && typeof h.command === 'string' && h.command.includes('claude-hook.js')));
function loadSettings(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return {}; }
}
function saveSettings(p, s) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
}

function findOursIdx(settings, hookPath) {
  const groups = (settings.hooks && settings.hooks.Stop) || [];
  for (let i = 0; i < groups.length; i++) if (isOurEntry(groups[i], hookPath)) return i;
  return -1;
}

function statusOf(settingsPath, hookPath) {
  const s = loadSettings(settingsPath);
  const idx = findOursIdx(s, hookPath);
  const others = ((s.hooks && s.hooks.Stop) || []).length - (idx > -1 ? 1 : 0);
  console.log((idx > -1 ? '✓ 已注册 Claude Stop Hook' : '✗ 未注册') + '：' + settingsPath);
  if (idx > -1) console.log('  ' + s.hooks.Stop[idx].hooks[0].command);
  if (others > 0) console.log('  （另有 ' + others + ' 条他人 Stop Hook，互不影响）');
  return { installed: idx > -1 };
}

function installTo(settingsPath, hookPath) {
  const s = loadSettings(settingsPath);
  const existed = fs.existsSync(settingsPath);
  const idx = findOursIdx(s, hookPath);
  const canonicalEntry = buildHookEntry(buildCommand(hookPath));
  if (idx > -1) {
    if (JSON.stringify(s.hooks.Stop[idx]) === JSON.stringify(canonicalEntry)) {
      console.log('✓ Claude Stop Hook 已注册（幂等跳过）：');
      console.log('  ' + s.hooks.Stop[idx].hooks[0].command);
      return { changed: false };
    }
    if (existed) fs.writeFileSync(settingsPath + '.chatgraphic-backup', fs.readFileSync(settingsPath)); // 原文件备份
    s.hooks.Stop[idx] = canonicalEntry; // 路径迁移
    saveSettings(settingsPath, s);
    console.log('✓ Claude Stop Hook 路径已迁移为当前位置：');
    console.log('  ' + canonicalEntry.hooks[0].command);
    return { changed: true };
  }
  if (existed) fs.writeFileSync(settingsPath + '.chatgraphic-backup', fs.readFileSync(settingsPath)); // 原文件备份
  s.hooks = s.hooks || {};
  s.hooks.Stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
  s.hooks.Stop.push(canonicalEntry); // 追加并存，不动他人条目
  saveSettings(settingsPath, s);
  console.log('✓ 已注册 Claude Stop Hook（写入 ' + settingsPath + '）：');
  console.log('  ' + canonicalEntry.hooks[0].command);
  console.log('  → Claude Code 每轮响应结束（Stop）自动解析出图；config.json 可一键关闭。');
  console.log('  → 移除：node ' + path.join(DIR, 'install-claude.js') + ' --uninstall');
  return { changed: true };
}

function uninstallFrom(settingsPath, hookPath) {
  const s = loadSettings(settingsPath);
  const idx = findOursIdx(s, hookPath);
  if (idx < 0) { console.log('✓ 未注册（无需移除）'); return { changed: false }; }
  s.hooks.Stop.splice(idx, 1);
  if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
  if (s.hooks && Object.keys(s.hooks).length === 0) delete s.hooks; // 无任何事件配置则整体还原
  saveSettings(settingsPath, s);
  console.log('✓ 已移除 Claude Stop Hook（' + settingsPath + '）');
  return { changed: true };
}

/* ---------- CLI 入口 ---------- */
if (require.main === module) {
  const cfg = claudeSettingsPath();
  const arg = process.argv[2] || '';
  if (arg === '--uninstall') uninstallFrom(cfg, hookScriptPath(DIR));
  else if (arg === '--status') statusOf(cfg, hookScriptPath(DIR));
  else installTo(cfg, hookScriptPath(DIR));
}

/* ---------- 供测试与二次开发 ---------- */
module.exports = { claudeSettingsPath, hookScriptPath, buildHookEntry, buildCommand, findOursIdx, installTo, uninstallFrom, statusOf };
