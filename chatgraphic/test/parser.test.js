'use strict';
/* ChatGraphic · parser 纯逻辑单元测试（离线，不调用 codely/LLM） */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const P = require('../parser.js');

/* ---------- Windows：codely .cmd shim 入口定位（spawn 无法直接执行 .cmd） ---------- */
test('codelyEntryFromDir：标准 npm 布局 / shim 文本解析 / 未命中', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codely-'));
  const pkgDir = path.join(root, 'node_modules', '@codely', 'cli');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ bin: { codely: 'bundle/gemini.js' } }));
  assert.strictEqual(P.codelyEntryFromDir(root), path.join(pkgDir, 'bundle', 'gemini.js'), '标准布局应经 package.json bin 定位');

  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codely-'));
  fs.writeFileSync(path.join(root2, 'codely.cmd'),
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@codely\\cli\\bundle\\gemini.js" %*');
  assert.strictEqual(P.codelyEntryFromDir(root2), path.join(root2, 'node_modules', '@codely', 'cli', 'bundle', 'gemini.js'), '无 package.json 时应解析 shim 文本');

  const root3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-codely-'));
  assert.strictEqual(P.codelyEntryFromDir(root3), null, '未命中应返回 null');
});

/* ---------- 转录归一化：三种真实格式 ---------- */
test('loadTranscriptFromRaw：auto-save clientHistory 格式', () => {
  const raw = JSON.stringify({ tag: 'x', clientHistory: [{ role: 'user', parts: [{ text: 'hi' }] }] });
  const h = P.loadTranscriptFromRaw(raw);
  assert.strictEqual(h.length, 1);
  assert.strictEqual(h[0].role, 'user');
});

test('loadTranscriptFromRaw：纯数组格式', () => {
  const h = P.loadTranscriptFromRaw(JSON.stringify([{ role: 'user', parts: [{ text: 'hi' }] }]));
  assert.strictEqual(h.length, 1);
});

test('loadTranscriptFromRaw：实时 JSONL（t:put 信封，取 msg，忽略 header/patch/ckpt）', () => {
  const raw = [
    JSON.stringify({ t: 'header', durableSessionId: 's-1', seq: 0 }),
    JSON.stringify({ t: 'put', seq: 1, msg: { id: 'm1', type: 'user', content: '你好' } }),
    JSON.stringify({ t: 'put', seq: 2, msg: { id: 'm2', type: 'gemini', content: '好的' } }),
    JSON.stringify({ t: 'session', seq: 3, patch: { foo: 1 } }),
    JSON.stringify({ t: 'ckpt', seq: 4, msgCount: 2 })
  ].join('\n');
  const h = P.loadTranscriptFromRaw(raw);
  assert.strictEqual(h.length, 2);
  assert.strictEqual(P.entryRole(h[0]), 'user');
  assert.strictEqual(P.entryRole(h[1]), 'model');
  assert.deepStrictEqual(P.entryParts(h[0]), [{ text: '你好' }]);
  assert.deepStrictEqual(P.entryParts(h[1]), [{ text: '好的' }]);
});

test('loadTranscriptFromRaw：无法识别的格式应抛错', () => {
  assert.throws(() => P.loadTranscriptFromRaw('这不是JSON\n也不是JSONL'), /无法识别/);
});

/* ---------- 轮次构建 ---------- */
test('buildRounds：剥离 [agent-auto]、工具调用摘要、工具结果截断、轮次编号', () => {
  const history = [
    { role: 'user', parts: [{ text: '[agent-auto] 系统上下文注入，应被忽略' }] },
    { role: 'model', parts: [{ text: 'Got it. Thanks for the context!' }] },
    { role: 'user', parts: [{ text: '帮我重构登录模块' }] },
    { role: 'model', parts: [
      { text: '开始实现。' },
      { functionCall: { id: 'c1', name: 'write_file', args: { file_path: '/a/b/auth/login.ts', content: '超长内容应被跳过' } } }
    ] },
    { role: 'user', parts: [{ functionResponse: { id: 'c1', name: 'write_file', response: { output: 'x'.repeat(500) } } }] },
    { role: 'model', parts: [{ text: '完成。' }] }
  ];
  const rounds = P.buildRounds(history);
  // agent-auto 被剥离后，模型 ack 先于首条真实用户消息 → 生成占位轮 1；真实提问为轮 2
  assert.strictEqual(rounds.length, 2);
  assert.ok(rounds[0].userText.includes('无明确起始提问'));
  assert.strictEqual(rounds[1].userText, '帮我重构登录模块');
  assert.ok(rounds[1].assistant.join('\n').includes('开始实现。'));
  assert.ok(rounds[1].assistant.join('\n').includes('完成。'));
  const fc = rounds[1].tools.find(t => t.name === 'write_file' && t.summary);
  assert.ok(fc, '应有工具调用摘要');
  assert.ok(fc.summary.includes('login.ts'), '路径参数应只保留 basename');
  assert.ok(!fc.summary.includes('超长内容'), 'content 参数不应进入摘要');
  const fr = rounds[1].tools.find(t => t.result);
  assert.ok(fr.result.length < 500 && fr.result.includes('截断'), '工具结果应被截断');
});

