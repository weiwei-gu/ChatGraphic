#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · claude-hook.js — Claude Code Stop Hook（主代理响应结束）触发器
 * 注册：install-claude.js 把本命令写入 ~/.claude/settings.json 的 hooks.Stop（用户级，全局生效）。
 * Claude Code 在每轮结束时以 JSON 经【stdin】调用 Hook 命令（官方机制），payload 含：
 *   {"session_id":"…","transcript_path":"…","cwd":"…","hook_event_name":"Stop",…}
 *   （transcript_path 直接给出会话转录 ~/.claude/projects/<项目slug>/<会话id>.jsonl，
 *    无需像 Codex 那样按 thread-id 搜索；SubagentStop 等其他事件一律忽略，避免子代理重复触发）
 * 其余与 hook.js / codex-hook.js 同款：秒级退出不阻塞；会话级隔离 work/sessions/<session_id>/；
 *   去重、取代旧解析、config.enabled 总开关；解析引擎由转录格式路由（Claude → claude -p 同链路）。
 * 手动测试：node claude-hook.js <转录 jsonl 路径>
 * 环境覆盖：CLAUDE_CONFIG_DIR（Claude home，默认 ~/.claude，transcript 缺失时回退搜索用）、
 *           CHATGRAPHIC_HOME（数据目录）、CHATGRAPHIC_PARSER_PATH（测试替身）
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
function claudeHome() { return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'); }

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(path.join(WORK, 'hook.log'), line); } catch (e) {}
}
function atomicWrite(p, s) { const t = p + '.tmp'; fs.writeFileSync(t, s); fs.renameSync(t, p); }

/* stdin payload 解析：仅接受 Stop（主代理结束）；取 session_id 与 transcript_path */
function parseHookPayload(str) {
  try {
    const o = JSON.parse(String(str));
    if (o && typeof o === 'object' && o.hook_event_name === 'Stop') {
      const sid = o.session_id || o.sessionId;
      if (sid) return { sessionId: String(sid), transcriptPath: o.transcript_path || null };
    }
  } catch (e) { /* 非 JSON → 手动模式 */ }
  return null;
}

/* transcript 缺失时回退搜索：<claudeHome>/projects/<项目slug>/<session_id>.jsonl */
function findTranscriptForSession(projectsRoot, sessionId) {
  const target = path.join(projectsRoot, sessionId + '.jsonl');
  try { if (fs.existsSync(target)) return target; } catch (e) {}
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 2 || hits.length > 4) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === sessionId + '.jsonl') { try { hits.push({ p, t: fs.statSync(p).mtimeMs }); } catch (e2) {} }
    }
  };
  try { walk(projectsRoot, 0); } catch (e) {}
  hits.sort((a, b) => b.t - a.t);
  return hits.length ? hits[0].p : null;
}

function dispatch(tp, sessionId, source) {
  const sd = path.join(SESSROOT, sessionId);
  fs.mkdirSync(sd, { recursive: true });
  // 去重（仅本会话）
  const hash = crypto.createHash('sha1').update(fs.readFileSync(tp)).digest('hex');
  let lastHash = '';
  try { lastHash = fs.readFileSync(path.join(sd, 'last-hash'), 'utf8').trim(); } catch (e) {}
  if (hash === lastHash) return;
  // 取代旧解析（仅本会话）
  try {
    const pid = parseInt(fs.readFileSync(path.join(sd, 'parse.pid'), 'utf8'), 10);
    if (pid && pid !== process.pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
      log('claude-hook: [' + sessionId + '] 终止未完成的旧解析 pid=' + pid);
    }
  } catch (e) { /* 无旧进程或已退出 */ }
  atomicWrite(path.join(sd, 'trigger.json'), JSON.stringify({
    transcriptPath: tp, sessionId, source, ts: Date.now()
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
  log('claude-hook: [' + sessionId + '] 已派发解析（转录 ' + hash.slice(0, 8) + '）');
}

function main() {
  try {
    // 1. 防递归（解析子进程的 claude -p 触发自身 Stop Hook 时静默退出）
    if (process.env.CHATGRAPHIC_CHILD === '1') process.exit(0);
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(SESSROOT, { recursive: true });

    // 2. 总开关
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch (e) {}
    if (cfg.enabled === false) { log('claude-hook: 已禁用（config.enabled=false），跳过'); process.exit(0); }

    // 3. 定位转录：argv 路径（手动测试）> stdin JSON（Stop 事件）
    if (process.argv[2] && fs.existsSync(process.argv[2]) && process.argv[2].endsWith('.jsonl')) {
      // 从转录头部提取 session id，使手动补跑与 Stop 触发落到同一会话目录（增量/去重语义一致）
      const head = fs.readFileSync(process.argv[2], 'utf8').slice(0, 2000);
      const m = head.match(/"session_?[Ii]d":"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/);
      dispatch(process.argv[2], m ? m[1] : 'claude-manual-' + Date.now(), 'claude-manual');
      process.exit(0);
    }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { buf += d; });
    process.stdin.on('end', () => {
      try {
        const p = parseHookPayload(buf);
        if (!p) { log('claude-hook: 非 Stop 事件或 payload 无法解析，跳过'); process.exit(0); }
        let tp = p.transcriptPath;
        if (!tp || !fs.existsSync(tp)) tp = findTranscriptForSession(path.join(claudeHome(), 'projects'), p.sessionId);
        if (!tp) { log('claude-hook: [' + p.sessionId + '] 未找到会话转录，跳过'); process.exit(0); }
        dispatch(tp, p.sessionId, 'claude-stop');
      } catch (e) {
        try { log('claude-hook: 异常 - ' + (e.message || e)); } catch (e2) {}
      }
      process.exit(0);
    });
    // stdin 超时兜底（非 Hook 场景直接运行时避免挂起）
    setTimeout(() => { log('claude-hook: stdin 无输入超时退出'); process.exit(0); }, 3000).unref();
  } catch (e) {
    try { log('claude-hook: 异常 - ' + (e.message || e)); } catch (e2) {}
    process.exit(0);
  }
}

if (require.main === module) main();

/* ---------- 供测试与二次开发 ---------- */
module.exports = { resolveWork, claudeHome, parseHookPayload, findTranscriptForSession };
