#!/usr/bin/env node
'use strict';
/*
 * ChatGraphic · run-tests.js —— 跨平台测试入口
 * npm test 原写法 `node --test chatgraphic/test/*.test.js` 依赖通配符展开：
 *   POSIX 由 shell 展开；Windows 的 cmd 不展开，需 Node 21+ 的 --test 原生 glob。
 *   「Windows + Node 20」两者皆无 → 一个用例都跑不到，CI 该格自矩阵加入起常红。
 * 这里由脚本显式列出 *.test.js 交给 --test（文件参数在 Node 18+ 所有平台语义一致）。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = path.join(__dirname, '..', 'chatgraphic', 'test');
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(dir, f))
  .sort();
if (!files.length) {
  console.error('✗ 未找到测试文件（期望 ' + dir + ' 下有 *.test.js）');
  process.exit(1);
}
const child = spawn(process.execPath, ['--test'].concat(files), { stdio: 'inherit' });
child.on('error', e => { console.error('✗ 启动测试失败：' + e.message); process.exit(1); });
child.on('close', code => process.exit(code || 0));
