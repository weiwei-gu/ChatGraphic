'use strict';
/* ChatGraphic · Codex 支持测试（离线，不调 codely/LLM）
 * 覆盖：rollout 转录归一化（注入过滤 / 工具名映射 / event_msg 去重）、session_meta 会话定位、
 *       notify 参数解析、rollout 文件定位、config.toml notify 注册（插入位置 / 幂等 / 占用 / 卸载 / 迁移）、
 *       codex-hook 手动模式端到端（stub parser 派发 + 去重落盘） */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('../parser.js');
const CX = require('../codex-hook.js');
const IC = require('../install-codex.js');

/* ---------- 合成 rollout（结构对照 codex-cli 0.141.0 实测样本） ---------- */
const TID = '01a0756b-31f3-7cb1-8d6c-e7cc58e1ae03';
const ROLLOUT = [
  { type: 'session_meta', payload: { id: TID, cwd: '/x', cli_version: '0.141.0' } },
  { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>' }] } },
  { type: 'event_msg', payload: { type: 'user_message', message: '看下当前 repo' } }, // response_item 的回显，应跳过
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '看下当前 repo' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我先扫一眼仓库结构。' }] } },
  { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"ls -la /x"}', call_id: 'c1' } },
  { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'total 0' } },
  { type: 'event_msg', payload: { type: 'token_count', info: {} } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '仓库是空的。' }] } }
].map(l => JSON.stringify(l)).join('\n');

/* ---------- 转录归一化 ---------- */
test('loadTranscriptFromRaw：Codex rollout → history（跳过 developer / 注入 / event_msg）', () => {
  const h = P.loadTranscriptFromRaw(ROLLOUT);
  assert.strictEqual(h.length, 5, '应得到 5 条（用户1 + 助手2 + 调用1 + 结果1）');
  assert.strictEqual(h[0].role, 'user');
  assert.strictEqual(h[0].parts[0].text, '看下当前 repo');
  assert.strictEqual(h[4].parts[0].text, '仓库是空的。');
});

test('buildRounds：Codex 会话轮次构建（注入文本不构成轮次、工具名经 call_id 映射）', () => {
  const rounds = P.buildRounds(P.loadTranscriptFromRaw(ROLLOUT));
  assert.strictEqual(rounds.length, 1, '一条真实用户消息 → 一轮（developer/环境注入不算）');
  const r = rounds[0];
  assert.strictEqual(r.userText, '看下当前 repo');
  assert.strictEqual(r.assistant.length, 2);
  assert.strictEqual(r.tools[0].name, 'exec_command');
  assert.match(r.tools[0].summary, /ls -la \/x/);
  assert.strictEqual(r.tools[1].name, 'exec_command', 'function_call_output 的工具名应经 call_id 映射');
  assert.strictEqual(r.tools[1].result, 'total 0');
});

test('resolveSessionId：Codex session_meta 头提取 thread id', () => {
  assert.strictEqual(P.resolveSessionId(ROLLOUT), TID);
});

/* ---------- codex-hook 纯函数 ---------- */
test('parseNotifyArgv：kebab-case 优先、snake_case 兼容、非 JSON 为 null', () => {
  assert.deepStrictEqual(CX.parseNotifyArgv('{"type":"agent-turn-complete","thread-id":"a1"}'), { threadId: 'a1', type: 'agent-turn-complete' });
  assert.strictEqual(CX.parseNotifyArgv('{"thread_id":"a2"}').threadId, 'a2');
  assert.strictEqual(CX.parseNotifyArgv('not-json'), null);
  assert.strictEqual(CX.parseNotifyArgv('/path/rollout-x.jsonl'), null, '文件路径不是 JSON → 交手动模式');
});

