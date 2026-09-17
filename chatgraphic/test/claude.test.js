'use strict';
/* ChatGraphic · Claude 支持测试（离线，不调 codely/codex/claude）
 * 覆盖：Claude 转录归一化（isMeta/isSidechain/噪音行过滤 / 工具名经 tool_use_id 映射）、
 *       session id 提取、转录识别路由、Stop payload 解析、transcript 回退搜索、
 *       settings.json Stop Hook 注册（追加并存 / 幂等 / 迁移 / 卸载）、手动模式端到端 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('../parser.js');
const CH = require('../claude-hook.js');
const IC = require('../install-claude.js');

/* ---------- 合成 Claude 转录（结构对照 Claude Code 2.1.266 实测样本） ---------- */
const SID = '6a75416d-026e-4814-8d3b-a7b641ab309c';
const CLAUDE_TRANSCRIPT = [
  { type: 'mode', mode: 'default', sessionId: SID },                                  // 噪音行
  { type: 'permission-mode', sessionId: SID },                                          // 噪音行
  { type: 'user', isMeta: true, sessionId: SID, message: { role: 'user', content: [{ type: 'text', text: '<command-name>/clear</command-name>' }] } }, // 元信息
  { type: 'user', isSidechain: true, sessionId: SID, message: { role: 'user', content: [{ type: 'text', text: '子代理旁路消息' }] } },               // 旁路
  { type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'text', text: '看下当前 repo' }] } },
  { type: 'system', sessionId: SID, content: 'system noise' },                         // 噪音行
  { type: 'ai-title', sessionId: SID },                                               // 噪音行
  { type: 'assistant', sessionId: SID, message: { role: 'assistant', content: [
    { type: 'thinking', thinking: '内心独白不上图' },
    { type: 'text', text: '我先扫一眼仓库结构。' }
  ] } },
  { type: 'assistant', sessionId: SID, message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls -la /x' } }
  ] } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu1', content: 'total 0' }
  ] } },
  { type: 'user', sessionId: SID, message: { role: 'user', content: [
    { type: 'text', text: '<system-reminder>后台提醒注入</system-reminder>' },
    { type: 'text', text: '继续，说说结论' }
  ] } }
].map(l => JSON.stringify(l)).join('\n');

/* ---------- 转录归一化 ---------- */
test('loadTranscriptFromRaw：Claude 转录 → history（跳过 isMeta / isSidechain / 噪音行 / 注入）', () => {
  const h = P.loadTranscriptFromRaw(CLAUDE_TRANSCRIPT);
  assert.strictEqual(h.length, 5, '应得到 5 条（用户2 + 助手2 + 结果1；注入文本被过滤后留在其所在条目）');
  assert.strictEqual(h[0].role, 'user');
  assert.strictEqual(h[0].parts[0].text, '看下当前 repo');
  assert.ok(!h.some(e => JSON.stringify(e).includes('子代理旁路') || JSON.stringify(e).includes('内心独白')), '旁路与 thinking 不进 history');
  assert.ok(!JSON.stringify(h[4]).includes('system-reminder'), '同条目中的注入文本被过滤');
  assert.strictEqual(h[4].parts[0].text, '继续，说说结论');
});

test('buildRounds：Claude 会话轮次构建（工具名经 tool_use_id 映射、thinking 不上图）', () => {
  const rounds = P.buildRounds(P.loadTranscriptFromRaw(CLAUDE_TRANSCRIPT));
  assert.strictEqual(rounds.length, 2, '两条真实用户消息 → 两轮');
  assert.strictEqual(rounds[0].userText, '看下当前 repo');
  assert.ok(rounds[0].assistant.join('').includes('我先扫一眼仓库结构。'));
  assert.ok(!rounds[0].assistant.join('').includes('内心独白'), 'thinking 块不进轮次');
  assert.strictEqual(rounds[0].tools[0].name, 'Bash');
  assert.match(rounds[0].tools[0].summary, /ls -la \/x/);
  assert.strictEqual(rounds[0].tools[1].name, 'Bash', 'tool_result 的工具名应经 tool_use_id 映射');
  assert.strictEqual(rounds[0].tools[1].result, 'total 0');
  assert.strictEqual(rounds[1].userText, '继续，说说结论');
});

