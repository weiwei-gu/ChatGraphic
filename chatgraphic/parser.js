#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · parser.js — 解析 worker（会话级隔离 + 增量解析版）
 * 由 hook.js 异步派发，也可手动补跑：
 *   node parser.js --transcript <路径> [--session <会话id>] [--full]
 * 每个会话独立目录 work/sessions/<sessionId>/，多窗口并行互不干扰；
 * 解析开始即切换 work/current.json 指针（viewer 从「解析中」状态起就开始跟随本会话；完成时更新时间戳）。
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

/* 数据目录：CHATGRAPHIC_HOME 可覆盖；扩展安装态数据不入扩展目录（防 update 清空）——
   用户级（~/.codely-cli/extensions/…）放 ~/.chatgraphic/，workspace 级（<项目>/.codely-cli/extensions/…）随项目放 <项目>/.chatgraphic/；
   仓库/开发态用本地 work/ */
function resolveWork(dir) {
  if (process.env.CHATGRAPHIC_HOME) return path.join(process.env.CHATGRAPHIC_HOME, 'work');
  const parts = path.resolve(dir).split(path.sep);
  const i = parts.lastIndexOf('.codely-cli');
  if (i > 0 && parts[i + 1] === 'extensions') {
    const projectDir = parts.slice(0, i).join(path.sep);
    if (projectDir === os.homedir()) return path.join(os.homedir(), '.chatgraphic'); /* 用户级扩展：机器共享 */
    return path.join(projectDir, '.chatgraphic'); /* workspace 级扩展：随项目 */
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
  const cx = String(raw).slice(0, 400).match(/"type":"session_meta","payload":\{"id":"([A-Za-z0-9\-]+)"/); // Codex rollout 头
  if (cx) return cx[1];
  const cl = String(raw).slice(0, 2000).match(/"session_?[Ii]d":"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"/); // Claude 会话转录头
  if (cl) return cl[1];
  try { const o = JSON.parse(raw); if (o.tag) return o.tag; } catch (e) {} // auto-save
  return 'manual';
}

/* ---------- 转录归一化（clientHistory / 数组 / JSONL / Claude 风格 容错） ---------- */
function loadTranscriptFromRaw(raw) {
  let data;
  try { data = JSON.parse(raw); }
  catch (e) {
    // JSONL 容错：逐行解析后按信封分派（Codex rollout / Claude 会话转录 / Codely 实时转录）
    const lines = raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (e2) { return null; } })
      .filter(Boolean);
    if (lines.some(l => l.type === 'session_meta' || l.type === 'response_item')) {
      data = codexRolloutToHistory(lines); // Codex rollout（~/.codex/sessions/**/rollout-*.jsonl）
    } else if (isClaudeTranscript(raw)) {
      data = claudeTranscriptToHistory(lines); // Claude Code 会话转录（~/.claude/projects/<项目slug>/<会话id>.jsonl）
    } else {
      data = lines.filter(l => l.t === 'put' && l.msg).map(l => l.msg); // Codely 实时转录（t:"put" + msg 信封）
    }
  }
  let history = null;
  if (Array.isArray(data)) history = data;
  else if (data && Array.isArray(data.clientHistory)) history = data.clientHistory;
  else if (data && Array.isArray(data.history)) history = data.history;
  else if (data && Array.isArray(data.messages)) history = data.messages;
  if (!history || !history.length) throw new Error('无法识别的转录格式（非 JSON 数组 / clientHistory / history / messages / JSONL）');
  return history;
}
/* Codex rollout → 通用 history：取 response_item 记录（event_msg 为其回显，跳过）；
 * developer/system 为注入内容，跳过；注入式 user 文本（<environment_context> 等）不构成轮次起点；
 * function_call_output 仅含 call_id，经 function_call 建 call_id→工具名 映射。 */
const CODEX_INJECTED_RE = /^<(environment_context|user_instructions|permissions|turn_context|AGENTS\.md)/;
function codexRolloutToHistory(lines) {
  const callNames = new Map();
  const out = [];
  for (const l of lines) {
    const p = (l && l.type === 'response_item' && l.payload) || null;
    if (!p) continue;
    if (p.type === 'message') {
      const role = p.role === 'assistant' ? 'model' : p.role;
      if (role !== 'user' && role !== 'model') continue;
      const parts = (Array.isArray(p.content) ? p.content : [])
        .map(c => (c && typeof c.text === 'string') ? { text: c.text } : null).filter(Boolean);
      if (!parts.length) continue;
      if (role === 'user') {
        const real = parts.filter(pt => !CODEX_INJECTED_RE.test(String(pt.text).trimStart()));
        if (!real.length) continue; // 纯注入（环境上下文等），不构成轮次
        out.push({ role, parts: real });
      } else out.push({ role, parts });
    } else if (p.type === 'function_call' && p.name) {
      callNames.set(p.call_id, p.name);
      let args = {};
      try { args = JSON.parse(p.arguments || '{}'); } catch (e) { args = { raw: truncate(String(p.arguments), 80) }; }
      out.push({ role: 'model', parts: [{ functionCall: { name: p.name, args } }] });
    } else if (p.type === 'function_call_output') {
      out.push({ role: 'user', parts: [{ functionResponse: { name: callNames.get(p.call_id) || 'tool', response: { output: p.output } } }] });
    }
  }
  return out;
}
/* Claude Code 会话转录 → 通用 history：只取 type=user/assistant 的 message.content；
 * 跳过 isMeta / isSidechain（子代理旁路，其结果经主线程 tool_result 回流不丢信息）与
 * mode/attachment/system/ai-title 等噪音行；<command-name>/<system-reminder> 等注入不构成轮次；
 * tool_result 仅含 tool_use_id，经 tool_use 建 id→工具名 映射。 */