test('buildRounds：JSONL msg 格式（content 为字符串/块数组）', () => {
  const history = [
    { type: 'user', content: '第一问' },
    { type: 'gemini', content: '第一答' },
    { type: 'user', content: [{ text: '第二问' }] },
    { type: 'gemini', content: [{ text: '第二答' }] }
  ];
  const rounds = P.buildRounds(history);
  assert.strictEqual(rounds.length, 2);
  assert.strictEqual(rounds[0].userText, '第一问');
  assert.strictEqual(rounds[1].userText, '第二问');
  assert.ok(rounds[1].assistant.join(' ').includes('第二答'));
});

/* ---------- 精简与超限略去中段 ---------- */
test('renderLean：超限时保头保尾、略去中段并如实标注', () => {
  const rounds = [];
  for (let i = 1; i <= 10; i++) {
    rounds.push({ n: i, userText: '第' + i + '轮问题', assistant: ['x'.repeat(300)], tools: [] });
  }
  try {
    P.__setConfig({ maxTurnChars: 400, maxTotalLeanChars: 1200 });
    const lean = P.renderLean(rounds);
    assert.ok(lean.includes('第1轮问题'), '保头：第 1 轮必须在');
    assert.ok(lean.includes('第10轮问题'), '保尾：最后一轮必须在');
    assert.ok(lean.includes('已略去的轮次'), '必须标注略去的轮次');
    assert.ok(lean.length <= 1600, '总量受控（含标注行）');
  } finally {
    P.__resetConfig();
  }
});

/* ---------- 归一化 ---------- */
test('normalize：chosen 至多一个，多出的降为候选', () => {
  const out = P.normalize({
    goal: '目标', startRound: 1,
    options: [
      { id: 'opt-a', title: '方案A', state: 'chosen' },
      { id: 'opt-b', title: '方案B', state: 'chosen' }
    ], tasks: [], decisions: [], files: [], questions: []
  }, 3);
  const chosen = out.options.filter(o => o.state === 'chosen');
  assert.strictEqual(chosen.length, 1);
  assert.strictEqual(chosen[0].id, 'opt-a');
  assert.strictEqual(out.options[1].state, 'candidate');
});

test('normalize：任务 parent 兜底到最终选择/分类；roundRefs 钳制', () => {
  const out = P.normalize({
    goal: '目标', startRound: 2,
    options: [{ id: 'opt-a', title: '方案A', state: 'chosen' }],
    tasks: [
      { id: 't1', title: '有效任务', parent: 'opt-a', status: 'done', roundRefs: [2, 99] },
      { id: 't2', title: 'parent无效的任务', parent: 'opt-不存在', roundRefs: [] }
    ],
    decisions: [], files: [], questions: [{ id: 'q1', title: '疑问', confidence: 'high' }]
  }, 5);
  assert.strictEqual(out.tasks[0].parent, 'opt-a');
  assert.deepStrictEqual(out.tasks[0].roundRefs, [2], '超出轮次数的引用应被丢弃');
  assert.strictEqual(out.tasks[1].parent, 'opt-a', '无效 parent 兜底到最终选择');
  assert.deepStrictEqual(out.tasks[1].roundRefs, [2], '空引用兜底到 startRound');
  assert.strictEqual(out.questions[0].confidence, 'low', '待确认节点强制低置信');
});

test('normalize：重复 id 去重；timeline 空文本过滤', () => {
  const out = P.normalize({
    goal: '目标', startRound: 1,
    options: [{ id: 'dup', title: 'A' }, { id: 'dup', title: 'B' }],
    tasks: [], decisions: [], files: [], questions: [],
    timeline: [{ round: 1, text: '有效' }, { round: 2, text: '  ' }]
  }, 2);
  assert.deepStrictEqual(out.options.map(o => o.id).sort(), ['dup', 'dup-2']);
  assert.strictEqual(out.timeline.length, 1);
});

