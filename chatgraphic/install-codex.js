#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · install-codex.js — 把 ChatGraphic 注册为 Codex CLI 的 notify 程序
 * 用法：
 *   node install-codex.js              # 注册（幂等）
 *   node install-codex.js --uninstall  # 移除
 *   node install-codex.js --status     # 查看状态
 *
 * 写入 <CODEX home>/config.toml（默认 ~/.codex/config.toml，Codex 用户级配置、全局生效）：
 *   notify = ["node", "<codex-hook.js 绝对路径>"]
 *   （Codex 在 agent-turn-complete 时以 JSON 作为最后一个参数调用该命令，codex-cli 0.141.0 实测）
 * 规则：
 *   - notify 键已存在且指向 ChatGraphic（含 codex-hook.js）→ 幂等；路径变化自动改写
 *   - notify 键已被其他程序占用 → 告警且不改动（不覆盖用户既有通知程序）
 *   - 新增：TOML 顶层键必须位于首个 [表头] 之前——插到首个表头行之前（其前有空行则插到空行前）
 *   - 原文件备份为 config.toml.chatgraphic-backup
 *   - 用户级注册为本机绝对路径（TOML 无官方 home 占位符，跨机器需重装；与 Codely 用户级注册同策略）
 * 环境覆盖：CHATGRAPHIC_CODEX_HOME（默认 ~/.codex，测试用）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = __dirname;

function codexConfigPath(codexHomeDir) {
  const home = codexHomeDir || process.env.CHATGRAPHIC_CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}
function hookScriptPath(dir) { return path.join(dir || DIR, 'codex-hook.js'); }
/* TOML 字符串字面量：转义反斜杠与双引号 */
function tomlStr(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function buildNotifyLine(hookPath) { return 'notify = ["node", ' + tomlStr(hookPath) + ']'; }
const NOTIFY_KEY_RE = /^\s*notify\s*=/;
const TABLE_RE = /^\s*\[/;

function loadLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n'); }
  catch (e) { return null; }
}
function saveLines(p, lines) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, lines.join('\n'));
}
/* 顶层 notify 行（表头之后出现的 notify 属于某 [table]，不算） */
function findTopLevelNotifyIdx(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_RE.test(lines[i])) return -1; // 已进入表区，顶层键区间结束
    if (NOTIFY_KEY_RE.test(lines[i])) return i;
  }
  return -1;
}
function firstTableIdx(lines) {
  for (let i = 0; i < lines.length; i++) if (TABLE_RE.test(lines[i])) return i;
  return -1;
}
/* 插入点：首个表头前（其前紧邻空行则插到空行前，保持排版）；无表头则文件末尾 */
function insertPosOf(lines) {
  const t = firstTableIdx(lines);
  if (t < 0) return lines.length;
  if (t > 0 && lines[t - 1].trim() === '') return t - 1;
  return t;
}

function statusOf(configPath, hookPath) {
  const lines = loadLines(configPath);
  const idx = lines ? findTopLevelNotifyIdx(lines) : -1;
  const stored = idx > -1 ? lines[idx].trim() : null;
  const ours = !!stored && stored.includes('codex-hook.js');
  console.log((ours ? '✓ 已注册 Codex notify' : stored ? '✗ notify 已被其他程序占用' : '✗ 未注册') + '：' + configPath);
  if (stored) console.log('  ' + stored);
  return { installed: ours, blocked: !!stored && !ours };
}

function installTo(configPath, hookPath) {
  const canonical = buildNotifyLine(hookPath);
  let lines = loadLines(configPath);
  const existed = !!lines;
  lines = lines || []; // 全新配置文件（无文件 → 仅一行 notify）
  const idx = findTopLevelNotifyIdx(lines);
  if (idx > -1) {
    if (!lines[idx].includes('codex-hook.js')) {
      console.log('⚠ config.toml 的 notify 已被其他程序占用，未做任何改动：');
      console.log('  ' + lines[idx].trim());
      console.log('  → 需要手动处理（如改写为你自己的转发脚本，在其中同时调用 codex-hook.js）');
      return { changed: false, blocked: true };
    }
    if (lines[idx].trim() === canonical) {
      console.log('✓ Codex notify 已注册（幂等跳过）：');
      console.log('  ' + canonical);
      return { changed: false };
    }
    if (existed) fs.writeFileSync(configPath + '.chatgraphic-backup', fs.readFileSync(configPath)); // 原文件备份
    lines[idx] = canonical;
    saveLines(configPath, lines);
    console.log('✓ Codex notify 路径已迁移为当前位置：');
    console.log('  ' + canonical);
    return { changed: true };
  }
  if (existed) fs.writeFileSync(configPath + '.chatgraphic-backup', fs.readFileSync(configPath)); // 原文件备份
  lines.splice(insertPosOf(lines), 0, canonical);
  saveLines(configPath, lines);
  console.log('✓ 已注册 Codex notify（写入 ' + configPath + '）：');
  console.log('  ' + canonical);
  console.log('  → Codex 每轮结束（agent-turn-complete）自动解析出图；config.json 可一键关闭。');
  console.log('  → 移除：node ' + path.join(DIR, 'install-codex.js') + ' --uninstall');
  return { changed: true };
}

function uninstallFrom(configPath, hookPath) {
  const lines = loadLines(configPath);
  const idx = lines ? findTopLevelNotifyIdx(lines) : -1;
  if (idx < 0) { console.log('✓ 未注册（无需移除）'); return { changed: false }; }
  if (!lines[idx].includes('codex-hook.js')) { console.log('✓ notify 属于其他程序，未改动'); return { changed: false }; }
  lines.splice(idx, 1);
  saveLines(configPath, lines);
  console.log('✓ 已移除 Codex notify（' + configPath + '）');
  return { changed: true };
}

/* ---------- CLI 入口 ---------- */
if (require.main === module) {
  const cfg = codexConfigPath();
  const arg = process.argv[2] || '';
  if (arg === '--uninstall') uninstallFrom(cfg, hookScriptPath(DIR));
  else if (arg === '--status') statusOf(cfg, hookScriptPath(DIR));
  else installTo(cfg, hookScriptPath(DIR));
}

/* ---------- 供测试与二次开发 ---------- */
module.exports = { codexConfigPath, hookScriptPath, buildNotifyLine, tomlStr, findTopLevelNotifyIdx, insertPosOf, installTo, uninstallFrom, statusOf };
