'use strict';
/* ChatGraphic · hook.js 集成测试（子进程方式，用 fake-parser 替身，不调用 LLM） */
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, '..', 'hook.js');
const FAKE_PARSER = path.join(__dirname, 'fake-parser.js');

function mkHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hooktest-')); }
function writeTranscript(dir, content) {
  const p = path.join(dir, 't-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(p, JSON.stringify({ clientHistory: [{ role: 'user', parts: [{ text: content }] }] }));
  return p;
}
function runHook(env, args) {
  return spawnSync(process.execPath, [HOOK].concat(args || []), {
    env: Object.assign({}, process.env, env),
    encoding: 'utf8', timeout: 15000
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const markerOf = (home, sid) => path.join(home, 'work', 'fake-parser-' + sid + '.json');
const baseEnv = home => ({
  CHATGRAPHIC_HOME: home,
  CHATGRAPHIC_PARSER_PATH: FAKE_PARSER
});

test('防递归守卫：CHATGRAPHIC_CHILD=1 时秒退且不产生任何文件', () => {
  const home = mkHome();
  const r = runHook(Object.assign(baseEnv(home), { CHATGRAPHIC_CHILD: '1' }), ['/nonexistent.json']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stderr, '');
  assert.ok(!fs.existsSync(path.join(home, 'work')), '守卫应先于 mkdir 生效');
});

test('派发 → sha1 去重 → 内容变化后重派发', async () => {
  const home = mkHome();
  const sid = 'sess-a';
  const env = Object.assign(baseEnv(home), { CODELY_SESSION_ID: sid });
  const t1 = writeTranscript(home, '第一轮内容');

  // 1) 首次触发：应派发（替身写出 marker）
  let r = runHook(env, [t1]);
  assert.strictEqual(r.status, 0);
  await sleep(400);
  assert.ok(fs.existsSync(markerOf(home, sid)), '首次触发应派发解析');
  assert.ok(fs.existsSync(path.join(home, 'work', 'sessions', sid, 'trigger.json')), '应写入 trigger');
  assert.ok(fs.existsSync(path.join(home, 'work', 'sessions', sid, 'last-hash')), '应写入去重哈希');

  // 2) 同一转录再次触发：去重，不重复派发
  fs.unlinkSync(markerOf(home, sid));
  r = runHook(env, [t1]);
  assert.strictEqual(r.status, 0);
  await sleep(400);
  assert.ok(!fs.existsSync(markerOf(home, sid)), '同一转录应被去重（无再次派发）');

  // 3) 转录内容变化：重新派发
  const t2 = writeTranscript(home, '第二轮内容');
  r = runHook(env, [t2]);
  assert.strictEqual(r.status, 0);
  await sleep(400);
  assert.ok(fs.existsSync(markerOf(home, sid)), '内容变化后应重派发');

  // 清理替身进程
  killFake(home, sid);
});

test('取代旧解析：新触发应杀掉仍在运行的旧解析进程', async () => {
  const home = mkHome();
  const sid = 'sess-b';
  const env = Object.assign(baseEnv(home), { CODELY_SESSION_ID: sid });
  const t1 = writeTranscript(home, '旧内容');
  const t2 = writeTranscript(home, '新内容');

  runHook(env, [t1]);
  await sleep(400);
  const m = JSON.parse(fs.readFileSync(markerOf(home, sid), 'utf8'));
  const pidA = m.pid;
  process.kill(pidA, 0); // 旧替身应存活（挂起中）

  runHook(env, [t2]);
  await sleep(300);
  let dead = false;
  try { process.kill(pidA, 0); } catch (e) { dead = true; }
  assert.ok(dead, '新触发应杀掉未完成的旧解析（进程组 kill）');

  killFake(home, sid);
});

/** 读取 parse.pid 并清理替身（避免测试残留挂起进程） */
function killFake(home, sid) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(home, 'work', 'sessions', sid, 'parse.pid'), 'utf8'), 10);
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} } }
  } catch (e) { /* 文件不存在则无需清理 */ }
}
