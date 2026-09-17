#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · codex-hook.js — Codex CLI notify（agent-turn-complete）触发器
 * 注册：install-codex.js 把 notify = ["node", "<本文件绝对路径>"] 写入 ~/.codex/config.toml；
 *       Codex 每轮结束时以 JSON 作为【最后一个参数】调用本程序（codex-cli 0.141.0 实测）。
 * payload（kebab-case）：{"type":"agent-turn-complete","thread-id":"…","turn-id":"…","cwd":"…",
 *                        "client":"…","input-messages":[…],"last-assistant-message":"…"}
 * 本程序只取 thread-id 定位全量 rollout 文件（比事件内嵌消息完整，含工具调用）：
 *   <CODEX home>/sessions/<年/月/日>/rollout-*-<threadId>.jsonl，同名取 mtime 最新。
 * 其余与 hook.js 同款：秒级退出不阻塞；会话级隔离 work/sessions/<threadId>/；
 *   去重、取代旧解析、config.enabled 总开关；解析仍复用 codely 同链路（parser.js）。
 * 手动测试：node codex-hook.js '<notify JSON>' 或 node codex-hook.js <rollout 文件路径>
 * 环境覆盖：CHATGRAPHIC_CODEX_HOME（Codex home，默认 ~/.codex）、CHATGRAPHIC_HOME（数据目录）、
 *           CHATGRAPHIC_PARSER_PATH（测试替身）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;

/* 数据目录：与 hook.js 同规则（CHATGRAPHIC_HOME > 扩展态：用户级 ~/.chatgraphic、workspace 级 <项目>/.chatgraphic > 本地 work/） */
function resolveWork(dir) {
  if (process.env.CHATGRAPHIC_HOME) return path.join(process.env.CHATGRAPHIC_HOME, 'work');
  const parts = path.resolve(dir).split(path.sep);
  const i = parts.lastIndexOf('.codely-cli');
  if (i > 0 && parts[i + 1] === 'extensions') {
    const projectDir = parts.slice(0, i).join(path.sep);
    if (projectDir === os.homedir()) return path.join(os.homedir(), '.chatgraphic');
    return path.join(projectDir, '.chatgraphic');
  }
  return path.join(dir, 'work');
}
const WORK = resolveWork(DIR);
const SESSROOT = path.join(WORK, 'sessions');
const PARSER = process.env.CHATGRAPHIC_PARSER_PATH || path.join(DIR, 'parser.js');
function codexHome() { return process.env.CHATGRAPHIC_CODEX_HOME || path.join(os.homedir(), '.codex'); }

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(path.join(WORK, 'hook.log'), line); } catch (e) {}
}
function atomicWrite(p, s) { const t = p + '.tmp'; fs.writeFileSync(t, s); fs.renameSync(t, p); }

/* notify 参数解析：JSON 且含 thread-id（兼容 snake_case）→ {threadId, type}；否则 null（交手动模式） */
function parseNotifyArgv(arg) {
  try {
    const o = JSON.parse(String(arg));
    if (o && typeof o === 'object') {
      const tid = o['thread-id'] || o.thread_id || (o.payload && (o.payload['thread-id'] || o.payload.thread_id));
      if (tid) return { threadId: String(tid), type: String(o.type || '') };
    }
  } catch (e) { /* 非 JSON → 手动模式 */ }
  return null;
}

/* 在 sessions 树中定位该 thread 的 rollout（文件名尾段即 thread id；同名取最新） */
function findRolloutForThread(sessionsRoot, threadId) {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 6 || hits.length > 20) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.startsWith('rollout-') && e.name.endsWith('-' + threadId + '.jsonl')) {
        try { hits.push({ p, t: fs.statSync(p).mtimeMs }); } catch (e2) {}
      }
    }
  };
  try { walk(sessionsRoot, 0); } catch (e) {}
  hits.sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

/* 手动模式：从 rollout 文件名提取 thread id（rollout-<时间戳>-<uuid>.jsonl） */
function threadIdOfRolloutFile(p) {
  const m = String(p).match(/-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/);
  return m ? m[1] : null;
}

function main() {
  try {
    // 1. 防递归（与 hook.js 同款守卫）
    if (process.env.CHATGRAPHIC_CHILD === '1') process.exit(0);
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(SESSROOT, { recursive: true });

    // 2. 总开关
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch (e) {}
    if (cfg.enabled === false) { log('codex-hook: 已禁用（config.enabled=false），跳过'); process.exit(0); }

    // 3. 定位 rollout：notify JSON（thread-id）> 手动路径
    const argv1 = process.argv[2] || '';
    let tp = null, sessionId = null;
    const nt = parseNotifyArgv(argv1);
    if (nt) {
      sessionId = nt.threadId;
      tp = findRolloutForThread(path.join(codexHome(), 'sessions'), nt.threadId);
      if (!tp) { log('codex-hook: [' + sessionId + '] 未找到 rollout（sessions 树中无 *-' + sessionId + '.jsonl）'); process.exit(0); }
    } else if (argv1 && fs.existsSync(argv1) && argv1.endsWith('.jsonl')) {
      tp = argv1; // 手动测试：直接给 rollout 路径
      sessionId = threadIdOfRolloutFile(tp) || 'codex-manual-' + Date.now();
    } else {
      log('codex-hook: 参数既非 notify JSON 也非 rollout 路径，跳过');
      process.exit(0);
    }

    // 4. 会话级隔离目录
    const sd = path.join(SESSROOT, sessionId);
    fs.mkdirSync(sd, { recursive: true });

    // 5. 去重（仅本会话）：同一份 rollout 不重复解析
    const hash = crypto.createHash('sha1').update(fs.readFileSync(tp)).digest('hex');
    let lastHash = '';
    try { lastHash = fs.readFileSync(path.join(sd, 'last-hash'), 'utf8').trim(); } catch (e) {}
    if (hash === lastHash) process.exit(0);

    // 6. 取代旧解析（仅本会话）
    try {
      const pid = parseInt(fs.readFileSync(path.join(sd, 'parse.pid'), 'utf8'), 10);
      if (pid && pid !== process.pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
        log('codex-hook: [' + sessionId + '] 终止未完成的旧解析 pid=' + pid);
      }
    } catch (e) { /* 无旧进程或已退出 */ }

    // 7. 派发解析（detached）后立即退出
    atomicWrite(path.join(sd, 'trigger.json'), JSON.stringify({
      transcriptPath: tp, sessionId, source: 'codex', ts: Date.now()
    }, null, 1));
    fs.writeFileSync(path.join(sd, 'last-hash'), hash);
    const child = spawn(process.execPath, [PARSER, '--transcript', tp, '--session', sessionId], {
      cwd: os.tmpdir(),
      env: Object.assign({}, process.env, { CHATGRAPHIC_CHILD: '1' }),
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    log('codex-hook: [' + sessionId + '] 已派发解析（rollout ' + hash.slice(0, 8) + '）');
  } catch (e) {
    try { log('codex-hook: 异常 - ' + (e.message || e)); } catch (e2) {}
  }
  process.exit(0);
}

if (require.main === module) main();

/* ---------- 供测试与二次开发 ---------- */
module.exports = { resolveWork, codexHome, parseNotifyArgv, findRolloutForThread, threadIdOfRolloutFile };
