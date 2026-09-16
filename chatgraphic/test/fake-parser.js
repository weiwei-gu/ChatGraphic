#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic 测试专用：hook.js 的解析器替身。
 * 行为模拟真实 parser.js 的启动段——写 parse.pid 与 marker 后挂起，
 * 全程不调用 codely/LLM；等待被 hook 的「取代旧解析」杀掉或测试结束清理。
 */
const fs = require('fs');
const path = require('path');

function resolveWork() {
  if (process.env.CHATGRAPHIC_HOME) return path.join(process.env.CHATGRAPHIC_HOME, 'work');
  return path.join(process.env.HOME || os.tmpdir(), 'work');
}
const WORK = resolveWork();
const sid = process.env.CODELY_SESSION_ID || 'unknown';
const sd = path.join(WORK, 'sessions', sid);
fs.mkdirSync(sd, { recursive: true });
fs.writeFileSync(path.join(sd, 'parse.pid'), String(process.pid));
fs.writeFileSync(path.join(WORK, 'fake-parser-' + sid + '.json'),
  JSON.stringify({ pid: process.pid, sessionId: sid, ts: Date.now() }));
try { fs.writeFileSync(path.join(sd, 'status.json'), JSON.stringify({ state: 'running' })); } catch (e) {}
setInterval(() => {}, 60000); /* 挂起等待被杀 */