const CLAUDE_NOISE_RE = /^<(command-name|command-message|command-args|local-command|system-reminder|bash-input|bash-output|user-prompt-summar)/;
function isClaudeTranscript(raw) {
  const head = String(raw).slice(0, 8000);
  return /"type":"(user|assistant)"/.test(head) && /"sessionId"/.test(head);
}
function claudeTranscriptToHistory(lines) {
  const callNames = new Map();
  const out = [];
  for (const l of lines) {
    if (!l || (l.type !== 'user' && l.type !== 'assistant') || l.isMeta || l.isSidechain) continue;
    const c0 = l.message && l.message.content;
    const content = Array.isArray(c0) ? c0 : (typeof c0 === 'string' ? [{ type: 'text', text: c0 }] : []);
    if (!content.length) continue;
    if (l.type === 'user') {
      const parts = [];
      for (const c of content) {
        if (c.type === 'tool_result') {
          let rc = c.content;
          if (Array.isArray(rc)) rc = rc.map(x => x && x.text).filter(Boolean).join('\n');
          if (rc == null || rc === '') rc = l.toolUseResult != null ? JSON.stringify(l.toolUseResult).slice(0, 200) : '';
          parts.push({ functionResponse: { name: callNames.get(c.tool_use_id) || 'tool', response: { output: rc } } });
        } else if (c.type === 'text' && typeof c.text === 'string') {
          parts.push({ text: c.text });
        }
      }
      const real = parts.filter(p => p.functionResponse || !CLAUDE_NOISE_RE.test(String(p.text || '').trimStart()));
      if (real.length) out.push({ role: 'user', parts: real });
    } else {
      const parts = [];
      for (const c of content) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) parts.push({ text: c.text });
        else if (c.type === 'tool_use' && c.name) {
          callNames.set(c.id, c.name);
          parts.push({ functionCall: { name: c.name, args: c.input || {} } });
        } // thinking 块不上图
      }
      if (parts.length) out.push({ role: 'model', parts });
    }
  }
  return out;
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
/* ---------- Windows：codely 是 .cmd shim，spawn 无法直接执行（ENOENT）。
   定位真实 JS 入口后改用当前 node 运行（零依赖，且避开 shell 引号/转义问题） ---------- */
