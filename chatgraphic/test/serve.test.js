'use strict';
/* ChatGraphic · serve.js 集成测试（随机端口 + CHATGRAPHIC_HOME 指向夹具数据目录） */
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVE = path.join(__dirname, '..', 'serve.js');
const children = [];

function mkHomeWithSession() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-serve-'));
  const work = path.join(home, 'work'); /* CHATGRAPHIC_HOME 下实际数据根为 <home>/work */
  const sd = path.join(work, 'sessions', 'demo-1');
  fs.mkdirSync(sd, { recursive: true });
  fs.writeFileSync(path.join(sd, 'graph.json'), JSON.stringify({
    version: 3, sessionId: 'demo-1', roundCount: 5, generatedAt: '2026-09-16T00:00:00.000Z',
    goal: '测试目标', startRound: 1, timeline: [], root: null, categories: [], nodes: []
  }));
  fs.writeFileSync(path.join(sd, 'transcript.json'), JSON.stringify({ rounds: [] }));
  fs.writeFileSync(path.join(sd, 'version.txt'), '3');
  fs.writeFileSync(path.join(sd, 'status.json'), JSON.stringify({ state: 'ok' }));
  fs.writeFileSync(path.join(work, 'current.json'), JSON.stringify({ sessionId: 'demo-1' }));
  return home;
}

function startServe(env, args) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [SERVE].concat(args || []), {
      env: Object.assign({}, process.env, env),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    children.push(c);
    let out = '';
    const timer = setTimeout(() => reject(new Error('serve 启动超时: ' + out)), 10000);
    c.stdout.on('data', d => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)/);
      if (m) { clearTimeout(timer); resolve({ child: c, port: parseInt(m[1], 10) }); }
    });
    c.stderr.on('data', d => { out += d; });
    c.on('error', e => { clearTimeout(timer); reject(e); });
  });
}
const base = 'http://127.0.0.1:';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('路由：/sessions /current /session/<id>/* 与兼容路由、404', async () => {
  const home = mkHomeWithSession();
  const s = await startServe({ CHATGRAPHIC_HOME: home }, ['--port', '0', '--no-open']);

  const sessions = await (await fetch(base + s.port + '/sessions')).json();
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].sessionId, 'demo-1');
  assert.strictEqual(sessions[0].goal, '测试目标');
  assert.strictEqual(sessions[0].version, 3);

  const cur = await (await fetch(base + s.port + '/current')).json();
  assert.strictEqual(cur.sessionId, 'demo-1');

  const g = await (await fetch(base + s.port + '/session/demo-1/graph.json')).json();
  assert.strictEqual(g.goal, '测试目标');

  const ver = await (await fetch(base + s.port + '/session/demo-1/version')).text();
  assert.strictEqual(parseInt(ver, 10), 3);

  const st = await (await fetch(base + s.port + '/session/demo-1/status')).json();
  assert.strictEqual(st.state, 'ok');

  const compat = await (await fetch(base + s.port + '/graph.json')).json(); // 兼容旧路由（跟随 current）
  assert.strictEqual(compat.goal, '测试目标');

  const nf = await fetch(base + s.port + '/nope');
  assert.strictEqual(nf.status, 404);
});

test('端口占用自动避让：第二个 serve 应 +1 并正常服务', async () => {
  const home = mkHomeWithSession();
  const env = { CHATGRAPHIC_HOME: home };
  const a = await startServe(env, ['--port', '41971', '--no-open']);
  const b = await startServe(env, ['--port', '41971', '--no-open']);
  assert.strictEqual(b.port, a.port + 1, '端口被占应自动避让');
  const ra = await fetch(base + a.port + '/');
  const rb = await fetch(base + b.port + '/');
  assert.strictEqual(ra.status, 200);
  assert.strictEqual(rb.status, 200);
});

test.after(() => {
  children.forEach(c => { try { c.kill('SIGKILL'); } catch (e) {} });
});
