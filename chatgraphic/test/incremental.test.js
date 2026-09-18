'use strict';
/* ChatGraphic · 增量解析单元测试（离线；数据目录经 CHATGRAPHIC_HOME 隔离） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/* 必须在 require parser 之前设置：parser 在模块加载时解析 WORK 目录 */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inc-'));
process.env.CHATGRAPHIC_HOME = HOME;
const P = require('../parser.js');

/* ---------- 模式决策 ---------- */
test('resolveParseMode：首次全量 / 有图增量 / 无新增跳过 / 压缩回退 / 强制与配置', () => {
  const prev = { parsedRoundCount: 5, nodes: [] };
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'auto', prev: null, roundCount: 3 }), 'full', '无上一版 → 全量');
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'auto', prev: {}, roundCount: 3 }), 'full', '上一版无 parsedRoundCount → 全量');
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'auto', prev, roundCount: 7 }), 'incremental', '有新增轮次 → 增量');
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'auto', prev, roundCount: 5 }), 'skip', '轮次不变 → 跳过');
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'auto', prev, roundCount: 4 }), 'full', '轮次变少（转录被压缩）→ 回退全量');
  assert.strictEqual(P.resolveParseMode({ forceFull: true, cfgMode: 'auto', prev, roundCount: 7 }), 'full', '--full 强制全量');
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'full', prev, roundCount: 7 }), 'full', '配置强制全量');
  assert.strictEqual(P.resolveParseMode({ forceFull: false, cfgMode: 'incremental', prev, roundCount: 7 }), 'incremental', '配置强制增量');
});

/* ---------- 图差异 ---------- */
test('computeGraphDiff：新增 / 更新 / 移除 计数正确，字段顺序不影响 updated 判定', () => {
  const prev = [
    { id: 'a', type: 'option', title: '甲', parent: 'cat-plans' },
    { id: 'b', type: 'task', title: '乙', parent: 'a', status: 'todo' },
    { id: 'c', type: 'decision', title: '丙', parent: 'cat-dec' }
  ];
  const next = [
    { parent: 'cat-plans', title: '甲', type: 'option', id: 'a' },          // 键序不同，内容相同 → 不算更新
    { id: 'b', type: 'task', title: '乙', parent: 'a', status: 'done' },   // 状态变化 → 更新
    { id: 'd', type: 'question', title: '丁', parent: 'cat-todo' }         // 新增
  ];
  const d = P.computeGraphDiff(prev, next);
  assert.strictEqual(d.added, 1);
  assert.strictEqual(d.updated, 1);
  assert.strictEqual(d.removed, 1, 'c 已不存在 → 移除');
  // 空上一版
  const d2 = P.computeGraphDiff([], next);
  assert.deepStrictEqual(d2, { added: 3, updated: 0, removed: 0 });
});

/* ---------- 增量提示词 ---------- */
test('buildPromptIncremental：含图状态摘要与新增轮次，不含旧轮次内容', () => {
  const prev = {
    goal: '旧目标', startRound: 2, timeline: [{ round: 3, text: '关键点' }],
    nodes: [{ id: 'opt-a', type: 'option', title: '既有方案A', parent: 'cat-plans', state: 'chosen', roundRefs: [3], confidence: 'high' }]
  };
  const lean = '[第 6 轮 · 用户]\n新增讨论内容XYZ\n\n[第 6 轮 · 助手]\n新方案结论';
  const payload = P.buildPromptIncremental(lean, prev);
  assert.ok(payload.includes('当前导图状态'), '应标识图状态输入');
  assert.ok(payload.includes('既有方案A') && payload.includes('opt-a'), '应携带上一版节点');
  assert.ok(payload.includes('新增讨论内容XYZ'), '应携带新增轮次');
  assert.ok(!payload.includes('旧轮次内容不存在'), '占位检查');
  assert.ok(payload.includes('不是 diff'), '应说明输出为全量结果');
});

