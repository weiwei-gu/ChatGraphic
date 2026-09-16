'use strict';
/* ChatGraphic · 增量解析单元测试（离线；数据目录经 CHATGRAPHIC_HOME 隔离） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
});
