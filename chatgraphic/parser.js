#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · parser.js — 解析 worker（会话级隔离 + 增量解析版）
 * 由 hook.js 异步派发，也可手动补跑：
 *   node parser.js --transcript <路径> [--session <会话id>] [--full]
 * 每个会话独立目录 work/sessions/<sessionId>/，多窗口并行互不干扰；
 * 解析完成更新 work/current.json 指针（viewer 默认跟随最新会话）。
 * 增量解析（v0.2.0，对齐 v0.3 Phase 2「滚动窗口 + 图状态摘要」）：
 *   同会话第二次起，输入 = 图状态摘要 + 新增轮次（不再重发全量转录，成本近似常数）；
 *   首次 / 转录被压缩 / 增量失败 / 疑似丢节点 → 自动回退全量；--full 可强制全量。
 * 解析失败重试 1 次；仍失败保留该会话上一版导图并写 status.json。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = __dirname;

/* 数据目录：CHATGRAPHIC_HOME 可覆盖；扩展安装态（~/.codely-cli/extensions/…）放 ~/.chatgraphic/ 防 update 清空；仓库/开发态用本地 work/ */
function resolveWork(dir) {
  if (process.env.CHATGRAPHIC_HOME) return path.join(process.env.CHATGRAPHIC_HOME, 'work');
  if (dir.startsWith(path.join(os.homedir(), '.codely-cli', 'extensions') + path.sep)) {
    return path.join(os.homedir(), '.chatgraphic');
  }
  return path.join(dir, 'work');
}
const WORK = resolveWork(DIR);
const SESSROOT = path.join(WORK, 'sessions');
const CFG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const __CFG_ORIG = JSON.parse(JSON.stringify(CFG));
/* 测试钩子（node --test 用）：临时改写截断/上限，不动配置文件 */
function __setConfig(patch) { Object.assign(CFG, patch); }
function __resetConfig() { Object.assign(CFG, __CFG_ORIG); }