test('resolveSessionId：Claude 转录头提取 session id', () => {
  assert.strictEqual(P.resolveSessionId(CLAUDE_TRANSCRIPT), SID);
});

test('isClaudeTranscript：识别路由（Claude ✓ / Codex rollout ✗ / Codely ✗）', () => {
  assert.strictEqual(P.isClaudeTranscript(CLAUDE_TRANSCRIPT), true);
  const codexLike = [{ type: 'session_meta', payload: { id: '01a0756b-31f3-7cb1-8d6c-e7cc58e1ae03' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [] } }].map(l => JSON.stringify(l)).join('\n');
  assert.strictEqual(P.isClaudeTranscript(codexLike), false, 'Codex rollout 不误判');
  assert.strictEqual(P.isClaudeTranscript(JSON.stringify({ t: 'put', msg: { role: 'user', parts: [] } })), false, 'Codely JSONL 不误判');
  assert.strictEqual(P.isClaudeTranscript(''), false);
});

/* ---------- claude-hook 纯函数 ---------- */
test('parseHookPayload：仅接受 Stop；取 session_id 与 transcript_path', () => {
  assert.deepStrictEqual(
    CH.parseHookPayload(JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', transcript_path: '/t.jsonl' })),
    { sessionId: 's1', transcriptPath: '/t.jsonl' });
  assert.strictEqual(CH.parseHookPayload(JSON.stringify({ hook_event_name: 'SubagentStop', session_id: 's1' })), null, '子代理结束不触发');
  assert.strictEqual(CH.parseHookPayload(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1' })), null, '其他事件不触发');
  assert.strictEqual(CH.parseHookPayload('not-json'), null);
  assert.strictEqual(CH.parseHookPayload(JSON.stringify({ hook_event_name: 'Stop' })), null, '缺 session_id 视为无效');
});

test('findTranscriptForSession：projects 树回退搜索；未命中为 null', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cl-sess-'));
  const proj = path.join(root, '-Users-weiwei-x'); fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, SID + '.jsonl'), '{}');
  assert.strictEqual(CH.findTranscriptForSession(root, SID), path.join(proj, SID + '.jsonl'));
  assert.strictEqual(CH.findTranscriptForSession(root, '00000000-0000-4000-8000-000000000000'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

/* ---------- install-claude：settings.json Stop Hook 注册 ---------- */
function tmpSettings(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cl-cfg-'));
  const p = path.join(dir, 'settings.json');
  if (content != null) fs.writeFileSync(p, content);
  return { dir, p, hook: path.join(dir, 'claude-hook.js') };
}
const BASE_SETTINGS = JSON.stringify({ env: { FOO: 'bar' }, model: 'glm-5.3', includeCoAuthoredBy: false }, null, 2) + '\n';
const FOREIGN_HOOKS = JSON.stringify({ hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'say-done.sh' }] }] } }, null, 2) + '\n';

test('installTo：追加并存，不动既有配置与他人 Hook', () => {
  const { dir, p, hook } = tmpSettings(BASE_SETTINGS);
  const r = IC.installTo(p, hook);
  assert.strictEqual(r.changed, true);
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.strictEqual(s.env.FOO, 'bar', '既有配置保留');
  assert.strictEqual(s.model, 'glm-5.3', '既有 model 保留');
  assert.ok(findOurs(s, hook), '我们已注册');
  assert.ok(fs.existsSync(p + '.chatgraphic-backup'), '原文件备份');
  // 他人 Hook 并存
  const fx = tmpSettings(FOREIGN_HOOKS);
  IC.installTo(fx.p, fx.hook);
  const s2 = JSON.parse(fs.readFileSync(fx.p, 'utf8'));
  assert.strictEqual(s2.hooks.Stop.length, 2, '与他人条目并存');
  assert.ok(s2.hooks.Stop.some(g => g.hooks.some(h => h.command === 'say-done.sh')), '他人条目保留');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fx.dir, { recursive: true, force: true });
});
function findOurs(s, hook) {
  const cmd = IC.buildCommand(hook);
  return ((s.hooks && s.hooks.Stop) || []).some(g => g && g.hooks.some(h => h.command === cmd));
}