/* ---------- writeGraph 集成（隔离数据目录） ---------- */
test('writeGraph：写入 parsedRoundCount / parseMode，版本递增，current 指针更新', () => {
  const sid = 'sess-inc-write';
  const sd = path.join(HOME, 'work', 'sessions', sid);
  fs.mkdirSync(sd, { recursive: true });
  const norm = {
    goal: '测试目标', startRound: 1, timeline: [],
    options: [{ id: 'o1', type: 'option', title: '方案', parent: 'cat-plans', state: 'chosen', note: '', roundRefs: [1], confidence: 'high' }],
    tasks: [], decisions: [], files: [], questions: []
  };
  let v = P.writeGraph(norm, sd, sid, 6, { mode: 'incremental' });
  assert.strictEqual(v, 1);
  let g = JSON.parse(fs.readFileSync(path.join(sd, 'graph.json'), 'utf8'));
  assert.strictEqual(g.parsedRoundCount, 6);
  assert.strictEqual(g.parseMode, 'incremental');
  assert.strictEqual(g.version, 1);
  const cur = JSON.parse(fs.readFileSync(path.join(HOME, 'work', 'current.json'), 'utf8'));
  assert.strictEqual(cur.sessionId, sid);
  v = P.writeGraph(norm, sd, sid, 8, { mode: 'full' });
  assert.strictEqual(v, 2, '版本应递增');
  g = JSON.parse(fs.readFileSync(path.join(sd, 'graph.json'), 'utf8'));
  assert.strictEqual(g.parsedRoundCount, 8);
  assert.strictEqual(g.parseMode, 'full');
  // 版本快照：写 v2 前应保留 v1 全文
  assert.ok(fs.existsSync(path.join(sd, 'graph.v1.json')), '写新版前生成上一版快照');
  const snap = JSON.parse(fs.readFileSync(path.join(sd, 'graph.v1.json'), 'utf8'));
  assert.strictEqual(snap.version, 1, '快照是第一版');
  assert.strictEqual(snap.parsedRoundCount, 6, '快照内容为上一版（6 轮）');
});

