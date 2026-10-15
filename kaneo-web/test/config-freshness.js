'use strict';

// =============================================================================
// kaneo-web 设定解析的回归测试
//
//     node test/config-freshness.js
//
// 这个档案钉住的是线上实测踩到、而且**静默**的那个 bug：
//
//   金钥存进去之后（settings.update → Loader 把新 config 解析进 fiber），
//   外挂实例闭包里的那份 config 还是旧的。若读设定时优先看闭包，就会得到
//   「存进去了，但读回是空的」—— 使用者看到的是「按了储存没反应」。
//
//   正确做法是优先读 `ctx.fiber.config`（永远指向这个实例目前的 Config），
//   闭包只当后备。加了这个测试之后，把优先序改回去会立刻红。
// =============================================================================

const assert = require('node:assert/strict');
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
 * 挂起外挂并回报它注册的路由。
 *
 * @param stale - `apply` 当时拿到的（旧的）config；模拟闭包里的那一份。
 * @param fresh - fiber 上目前的 config；模拟 Loader 解析后的那一份。
 * @returns `{ route, writes }`。
 */
function mount(stale, fresh) {
  const writes = [];
  const routes = [];
  const webServer = {
    register(value) {
      routes.push(value);
      return function () { routes.length = 0; };
    }
  };
  const settings = {
    async update(ns, patch) {
      writes.push({ op: 'update', ns: ns, patch: patch });
      // 真的写入之后，Loader 会让 fiber 上的 config 变成新的。
      fresh = { apiKey: { get: () => patch.apiKey }, redirect: { get: () => fresh.redirect.get() } };
    },
    async mutate(ns, ops) {
      writes.push({ op: 'mutate', ns: ns, ops: ops });
      for (const op of ops) if (op.path.join('.') === 'apiKey') fresh = { apiKey: { get: () => '' }, redirect: fresh.redirect };
    }
  };
  const ctx = {
    logger: { warn() {}, debug() {} },
    get fiber() { return { config: fresh }; },
    // ctx.effect(fn, label) 会**立刻**跑 fn 并拿它的回传值当 disposer —— 这里
    // 必须照做，否则路由根本不会注册（测试会以「route is undefined」失败，
    // 而不是以它真正想验的那件事失败）。
    effect(fn) { const disposer = fn(); return disposer; },
    inject(names, callback) { callback({ webServer: webServer, settings: settings, get: (n) => (n === 'settings' ? settings : webServer) }); },
    get(name) { return name === 'settings' ? settings : undefined; }
  };
  host.apply(ctx, stale);
  return { route: routes[0], writes: writes };
}

/**
 * 打一次路由并收下回应。
 *
 * @param route - 注册进来的路由物件。
 * @param method - HTTP 方法。
 * @param body - 请求体。
 * @returns Promise<{ status, json }>。
 */
function call(route, method, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const req = {
    method: method,
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
      setHeader() {},
      end(payload) { resolve({ status: this.statusCode, json: JSON.parse(payload) }); }
    };
    route.handler(req, res);
  });
}

(async function main() {
  console.log('kaneo-web config freshness');

  // 情境：外挂是在 apiKey 还是空的时候挂起来的（闭包 = 空），
  // 但 fiber 上已经是使用者刚存进去的值。
  const fresh = { apiKey: { get: () => 'FRESH-KEY' }, redirect: { get: () => '/dashboard' } };
  const harness = mount({ apiKey: '', redirect: '/dashboard' }, fresh);

  const status = await call(harness.route, 'GET');
  check('a stored key is read from the fiber, not the stale closure', function () {
    assert.equal(status.status, 200);
    assert.equal(status.json.configured, true, '存过的金钥不该被读成未设定');
    assert.ok(status.json.url.includes('key=FRESH-KEY'), String(status.json.url));
  });

  check('no [object Object] can leak into the url', function () {
    assert.equal(String(status.json.url).includes('object'), false, status.json.url);
  });

  // 反向：fiber 还没有值时，闭包也不该凭空生出金钥。
  const empty = mount({ apiKey: 'OLD-CLOSURE-KEY', redirect: '/dashboard' },
    { apiKey: { get: () => '' }, redirect: { get: () => '/dashboard' } });
  const emptyStatus = await call(empty.route, 'GET');
  check('an empty fiber config reads as unconfigured', function () {
    assert.equal(emptyStatus.json.configured, false);
    assert.equal(emptyStatus.json.url, null);
  });

  console.log('');
  console.log(process.exitCode === 1 ? 'failed' : 'all ' + passed + ' checks passed');
})().catch(function (err) {
  console.error(err);
  process.exitCode = 1;
});