/* ---------- JSON 提取 ---------- */
test('extractJson：代码围栏 / 前后缀噪音 / 无 JSON 报错', () => {
  assert.deepStrictEqual(P.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepStrictEqual(P.extractJson('好的，结果是：\n{"a": 2}\n以上。'), { a: 2 });
  assert.throws(() => P.extractJson('完全没有 JSON'), /JSON/);
  assert.throws(() => P.extractJson(''), /空响应/);
});

/* ---------- 会话定位 ---------- */
test('resolveSessionId：--session 参数 > 环境变量 > JSONL 头 > tag > manual', () => {
  const origEnv = process.env.CODELY_SESSION_ID;
  try {
    process.argv.push('--session', 'from-argv');
    assert.strictEqual(P.resolveSessionId('x'), 'from-argv');
    process.argv.splice(-2, 2);

    process.env.CODELY_SESSION_ID = 'from-env';
    assert.strictEqual(P.resolveSessionId('x'), 'from-env');
    delete process.env.CODELY_SESSION_ID;

    assert.strictEqual(P.resolveSessionId('{"t":"header","durableSessionId":"s-9","seq":0}\n...'), 's-9');
    assert.strictEqual(P.resolveSessionId(JSON.stringify({ tag: 'auto-save-123' })), 'auto-save-123');
    assert.strictEqual(P.resolveSessionId('随便什么'), 'manual');
  } finally {
    if (origEnv !== undefined) process.env.CODELY_SESSION_ID = origEnv;
  }
});

/* ---------- 数据目录规则 ---------- */
test('resolveWork：CHATGRAPHIC_HOME > 扩展态（user ~/.chatgraphic / workspace 随项目）> 本地 work/', () => {
  const os = require('os');
  const extDir = path.join(os.homedir(), '.codely-cli', 'extensions', 'chatgraphic', 'chatgraphic');
  const projBase = path.resolve('/Users/somewhere/MyProject'); /* 经 resolve 归一，Windows 上带盘符，断言两侧才一致 */
  const wsDir = path.join(projBase, '.codely-cli', 'extensions', 'chatgraphic', 'chatgraphic'); // workspace 作用域
  const repoDir = '/Users/somewhere/ChatGraphic/chatgraphic';
  try {
    process.env.CHATGRAPHIC_HOME = '/tmp/cg-home';
    assert.strictEqual(P.resolveWork(extDir), path.join('/tmp/cg-home', 'work'));
    delete process.env.CHATGRAPHIC_HOME;
    assert.strictEqual(P.resolveWork(extDir), path.join(os.homedir(), '.chatgraphic'), 'user 作用域：数据不入扩展目录');
    assert.strictEqual(P.resolveWork(wsDir), path.join(projBase, '.chatgraphic'), 'workspace 作用域：数据随项目，不入扩展目录');
    assert.strictEqual(P.resolveWork(repoDir), path.join(repoDir, 'work'), '仓库/开发态用本地 work/');
  } finally {
    delete process.env.CHATGRAPHIC_HOME;
  }
});

/* ---------- 记忆完整性兜底（v0.3.1） ---------- */
test('strSentence：未触限原样；触限回退到句子边界；无边界保底硬切', () => {
  const short = 'C# 组件化开发，跨 25+ 平台。';
  assert.strictEqual(P.strSentence(short, 120), short, '未触限原样返回');
  const long = 'Unity 是跨平台引擎，支持导出 25+ 平台，全球过半手游出自 Unity；短板是画面上限不如 UE5，版本迭代快偶有坑，长句还会继续延伸到上限处被截断';
  const cut = P.strSentence(long, 60);
  assert.ok(cut.length <= 60, '不超过上限');
  assert.ok('。！？；．.!?;'.includes(cut[cut.length - 1]), '截断点应落在句子边界：' + cut);
  const noPunct = 'A'.repeat(200);
  assert.strictEqual(P.strSentence(noPunct, 60), 'A'.repeat(60), '找不到边界时保底硬切');
});

test('mergeBackMissing：缺失节点按类型补回，计数正确，已有节点不动', () => {
  const prev = { nodes: [
    { id: 'opt-a', type: 'option', title: '甲', note: 'x', roundRefs: [1], confidence: 'high' },
    { id: 'opt-b', type: 'option', title: '乙', note: 'y', roundRefs: [2], confidence: 'high' },
    { id: 'q-c', type: 'question', title: '丙?', note: '', roundRefs: [2], confidence: 'low' }
  ] };
  const norm = {
    options: [{ id: 'opt-a', title: '甲', note: '甲更新', roundRefs: [1, 3], confidence: 'high' }],
    tasks: [], decisions: [], files: [], questions: []
  };
  const rescued = P.mergeBackMissing(prev, norm);
  assert.strictEqual(rescued, 2, '补回 opt-b 与 q-c');
  assert.ok(norm.options.some(n => n.id === 'opt-b'), 'opt-b 补回 options');
  assert.ok(norm.questions.some(n => n.id === 'q-c'), 'q-c 补回 questions');
  assert.strictEqual(norm.options.find(n => n.id === 'opt-a').note, '甲更新', '既有节点不被覆盖');
  assert.strictEqual(P.mergeBackMissing({ nodes: [] }, norm), 0, '无缺失时计数为 0');
});