/* ---------- 端到端：增量丢节点回退全量（fake codely，跨平台 bin 布局） ---------- */
test('增量失败回退全量：payload / lean.txt 必须携带完整转录，历史轮次不得丢失', async () => {
  const sid = 'sess-fallback';
  const sd = path.join(HOME, 'work', 'sessions', sid);
  fs.mkdirSync(sd, { recursive: true });
  // 上一版图：2 方案、已解析 2 轮；新转录 3 轮 → 增量模式
  const prev = {
    version: 1, sessionId: sid, roundCount: 2, parseMode: 'incremental', parsedRoundCount: 2,
    goal: '引擎选型', startRound: 1, timeline: [], root: {}, categories: [],
    nodes: [
      { id: 'opt-a', type: 'option', title: '方案甲', parent: 'cat-plans', state: 'candidate', note: '甲详情', roundRefs: [1], confidence: 'high' },
      { id: 'opt-b', type: 'option', title: '方案乙', parent: 'cat-plans', state: 'candidate', note: '乙详情', roundRefs: [2], confidence: 'high' }
    ]
  };
  fs.writeFileSync(path.join(sd, 'graph.json'), JSON.stringify(prev, null, 2));
  fs.writeFileSync(path.join(sd, 'version.txt'), '1'); // readVersion 从 version.txt 起算，须与 prev 一致

  // fake codely：第 1 次（增量）返回丢节点 JSON 触发回退，之后（全量）返回完整图；每次调用落盘收到的 payload
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fakebin-'));
  const cliDir = path.join(bin, 'node_modules', '@codely', 'cli');
  fs.mkdirSync(path.join(cliDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({ name: '@codely/cli', bin: { codely: 'bin/codely.js' } }));
  const bad = JSON.stringify({
    goal: '引擎选型', startRound: 3, timeline: [],
    options: [{ id: 'opt-x', title: '错乱节点', state: 'candidate', note: '', roundRefs: [3], confidence: 'low' }],
    tasks: [], decisions: [], files: [], questions: []
  });
  const good = JSON.stringify({
    goal: '引擎选型', startRound: 1, timeline: [{ round: 3, text: '改选方案丙' }],
    options: [
      { id: 'opt-a', title: '方案甲', state: 'candidate', note: '甲详情', roundRefs: [1], confidence: 'high' },
      { id: 'opt-b', title: '方案乙', state: 'candidate', note: '乙详情', roundRefs: [2], confidence: 'high' },
      { id: 'opt-c', title: '方案丙', state: 'chosen', note: '丙敲定', roundRefs: [3], confidence: 'high' }
    ],
    tasks: [], decisions: [], files: [], questions: []
  });
  fs.writeFileSync(path.join(cliDir, 'bin', 'codely.js'), [
    "'use strict';",
    'const fs = require("fs"); const path = require("path");',
    'const dir = path.join(__dirname, "..");',
    'let n = 0; try { n = JSON.parse(fs.readFileSync(path.join(dir, "counter.json"), "utf8")).n; } catch (e) {}',
    'n += 1; fs.writeFileSync(path.join(dir, "counter.json"), JSON.stringify({ n }));',
    'const ai = process.argv.indexOf("-p");',
    'fs.writeFileSync(path.join(dir, "payload-" + n + ".txt"), ai > -1 ? process.argv[ai + 1] : "");',
    'process.stdout.write(n === 1 ? ' + JSON.stringify(bad) + ' : ' + JSON.stringify(good) + ');'
  ].join('\n'));
  // POSIX 直接 spawn('codely')，需 PATH 内可执行 shim；Windows 走 resolveCodelySpawn 的标准 npm 布局
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(bin, 'codely'), '#!/usr/bin/env node\nrequire("./node_modules/@codely/cli/bin/codely.js");\n');
    fs.chmodSync(path.join(bin, 'codely'), 0o755);
  }

  const jsonl = [
    JSON.stringify({ t: 'header', durableSessionId: sid, seq: 0 }),
    JSON.stringify({ t: 'put', seq: 1, msg: { id: 'm1', type: 'user', content: '第一轮讨论方案甲，甲很全面' } }),
    JSON.stringify({ t: 'put', seq: 2, msg: { id: 'm2', type: 'assistant', content: '甲方案介绍' } }),
    JSON.stringify({ t: 'put', seq: 3, msg: { id: 'm3', type: 'user', content: '第二轮讨论方案乙' } }),
    JSON.stringify({ t: 'put', seq: 4, msg: { id: 'm4', type: 'assistant', content: '乙方案介绍' } }),
    JSON.stringify({ t: 'put', seq: 5, msg: { id: 'm5', type: 'user', content: '第三轮改选方案丙' } }),
    JSON.stringify({ t: 'put', seq: 6, msg: { id: 'm6', type: 'assistant', content: '丙方案敲定' } })
  ].join('\n');
  const tr = path.join(HOME, 'fb.jsonl');
  fs.writeFileSync(tr, jsonl);

  const env = Object.assign({}, process.env, { CHATGRAPHIC_HOME: HOME, PATH: bin + path.delimiter + process.env.PATH });
  delete env.APPDATA; // Windows 下避免 resolveCodelySpawn 先命中 APPDATA/npm 里的真实 codely
  const parserPath = path.join(__dirname, '..', 'parser.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [parserPath, '--transcript', tr], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('parser 子进程超时')); }, 60000);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('parser 退出码 ' + code + '：' + out.slice(-500))); });
  });

  // 回退全量被采用：图 = 全量结果（既有节点不丢）
  const g = JSON.parse(fs.readFileSync(path.join(sd, 'graph.json'), 'utf8'));
  assert.strictEqual(g.parseMode, 'full', '增量丢节点后应回退全量');
  assert.strictEqual(g.version, 2, '版本递增');
  assert.deepStrictEqual(g.nodes.map(n => n.id).sort(), ['opt-a', 'opt-b', 'opt-c'], '全量结果应含全部节点');

  // 回归点 1：lean.txt 记录实际发送的输入 —— 回退后必须换成完整转录，不能只剩新增轮次
  const lean = fs.readFileSync(path.join(sd, 'lean.txt'), 'utf8');
  assert.ok(lean.includes('第一轮讨论方案甲'), 'lean.txt 应含历史轮次（回退后为完整转录）');
  assert.ok(lean.includes('第三轮改选方案丙'), 'lean.txt 应含新增轮次');

  // 回归点 2：第 2 次引擎调用（回退全量）收到的 payload 必须含全部轮次 —— 修复前只有新增轮次
  const payload2 = fs.readFileSync(path.join(cliDir, 'payload-2.txt'), 'utf8');
  assert.ok(payload2.includes('第一轮讨论方案甲'), '回退全量 payload 应含历史轮次');
  assert.ok(payload2.includes('第三轮改选方案丙'), '回退全量 payload 应含新增轮次');
  assert.ok(!payload2.includes('===== 当前导图状态'), '全量 payload 不应携带增量专用的图状态段');
});

