'use strict';
// Offline tests for cute-clock's mask key route.
// node test/usage-mask.js

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../lib/index.js');
const t = mod.__test;

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log('  ok   ' + name); }
  catch (err) { failed += 1; console.log('  FAIL ' + name + '\n       ' + (err && err.message ? err.message : String(err))); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cute-mask-'));

/** Fake Cordis context that runs the inject callback synchronously. */
function makeCtx() {
  const routes = [];
  const scope = {
    webServer: { register(row) { routes.push(row); } },
    logger: { error() {}, log() {} },
  };
  scope.get = (n) => scope[n];
  return { ctx: { inject(names, cb) { cb(scope); }, effect(fn) { fn(); return () => {}; } }, routes };
}

console.log('== mask key 公式（MASK.md 的 67 字元 apiKey 形）');
test('maskKey 67 字元，且 base64 解码可拿回 key@<ISO>', () => {
  const pinned = new Date('2026-01-01T00:00:00.000Z');
  const key = 'sk-ExampleKeyReplaceMe001';
  const m = t.maskKey(key, pinned);
  assert.strictEqual(m.length, 67, 'sk- 3 + base64 64 = 67');
  assert.strictEqual(m.slice(0, 3), 'sk-');
  const inner = Buffer.from(m.slice(3), 'base64').toString('utf8');
  assert.strictEqual(inner, 'ExampleKeyReplaceMe001@2026-01-01T00:00:00.000Z', 'inner 必須是 22 字元 key + @ + 24 字元 ISO');
});

test('maskKey 拒絕空字串 / 非字串', () => {
  assert.throws(() => t.maskKey(''), /non-empty/i);
  assert.throws(() => t.maskKey(null), /non-empty/i);
});

test('readCredentialRef 只讀 refs 區塊，且剝引號', () => {
  const text = 'version: 1\nrefs:\n  AIFE_API_KEY: sk-AbC\n  OTHER: sk-Def\nother:\n  AIFE_API_KEY: nope\n';
  assert.strictEqual(t.readCredentialRef(text, 'AIFE_API_KEY'), 'sk-AbC');
  assert.strictEqual(t.readCredentialRef(text, 'OTHER'), 'sk-Def');
  assert.strictEqual(t.readCredentialRef(text, 'NOPE'), null);
  assert.strictEqual(t.readCredentialRef('refs:\n  K: "sk-q"\n', 'K'), 'sk-q');
  assert.strictEqual(t.readCredentialRef(null, 'K'), null);
});

test('★ maskedCredential 候選順序：AIFE 優先（實測 FEG 那把會 200 {}）', () => {
  const saved = process.env.DSH_CREDENTIALS_PATH;
  const f = path.join(tmp, 'creds.yaml');
  fs.writeFileSync(f, 'version: 1\nrefs:\n  FEG_API_KEY: sk-feg\n  AIFE_API_KEY: sk-aife\n', 'utf8');
  process.env.DSH_CREDENTIALS_PATH = f;
  try {
    const r = t.maskedCredential({ now: new Date('2026-01-01T00:00:00.000Z') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ref, 'AIFE_API_KEY');
    assert.strictEqual(JSON.stringify(r).indexOf('sk-aife'), -1, '★ 原文不得出現在回傳値裡');
  } finally {
    if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
    else process.env.DSH_CREDENTIALS_PATH = saved;
    fs.rmSync(f, { force: true });
  }
});

test('路由：GET 200、POST 405、讀不到憑證 503', () => {
  const { ctx, routes } = makeCtx();
  mod.apply(ctx);
  const route = routes.find((r) => r.path === t.MASK_KEY_PATH);
  assert.ok(route, '應該註冊 ' + t.MASK_KEY_PATH);

  const saved = process.env.DSH_CREDENTIALS_PATH;
  const f = path.join(tmp, 'route.yaml');
  fs.writeFileSync(f, 'version: 1\nrefs:\n  AIFE_API_KEY: sk-route\n', 'utf8');
  process.env.DSH_CREDENTIALS_PATH = f;
  const call = (method) => {
    let status = 0; let body = null;
    route.handler({ method }, {
      set statusCode(v) { status = v; },
      get statusCode() { return status; },
      setHeader() {},
      end(s) { body = JSON.parse(s); },
    });
    return { status, body };
  };
  try {
    const ok = call('GET');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.ok, true);
    assert.strictEqual(ok.body.ref, 'AIFE_API_KEY');
    // For sk-route (8 chars) the apiKey is 43 chars; for the real AIFE key (25
    // chars) it would be 67. Just check the format: starts with sk-, base64
    // decodes to inner ending in @<ISO> with the stripped key as the head.
    assert.strictEqual(ok.body.maskKey.slice(0, 3), 'sk-');
    const inner = Buffer.from(ok.body.maskKey.slice(3), 'base64').toString('utf8');
    assert.ok(inner.startsWith('route@'), 'inner 應以剝過 sk- 的 key 開頭');
    assert.ok(/@\d{4}-\d{2}-\d{2}T/.test(inner), 'inner 應以 @<ISO> 結尾');
    assert.strictEqual(JSON.stringify(ok.body).indexOf('sk-route'), -1, '★ 回應不得含原文');

    assert.strictEqual(call('POST').body.ok, false, 'POST 應該被拒');
    assert.ok(String(call('POST').body.error).indexOf('GET') !== -1);

    process.env.DSH_CREDENTIALS_PATH = path.join(tmp, 'missing.yaml');
    assert.strictEqual(call('GET').status, 503);
  } finally {
    if (saved === undefined) delete process.env.DSH_CREDENTIALS_PATH;
    else process.env.DSH_CREDENTIALS_PATH = saved;
    fs.rmSync(f, {force: true});
  }
});

test('apply 沒有 ctx.inject 時不抛', () => {
  const ctx = { logger: { error() {}, log() {} } };
  assert.doesNotThrow(() => mod.apply(ctx));
});

console.log('');
console.log('== ★ 路由註冊的坑（這個 bug 讓整條路由靜默消失過）');
const HOST_SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');
test('不得再用 apply 當下的 ctx.get 取 webServer', () => {
  assert.strictEqual(/ctx\.get\(\s*["']webServer["']\s*\)/.test(HOST_SRC), false);
  assert.ok(/ctx\.inject\(\s*\[\s*["']webServer["']\s*\]/.test(HOST_SRC));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log('');
console.log('通過 ' + passed + ' 項，失敗 ' + failed + ' 項');
console.log('結果：' + (failed === 0 ? 'PASS（全程無網路）' : 'FAILED'));
process.exit(failed === 0 ? 0 : 1);
