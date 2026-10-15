'use strict';

// =============================================================================
// kaneo-web 宿主路由的离线整合测试
//
//     node test/host-route.js
//
// 这一份比 smoke.js 更靠近真相：它**真的把外挂挂起来**，喂一个假的 ctx
// （一个 webServer 服务、一个 settings 服务），然后直接对注册进来的路由
// 送假的 HTTP 请求 —— GET / POST / DELETE 三条路都走一遍。
//
// 为什么要有这一份：线上验证需要重启宿主行程才会载到新代码，而这两件事
// （金钥有没有真的存进去、金钥有没有被拆成普通字串）正是最容易静默失效
// 的地方。实测踩过的那个 bug —— `.volatile()` 栏位是 Cordis 的 ref，
// 直接串进字串会变成 `[object Object]` —— 就是这一份要钉住的。
// =============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const host = require('../lib/index.js');

let passed = 0;
/** 跑一个测试并印出结果。 */
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok   ' + name);
  } catch (err) {
    console.error('  FAIL ' + name);
    console.error('       ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }
}

/**
 * 造一个假 ctx：只要外挂真的用得到的那些成员。
 *
 * `settings` 会真的把值记下来并回报已写入的 patch —— 这样「POST 之后
 * GET 读得到」这件事是被验证过的，不是假设。
 *
 * @param options - `{ settings: boolean }`，要不要挂 settings 服务。
 * @returns `{ ctx, routes, writes, patches }`。
 */
function makeHarness(options) {
  const opts = options || {};
  const routes = new Map();
  const patches = [];
  const writes = [];
  let live = { apiKey: '', redirect: '/dashboard' };

  const webServer = {
    register(route) {
      if (routes.has(route.path)) throw new Error('duplicate route ' + route.path);
      routes.set(route.path, route);
      return function () { routes.delete(route.path); };
    }
  };

  const settings = {
    async update(ns, patch, expectedRevision) {
      assert.equal(ns, 'kaneo-web');
      assert.equal(expectedRevision, undefined);
      writes.push({ ns: ns, patch: patch, op: 'update' });
      live = Object.assign({}, live, patch);
      patches.push(Object.assign({}, live));
    },
    async mutate(ns, ops, expectedRevision) {
      assert.equal(ns, 'kaneo-web');
      writes.push({ ns: ns, ops: ops, op: 'mutate' });
      // 模拟 dsh-settings 的 `unset` 语义：**移除这个栏位**，于是 Config 回到
      // schema 预设（redirect → /dashboard；apiKey 没有预设 → 未设定）。
      // 如果这里只是「设成空字串」，就会漏掉「回到预设」这一半。
      for (const op of ops) {
        if (op.op !== 'unset') continue;
        const path = op.path.join('.');
        if (path === 'apiKey') live = { apiKey: '', redirect: live.redirect };
        if (path === 'redirect') live = { apiKey: live.apiKey, redirect: '/dashboard' };
      }
    }
  };

  const services = { webServer: webServer };
  if (opts.settings !== false) services.settings = settings;

  const cleanups = [];
  const ctx = {
    logger: { warn() {}, debug() {} },
    // 用 volatile ref 包起来 —— 宿主真正给的就是这个形状。
    // mode 也要从 live 读（而不是初始 config），这样 PATCH 之后能即时反映。
    fiber: { config: {
      apiKey: { get: () => live.apiKey },
      redirect: { get: () => live.redirect },
      mode: { get: () => live.mode }
    } },
    effect(fn) { cleanups.push(fn()); },
    inject(names, callback) {
      for (const name of names) assert.ok(services[name], 'expected service ' + name);
      callback({
        webServer: services.webServer,
        settings: services.settings,
        get(name) { return services[name]; }
      });
    },
    get(name) { return services[name]; },
    /**
     * 把全域 fetch 换成假的：远端端点只在测试里被呼叫，不该真的连出去。
     *
     * @param impl - `(url, init) => Promise<{ status, ok, text() }>`。
     */
    __setFetch(impl) { globalThis.fetch = impl; }
  };

  return {
    ctx: ctx,
    routes: routes,
    patches: patches,
    writes: writes,
    live: function () { return live; },
    dispose: function () { for (const fn of cleanups) if (typeof fn === 'function') fn(); }
  };
}

/**
 * 打一次注册进来的路由，收下回应。
 *
 * @param harness - makeHarness 的结果。
 * @param method - HTTP 方法。
 * @param body - 请求体（物件会被序列化）。
 * @param routePath - 路由路径；预设设定路由。
 * @param query - 查询字串（含 `?`），用来测 `?redirect=` 覆写。
 * @returns Promise<{ status, json }>。
 */
function callRoute(harness, method, body, routePath, query) {
  const path = routePath === undefined ? '/plugins/kaneo-web/config' : routePath;
  const route = harness.routes.get(path);
  assert.ok(route, 'route not registered: ' + path);
  assert.equal(route.kind, 'exact');

  const chunks = [];
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method: method,
    url: path + (query === undefined ? '' : query),
    on(event, handler) {
      if (event === 'data' && text !== '') handler(Buffer.from(text, 'utf8'));
      if (event === 'end') handler();
      return req;
    },
    destroy() {}
  };

  return new Promise(function (resolve) {
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      end(payload) {
        resolve({
          status: this.statusCode,
          json: payload === undefined || payload === '' ? null : JSON.parse(payload)
        });
      }
    };
    route.handler(req, res);
  });
}

