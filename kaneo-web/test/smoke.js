'use strict';

// =============================================================================
// kaneo-web 离线冒烟测试
//
//     node test/smoke.js
//
// 这个档不连网、不需要宿主：它验的是「最容易默默坏掉」的那几件事：
//
//   1. 宿主半边的两个档案都载得进来，导出形状对；
//   2. Config schema 真的建起来了（arch 上是靠解析 schemastery 得到的，
//      解析失败会让 settings 拒绝写入 —— 那是静默失效，所以要有断言）；
//   3. 网址组成与 redirect 收束：金钥一定会编码，redirect 一定不能是外站；
//   4. 浏览器半边是合法的 CJS factory，而且**不含网域与签入路径**
//      —— 这是使用者要求的核心，用字串断言把它钉住。
// =============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
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

console.log('kaneo-web host half');

check('exports name / apply / inject', function () {
  assert.equal(host.name, 'kaneo-web');
  assert.equal(typeof host.apply, 'function');
  assert.deepEqual(host.inject, []);
});

check('Config schema was built (schemastery resolved)', function () {
  assert.notEqual(host.Config, undefined, 'Config 未建立 —— API Key 会存不起来');
  const json = JSON.stringify(host.Config.toJSON());
  assert.ok(json.includes('"volatile":true'), '两个栏位都必须是 volatile');
  assert.ok(json.includes('"role":"secret"'), 'apiKey 必须是 secret role（远端读取要 redact）');
});

check('unconfigured state carries no url', function () {
  const result = host.__test.resolveSignIn({ apiKey: '', redirect: '/dashboard' });
  assert.equal(result.ok, false);
  assert.equal(result.apiKeySet, false);
  assert.equal(result.url, undefined);
  assert.equal(result.redirect, '/dashboard');
});

check('configured state composes the sign-in url', function () {
  const result = host.__test.resolveSignIn({ apiKey: 'abc', redirect: '/dashboard' });
  assert.equal(result.ok, true);
  assert.equal(result.url, host.__test.DEFAULT_SERVER_URL + host.__test.SIGN_IN_PATH
    + '?key=abc&redirect=/dashboard');
});

check('api key is query-encoded, / is left literal everywhere', function () {
  // 金钥里出现 `&` 或 `#` 会把查询字串截断 —— 那是会静默传到错的金钥。
  const result = host.__test.resolveSignIn({ apiKey: 'a b&c#d/e', redirect: '/x/y' });
  assert.ok(result.url.includes('key=a%20b%26c%23d/e'), 'key 必须编码：' + result.url);
  assert.ok(result.url.includes('redirect=/x/y'), 'redirect 的斜线不该被编码');
});

check('encodeQueryValue keeps / literal', function () {
  assert.equal(host.__test.encodeQueryValue('a/b'), 'a/b');
  assert.equal(host.__test.encodeQueryValue('/dashboard'), '/dashboard');
  assert.equal(host.__test.encodeQueryValue('a=b'), 'a%3Db');
});

check('redirect falls back to /dashboard when absent', function () {
  assert.equal(host.__test.resolveSignIn({ apiKey: 'k' }).redirect, '/dashboard');
  assert.equal(host.__test.resolveSignIn({ apiKey: 'k', redirect: '' }).redirect, '/dashboard');
});

check('redirect refuses off-site values', function () {
  const reject = ['//evil.example/x', 'https://evil.example', 'http://x/y', 'javascript:alert(1)',
    '/a:b', '/a\\b', '/a b', 'dashboard', ''];
  for (const value of reject) {
    assert.equal(host.__test.sanitizeRedirect(value), null, 'should reject: ' + JSON.stringify(value));
  }
});

check('redirect accepts site-relative paths', function () {
  for (const value of ['/dashboard', '/p/demo/tasks', '/settings?tab=a']) {
    assert.equal(host.__test.sanitizeRedirect(value), value);
  }
});

check('volatile refs are unwrapped before use', function () {
  // 回归测试：`.volatile()` 栏位在宿主端是 ref（有 get()），不是字串。
  // 没有拆开就会组出 `key=%5Bobject%20Object%5D` —— 金钥静默失效。
  const ref = { get: function () { return 'REAL-KEY'; } };
  assert.equal(host.__test.trimmed(ref), 'REAL-KEY');
  assert.equal(host.__test.trimmed({ get: function () { return { get: function () { return 'NESTED'; } }; } }), 'NESTED');
  assert.equal(host.__test.trimmed(undefined), '');
  assert.equal(host.__test.trimmed('  spaced  '), 'spaced');
  const result = host.__test.resolveSignIn({ apiKey: ref, redirect: { get: function () { return '/dashboard'; } } });
  assert.ok(result.url.includes('key=REAL-KEY'), result.url);
  assert.ok(!result.url.includes('object'), '网址里不该出现 [object Object]');
});