test('findRolloutForThread：sessions 树定位，同名取最新；未命中为 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cx-sess-'));
  const sid = '01234567-89ab-4cde-8f01-23456789abcd';
  const d1 = path.join(root, '2026', '09', '05'); fs.mkdirSync(d1, { recursive: true });
  const d2 = path.join(root, '2026', '09', '06'); fs.mkdirSync(d2, { recursive: true });
  const old = path.join(d1, 'rollout-2026-09-05T01-00-00-' + sid + '.jsonl');
  const neu = path.join(d2, 'rollout-2026-09-06T02-00-00-' + sid + '.jsonl');
  fs.writeFileSync(old, '{}'); fs.writeFileSync(neu, '{}');
  const t = Date.now() / 1000;
  fs.utimesSync(old, t - 86400, t - 86400);
  fs.utimesSync(neu, t, t);
  assert.strictEqual(CX.findRolloutForThread(root, sid), neu);
  assert.strictEqual(CX.findRolloutForThread(root, '00000000-0000-4000-8000-000000000000'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('threadIdOfRolloutFile：从文件名提取 thread id', () => {
  assert.strictEqual(CX.threadIdOfRolloutFile('/a/rollout-2026-09-06T14-32-34-' + TID + '.jsonl'), TID);
  assert.strictEqual(CX.threadIdOfRolloutFile('/a/other.jsonl'), null);
});

/* ---------- install-codex：config.toml notify 注册 ---------- */
function tmpCfg(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cx-cfg-'));
  const cfg = path.join(dir, 'config.toml');
  if (content != null) fs.writeFileSync(cfg, content);
  return { dir, cfg, hook: path.join(dir, 'codex-hook.js') };
}
const BASE_CFG = 'model = "m"\n\n[projects."/a"]\ntrust_level = "trusted"\n';

test('installTo：顶层 notify 插入在首个表头之前，其余行原样保留', () => {
  const { dir, cfg, hook } = tmpCfg(BASE_CFG);
  const r = IC.installTo(cfg, hook);
  assert.strictEqual(r.changed, true);
  const lines = fs.readFileSync(cfg, 'utf8').split('\n');
  const nIdx = IC.findTopLevelNotifyIdx(lines);
  const tIdx = lines.findIndex(l => l.trim().startsWith('[projects'));
  assert.ok(nIdx > -1 && nIdx < tIdx, 'notify 必须位于表头之前');
  assert.ok(lines[nIdx].includes('codex-hook.js'));
  assert.ok(lines[nIdx + 1].trim() === '', 'notify 与表头之间保留空行');
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('trust_level = "trusted"'), '原有内容不变');
  assert.ok(fs.existsSync(cfg + '.chatgraphic-backup'), '原文件已备份');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installTo：幂等与路径迁移', () => {
  const { dir, cfg, hook } = tmpCfg(BASE_CFG);
  IC.installTo(cfg, hook);
  const once = fs.readFileSync(cfg, 'utf8');
  assert.strictEqual(IC.installTo(cfg, hook).changed, false, '二次注册幂等');
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), once, '幂等不改动文件');
  IC.installTo(cfg, path.join(path.dirname(hook), 'elsewhere', 'codex-hook.js'));
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('elsewhere'), '路径变化应改写为新位置');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installTo：notify 被其他程序占用 → 告警不动手', () => {
  const { dir, cfg, hook } = tmpCfg('notify = ["python", "ding.py"]\n\n[projects."/a"]\ntrust_level = "trusted"\n');
  const r = IC.installTo(cfg, hook);
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.blocked, true);
  assert.ok(fs.readFileSync(cfg, 'utf8').includes('ding.py'), '占用时不改动');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('installTo：无 config.toml 时新建仅含 notify；无表头时追加末尾', () => {
  const a = tmpCfg(null);
  IC.installTo(a.cfg, a.hook);
  assert.strictEqual(fs.readFileSync(a.cfg, 'utf8').trim(), IC.buildNotifyLine(a.hook), '全新文件只含一行 notify');
  const b = tmpCfg('model = "m"\n');
  IC.installTo(b.cfg, b.hook);
  const nonEmpty = fs.readFileSync(b.cfg, 'utf8').split('\n').filter(l => l.trim() !== '');
  assert.ok(nonEmpty[nonEmpty.length - 1].includes('notify = ['), '无表头时 notify 应追加在末尾');
  assert.strictEqual(nonEmpty[0], 'model = "m"', '原有键保留在前');
  fs.rmSync(a.dir, { recursive: true, force: true });
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test('uninstallFrom：移除我们的一条；他人的不动；未注册为 no-op', () => {
  const { dir, cfg, hook } = tmpCfg(BASE_CFG);
  IC.installTo(cfg, hook);
  assert.strictEqual(IC.uninstallFrom(cfg, hook).changed, true);
  assert.strictEqual(fs.readFileSync(cfg, 'utf8'), BASE_CFG, '卸载后恢复原文件');
  assert.strictEqual(IC.uninstallFrom(cfg, hook).changed, false, '再次卸载 no-op');
  const fx = tmpCfg('notify = ["python", "ding.py"]\n');
  assert.strictEqual(IC.uninstallFrom(fx.cfg, hook).changed, false, '他人 notify 不动');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fx.dir, { recursive: true, force: true });
});

/* ---------- codex-hook 手动模式端到端（stub parser） ---------- */
test('codex-hook 手动模式：rollout 路径 → 秒级退出 + 派发 + 去重落盘', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cx-e2e-'));
  const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const d = path.join(home, 'codex-sessions', '2026', '09', '06');
  fs.mkdirSync(d, { recursive: true });
  const ro = path.join(d, 'rollout-2026-09-06T10-00-00-' + sid + '.jsonl');
  fs.writeFileSync(ro, JSON.stringify({ type: 'session_meta', payload: { id: sid } }) + '\n');
  const stub = path.join(home, 'stub-parser.js');
  fs.writeFileSync(stub, ''); // 空脚本即可：本测试验证 codex-hook 自身的派发与落盘
  const t0 = Date.now();
  const code = await new Promise(res => {
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'codex-hook.js'), ro], {
      env: Object.assign({}, process.env, { CHATGRAPHIC_HOME: home, CHATGRAPHIC_PARSER_PATH: stub })
    });
    c.on('close', res);
  });
  assert.strictEqual(code, 0, 'codex-hook 正常退出');
  assert.ok(Date.now() - t0 < 1500, '秒级退出（不阻塞对话）');
  const sd = path.join(home, 'work', 'sessions', sid);
  assert.ok(fs.existsSync(path.join(sd, 'last-hash')), '去重 hash 落盘');
  const trig = JSON.parse(fs.readFileSync(path.join(sd, 'trigger.json'), 'utf8'));
  assert.strictEqual(trig.sessionId, sid);
  assert.strictEqual(trig.source, 'codex');
  assert.strictEqual(trig.transcriptPath, ro);
  fs.rmSync(home, { recursive: true, force: true });
});