(async function main() {
  console.log('kaneo-web host route (offline)');

  const harness = makeHarness({ settings: true });
  host.apply(harness.ctx, { apiKey: '', redirect: '/dashboard' });

  check('registers one exact route per capability', function () {
    assert.equal(harness.routes.size, 4, '实得：' + [...harness.routes.keys()].join(', '));
    assert.ok(harness.routes.has('/plugins/kaneo-web/config'));
    assert.ok(harness.routes.has('/plugins/kaneo-web/mask-key'));
    assert.ok(harness.routes.has('/plugins/kaneo-web/restore'));
    assert.ok(harness.routes.has('/plugins/kaneo-web/reset'));
  });

  let status = await callRoute(harness, 'GET');
  check('GET before setup reports unconfigured, no url', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.configured, false);
    assert.equal(status.json.apiKeySet, false);
    assert.equal(status.json.url, null);
    assert.equal(status.json.redirect, '/dashboard');
  });

  // **每個回應都要帶 mode** —— GET 漏掉 mode 是「使用者切換過的開啟方式
  // 每次都被自動偵測蓋回預設值」這個 bug 的根因，所以這條單獨釘住。
  check('GET carries the mode field (not just DELETE/PATCH/reset)', function () {
    assert.ok(Object.prototype.hasOwnProperty.call(status.json, 'mode'),
      'GET 回應必須有 mode 欄位；實得 ' + JSON.stringify(status.json));
    assert.ok(status.json.mode === 'newtab' || status.json.mode === 'iframe',
      'mode 只能是 newtab 或 iframe，實得 ' + JSON.stringify(status.json.mode));
  });

  status = await callRoute(harness, 'POST', { apiKey: 'K-123', redirect: '/dashboard' });
  check('POST stores the key and returns a usable url', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.configured, true);
    assert.equal(status.json.url,
      'https://pl.feg.cn/api/auth/api-key/sign-in?key=K-123&redirect=/dashboard');
    assert.equal(status.json.url.includes('object'), false, '不得出现 [object Object]');
    assert.equal(harness.live().apiKey, 'K-123', '金钥必须真的被写进设定');
  });

  check('the write went through settings.update, not a side channel', function () {
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].op, 'update');
    assert.equal(harness.writes[0].patch.apiKey, 'K-123');
    assert.equal(harness.writes[0].patch.redirect, '/dashboard');
  });

  status = await callRoute(harness, 'GET');
  check('GET after setup returns the composed url', function () {
    assert.equal(status.json.configured, true);
    assert.ok(status.json.url.startsWith('https://pl.feg.cn/api/auth/api-key/sign-in?key=K-123'));
  });

  status = await callRoute(harness, 'POST', { apiKey: 'K-456', redirect: '/p/demo/tasks' });
  check('POST accepts a site-relative redirect', function () {
    assert.equal(status.status, 200);
    assert.ok(status.json.url.endsWith('&redirect=/p/demo/tasks'), status.json.url);
  });

  status = await callRoute(harness, 'POST', { apiKey: 'K-789', redirect: 'https://evil.example/steal' });
  check('POST refuses an off-site redirect instead of silently defaulting', function () {
    assert.equal(status.status, 400);
    assert.equal(status.json.ok, false);
    assert.ok(status.json.error.includes('/dashboard'), status.json.error);
    assert.equal(harness.live().apiKey, 'K-456', '被拒绝的请求不该动到已存的值');
  });

  status = await callRoute(harness, 'POST', { apiKey: '   ' });
  check('POST refuses an empty key', function () {
    assert.equal(status.status, 400);
    assert.equal(status.json.ok, false);
  });

  status = await callRoute(harness, 'POST', { apiKey: 'x'.repeat(600) });
  check('POST refuses an oversized key', function () {
    assert.equal(status.status, 400);
  });

  status = await callRoute(harness, 'PUT');
  check('an unsupported method is answered, not left hanging', function () {
    assert.equal(status.status, 405);
    assert.equal(status.json.ok, false);
  });

  status = await callRoute(harness, 'DELETE');
  check('DELETE clears the stored key and reports unconfigured', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.configured, false);
    assert.equal(status.json.url, null);
    assert.equal(harness.live().apiKey, '');
  });

  check('clearing used settings.mutate/unset, not an empty write', function () {
    const mutate = harness.writes.filter((w) => w.op === 'mutate').pop();
    assert.ok(mutate, '没有发出 mutate');
    assert.deepEqual(JSON.parse(JSON.stringify(mutate.ops)), [{ op: 'unset', path: ['apiKey'] }]);
  });

  status = await callRoute(harness, 'POST', { apiKey: 'K-AFTER-CLEAR' });
  check('POST after DELETE works again (redirect kept from before)', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.redirect, '/p/demo/tasks');
    assert.ok(status.json.url.includes('key=K-AFTER-CLEAR'));
  });

  // 重置：金鑰與路徑一起收回初始狀態（一次 mutate 帶兩個 unset）。
  status = await callRoute(harness, 'POST', undefined, '/plugins/kaneo-web/reset');
  check('POST reset clears both the key and the redirect', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.reset, true);
    assert.equal(status.json.configured, false);
    assert.equal(status.json.apiKeySet, false);
    assert.equal(status.json.url, null);
    assert.equal(status.json.redirect, '/dashboard', '路徑要回到 schema 預設');
    assert.equal(harness.live().apiKey, '', '金鑰要清掉');
  });

  check('reset used one mutate carrying two unset ops', function () {
    const mutate = harness.writes.filter((w) => w.op === 'mutate').pop();
    assert.ok(mutate, '沒有發出 mutate');
    const paths = JSON.parse(JSON.stringify(mutate.ops)).map((op) => op.path.join('.'));
    assert.deepEqual(paths.sort(), ['apiKey', 'redirect']);
    assert.equal(mutate.ops.every((op) => op.op === 'unset'), true);
  });

  status = await callRoute(harness, 'GET', undefined, '/plugins/kaneo-web/reset');
  check('the reset route refuses GET', function () {
    assert.equal(status.status, 405);
  });

  // PATCH 切換模式：只動 mode，不動 apiKey/redirect。
  // 測量面板實際的兩種切換：newtab → iframe、與驗證無效值會被拒絕。
  status = await callRoute(harness, 'PATCH', { mode: 'iframe' }, '/plugins/kaneo-web/config');
  check('PATCH mode=iframe succeeds and reports the new mode', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.mode, 'iframe', 'got: ' + JSON.stringify(status.json));
    // 寫進設定的方式是 update（不是 mutate）：patch 不是 unset。
    const last = harness.writes.filter((w) => w.op === 'update').pop();
    assert.ok(last, '應該用 settings.update 寫進');
    assert.deepEqual(Object.keys(last.patch), ['mode']);
    assert.equal(last.patch.mode, 'iframe');
  });

  status = await callRoute(harness, 'PATCH', { mode: 'newtab' }, '/plugins/kaneo-web/config');
  check('PATCH mode=newtab also succeeds', function () {
    assert.equal(status.json.mode, 'newtab');
  });

  status = await callRoute(harness, 'PATCH', { mode: 'bogus' }, '/plugins/kaneo-web/config');
  check('PATCH with an invalid mode is rejected', function () {
    assert.equal(status.status, 400);
    assert.equal(status.json.ok, false);
    assert.ok(/iframe|newtab/.test(status.json.error), status.json.error);
  });

  status = await callRoute(harness, 'PATCH', { redirect: '/p/x' }, '/plugins/kaneo-web/config');
  check('PATCH that only touches redirect is rejected (this route is mode-only)', function () {
    // PATCH 只接受 mode；redirect 走 POST 那條路徑。
    assert.equal(status.status, 400);
  });

  status = await callRoute(harness, 'PATCH', {}, '/plugins/kaneo-web/config');
  check('PATCH with no actionable field is also rejected', function () {
    assert.equal(status.status, 400);
  });

  // 端到端來回：PATCH 存 iframe 之後，**GET 必須讀回 iframe**。
  // 這是使用者症狀（「存了 iframe，重開又變回新分頁」）最直接的回歸測試 ——
  // 只要 GET 忘記帶 mode，這條就會紅。
  await callRoute(harness, 'PATCH', { mode: 'iframe' }, '/plugins/kaneo-web/config');
  const roundTrip = await callRoute(harness, 'GET');
  check('mode survives a PATCH -> GET round-trip', function () {
    assert.equal(roundTrip.status, 200);
    assert.equal(roundTrip.json.mode, 'iframe',
      'PATCH 存了 iframe，GET 就必須讀回 iframe；實得 ' + JSON.stringify(roundTrip.json));
  });

  // 反向也要成立（避免只是硬編某個值）。
  await callRoute(harness, 'PATCH', { mode: 'newtab' }, '/plugins/kaneo-web/config');
  const roundTripBack = await callRoute(harness, 'GET');
  check('mode round-trips back to newtab as well', function () {
    assert.equal(roundTripBack.json.mode, 'newtab');
  });

  status = await callRoute(harness, 'GET');
  check('after a reset the panel is back to the setup state', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.configured, false);
    assert.equal(status.json.redirect, '/dashboard');
    assert.equal(status.json.url, null);
  });

  const deg = makeHarness({ settings: false });
  host.apply(deg.ctx, { apiKey: 'K', redirect: '/dashboard' });
  status = await callRoute(deg, 'POST', { apiKey: 'K-NEW' });
  check('without a settings service the failure is explicit', function () {
    assert.equal(status.status, 500);
    assert.equal(status.json.ok, false);
    assert.ok(status.json.error.includes('dsh-settings'), status.json.error);
  });

  harness.dispose();
  check('disposal removes the route', function () {
    assert.equal(harness.routes.size, 0);
  });

  /* ------------------------------------------------- 遮蔽金钥与远端取回 */

  const credentialsText = [
    'version: 1',
    'refs:',
    '  AIFE_API_KEY: sk-aife-test-0001',
    ''
  ].join('\n');
  const credentialsFile = path.join(os.tmpdir(), 'kaneo-web-route-cred-' + process.pid + '.yaml');
  fs.writeFileSync(credentialsFile, credentialsText, 'utf8');
  process.env.DSH_CREDENTIALS_PATH = credentialsFile;

  const restoreHarness = makeHarness({ settings: true, fetch: null });
  host.apply(restoreHarness.ctx, { apiKey: '', redirect: '/dashboard' });

  check('the mask-key and restore routes are registered as well', function () {
    assert.equal(restoreHarness.routes.size, 4, '实得 ' + [...restoreHarness.routes.keys()].join(', '));
    assert.ok(restoreHarness.routes.has('/plugins/kaneo-web/mask-key'));
    assert.ok(restoreHarness.routes.has('/plugins/kaneo-web/restore'));
    assert.ok(restoreHarness.routes.has('/plugins/kaneo-web/reset'));
  });

  status = await callRoute(restoreHarness, 'GET', undefined, '/plugins/kaneo-web/mask-key');
  check('GET mask-key returns a masked key and never the raw one', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.equal(status.json.ref, 'AIFE_API_KEY');
    assert.ok(status.json.maskKey.startsWith('sk-'));
    assert.equal(JSON.stringify(status.json).includes('sk-aife-test-0001'), false,
      '遮蔽路由不得回传原文：' + JSON.stringify(status.json));
  });

  check('the masked key decodes back to raw + timestamp', function () {
    const decoded = Buffer.from(status.json.maskKey.slice(3), 'base64').toString('utf8');
    assert.ok(decoded.startsWith('sk-aife-test-0001@'), decoded);
    assert.ok(/@\d{4}-\d{2}-\d{2}T/.test(decoded), decoded);
  });

  const upstream = {
    calls: [],
    reply: { status: 200, body: { apiKey: 'KANEO-KEY-1', name: 'Jinbe' } }
  };

  restoreHarness.ctx.__setFetch(async function (url, init) {
    upstream.calls.push({ url: url, init: init, body: JSON.parse(init.body) });
    return {
      status: upstream.reply.status,
      ok: upstream.reply.status >= 200 && upstream.reply.status < 300,
      text: async function () { return JSON.stringify(upstream.reply.body); }
    };
  });

  status = await callRoute(restoreHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('POST restore posts the masked key upstream and reports candidates', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(status.json.candidates)),
      [{ path: 'apiKey', value: 'KANEO-KEY-1' }]);
    assert.equal(status.json.fields.name, 'Jinbe');
    assert.equal(upstream.calls.length, 1);
    assert.equal(upstream.calls[0].url, 'https://abc.feg.com.tw/BDD/API/AI/dsh/storage/kaneo');
    assert.ok(String(upstream.calls[0].body.apiKey).startsWith('sk-'), '上游拿到的必须是遮蔽值');
    assert.equal(JSON.stringify(upstream.calls[0]).includes('sk-aife-test-0001'), false,
      '上游请求里不得出现原文');
  });

  upstream.reply = { status: 200, body: {} };
  status = await callRoute(restoreHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('an empty 200 from upstream is reported with the raw body, not as success', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.ok, true);
    assert.deepEqual(JSON.parse(JSON.stringify(status.json.candidates)), []);
    assert.deepEqual(JSON.parse(JSON.stringify(status.json.raw)), {});
  });

  upstream.reply = { status: 500, body: '' };
  status = await callRoute(restoreHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('an upstream 500 names the expected request shape', function () {
    assert.equal(status.status, 502);
    assert.equal(status.json.ok, false);
    assert.equal(status.json.step, 'upstream');
    assert.ok(status.json.error.includes('{"apiKey"'), status.json.error);
  });

  status = await callRoute(restoreHarness, 'GET', undefined, '/plugins/kaneo-web/restore');
  check('restore only answers POST', function () {
    assert.equal(status.status, 405);
  });

  // 拿不到遮蔽金钥时：明确说「卡在哪一步」，而且不假装成功。
  const noCredFile = path.join(os.tmpdir(), 'kaneo-web-route-empty-' + process.pid + '.yaml');
  fs.writeFileSync(noCredFile, 'version: 1\nrefs:\n', 'utf8');
  process.env.DSH_CREDENTIALS_PATH = noCredFile;
  const brokenHarness = makeHarness({ settings: true, fetch: null });
  host.apply(brokenHarness.ctx, { apiKey: '', redirect: '/dashboard' });
  status = await callRoute(brokenHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('without a usable credential the failure names the step and the tried refs', function () {
    assert.equal(status.status, 503);
    assert.equal(status.json.ok, false);
    assert.equal(status.json.step, 'mask-key');
    assert.ok(Array.isArray(status.json.tried) && status.json.tried.length > 0);
  });
  // 换回有金钥的那一份，后面的 storageUrl 测试才有遮蔽金钥可用。
  process.env.DSH_CREDENTIALS_PATH = credentialsFile;

  // 关掉 enableRestore 时不该打远端。
  upstream.calls = [];
  const disabledHarness = makeHarness({ settings: true, fetch: null });
  host.apply(disabledHarness.ctx, { apiKey: '', redirect: '/dashboard', enableRestore: { get: () => false } });
  disabledHarness.ctx.__setFetch(async function () { throw new Error('should not be called'); });
  status = await callRoute(disabledHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('enableRestore=false refuses to call the remote endpoint', function () {
    assert.equal(status.status, 403);
    assert.equal(status.json.ok, false);
  });

  // storageUrl 可以在 Config 里换成别的环境，而且换回来的金钥会被预检。
  upstream.calls = [];
  const customHarness = makeHarness({ settings: true, fetch: null });
  host.apply(customHarness.ctx, {
    apiKey: '',
    redirect: '/dashboard',
    storageUrl: 'https://example.invalid/BDD/API/AI/dsh/storage/kaneo',
    enableRestore: true
  });
  customHarness.ctx.__setFetch(async function (url) {
    upstream.calls.push({ url: url });
    // 远端换回金钥之后，宿主还会对登录端点做一次预检 —— 桩要认得两种请求。
    if (String(url).includes('/api/auth/api-key/')) {
      return { status: 302, ok: false, text: async function () { return ''; } };
    }
    return {
      status: 200,
      ok: true,
      text: async function () { return JSON.stringify({ API_KEY: 'K-ENV' }); }
    };
  });
  status = await callRoute(customHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('storageUrl is configurable per environment', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.candidates[0].value, 'K-ENV');
    assert.equal(upstream.calls[0].url, 'https://example.invalid/BDD/API/AI/dsh/storage/kaneo');
  });

  check('the fetched key is pre-checked against the sign-in endpoint', function () {
    assert.equal(status.json.check.verdict, 'ok');
    assert.equal(status.json.check.status, 302);
    const probed = upstream.calls.filter((c) => String(c.url).includes('/api/auth/api-key/'));
    assert.equal(probed.length, 1, '应正好预检一次：' + JSON.stringify(upstream.calls));
    assert.ok(probed[0].url.includes('key=K-ENV'), probed[0].url);
    assert.equal(probed[0].url.includes('sk-'), false, '预检网址里不该出现遮蔽金钥');
  });

  // 远端金钥被 Kaneo 拒绝（实测就是这样）：预检必须把 verdict 标成 invalid。
  upstream.calls = [];
  customHarness.ctx.__setFetch(async function (url) {
    upstream.calls.push({ url: url });
    if (String(url).includes('/api/auth/api-key/')) {
      return {
        status: 401,
        ok: false,
        text: async function () { return JSON.stringify({ code: 'INVALID_API_KEY' }); }
      };
    }
    return {
      status: 200,
      ok: true,
      text: async function () { return JSON.stringify({ API_KEY: 'K-BAD' }); }
    };
  });
  status = await callRoute(customHarness, 'POST', undefined, '/plugins/kaneo-web/restore');
  check('a key Kaneo rejects is reported as invalid, not as success', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.check.verdict, 'invalid');
    assert.equal(status.json.check.status, 401);
  });

  fs.unlinkSync(credentialsFile);
  fs.unlinkSync(noCredFile);
  delete process.env.DSH_CREDENTIALS_PATH;

  console.log('');
  console.log(process.exitCode === 1 ? 'failed' : 'all ' + passed + ' checks passed');
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