check('parseBody rejects non-objects and garbage', function () {
  assert.deepEqual(host.__test.parseBody(''), {});
  assert.deepEqual(host.__test.parseBody('{"apiKey":"k"}'), { apiKey: 'k' });
  assert.equal(host.__test.parseBody('[1,2]'), null);
  assert.equal(host.__test.parseBody('"str"'), null);
  assert.equal(host.__test.parseBody('{oops'), null);
  assert.equal(host.__test.parseBody('null'), null);
});

check('patch row starts with an empty api key', function () {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8');
  assert.ok(/apiKey:\s*''/.test(patch), 'patch 里的 apiKey 必须是空字串');
  assert.ok(/redirect:\s*\/dashboard/.test(patch), 'patch 里的 redirect 预设 /dashboard');
});

console.log('kaneo-web client half');

const clientSource = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

check('client.js loads through window.__ModuleLoader__', function () {
  let registration = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(value) { registration = value; }
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' });
  assert.notEqual(registration, null, '没有呼叫 __ModuleLoader__.load');
  assert.equal(registration.id, 'kaneo-web');
  assert.equal(typeof registration.factory, 'function');

  const plugin = registration.factory(function (spec) {
    if (spec === 'react') {
      return {
        createElement: function () { return null; },
        useCallback: function (fn) { return fn; },
        useEffect: function () {},
        useRef: function () { return { current: null }; },
        useState: function (initial) { return [initial, function () {}]; }
      };
    }
    throw new Error('unexpected require: ' + spec);
  });
  assert.equal(typeof plugin.apply, 'function');
  assert.equal(plugin.inject.join(','), 'slots,locale');
  assert.equal(plugin.__internals.PANEL_ID, 'kaneo-web');
});