function codelyEntryFromDir(d) {
  // 1) 标准 npm 全局布局：<d>/node_modules/@codely/cli/package.json 的 bin.codely
  try {
    const pkgDir = path.join(d, 'node_modules', '@codely', 'cli');
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.codely);
    if (bin) return path.resolve(pkgDir, bin);
  } catch (e) { /* 布局不匹配，继续 */ }
  // 2) 解析 .cmd shim 文本中的 JS 目标（兼容自定义 prefix 等非标准布局）
  try {
    const txt = fs.readFileSync(path.join(d, 'codely.cmd'), 'utf8');
    const m = txt.match(/(%dp0%|[A-Za-z]:)[^"\r\n]*?node_modules[\\/]@codely[\\/]cli[\\/][^"\r\n]*?\.js/);
    if (m) return path.resolve(m[0].split('%dp0%').join(d).replace(/\\/g, '/'));
  } catch (e) { /* 继续 */ }
  return null;
}
function resolveCodelySpawn() {
  if (process.platform !== 'win32') return { cmd: 'codely', pre: [] };
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  String(process.env.PATH || '').split(path.delimiter).forEach(d => { if (d) dirs.push(d); });
  for (const d of dirs) {
    const entry = codelyEntryFromDir(d);
    if (entry) return { cmd: process.execPath, pre: [entry] };
  }
  return { cmd: 'codely', pre: [] }; // 未定位到 → 保持原生命令（POSIX 正常；Windows 将报 ENOENT）
}
function runCodely(payload) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (CFG.model) args.push('-m', CFG.model);
    args.push('--output-format', 'text', '-p', payload);
    // 独占临时目录作为 cwd：同机并行解析互不共享任何 cwd 内状态
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgraphic-parse-'));
    const codely = resolveCodelySpawn();
    const child = spawn(codely.cmd, codely.pre.concat(args), {
      cwd: scratch,
      env: Object.assign({}, process.env, { CHATGRAPHIC_CHILD: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
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
/* ---------- 同链路解析（Codex 会话）：codex exec 无头运行 ----------
   「同链路」在 Codex 侧的本义：用用户 Codex 配置的模型/认证（config.toml 的 model），
   config.json 的 model 不参与路由；引擎由转录格式决定（isCodexRollout）。
   exec 为 agent 形态：stdin 必须立即关闭（读附加输入直到 EOF）；--skip-git-repo-check
   适配 tmpdir cwd；stdout 即最终回复（extractJson 括号配对可容忍少量过程输出）。 */
function isCodexRollout(raw) {
  return /"type":"(session_meta|response_item)"/.test(String(raw).slice(0, 400));
}
function runCodex(payload) {
  return new Promise((resolve, reject) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgraphic-parse-'));
    const child = spawn('codex', ['exec', '--skip-git-repo-check', payload], {
      cwd: scratch,
      env: Object.assign({}, process.env, { CHATGRAPHIC_CHILD: '1' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    child.stdin.end(); // exec 从 stdin 读附加输入直到 EOF，必须立即关闭
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
      else reject(new Error('codex exec 退出码 ' + code + '；stderr: ' + err.slice(0, 400)));
    });
  });
}
/* ---------- 同链路解析（Claude 会话）：claude -p 无头运行 ----------
   用用户 Claude Code 配置的模型/认证（~/.claude/settings.json 的 env/model），
   config.json 的 model 不参与；引擎由转录格式决定（isClaudeTranscript）。 */
function runClaude(payload) {
  return new Promise((resolve, reject) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgraphic-parse-'));
    const child = spawn('claude', ['-p', payload, '--output-format', 'text'], {
      cwd: scratch,
      env: Object.assign({}, process.env, { CHATGRAPHIC_CHILD: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
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
      else reject(new Error('claude -p 退出码 ' + code + '；stderr: ' + err.slice(0, 400)));
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
    // note 上限 120：与「1~2 句、写具体信息」规则配套（80 会让两句话被硬切破句）
    note: str(x.note, 120),
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
  /* 解析开始即切换 viewer 跟随指针：新会话解析期间徽章即显示「解析中」（完成时下方再更新时间戳） */
  atomicWrite(path.join(WORK, 'current.json'), JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 1));

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
    let lean, payloadInc = null;
    const leanFull = renderLean(rounds); // 全量输入（全量模式 / 增量失败回退共用）必须覆盖全部轮次
    if (mode === 'incremental') {
      const newRounds = rounds.slice(prevGraph.parsedRoundCount); // 滚动窗口：只发新增轮次
      lean = renderLean(newRounds);
      payloadInc = buildPromptIncremental(lean, prevGraph);      // 图状态摘要 + 新增轮次
      log('parser: [' + sessionId + '] 增量模式 · 新增 ' + newRounds.length + ' 轮 · 图状态 ' + (prevGraph.nodes || []).length + ' 节点 · lean ' + lean.length + ' 字符');
    } else {
      lean = leanFull;
      log('parser: [' + sessionId + '] 全量模式 · ' + rounds.length + ' 轮 · lean ' + lean.length + ' 字符');
    }
    fs.writeFileSync(path.join(sd, 'lean.txt'), lean);
    // 回退全量不得复用增量 lean：那只有新增轮次，历史内容会整体丢失（伪全量，图必然退化）
    const payloadFull = buildPrompt(leanFull, sd);

    // 尝试序列：增量失败 / 疑似丢节点 → 回退全量（全量保留一次重试）
    // 引擎路由（同链路）：Codex rollout → codex exec；Claude 会话转录 → claude -p；其余 → codely -p
    const engine = isCodexRollout(raw) ? 'codex' : (isClaudeTranscript(raw) ? 'claude' : 'codely');
    const attempts = mode === 'incremental' ? ['incremental', 'full', 'full'] : ['full', 'full'];
    let norm = null, usedMode = mode, lastErr = null, diff = null;
    for (let i = 0; i < attempts.length && !norm; i++) {
      const m = attempts[i];
      if (m === 'full' && mode === 'incremental' && lean !== leanFull) {
        lean = leanFull;
        fs.writeFileSync(path.join(sd, 'lean.txt'), lean); // lean.txt 记录实际发送的输入，回退后须换成完整转录
        log('parser: [' + sessionId + '] 回退全量 · lean 切换为完整转录 ' + lean.length + ' 字符');
      }
      try {
        const engineCall = { codex: runCodex, claude: runClaude, codely: runCodely }[engine];
        const engineTag = { codex: 'codex exec', claude: 'claude -p', codely: 'codely' }[engine];
        log('parser: [' + sessionId + '] 调用 ' + engineTag + '（' + m + (i > 0 ? ' · 回退' : '') + '）');
        const out = await engineCall(m === 'incremental' ? payloadInc : payloadFull);
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
  resolveParseMode, computeGraphDiff, normNodes, codexRolloutToHistory, isCodexRollout,
  claudeTranscriptToHistory, isClaudeTranscript,
  codelyEntryFromDir, resolveCodelySpawn,
  __setConfig, __resetConfig
};
