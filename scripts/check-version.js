#!/usr/bin/env node
'use strict';
/*
 * 发布版本一致性校验：tag（vX.Y.Z）必须与 package.json、gemini-extension.json 的 version 一致。
 * 用法：node scripts/check-version.js v0.1.0   （CI 的 Release 工作流中作为发布闸门）
 */
const path = require('path');
const pkg = require(path.join(__dirname, '..', 'package.json'));
const ext = require(path.join(__dirname, '..', 'gemini-extension.json'));

const tag = process.argv[2];
if (!tag || !/^v\d+\.\d+\.\d+(-[\w.]+)?$/.test(tag)) {
  console.error('✗ 用法：node scripts/check-version.js vX.Y.Z（收到：' + (tag || '(空)') + '）');
  process.exit(1);
}
const v = tag.replace(/^v/, '');
const fails = [];
if (pkg.version !== v) fails.push('package.json version = ' + pkg.version);
if (ext.version !== v) fails.push('gemini-extension.json version = ' + ext.version);
if (fails.length) {
  console.error('✗ 版本不一致：tag=' + v + '，' + fails.join('；'));
  process.exit(1);
}
console.log('✓ 版本一致：tag ' + tag + ' ↔ package.json ↔ gemini-extension.json (' + v + ')');
