'use strict';

// =============================================================================
// 團隊協同 · ntfy-teams —— 設定儲存層的離線測試
//
// 測的是「設定與憑證真的落成能讀回來的 YAML」：往返一致、壞檔不吞、
// 憑證權限收緊、原子寫入不留半份、js-yaml 缺席時內建實作仍可用。
//
// 跑法：node test/config-store-node.js
// =============================================================================

const assert = require('assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require(path.join(__dirname, '..', 'lib', 'config-store.js'));
const t = store.__test;

let passed = 0;
let failed = 0;

/**
 * 跑一個測試。
 * @param name - 名稱。
 * @param fn - 內容。
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL ' + name);
    console.log('       ' + (err && err.message ? err.message : String(err)));
  }
}

/** @returns 一个全新的临时目录。 */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-teams-cfg-'));
}

/**
 * 清掉临时目录。
 * @param dir - 目录。
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) { /* 清不掉就算了 */ }
}

/**
 * 严格比较两个值 —— 用 JSON 序列化。
 *
 * 为什么不用 deepStrictEqual：它对 `{}` 与 `[]` 的比较会放过去，但这两者
 * 在 YAML 里是完全不同的东西（一个映射、一个阵列）。实测就是靠这个才发现
 * 空物件被写成 `[]`。
 *
 * @param actual - 实际值。
 * @param expected - 期望值。
 * @param message - 失败时的说明。
 */
function assertSame(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert.strictEqual(a, b, (message || '') + '\n        實際：' + a + '\n        期望：' + b);
}

console.log('設定儲存層離線測試（YAML）');
console.log('  YAML 實作：' + t.yamlBackend().label + (t.yamlBackend().usingLibrary ? '' : '（js-yaml 從外掛目錄 require 不到，走內建）'));
console.log('');

// ------------------------------------------------------------------ YAML 往返
console.log('== YAML 往返');
test('典型設定往返一致', () => {
  const value = {
    server: 'https://msn.feg.cn',
    topics: ['pub_demo', 'pub_x'],
    identity: 'shawoo',
    dashboardWidth: 260
  };
  const back = t.fromYaml(t.toYaml(value));
  assert.strictEqual(back.ok, true, back.error);
  assertSame(back.value, value);
});

test('容易误判的纯量不会变形（数字/布林/null/井号/冒号/引号）', () => {
  const value = {
    looksNumber: '123',
    looksBool: 'true',
    looksNull: 'null',
    hash: 'a # b',
    colon: 'a: b',
    quote: "it's",
    dash: '- x',
    empty: '',
    url: 'https://msn.feg.cn/pub_demo'
  };
  const back = t.fromYaml(t.toYaml(value));
  assert.strictEqual(back.ok, true, back.error);
  assertSame(back.value, value);
});

test('嵌套物件与物件阵列往返一致', () => {
  const value = { aliases: { 'pub_demo': '研發組' }, members: [{ name: 'a', n: 1 }, { name: 'b', n: 2 }] };
  const back = t.fromYaml(t.toYaml(value));
  assert.strictEqual(back.ok, true, back.error);
  assertSame(back.value, value);
});

test('空物件与空阵列往返一致', () => {
  for (const value of [{}, { a: [], b: {} }, []]) {
    const back = t.fromYaml(t.toYaml(value));
    assert.strictEqual(back.ok, true, back.error);
    assertSame(back.value, value);
  }
});

test('内建实作单独也能往返（不依赖 js-yaml）', () => {
  const value = { server: 'https://x', topics: ['a', 'b'], n: 3, yes: 'no' };
  const yaml = t.dumpYaml(value, 0);
  const back = t.parseYaml(yaml);
  assert.strictEqual(back.ok, true, back.error);
  assertSame(back.value, value);
});

test('注释、空行、--- 分隔线都能忽略', () => {
  const text = [
    '# 這是註解',
    '---',
    '',
    'server: https://msn.feg.cn',
    '',
    '# 中間的註解',
    'topics:',
    '  - pub_demo',
    '  - pub_x',
    ''
  ].join('\n');
  const back = t.fromYaml(text);
  assert.strictEqual(back.ok, true, back.error);
  assertSame(back.value, { server: 'https://msn.feg.cn', topics: ['pub_demo', 'pub_x'] });
});

test('看不懂的语法要报错，而不是静默丢一半', () => {
  const back = t.parseYaml('server: https://x\n???這行壞了\n');
  assert.strictEqual(back.ok, false, '壞語法必須回報失敗');
  assert.ok(back.error.indexOf('行') !== -1, '錯誤要指出行號：' + back.error);
});

// ------------------------------------------------------------------ 档案读写
console.log('');
console.log('== 档案读写');

test('档案不存在时回 missing，不当作错误', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    const r = s.readConfig();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.missing, true);
    assert.strictEqual(r.value, null);
  } finally { cleanup(dir); }
});

test('写入后能读回，且 value 完整', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    const value = { server: 'https://msn.feg.cn', topics: ['pub_demo'], dashboardWidth: 300 };
    const w = s.writeConfig(value);
    assert.strictEqual(w.ok, true, w.error);
    const r = s.readConfig();
    assert.strictEqual(r.ok, true, r.error);
    assertSame(r.value, value);
    assert.strictEqual(r.missing, false);
  } finally { cleanup(dir); }
});

test('坏掉的档案要报错，不能当成空设定（否则会洗掉使用者资料）', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    fs.writeFileSync(s.configPath, 'server: https://x\n???壞了\n', 'utf8');
    const r = s.readConfig();
    assert.strictEqual(r.ok, false, '壞档必須回報失敗');
    assert.ok(r.error, '要有原因');
  } finally { cleanup(dir); }
});

