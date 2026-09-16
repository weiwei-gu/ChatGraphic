#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic POC · serve.js — 本地只读视图服务（会话级隔离版，零依赖）
 * 用法：node serve.js [--port 4830] [--no-open]
 * 路由：
 *   /                    viewer.html
 *   /sessions            会话列表（按更新时间倒序）
 *   /current             viewer 默认跟随的会话（最近一次完成解析的会话）
 *   /session/<id>/graph.json | transcript.json | version | status
 *   /graph.json /transcript.json /version /status   兼容旧路由（跟随 current）
 * 端口被占用时自动 +1 避让（同机多实例共存）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const DIR = __dirname;

/* 数据目录：与 hook.js/parser.js 同规则（CHATGRAPHIC_HOME > 扩展安装态 ~/.chatgraphic > 本地 work/） */
function resolveWork(dir) {
  if (process.env.CHATGRAPHIC_HOME) return path.join(process.env.CHATGRAPHIC_HOME, 'work');
  if (path.resolve(dir).includes(path.sep + '.codely-cli' + path.sep + 'extensions' + path.sep)) {
    return path.join(os.homedir(), '.chatgraphic');
  }
  return path.join(dir, 'work');
}
const WORK = resolveWork(DIR);
const SESSROOT = path.join(WORK, 'sessions');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8')); } catch (e) {}

const args = process.argv.slice(2);
let port = cfg.port || 4830;
const pi = args.indexOf('--port');
if (pi > -1 && args[pi + 1]) port = parseInt(args[pi + 1], 10) || port;
const noOpen = args.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};
const JSON_TYPE = 'application/json; charset=utf-8';

function readCurrent() {
  try { return JSON.parse(fs.readFileSync(path.join(WORK, 'current.json'), 'utf8')).sessionId || null; }
  catch (e) { return null; }
}
function listSessions() {
  const out = [];
  try {
    for (const d of fs.readdirSync(SESSROOT)) {
      try {
        const g = JSON.parse(fs.readFileSync(path.join(SESSROOT, d, 'graph.json'), 'utf8'));
        out.push({
          sessionId: d, goal: g.goal, version: g.version,
          roundCount: g.roundCount, generatedAt: g.generatedAt
        });
      } catch (e) { /* 无 graph.json 的目录跳过 */ }
    }
  } catch (e) { /* sessions 目录不存在 */ }
  out.sort((a, b) => String(b.generatedAt || '').localeCompare(String(a.generatedAt || '')));
  return out;
}

const server = http.createServer((req, res) => {
  const u = (req.url || '/').split('?')[0];
  const send = (code, type, body) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(body);
  };
  const sendFile = (p, fallback, code) => {
    try { send(200, MIME[path.extname(p)] || 'text/plain; charset=utf-8', fs.readFileSync(p)); }
    catch (e) { send(code || 404, JSON_TYPE, JSON.stringify({ error: fallback })); }
  };

  if (u === '/' || u === '/index.html') return sendFile(path.join(DIR, 'viewer.html'), 'viewer.html 缺失');
  if (u === '/sessions') return send(200, JSON_TYPE, JSON.stringify(listSessions()));
  if (u === '/current') return send(200, JSON_TYPE, JSON.stringify({ sessionId: readCurrent() }));

  const m = u.match(/^\/session\/([A-Za-z0-9_\-]+)\/(graph\.json|transcript\.json|version|status)$/);
  if (m) {
    const dir = path.join(SESSROOT, m[1]);
    if (m[2] === 'version') return sendFile(path.join(dir, 'version.txt'), '0');
    if (m[2] === 'status') return sendFile(path.join(dir, 'status.json'), '{}');
    return sendFile(path.join(dir, m[2]), '尚未生成（先聊一轮或手动补跑）', 503);
  }

  // 兼容旧路由：跟随 current 会话
  if (u === '/graph.json' || u === '/transcript.json' || u === '/version' || u === '/status') {
    const cur = readCurrent();
    if (!cur) return send(503, JSON_TYPE, JSON.stringify({ error: '尚无会话：先在 Codely 里聊一轮，或手动补跑 node chatgraphic/parser.js --transcript <会话JSON>' }));
    const dir = path.join(SESSROOT, cur);
    if (u === '/version') return sendFile(path.join(dir, 'version.txt'), '0');
    if (u === '/status') return sendFile(path.join(dir, 'status.json'), '{}');
    return sendFile(path.join(dir, u.slice(1)), '尚未生成', 503);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('404');
});

// 端口占用自动避让：同机多实例（同项目多窗口、多项目）互不打架
let tries = 0;
server.on('error', e => {
  if (e && e.code === 'EADDRINUSE' && tries < 10) {
    tries++;
    port++;
    server.listen(port);
  } else {
    console.error('端口监听失败：', e.message);
    process.exit(1);
  }
});
server.listen(port, () => {
  const actual = (server.address() && server.address().port) || port; /* --port 0 = 随机端口（测试用） */
  const url = 'http://localhost:' + actual;
  console.log('ChatGraphic viewer → ' + url);
  if (tries > 0 && actual === port) console.log('（配置端口被占用，已自动避让到 ' + port + '）');
  console.log('提示：导图未生成时，在 Codely 里聊一轮即可；历史会话可手动补跑：');
  console.log('      node chatgraphic/parser.js --transcript <会话JSON路径>');
  if (!noOpen) {
    // 按平台打开浏览器（Windows 用 cmd start，空串占位防 start 把 URL 当窗口标题）；失败静默不影响服务
    const opener = process.platform === 'win32' ? { cmd: 'cmd', pre: ['/c', 'start', ''] }
      : process.platform === 'darwin' ? { cmd: 'open', pre: [] }
      : { cmd: 'xdg-open', pre: [] };
    try { require('child_process').spawn(opener.cmd, opener.pre.concat(url), { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch (e) {}
  }
});