/* ---------- 端到端：增量丢少量节点（≤50%）合并兜底 ---------- */
test('增量丢少量节点：mergeBackMissing 补回、不回退全量（单次引擎调用）', async () => {
  const sid = 'sess-merge-back';
  const sd = path.join(HOME, 'work', 'sessions', sid);
  fs.mkdirSync(sd, { recursive: true });
  // 上一版：5 节点、已解析 2 轮
  const prev = {
    version: 1, sessionId: sid, roundCount: 2, parseMode: 'incremental', parsedRoundCount: 2,
    goal: '引擎选型', startRound: 1, timeline: [], root: {}, categories: [],
    nodes: [
      { id: 'opt-a', type: 'option', title: '方案甲', parent: 'cat-plans', state: 'candidate', note: '甲详情', roundRefs: [1], confidence: 'high' },
      { id: 'opt-b', type: 'option', title: '方案乙', parent: 'cat-plans', state: 'candidate', note: '乙详情', roundRefs: [2], confidence: 'high' },
      { id: 'q-c', type: 'question', title: '目标平台?', parent: 'cat-todo', note: '', roundRefs: [2], confidence: 'low' },
      { id: 'dec-d', type: 'decision', title: '用 TypeScript', parent: 'cat-dec', note: '拍板', roundRefs: [2], confidence: 'high' },
      { id: 'f-e', type: 'file', title: 'a.ts', parent: 'cat-files', note: '创建', roundRefs: [2], confidence: 'high' }
    ]
  };
  fs.writeFileSync(path.join(sd, 'graph.json'), JSON.stringify(prev, null, 2));
  fs.writeFileSync(path.join(sd, 'version.txt'), '1');

  // fake codely：一次返回丢 2/5 节点（40%）的结果——若 parser 走合并兜底则不会来第二次调用
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fakebin-'));
  const cliDir = path.join(bin, 'node_modules', '@codely', 'cli');
  fs.mkdirSync(path.join(cliDir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'package.json'), JSON.stringify({ name: '@codely/cli', bin: { codely: 'bin/codely.js' } }));
  const partial = JSON.stringify({
    goal: '引擎选型', startRound: 1, timeline: [],
    options: [
      { id: 'opt-a', title: '方案甲', state: 'candidate', note: '甲详情更新', roundRefs: [1, 3], confidence: 'high' },
      { id: 'opt-b', title: '方案乙', state: 'candidate', note: '乙详情', roundRefs: [2], confidence: 'high' },
      { id: 'opt-new', title: '新方案', state: 'candidate', note: '本轮新增', roundRefs: [3], confidence: 'high' }
    ],
    tasks: [], decisions: [{ id: 'dec-d', title: '用 TypeScript', note: '拍板', roundRefs: [2], confidence: 'high' }],
    files: [], questions: []
  });
  const boom = JSON.stringify({ goal: '不该走到这', startRound: 1, timeline: [], options: [], tasks: [], decisions: [], files: [], questions: [] });
  fs.writeFileSync(path.join(cliDir, 'bin', 'codely.js'), [
    "'use strict';",
    'const fs = require("fs"); const path = require("path");',
    'const dir = path.join(__dirname, "..");',
    'let n = 0; try { n = JSON.parse(fs.readFileSync(path.join(dir, "counter.json"), "utf8")).n; } catch (e) {}',
    'n += 1; fs.writeFileSync(path.join(dir, "counter.json"), JSON.stringify({ n }));',
    'process.stdout.write(n === 1 ? ' + JSON.stringify(partial) + ' : ' + JSON.stringify(boom) + ');'
  ].join('\n'));
  if (process.platform !== 'win32') {
    fs.writeFileSync(path.join(bin, 'codely'), '#!/usr/bin/env node\nrequire("./node_modules/@codely/cli/bin/codely.js");\n');
    fs.chmodSync(path.join(bin, 'codely'), 0o755);
  }

  const jsonl = [
    JSON.stringify({ t: 'header', durableSessionId: sid, seq: 0 }),
    JSON.stringify({ t: 'put', seq: 1, msg: { id: 'm1', type: 'user', content: '第一轮讨论方案甲' } }),
    JSON.stringify({ t: 'put', seq: 2, msg: { id: 'm2', type: 'assistant', content: '甲方案介绍' } }),
    JSON.stringify({ t: 'put', seq: 3, msg: { id: 'm3', type: 'user', content: '第二轮讨论方案乙并拍板 TypeScript' } }),
    JSON.stringify({ t: 'put', seq: 4, msg: { id: 'm4', type: 'assistant', content: '乙方案介绍' } }),
    JSON.stringify({ t: 'put', seq: 5, msg: { id: 'm5', type: 'user', content: '第三轮又提出新方案' } }),
    JSON.stringify({ t: 'put', seq: 6, msg: { id: 'm6', type: 'assistant', content: '新方案介绍' } })
  ].join('\n');
  const tr = path.join(HOME, 'mb.jsonl');
  fs.writeFileSync(tr, jsonl);

  const env = Object.assign({}, process.env, { CHATGRAPHIC_HOME: HOME, PATH: bin + path.delimiter + process.env.PATH });
  delete env.APPDATA;
  const parserPath = path.join(__dirname, '..', 'parser.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [parserPath, '--transcript', tr], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} reject(new Error('parser 子进程超时')); }, 60000);
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('parser 退出码 ' + code + '：' + out.slice(-500))); });
  });

  // 合并兜底生效：一次调用、增量模式、5 旧节点全在（+1 新节点）
  const calls = JSON.parse(fs.readFileSync(path.join(cliDir, 'counter.json'), 'utf8')).n;
  assert.strictEqual(calls, 1, '不应回退全量重跑（引擎只被调用 1 次）');
  const g = JSON.parse(fs.readFileSync(path.join(sd, 'graph.json'), 'utf8'));
  assert.strictEqual(g.parseMode, 'incremental', '仍为增量结果');
  const ids = g.nodes.map(n => n.id).sort();
  assert.deepStrictEqual(ids, ['dec-d', 'f-e', 'opt-a', 'opt-b', 'opt-new', 'q-c'], '缺失的 2 个旧节点被补回');
  const st = JSON.parse(fs.readFileSync(path.join(sd, 'status.json'), 'utf8'));
  assert.strictEqual(st.diff.removed, 0, '补回后无移除');
  assert.strictEqual(st.diff.added, 1, '新方案 1 个新增');
});