test('原子写入：目录里不留 .tmp 残档', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    s.writeConfig({ a: 1 });
    s.writeConfig({ a: 2 });
    s.writeConfig({ a: 3 });
    const leftovers = fs.readdirSync(dir).filter((f) => f.indexOf('.tmp') !== -1);
    assert.deepStrictEqual(leftovers, [], '不該留下暫存檔');
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['config.yml']);
  } finally { cleanup(dir); }
});

test('目录不存在会自动建立', () => {
  const base = tmpDir();
  try {
    const nested = path.join(base, 'deep', 'deeper');
    const s = store.createStore({ dir: nested });
    const w = s.writeConfig({ a: 1 });
    assert.strictEqual(w.ok, true, w.error);
    assert.ok(fs.existsSync(path.join(nested, 'config.yml')));
  } finally { cleanup(base); }
});

test('非物件内容被拒绝（避免写出不合法的档案）', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    for (const bad of [null, undefined, 'x', 42, ['a']]) {
      const w = s.writeConfig(bad);
      assert.strictEqual(w.ok, false, '应该拒绝：' + JSON.stringify(bad));
    }
    assert.strictEqual(fs.existsSync(s.configPath), false, '不该产生档案');
  } finally { cleanup(dir); }
});

// ------------------------------------------------------------------ 凭证分离
console.log('');
console.log('== 凭证分离与权限');

test('凭证与设定是两个独立档案', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    s.writeConfig({ server: 'https://msn.feg.cn' });
    s.writeSecrets({ 'https://msn.feg.cn': { mode: 'basic', user: 'u', password: 'p' } });
    assert.notStrictEqual(s.configPath, s.secretsPath);
    // 设定档里不可以出现密码
    const cfgText = fs.readFileSync(s.configPath, 'utf8');
    assert.strictEqual(cfgText.indexOf('password'), -1, '一般设定不该含凭证');
    assert.strictEqual(cfgText.indexOf('p\n'), -1, '一般设定不该含密码值');
    // 凭证档里确实有
    const secText = fs.readFileSync(s.secretsPath, 'utf8');
    assert.ok(secText.indexOf('password') !== -1);
  } finally { cleanup(dir); }
});

test('凭证档权限收紧了（POSIX）；Windows 上不因此失败', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    s.writeSecrets({ 'https://x': { mode: 'token', token: 'tk' } });
    if (process.platform === 'win32') {
      assert.ok(fs.existsSync(s.secretsPath), 'Windows 上至少要写成功');
    } else {
      const mode = fs.statSync(s.secretsPath).mode & 0o777;
      assert.strictEqual(mode, t.SECRETS_MODE, '权限应為 ' + t.SECRETS_MODE.toString(8) + '，實際 ' + mode.toString(8));
    }
  } finally { cleanup(dir); }
});

test('readAll 同时读两份并回报「档在不在」', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    let all = s.readAll();
    assert.strictEqual(all.ok, true);
    assert.strictEqual(all.configMissing, true);
    assert.strictEqual(all.secretsMissing, true);
    s.writeConfig({ server: 'https://x' });
    all = s.readAll();
    assert.strictEqual(all.configMissing, false);
    assert.strictEqual(all.secretsMissing, true);
    assert.deepStrictEqual(all.config, { server: 'https://x' });
  } finally { cleanup(dir); }
});

test('readAll 遇到坏档要回失败（不能只回一半就当成功）', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    fs.writeFileSync(s.secretsPath, '??? 壞了\n', 'utf8');
    const all = s.readAll();
    assert.strictEqual(all.ok, false, '壞档必須讓整次讀取失敗');
    assert.ok(all.error);
  } finally { cleanup(dir); }
});

// ------------------------------------------------------------------ 落档内容
console.log('');
console.log('== 落档内容可读性');

test('写出的 YAML 是人看得懂、能手改的形状', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    s.writeConfig({
      server: 'https://msn.feg.cn',
      topics: ['pub_demo', 'pub_team'],
      dashboardWidth: 260
    });
    const text = fs.readFileSync(s.configPath, 'utf8');
    assert.ok(text.indexOf('server: https://msn.feg.cn') !== -1, '伺服器应可直接阅读：\n' + text);
    assert.ok(text.indexOf('- pub_demo') !== -1, '主题清单应是 YAML 阵列：\n' + text);
    assert.ok(text.indexOf('dashboardWidth: 260') !== -1, '数字不该被加引号：\n' + text);
  } finally { cleanup(dir); }
});

test('手改过的档案仍能读回（真实使用情境）', () => {
  const dir = tmpDir();
  try {
    const s = store.createStore({ dir: dir });
    fs.writeFileSync(s.configPath, [
      '# 我手动加的注释',
      'server: https://msn.feg.cn',
      'topics:',
      '  - pub_demo',
      '  # 下面这个别名是我改的',
      'aliases:',
      "  pub_demo: '研发组'",
      ''
    ].join('\n'), 'utf8');
    const r = s.readConfig();
    assert.strictEqual(r.ok, true, r.error);
    assert.strictEqual(r.value.server, 'https://msn.feg.cn');
    assert.deepStrictEqual(r.value.topics, ['pub_demo']);
    assert.strictEqual(r.value.aliases.pub_demo, '研发组');
  } finally { cleanup(dir); }
});

console.log('');
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
console.log('结果：' + (failed === 0 ? 'PASS（全程无网络）' : 'FAILED'));
process.exit(failed === 0 ? 0 : 1);
