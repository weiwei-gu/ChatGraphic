'use strict';
/* ChatGraphic · install.js 单元测试（全部针对临时 settings 文件，不碰真实配置） */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const I = require('../install.js');

const HOOK_DIR = path.join(__dirname, '..');
function mkSettingsPath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-inst-')), 'settings.json');
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));

test('全新安装 → 幂等 → 卸载后完全还原（无 hooks 残留）', () => {
  const sp = mkSettingsPath();
  const r1 = I.installTo(sp, HOOK_DIR);
  assert.strictEqual(r1.changed, true);
  let s = read(sp);
  assert.strictEqual(s.hooks.enabled, true);
  assert.strictEqual(s.hooks.AfterAgent.length, 1);
  assert.ok(s.hooks.AfterAgent[0].hooks[0].command.includes(path.join(HOOK_DIR, 'hook.js')));

  const r2 = I.installTo(sp, HOOK_DIR); // 幂等
  assert.strictEqual(r2.changed, false);
  assert.strictEqual(read(sp).hooks.AfterAgent.length, 1);

  const r3 = I.uninstallFrom(sp, HOOK_DIR);
  assert.strictEqual(r3.changed, true);
  s = read(sp);
  assert.strictEqual(s.hooks, undefined, 'hooks 空壳应整体还原');
});

test('保留已有 hooks 配置与他人 Hook、无关顶层键', () => {
  const sp = mkSettingsPath();
  fs.writeFileSync(sp, JSON.stringify({
    unityInsight: { enabled: true },
    hooks: { enabled: true, AfterAgent: [{ matcher: 'x', hooks: [{ type: 'command', command: 'node other.js' }] }] }
  }));
  I.installTo(sp, HOOK_DIR);
  assert.strictEqual(read(sp).hooks.AfterAgent.length, 2, '应追加而非覆盖');

  I.uninstallFrom(sp, HOOK_DIR);
  const s = read(sp);
  assert.strictEqual(s.hooks.AfterAgent.length, 1, '只移除自己的条目');
  assert.strictEqual(s.hooks.AfterAgent[0].hooks[0].command, 'node other.js', '他人 Hook 不受影响');
  assert.strictEqual(s.hooks.enabled, true, 'hooks 配置键保留');
  assert.deepStrictEqual(s.unityInsight, { enabled: true }, '无关顶层键保留');
});

test('未安装时卸载为 no-op（不创建文件）', () => {
  const sp = mkSettingsPath();
  const r = I.uninstallFrom(sp, HOOK_DIR);
  assert.strictEqual(r.changed, false);
  assert.ok(!fs.existsSync(sp), '未安装时不得创建 settings 文件');
});

test('statusOf 报告安装状态', () => {
  const sp = mkSettingsPath();
  assert.strictEqual(I.statusOf(sp, HOOK_DIR).installed, false);
  I.installTo(sp, HOOK_DIR);
  assert.strictEqual(I.statusOf(sp, HOOK_DIR).installed, true);
  I.uninstallFrom(sp, HOOK_DIR);
  assert.strictEqual(I.statusOf(sp, HOOK_DIR).installed, false);
});