/* ---------- 基础工具 ---------- */
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.join(' ')}\n`;
  try { fs.appendFileSync(path.join(WORK, 'hook.log'), line); } catch (e) {}
  console.log(line.trim());
}
function atomicWrite(p, s) {
  const t = p + '.tmp';
  fs.writeFileSync(t, s);
  fs.renameSync(t, p);
}
function setStatus(sd, obj) {
  try { atomicWrite(path.join(sd, 'status.json'), JSON.stringify(obj, null, 2)); } catch (e) {}
}
function readVersion(sd) {
  try { return Math.max(0, parseInt(fs.readFileSync(path.join(sd, 'version.txt'), 'utf8'), 10) || 0); }
  catch (e) { return 0; }
}
function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n) + ' …（截断）';
}
function baseName(p) {
  try { return String(p).split('/').pop().slice(0, 60); } catch (e) { return String(p).slice(0, 60); }
}

/* ---------- 会话解析 ---------- */
function resolveSessionId(raw) {
  const ai = process.argv.indexOf('--session');
  if (ai > -1 && process.argv[ai + 1]) return process.argv[ai + 1];
  if (process.env.CODELY_SESSION_ID) return process.env.CODELY_SESSION_ID;
  const m = String(raw).slice(0, 400).match(/"durableSessionId":"([A-Za-z0-9\-]+)"/); // 实时 JSONL 头
  if (m) return m[1];
  try { const o = JSON.parse(raw); if (o.tag) return o.tag; } catch (e) {} // auto-save
  return 'manual';
}

/* ---------- 转录归一化（clientHistory / 数组 / JSONL / Claude 风格 容错） ---------- */
function loadTranscriptFromRaw(raw) {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    // JSONL：Codely 实时转录（t:"put" + msg 信封），取 put 记录的 msg
    data = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e2) { return null; } })
      .filter(Boolean)
      .filter(l => l.t === 'put' && l.msg)
      .map(l => l.msg);
  }
  let history = null;
  if (Array.isArray(data)) history = data;
  else if (data && Array.isArray(data.clientHistory)) history = data.clientHistory;
  else if (data && Array.isArray(data.history)) history = data.history;
  else if (data && Array.isArray(data.messages)) history = data.messages;
  if (!history || !history.length) throw new Error('无法识别的转录格式（非 JSON 数组 / clientHistory / history / messages / JSONL）');
  return history;
}
function entryRole(entry) {
  if (entry.role === 'user' || entry.role === 'model' || entry.role === 'assistant') {
    return entry.role === 'assistant' ? 'model' : entry.role;
  }
  // JSONL 消息的 type 字段：user / gemini（即模型）
  if (entry.type === 'user') return 'user';
  if (entry.type === 'gemini' || entry.type === 'assistant' || entry.type === 'model') return 'model';
  return null;
}
function entryParts(entry) {
  let parts = entry.parts || (entry.message && entry.message.content) || entry.content;
  if (typeof parts === 'string') return [{ text: parts }]; // JSONL 消息 content 为纯字符串
  return Array.isArray(parts) ? parts : [];
}

/* ---------- 精简为轮次脚本 ---------- */
function isRealUserText(t) {
  const s = String(t || '').trim();
  return !!s && !s.startsWith('[agent-auto]');
}
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const preferred = ['file_path', 'absolute_path', 'path', 'command', 'pattern', 'jobId', 'url', 'query', 'subject', 'name', 'description'];
  const skip = ['old_string', 'new_string', 'content', 'prompt', 'code', 'schema'];
  const bits = [];
  for (const k of preferred) {
    if (args[k] != null) {
      let v = String(args[k]);
      if (/path/i.test(k)) v = baseName(v);
      bits.push(k + '=' + truncate(v, 80));
    }
  }
  if (!bits.length) {
    for (const k of Object.keys(args).slice(0, 3)) {
      if (skip.includes(k)) continue;
      bits.push(k + '=' + truncate(String(args[k]), 40));
    }
  }
  return bits.join(' ');
}
function buildRounds(history) {
  const rounds = [];
  let cur = null;
  const ensureCur = () => {
    if (!cur) { cur = { n: 1, userText: '（无明确起始提问）', assistant: [], tools: [] }; rounds.push(cur); }
    return cur;
  };
  for (const entry of history) {
    const role = entryRole(entry);
    if (!role) continue;
    for (const part of entryParts(entry)) {
      if (role === 'user' && typeof part.text === 'string' && isRealUserText(part.text)) {
        cur = { n: rounds.length + 1, userText: truncate(part.text, CFG.maxTurnChars), assistant: [], tools: [] };
        rounds.push(cur);
      }
      else if (role === 'user' && part.type === 'text' && isRealUserText(part.text)) {
        cur = { n: rounds.length + 1, userText: truncate(part.text, CFG.maxTurnChars), assistant: [], tools: [] };
        rounds.push(cur);
      }
      else if (role === 'model' && typeof part.text === 'string' && part.text.trim()) {
        ensureCur().assistant.push(truncate(part.text, CFG.maxTurnChars));
      }
      else if (role === 'model' && part.type === 'text' && part.text) {
        ensureCur().assistant.push(truncate(part.text, CFG.maxTurnChars));
      }
      else if (part.functionCall && part.functionCall.name) {
        ensureCur().tools.push({ name: part.functionCall.name, summary: summarizeArgs(part.functionCall.args) });
      }
      else if (part.type === 'tool_use' && part.name) {
        ensureCur().tools.push({ name: part.name, summary: summarizeArgs(part.input) });
      }
      else if (part.functionResponse && part.functionResponse.name) {
        const r = part.functionResponse.response || {};
        const out = r.output != null ? r.output : (r.error != null ? 'ERROR: ' + r.error : '');
        ensureCur().tools.push({ name: part.functionResponse.name, result: truncate(out, 200) });
      }
      else if (part.type === 'tool_result') {
        const c = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
        ensureCur().tools.push({ name: part.name || 'tool', result: truncate(c, 200) });
      }
    }
  }
  return rounds;
}
function roundBlocks(rounds, maxTurn) {
  const blocks = [];
  for (const r of rounds) {
    const parts = [`[第 ${r.n} 轮 · 用户]\n${truncate(r.userText, maxTurn)}`];
    for (const a of r.assistant) parts.push(`[第 ${r.n} 轮 · 助手]\n${truncate(a, maxTurn)}`);
    for (const t of r.tools) {
      if (t.summary) parts.push(`[助手 · 调用工具 ${t.name}] ${t.summary}`);
      if (t.result) parts.push(`[工具结果 · ${t.name}] ${t.result}`);
    }
    blocks.push({ n: r.n, text: parts.join('\n') });
  }
  return blocks;
}
function renderLean(rounds) {
  const join = bs => bs.map(b => b.text).join('\n\n');
  let blocks = roundBlocks(rounds, CFG.maxTurnChars);
  const dropped = [];
  let s = join(blocks);
  // 超限收缩（分级，保头 = 目标来源，保尾 = 最新状态，极端时保尾优先）：
  // 1) 压缩单轮文本 → 2) 略中段，保头 2 + 尾 2 → 3) 只保头 1 + 尾 2 → 4) 兜底截头保尾
  if (s.length > CFG.maxTotalLeanChars) {
    blocks = roundBlocks(rounds, Math.max(200, Math.floor(CFG.maxTurnChars / 3)));
    s = join(blocks);
  }
  const dropMiddle = (keepHead, keepTail) => {
    while (s.length > CFG.maxTotalLeanChars && blocks.length > keepHead + keepTail) {
      const idx = Math.max(keepHead, Math.min(blocks.length - keepTail - 1, Math.floor(blocks.length / 2)));
      dropped.push(blocks[idx].n);
      blocks.splice(idx, 1);
      s = join(blocks);
    }
  };
  dropMiddle(2, 2);
  dropMiddle(1, 2);
  if (s.length > CFG.maxTotalLeanChars) {
    s = s.slice(s.length - CFG.maxTotalLeanChars) + '\n…（极端超限，已截头保尾）';
  }
  if (dropped.length) s += '\n\n[已略去的轮次：' + dropped.sort((a, b) => a - b).join('、') + '（内容过长省略，其余轮次完整）]';
  return s;
}
function viewRound(r) {
  return {
    n: r.n,
    user: r.userText,
    assistant: r.assistant.join('\n\n').slice(0, 1200),
    tools: r.tools.slice(0, 12)
  };
}

/* ---------- 同链路解析：spawn `codely -p`（全部载荷经 -p 参数，stdin 不可靠已弃用） ---------- */
function buildPrompt(lean, sd) {
  const instr = fs.readFileSync(path.join(DIR, 'parse-prompt.md'), 'utf8');
  let prev = '';
  try {
    const g = JSON.parse(fs.readFileSync(path.join(sd, 'graph.json'), 'utf8'));
    const summary = (g.nodes || []).map(n => ({
      id: n.id, type: n.type, title: n.title, parent: n.parent,
      state: n.state || null, status: n.status || null
    }));
    prev = '\n\n## 上一版导图节点（同一概念务必沿用相同 id；不再有依据的节点可删除；状态变化要更新；**上一版中类型划分错误的节点（如把方案写成任务），本轮以转录为准修正**）\n'
      + JSON.stringify(summary);
  } catch (e) { /* 首次解析没有上一版 */ }
  let payload = instr + prev + '\n\n===== 会话转录（已精简）=====\n\n' + lean
    + '\n\n执行上述解析任务：只输出符合 schema 的 JSON 对象，不要代码围栏，不要任何其他文字。';
  if (payload.length > 90000) payload = payload.slice(0, 90000) + '\n…（截断）';
  return payload;
}
function runCodely(payload) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (CFG.model) args.push('-m', CFG.model);
    args.push('--output-format', 'text', '-p', payload);
    // 独占临时目录作为 cwd：同机并行解析互不共享任何 cwd 内状态
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgraphic-parse-'));
    const child = spawn('codely', args, {
      cwd: scratch,
      env: Object.assign({}, process.env, { CHATGRAPHIC_CHILD: '1' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) {}
      reject(new Error('解析超时（' + CFG.parseTimeoutMs + 'ms）'));
    }, CFG.parseTimeoutMs);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) {}
      if (code === 0) resolve(out);
      else reject(new Error('codely 退出码 ' + code + '；stderr: ' + err.slice(0, 400)));
    });
  });
}
function extractJson(text) {
  if (!text || !text.trim()) throw new Error('空响应');
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('响应中没有 JSON 对象');
  return JSON.parse(t.slice(i, j + 1));
}

/* ---------- 校验与归一化 ---------- */
function str(v, max) { v = typeof v === 'string' ? v.trim() : ''; return v.slice(0, max); }
function ints(v, maxN) {
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    const n = Math.round(Number(x));
    if (Number.isFinite(n) && n >= 1 && n <= maxN && !out.includes(n)) out.push(n);
  }
  return out;
}
function normalize(parsed, roundCount) {
  const goal = str(parsed.goal, 60) || '本次协作';
  const startRound = Math.max(1, Math.min(roundCount, Math.round(Number(parsed.startRound) || 1)));
  const timeline = (Array.isArray(parsed.timeline) ? parsed.timeline : []).slice(0, 10)
    .map(t => ({ round: Math.max(1, Math.min(roundCount, Math.round(Number(t.round) || 1))), text: str(t.text, 40) }))
    .filter(t => t.text);

  const used = new Set();
  const uniqId = id => {
    let base = str(id, 40).replace(/[^\w\-]/g, '-') || 'n';
    let k = base, i = 2;
    while (used.has(k)) k = base + '-' + (i++);
    used.add(k);
    return k;
  };
  const refs = (v) => { const r = ints(v, roundCount); return r.length ? r : [startRound]; };
  const conf = v => (v === 'low' ? 'low' : 'high');

  const options = (Array.isArray(parsed.options) ? parsed.options : []).map(o => ({
    id: uniqId(o.id),
    type: 'option',
    title: str(o.title, 40) || '未命名方案',
    parent: 'cat-plans',
    state: ['chosen', 'rejected', 'candidate', 'warn'].includes(o.state) ? o.state : 'candidate',
    note: str(o.note, 80),
    roundRefs: refs(o.roundRefs),
    confidence: conf(o.confidence)
  }));
  // 最终选择至多一个（v0.3：唯一高亮）；多出的降为候选
  (() => {
    let seen = false;
    for (const o of options) {
      if (o.state === 'chosen') { if (seen) o.state = 'candidate'; else seen = true; }
    }
  })();
  const optIds = new Set(options.map(o => o.id));
  const chosenId = (options.find(o => o.state === 'chosen') || options[0] || {}).id;

  const tasks = (Array.isArray(parsed.tasks) ? parsed.tasks : []).map(t => ({
    id: uniqId(t.id),
    type: 'task',
    title: str(t.title, 40) || '未命名任务',
    parent: optIds.has(t.parent) ? t.parent : (chosenId || 'cat-plans'),
    status: ['done', 'doing', 'todo'].includes(t.status) ? t.status : 'todo',
    evidence: str(t.evidence, 80),
    roundRefs: refs(t.roundRefs),
    confidence: conf(t.confidence)
  }));

  const mapArr = (arr, type, defParent) => (Array.isArray(arr) ? arr : []).map(x => ({
    id: uniqId(x.id),
    type,
    title: str(x.title, 60) || '未命名',
    parent: defParent,
    note: str(x.note, 80),
    roundRefs: refs(x.roundRefs),
    confidence: conf(x.confidence)
  }));
  const decisions = mapArr(parsed.decisions, 'decision', 'cat-dec');
  const files = mapArr(parsed.files, 'file', 'cat-files');
  const questions = mapArr(parsed.questions, 'question', 'cat-todo')
    .map(q => Object.assign(q, { confidence: 'low' }));

  return { goal, startRound, timeline, options, tasks, decisions, files, questions };
}

/* ---------- 增量解析（v0.3 Phase 2：滚动窗口 + 图状态摘要） ---------- */
function resolveParseMode(o) {
  const forceFull = o.forceFull, cfgMode = o.cfgMode, prev = o.prev, roundCount = o.roundCount;
  if (forceFull) return 'full';
  if (cfgMode === 'full') return 'full';
  if (!prev || !Number.isInteger(prev.parsedRoundCount)) return 'full'; // 首次解析
  if (roundCount < prev.parsedRoundCount) return 'full';                // 转录被压缩/重写，回退全量
  if (roundCount === prev.parsedRoundCount) return 'skip';             // 无新增轮次
  return 'incremental';                                                // auto / incremental
}
function canonNode(n) {
  return JSON.stringify([n.id, n.type, n.title, n.parent, n.state || null, n.status || null,
    n.note || '', n.evidence || '', n.confidence || '', n.roundRefs || []]);
}
function normNodes(n) { return [].concat(n.options, n.tasks, n.decisions, n.files, n.questions); }
function computeGraphDiff(prev, next) {
  const prevMap = new Map((prev || []).map(n => [n.id, canonNode(n)]));
  const nextMap = new Map((next || []).map(n => [n.id, canonNode(n)]));
  let added = 0, removed = 0, updated = 0;
  (next || []).forEach(n => {
    if (!prevMap.has(n.id)) added++;
    else if (prevMap.get(n.id) !== canonNode(n)) updated++;
  });
  (prev || []).forEach(n => { if (!nextMap.has(n.id)) removed++; });
  return { added, removed, updated };
}
function buildPromptIncremental(lean, prev) {
  const instr = fs.readFileSync(path.join(DIR, 'parse-prompt.md'), 'utf8');
  const summary = JSON.stringify({
    goal: prev.goal,
    startRound: prev.startRound,
    timeline: prev.timeline || [],
    nodes: (prev.nodes || []).map(n => ({
      id: n.id, type: n.type, title: n.title, parent: n.parent,
      state: n.state, status: n.status, note: n.note, evidence: n.evidence,
      roundRefs: n.roundRefs, confidence: n.confidence
    }))
  });
  let payload = instr
    + '\n\n===== 当前导图状态（增量模式：以下节点已存在，除新增轮次给出修改依据外必须原样保留）=====\n' + summary
    + '\n\n===== 新增轮次（自上次解析以来）=====\n\n' + lean
    + '\n\n执行上述解析任务（增量模式）：基于「当前导图状态」与「新增轮次」，输出更新后的完整导图 JSON（不是 diff，是全量结果）。不要代码围栏，不要任何其他文字。';
  if (payload.length > 90000) payload = payload.slice(0, 90000) + '\n…（截断）';
  return payload;
}

/* ---------- 组装 graph.json（会话目录内） ---------- */
function writeGraph(norm, sd, sessionId, roundCount, meta) {
  const version = readVersion(sd) + 1;
  const graph = {
    version,
    sessionId,
    roundCount,
    parseMode: (meta && meta.mode) || 'full',
    parsedRoundCount: roundCount,
    generatedAt: new Date().toISOString(),
    goal: norm.goal,
    startRound: norm.startRound,
    timeline: norm.timeline,
    root: { id: 'root', type: 'root', title: norm.goal, note: '起点 · 第 ' + norm.startRound + ' 轮对话', roundRefs: [norm.startRound] },
    categories: [
      { id: 'cat-plans', type: 'category', title: '方案讨论', parent: 'root' },
      { id: 'cat-dec', type: 'category', title: '决策记录', parent: 'root' },
      { id: 'cat-files', type: 'category', title: '文件变更', parent: 'root' },
      { id: 'cat-todo', type: 'category', title: '待确认', parent: 'root' }
    ],
    nodes: [].concat(norm.options, norm.tasks, norm.decisions, norm.files, norm.questions)
  };
  atomicWrite(path.join(sd, 'graph.json'), JSON.stringify(graph, null, 2));
  atomicWrite(path.join(sd, 'version.txt'), String(version));
  // 最新完成解析的会话成为 viewer 默认跟随对象
  atomicWrite(path.join(WORK, 'current.json'), JSON.stringify({ sessionId, updatedAt: graph.generatedAt }, null, 1));
  return version;
}

/* ---------- 主流程 ---------- */
async function main() {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(SESSROOT, { recursive: true });

  // 转录来源：--transcript > 环境变量 > 遗留 trigger.json
  let transcriptPath = null;
  const ai = process.argv.indexOf('--transcript');
  if (ai > -1 && process.argv[ai + 1]) transcriptPath = process.argv[ai + 1];
  if (!transcriptPath && process.env.CODELY_TRANSCRIPT_PATH) transcriptPath = process.env.CODELY_TRANSCRIPT_PATH;
  if (!transcriptPath) {
    try { transcriptPath = JSON.parse(fs.readFileSync(path.join(WORK, 'trigger.json'), 'utf8')).transcriptPath; } catch (e) {}
  }
  if (!transcriptPath) { log('parser: 未找到转录来源（--transcript / CODELY_TRANSCRIPT_PATH / trigger.json）'); process.exit(1); }
  if (!fs.existsSync(transcriptPath)) { log('parser: 转录文件不存在 ' + transcriptPath); process.exit(1); }

  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const sessionId = resolveSessionId(raw);
  const sd = path.join(SESSROOT, sessionId);
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'parse.pid'), String(process.pid));
  log('parser: [' + sessionId + '] 开始解析 ' + transcriptPath);
  setStatus(sd, { state: 'running', startedAt: new Date().toISOString(), transcript: transcriptPath, sessionId });

  try {
    const history = loadTranscriptFromRaw(raw);
    const rounds = buildRounds(history);
    if (!rounds.length) throw new Error('转录中未发现用户轮次');

    // 模式决策（v0.2.0 增量解析）：--full / config.parseMode / 首次全量 / 转录回退全量 / 无新增跳过
    let prevGraph = null;
    try { prevGraph = JSON.parse(fs.readFileSync(path.join(sd, 'graph.json'), 'utf8')); } catch (e) {}
    const mode = resolveParseMode({
      forceFull: process.argv.includes('--full'),
      cfgMode: CFG.parseMode, prev: prevGraph, roundCount: rounds.length
    });
    if (mode === 'skip') {
      setStatus(sd, { state: 'ok', finishedAt: new Date().toISOString(), roundCount: rounds.length, version: readVersion(sd), parseMode: 'skip' });
      log('parser: [' + sessionId + '] 无新增轮次（' + rounds.length + '），跳过解析');
      return;
    }

    atomicWrite(path.join(sd, 'transcript.json'), JSON.stringify({ rounds: rounds.map(viewRound) }, null, 1));
    let lean, payloadInc = null, payloadFull;
    if (mode === 'incremental') {
      const newRounds = rounds.slice(prevGraph.parsedRoundCount); // 滚动窗口：只发新增轮次
      lean = renderLean(newRounds);
      payloadInc = buildPromptIncremental(lean, prevGraph);      // 图状态摘要 + 新增轮次
      log('parser: [' + sessionId + '] 增量模式 · 新增 ' + newRounds.length + ' 轮 · 图状态 ' + (prevGraph.nodes || []).length + ' 节点 · lean ' + lean.length + ' 字符');
    } else {
      lean = renderLean(rounds);
      log('parser: [' + sessionId + '] 全量模式 · ' + rounds.length + ' 轮 · lean ' + lean.length + ' 字符');
    }
    fs.writeFileSync(path.join(sd, 'lean.txt'), lean);
    payloadFull = buildPrompt(lean, sd);

    // 尝试序列：增量失败 / 疑似丢节点 → 回退全量（全量保留一次重试）
    const attempts = mode === 'incremental' ? ['incremental', 'full', 'full'] : ['full', 'full'];
    let norm = null, usedMode = mode, lastErr = null, diff = null;
    for (let i = 0; i < attempts.length && !norm; i++) {
      const m = attempts[i];
      try {
        log('parser: [' + sessionId + '] 调用 codely（' + m + (i > 0 ? ' · 回退' : '') + '）');
        const out = await runCodely(m === 'incremental' ? payloadInc : payloadFull);
        const n2 = normalize(extractJson(out), rounds.length);
        const nodes = normNodes(n2);
        if (prevGraph) {
          const d = computeGraphDiff(prevGraph.nodes, nodes);
          if (m === 'incremental' && (prevGraph.nodes || []).length > 0 && d.removed > (prevGraph.nodes || []).length * 0.5) {
            throw new Error('增量结果疑似丢节点（移除 ' + d.removed + '/' + prevGraph.nodes.length + '），回退全量');
          }
          diff = d;
        }
        norm = n2; usedMode = m;
      } catch (e) {
        lastErr = e;
        log('parser: [' + sessionId + '] ' + m + ' 解析失败 - ' + (e.message || e));
      }
    }
    if (!norm) throw (lastErr || new Error('解析失败'));

    const version = writeGraph(norm, sd, sessionId, rounds.length, { mode: usedMode });
    setStatus(sd, {
      state: 'ok', finishedAt: new Date().toISOString(), roundCount: rounds.length, version,
      parseMode: usedMode, diff: diff || undefined,
      counts: { options: norm.options.length, tasks: norm.tasks.length, decisions: norm.decisions.length, files: norm.files.length, questions: norm.questions.length }
    });
    log('parser: [' + sessionId + '] 完成 v' + version + '（' + (usedMode === 'incremental' ? '增量' : '全量') + '）'
      + (diff ? ' · 图变化 +' + diff.added + ' 新增 / ' + diff.updated + ' 更新 / -' + diff.removed + ' 移除' : '')
      + ' · 方案 ' + norm.options.length + ' · 任务 ' + norm.tasks.length
      + ' · 决策 ' + norm.decisions.length + ' · 文件 ' + norm.files.length + ' · 待确认 ' + norm.questions.length);
  } catch (e) {
    setStatus(sd, { state: 'error', finishedAt: new Date().toISOString(), error: String(e.message || e) });
    try { fs.unlinkSync(path.join(sd, 'last-hash')); } catch (e2) {} // 允许下一轮重试本转录
    log('parser: [' + sessionId + '] 失败 - ' + (e.message || e));
    process.exit(1);
  }
}
if (require.main === module) main();

/* ---------- 供测试与二次开发 ---------- */
module.exports = {
  resolveWork, resolveSessionId, loadTranscriptFromRaw, entryRole, entryParts,
  buildRounds, roundBlocks, renderLean, viewRound,
  buildPrompt, buildPromptIncremental, extractJson, normalize, writeGraph,
  resolveParseMode, computeGraphDiff, normNodes,
  __setConfig, __resetConfig
};