test('installTo：幂等与路径迁移', () => {
  const { dir, p, hook } = tmpSettings(BASE_SETTINGS);
  IC.installTo(p, hook);
  const once = fs.readFileSync(p, 'utf8');
  assert.strictEqual(IC.installTo(p, hook).changed, false, '二次注册幂等');
  assert.strictEqual(fs.readFileSync(p, 'utf8'), once, '幂等不改动文件');
  const elsewhere = path.join(path.dirname(hook), 'elsewhere', 'claude-hook.js');
  IC.installTo(p, elsewhere); // 路径变化 → 迁移
  assert.ok(fs.readFileSync(p, 'utf8').includes('elsewhere'), '路径变化应改写为新位置');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('uninstallFrom：只移除我们的一条；他人保留；无事件配置时还原 hooks 键', () => {
  const a = tmpSettings(BASE_SETTINGS);
  IC.installTo(a.p, a.hook);
  assert.strictEqual(IC.uninstallFrom(a.p, a.hook).changed, true);
  const sa = JSON.parse(fs.readFileSync(a.p, 'utf8'));
  assert.ok(!sa.hooks, 'hooks 下无事件配置应整体还原');
  assert.strictEqual(sa.model, 'glm-5.3', '其余配置不受影响');
  assert.strictEqual(IC.uninstallFrom(a.p, a.hook).changed, false, '再次卸载 no-op');

  const b = tmpSettings(FOREIGN_HOOKS);
  IC.installTo(b.p, b.hook);
  IC.uninstallFrom(b.p, b.hook);
  const sb = JSON.parse(fs.readFileSync(b.p, 'utf8'));
  assert.strictEqual(sb.hooks.Stop.length, 1, '他人条目保留');
  assert.ok(sb.hooks.Stop[0].hooks[0].command === 'say-done.sh');
  fs.rmSync(a.dir, { recursive: true, force: true });
  fs.rmSync(b.dir, { recursive: true, force: true });
});

/* ---------- claude-hook 手动模式端到端（stub parser） ---------- */
test('claude-hook 手动模式：转录路径 → 秒级退出 + 派发 + 去重落盘（session id 取自转录头）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cl-e2e-'));
  const tdir = path.join(home, 'transcripts');
  fs.mkdirSync(tdir, { recursive: true });
  const tp = path.join(tdir, SID + '.jsonl');
  fs.writeFileSync(tp, CLAUDE_TRANSCRIPT.split('\n').slice(0, 3).join('\n') + '\n'); // 头三行已含 sessionId
  const stub = path.join(home, 'stub-parser.js');
  fs.writeFileSync(stub, ''); // 空脚本即可：本测试验证 claude-hook 自身的派发与落盘
  const t0 = Date.now();
  const code = await new Promise(res => {
    const { spawn } = require('child_process');
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'claude-hook.js'), tp], {
      env: Object.assign({}, process.env, { CHATGRAPHIC_HOME: home, CHATGRAPHIC_PARSER_PATH: stub })
    });
    c.on('close', res);
  });
  assert.strictEqual(code, 0, 'claude-hook 正常退出');
  assert.ok(Date.now() - t0 < 1500, '秒级退出（不阻塞对话）');
  const sd = path.join(home, 'work', 'sessions', SID);
  assert.ok(fs.existsSync(path.join(sd, 'last-hash')), '去重 hash 落盘');
  const trig = JSON.parse(fs.readFileSync(path.join(sd, 'trigger.json'), 'utf8'));
  assert.strictEqual(trig.sessionId, SID, 'session id 应取自转录头');
  assert.strictEqual(trig.source, 'claude-manual');
  assert.strictEqual(trig.transcriptPath, tp);
  fs.rmSync(home, { recursive: true, force: true });
});
