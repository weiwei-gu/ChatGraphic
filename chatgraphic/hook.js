#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · hook.js — AfterAgent（每轮结束）触发器（会话级隔离版）
 * 设计约束：收到事件后必须立即退出（<1s，不阻塞对话）。
 * 每个会话独立目录 work/sessions/<sessionId>/：
 *   去重、取代旧解析、trigger 均只作用于本会话——同项目多窗口并行互不干扰。
 * 手动测试：node hook.js <transcriptPath>（无会话ID时按时间戳生成一次性目录）
 * 测试替身：CHATGRAPHIC_PARSER_PATH 指向替代脚本（集成测试用，不调用真实解析）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');

const DIR = __dirname;

/* 数据目录：CHATGRAPHIC_HOME 可覆盖；扩展安装态（user/workspace 作用域均含 .codely-cli/extensions/ 路径段）放 ~/.chatgraphic/ 防 update 清空；仓库/开发态用本地 work/ */
function resolveWork(dir) {
  if (process.env.CHATGRAPHIC_HOME) return path.join(process.env.CHATGRAPHIC_HOME, 'work');
  if (path.resolve(dir).includes(path.sep + '.codely-cli' + path.sep + 'extensions' + path.sep)) {
    return path.join(os.homedir(), '.chatgraphic');
  }
  return path.join(dir, 'work');
}
const WORK = resolveWork(DIR);
const SESSROOT = path.join(WORK, 'sessions');
/* 解析器路径（测试可用 CHATGRAPHIC_PARSER_PATH 替换为不调 LLM 的替身） */
const PARSER = process.env.CHATGRAPHIC_PARSER_PATH || path.join(DIR, 'parser.js');

function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(path.join(WORK, 'hook.log'), line); } catch (e) {}
}
function atomicWrite(p, s) { const t = p + '.tmp'; fs.writeFileSync(t, s); fs.renameSync(t, p); }

/* 从项目目录定位最新 auto-save 转录（CODELY_TRANSCRIPT_PATH 缺失时的兜底） */
function resolveTranscriptFallback(projDir, argvPath) {
  if (argvPath) return argvPath;
  if (process.env.CODELY_TRANSCRIPT_PATH) return process.env.CODELY_TRANSCRIPT_PATH;
  const asDir = path.join(projDir, '.codely-cli', 'auto-saves');
  try {
    const files = fs.readdirSync(asDir)
      .filter(f => f.startsWith('chat-auto-save') && f.endsWith('.json'))
      .map(f => ({ p: path.join(asDir, f), t: fs.statSync(path.join(asDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (files.length) return files[0].p;
  } catch (e) {}
  return null;
}

function main() {
  try {
    // 1. 防递归：解析子进程（含其内部的 codely -p）不再触发解析
    if (process.env.CHATGRAPHIC_CHILD === '1') process.exit(0);
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(SESSROOT, { recursive: true });

    // 2. 总开关（一键关闭，对应 v0.3「可一键关闭」承诺）
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch (e) {}
    if (cfg.enabled === false) { log('hook: 已禁用（config.enabled=false），跳过'); process.exit(0); }

    // 3. 会话定位：每会话独立目录，多窗口互不干扰
    const sessionId = process.env.CODELY_SESSION_ID || ('adhoc-' + Date.now());
    const sd = path.join(SESSROOT, sessionId);
    fs.mkdirSync(sd, { recursive: true });

    // 4. 定位转录：argv（手动测试）> CODELY_TRANSCRIPT_PATH > 项目内最新 auto-save
    let tp = process.argv[2] === '--transcript' ? process.argv[3] : process.argv[2];
    tp = resolveTranscriptFallback(process.env.CODELY_PROJECT_DIR || path.resolve(DIR, '..'), tp);
    if (!tp) { log('hook: [' + sessionId + '] 未找到转录来源，跳过'); process.exit(0); }
    if (!fs.existsSync(tp)) { log('hook: [' + sessionId + '] 转录文件不存在 ' + tp); process.exit(0); }

    // 5. 去重（仅本会话）：同一份转录不重复解析（同一轮 AfterAgent 可能多次触发）
    const hash = crypto.createHash('sha1').update(fs.readFileSync(tp)).digest('hex');
    let lastHash = '';
    try { lastHash = fs.readFileSync(path.join(sd, 'last-hash'), 'utf8').trim(); } catch (e) {}
    if (hash === lastHash) process.exit(0);

    // 6. 取代旧解析（仅本会话）：杀掉本会话未完成的旧解析进程组，全量重解析最新胜出
    try {
      const pid = parseInt(fs.readFileSync(path.join(sd, 'parse.pid'), 'utf8'), 10);
      if (pid && pid !== process.pid) {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
        log('hook: [' + sessionId + '] 终止未完成的旧解析 pid=' + pid);
      }
    } catch (e) { /* 无旧进程或已退出 */ }

    // 7. 派发解析（detached 成独立进程组）后立即退出
    atomicWrite(path.join(sd, 'trigger.json'), JSON.stringify({
      transcriptPath: tp,
      sessionId,
      ts: Date.now()
    }, null, 1));
    fs.writeFileSync(path.join(sd, 'last-hash'), hash);
    const child = spawn(process.execPath, [PARSER], {
      cwd: os.tmpdir(),
      env: Object.assign({}, process.env, {
        CHATGRAPHIC_CHILD: '1',
        CODELY_TRANSCRIPT_PATH: tp,
        CODELY_SESSION_ID: sessionId
      }),
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    log('hook: [' + sessionId + '] 已派发解析（转录 ' + hash.slice(0, 8) + '）');
  } catch (e) {
    try { log('hook: 异常 - ' + (e.message || e)); } catch (e2) {}
  }
  process.exit(0);
}

/* 直接运行（node hook.js），或经项目级 Hook 命令的 node -e require() 方式加载
 * （Codely Windows 免 shell 机制；命令先置 CHATGRAPHIC_HOOK_AS_MAIN=1 显式开启） */
if (require.main === module || process.env.CHATGRAPHIC_HOOK_AS_MAIN === '1') main();

/* ---------- 供测试与二次开发 ---------- */
module.exports = { resolveWork, resolveTranscriptFallback };
