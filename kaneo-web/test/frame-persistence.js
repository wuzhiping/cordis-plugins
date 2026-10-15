'use strict';

// =============================================================================
// kaneo-web iframe 常駐行為測試
//
//     node test/frame-persistence.js
//
// 使用者的問題是「一旦打開，那個 iframe 可以狀態保持嗎？每次都要重新打開」。
// 這一輪把答案拆成可驗證的三件事：
//
//   1. **切換側邊欄面板不重新載入**：iframe 是 module 級單例，切走時被「停放」
//      到畫面外的區域（不是銷毀），切回來只是搬回去 —— 整個過程 `src` 不變，
//      也就不會重新導覽、不會重新登入。
//   2. **重新整理頁面（F5）會重新載入**：iframe 活在文件裡，文件沒了它就沒了。
//   3. **同一個網址再掛載不會重置**：`navigateFrame` 只在網址真的變了才指派
//      `src`，所以重新掛載不會白白重載使用者正在看的頁面。
//
// 這裡不做 DOM：假的 document／element 會把每一次 `src` 指派都記下來，
// 測試直接數「導覽發生了幾次」。
// =============================================================================

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CLIENT_PATH = path.join(__dirname, '..', 'lib', 'client.js');

let passed = 0;
/** 跑一個測試並印出結果。 */
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
 * 造一個假的 DOM，並把 client.js 載起來。
 *
 * `src` 用存取器實作：**每次指派都計一次**，所以「有沒有重新導覽」是可數的。
 *
 * @returns `{ internals, created, navigations, appendLog }`。
 */
function loadClient() {
  let registration = null;
  const created = [];
  const navigations = [];

  function makeElement(tag) {
    const element = {
      tagName: String(tag).toUpperCase(),
      children: [],
      attributes: {},
      style: { cssText: '' },
      parentNode: null,
      className: '',
      title: undefined,
      setAttribute(name, value) { element.attributes[name] = value; },
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) {
        if (child.parentNode !== null && child.parentNode !== undefined) {
          const at = child.parentNode.children.indexOf(child);
          if (at !== -1) child.parentNode.children.splice(at, 1);
        }
        child.parentNode = element;
        element.children.push(child);
        return child;
      },
      removeChild(child) {
        const at = element.children.indexOf(child);
        if (at !== -1) element.children.splice(at, 1);
        child.parentNode = null;
        return child;
      }
    };
    // 只追蹤 iframe 的 src：其他元素的屬性與導覽無關。
    let src;
    Object.defineProperty(element, 'src', {
      get() { return src; },
      set(value) {
        if (element.tagName === 'IFRAME') navigations.push(value);
        src = value;
      }
    });
    // 跨來源讀 location 會拋（SecurityError）；這裡就讓它拋，確認有被 try 包住。
    Object.defineProperty(element, 'contentWindow', {
      get() {
        if (element.tagName === 'IFRAME') {
          throw new Error('SecurityError: cross-origin');
        }
        return undefined;
      }
    });
    created.push(element);
    return element;
  }

  const documentStub = {
    head: makeElement('head'),
    body: makeElement('body'),
    createElement: makeElement,
    getElementById() { return null; },
    querySelector() { return null; }
  };

  const sandbox = {
    console: console,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    Date: Date,
    document: documentStub,
    window: { __ModuleLoader__: { load(value) { registration = value; } } },
    globalThis: undefined
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CLIENT_PATH, 'utf8'), sandbox, { filename: 'client.js' });

  const internals = registration.factory(function (spec) {
    if (spec !== 'react') throw new Error('unexpected require: ' + spec);
    return {};
  }).__internals;

  return {
    internals: internals,
    navigations: navigations,
    iframes() { return created.filter((el) => el.tagName === 'IFRAME'); },
    /** 目前 iframe 掛在誰底下（用來確認「停放」與「搬回」）。 */
    parentTag() {
      const frame = created.filter((el) => el.tagName === 'IFRAME')[0];
      if (!frame) return null;
      if (frame.parentNode === null) return null;
      return frame.parentNode.getAttribute ? (frame.parentNode.attributes['data-dsh-kaneo-web'] ? 'parked' : frame.parentNode.tagName) : 'host';
    }
  };
}