/**
 * 去掉 // 注解与区块注解，只留真正的程序码。
 *
 * 测试要看的是「代码有没有用浏览器储存」，而注解里说明「刻意不用」
 * 不应该算违规 —— 所以先剥注解再断言。
 *
 * @param source - 原始檔内容。
 * @returns 去掉注解后的内容。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(function (line) { return !/^\s*\/\//.test(line); })
    .join('\n');
}

const clientCode = stripComments(clientSource);

check('client bundle never names the server or the sign-in path', function () {
  const forbidden = ['pl.feg.cn', 'api/auth', 'api-key', 'sign-in', 'https://', 'feg.cn',
    'abc.feg.com.tw', 'storage/kaneo', 'BDD/API'];
  for (const needle of forbidden) {
    assert.equal(clientSource.includes(needle), false,
      'client.js 不该出现 ' + needle + '（网域与签入路径只能留在宿主半边）');
  }
});

check('browser storage only keeps non-secret UI preferences', function () {
  // 這條刻意收窄但不放鬆：localStorage 只准記「非機密的使用者偏好」——
  // 目前是「上次停在哪一頁」與「用哪種方式開工作區」這兩個鍵。
  // 其他儲存一律不准用；而且寫進去的鍵名必須看得出來不是金鑰。
  const forbidden = ['sessionStorage', 'document.cookie', 'indexedDB'];
  for (const needle of forbidden) {
    assert.equal(clientCode.includes(needle), false, 'client.js 不该使用 ' + needle);
  }
  // 白名單：只有這兩個鍵可以進瀏覽器儲存。
  const allowedKeys = ['kaneo-web.lastPath', 'kaneo-web.mode'];
  for (const key of allowedKeys) {
    assert.ok(clientCode.includes(key), '應該有這個儲存鍵：' + key);
  }
  const setItemLines = clientCode.split('\n').filter((line) => line.includes('localStorage.setItem'));
  assert.equal(setItemLines.length, allowedKeys.length,
    'localStorage.setItem 的數量要跟白名單一致：' + setItemLines.join(' | '));
  for (const line of setItemLines) {
    assert.ok(/LAST_PATH_KEY|MODE_KEY/.test(line), '只能用白名單的鍵：' + line.trim());
    assert.equal(/apiKey/i.test(line), false, '不得把金鑰寫進瀏覽器儲存');
  }
  // 最關鍵的安全斷言：整份 bundle 不得把 apiKey 交給任何儲存 API。
  assert.equal(/localStorage\.setItem\([^)]*apiKey/i.test(clientCode), false,
    '金鑰永遠不得進瀏覽器儲存');
});

check('the remembered path is guarded against open redirects', function () {
  // 存在瀏覽器裡的東西可能被手改（或外掛亂寫），所以讀回來一定要驗形狀。
  const guarded = clientCode.includes('function safeSitePath(');
  assert.ok(guarded, 'client.js 應該有 safeSitePath 把關');
  assert.ok(clientCode.includes("text.charAt(1) === '/'"), '要擋掉 //host 這種寫法');
  assert.ok(clientCode.includes("indexOf('://')"), '要擋掉帶協定的絕對網址');
});

check('client styles only use theme tokens', function () {
  const hex = clientSource.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hex, [], 'client.js 的 CSS 出现写死颜色：' + hex.join(', '));
});

check('the sidebar entry is labelled 管線看板 and carries the registrations', function () {
  // 菜单名称是使用者改过的：zh 必须显示「管線看板」（繁體）。
  let registration = null;
  const options = [];
  const dicts = [];
  const sandbox = { window: { __ModuleLoader__: { load(value) { registration = value; } } } };
  vm.createContext(sandbox);
  vm.runInContext(clientSource, sandbox, { filename: 'client.js' });
  const plugin = registration.factory(function (spec) {
    if (spec !== 'react') throw new Error('unexpected require: ' + spec);
    return {
      createElement: function () { return null; },
      useCallback: function (fn) { return fn; },
      useEffect: function () {},
      useRef: function () { return { current: null }; },
      useState: function (initial) { return [initial, function () {}]; }
    };
  });
  const ctx = {
    effect(fn) { return fn(); },
    locale: {
      register(ns, localeOrDicts, dict) {
        if (typeof localeOrDicts === 'string') dicts.push({ ns: ns, locale: localeOrDicts, dict: dict });
        else dicts.push({ ns: ns, locale: Object.keys(localeOrDicts).join(','), dict: localeOrDicts });
        return function () {};
      },
      bind() { return function (key) { return plugin.__internals.zh[key]; }; }
    },
    slots: {
      inject(key, callback) { callback(); },
      register(value) { options.push(value); return function () {}; }
    }
  };
  plugin.apply(ctx);
  const entry = options.filter((value) => value.name === 'sidebar.panellist')[0];
  assert.ok(entry, '没有注册 sidebar.panellist');
  assert.equal(entry.id, 'kaneo-web');
  assert.equal(typeof entry.label, 'function', 'label 应该是 thunk（跟着语言即时更新）');
  assert.equal(entry.label(), '管線看板');
  const main = options.filter((value) => value.name === 'main')[0];
  assert.ok(main, '没有注册 main');
  assert.equal(main.key, entry.id, 'main 的 key 必须等于 sidebar.panellist 的 id');

  // 繁體字典要同時掛在 `zh`（harness 一定有的鍵）與 `zh-TW`（語言包發布的 id）上，
  // 這樣不管使用者選哪一個語系都拿到繁體，不必依賴簡→繁轉換。
  const locales = dicts.filter((d) => d.ns === 'kaneo-web').map((d) => d.locale);
  assert.ok(locales.includes('zh'), 'zh 沒註冊：' + locales.join(','));
  assert.ok(locales.includes('zh-TW'), 'zh-TW 沒註冊：' + locales.join(','));
  const zhDict = dicts.filter((d) => d.locale === 'zh')[0].dict;
  assert.equal(zhDict['panel.title'], '管線看板');
});

check('no product brand in the ui dictionaries or the frame title', function () {
  // 使用者要求：介面上不出現「Kaneo」。字典與 iframe 標題都算介面。
  const internals = (function () {
    let registration = null;
    const sandbox = { window: { __ModuleLoader__: { load(value) { registration = value; } } } };
    vm.createContext(sandbox);
    vm.runInContext(clientSource, sandbox, { filename: 'client.js' });
    return registration.factory(function () { return {}; }).__internals;
  })();
  const brand = /kaneo/i;
  for (const key of Object.keys(internals.zh)) {
    assert.equal(brand.test(internals.zh[key]), false, 'zh.' + key + ' 出現產品名：' + internals.zh[key]);
  }
  for (const key of Object.keys(internals.en)) {
    assert.equal(brand.test(internals.en[key]), false, 'en.' + key + ' 出現產品名：' + internals.en[key]);
  }
  assert.equal(brand.test(internals.FRAME_TITLE), false, 'iframe 標題出現產品名：' + internals.FRAME_TITLE);
});

check('every zh string is Traditional Chinese, not Simplified', function () {
  // 明顯的簡體字元；出現任何一個都代表這份字典還停在簡體。
  const simplified = /[设钥载远复页关讯输从边过后里见说员权个点为图确书术记]/;
  const internals = (function () {
    let registration = null;
    const sandbox = { window: { __ModuleLoader__: { load(value) { registration = value; } } } };
    vm.createContext(sandbox);
    vm.runInContext(clientSource, sandbox, { filename: 'client.js' });
    return registration.factory(function () { return {}; }).__internals;
  })();
  const offenders = Object.keys(internals.zh).filter((key) => simplified.test(internals.zh[key]));
  assert.deepEqual(offenders, [], '這些鍵還是簡體：' + offenders.join(','));
});

console.log('');
console.log(process.exitCode === 1
  ? 'failed'
  : 'all ' + passed + ' checks passed');