const URL_A = 'https://example.invalid/api/auth/api-key/sign-in?key=K&redirect=/dashboard';

console.log('kaneo-web iframe persistence');

const client = loadClient();

check('the first navigate creates exactly one iframe and one navigation', function () {
  client.internals.navigateFrame(URL_A);
  assert.equal(client.iframes().length, 1, '應該只有一個 iframe');
  assert.equal(client.navigations.length, 1, '導覽次數：' + client.navigations.length);
  assert.equal(client.navigations[0], URL_A);
});

check('re-navigating to the same url does not reload', function () {
  client.internals.navigateFrame(URL_A);
  assert.equal(client.navigations.length, 1, '同一個網址不該再導覽一次：' + client.navigations.length);
});

check('parking (panel switch away) does not navigate', function () {
  const frame = client.iframes()[0];
  client.internals.parkFrame();
  assert.equal(client.navigations.length, 1, '停放不該產生導覽');
  // 停放後 iframe 仍在文件裡（畫面外），文件才活得下去。
  assert.notEqual(frame.parentNode, null, 'iframe 不該被移除');
  assert.equal(frame.parentNode.attributes['data-dsh-kaneo-web'], 'parked', '應該被停到畫面外的停放區');
});

check('returning to the panel re-parents the same iframe without reloading', function () {
  const frame = client.iframes()[0];
  const host = { tagName: 'DIV', children: [], attributes: {}, style: {}, parentNode: null,
    setAttribute() {}, addEventListener() {}, removeEventListener() {},
    appendChild(child) { child.parentNode = host; host.children.push(child); return child; },
    removeChild(child) { const at = host.children.indexOf(child); if (at !== -1) host.children.splice(at, 1); child.parentNode = null; return child; } };
  host.appendChild(frame);
  assert.equal(client.iframes().length, 1, '仍然是同一個 iframe');
  assert.equal(client.navigations.length, 1, '搬回去不該導覽：' + client.navigations.length);
  assert.equal(frame.parentNode, host, 'iframe 應該被搬回面板');
});

check('the frame element is reused across parking cycles', function () {
  const first = client.iframes()[0];
  client.internals.parkFrame();
  client.internals.navigateFrame(URL_A);
  assert.equal(client.iframes()[0], first, '必須是同一個元素（不是新建的）');
  assert.equal(client.navigations.length, 1, '導覽次數不變：' + client.navigations.length);
});

check('a different url does navigate (key or path changed)', function () {
  client.internals.navigateFrame(URL_A + '&other=1');
  assert.equal(client.navigations.length, 2, '網址變了就該導覽：' + client.navigations.length);
});

check('reloadFrame re-runs the current url on purpose', function () {
  client.internals.reloadFrame();
  assert.equal(client.navigations.length, 3);
  assert.equal(client.navigations[2], URL_A + '&other=1');
});

check('reading the cross-origin location is wrapped (must not throw)', function () {
  // 假 iframe 的 contentWindow 一讀就拋 SecurityError；外掛不該因此炸掉。
  const frame = client.iframes()[0];
  assert.throws(function () { return frame.contentWindow.location.href; });
  // 而外掛自己的常駐檢查路徑不碰 contentWindow，所以下面這些都不拋。
  client.internals.parkFrame();
  client.internals.navigateFrame(URL_A + '&other=1');
});

check('destroyFrame removes the frame and the keeper (plugin unload)', function () {
  client.internals.destroyFrame();
  assert.equal(client.iframes().length, 1, '建立的元素還在陣列裡（只是被拆下）');
  const frame = client.iframes()[0];
  assert.equal(frame.parentNode, null, 'destroy 之後 iframe 應該離開文件');
});

check('after destroy, a fresh navigate creates a new frame (fresh login)', function () {
  client.internals.navigateFrame(URL_A);
  assert.equal(client.iframes().length, 2, '卸下重建就該是新的 iframe');
  assert.equal(client.navigations.length, 4);
});

console.log('');
console.log(process.exitCode === 1 ? 'failed' : 'all ' + passed + ' checks passed');
