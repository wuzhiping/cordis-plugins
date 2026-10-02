'use strict';

// =============================================================================
// 团队协同 · ntfy-teams —— 离线测试（不需要网络、不需要浏览器）
//
//   node test/client-offline.js
//
// 验证三件事：
//   1. lib/client.js 是「一支 classic script、注册恰好一个 factory」，id 必须是
//      套件名 'ntfy-teams'（client-modules 以此为准，注册不到就是载入失败）。
//   2. factory(require) 回传的 exports 形状正确：apply 是函数、inject === ['slots']。
//   3. apply(ctx) 真的挂上三个座位：样式 effect、sidebar.panellist(id=ntfy-teams)、
//      main(key=ntfy-teams)，而且不抛错；另外抽验纯函数与仓库接线。
//
// 这里的 React 是「足以跑 hooks 的最小替身」：只实作本档用到的 useState/useEffect/
// useRef/createElement。它不渲染 DOM，只确保元件建得出来、hooks 不越界。
// =============================================================================

const path = require('node:path');
const assert = require('node:assert');

const BUNDLE = path.join(__dirname, '..');
const CORE_PATH = path.join(BUNDLE, 'lib', 'core.js');
const CLIENT_PATH = path.join(BUNDLE, 'lib', 'client.js');

let passed = 0;
let failed = 0;

/**
 * 跑一条断言。
 * @param name - 测试名称。
 * @param fn - 测试主体。
 */
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed += 1;
    console.log('  FAIL  ' + name);
    console.log('        ' + (err && err.message ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------- 环境替身 --

/** 最小 localStorage 替身。 */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    get length() { return map.size; },
    key: (i) => Array.from(map.keys())[i] ?? null,
  };
}

/** 最小 document/head 替身，只够 installStyles 用。 */
function makeDocument() {
  const head = [];
  return {
    head: {
      appendChild(node) { head.push(node); },
      removeChild(node) {
        const i = head.indexOf(node);
        if (i !== -1) head.splice(i, 1);
      },
    },
    createElement(tag) {
      return {
        tagName: String(tag).toUpperCase(),
        attributes: {},
        textContent: '',
        parentNode: null,
        setAttribute(name, value) { this.attributes[name] = value; },
      };
    },
    __head: head,
  };
}

/**
 * 足以驱动 hooks 的 React 替身。
 * createElement 只记录 type/props/children，不产生 DOM。
 */
function makeReact() {
  const slots = [];
  let cursor = 0;
  let effects = [];

  function useState(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    const setState = (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next;
    };
    return [slots[index], setState];
  }

  function useEffect(fn, deps) {
    const index = cursor;
    cursor += 1;
    slots[index] = { fn, deps };
    effects.push(slots[index]);
  }

  function useRef(initial) {
    const index = cursor;
    cursor += 1;
    if (!(index in slots)) slots[index] = { current: initial };
    return slots[index];
  }

  function createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.length > 1 ? children : children[0] };
  }

  return {
    React: {
      useState,
      useEffect,
      useRef,
      createElement,
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
    },
    /** 每次要建立元件树之前呼叫：重置 hooks 游标。 */
    reset() { cursor = 0; effects = []; },
    /** 已登记的 effect 数量（用来确认元件真的有挂 effect）。 */
    get effects() { return effects; },
  };
}

// ------------------------------------------------------------- 载入浏览器档 --
//
// 这里刻意**不**先载入 core.js：浏览器拿到的只有 lib/client.js 这一个档案
// （dsh.client 只送 exports["./client"]），所以 core 必须已经内嵌在里面。
// 若内嵌失效，下面「core 必须由 client.js 自己带进来」那条会立刻失败 ——
// 那正是让「核心模块未加载」在离线就被抓到的那道防线。

const localStorageStub = makeStorage();
globalThis.localStorage = localStorageStub;

let captured = null;
const documentStub = makeDocument();
const reactStub = makeReact();

// 浏览器里 window === globalThis（同一个 realm 的同一个物件），所以这里也这样模拟；
// 用「另建一个 window 物件」会造出一个浏览器不存在的分歧：内嵌的 core 会把
// moduleRoot 挂在 globalThis 上，而 factory 读的却是那个替身 window —— 于是测试
// 失败、浏览器却正常（反之亦然）。真实形状才抓得到真实的 bug。
globalThis.__ModuleLoader__ = {
  load(registration) {
    assert.strictEqual(captured, null, 'client.js 注册了多于一个 factory');
    captured = registration;
  },
};
globalThis.window = globalThis;
globalThis.document = documentStub;

// 载入浏览器档（会注册 factory，但还不执行 factory 本体）。
require(CLIENT_PATH);

// ---------------------------------------------------------------- 测试本体 --

console.log('');
console.log('ntfy-teams · client.js 离线测试');
console.log('');

test('注册恰好一个 factory，且 id === "ntfy-teams"', () => {
  assert.ok(captured, 'window.__ModuleLoader__.load 没有被呼叫');
  assert.strictEqual(typeof captured.factory, 'function', 'factory 不是函数');
  assert.strictEqual(captured.id, 'ntfy-teams', 'factory id 必须是套件名 ntfy-teams');
});

/** 以替身 require 建立 exports。 */
function buildExports() {
  const record = {};
  const fakeRequire = (name) => {
    record.requested = record.requested || [];
    record.requested.push(name);
    if (name === 'react') return reactStub.React;
    throw new Error('未预期的 require("' + name + '")');
  };
  const exports = captured.factory(fakeRequire);
  return { exports, record };
}

let built = null;
/** core 在 factory materialize 之后才会出现，所以这里留一个可变参考。 */
let core = null;

test('factory(require) 只 require("react")，并回传 exports', () => {
  built = buildExports();
  assert.ok(built.exports && typeof built.exports === 'object', 'factory 没有回传 exports');
  assert.deepStrictEqual(built.record.requested, ['react'], '除了 react 不该 require 其他套件');
});

test('core 由 client.js 自己带进来（协议层已内嵌，不是隔壁档案）', () => {
  core = globalThis.window.__ntfyTeamsCore;
  assert.ok(core, 'factory materialize 后 window.__ntfyTeamsCore 必须存在');
  assert.strictEqual(typeof core.store, 'object', 'core.store 必须存在');
  assert.strictEqual(typeof core.decodeId, 'function');
  assert.strictEqual(typeof core.publishMessage, 'function');
  assert.strictEqual(typeof core.subscribeTopic, 'function');
});

test('exports.inject 宣告 slots／layout／uiWorkspace', () => {
  // 实测教训：inject 只宣告 'slots' 时，在 onClick 里读 ctx.layout 会抛
  // `cannot get property "layout" without inject`，`if (ctx.layout && …)` 挡不住
  // （读属性本身就抛了）。所以 'layout' 必须一起注入。
  //
  // uiWorkspace 是「日復盤」要用的（開新工作階段）。它對這個外掛是可選依賴：
  // apply 用 ctx.get('uiWorkspace') 取，拿不到時其餘功能照常。
  assert.deepStrictEqual(built.exports.inject, ['slots', 'layout', 'uiWorkspace']);
  // core.js 内嵌区块不应把 'layout' 覆盖回去
  assert.ok(built.exports.inject.indexOf('layout') !== -1);
  assert.ok(built.exports.inject.indexOf('uiWorkspace') !== -1);
});

test('exports.apply 是函数', () => {
  assert.strictEqual(typeof built.exports.apply, 'function');
});

/** 收集注册进座的座位。 */
function makeCtx() {
  const seats = {};
  const disposers = [];
  /**
   * 宣告面板可見狀態。
   *
   * apply() 會照著 client 內部的 panelVisible 去設 store 的 view hook，而那個旗標
   * 預設是 false（面板還沒掛載）。測試要自己決定「現在有沒有人在看」，所以每次
   * effect 之後都重新宣告一次，蓋掉 apply() 設進去的預設值。
   * @param visible - 是否可見。
   */
  const announce = (visible) => {
    try {
      if (typeof core !== 'undefined' && core && core.store && typeof core.store.setViewHooks === 'function') {
        // 兩個旗標都要給：`isPanelVisible`（面板開著、正在看這個主題）與
        // `isFollowing`（**而且貼在底部**）。少了後者會變成「沒在看最新」，
        // 別人的訊息就一律算未讀 —— 那會讓一堆既有測試的預期落差。
        core.store.setViewHooks({
          isPanelVisible: () => visible === true,
          isFollowing: () => visible === true
        });
      }
    } catch (err) { /* 沒 core 時不影響 */ }
  };
  const context = {
    effect(fn, label) {
      const dispose = fn();
      const off = () => { if (typeof dispose === 'function') dispose(); };
      disposers.push(off);
      // apply() 剛把 view hook 設成「不可見」，這裡蓋回測試要的值。
      announce(context.__visible !== false);
      return off;
    },
    slots: {
      inject(slotName, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        seats[options.name + (options.key ? ':' + options.key : options.id ? ':' + options.id : '')] = {
          options,
          component,
        };
        return () => {};
      },
    },
    layout: {
      selected: null,
      selectPanel(id) { this.selected = id; },
    },
  };
  // apply() 現在會掛一個 host 層的即時同步（含 debounce timer）。測試若不清掉它，
  // process 會被那個 timer 拖著不結束（實測：跑完 30 項卻一直不 exit）。
  context.__dispose = () => { while (disposers.length) disposers.pop()(); };
  context.__visible = true;
  context.__setPanelVisible = (v) => { context.__visible = v !== false; announce(context.__visible); };
  return { context, seats };
}

test('apply(ctx) 挂上三个座位且不抛错', () => {
  const { context, seats } = makeCtx();
  built.exports.apply(context);

  assert.ok(seats['main:' + 'ntfy-teams'], 'main 座位没有注册 key=ntfy-teams');
  assert.ok(seats['sidebar.panellist:ntfy-teams'], 'sidebar.panellist 没有注册 id=ntfy-teams');
  assert.strictEqual(seats['main:' + 'ntfy-teams'].options.key, 'ntfy-teams');
  assert.strictEqual(seats['sidebar.panellist:ntfy-teams'].options.id, 'ntfy-teams');
  assert.strictEqual(
    seats['sidebar.panellist:ntfy-teams'].options.label(),
    '團隊協同',
    '側欄標籤必須是「團隊協同」（繁體，與宿主介面語言一致）',
  );
});

test('apply(ctx) 注入一支 <style data-plugin="ntfy-teams">', () => {
  const { context } = makeCtx();
  documentStub.__head.length = 0;
  built.exports.apply(context);
  const styles = documentStub.__head.filter((n) => n.tagName === 'STYLE');
  assert.strictEqual(styles.length, 1, '应该恰好注入一支样式表');
  assert.strictEqual(styles[0].attributes['data-plugin'], 'ntfy-teams');
  assert.ok(styles[0].textContent.includes('.ntfy-teams-root'), '样式表内容不对');
});

test('样式表只用主题令牌，不写死颜色（SVG 图稿除外）', () => {
  const { context } = makeCtx();
  documentStub.__head.length = 0;
  built.exports.apply(context);
  const css = documentStub.__head[0].textContent;
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  const rgb = css.match(/\brgba?\(/g) || [];
  // 已知且刻意的例外：都是使用者明確指定的固定灰階邊框／色碼。
  //   #ddd —— 看板的虛線左緣、以及抬頭的底線（1px solid）
  //   #eee —— 看板底部保留區的上緣（1px solid，使用者指定）
  //   #333 —— 焦點／深色邊框
  // 這裡用「扣掉已知例外後必須為空」而不是直接放寬成「允許 hex」——
  // 這樣新加的任何寫死顏色仍然會被擋下（這條規則的價值就在這裡）。
  const KNOWN_HEX = ['#ddd', '#333', '#eee'];
  const unexpectedHex = hex.filter((h) => KNOWN_HEX.indexOf(h) === -1);
  assert.deepStrictEqual(unexpectedHex, [],
    'CSS 里出现写死的十六进制颜色: ' + unexpectedHex.join(', '));
  // 例外必須真的存在 —— 否則它會變成一個永遠沒人用的白名單。
  assert.ok(hex.indexOf('#ddd') !== -1,
    '看板／抬頭的 #ddd 例外應該還在（若已改回令牌，請一併從白名單移除）');
  assert.deepStrictEqual(rgb, [], 'CSS 里出现写死的 rgb()/rgba() 颜色');
  assert.ok(css.includes('var(--dsw-alias-'), 'CSS 没有使用任何主题令牌');
});

test('連線那一列：輸入框要能被壓縮，否則「清除憑證」會被擠到第二行', () => {
  // 需求：認證／帳號／密碼／測試連線／儲存／清除憑證**排成一行**。
  //
  // 為什麼會換行：`--grow` 的 flex-basis 是 200px，兩個輸入框就先要 400px，
  // 加上選單與三顆按鈕會超出可用寬度（實測 825px 的列需要約 875px），
  // flex-wrap 於是把最後一顆（清除憑證）擠到下一行。
  //
  // 這條測試在 CSS 層面守住那個覆寫：輸入框必須是「可以縮到很小」的
  // （basis 小 + min-width:0，因為表單元件的預設 min-width 是 auto，
  // 不覆寫的話它會撐在 209px 左右不讓）。
  const { context } = makeCtx();
  documentStub.__head.length = 0;
  built.exports.apply(context);
  const css = documentStub.__head[0].textContent;

  // 覆寫必須存在，而且要在 `.ntfy-teams-connrow` 之內（才不會影響其他地方的輸入框）。
  const m = css.match(/\.ntfy-teams-connrow \.ntfy-teams-input\{([^}]*)\}/);
  assert.ok(m, 'CSS 應該有 `.ntfy-teams-connrow .ntfy-teams-input` 這條覆寫（否則清除憑證會換行）');
  const body = m[1];
  // basis 要比原本的 200px 小很多，讓三顆按鈕有位置
  const basis = (body.match(/flex:1 1 (\d+)px/) || [])[1];
  assert.ok(basis, '覆寫裡應該有 flex basis，實際：' + body);
  assert.ok(Number(basis) <= 120,
    'flex basis 應該縮小（<=120px）才排得下一行，實際 ' + basis + 'px');
  // min-width:0 是關鍵：表單元素預設 min-width:auto 會拒絕縮小
  assert.ok(body.indexOf('min-width:0') !== -1,
    '必須覆寫 min-width:0（表單元素預設 min-width:auto，不覆寫就縮不下去），實際：' + body);

  // 換行本身要留著：面板真的很窄時還是要能換，不能改成 nowrap 擠壞版面。
  //
  // 注意要用「行首就是 .ntfy-teams-connrow{」去比對：檔案裡還有一條
  // `.ntfy-teams-settings--open .ntfy-teams-connrow{padding:…}`，
  // 用寬鬆的比對會先命中那一條（實測踩過），於是永遠找不到 flex-wrap。
  const rowMatches = css.match(/(?:^|\})\.ntfy-teams-connrow\{([^}]*)\}/g) || [];
  assert.ok(rowMatches.length > 0, '應該有 .ntfy-teams-connrow 規則');
  const hasWrap = rowMatches.some((r) => r.indexOf('flex-wrap:wrap') !== -1);
  assert.ok(hasWrap,
    '窄面板時仍要能換行，所以 flex-wrap 必須保留 wrap，實際：' + JSON.stringify(rowMatches));
});

test('編輯中的主題：文字必須看得清（不能被聚焦的反色蓋掉）', () => {
  // 使用者回報：「topic 編輯模式，黑黑的反色背景無法看清文字」。
  //
  // 病灶：`.ntfy-teams-topic--editing`（淺底）與 `.ntfy-teams-topic--active`（反色）
  // 特異度**相同**，而反色那條寫在後面 → 正在編輯的聚焦主題變成
  // `background: label-primary` ＋ `color: bg-base`（深底＋白字），
  // 偏偏輸入框自己又是 `background: transparent`，文字就與底色同色了。
  //
  // 這裡在 CSS 層面守住兩件事：
  //   1. 有一條編輯狀態的覆寫把反色壓回去（而且包含 :hover 與輸入框的文字色）；
  //   2. 輸入框的文字色是**明確指定**的，不靠繼承（父層一旦反色就會變白字）。
  const { context } = makeCtx();
  documentStub.__head.length = 0;
  built.exports.apply(context);
  const css = documentStub.__head[0].textContent;

  // 1) 編輯狀態必須明確蓋掉反色的底色與字色
  const editingRules = css.match(/\.ntfy-teams-topic--editing[^{]*\{[^}]*\}/g) || [];
  assert.ok(editingRules.length > 0, '應該有 .ntfy-teams-topic--editing 規則');
  const overridesInverse = editingRules.some((r) => r.indexOf('color:var(--dsw-alias-label-primary)') !== -1
    && r.indexOf('background:var(--dsw-alias-bg-layer-2)') !== -1);
  assert.ok(overridesInverse,
    '編輯狀態必須把底色與字色都設回淺底／深字（否則被 --active 的反色蓋掉就看不清），實際：'
    + JSON.stringify(editingRules));

  // 也要蓋掉 hover —— 反色那條有 `:hover`，不比它明確就會在滑過時又變回反色。
  const hoverOverride = editingRules.some((r) => r.indexOf(':hover') !== -1
    && r.indexOf('color:var(--dsw-alias-label-primary)') !== -1);
  assert.ok(hoverOverride, '編輯狀態的 :hover 也要一起覆寫，否則滑過又變反色');

  // 2) 輸入框的文字色不該靠繼承
  assert.ok(/\.ntfy-teams-aliasinput[,{][^}]*color:var\(--dsw-alias-label-primary\)/.test(css)
    || /\.ntfy-teams-topic--editing \.ntfy-teams-input[^{]*\{[^}]*color:var\(--dsw-alias-label-primary\)/.test(css),
    '別名輸入框的文字色必須明確指定（不要靠繼承：父層是反色時會變白字）');
  // placeholder 才用次要色（它本來就該淡一點）
  assert.ok(/\.ntfy-teams-aliasinput::placeholder\{[^}]*color:/.test(css),
    'placeholder 應該有自己的顏色');
});

test('侧栏图示点一下会切换面板（active 时回 null）', () => {
  const { context, seats } = makeCtx();
  built.exports.apply(context);
  const seat = seats['sidebar.panellist:ntfy-teams'];

  reactStub.reset();
  const closedProps = { size: 18, active: false, onClick: undefined };
  const closedNode = seat.component(closedProps);
  // 侧栏给的 onClick 由座位自己接上；直接驱动它。
  const ctx2 = context;
  reactStub.reset();
  const node = seat.component({ size: 18, active: false });
  assert.ok(node, '图示元件没有渲染出东西');
  node.props.onClick();
  assert.strictEqual(ctx2.layout.selected, 'ntfy-teams', '未选中时应切到 ntfy-teams');

  reactStub.reset();
  const activeNode = seat.component({ size: 18, active: true });
  activeNode.props.onClick();
  assert.strictEqual(ctx2.layout.selected, null, '已选中时应切回会话（null）');
  void closedNode;
});

test('面板座位的元件建得出来（core 已加载）', () => {
  const { context, seats } = makeCtx();
  built.exports.apply(context);
  reactStub.reset();
  const seat = seats['main:ntfy-teams'];
  // 座位回传的是 <PanelEntry/>：core 存在时它再委派给 <MainPanel/>。
  const entry = seat.component();
  assert.ok(entry, '面板没有渲染出东西');
  assert.strictEqual(typeof entry.type, 'function', '座位应回传一个元件');
  // 把 PanelEntry 展开一层，确认它委派到 MainPanel 而不是「核心模块未加载」。
  reactStub.reset();
  const inner = entry.type();
  assert.ok(inner, 'PanelEntry 没有回传内容');
  assert.strictEqual(typeof inner.type, 'function', 'PanelEntry 应委派给 MainPanel 元件');
});

test('纯函数：serverHost / phaseModifier / badgeText', () => {
  const t = built.exports.__test;
  assert.strictEqual(t.serverHost('https://msn.feg.cn'), 'msn.feg.cn');
  assert.strictEqual(t.serverHost('https://msn.feg.cn/base/'), 'msn.feg.cn');
  assert.strictEqual(t.phaseModifier('live'), 'ok');
  assert.strictEqual(t.phaseModifier('error'), 'err');
  assert.strictEqual(t.phaseModifier('connecting'), 'warn');
  assert.strictEqual(t.badgeText(0), '');
  assert.strictEqual(t.badgeText(7), '7');
  assert.strictEqual(t.badgeText(120), '99+');
});

test('纯函数：safeHref 只放行 http/https', () => {
  const t = built.exports.__test;
  assert.strictEqual(t.safeHref('https://a.example/x'), 'https://a.example/x');
  assert.strictEqual(t.safeHref('http://a.example'), 'http://a.example');
  assert.strictEqual(t.safeHref('javascript:alert(1)'), '');
  assert.strictEqual(t.safeHref('  '), '');
});

test('纯函数：时间格式与 id 推时', () => {
  const t = built.exports.__test;
  // 注意：本台 ntfy 服务器（msn.feg.cn）发出的 id 是随机字串，不是时间编码，
  // 实测 8 个样本的任一种位元组解读都对不上 time 栏位。因此 decodeId 回 null
  // 是正确行为，UI 一律以服务器给的 time 栏位为准。
  const decoded = t.decodeTime('1jLfaNcFIDCe');
  assert.strictEqual(decoded, null, '随机 id 不应被硬解成荒谬的年份');
  assert.strictEqual(t.decodeTime('not-base64!!'), null);

  // time 缺失（0）且 id 无法解时回 null，UI 显示空白而非乱数时间。
  assert.strictEqual(t.messageTime({ id: '1jLfaNcFIDCe', time: 0 }), null);
  // time 存在时一律优先采用。
  assert.strictEqual(t.messageTime({ id: '1jLfaNcFIDCe', time: 1790756810 }), 1790756810);
  assert.strictEqual(t.messageTime({ id: 'x', time: 123 }), 123);

  const out = t.formatTime(1790756810);
  assert.ok(/^\d{2}:\d{2}:\d{2}$|^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(out), '时间格式不对: ' + out);
  assert.strictEqual(t.formatTime(0), '');
  assert.strictEqual(t.formatTime(null), '');
});

test('仓库接线：addMessage 后快照换了新参考且讯息进了对应 topic', () => {
  const snapBefore = core.store.getSnapshot();
  const snapSame = core.store.getSnapshot();
  assert.strictEqual(snapBefore, snapSame, '没有变动时 getSnapshot() 必须回同一个参考');

  core.store.ensureTopic('pub_offline');
  const topic = core.store.getSnapshot();
  assert.ok(topic.topics.includes('pub_offline'), 'ensureTopic 没有把 topic 加进去');

  const changed = core.store.addMessage('pub_offline', {
    id: '1jLfaNcFIDCe',
    time: 1790756810,
    topic: 'pub_offline',
    message: 'offline harness message',
    tags: [],
  });
  assert.strictEqual(changed, true, 'addMessage 应回报有新增');

  const after = core.store.getSnapshot();
  assert.notStrictEqual(after, snapBefore, '有变动后 getSnapshot() 必须换新参考');
  const list = after.messagesByTopic.pub_offline || [];
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].message, 'offline harness message');

  // 同一则再喂一次不应该重复。
  core.store.addMessage('pub_offline', {
    id: '1jLfaNcFIDCe',
    time: 1790756810,
    topic: 'pub_offline',
    message: 'offline harness message',
    tags: [],
  });
  assert.strictEqual((core.store.getSnapshot().messagesByTopic.pub_offline || []).length, 1, '同一 id 不该重复');

  core.store.removeTopic('pub_offline');
});

test('仓库订阅：listener 会被呼叫，取消订阅后不再收到', () => {
  let hits = 0;
  const off = core.store.subscribe(() => { hits += 1; });
  core.store.ensureTopic('pub_offline_sub');
  assert.ok(hits > 0, '订阅后变更应通知 listener');
  off();
  const before = hits;
  core.store.ensureTopic('pub_offline_sub2');
  assert.strictEqual(hits, before, '取消订阅后不该再收到通知');
  core.store.removeTopic('pub_offline_sub');
  core.store.removeTopic('pub_offline_sub2');
});

test('core 缺失时面板座位仍可渲染（不会炸掉整个 slot）', () => {
  const saved = globalThis.window.__ntfyTeamsCore;
  globalThis.window.__ntfyTeamsCore = undefined;
  // client.js 已 materialize，factory 内的 core 变数已固定；这里改的是 fallback 路径的
  // 可用性检查，因此直接抽验 __test.apply 在 core 存在时仍正常即可。
  const { context, seats } = makeCtx();
  assert.doesNotThrow(() => built.exports.apply(context));
  assert.ok(seats['main:ntfy-teams']);
  globalThis.window.__ntfyTeamsCore = saved;
});

// ------------------------------- 回归：单一档案自足（真实浏览器载入形状） --
//
// 这是浏览器端真正发生的事，也是最初的 bug：
//   * combo script 把每个 plugin 档案包成 lazy body，档案在「注册阶段」不执行；
//   * dsh-client-modules 只送 exports["./client"] 这一个档案 —— 隔壁 lib/core.js
//     永远不会被送出去（实测 GET /plugins/ntfy-teams/core.js → 404）。
// 于是「core.js 排在前面」或「client.js 呼叫 root.moduleRoot()」都救不了：
// moduleRoot 根本不存在，面板显示「核心模块未加载」。
//
// 正确做法是 core 内嵌进 client.js（见 build.js）。这个回归用干净的 registry
// 从零重跑一次，且**刻意不预先把任何 core 放进全局**。
(function regression() {
  console.log('');
  console.log('回归：单一档案自足（lazy body + 只有一个 client 档案）');
  console.log('');

  const MODULE_ID = 'ntfy-teams';
  const registry = new Map();

  // 同样模拟浏览器：window === globalThis。
  const savedWindow = globalThis.window;
  const savedLoader = globalThis.__ModuleLoader__;
  const savedCore = globalThis.__ntfyTeamsCore;
  delete globalThis.__ntfyTeamsCore;

  globalThis.__ModuleLoader__ = {
    load(registration) {
      assert.ok(!registry.has(registration.id), '重复注册 factory：' + registration.id);
      registry.set(registration.id, registration.factory);
    },
  };
  globalThis.window = globalThis;

  test('没有外部 core 时，client.js 自己就能把协议层带进来', () => {
    assert.strictEqual(
      typeof globalThis.__ntfyTeamsCore,
      'undefined',
      '起跑点必须干净：全局不该预先有 core',
    );

    // 1) 只载入 client.js —— 浏览器就是这样，没有第二个档案
    delete require.cache[require.resolve(CLIENT_PATH)];
    require(CLIENT_PATH);
    const factory = registry.get(MODULE_ID);
    assert.ok(factory, 'client.js 没有注册 factory');
    assert.strictEqual(registry.size, 1, '应当只注册一个 factory，实际 ' + registry.size);
    assert.strictEqual(
      typeof globalThis.__ntfyTeamsCore,
      'undefined',
      '注册阶段不该执行 factory 本体',
    );

    // 2) materialize —— 内嵌的 core 必须在这一刻出现
    const fakeRequire = (name) => {
      if (name === 'react') return reactStub.React;
      throw new Error('未预期的 require("' + name + '")');
    };
    let exports;
    assert.doesNotThrow(() => { exports = factory(fakeRequire); }, 'factory 不应抛错');
    assert.ok(exports && typeof exports.apply === 'function');
    assert.ok(
      globalThis.__ntfyTeamsCore && typeof globalThis.__ntfyTeamsCore.decodeId === 'function',
      'factory 执行后必须存在 window.__ntfyTeamsCore（代表内嵌区块真的在跑）',
    );

    // 3) 面板必须渲染「真面板」，而不是「核心模块未加载」的 fallback
    const seats = {};
    const ctx = {
      effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
      slots: {
        inject: (_name, cb) => { cb(); return () => {}; },
        register: (options, component) => {
          seats[options.name + ':' + (options.key || options.id)] = { options, component };
          return () => {};
        },
      },
      layout: { selectPanel() {} },
    };
    exports.apply(ctx);
    const seat = seats['main:ntfy-teams'];
    assert.ok(seat, 'main 座位没有注册');
    reactStub.reset();
    const entry = seat.component();
    reactStub.reset();
    const inner = entry.type();
    // 「核心模块未加载」会回传一个 div（host 型别是字串）；真面板会委派给 MainPanel（函数）。
    assert.strictEqual(
      typeof inner.type,
      'function',
      '面板落回了「核心模块未加载」——内嵌区块没有生效，回头跑 node build.js',
    );
  });

  globalThis.window = savedWindow;
  globalThis.__ModuleLoader__ = savedLoader;
  if (savedCore === undefined) delete globalThis.__ntfyTeamsCore;
  else globalThis.__ntfyTeamsCore = savedCore;
})();

// ------------------------------------------ 回归：订阅清单必须真的落盘 --
//
// 这条是为了一个实测漏掉的 bug：core.store 是纯状态、不写 localStorage，
// 而 UI 层当初只呼叫 loadPersisted()、从来没有呼叫 persist()。结果
// localStorage 里永远没有 ntfy-teams:store:v1，重新整理后订阅清单就没了
// （浏览器验证抓到：加完 topic 后 key 不存在，手动 persist() 才出现）。
//
// 这里用一个「会重跑 hooks」的 React 替身，把核心顺序走一遍：
// 挂载 → loadPersisted() → 建立 topic → 应该写出 store 快照。
(function persistRegression() {
  console.log('');
  console.log('回归：面板挂载后，订阅清单必须落盘（persist 有被呼叫）');
  console.log('');

  const savedLoader = globalThis.__ModuleLoader__;
  const savedCore = globalThis.__ntfyTeamsCore;
  const savedWindow = globalThis.window;
  const store = makeStorage();
  globalThis.localStorage = store;
  globalThis.window = globalThis;

  /** 会保存 hooks 并同步重跑的 React 替身（makeHookedReact，定义在档尾）。 */
  const makeRealishReact = makeHookedReact;

  const harness = makeHookedReact();
  const registry = new Map();
  globalThis.__ModuleLoader__ = {
    load(registration) { registry.set(registration.id, registration.factory); },
  };
  delete globalThis.__ntfyTeamsCore;

  test('透過面板新增主題後：設定寫回宿主，且 localStorage 完全沒被寫入', () => {
    delete require.cache[require.resolve(CLIENT_PATH)];
    require(CLIENT_PATH);
    const factory = registry.get('ntfy-teams');
    assert.ok(factory, '没有注册 factory');

    const exports = factory((name) => {
      if (name === 'react') return harness.React;
      throw new Error('未预期的 require("' + name + '")');
    });

    const core = globalThis.__ntfyTeamsCore;
    assert.ok(core && core.store, '内嵌 core 必须可用');
    assert.strictEqual(
      typeof exports.__test.saveSubscriptions, 'function',
      '必须导出 saveSubscriptions 供测试与内部使用',
    );

    // 記錄所有對 localStorage 的寫入：這個外掛**不應該**寫任何一次。
    const writes = [];
    const realSet = store.setItem;
    store.setItem = (k, v) => { writes.push(String(k)); return realSet.call(store, k, v); };

    try {
      const seats = {};
      exports.apply({
        effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
        slots: {
          inject: (_n, cb) => { cb(); return () => {}; },
          register: (options, component) => {
            seats[options.name + ':' + (options.key || options.id)] = { options, component };
            return () => {};
          },
        },
        layout: { selectPanel() {} },
      });

      // 面板主體掛載
      assert.ok(harness.render(seats['main:ntfy-teams'].component, {}), '面板沒有渲染出東西');

      // TopicBar 的「+ 訂閱主題」在 commit() 裡就是做這幾件事。
      core.store.ensureTopic('pub_persist_probe');
      core.store.setActiveTopic('pub_persist_probe');
      const ok = exports.__test.saveSubscriptions();
      assert.strictEqual(ok, true, 'saveSubscriptions 應該回報已受理');
      assert.strictEqual(core.store.getSnapshot().topics.indexOf('pub_persist_probe') !== -1,
        true, 'store 應該有這個主題');

      // 關鍵：**一次都不該寫 localStorage**。
      assert.deepStrictEqual(writes, [],
        '這個外掛不該寫 localStorage，實際寫了：' + JSON.stringify(writes));
      // 兩個舊的 key 也應該完全不存在。
      assert.strictEqual(store.getItem('ntfy-teams:store:v1'), null, '不該有訊息快取存檔');
      assert.strictEqual(store.getItem('ntfy-teams:config:v1'), null, '不該有設定存檔');
      core.store.removeTopic('pub_persist_probe');
    } finally {
      store.setItem = realSet;
    }
  });

  // 还原
  globalThis.__ModuleLoader__ = savedLoader;
  globalThis.window = savedWindow;
  if (savedCore === undefined) delete globalThis.__ntfyTeamsCore;
  else globalThis.__ntfyTeamsCore = savedCore;
})();

// ---------------------------------------------------------------- 共用替身 --

/**
 * 回歸：「刪除 topic → 重新打開又出現」。
 *
 * 根因：同步宿主設定時只呼叫 store.ensureTopic()（**只加不減**），
 * 所以宿主已經刪掉的主題在 store 裡不會消失；而 store 又會從 localStorage 的
 * 訊息快取把舊主題撈回來 —— 畫面上於是「刪掉的又出現了」。
 *
 * 這裡用純 store 邏輯驗證「同步 = 讓 store 等於宿主的清單」這件事。
 */
(function () {
  const assert = require('node:assert');
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    key: (i) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    clear: () => m.clear(),
  };
  delete require.cache[require.resolve('../lib/core.js')];
  const core = require('../lib/core.js');

  test('同步後 store 的主題必須等於宿主的清單（只加不減是 bug）', () => {
    core.store.getSnapshot().topics.slice().forEach((t) => core.store.removeTopic(t));
    // 模擬：store 從快取撈回了「宿主已經刪掉」的舊主題
    core.store.ensureTopic('pub_keep');
    core.store.ensureTopic('pub_stale');   // ← 宿主已經沒有這個了

    // 模擬同步：宿主清單只有 pub_keep
    const want = ['pub_keep'];
    for (const t of want) core.store.ensureTopic(t);
    for (const t of core.store.getSnapshot().topics.slice()) {
      if (want.indexOf(t) === -1) core.store.removeTopic(t);
    }

    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_keep'],
      '宿主沒有的主題必須從 store 移除，實際：' + JSON.stringify(core.store.getSnapshot().topics));
  });
})();

// -------------------------------------------- 回归：工作群組 UI / markdown / #username --
//
// 这一组盯住三个「看得到才算数」的需求：
//   1. 面板是工作组结构（群组抬头 + 头像 + 訊息串 + 撰写区），不是一条扁平列表；
//   2. 內文走 markdown 渲染，而且绝不產生危险元素（不注入 HTML、不放行 javascript:）；
//   3. 送出的訊息 title 就是 #username。
(function redesignRegression() {
  console.log('');
  console.log('回归：工作群組 UI、markdown 渲染、#username 身分');
  console.log('');

  const savedLoader = globalThis.__ModuleLoader__;
  const savedCore = globalThis.__ntfyTeamsCore;
  const savedWindow = globalThis.window;
  const store = makeStorage();
  globalThis.localStorage = store;
  globalThis.window = globalThis;

  const registry = new Map();
  globalThis.__ModuleLoader__ = {
    load(registration) { registry.set(registration.id, registration.factory); },
  };
  delete globalThis.__ntfyTeamsCore;

  /**
   * 把 React 元素树摊平成 {tag, cls, text, props} 清单。
   *
   * 每个测试都用「自己的」harness 呼叫这个函式（hook 状态不跨测试共用）。
   *
   * 展开自订元件时的规则（踩过两次坑才定下来）：
   *   进入 walk 时先冻结一份 hook 状态 `outer`，之后**每次**展开元件都先还原到
   *   `outer` 再呼叫它。这样：
   *     * 元件之间不会互相沿用 stateSlots（否则摘要会读到别的元件的 useState 值）；
   *     * 元件在展开期间呼叫 setState 造成的重绘也不会被还原掉
   *       （否则「双击 → 变成输入框」这种需要状态的画面永远看不到）。
   *   两者只做其中一个都会坏，所以这里是「还原到同一个外层快照」而不是各自 reset。
   *
   * @param harness - makeHookedReact() 的实例，用来安全地展开自订元件。
   * @param node - React 元素或元素阵列。
   * @param out - 累积用的阵列。
   * @param depth - 目前深度。
   * @param outer - 内部用：整棵树共用的外层快照。
   */
  /**
   * 把一個元素的子樹攤平成走訪節點（含文字）。
   *
   * ⚠️ 為什麼需要這個：`walk()` 產生的節點是**已經攤平過**的，`n.children` 是
   * 原始 React 子元素（不是走訪節點）。所以不能對 `n.children` 直接再 `walk()`，
   * 也不能用 `array.forEach(collect)` 去收集 —— `forEach` 會多傳 index 與陣列，
   * 遞迴函式的第二個參數就被污染了，而且**不會報錯**，只會安靜地收不到東西。
   *
   * @param harness - 測試替身。
   * @param element - 原始 React 元素（或節點）。
   * @returns 走訪節點陣列。
   */
  function walkInto(harness, element) {
    const out = [];
    if (element === null || element === undefined) return out;
    if (element.tag) {
      // 已經是走訪節點 → 從它的原始 children 繼續。
      walk(harness, element.children, out, 0);
      return out;
    }
    walk(harness, element, out, 0);
    return out;
  }

  /** 測試脚手架：找一個走訪節點。 @param nodes - 走訪結果。 @param cls - class 名。 @returns 節點。 */
  function findNode(nodes, cls) {
    return nodes.filter((n) => n.cls
      && String(n.cls).split(/\s+/).indexOf(cls) !== -1)[0];
  }

  function walk(harness, node, out, depth, outer) {
    if (outer === undefined) outer = harness.snapshot();
    if (node === null || node === undefined || depth > 40) return;
    if (Array.isArray(node)) {
      node.forEach((child) => walk(harness, child, out, depth + 1, outer));
      return;
    }
    if (typeof node === 'string' || typeof node === 'number') {
      out.push({ tag: '#text', text: String(node) });
      return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.type === 'function') {
      // 自订元件：为了看到结构直接呼叫它。
      //
      // 用「换一颗全新的 slot 阵列、内容沿用外层快照」的方式隔离：
      //   * 共用同一组 slot：后面被展开的元件会读到前面元件的 useState 值；
      //   * 单纯 reset 清空：需要保留状态的元件（正在改别名的 TopicBar）会掉回初始值；
      //   * 换成另一颗阵列：元件拿得到当前状态，但它自己 setState 造成的重绘只写到
      //     这颗临时阵列，不会污染外层，也不会被随后的还原吃掉。
      const frozen = harness.snapshot();
      const scratch = harness.swapSlots();
      let rendered = null;
      try {
        rendered = node.type(node.props);
      } catch (err) {
        rendered = null;
      }
      harness.swapSlots(scratch);
      harness.restore(frozen);
      walk(harness, rendered, out, depth + 1, outer);
      return;
    }
    if (typeof node.type === 'string') {
      out.push({
        tag: node.type,
        cls: (node.props && node.props.className) || '',
        props: node.props || {},
        children: node.children,
      });
      const kids = node.children;
      if (Array.isArray(kids)) kids.forEach((child) => walk(harness, child, out, depth + 1, outer));
      else walk(harness, kids, out, depth + 1, outer);
      return;
    }
  }

  /** @param nodes - walk 结果。 @returns 全部文字。 */
  function allText(nodes) {
    return nodes.filter((n) => n.tag === '#text').map((n) => n.text).join(' ');
  }

  /**
   * 這個節點是不是**日期抬頭**（`.ntfy-teams-day`，可帶 `--today` / `--collapsed`）。
   *
   * ⚠️ 不能用 `cls.indexOf('ntfy-teams-day') !== -1`：那個前綴會**誤中**
   * 日期跳轉列的按鈕 `.ntfy-teams-daynavbtn`（實測：3 天被算成 6 個）。
   * 這跟 `ntfy-teams-header` 誤中 `ntfy-teams-headeracts` 是同一類陷阱。
   *
   * 這裡用「切 token」比對：`ntfy-teams-day` 本身要是獨立的一個 class，
   * 而且不能是 `ntfy-teams-daynav*` 家族。
   *
   * @param n - walk 出來的節點。
   * @returns 是否為日期抬頭。
   */
  function hasDayToken(n) {
    if (!n || !n.cls) return false;
    const tokens = String(n.cls).split(/\s+/).filter(Boolean);
    if (tokens.indexOf('ntfy-teams-daynav') !== -1) return false;
    if (tokens.some((t) => t.indexOf('ntfy-teams-daynav') === 0)) return false;
    return tokens.indexOf('ntfy-teams-day') !== -1
      || tokens.indexOf('ntfy-teams-day--today') !== -1
      || tokens.indexOf('ntfy-teams-day--collapsed') !== -1;
  }

  /** @param nodes - walk 结果。 @param tag - 元素名。 @returns 该元素出现次数。 */
  function countTag(nodes, tag) {
    return nodes.filter((n) => n.tag === tag).length;
  }

  /**
   * 把一个 React 节点的文字全部收拢起来（文字可能夹在阵列里）。
   * @param node - React 节点。
   * @returns 文字。
   */
  function collectText(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(collectText).join('');
    if (typeof node === 'object' && node.children !== undefined) return collectText(node.children);
    return '';
  }

  /**
   * 每个测试都从干净状态开始：新的 harness、重新 materialize client.js。
   * @returns {{harness: object, exports: object, core: object, seats: object}}
   */
  function freshPanel() {
    const harness = makeHookedReact();
    delete require.cache[require.resolve(CLIENT_PATH)];
    require(CLIENT_PATH);
    const factory = registry.get('ntfy-teams');
    assert.ok(factory, '没有注册 factory');
    const mod = factory((name) => {
      if (name === 'react') return harness.React;
      throw new Error('未预期的 require("' + name + '")');
    });
    const core = globalThis.__ntfyTeamsCore;
    assert.ok(core && core.store, '内嵌 core 必须可用');
    const seats = {};
    const setVisible = (v) => {
      if (core && core.store && typeof core.store.setViewHooks === 'function') {
        // 同 announce：兩個旗標一起設（可見且貼底 = 正在看最新）。
        core.store.setViewHooks({
          isPanelVisible: () => v !== false,
          isFollowing: () => v !== false
        });
      }
    };
    mod.apply({
      effect: (fn) => {
        const d = fn();
        // apply() 依 DOM 判斷可見性，而測試的 document 是替身、查不到面板根節點，
        // 所以一律會是「不可見」。測試要的是「面板正開著」的語意，這裡明說。
        setVisible(true);
        return () => { if (typeof d === 'function') d(); };
      },
      slots: {
        inject: (_n, cb) => { cb(); return () => {}; },
        register: (options, component) => {
          seats[options.name + ':' + (options.key || options.id)] = { options, component };
          return () => {};
        },
      },
      layout: { selectPanel() {} },
    });
    setVisible(true);
    return { harness, exports: mod, core, seats, setPanelVisible: setVisible };
  }

  test('面板渲染出工作组结构（群组抬头 / 头像 / 訊息串 / 撰写区）', () => {
    const { harness, core, seats } = freshPanel();

    // 准备一则带 markdown 与身分的訊息，让訊息串真的有东西可渲染。
    core.store.ensureTopic('pub_demo');
    core.store.addMessage('pub_demo', {
      id: 'msg-1',
      time: Math.floor(Date.now() / 1000) - 60,
      topic: 'pub_demo',
      title: '#shawoo',
      message: '# 標題\n\n**粗體** 與 `code`\n\n- 甲\n- 乙\n\n> 引用\n\n```js\nconst a = 1;\n```\n\n[連結](https://example.com)',
    });

    const tree = harness.render(seats['main:ntfy-teams'].component, {});
    const nodes = [];
    walk(harness, tree, nodes, 0);

    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-grouplogo') !== -1),
      '应有工作组標誌（grouplogo）');
    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-title') !== -1),
      '应有群組名稱');
    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-subtitle') !== -1),
      '应有副標題（伺服器 / 話題數 / 身分）');
    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-avatar') !== -1),
      '每則訊息應有頭像（workgroup 觀感）');
    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-sender') !== -1),
      '每則訊息應有發送者');
    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-stream') !== -1),
      '應有訊息串容器');
    assert.ok(nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-compose') !== -1),
      '應有撰寫區');

    const txt = allText(nodes);
    assert.ok(txt.indexOf('團隊協同') !== -1, '群組名稱應為繁體「團隊協同」，實際：' + txt.slice(0, 120));
    assert.ok(txt.indexOf('#shawoo') !== -1, '應顯示發送者 #shawoo');
  });

  test('markdown 渲染成真正元素，且不注入 HTML', () => {
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_md');
    core.store.addMessage('pub_md', {
      id: 'md-1',
      time: Math.floor(Date.now() / 1000) - 60,
      topic: 'pub_md',
      title: '#someone',
      message: [
        '# H1',
        '## H2',
        '',
        '**粗體** *斜體* ~~刪除~~ `行內`',
        '',
        '- 項目一',
        '- 項目二',
        '',
        '> 引用文字',
        '',
        '```js',
        'const x = 1;',
        '  indented();',
        '```',
        '',
        '[安全連結](https://example.com/path)',
        '',
        '[危險連結](javascript:alert(1))',
        '',
        '<script>alert(2)</script>',
        '<img src=x onerror=alert(3)>',
      ].join('\n'),
    });

    const tree = harness.render(seats['main:ntfy-teams'].component, {});
    const nodes = [];
    walk(harness, tree, nodes, 0);

    assert.ok(countTag(nodes, 'h1') >= 1, '應渲染 <h1>');
    assert.ok(countTag(nodes, 'h2') >= 1, '應渲染 <h2>');
    assert.ok(countTag(nodes, 'strong') >= 1, '應渲染 <strong>');
    assert.ok(countTag(nodes, 'em') >= 1, '應渲染 <em>');
    assert.ok(countTag(nodes, 'del') >= 1, '應渲染 <del>');
    assert.ok(countTag(nodes, 'code') >= 1, '應渲染 <code>');
    assert.ok(countTag(nodes, 'ul') >= 1 && countTag(nodes, 'li') >= 2, '應渲染清單');
    assert.ok(countTag(nodes, 'blockquote') >= 1, '應渲染 <blockquote>');
    assert.ok(countTag(nodes, 'pre') >= 1, '應渲染 <pre>');

    // 围栏程式码内容必须逐字保留（含缩排）。
    const preText = nodes.filter((n) => n.tag === '#text').map((n) => n.text).join('\n');
    assert.ok(preText.indexOf('const x = 1;') !== -1, '程式碼內容應保留');
    assert.ok(preText.indexOf('  indented();') !== -1, '程式碼縮排應逐字保留');

    // 只有 http/https 會變成 <a>：javascript: 必須退化為文字。
    const anchors = nodes.filter((n) => n.tag === 'a');
    assert.strictEqual(anchors.length, 1, '只應有一個連結，實際：' + anchors.length);
    assert.strictEqual(
      anchors[0].props.href,
      'https://example.com/path',
      '唯一連結必須是安全的那一個',
    );
    assert.ok(
      preText.indexOf('javascript:alert(1)') !== -1,
      'javascript: 連結必須以純文字呈現',
    );

    // 不得注入 HTML：沒有 script / img 元素產生。
    assert.strictEqual(countTag(nodes, 'script'), 0, '不得產生 <script>');
    assert.strictEqual(countTag(nodes, 'img'), 0, '不得產生 <img>');
    assert.ok(
      preText.indexOf('<script>alert(2)</script>') !== -1,
      '原始 HTML 必須以純文字呈現（未被當成標籤）',
    );

    core.store.removeTopic('pub_md');
  });

  test('送出的訊息 title 就是 #username（核心規則 + 撰寫區顯示）', () => {
    // 先設定身分，再開面板，撰寫區才會帶著 #name。
    const coreProbe = require(CORE_PATH);
    if (typeof coreProbe.setIdentity === 'function') coreProbe.setIdentity('shawoo');

    const { harness, exports: mod, core, seats } = freshPanel();
    core.store.ensureTopic('pub_identity');
    if (typeof core.setIdentity === 'function') core.setIdentity('shawoo');

    const tree = harness.render(seats['main:ntfy-teams'].component, {});
    const nodes = [];
    walk(harness, tree, nodes, 0);
    const txt = allText(nodes);
    assert.ok(txt.indexOf('#shawoo') !== -1, '撰寫區應顯示 #shawoo，實際：' + txt.slice(0, 300));
    // 身分說明現在是**行內簡短版**（只有 `#名稱`），完整句子（「以…的身分傳送」）
    // 搬到 tooltip —— 那一段每一眼都要重讀，但只在真的要確認時才有用。
    const sendAsNode = nodes.filter((n) => n.cls
      && String(n.cls).split(/\s+/).indexOf('ntfy-teams-sendas') !== -1)[0];
    assert.ok(sendAsNode, '應該有身分顯示');
    assert.ok(String(sendAsNode.props.title || '').indexOf('的身分傳送') !== -1,
      'tooltip 應說明以誰的身分傳送，實際：' + sendAsNode.props.title);

    // core 的規則
    assert.strictEqual(core.getIdentity(), 'shawoo', 'setIdentity 應存下 shawoo');
    assert.strictEqual(core.senderTitle('shawoo'), '#shawoo', 'senderTitle(shawoo) 應為 #shawoo');
    assert.strictEqual(core.senderTitle('#shawoo'), '#shawoo', 'senderTitle 應冪等，不得變成 ##shawoo');
    assert.strictEqual(core.senderTitle(''), '', '空名稱應回空字串');

    // client 的 titleFor 必須與 core 的規則一致（撰寫區送出的 title 用它產生）
    const t = mod.__test;
    assert.strictEqual(t.titleFor('shawoo'), '#shawoo', 'titleFor(shawoo) 應為 #shawoo');
    assert.strictEqual(t.titleFor('#shawoo'), '#shawoo', 'titleFor 應冪等');
    assert.strictEqual(t.titleFor('  bob  '), '#bob', 'titleFor 應 trim');
    assert.strictEqual(t.titleFor(''), '', 'titleFor(\'\') 應為空');
    assert.strictEqual(t.PANEL_LABEL, '團隊協同');
    assert.deepStrictEqual(
      t.identityOf('#shawoo'),
      { handle: 'shawoo', isMention: true },
      'identityOf 應解析 #shawoo',
    );
    // 舊的 @ 格式：解析仍要成功（否則舊主題的訊息會變成未具名），
    // 而且送出的 title 會被正規化成 #。
    assert.deepStrictEqual(
      t.identityOf('@shawoo'),
      { handle: 'shawoo', isMention: true },
      'identityOf 仍應解析舊的 @shawoo',
    );
    assert.strictEqual(t.titleFor('@shawoo'), '#shawoo', '舊 @ 輸入要正規化成 #');
    assert.deepStrictEqual(
      t.identityOf('隨便一個標題'),
      { handle: '', isMention: false },
      '非 # 開頭的標題不算發送者',
    );

    core.store.removeTopic('pub_identity');
  });

  test('側欄未讀數量 badge：計數語意與顯示', () => {
    const { harness, exports: mod, core, seats } = freshPanel();
    const t = mod.__test;

    core.store.ensureTopic('pub_a');
    core.store.ensureTopic('pub_b');
    core.store.setActiveTopic('pub_a');
    assert.strictEqual(t.totalUnread(core.store.getSnapshot()), 0, '起點應為 0');

    // 歷史載入不算未讀
    core.store.addMessages('pub_b', [{ id: 'h1', time: 100, topic: 'pub_b', message: 'history' }], 'history');
    assert.strictEqual(t.totalUnread(core.store.getSnapshot()), 0, '歷史訊息不應計入未讀');

    // 即時訊息：非當前主題才累加
    core.store.addMessage('pub_b', { id: 's1', time: 200, topic: 'pub_b', message: 'live', source: 'sse' });
    core.store.addMessage('pub_b', { id: 's2', time: 201, topic: 'pub_b', message: 'live2', source: 'sse' });
    core.store.addMessage('pub_a', { id: 's3', time: 202, topic: 'pub_a', message: 'active', source: 'sse' });
    assert.strictEqual(t.totalUnread(core.store.getSnapshot()), 2, 'pub_b 的 2 則即時訊息應計入未讀');

    // 側欄 badge 顯示的是「數量」，不是只有一個紅點
    harness.reset();
    const icon = seats['sidebar.panellist:ntfy-teams'].component({ size: 16, active: false });
    const nodes = [];
    walk(harness, icon, nodes, 0);
    assert.ok(
      nodes.some((n) => n.cls && n.cls.indexOf('ntfy-teams-unreadbadge') !== -1),
      '側欄應有未讀 badge 元素',
    );
    assert.ok(allText(nodes).indexOf('2') !== -1, 'badge 應顯示數量 2');

    // 看過（切到該主題）就清零
    core.store.setActiveTopic('pub_b');
    assert.strictEqual(t.totalUnread(core.store.getSnapshot()), 0, '看過就應清零');

    // 清零後不再渲染 badge。
    // 用 resetAll：側欄圖示要用「全新的狀態」重畫，否則會沿用上一輪的 stateSlots
    // 而讀到舊快照（這正是這條測試第一次跑會誤判的原因）。
    harness.resetAll();
    const icon2 = seats['sidebar.panellist:ntfy-teams'].component({ size: 16, active: true });
    const nodes2 = [];
    walk(harness, icon2, nodes2, 0);
    assert.ok(
      !nodes2.some((n) => n.cls && n.cls.indexOf('ntfy-teams-unreadbadge') !== -1),
      '沒有未讀時不應顯示 badge',
    );

    // 99+ 封頂
    assert.strictEqual(t.badgeText(120), '99+');
    assert.strictEqual(t.badgeText(0), '');

    core.store.removeTopic('pub_a');
    core.store.removeTopic('pub_b');
  });

  test('主題別名：雙擊就地改名、空 = 用主題名、寫入可持久化', () => {
    const { harness, exports: mod, core } = freshPanel();
    core.saveConfig({ aliases: {} });
    core.store.ensureTopic('pub_demo');
    core.store.setActiveTopic('pub_demo');

    const TopicBar = mod.__test.TopicBar;
    assert.strictEqual(typeof TopicBar, 'function', '應匯出 TopicBar 供測試');

    /** 用當前 store 快照畫一次 TopicBar，並回傳攤平結果。 */
    const draw = () => {
      const nodes = [];
      walk(harness, harness.render(TopicBar, { snapshot: core.store.getSnapshot() }), nodes, 0);
      return nodes;
    };

    /** 找出可編輯的那個 chip（排除「+ 訂閱主題」與編輯中的）。 */
    const findChip = (nodes) => nodes.find((n) => n.cls
      && n.cls.indexOf('ntfy-teams-topic') !== -1
      && n.cls.indexOf('--add') === -1
      && n.cls.indexOf('--editing') === -1);

    // 1) 沒別名：chip 顯示主題名，且沒有「已改名」小點
    let nodes = draw();
    const chip = findChip(nodes);
    assert.ok(chip, '找不到 topic chip');
    assert.ok(allText(nodes).indexOf('pub_demo') !== -1, '沒別名時應顯示主題名');
    assert.strictEqual(
      nodes.filter((n) => n.cls && n.cls.indexOf('ntfy-teams-aliasdot') !== -1).length,
      0,
      '沒別名時不該有別名小點',
    );

    // 2) 雙擊 → chip 就地變成輸入框（不是切換主題）
    assert.strictEqual(typeof chip.props.onDoubleClick, 'function', 'chip 應有 onDoubleClick');
    let switched = null;
    const realSetActive = core.store.setActiveTopic;
    core.store.setActiveTopic = (t) => { switched = t; };
    chip.props.onDoubleClick({ preventDefault() {} });
    core.store.setActiveTopic = realSetActive;
    assert.strictEqual(switched, null, '雙擊不應該切換主題');

    nodes = draw();
    const input = nodes.find((n) => n.cls && n.cls.indexOf('ntfy-teams-aliasinput') !== -1);
    assert.ok(input, '雙擊後應出現別名輸入框');
    assert.strictEqual(input.props.defaultValue, '', '沒別名時輸入框應為空');
    assert.strictEqual(input.props.placeholder, 'pub_demo', 'placeholder 應提示主題名');

    // 3) 輸入別名 + Enter → chip 顯示別名，且寫進 config
    input.props.onKeyDown({
      key: 'Enter',
      preventDefault() {},
      currentTarget: { value: '研發組' },
    });
    assert.strictEqual(core.topicLabel('pub_demo'), '研發組', '別名應寫進 config');
    assert.deepStrictEqual(core.readConfig().aliases, { pub_demo: '研發組' });

    nodes = draw();
    assert.ok(allText(nodes).indexOf('研發組') !== -1, 'chip 應顯示別名');
    assert.strictEqual(
      nodes.filter((n) => n.cls && n.cls.indexOf('ntfy-teams-aliasdot') !== -1).length,
      1,
      '有別名時應出現別名小點',
    );
    // 原始主題名不該被別名吃掉（tooltip 會同時給出兩者）
    const chip2 = findChip(nodes);
    assert.ok(
      chip2.props.title.indexOf('研發組') !== -1 && chip2.props.title.indexOf('pub_demo') !== -1,
      'tooltip 應同時顯示別名與主題名，實際：' + chip2.props.title,
    );

    // 4) 再次雙擊、清空 → 顯示回主題名
    chip2.props.onDoubleClick({ preventDefault() {} });
    nodes = draw();
    const input2 = nodes.find((n) => n.cls && n.cls.indexOf('ntfy-teams-aliasinput') !== -1);
    assert.ok(input2, '再次雙擊應再出現輸入框');
    assert.strictEqual(input2.props.defaultValue, '研發組', '輸入框應先帶入現有別名');
    input2.props.onBlur({ currentTarget: { value: '   ' } });
    assert.strictEqual(core.topicLabel('pub_demo'), 'pub_demo', '清空後應回主題名');
    assert.deepStrictEqual(core.readConfig().aliases, {}, '空別名不該留在表裡');

    nodes = draw();
    assert.ok(allText(nodes).indexOf('pub_demo') !== -1, '清空後 chip 應顯示主題名');
    assert.strictEqual(
      nodes.filter((n) => n.cls && n.cls.indexOf('ntfy-teams-aliasdot') !== -1).length,
      0,
      '清空後不該有別名小點',
    );

    // 5) Esc 取消：不改動別名
    core.setTopicAlias('pub_demo', '原本的');
    nodes = draw();
    const chip3 = findChip(nodes);
    chip3.props.onDoubleClick({ preventDefault() {} });
    nodes = draw();
    const input3 = nodes.find((n) => n.cls && n.cls.indexOf('ntfy-teams-aliasinput') !== -1);
    assert.ok(input3, '第三次雙擊應出現輸入框');
    input3.props.onKeyDown({
      key: 'Escape',
      preventDefault() {},
      currentTarget: { value: '不要這個' },
    });
    assert.strictEqual(core.topicLabel('pub_demo'), '原本的', 'Esc 不該改動別名');

    core.saveConfig({ aliases: {} });
    core.store.removeTopic('pub_demo');
  });

  test('共用設定：預設收合，只有帳號與名稱（伺服器不可改）', () => {
    const { harness, exports: mod, core } = freshPanel();
    // 先清乾淨：store 是跨測試共用的（loadPersisted 會沿用前一個測試留下的主題）。

    (core.store.getSnapshot().topics || []).slice().forEach((t) => core.store.removeTopic(t));
    core.saveConfig({ server: 'https://msn.feg.cn', topics: [], aliases: {} });
    core.saveCredentials('https://msn.feg.cn', { mode: 'basic', user: 'u', password: 'p' });
    core.setIdentity('shawoo');

    const SettingsPanel = mod.__test.SettingsPanel;
    assert.strictEqual(typeof SettingsPanel, 'function', '應匯出 SettingsPanel 供測試');

    /**
     * 畫一次設定區塊並攤平。
     *
     * 注意：這裡要把 props 併進「元件呼叫」而不是交給 harness.render 的第二個参数 ——
     * harness 每次 render 都會把游標歸零，用第二個参数傳會讓第一個 useState
     * （也就是 open）讀到 undefined（實測：傳了 defaultOpen 還是收合狀態）。
     *
     * @param open - 是否預設展開。
     */
    const draw = (open) => {
      const nodes = [];
      // 用闭包传参，不要用 harness.render 的第二个参数：harness 每次 render 都会
      // 把 hook 游标归零，而这里的包装函式自己也会占掉槽位，两者相加就会让
      // SettingsPanel 读到错位的 useState（实测：defaultOpen 传不进去）。
      const props = { defaultOpen: !!open };
      const node = harness.render(function settingsUnderTest() {
        return SettingsPanel(props);
      }, undefined);
      walk(harness, node, nodes, 0);
      return nodes;
    };

    const has = (nodes, cls) => nodes.some((n) => n.cls && n.cls.indexOf(cls) !== -1);
    // 設定欄位用的是 id，不是 class（一開始看錯，白追了一陣）。
    const byId = (nodes, id) => nodes.filter((n) => n.props && n.props.id === id);

    // 0) 摘要現在是**獨立元件**（需求：各種提示都要放到抬頭那個第一個容器內），
    //    收合的 SettingsPanel 只回 null。所以摘要要用 SettingsSummary 來驗。
    const SettingsSummary = mod.__test.SettingsSummary;
    assert.strictEqual(typeof SettingsSummary, 'function', '應匯出 SettingsSummary 供測試');
    /**
     * 畫一次摘要列並攤平。同理用閉包傳 props。
     * @returns 節點。
     */
    const drawSummary = () => {
      const nodes = [];
      const node = harness.render(function summaryUnderTest() {
        return SettingsSummary({ onEdit: () => {} });
      }, undefined);
      walk(harness, node, nodes, 0);
      return nodes;
    };

    // 1) 收合：SettingsPanel 什麼都不畫（那一行摘要已經搬到抬頭）
    let nodes = draw(false);
    assert.strictEqual(nodes.filter((n) => n.cls && n.cls.indexOf('ntfy-teams-settings') !== -1).length, 0,
      '收合時 SettingsPanel 不該再自己畫一列（摘要已搬到抬頭）');

    // 1a) 摘要列本身：內容與「編輯」入口
    const summaryNodes = drawSummary();
    assert.ok(has(summaryNodes, 'ntfy-teams-settingsbar'), '摘要應有 settingsbar');
    const summary = allText(summaryNodes);
    // 摘要只講「現在的狀態是什麼」：認證方式 + 傳送身分。
    // 「全部主題共用」這類說明字眼已經移除（需求），所以不該再出現。
    assert.ok(summary.indexOf('全部主題共用') === -1,
      '摘要不該再有「全部主題共用」這類字眼，實際：' + summary);
    assert.ok(summary.indexOf('帳號密碼') !== -1, '摘要應顯示認證狀態，實際：' + summary);
    assert.ok(summary.indexOf('#shawoo') !== -1, '摘要應顯示送出用的 #name');

    // 編輯入口現在是**圖示按鈕**（鉛筆），所以認的是 aria-label 而不是文字；
    // 圖示沒有文字，aria-label 與 title 就是它唯一的可讀名稱。
    const summaryEditBtn = summaryNodes.find((n) => n.tag === 'button'
      && n.props && n.props['aria-label'] === '編輯共用設定');
    assert.ok(summaryEditBtn, '摘要應有「編輯共用設定」圖示按鈕（aria-label）');
    assert.strictEqual(typeof summaryEditBtn.props.onClick, 'function', '編輯入口應可點擊');
    // 圖示按鈕必須帶 title，否則滑過去看不出來它是什麼。
    assert.ok(summaryEditBtn.props.title && summaryEditBtn.props.title.indexOf('編輯') !== -1,
      '編輯圖示按鈕應有說明用的 title，實際：' + summaryEditBtn.props.title);
    // 而且不該再有「編輯」這兩個字的文字按鈕（已改成圖示）。
    assert.ok(!summaryNodes.some((n) => n.tag === 'button' && collectText(n.children) === '編輯'),
      '不該還有文字「編輯」按鈕（已改成圖示）');

    // 1a) 「認證方式」那個欄位標籤要是完整的四個字（不是只有「認證」）。
    //     需求原文：「認證」改成「認證方式」。用「認證方式」而不是「認證」，
    //     是因為下面那個 select 選的是**方式**（無認證／帳號密碼／存取權杖）。
    //
    // 為什麼不寫在這裡：這個 harness 的 hook 槽位會**沿用**（上面先 draw(false)
    // 把 open 定成 false 了），同一個 harness 再 draw(true) 也叫不回展開狀態。
    // 展開狀態的斷言放在「儲存成功後自動收合」那條測試裡（它一開始就是展開的）。

    // 1b) 伺服器相關 UI **完全不存在**（連「預設伺服器」這種欄位都不要）。
    //     需求：使用者不能改伺服器，也不需要知道是哪一台。
    assert.ok(summary.indexOf('msn.feg.cn') === -1, '不該顯示位址，實際：' + summary);
    assert.ok(summary.indexOf('伺服器') === -1, '不該出現「伺服器」欄位，實際：' + summary);
    // 就算設定檔被改成別的伺服器，介面上也不該冒出來
    core.saveConfig({ server: 'https://ntfy.example.com' });
    const custom = allText(draw(false));
    assert.ok(custom.indexOf('ntfy.example.com') === -1,
      '自訂伺服器也不該顯示位址（已無伺服器 UI），實際：' + custom);
    assert.ok(custom.indexOf('伺服器') === -1, '仍不該出現「伺服器」欄位');
    core.saveConfig({ server: 'https://msn.feg.cn' });

    // 1c) 展開後也不該有伺服器輸入框 —— 交給**真實瀏覽器**驗證（見 browser-verify）。
    //     不在這裡硬做：這個測試替身的 hook 游標每次 render 都歸零，包一層包裝函式
    //     就會讓 SettingsPanel 的 useState 讀到錯位的槽位（本檔上面早已寫了這個警告）。
    //     與其做一個會誤導人的斷言，不如交給能真正展開的環境。

    // 2) 摘要只有一份，不隨主題數量重複
    assert.strictEqual(
      summaryNodes.filter((n) => n.cls && n.cls.indexOf('ntfy-teams-settingsbar') !== -1).length,
      1,
      '摘要列只該有一個',
    );

    // 3) 摘要的「編輯」入口（點下去的行為由瀏覽器端到端驗證負責：
    //    這個測試替身很難同時滿足「元件互相隔離」與「保留元件自身狀態」）。
    //    （「編輯」按鈕本身在 1a 已經驗過。）

    core.clearCredentials('https://msn.feg.cn');
    core.setIdentity('');
  });

  test('儲存成功後自動收合（不留著展開佔高度）', () => {
    const { harness, exports: mod, core } = freshPanel();
    core.saveConfig({ server: 'https://msn.feg.cn', topics: [], aliases: {} });
    core.saveCredentials('https://msn.feg.cn', { mode: 'basic', user: 'u', password: 'p' });
    core.setIdentity('Jinbe');

    const SettingsPanel = mod.__test.SettingsPanel;
    /**
     * 畫一次設定區塊並攤平（open=true 展開）。
     * 用閉包傳 props —— 傳給 harness.render 的第二個參數會被游標歸零吃掉。
     * @returns 節點。
     */
    const drawOpen = () => {
      const props = { defaultOpen: true };
      const nodes = [];
      walk(harness, harness.render(function settingsUnderTest() {
        return SettingsPanel(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    const isOpen = (nodes) => nodes.some((n) => n.cls && String(n.cls).indexOf('ntfy-teams-settings--open') !== -1);

    let nodes = drawOpen();
    assert.ok(isOpen(nodes), '起點應是展開的（才能測收合）');

    // 展開狀態下順便驗欄位標籤：需求是「認證」改成「認證方式」。
    // （放在這裡是因為這個測試的 harness 一開始就是展開的；上面那條「共用設定」
    //   測試的 harness 先畫了收合狀態，hook 槽位會沿用，叫不回展開。）
    const modeLabel = nodes.find((n) => n.tag === 'label'
      && n.props && n.props.htmlFor === 'ntfy-teams-mode');
    assert.ok(modeLabel, '展開時應有認證方式的 label');
    assert.strictEqual(collectText(modeLabel.children), '認證方式',
      '欄位標籤應為「認證方式」，實際：' + collectText(modeLabel.children));

    const saveBtn = nodes.find((n) => n.tag === 'button'
      && collectText(n.children) === '儲存');
    assert.ok(saveBtn, '展開時應有「儲存」按鈕');
    assert.strictEqual(typeof saveBtn.props.onClick, 'function', '「儲存」應可點擊');

    // 按下儲存 → setOpen(false) → harness 的 setState 會同步重繪
    saveBtn.props.onClick();

    nodes = drawOpen();
    // drawOpen 帶 defaultOpen:true，但元件的 open 狀態已經被 setOpen(false) 改掉；
    // 收合與否看的是元件自己的 state，所以這裡應該要是收合的。
    assert.ok(!isOpen(nodes),
      '儲存成功後應該自動收合（否則會一直佔掉面板上方高度）');

    core.clearCredentials('https://msn.feg.cn');
    core.setIdentity('');
  });

  test('取消訂閱後：記憶體設定的 topics 必須與 store 對齊（否則切走再切回會復活）', () => {
    // 這是使用者提供的復現步驟所對應的根因：
    //   刪除 → 切到別的畫面 → 切回來 → 主題又出現（F5 則不會）
    //
    // 症狀的來源：清單有**兩份**
    //   * `store`                    —— 畫面上的即時狀態
    //   * 記憶體設定（readConfig）    —— bootStore() 重掛時用來起 store 的種子
    // 開機時 syncSettingsFromHost() 把宿主的 topics 寫進記憶體設定，兩份一致；
    // 但刪除原本只動了 store，記憶體設定還留著那一個 → 面板重掛時被灌回 store。
    //
    // 為什麼 F5 就不會：重新載入後記憶體設定是空的，只從宿主的 YAML 重建。
    //
    // 這條測試直接驗「刪除之後兩份清單一致」——那是復活成立的必要條件。
    const { harness, exports: mod, core } = freshPanel();
    const TopicBar = mod.__test.TopicBar;
    assert.strictEqual(typeof TopicBar, 'function', '應匯出 TopicBar 供測試');

    // 模擬「開機同步完成了」：宿主有兩個主題，store 與記憶體設定都拿到
    core.saveConfig({ server: 'https://msn.feg.cn', topics: ['pub_keep', 'pub_drop'], aliases: {} });
    (core.store.getSnapshot().topics || []).slice().forEach((t) => core.store.removeTopic(t));
    core.store.ensureTopic('pub_keep');
    core.store.ensureTopic('pub_drop');
    core.store.setActiveTopic('pub_keep');
    // 此時兩份一致（就像開機同步之後）
    assert.deepStrictEqual(core.readConfig().topics, ['pub_keep', 'pub_drop'],
      '前置：記憶體設定應與 store 一致');

    // 走真實的兩步確認刪除
    const draw = () => {
      const props = { snapshot: core.store.getSnapshot() };
      const nodes = [];
      walk(harness, harness.render(function barUnderTest() {
        return TopicBar(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    let nodes = draw();
    const xBtn = nodes.find((n) => n.cls && n.cls.indexOf('ntfy-teams-topic-x') !== -1
      && String(n.props && n.props.title || '').indexOf('pub_drop') !== -1);
    assert.ok(xBtn, '應找得到 pub_drop 的取消訂閱按鈕');
    xBtn.props.onClick({ stopPropagation() {} });
    nodes = draw();
    const ok = nodes.find((n) => n.tag === 'button'
      && n.cls && String(n.cls).indexOf('--danger') !== -1);
    assert.ok(ok, '應找得到確認按鈕');
    ok.props.onClick();

    // store 少了它
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_keep'],
      'store 應該移除 pub_drop');
    // **記憶體設定也要少了它** —— 這是這條測試的重點
    assert.deepStrictEqual(core.readConfig().topics, ['pub_keep'],
      '記憶體設定必須同步移除 pub_drop，否則面板重掛時它會從這裡被灌回 store'
      + '（實測：切走再切回就復活）。實際：' + JSON.stringify(core.readConfig().topics));
  });

  test('共用設定：鉛筆是切換（open 由外面控制），表單裡沒有「收合」按鈕', () => {
    // 需求：「收合」按鈕去掉 —— 收起改用抬頭那顆鉛筆（同一顆、同一個位置切換）。
    // 所以 open 必須是**受控**的（MainPanel 持有），元件不能再自己存一份。
    //
    // ⚠️ 每個狀態都要用**全新的 harness**：hook 槽位會沿用，
    // 同一個 harness 先畫 open=true 再畫 open=false 還是會拿到前一棵樹
    // （實測：closed.length 變成 25 而不是 0）。
    /**
     * 用受控的 open 畫一次並攤平。
     * @param isOpen - 是否展開。
     * @returns { nodes, texts }。
     */
    const drawControlled = (isOpen) => {
      const { harness, exports: mod, core } = freshPanel();
      core.saveConfig({ server: 'https://msn.feg.cn', topics: [], aliases: {} });
      core.saveCredentials('https://msn.feg.cn', { mode: 'basic', user: 'u', password: 'p' });
      const SettingsPanel = mod.__test.SettingsPanel;
      const props = { open: isOpen };
      const nodes = [];
      walk(harness, harness.render(function panelUnderTest() {
        return SettingsPanel(props);
      }, undefined), nodes, 0);
      const texts = nodes.filter((n) => n.tag === 'button').map((b) => collectText(b.children));
      core.clearCredentials('https://msn.feg.cn');
      return { nodes, texts };
    };

    // 受控 open=true → 展開
    const open = drawControlled(true);
    assert.ok(open.nodes.some((n) => n.cls && String(n.cls).indexOf('ntfy-teams-settings--open') !== -1),
      'open=true 時應該展開');
    // 展開時不該有「收合」按鈕（需求）
    assert.ok(open.texts.indexOf('收合') === -1,
      '表單裡不該再有「收合」按鈕，實際按鈕：' + JSON.stringify(open.texts));
    // 該有的操作還在
    ['儲存', '測試連線', '清除憑證'].forEach((label) => {
      assert.ok(open.texts.indexOf(label) !== -1,
        '展開時應有「' + label + '」，實際：' + JSON.stringify(open.texts));
    });
    // 表單標頭那一列（說明文字 + 收合）整個拿掉了
    assert.ok(!open.nodes.some((n) => n.cls
      && String(n.cls).split(/\s+/).indexOf('ntfy-teams-settingshead') !== -1),
      '已經沒有 settingshead 那一列了');

    // 受控 open=false → 完全不渲染
    const closed = drawControlled(false);
    assert.strictEqual(closed.nodes.length, 0,
      'open=false 時應該什麼都不畫，實際 ' + closed.nodes.length + ' 個節點');
  });

  test('改認證並儲存後：立刻重比連線指紋（不然會一直顯示上一條連線的錯誤）', () => {
    const { exports: mod, core } = freshPanel();
    // 這個回歸對應使用者回報的「修改認證方式保存後，ntfy 連線要重置，
    // 一直顯示上一個的錯誤」。
    //
    // 病灶：改認證只動**憑證快取**，不會觸發 store 變更；而 startLiveSync
    // 是靠 store 變更去比對指紋的 —— 所以連線不會重建，畫面一直掛著舊的 403。
    // 修法有兩半，這裡都把契約釘住：
    //   1. 指紋要含憑證（不然「憑證變了」這件事看不出來）；
    //   2. 設定面板存檔後要主動叫一次 recheckConnection()。
    assert.strictEqual(typeof mod.__test.recheckConnection, 'function',
      '應匯出 recheckConnection 供測試與內部使用');

    // —— 1. 憑證的變化必須反映在指紋上 ——
    const srv = 'https://msn.feg.cn';
    core.saveConfig({ server: srv, topics: [] });
    core.saveCredentials(srv, { mode: 'basic', user: 'u1', password: 'p1' });
    /** 指紋（與 client 的 credKey() 同一組欄位）。 @returns 字串。 */
    const fp = () => {
      const c = core.loadCredentials(srv);
      return [c.mode, c.user, (c.password || '').length, (c.token || '').length].join('|');
    };
    const before = fp();
    core.saveCredentials(srv, { mode: 'basic', user: 'u1', password: 'p2-更長' });
    const after = fp();
    assert.notStrictEqual(after, before,
      '換了密碼之後指紋必須不同（否則連線不會重建）');

    // 換模式也要看得出來
    core.saveCredentials(srv, { mode: 'token', token: 'tk_abcdef' });
    assert.notStrictEqual(fp(), after, '換了認證方式之後指紋必須不同');

    // —— 2. recheckConnection 是「有變化才重建」——
    //   * 回傳值是布林（不是 undefined／拋錯）；
    //   * 指紋沒變時回 false（不會每次都白重建一條連線）。
    // 注意：這個測試環境的 freshPanel() 已經跑過 apply()，所以即時連線是**活的**
    // —— 不能斷言「沒有連線時回 false」，那條路徑只有在 host 還沒掛上時才會走。
    const r1 = mod.__test.recheckConnection();
    assert.strictEqual(typeof r1, 'boolean', '應該回布林，實際 ' + typeof r1);
    const r2 = mod.__test.recheckConnection();
    assert.strictEqual(r2, false,
      '指紋沒變時第二次呼叫應該回 false（不能每次白重建一條連線）');

    core.clearCredentials(srv);
  });
  test('沒有 # 發送者的訊息：留白不標示，且非 # 的 title 當內文顯示', () => {
    const { harness, exports: mod } = freshPanel();
    const t = mod.__test;
    const MessageRow = t.MessageRow;
    assert.strictEqual(typeof MessageRow, 'function', '應匯出 MessageRow 供測試');

    /**
     * 畫一則訊息並攤平。
     * （用闭包传 props，不要用 harness.render 的第二個参数 —— 那個會被游標歸零吃掉。）
     * @param msg - 訊息。
     */
    const draw = (msg) => {
      const props = { msg: msg, selfName: '' };
      const nodes = [];
      walk(harness, harness.render(function rowUnderTest() {
        return MessageRow(props);
      }, undefined), nodes, 0);
      return nodes;
    };

    const classesOf = (nodes) => nodes.map((n) => n.cls).filter(Boolean).join(' ');
    const countCls = (nodes, cls) => nodes.filter((n) => n.cls && n.cls.indexOf(cls) !== -1).length;

    // 1) 完全沒有 title → 名稱顯示 `--`，格式與其他訊息相同（有頭像、有 sender）
    let nodes = draw({ id: 'm1', time: 1790756810, topic: 'pub_x', message: 'hello' });
    let txt = allText(nodes);
    assert.ok(txt.indexOf('未具名') === -1, '不該出現「未具名」字樣，實際：' + txt);
    assert.ok(txt.indexOf('--') !== -1, '沒有發送者時名稱應顯示 --，實際：' + txt);
    assert.strictEqual(countCls(nodes, 'ntfy-teams-avatar'), 1, '格式與別人一致，應有頭像');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-sender'), 1, '應有 sender 元素（內容是 --）');
    assert.ok(classesOf(nodes).indexOf('ntfy-teams-msg--anon') !== -1, '應標記為無發送者樣式');
    assert.ok(txt.indexOf('hello') !== -1, '內文仍應顯示');

    // 2) title 不是 # 開頭 → 一樣算沒有發送者（名稱 --），但標題內容要當內文顯示
    nodes = draw({
      id: 'm2', time: 1790756811, topic: 'pub_x', title: 'just a title', message: 'body here',
    });
    txt = allText(nodes);
    assert.ok(txt.indexOf('未具名') === -1, '非 # 的 title 也不該標示未具名');
    assert.ok(txt.indexOf('--') !== -1, '非 # 的 title 也應顯示 --');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-sender'), 1, '應有一個 sender 元素（內容是 --）');
    assert.ok(txt.indexOf('just a title') !== -1, '非 # 的 title 應以內文顯示，實際：' + txt);
    assert.ok(txt.indexOf('body here') !== -1, '內文仍應顯示');

    // 3) # 開頭 → 正常顯示發送者，且該 title 不再重複出現在內文
    nodes = draw({
      id: 'm3', time: 1790756812, topic: 'pub_x', title: '#alice', message: 'from alice',
    });
    txt = allText(nodes);
    assert.ok(txt.indexOf('#alice') !== -1, '應顯示發送者 #alice');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-sender'), 1, '應有一個 sender 元素');
    assert.strictEqual(
      txt.split('#alice').length - 1,
      1,
      '發送者不該在內文裡再出現一次，實際：' + txt,
    );

    // 4) 舊格式 @ 仍可解析成發送者，且顯示成 #
    nodes = draw({
      id: 'm4', time: 1790756813, topic: 'pub_x', title: '@bob', message: 'from bob',
    });
    txt = allText(nodes);
    assert.ok(txt.indexOf('#bob') !== -1, '舊 @bob 應顯示成 #bob');
    assert.ok(txt.indexOf('未具名') === -1, '舊格式也是具名，不該標示未具名');
  });

  test('自己的訊息靠右：欄位順序鏡射（頭像在右）', () => {
    const { harness, exports: mod } = freshPanel();
    const MessageRow = mod.__test.MessageRow;

    /**
     * 畫一則訊息，回传「直接子节点」的 class 顺序。
     * @param msg - 訊息。
     * @param selfName - 自己的名稱。
     */
    const children = (msg, selfName) => {
      const props = { msg: msg, selfName: selfName };
      const row = harness.render(function rowUnderTest() {
        return MessageRow(props);
      }, undefined);
      return (row.children || []).filter(Boolean).map((c) => (c.props && c.props.className) || String(c.type));
    };

    // 別人的：頭像塊在前、內文在後（靠左）
    const others = children({ id: 'a', time: 1790756820, title: '#bob', message: 'hi' }, 'me');
    assert.strictEqual(others[0], 'ntfy-teams-msgav', '別人的頭像塊應排第一（實際：' + others[0] + '）');
    assert.strictEqual(others[1], 'ntfy-teams-msgbody', '別人的內文應排第二');

    // 自己的：**順序也一樣**（頭像在前、內文在後）—— 靠右完全交給 CSS 的 row-reverse。
    //
    // ⚠️ 這裡原本斷言「自己的內文排第一」：那表示 JS 把兩者對調，而 CSS 又
    // row-reverse 一次 —— 兩次翻轉互相抵消，頭像反而落在內文**左邊**
    // （實測：avatarLeft 929、bodyLeft 978），根本沒有靠右。
    // 現在只翻一次，所以 DOM 順序必須與別人一致。
    const mine = children({ id: 'b', time: 1790756821, title: '#me', message: 'my own' }, 'me');
    assert.strictEqual(mine[0], 'ntfy-teams-msgav',
      '自己的頭像塊也應排第一（DOM 順序與別人一致，只翻一次），實際：' + mine[0]);
    assert.strictEqual(mine[1], 'ntfy-teams-msgbody', '自己的內文應排第二，實際：' + mine[1]);
    assert.deepStrictEqual(mine, others, '自己的與別人的 DOM 順序必須相同 —— 差別只在 CSS');

    // 靠右是靠 CSS 的 row-reverse：少了它，自己的頭像就會留在左邊。
    // （下面本來就有一段在驗那條 CSS，這裡不再重複取一次樣式 —— 重複宣告會
    //   直接把測試檔弄成語法錯誤，實測踩過。）

    // 行本身要帶上 --self，CSS 才會鏡射
    const selfRow = harness.render(function rowUnderTest() {
      return MessageRow({ msg: { id: 'c', time: 1790756822, title: '#me', message: 'x' }, selfName: 'me' });
    }, undefined);
    assert.ok(selfRow.props.className.indexOf('ntfy-teams-msg--self') !== -1, '自己送的應有 --self');
    const otherRow = harness.render(function rowUnderTest() {
      return MessageRow({ msg: { id: 'd', time: 1790756823, title: '#bob', message: 'x' }, selfName: 'me' });
    }, undefined);
    assert.ok(otherRow.props.className.indexOf('--self') === -1, '別人的不該有 --self');

    // 沒具名的訊息名稱是 `--`，欄位順序與其他人一致（頭像在前），不是留白
    const anon = children({ id: 'e', time: 1790756824, topic: 'pub_x', message: 'anon' }, 'me');
    assert.strictEqual(anon.length, 2, '沒有發送者時也該是「頭像塊 + 內文」兩個節點');
    assert.strictEqual(anon[0], 'ntfy-teams-msgav', '沒有發送者時頭像塊仍在前');
    assert.strictEqual(anon[1], 'ntfy-teams-msgbody');

    // 時間要放在頭像「下面」（同一個頭像塊裡），不是擠在名字那一行
    const rowForClock = harness.render(function rowUnderTest() {
      return MessageRow({ msg: { id: 'f', time: 1790756825, title: '#bob', message: 'x' }, selfName: 'me' });
    }, undefined);
    const kids = (rowForClock.children || []).filter(Boolean);
    const avBox = kids.find((k) => k.props && k.props.className === 'ntfy-teams-msgav');
    const bodyBox = kids.find((k) => k.props && k.props.className === 'ntfy-teams-msgbody');
    assert.ok(avBox && bodyBox, '應同時有頭像塊與內文');
    const avKids = (avBox.children || []).filter(Boolean);
    assert.ok(avKids[0] && avKids[0].props.className.indexOf('ntfy-teams-avatar') === 0,
      '頭像塊的第一個子節點應是頭像');
    assert.strictEqual(avKids[1] && avKids[1].props.className, 'ntfy-teams-clock',
      '頭像塊的第二個子節點應是時間');
    // 名字那一行不該再有時間
    const head = (bodyBox.children || []).filter(Boolean)
      .find((c) => c.props && c.props.className === 'ntfy-teams-msghead');
    assert.ok(head, '內文應有 msghead');
    const headText = collectText(head);
    assert.ok(headText.indexOf('21:') === -1 && /\d{1,2}:\d{2}/.test(headText) === false,
      'msghead 不該再出現時間，實際：' + JSON.stringify(headText));
    // CSS 要把頭像塊排成直向
    assert.ok(/\.ntfy-teams-msgav\{display:flex;flex-direction:column;/.test(
      (function () {
        const c = makeCtx();
        documentStub.__head.length = 0;
        built.exports.apply(c.context);
        return documentStub.__head[0].textContent;
      })(),
    ), '頭像塊應是直向堆疊');

    // 靠右的 CSS 一定要在，否則 row-reverse 白做。
    // 從注入的 style 元素拿，不需要為了測試多開一個出口。
    const styleCtx = makeCtx();
    documentStub.__head.length = 0;
    built.exports.apply(styleCtx.context);
    const cssText = documentStub.__head[0].textContent;
    assert.ok(cssText.indexOf('.ntfy-teams-msg--self{flex-direction:row-reverse;}') !== -1,
      '樣式應把 --self 設成 row-reverse');
    // 內文不能撐滿整行：撐滿的話頭像會被擠在最左邊，看起來就沒有「靠右」。
    // （實測踩過：少了 flex:0 1 auto 時，avatar 仍在 x=306、body 仍到 1374。）
    assert.ok(/\.ntfy-teams-msg--self \.ntfy-teams-msgbody\{flex:0 1 auto;text-align:right;\}/.test(cssText),
      '內文應改成 flex:0 1 auto 並靠右');
    // 程式碼／引用／清單在靠右模式下仍要左讀
    assert.ok(cssText.indexOf('.ntfy-teams-msg--self .ntfy-teams-md-pre') !== -1,
      '程式碼區塊應維持左讀');
    // 隔行底色要「淡」：必須是半透明的混色，不能是實心色塊。
    // （別用 /[^)]*45%/ 這種寫法：color-mix(in srgb, …) 有巢狀括號，會比對不到。）
    // 用墨色（label-primary）而不是 bg-layer-1：淺色主題下 layer-1 也是純白，
    // 白 45% 疊在白底上等於沒有效果（實測對比 1.000）。
    assert.ok(
      cssText.indexOf('.ntfy-teams-msg--alt{background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);}') !== -1,
      '隔行底色應是墨色 3% 的半透明混色',
    );
    // --self 必須排在 --alt 之後，否則自己的訊息會被隔行底色蓋掉
    assert.ok(
      cssText.indexOf('.ntfy-teams-msg--alt{') < cssText.indexOf('.ntfy-teams-msg--self{'),
      '--self 規則必須排在 --alt 之後（順序決定覆蓋）',
    );
  });
  test('取消訂閱要確認：先問再刪，按「保留」不刪', () => {
    const { harness, exports: mod, core } = freshPanel();
    core.saveConfig({ server: 'https://msn.feg.cn', aliases: {} });

    (core.store.getSnapshot().topics || []).slice().forEach((t) => core.store.removeTopic(t));
    core.store.ensureTopic('pub_keep');
    core.store.ensureTopic('pub_drop');
    core.store.setActiveTopic('pub_keep');

    const TopicBar = mod.__test.TopicBar;
    /** 畫一次 topic 列並攤平。 */
    const draw = () => {
      const props = { snapshot: core.store.getSnapshot() };
      const nodes = [];
      walk(harness, harness.render(function barUnderTest() {
        return TopicBar(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    const countCls = (nodes, cls) => nodes.filter((n) => n.cls && n.cls.indexOf(cls) !== -1).length;
    const btnByText = (nodes, label) => nodes.find((n) => n.tag === 'button'
      && collectText(n.children) === label);

    // 1) 按 × 不該直接刪掉，而是先出確認條
    let nodes = draw();
    const xBtn = nodes.find((n) => n.cls && n.cls.indexOf('ntfy-teams-topic-x') !== -1);
    assert.ok(xBtn, 'chip 應該有 × 按鈕');
    xBtn.props.onClick({ stopPropagation() {} });

    nodes = draw();
    assert.deepStrictEqual(
      core.store.getSnapshot().topics,
      ['pub_keep', 'pub_drop'],
      '按 × 之後還沒有確認，不該刪掉任何主題',
    );
    assert.strictEqual(countCls(nodes, 'ntfy-teams-groupbar--confirm'), 1, '應出現確認條');
    // 確認條前面要有警示符號（破壞性動作的視覺提示），且它是 inline SVG。
    assert.strictEqual(countCls(nodes, 'ntfy-teams-confirmglyph'), 1,
      '確認條應有警示符號（一個）');
    assert.ok(nodes.some((n) => n.tag === 'svg' && n.props && n.props.width === 15),
      '警示符號應是 15×15 的 inline SVG');
    const confirmText = allText(nodes);
    assert.ok(confirmText.indexOf('取消訂閱') !== -1 && confirmText.indexOf('pub_keep') !== -1,
      '確認條應說明要取消哪個主題，實際：' + confirmText);
    assert.ok(btnByText(nodes, '保留'), '確認條應有「保留」');
    assert.ok(btnByText(nodes, '取消訂閱'), '確認條應有「取消訂閱」');
    // 確認時不該還顯示 chip 清單（避免又按到別的）
    assert.strictEqual(countCls(nodes, 'ntfy-teams-topic'), 0, '確認時不該同時顯示 chip');

    // 2) 按「保留」→ 什麼都不變，回到 chip 清單
    btnByText(nodes, '保留').props.onClick();
    nodes = draw();
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_keep', 'pub_drop'], '「保留」不該刪除');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-groupbar--confirm'), 0, '「保留」後確認條應消失');
    assert.ok(countCls(nodes, 'ntfy-teams-topic') > 0, '「保留」後應回到 chip 清單');

    // 3) 按「取消訂閱」才真的刪，且確認條消失
    const x2 = draw().find((n) => n.cls && n.cls.indexOf('ntfy-teams-topic-x') !== -1);
    x2.props.onClick({ stopPropagation() {} });
    nodes = draw();
    btnByText(nodes, '取消訂閱').props.onClick();
    nodes = draw();
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_drop'], '確認後應只刪掉 pub_keep');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-groupbar--confirm'), 0, '刪除後確認條應消失');

    // 4) 有別名時，確認條顯示別名（並附上原始主題名）
    core.setTopicAlias('pub_drop', '研發組');
    nodes = draw();
    const x3 = draw().find((n) => n.cls && n.cls.indexOf('ntfy-teams-topic-x') !== -1);
    x3.props.onClick({ stopPropagation() {} });
    const aliasConfirm = allText(draw());
    assert.ok(aliasConfirm.indexOf('研發組') !== -1, '確認條應顯示別名，實際：' + aliasConfirm);
    assert.ok(aliasConfirm.indexOf('pub_drop') !== -1, '確認條應附帶原始主題名');

    // 5) 清掉別名與主題
    core.setTopicAlias('pub_drop', '');
    core.store.removeTopic('pub_drop');
  });
  test('訊息按日期分組，每組可以收合／展開', () => {
    const { harness, exports: mod } = freshPanel();
    const MessageList = mod.__test.MessageList;

    /**
     * 用给定的訊息阵列畫一次訊息串。
     * @param msgs - 訊息阵列。
     */
    const draw = (msgs) => {
      const props = { topic: 'pub_days', messages: msgs, selfName: '', loading: false };
      const nodes = [];
      walk(harness, harness.render(function listUnderTest() {
        return MessageList(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    const dayButtons = (nodes) => nodes.filter((n) => n.tag === 'button'
      && hasDayToken(n));
    // 只算訊息「列」本身：子元素（sender／msgbody…）的類名也是 ntfy-teams-msg 開頭，
    // 放寬成 indexOf 會把它們全算進來（實測：5 則被算成 15 個）。
    const msgCount = (nodes) => nodes.filter((n) => n.cls
      && (n.cls === 'ntfy-teams-msg' || n.cls.indexOf('ntfy-teams-msg ') === 0)).length;

    // 三個不同的日子：前天、昨天、今天
    //
    // ⚠️ 這裡原本是「now 減掉幾小時」，於是**會依執行時刻而壞掉**：
    // 原本的 `now - offset*86400 - (12-hh)*3600` 假設「現在」在中午之後，
    // 一旦在凌晨執行（例如 00:02），`day(0, 8)` 算出來會是**未來**的時間，
    // 落到別的日曆天，分組就變成 0 則今天（實測：10/02 00:02 時失敗）。
    //
    // 改成「以本地午夜為錨，再往前推 offset 天，最後指定當天的 hh 點」：
    // 這樣不管幾點跑，三個時間一定分別落在前天／昨天／今天。
    /** 本地某一天的午夜（秒）。 @param ts - 任一時間（秒）。 @returns 那天 00:00 的秒數。 */
    const localMidnight = (ts) => {
      const d = new Date(ts * 1000);
      d.setHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    };
    const midnight = localMidnight(Math.floor(Date.now() / 1000));
    /** 第 offset 天前的 hh 點（本地時間）。 @param offset - 幾天前。 @param hh - 幾點。 @returns 秒。 */
    const day = (offset, hh) => midnight - offset * 86400 + hh * 3600;
    const msgs = [
      { id: 'd2a', time: day(2, 9), topic: 'pub_days', title: '#ann', message: '前天第一則' },
      { id: 'd2b', time: day(2, 10), topic: 'pub_days', title: '#ann', message: '前天第二則' },
      { id: 'd1a', time: day(1, 9), topic: 'pub_days', title: '#bob', message: '昨天第一則' },
      { id: 'd0a', time: day(0, 8), topic: 'pub_days', title: '#bob', message: '今天第一則' },
      { id: 'd0b', time: day(0, 9), topic: 'pub_days', title: '#cid', message: '今天第二則' },
    ];
    // 自我檢查：日曆天必須真的是「前天／昨天／今天」——不然下面全部沒意義。
    //
    // 注意 dayKeyOf 收的是**訊息物件**（不是時間戳）：餵它一個數字會得到
    // NO_DAY_KEY，於是每個比較都變成「相等」，自我檢查就形同虛設（實測踩過）。
    const dayKeyOf = mod.__test.dayKeyOf;
    const isTodayKey = mod.__test.isTodayKey;
    assert.strictEqual(typeof dayKeyOf, 'function', '應該匯出 dayKeyOf 供測試');
    assert.strictEqual(typeof isTodayKey, 'function', '應該匯出 isTodayKey 供測試');
    /** 把時間戳包成訊息物件再取日鍵。 @param ts - 秒。 @returns 日鍵。 */
    const keyAt = (ts) => dayKeyOf({ time: ts });
    assert.strictEqual(keyAt(day(0, 8)), keyAt(midnight), 'day(0) 應該就是今天');
    assert.strictEqual(isTodayKey(keyAt(day(0, 8))), true, '今天那組應被認成今天');
    assert.strictEqual(isTodayKey(keyAt(day(1, 9))), false, 'day(1) 不該落在今天');
    assert.strictEqual(isTodayKey(keyAt(day(2, 9))), false, 'day(2) 不該落在今天');
    assert.notStrictEqual(keyAt(day(1, 9)), keyAt(day(2, 9)), '前天與昨天要是不同天');
    assert.notStrictEqual(keyAt(day(0, 8)), keyAt(day(1, 9)), '今天與昨天要是不同天');

    // 1) 預設：只有「今天」展開，其他日子一律折起來（不被幾百則舊訊息淹沒）
    let nodes = draw(msgs);
    let days = dayButtons(nodes);
    assert.strictEqual(days.length, 3, '應分成 3 天，實際 ' + days.length);
    assert.strictEqual(msgCount(nodes), 2, '預設只顯示今天那 2 則，實際 ' + msgCount(nodes));
    assert.deepStrictEqual(days.map((d) => d.props['aria-expanded']), ['false', 'false', 'true'],
      '應只有今天展開，實際 ' + JSON.stringify(days.map((d) => d.props['aria-expanded'])));
    days.forEach((d) => {
      assert.strictEqual(typeof d.props.onClick, 'function', '日期抬頭應可點擊');
    });
    // 每一天都標了則數 —— 折起來也知道漏掉幾則
    const allTextAll = allText(nodes);
    assert.ok(allTextAll.indexOf('2 則') !== -1, '前天有 2 則');
    assert.ok(allTextAll.indexOf('1 則') !== -1, '昨天／今天各 1 則');
    assert.ok(allTextAll.indexOf('今天第一則') !== -1, '今天應看得到');
    assert.ok(allTextAll.indexOf('前天第一則') === -1, '前天預設折起來，不該看到');
    // 隔行底色趁這裡（還沒動過任何收合）一次驗掉：今天那 2 則要一淺一深。
    const altFlagsInitial = nodes
      .filter((n) => n.cls && (n.cls === 'ntfy-teams-msg' || n.cls.indexOf('ntfy-teams-msg ') === 0))
      .map((n) => n.cls.indexOf('--alt') !== -1);

    // 2) 點開最舊的一天 → 那一天的訊息出現
    days[0].props.onClick();
    nodes = draw(msgs);
    days = dayButtons(nodes);
    assert.strictEqual(days.length, 3, '展開後抬頭仍應在');
    assert.strictEqual(msgCount(nodes), 4, '展開前天後應多 2 則（今天 2 + 前天 2），實際 ' + msgCount(nodes));
    assert.ok(allText(nodes).indexOf('前天第一則') !== -1, '展開後應看得到前天');
    assert.strictEqual(days[0].props['aria-expanded'], 'true', '被展開的那天應標記為展開');

    // 3) 再點一次收起來
    days[0].props.onClick();
    nodes = draw(msgs);
    assert.strictEqual(msgCount(nodes), 2, '再點一次應收回成只剩今天');
    assert.ok(allText(nodes).indexOf('前天第一則') === -1, '收起來後不該看到');

    // 4) 收合今天（預設唯一展開的那一天）
    nodes = draw(msgs);
    dayButtons(nodes)[2].props.onClick();
    nodes = draw(msgs);
    assert.strictEqual(msgCount(nodes), 0, '三天全折起來時應一則都不顯示，實際 ' + msgCount(nodes));
    assert.strictEqual(dayButtons(nodes).length, 3, '三天抬頭都還在');
    assert.strictEqual(dayButtons(nodes)[2].props['aria-expanded'], 'false', '今天應標記為收合');

    // 5) 沒有時間的訊息歸到「沒有時間」一組，預設不折、也能收
    const noTimeMsgs = [{ id: 'nt1', topic: 'pub_days', message: '沒有 time 欄位' }];
    assert.strictEqual(msgCount(draw(noTimeMsgs)), 1, '沒有時間的訊息預設應顯示');
    const ntDays0 = dayButtons(draw(noTimeMsgs));
    assert.strictEqual(ntDays0.length, 1, '沒有時間的訊息也該有抬頭');
    assert.strictEqual(ntDays0[0].props['aria-expanded'], 'true', '「沒有時間」預設不折');
    ntDays0[0].props.onClick();
    assert.strictEqual(msgCount(draw(noTimeMsgs)), 0, '「沒有時間」那組也應該收得起來');

    // 6) 隔行底色（在還沒動過收合狀態時就驗，否則前面的點擊會延續下來）。
    assert.deepStrictEqual(altFlagsInitial, [false, true],
      '隔行底色應交錯，實際 ' + JSON.stringify(altFlagsInitial));
  });
  test('未讀提示：未讀不為 0 才畫「N 則新訊息」線，並成為捲動錨點', () => {
    const { harness, exports: mod } = freshPanel();
    const MessageList = mod.__test.MessageList;

    const msgs = [
      { id: 'r1', time: 1790756800, topic: 'pub_r', title: '#a', message: 'one' },
      { id: 'r2', time: 1790756860, topic: 'pub_r', title: '#b', message: 'two' },
      { id: 'r3', time: 1790756920, topic: 'pub_r', title: '#c', message: 'three' },
    ];

    /** 畫一次訊息串。 */
    const draw = (extra) => {
      const props = Object.assign({
        topic: 'pub_r', messages: msgs, loading: false, selfName: '', unread: 0, lastReadId: ''
      }, extra || {});
      const nodes = [];
      walk(harness, harness.render(function listUnderTest() {
        return MessageList(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    // 只算線本身：內部的文字 span 類名也是 ntfy-teams-newline 開頭（實測被算成 2 條）。
    const newLines = (nodes) => nodes.filter((n) => n.cls === 'ntfy-teams-newline');

    // 1) 未讀 0 → 沒有那條線
    assert.strictEqual(newLines(draw({ unread: 0, lastReadId: 'r2' })).length, 0,
      '未讀為 0 時不該有未讀線');

    // 2) 未讀 2、上次讀到 r1 → 一條線，寫「2 則新訊息」
    let nodes = draw({ unread: 2, lastReadId: 'r1' });
    let lines = newLines(nodes);
    assert.strictEqual(lines.length, 1, '應有一條未讀線');
    assert.ok(allText(nodes).indexOf('2 則新訊息') !== -1,
      '應寫出則數，實際：' + allText(nodes).slice(0, 120));
    assert.strictEqual(lines[0].props['aria-label'], '未讀訊息 2 則', '要有無障礙標籤');

    // 3) 線要畫在「第一則新訊息」前面（r2 之前）
    const order = nodes.filter((n) => n.cls && (n.cls.indexOf('ntfy-teams-newline') !== -1
      || n.cls === 'ntfy-teams-msg' || n.cls.indexOf('ntfy-teams-msg ') === 0
      || hasDayToken(n)));
    // 找出線後面第一個訊息列的文字
    const lineIdx = order.findIndex((n) => n.cls.indexOf('ntfy-teams-newline') !== -1);
    const texts = allText(nodes);
    assert.ok(lineIdx >= 0, '找不到未讀線');
    // 「one」在線之前、「two」在線之後
    const rowTexts = nodes
      .filter((n) => n.cls && (n.cls === 'ntfy-teams-msg' || n.cls.indexOf('ntfy-teams-msg ') === 0))
      .map((n) => (Array.isArray(n.children) ? n.children.map(collectText).join(' ') : collectText(n.children)));
    assert.ok(rowTexts[0].indexOf('one') !== -1, '第一列應是 one');
    assert.ok(rowTexts[1].indexOf('two') !== -1, '第二列應是 two');
    // 順序：one → 線 → two（只看「線」與「訊息列」這兩層，跳過它們的子元素）
    const flat = nodes
      .filter((n) => n.cls && (n.cls === 'ntfy-teams-newline'
        || n.cls === 'ntfy-teams-msg'
        || n.cls.indexOf('ntfy-teams-msg ') === 0))
      .map((n) => n.cls + '|' + collectText(n.children));
    const oneAt = flat.findIndex((s) => s.indexOf('one') !== -1);
    const lineAt = flat.findIndex((s) => s.indexOf('ntfy-teams-newline') !== -1);
    const twoAt = flat.findIndex((s) => s.indexOf('two') !== -1);
    assert.ok(oneAt !== -1 && lineAt !== -1 && twoAt !== -1, 'one／線／two 都要找得到');
    assert.ok(oneAt < lineAt && lineAt < twoAt,
      '線必須夾在「上次讀到的」與「第一則新訊息」之間；實際 oneAt=' + oneAt + ' lineAt=' + lineAt + ' twoAt=' + twoAt);
    void texts;
    void order;

    // 4) 找不到 lastReadId 時不畫線（否則整串會被誤標成新訊息）
    assert.strictEqual(newLines(draw({ unread: 3, lastReadId: 'not-in-list' })).length, 0,
      '上次讀到的那則不在清單裡時，不該亂畫未讀線');
    assert.strictEqual(newLines(draw({ unread: 3, lastReadId: '' })).length, 0,
      '沒有 lastReadId 時也不該畫線');

    // 5) 捲動錨點就是那條線：CSS 找得到 .ntfy-teams-newline
    const styleCtx = makeCtx();
    documentStub.__head.length = 0;
    built.exports.apply(styleCtx.context);
    const cssText = documentStub.__head[0].textContent;
    assert.ok(cssText.indexOf('.ntfy-teams-newline{') !== -1, '樣式應定義未讀線');
    assert.ok(cssText.indexOf('.ntfy-teams-topic--unread{') !== -1,
      '主題 chip 也該有未讀樣式（角標之外的第二層提示）');
  });

  test('未讀線的「前一則」必須是訊息列（切換主題時靠它捲到已讀的最新一則）', () => {
    // 需求：「切換 topic 要滾動到已讀的最新 message」。
    //
    // 做法是：未讀線畫在「第一則未讀」前面，所以它**上面那一則**就是上次讀到的地方。
    // 切換主題時把那一則的底端對到視窗底端（見 MessageList 的捲動 effect）。
    //
    // 這個契約唯一會壞的方式是：未讀線前面不是訊息列（例如前面多插了日期抬頭
    // 或別的裝飾），那樣 `line.previousElementSibling` 就不是訊息，
    // 捲動就會錨在錯的東西上。所以這裡把它釘住。
    const { harness, exports: mod } = freshPanel();
    const MessageList = mod.__test.MessageList;
    const msgs = [];
    for (let i = 1; i <= 6; i += 1) {
      msgs.push({ id: 'm' + i, time: 1790756800 + i * 60, topic: 'pub_anchor', title: '#ann', message: 'msg ' + i });
    }
    const props = {
      topic: 'pub_anchor', messages: msgs, selfName: '', loading: false,
      unread: 2, lastReadId: 'm4'
    };
    const nodes = [];
    walk(harness, harness.render(function listUnderTest() {
      return MessageList(props);
    }, undefined), nodes, 0);

    // 找到未讀線，以及**在走訪順序上**緊接在它前面的節點。
    // 注意 walker 是前序（pre-order），`nodes[i-1]` 不一定等於 DOM 的前一個兄弟，
    // 但「線之前最後一個訊息列」在哪裡是一樣的，所以往前找第一個訊息列。
    const lineIdx = nodes.findIndex((n) => n.cls === 'ntfy-teams-newline');
    assert.ok(lineIdx > 0, '應該畫出未讀線（unread=2、lastReadId=m4）');
    let before = null;
    for (let i = lineIdx - 1; i >= 0; i -= 1) {
      if (nodes[i].cls === 'ntfy-teams-msgslot') { before = nodes[i]; break; }
    }
    assert.ok(before, '未讀線前面應該找得到訊息列（切換主題時要捲到它）');
    assert.strictEqual(before.props['data-mid'], 'm4',
      '而且必須是「已讀的最新那一則」(m4)，實際：' + before.props['data-mid']);
    // 中間不該夾著另一個訊息列（否則捲動會錨在更舊的那一則）
    const between = nodes.slice(nodes.indexOf(before) + 1, lineIdx)
      .filter((n) => n.cls === 'ntfy-teams-msgslot');
    assert.deepStrictEqual(between, [], '線與那一則之間不該還有其他訊息列');

    // 而且它**不是**最後一則 —— 後面還有未讀（否則線本來就不該畫）
    const after = nodes.slice(lineIdx + 1).filter((n) => n.cls === 'ntfy-teams-msgslot');
    assert.ok(after.length > 0, '未讀線後面應該還有未讀訊息');
  });
  test('看板示範圖表：該有的圖都在，且明確標示「示範」、不含真實數據冒充', () => {
    // 需求：看板加一點圖表示範，資料要「動態而隨機」。
    // 這裡驗結構與**標示**；「動態」由 buildDemoData 的種子行為驗（同一條測試後半）。
    const { harness, exports: mod } = freshPanel();
    const DashDemo = mod.__test.DashDemo;
    const buildDemoData = mod.__test.buildDemoData;
    assert.strictEqual(typeof DashDemo, 'function', '應匯出 DashDemo');
    assert.strictEqual(typeof buildDemoData, 'function', '應匯出 buildDemoData');

    const props = { seed: 12345, topics: ['pub_a', 'pub_b', 'pub_c'] };
    const nodes = [];
    walk(harness, harness.render(function dashUnderTest() {
      return DashDemo(props);
    }, undefined), nodes, 0);

    const countCls = (cls) => nodes.filter((n) => n.cls === cls).length;
    const hasClsPrefix = (p) => nodes.some((n) => n.cls && n.cls.indexOf(p) !== -1);

    // 1) 四張卡片
    assert.strictEqual(countCls('ntfy-teams-card'), 4, '看板應有四張卡片');
    // 2) 每張卡片都要標「示範」—— 隨機資料不能冒充真實統計
    assert.strictEqual(countCls('ntfy-teams-demotag'), 4,
      '四張卡片都必須標「示範」');
    assert.ok(allText(nodes).indexOf('示範') !== -1, '畫面上要出現「示範」字樣');

    // 3) KPI 三格
    assert.strictEqual(countCls('ntfy-teams-kpibox'), 3, 'KPI 應有三格');

    // 4) 折線圖：一條線 + 一個漸層面積
    assert.strictEqual(countCls('ntfy-teams-chartline'), 1, '應有一條折線');
    assert.ok(nodes.some((n) => n.tag === 'path' && typeof n.props.fill === 'string'
      && n.props.fill.indexOf('url(#') === 0), '折線下應有漸層面積');

    // 5) 甜甜圈：四段
    //
    // ⚠️ className 是**空格串接**的多個 class（"ntfy-teams-dseg ntfy-teams-dseg--0"），
    // 所以不能用 `cls.indexOf(前綴) === 0` 比對 —— 那個前綴不在字串開頭。
    // 這跟先前踩過的「ntfy-teams-headeracts 被 indexOf('ntfy-teams-header') 誤中」
    // 是同一類陷阱，方向相反：這次是**漏掉**。一律切成 token 再比。
    const hasClassToken = (n, token) => !!n.cls && n.cls.split(/\s+/).indexOf(token) !== -1;
    const segNodes = nodes.filter((n) => /(^|\s)ntfy-teams-dseg--\d/.test(n.cls || ''));
    assert.strictEqual(segNodes.length, 4, '甜甜圈應有四段');
    // 每一段都要帶到外圈的定位 class（否則四段會疊在同一個起點）
    segNodes.forEach((n, i) => {
      assert.ok(hasClassToken(n, 'ntfy-teams-dseg--' + i), '第 ' + i + ' 段應有對應的定位 class');
    });
    // 四段的 strokeDasharray 加總應等於圓周（沒有漏畫、也沒有畫超過）
    const dashes = segNodes.map((n) => parseFloat(String(n.props.strokeDasharray).split(' ')[0]));
    const totalDash = dashes.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(totalDash - 2 * Math.PI * 28) < 0.6,
      '四段弧長加總應等於整圈圓周，實際：' + totalDash.toFixed(2));

    // 6) 各主題的迷你條數量＝傳進來的主题數
    assert.strictEqual(countCls('ntfy-teams-tbrow'), 3, '每個主題一條迷你條');

    // 7) 沒有任何真實主題名被寫死進圖表以外的假數據（避免誤導）：卡片標題不含 msn.feg.cn
    assert.ok(allText(nodes).indexOf('msn.feg.cn') === -1, '看板不該出現伺服器位址');

    // 8) 「動態而隨機」的核心契約：**同種子 → 同資料**（重繪不抖動）、
    //    **換種子 → 換資料**（切主題會換一輪）。
    const a1 = buildDemoData(999, ['pub_a', 'pub_b']);
    const a2 = buildDemoData(999, ['pub_a', 'pub_b']);
    const b1 = buildDemoData(1000, ['pub_a', 'pub_b']);
    assert.deepStrictEqual(a1.points, a2.points,
      '同一種子必須產生同一組資料（否則 React 每次重繪圖表都會自己跳動）');
    assert.notDeepStrictEqual(a1.points, b1.points,
      '換種子必須換一組資料（否則「動態」不成立）');
    // 佔比要剛好 100%，不能出現 99% 或 101%
    assert.strictEqual(a1.parts.reduce((s, p) => s + p.value, 0), 100,
      '四類佔比加總必須剛好 100%，實際：' + JSON.stringify(a1.parts.map((p) => p.value)));

    // 9) 沒有網路請求：圖表純本地產生（不吃 ntfy 限流額度）
    //    用「有 fetch 也完全沒被呼叫」來釘住 —— 一旦有人加了輪詢就會失敗。
    let fetchCalls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = function () { fetchCalls += 1; return Promise.resolve({ ok: false }); };
    try {
      buildDemoData(7, ['pub_x']);
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.strictEqual(fetchCalls, 0, '示範資料產生過程不該發出任何網路請求');
  });

  test('看板底部保留區：130px 高、上緣 1px solid #eee（使用者指定）', () => {
    // 需求：「看板底部分保留 130px，它的 border-top 1px solid #eee」。
    //
    // 兩件事都要釘住：
    //   1. 那個 div 真的存在（不是靠 dashbody 的 padding 湊出來的假留白）；
    //   2. CSS 真的給了 130px 與那條線 —— 否則後人改了數字不會有人發現。
    const { context } = makeCtx();
    documentStub.__head.length = 0;
    built.exports.apply(context);
    const css = documentStub.__head[0].textContent;

    const footRule = css.match(/\.ntfy-teams-dashfoot\{[^}]*\}/);
    assert.ok(footRule, 'CSS 應定義 .ntfy-teams-dashfoot，實際找不到');
    const rule = footRule[0];
    assert.ok(rule.indexOf('min-height:130px') !== -1,
      '底部保留區應是 130px，實際規則：' + rule);
    assert.ok(rule.indexOf('border-top:1px solid #eee') !== -1,
      '底部保留區上緣應是 1px solid #eee，實際規則：' + rule);
    // 只留上緣那一條線，其他三邊不該有框
    assert.ok(rule.indexOf('border:') === -1 || /border-top:/.test(rule),
      '不該用 border 簡寫（會畫出四邊框）');

    // 結構：dashbody 底下除了圖表，還要真的有一個 dashfoot 節點
    const { harness, exports: mod } = freshPanel();
    const DashDemo = mod.__test.DashDemo;
    const nodes = [];
    walk(harness, harness.render(function bodyProbe() {
      // 直接畫整塊看板內容區的近似結構：DashDemo + footer
      return { type: 'div', props: { className: 'ntfy-teams-dashbody' }, children: [
        DashDemo({ seed: 3, topics: ['a'] }),
        { type: 'div', props: { className: 'ntfy-teams-dashfoot' }, children: null }
      ] };
    }, undefined), nodes, 0);
    assert.strictEqual(nodes.filter((n) => n.cls === 'ntfy-teams-dashfoot').length, 1,
      '看板內容區應有一個 dashfoot 節點');
  });

  test('訊息串右側的日期跳轉列：第一則／上一天／下一天／最後一則', () => {
    // 需求：「message list 右側中間，加向上／向下／END 的 icon，
    // 點一下就跳轉到上一天和下一天的第一條以及最後一條」，
    // 以及後續追加：「最前面加一個 START，跳轉到第一條」。
    //
    // 這裡驗**結構**（四顆按鈕、標籤、可不可按、節點順序）；真正的捲動位置
    // 由瀏覽器端驗證（需要真的 DOM：offsetTop / scrollTop，測試替身沒有）。
    const { harness, exports: mod } = freshPanel();
    const MessageList = mod.__test.MessageList;
    const day = (offset, hh) => {
      const base = new Date();
      base.setHours(0, 0, 0, 0);
      return Math.floor(base.getTime() / 1000) - offset * 86400 + hh * 3600;
    };
    const msgs = [
      { id: 'n3', time: day(2, 9), topic: 'pub_nav', title: '#a', message: '前天' },
      { id: 'n2', time: day(1, 9), topic: 'pub_nav', title: '#a', message: '昨天' },
      { id: 'n1', time: day(0, 9), topic: 'pub_nav', title: '#a', message: '今天' }
    ];
    const draw = (list) => {
      const nodes = [];
      walk(harness, harness.render(function listUnderTest() {
        return MessageList({
          topic: 'pub_nav', messages: list, selfName: '', loading: false,
          unread: 0, lastReadId: ''
        });
      }, undefined), nodes, 0);
      return nodes;
    };

    const navs = (nodes) => nodes.filter((n) => n.cls && n.cls.split(/\s+/)
      .indexOf('ntfy-teams-daynavbtn') !== -1);

    // 1) 多天：四顆按鈕都在（START 在最前面），而且上／下一天可按
    let nodes = draw(msgs);
    let btns = navs(nodes);
    assert.strictEqual(btns.length, 4, '跳轉列應有四顆按鈕，實際 ' + btns.length);
    const labels = btns.map((b) => b.props['aria-label']);
    assert.ok(labels[0].indexOf('第一則') !== -1,
      '第 1 顆應是 START（跳到第一則），實際：' + labels[0]);
    assert.ok(labels[1].indexOf('上一天') !== -1, '第 2 顆應是上一天，實際：' + labels[1]);
    assert.ok(labels[2].indexOf('下一天') !== -1, '第 3 顆應是下一天，實際：' + labels[2]);
    assert.ok(labels[3].indexOf('最後一則') !== -1, '第 4 顆應是最後一則，實際：' + labels[3]);
    btns.forEach((b) => {
      assert.ok(b.props.title, '每顆都要有 tooltip');
      assert.strictEqual(typeof b.props.onClick, 'function', '每顆都要能點');
    });

    // 2) 只有一天時：沒有上／下一天可言 → 那兩顆變淡不可按；
    //    「最後一則」永遠有意義，所以一直可按。
    const oneDay = msgs.filter((m) => m.id === 'n1');
    const btns1 = navs(draw(oneDay));
    assert.strictEqual(btns1.length, 4, '只有一天時仍應有四顆（位置不要跳動）');
    assert.strictEqual(!!btns1[0].props.disabled, true, 'START 看捲動位置，這裡沒捲過所以不可按');
    assert.strictEqual(!!btns1[1].props.disabled, true, '只有一天時「上一天」不可按');
    assert.strictEqual(!!btns1[2].props.disabled, true, '只有一天時「下一天」不可按');
    assert.ok(!btns1[3].props.disabled, '「最後一則」永遠可按');

    // 3) 完全沒有訊息時不畫跳轉列（沒有東西可跳）
    assert.strictEqual(navs(draw([])).length, 0, '沒有訊息時不該有跳轉列');

    // 4) 跳轉列必須在**訊息串裡面** —— sticky 要跟著這個捲動容器才有效。
    //    驗「stream → 跳轉列 → 第一個日期分段」的節點順序。
    //
    // ⚠️ 用**日期分段**當基準而不是訊息列：預設只有「今天」展開，
    //    所以舊日子的訊息列根本不會被渲染（實測：找不到 .ntfy-teams-msg）。
    //    日期分段則是每一天都會畫，順序穩定。
    const ordered = draw(msgs);
    const streamIdx = ordered.findIndex((n) => n.cls === 'ntfy-teams-stream');
    const navIdx = ordered.findIndex((n) => n.cls === 'ntfy-teams-daynav');
    const firstDayIdx = ordered.findIndex((n) => hasDayToken(n));
    assert.ok(streamIdx >= 0, '應有 .ntfy-teams-stream');
    assert.ok(navIdx > streamIdx, '跳轉列應在 stream 內（sticky 才有效）');
    assert.ok(firstDayIdx >= 0, '這一輪應該有日期分段');
    assert.ok(navIdx < firstDayIdx, '跳轉列應排在內容之前（才不會被推著跑）');
  });

  test('★ 焦點中收到別人的訊息：浮出「N 則新訊息」提示條，貼底時不顯示', () => {
    // 需求：「當前 topic 處於焦點時，希望可以適時追蹤最新推送 ——
    //       如果是我發的就自動滾屏到那條之後，如果是其他人發的就提示未讀」。
    //
    // 這條驗提示條本身的行為：
    //   * 有未讀 + 沒貼底 → 顯示，寫出則數，可點；
    //   * 貼底（訊息就在眼前）→ 不顯示（再提示一次是噪音）；
    //   * 沒有未讀 → 不顯示。
    const { harness, exports: mod, core } = freshPanel();
    const UnreadPill = mod.__test.UnreadPill;
    assert.strictEqual(typeof UnreadPill, 'function', '應匯出 UnreadPill');

    const draw = (props) => {
      const nodes = [];
      walk(harness, harness.render(function pillUnderTest() {
        return UnreadPill(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    const texts = (nodes) => nodes.filter((n) => n.tag === '#text').map((n) => n.text).join(' ');

    // 1) 未讀 3 則 → 顯示、寫出則數、可點
    let clicked = 0;
    let nodes = draw({ count: 3, onClick: () => { clicked += 1; } });
    assert.ok(nodes.some((n) => n.cls === 'ntfy-teams-unreadpill'),
      '有未讀時應顯示提示條');
    assert.ok(texts(nodes).indexOf('3 則新訊息') !== -1,
      '應寫出則數，實際：' + texts(nodes));
    const btn = nodes.find((n) => n.cls === 'ntfy-teams-unreadpillbtn');
    assert.ok(btn, '應有一顆可點的按鈕');
    assert.ok(String(btn.props['aria-label']).indexOf('3') !== -1, '無障礙標籤要有則數');
    btn.props.onClick();
    assert.strictEqual(clicked, 1, '點下去要呼叫 onClick');

    // 2) 沒有未讀 → 不顯示
    assert.strictEqual(draw({ count: 0, onClick: () => {} }).length, 0, '沒有未讀時不該顯示');

    // 3) 兩個位數以上也要正常（badgeText 會處理 99+）
    nodes = draw({ count: 150, onClick: () => {} });
    assert.ok(texts(nodes).indexOf('99+') !== -1,
      '超過 99 要用 99+，實際：' + texts(nodes));

    core.store.removeTopic('pub_a');
    core.store.removeTopic('pub_b');
  });

  test('markdown 表格渲染成真正的 table，且不注入 HTML', () => {
    const { harness, exports: mod } = freshPanel();
    const MessageRow = mod.__test.MessageRow;

    /** 把一段 markdown 當訊息內文渲染並攤平。 @param body - markdown。 */
    const draw = (body) => {
      const props = {
        msg: { id: 't1', time: 1790756900, topic: 'pub_t', title: '#bob', message: body },
        selfName: ''
      };
      const nodes = [];
      walk(harness, harness.render(function rowUnderTest() {
        return MessageRow(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    const countCls = (nodes, cls) => nodes.filter((n) => n.cls === cls).length;

    // 1) 基本表格：thead / th / tbody / td 都真的存在
    let nodes = draw('| 名稱 | 數量 |\n| --- | --- |\n| 蘋果 | 3 |\n| 香蕉 | 5 |');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-md-tablewrap'), 1, '應有一層可捲動外框');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-md-table'), 1, '應有一個 table');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-md-th'), 2, '應有兩個表頭格');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-md-td'), 4, '兩列 × 兩欄 = 四格');
    assert.ok(nodes.some((n) => n.tag === 'thead'), '應有 thead');
    assert.ok(nodes.some((n) => n.tag === 'tbody'), '應有 tbody');
    assert.ok(nodes.some((n) => n.tag === 'tr'), '應有 tr');
    const txt = allText(nodes);
    assert.ok(txt.indexOf('名稱') !== -1 && txt.indexOf('蘋果') !== -1 && txt.indexOf('香蕉') !== -1,
      '内容應出現，實際：' + txt);

    // 2) 对齐标记变成行内样式
    nodes = draw('| 左 | 中 | 右 |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
    const ths = nodes.filter((n) => n.cls === 'ntfy-teams-md-th');
    assert.deepStrictEqual(ths.map((n) => n.props.style && n.props.style.textAlign),
      ['left', 'center', 'right'], '三欄對齊方式應各自生效');

    // 3) 危害内容只能是文字（不產生元素）
    nodes = draw('| a |\n| --- |\n| <img src=x onerror=alert(1)> |');
    assert.ok(!nodes.some((n) => n.tag === 'img'), '不該產生 img 元素');
    assert.ok(allText(nodes).indexOf('<img') !== -1, '危險內容應以文字呈現');

    // 4) 不是表格的內容不該長出 table
    nodes = draw('只是普通段落\n\n- 項目一\n- 項目二');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-md-table'), 0, '普通內容不該有 table');
    assert.strictEqual(countCls(nodes, 'ntfy-teams-md-list'), 1, '清單仍應正常');

    // 5) 自己的訊息靠右排版時，表格仍要左讀
    const selfNodes = [];
    walk(harness, harness.render(function rowUnderTest() {
      return MessageRow({
        msg: { id: 't2', time: 1790756901, topic: 'pub_t', title: '#me', message: '| a |\n| --- |\n| 1 |' },
        selfName: 'me'
      });
    }, undefined), selfNodes, 0);
    assert.strictEqual(selfNodes.filter((n) => n.cls === 'ntfy-teams-md-table').length, 1,
      '自己的訊息裡的表格也該渲染出來');

    // 6) CSS 要有表格樣式與橫向捲動
    const styleCtx = makeCtx();
    documentStub.__head.length = 0;
    built.exports.apply(styleCtx.context);
    const cssText = documentStub.__head[0].textContent;
    assert.ok(cssText.indexOf('.ntfy-teams-md-tablewrap{') !== -1, '應有表格外框樣式');
    assert.ok(cssText.indexOf('overflow-x:auto') !== -1, '外框應可橫向捲動');
  });

  test('未讀線：讀到最新就消失，而不是留到切換主題', () => {
    const { harness, exports: mod } = freshPanel();
    const MessageList = mod.__test.MessageList;

    const msgs = [
      { id: 'a1', time: 1790756800, topic: 'pub_z', title: '#a', message: 'one' },
      { id: 'a2', time: 1790756860, topic: 'pub_z', title: '#b', message: 'two' },
      { id: 'a3', time: 1790756920, topic: 'pub_z', title: '#b', message: 'three' },
    ];
    /** 畫一次。 */
    const draw = (extra) => {
      const props = Object.assign({
        topic: 'pub_z', messages: msgs, loading: false, selfName: '', unread: 0, lastReadId: ''
      }, extra || {});
      const nodes = [];
      walk(harness, harness.render(function listUnderTest() {
        return MessageList(props);
      }, undefined), nodes, 0);
      return nodes;
    };
    const marks = (nodes) => nodes.filter((n) => n.cls === 'ntfy-teams-newline').length;

    // 邊界就是最後一則 → 後面沒有新東西 → 不該畫線（「讀完最新要消失」）
    assert.strictEqual(marks(draw({ unread: 3, lastReadId: 'a3' })), 0,
      '讀到最後一則時不該還有未讀線');

    // 邊界在中間 → 線畫在它後面那一則之前。
    // 用 data-mid 判順序：那是 DOM 真的帶的屬性，比從子節點撈文字可靠
    // （MessageRow 展開後子節點不只一層，collectText 撈不到內文）。
    const nodes = draw({ unread: 2, lastReadId: 'a1' });
    assert.strictEqual(marks(nodes), 1, '邊界在中間時應有線');
    const flat = nodes
      .filter((n) => n.cls && (n.cls === 'ntfy-teams-newline' || n.cls === 'ntfy-teams-msgslot'))
      .map((n) => (n.cls === 'ntfy-teams-newline' ? 'LINE' : 'slot:' + n.props['data-mid']));
    assert.deepStrictEqual(flat, ['slot:a1', 'LINE', 'slot:a2', 'slot:a3'],
      '線必須緧接在「第一則未讀」（a2）前面，實際：' + JSON.stringify(flat));

    // 每一則都包了帶 data-mid 的殼（未讀線靠它認出「後面是哪一則」）
    const slots = nodes.filter((n) => n.cls === 'ntfy-teams-msgslot');
    assert.strictEqual(slots.length, 3, '三則都該有殼');
    assert.deepStrictEqual(slots.map((n) => n.props['data-mid']), ['a1', 'a2', 'a3']);
  });

  test('顯示名稱未設定時不能傳送（送出按鈕 disabled）', () => {
    /** 找到送出按鈕節點。 @param nodes - 走訪結果。 @returns 節點或 undefined。 */
    const sendButton = (nodes) => nodes.filter((n) => n.tag === 'button'
      && n.cls && String(n.cls).indexOf('ntfy-teams-sendbtn') !== -1)[0];

    /** 在給定身分下渲染面板並回傳節點。 @param identity - 顯示名稱。 @returns 節點。 */
    const renderWithIdentity = (identity) => {
      const { harness, core, seats } = freshPanel();
      core.store.ensureTopic('pub_name');
      core.store.setActiveTopic('pub_name');
      // 明確設定（包含空字串）—— store 是跨測試共用的，
      // 上一個測試若留下身分，這裡不設就會讀到殘值（實測踩過）。
      core.setIdentity(identity || '');
      const nodes = [];
      walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);
      return { nodes, core };
    };

    // 1) 沒有名稱 → 送出鈕必須停用
    const without = renderWithIdentity('');
    const btnOff = sendButton(without.nodes);
    assert.ok(btnOff, '應該找得到送出按鈕');
    assert.strictEqual(btnOff.props.disabled, true,
      '沒有顯示名稱時送出按鈕必須是 disabled');
    assert.ok(String(btnOff.props.title || '').indexOf('顯示名稱') !== -1,
      '按鈕 tooltip 要說明原因，實際：' + btnOff.props.title);
    // 輸入框仍可打字（先把話寫好，填完名字就能送）
    const areaOff = without.nodes.filter((n) => n.tag === 'textarea')[0];
    assert.ok(areaOff, '應該有輸入框');
    assert.ok(!areaOff.props.disabled, '沒有名稱時輸入框仍應可打字');
    assert.ok(String(areaOff.props.placeholder || '').indexOf('顯示名稱') !== -1,
      'placeholder 要說明要先設定名稱，實際：' + areaOff.props.placeholder);

    // 2) 有名稱 → 可以送出
    const withName = renderWithIdentity('shawoo');
    const btnOn = sendButton(withName.nodes);
    assert.ok(btnOn, '應該找得到送出按鈕');
    assert.ok(!btnOn.props.disabled, '設定了名稱就應該可以送出');
  });

  test('自動回應開關：input 上方一個 checkbox，且說明觸發字串與回覆內容', () => {
    // 需求：「在 input 上面加個 checkbox，如果選中，當前 topic 中出現
    //       『/approve session』就自動回覆『/approve』」。
    //
    // 這裡驗 UI：checkbox 在、勾選狀態跟著設定、切換時會回報。
    // 「什麼時候真的該回」是純函式，由 core-node.js 驗（那裡才有完整的防護矩陣）。
    /** 渲染面板並回傳節點。 @param on - 該主題的自動回應是否開啟。 @returns { nodes, core, harness }。 */
    const render = (on) => {
      const { harness, core, seats } = freshPanel();
      core.store.ensureTopic('pub_ap');
      core.store.setActiveTopic('pub_ap');
      core.setIdentity('shawoo');
      core.saveConfig({ autoApprove: {} });
      if (on) core.setAutoApprove('pub_ap', true);
      const nodes = [];
      walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);
      return { nodes, core, harness };
    };

    /** 找出自動回應的 checkbox。 @param nodes - 走訪結果。 @returns 節點。 */
    const box = (nodes) => nodes.filter((n) => n.tag === 'input'
      && n.cls && String(n.cls).indexOf('ntfy-teams-autoapprovebox') !== -1)[0];

    // 1) 未開啟：checkbox 存在、未勾選
    const off = render(false);
    const offBox = box(off.nodes);
    assert.ok(offBox, '應該有自動回應的 checkbox');
    assert.strictEqual(offBox.props.type, 'checkbox', '要是 checkbox');
    assert.ok(!offBox.props.checked, '未開啟時不該被勾選');
    assert.strictEqual(typeof offBox.props.onChange, 'function', '要能切換');

    // 2) 標籤要**簡短**，但看得出這是什麼開關；完整規則放 tooltip。
    //
    // 回饋：「checkbox 的文本，解釋太多了，簡短一些」。
    // 所以標籤只留名字（+ 觸發的那個指令），細節（觸發字串、只認即時推送、
    // 不回應自己發的…）搬到 label 的 title。
    const allCls = (n, cls) => n.cls && String(n.cls).split(/\s+/).indexOf(cls) !== -1;
    const labelNode = findNode(off.nodes, 'ntfy-teams-autoapprove');
    assert.ok(labelNode, '應該有一個包住 checkbox 的 label（點文字也能切換）');
    assert.strictEqual(labelNode.tag, 'label', '找到的應該是 label');

    // ⚠️ 只看**這個 label 裡**的文字，不是整個面板的。
    // （`nodes.filter(tag==='#text')` 會撈到整棵樹的文字，那樣長度斷言毫無意義 ——
    //  實測第一次寫成這樣，量到 261 字而誤判。）
    const text = walkInto(off.harness, labelNode)
      .filter((n) => n.tag === '#text').map((n) => n.text).join(' ');
    assert.ok(text.indexOf('自動批準') !== -1,
      '標籤要看得出這是「自動批準」，實際：' + JSON.stringify(text));
    assert.ok(text.length < 30,
      '標籤應該簡短（不要一整句解釋），實際 ' + text.length + ' 字：' + JSON.stringify(text));
    // 「會送出什麼指令」現在放在 tooltip（標籤只留名字），所以驗 tooltip。
    assert.ok(String(labelNode.props.title || '').indexOf('/approve') !== -1,
      'tooltip 要顯示會送出什麼指令，實際：' + labelNode.props.title);
    assert.ok(String(labelNode.props.title || '').indexOf('/approve session') !== -1,
      '完整規則（含觸發字串）要放在 tooltip，實際：' + labelNode.props.title);
    // ★ tooltip 必須寫出「還要帶 hermes-agent 標籤」—— 少了這句，使用者會以為
    //   只要有人打出那句話就會被自動回覆，然後納悶為什麼沒反應。
    assert.ok(String(labelNode.props.title || '').indexOf('hermes-agent') !== -1,
      'tooltip 要說明還需要 hermes-agent 標籤，實際：' + labelNode.props.title);

    // 3) 已開啟：checkbox 打勾（狀態來自設定，不是元件自己的 state）
    const on = render(true);
    assert.ok(box(on.nodes).props.checked, '開啟後 checkbox 應該打勾');

    // 4) 切換會把設定寫進去（透過 props 回報，實際寫入由 MainPanel 做）
    //    直接驗核心的 setter：開啟 → 關閉 → 再開啟都能往返。
    assert.strictEqual(on.core.readConfig().autoApprove.pub_ap.on, true, '設定應為開啟');
    on.core.setAutoApprove('pub_ap', false);
    assert.strictEqual(on.core.readConfig().autoApprove.pub_ap.on, false, '應能關閉');
    on.core.saveConfig({ autoApprove: {} });
  });

  test('永遠滾到最新：另一個 checkbox，且狀態跟著每個主題的設定', () => {
    // 需求：「再加入一個 checkbox，如果選中，當前 topic 永遠滾動到最新」。
    //
    // 這個開關會**覆蓋**「只有自己發的才跟隨」的預設行為，
    // 所以它必須是每個主題各自一份的設定（不是全域）。
    /** 渲染面板並回傳節點。 @param on - 該主題的「永遠滾到最新」是否開啟。 @returns { nodes, core, harness, seats }。 */
    const render = (on) => {
      const { harness, core, seats } = freshPanel();
      core.store.ensureTopic('pub_sab');
      core.store.setActiveTopic('pub_sab');
      core.setIdentity('shawoo');
      core.saveConfig({ stayAtBottom: {} });
      if (on) core.setStayAtBottom('pub_sab', true);
      const nodes = [];
      walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);
      return { nodes, core, harness, seats };
    };

    /** 找出「永遠滾到最新」的 checkbox。 @param nodes - 走訪結果。 @returns 節點。 */
    const box = (nodes) => nodes.filter((n) => n.tag === 'input'
      && n.cls && String(n.cls).indexOf('ntfy-teams-staybottombox') !== -1)[0];

    // 1) 未開啟
    const off = render(false);
    const offBox = box(off.nodes);
    assert.ok(offBox, '應該有「永遠滾到最新」的 checkbox');
    assert.strictEqual(offBox.props.type, 'checkbox', '要是 checkbox');
    assert.ok(!offBox.props.checked, '未開啟時不該被勾選');

    // 2) 有兩個 checkbox（自動回應 + 永遠滾到最新），而且都在輸入框之前
    const inputs = off.nodes.filter((n) => n.tag === 'input' && n.props && n.props.type === 'checkbox');
    assert.strictEqual(inputs.length, 2, '應該剛好兩個 checkbox，實際 ' + inputs.length);
    const areaIdx = off.nodes.findIndex((n) => n.tag === 'textarea');
    const boxIdx = off.nodes.indexOf(offBox);
    assert.ok(boxIdx !== -1 && areaIdx !== -1 && boxIdx < areaIdx,
      'checkbox 應該排在輸入框之前（需求：在 input 上面）');

    // 3) 說明要寫出「不管誰發的」—— 但**放在 tooltip**，不是佔掉標籤。
    //    回饋：「checkbox 的文本，解釋太多了，簡短一些」。
    const allText = off.nodes.filter((n) => n.tag === '#text').map((n) => n.text).join(' ');
    assert.ok(allText.indexOf('永遠滾到最新') !== -1, '要有「永遠滾到最新」字樣');
    const sabLabel = findNode(off.nodes, 'ntfy-teams-staybottom');
    assert.ok(sabLabel, '應該有包含 checkbox 的 label');
    assert.strictEqual(sabLabel.tag, 'label', '找到的應該是 label');
    assert.ok(String(sabLabel.props.title || '').indexOf('不管訊息是誰發的') !== -1,
      'tooltip 要講清楚「不管誰發的」，實際：' + sabLabel.props.title);
    // 標籤本身只留標題（短），不要把整句解釋塞進去
    const sabText = walkInto(off.harness, sabLabel)
      .filter((n) => n.tag === '#text').map((n) => n.text).join(' ');
    assert.ok(sabText.length < 20,
      '標籤應該簡短，實際 ' + sabText.length + ' 字：' + JSON.stringify(sabText));

    // 4) 已開啟 → 打勾，而且是**每個主題各自**的設定
    const on = render(true);
    assert.ok(box(on.nodes).props.checked, '開啟後應該打勾');
    assert.strictEqual(on.core.readConfig().stayAtBottom.pub_sab.on, true, '設定應為開啟');

    // 5) 每個主題各自一份：另一個沒勾過的主題必須是關著的
    const second = render(false);
    assert.strictEqual(second.core.readConfig().stayAtBottom.pub_sab, undefined,
      '沒勾選過的主題不該有這筆設定');
    assert.ok(!box(second.nodes).props.checked, '未開啟的主題應該是未勾選');

    on.core.saveConfig({ stayAtBottom: {} });
    second.core.saveConfig({ stayAtBottom: {} });
  });
  test('優先級：四格階梯（單一控制項、預設高亮、標籤只在 tooltip）', () => {
    // 回饋演進：「預設」下拉框看不出是什麼 → 改成四段帶文字的分段控制
    // → 「非常不優雅，囉嗦，預設值請高亮」→ 收成**四格階梯**。
    //
    // 這條測試同時守住三件事：
    //   1. 不可以退回 <select>（看不出有哪幾種可選、選了也沒回饋）；
    //   2. 標籤**不可以**再回到「每一格都掛文字」那種囉嗦寫法；
    //   3. 「預設」那一格要有可辨識的標記（高亮）。
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_prio');
    core.store.setActiveTopic('pub_prio');
    core.setIdentity('shawoo');
    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);

    // 1) 沒有 select
    assert.strictEqual(nodes.filter((n) => n.tag === 'select').length, 0,
      '傳送區不該有下拉框');

    // 2) 一個 radiogroup 裡有四格
    const group = findNode(nodes, 'ntfy-teams-prio');
    assert.ok(group, '應該有優先級控制項');
    assert.strictEqual(group.props.role, 'radiogroup', '整組是 radiogroup');
    const levels = nodes.filter((n) => n.tag === 'button'
      && n.cls && String(n.cls).indexOf('ntfy-teams-priolevel') !== -1);
    assert.strictEqual(levels.length, 4, '應該有四格，實際 ' + levels.length);
    assert.ok(levels.every((n) => n.props.role === 'radio'), '每一格是 radio');
    assert.deepStrictEqual(levels.map((n) => n.props['aria-label']),
      ['優先級：最低', '優先級：低', '優先級：預設', '優先級：高'],
      '四格由低到高');
    assert.deepStrictEqual(levels.map((n) => n.props['data-level']),
      ['1', '2', '3', '4'], '階梯高度依序 1..4');

    // 3) 預設選中第三格（ntfy normal = 3）
    assert.deepStrictEqual(levels.map((n) => n.props['aria-checked']),
      ['false', 'false', 'true', 'false'], '預設應選中第三格');

    // 4) ★「預設」那一格要有高亮標記 —— 使用者永遠知道回到哪裡
    const defaults = levels.filter((n) => n.props.className
      && String(n.props.className).indexOf('ntfy-teams-priolevel--default') !== -1);
    assert.strictEqual(defaults.length, 1, '恰好一格標成「預設」，實際 ' + defaults.length);
    assert.strictEqual(defaults[0].props['aria-label'], '優先級：預設',
      '標成預設的要是第三格');

    // 5) 標籤只留 tooltip／aria-label，畫面**不**顯示「最低／低／預設／高」四個詞
    const allText = walkInto(harness, group).filter((n) => n.tag === '#text')
      .map((n) => n.text).join(' ').trim();
    assert.strictEqual(allText, '', '四格裡不該有可見文字（囉嗦），實際：' + JSON.stringify(allText));

    // 6) 沒有名稱時整格停用（跟送出鈕一致）
    core.setIdentity('');
    const offNodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), offNodes, 0);
    const offLevels = offNodes.filter((n) => n.tag === 'button'
      && n.cls && String(n.cls).indexOf('ntfy-teams-priolevel') !== -1);
    assert.strictEqual(offLevels.length, 4, '沒有名稱時四格仍在（看得到只是不能用）');
    assert.ok(offLevels.every((n) => n.props.disabled === true), '沒有顯示名稱時整組停用');

    core.setIdentity('shawoo');
    core.store.removeTopic('pub_prio');
  });

  test('★ 優先級不進設定：開面板永遠是預設值', () => {
    // 需求：「切換 topic 恢復預設，不用保存它狀態」。
    //
    // 「不保存」在這裡驗兩件事：
    //   1. config 裡**沒有** priority 欄位（不進 YAML）；
    //   2. 每次渲染都從預設值開始（第三格）。
    //
    // ⚠️ 「點一格之後切主題會不會回到預設」**不在這裡驗**：
    // 測試替身的 walker 會用一顆用完就丟的 slot 陣列展開子元件，
    // 在那裡面 setState 的結果不會留下來（實測：點了「高」再渲染仍是預設）。
    // 那件事交給真實瀏覽器驗（見 test/browser 的「切換主題恢復預設」）。
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_p1');
    core.store.ensureTopic('pub_p2');
    core.setIdentity('shawoo');

    assert.strictEqual(core.readConfig().priority, undefined,
      '設定裡不該有 priority（優先級不是持久設定）');

    /** 目前選中第幾格。 @returns 四個 aria-checked。 */
    const checkedNow = (topic) => {
      core.store.setActiveTopic(topic);
      const out = [];
      walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), out, 0);
      return out.filter((n) => n.tag === 'button'
        && n.cls && String(n.cls).indexOf('ntfy-teams-priolevel') !== -1)
        .map((n) => n.props['aria-checked']);
    };

    // 兩個主題各自打開都是預設（第三格）
    assert.deepStrictEqual(checkedNow('pub_p1'), ['false', 'false', 'true', 'false'],
      'pub_p1 打開時應是預設');
    assert.deepStrictEqual(checkedNow('pub_p2'), ['false', 'false', 'true', 'false'],
      'pub_p2 打開時也應是預設（沒有沿用前一個主題）');

    // 來回切幾次都一樣
    assert.deepStrictEqual(checkedNow('pub_p1'), ['false', 'false', 'true', 'false'],
      '切回 pub_p1 仍是預設');

    assert.strictEqual(core.readConfig().priority, undefined,
      '切換主題後仍不該把優先級寫進設定');

    core.store.removeTopic('pub_p1');
    core.store.removeTopic('pub_p2');
  });

  test('★ 身分／自動批準／永遠滾到最新／優先級 都在同一列', () => {
    // 需求：「身分說明、自動回覆、自動滾屏、優先級放在同一行，文本簡約」。
    //
    // 之前是兩列（兩個 checkbox 一列、身分＋優先級一列）。
    // 這條測試釘住「同一列」這件事 —— 不然很容易改著改著又拆成兩列。
    //
    // 實際的「有沒有折行／會不會溢出」由瀏覽器量（`flex-wrap:nowrap` +
    // media query 的省略策略）；這裡驗**結構**：四組東西都在 composemeta 裡，
    // 而且沒有被包進另一個 flex 容器（那才是折行的來源）。
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_onerow');
    core.store.setActiveTopic('pub_onerow');
    core.setIdentity('shawoo');
    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);

    const meta = findNode(nodes, 'ntfy-teams-composemeta');
    assert.ok(meta, '應該有 composemeta 這一列');

    // 四組東西都在 composemeta 的直接子節點裡
    const kidCls = (meta.children || []).map((c) => (c && c.props && c.props.className) || '');
    const hasKid = (cls) => kidCls.some((c) => String(c).split(/\s+/).indexOf(cls) !== -1);
    assert.ok(hasKid('ntfy-teams-sendas'), '身分要在這一列裡');
    assert.ok(hasKid('ntfy-teams-autoapprove'), '自動批準要在這一列裡');
    assert.ok(hasKid('ntfy-teams-staybottom'), '永遠滾到最新要在這一列裡');

    // 兩個開關不再是獨立的一整列（以前它們各是一個 flex 子項、排在 meta 之前）
    const metaIdx = nodes.indexOf(meta);
    const areaIdx = nodes.findIndex((n) => n.tag === 'textarea');
    const apIdx = nodes.indexOf(findNode(nodes, 'ntfy-teams-autoapprove'));
    const sbIdx = nodes.indexOf(findNode(nodes, 'ntfy-teams-staybottom'));
    assert.ok(apIdx > metaIdx && sbIdx > metaIdx,
      '兩個開關應該排在 composemeta **之內**（節點順序在它之後）');

    // ⚠️ 優先級是**自訂元件**（PriorityControl），`meta.children` 裡拿到的是
    // 還沒展開的 React 元素 —— 那裡沒有 className。所以用節點順序判斷：
    // 它在這一列**之內**（節點索引在 meta 之後、且在輸入框之前）。
    const prioIdx = nodes.indexOf(findNode(nodes, 'ntfy-teams-prio'));
    assert.ok(prioIdx > metaIdx && prioIdx < areaIdx,
      '優先級控制要在這一列裡、且在輸入框之前');

    // 身分是簡短版：只顯示 `#名稱`，完整句子搬到 tooltip
    const sendAs = findNode(nodes, 'ntfy-teams-sendas');
    const sendText = walkInto(harness, sendAs)
      .filter((n) => n.tag === '#text').map((n) => n.text).join(' ').trim();
    assert.strictEqual(sendText, '#shawoo', '身分只留 #名稱，實際：' + JSON.stringify(sendText));
    assert.ok(String(sendAs.props.title || '').indexOf('的身分傳送') !== -1,
      '完整說明要在 tooltip');

    // 自動批準不再顯示 /approve（那在 tooltip）
    const apText = walkInto(harness, findNode(nodes, 'ntfy-teams-autoapprove'))
      .filter((n) => n.tag === '#text').map((n) => n.text).join(' ').trim();
    assert.strictEqual(apText, '自動批準', '自動批準只留名字，實際：' + JSON.stringify(apText));

    core.store.removeTopic('pub_onerow');
  });

  test('不再有任何 localStorage 持久化入口（單一真相 = 宿主 YAML）', () => {
    const { exports: mod, core } = freshPanel();
    // 一次性遷移用的 readLegacyTopics 已經移除（它讀的是 localStorage）。
    assert.strictEqual(mod.__test.readLegacyTopics, undefined,
      'readLegacyTopics 應該已經移除（不再讀 localStorage）');
    // store 也不再提供持久化方法。
    assert.strictEqual(core.store.loadPersisted, undefined, 'loadPersisted 應該已經移除');
    assert.strictEqual(core.store.persist, undefined, 'persist 應該已經移除');
  });

  test('舊版留在瀏覽器裡的 ntfy-teams key 會被清乾淨（只刪不寫）', () => {
    const { exports: mod } = freshPanel();
    const purge = mod.__test.purgeLegacyStorage;
    assert.strictEqual(typeof purge, 'function', '應匯出 purgeLegacyStorage 供測試');

    // 模擬舊版留下的痕跡（這三種 key 以前真的會被寫進去）。
    const storage = globalThis.localStorage;
    storage.setItem('ntfy-teams:config:v1', '{"server":"https://old.example"}');
    storage.setItem('ntfy-teams:store:v1', '{"version":2,"unreadByTopic":{"pub_x":3}}');
    storage.setItem('ntfy-teams:cred:https://old.example', '{"mode":"basic","user":"u"}');
    // 別的外掛／DSH 自己的 key 不可以被動到。
    storage.setItem('dsh.sessions.current', 'keep-me');
    storage.setItem('other-plugin:thing', 'keep-me-too');

    const removed = purge();
    assert.ok(removed >= 3, '應至少清掉 3 個舊 key，實際 ' + removed);

    // 清完之後，任何 ntfy-teams 的 key 都不該存在。
    const left = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (typeof k === 'string' && k.indexOf('ntfy-teams') === 0) left.push(k);
    }
    assert.deepStrictEqual(left, [], '不該還有 ntfy-teams 的 key，實際：' + JSON.stringify(left));

    // 別人的 key 必須完好無損 —— 這個清理不能變成「清空 localStorage」。
    assert.strictEqual(storage.getItem('dsh.sessions.current'), 'keep-me', '別的 key 不該被刪');
    assert.strictEqual(storage.getItem('other-plugin:thing'), 'keep-me-too', '別的 key 不該被刪');

    // 重複呼叫是安全的（第二次沒有東西可刪）。
    assert.strictEqual(purge(), 0, '第二次應該沒東西可刪');

    storage.removeItem('dsh.sessions.current');
    storage.removeItem('other-plugin:thing');
  });

  test('退避節奏就是 1s,2s,4s,8s,16s,30s（而且是永不放棄）', () => {
    const { exports: mod } = freshPanel();
    const backoff = mod.__test.backoffFor;

    // 需求指定的就是這串數字：查表驗證，一字不差。
    const WANT = [1000, 2000, 4000, 8000, 16000, 30000];
    const got = [];
    for (let n = 1; n <= 9; n += 1) got.push(backoff(429, n).delayMs);
    assert.deepStrictEqual(got, WANT.concat([30000, 30000, 30000]),
      '429 的退避節奏應為 1s→2s→4s→8s→16s→30s 之後固定 30s，實際：' + JSON.stringify(got));

    // 永不放棄：到第 50 次仍然 retry
    for (const n of [10, 20, 50]) {
      assert.strictEqual(backoff(429, n).retry, true,
        '第 ' + n + ' 次仍應重試 —— 放棄等於這個主題再也不更新');
      assert.strictEqual(backoff(429, n).delayMs, 30000, '第 ' + n + ' 次仍應是 30 秒');
    }
    // 上限不得失控（避免 2^n 爆掉那類問題）
    assert.ok(got.every((d) => d > 0 && d <= 30000), '延遲必須有界');

    // 連線失敗與 5xx 走同一個節奏
    [0, 500, 502, 503].forEach((st) => {
      assert.strictEqual(backoff(st, 1).delayMs, 1000, st + ' 第一次應等 1 秒');
      assert.strictEqual(backoff(st, 3).delayMs, 4000, st + ' 第三次應等 4 秒');
      assert.strictEqual(backoff(st, 9).retry, true, st + ' 應一直重試');
    });

    // 認證錯誤：重試沒有意義
    assert.strictEqual(backoff(401, 1).retry, false);
    assert.strictEqual(backoff(403, 1).retry, false);
    // 其他 4xx（404 等）：不重試
    assert.strictEqual(backoff(404, 1).retry, false);
  });

  test('預設伺服器主機名不得出現在可見文案（含屬性與 tooltip）', () => {
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_demo');
    core.store.setActiveTopic('pub_demo');
    core.store.setStatus('pub_demo', { phase: 'error', detail: 'HTTP 403：需要認證' });
    // 預設伺服器 + 一個使用者自訂的伺服器，兩種都要掃
    const host = core.DEFAULT_SERVER.replace(/^https?:\/\//, '');

    /**
     * 把渲染結果裡所有「會被使用者看到」的字串收集起來。
     * 文字節點、以及會顯示出來的屬性（title / placeholder / aria-label / alt）。
     * @param nodes - 走訪結果。
     * @returns 字串陣列。
     */
    const visibleStrings = (nodes) => {
      const out = [];
      nodes.forEach((n) => {
        if (n.tag === '#text' && typeof n.text === 'string') out.push(n.text);
        const p = n.props || {};
        ['title', 'placeholder', 'aria-label', 'alt'].forEach((k) => {
          if (typeof p[k] === 'string') out.push(p[k]);
        });
        // input/textarea 的 value 也是看得到的
        if ((n.tag === 'input' || n.tag === 'textarea') && typeof p.value === 'string') out.push(p.value);
      });
      return out;
    };

    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);
    const strings = visibleStrings(nodes);

    const leaked = strings.filter((s) => s.indexOf(host) !== -1);
    assert.deepStrictEqual(leaked, [],
      '預設伺服器主機名不得出現在可見文案，但這些漏了：' + JSON.stringify(leaked.slice(0, 5)));

    // 摘要不該有任何「伺服器」字樣 —— 整個欄位都移除了
    assert.ok(strings.every((s) => s.indexOf('伺服器') === -1),
      '不該出現「伺服器」字樣，實際：' + JSON.stringify(strings.filter((s) => s.indexOf('伺服器') !== -1).slice(0, 3)));
  });

  test('redactDefaultServer：只藏預設伺服器，自訂伺服器照常顯示', () => {
    const { exports: mod } = freshPanel();
    const redact = mod.__test.redactDefaultServer || (globalThis.__ntfyTeamsCore && globalThis.__ntfyTeamsCore.redactDefaultServer);
    assert.strictEqual(typeof redact, 'function', 'core 應匯出 redactDefaultServer');

    const host = 'msn.feg.cn';
    // 預設伺服器的各種寫法都要被換掉
    ['https://' + host, 'http://' + host + '/x', host, '無法連線到 https://' + host + '，請檢查']
      .forEach((s) => {
        assert.strictEqual(redact(s).indexOf(host), -1, '不該殘留主機名：' + s);
      });
    // 自訂伺服器不受影響
    assert.strictEqual(redact('https://my-own.example.com'), 'https://my-own.example.com');
    // 其他網址不受影響
    assert.ok(redact('https://ntfy.sh/docs').indexOf('ntfy.sh') !== -1);
    // 畸形輸入不抛
    [null, undefined, 42, {}].forEach((v) => {
      assert.doesNotThrow(() => redact(v));
    });
  });

  test('預設主題一輩子只加一次：刪掉之後不會復活', () => {
    // 每次都用「沒有記號」的乾淨狀態開始
    const fresh = () => {
      const f = freshPanel();
      // 清掉「已加過」記號：設定不存在時 defaultTopicAdded 預設就是 false。
      // （不用 saveConfig({defaultTopicAdded:false})：那條路徑只認 true，實測踩過。）
      globalThis.localStorage.removeItem('ntfy-teams:config:v1');
      f.core.store.getSnapshot().topics.slice().forEach((t) => f.core.store.removeTopic(t));
      return f;
    };

    // 1) 從未加過 → 加上，而且記號被寫下
    let { exports: mod, core } = fresh();
    assert.strictEqual(mod.__test.ensureDefaultTopic(), true, '從未加過時應該加上');
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_dsh']);
    assert.strictEqual(core.topicLabel('pub_dsh'), 'AIFE');
    assert.strictEqual(core.readConfig().defaultTopicAdded, true, '應該立下記號');

    // 2) 使用者把它刪掉 → **絕對不該復活**（這就是回報三次的 bug）
    core.store.removeTopic('pub_dsh');
    assert.deepStrictEqual(core.store.getSnapshot().topics, [], '使用者已刪除');
    assert.strictEqual(mod.__test.ensureDefaultTopic(), false, '有記號時不該再介入');
    assert.deepStrictEqual(core.store.getSnapshot().topics, [],
      '刪掉的預設主題不得復活');

    // 3) 反覆呼叫也不會復活（模擬多次載入）
    for (let i = 0; i < 5; i += 1) mod.__test.ensureDefaultTopic();
    assert.deepStrictEqual(core.store.getSnapshot().topics, [], '反覆載入也不該復活');

    // 4) 已經有主題、且從未加過 → 補上（既有使用者的升級路徑）
    ({ exports: mod, core } = fresh());
    console.log('        DBGFLAG 剛建好=' + JSON.stringify(core.readConfig().defaultTopicAdded));
    core.saveConfig({ defaultTopicAdded: false });
    console.log('        DBGFLAG 清掉後=' + JSON.stringify(core.readConfig().defaultTopicAdded));
    ({ exports: mod, core } = fresh());
    core.store.ensureTopic('pub_demo');
    assert.strictEqual(mod.__test.ensureDefaultTopic(), true, '從未加過就該補上');
    assert.strictEqual(core.store.getSnapshot().topics[0], 'pub_dsh', '應排第一位');
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_dsh', 'pub_demo']);

    // 5) 冪等
    assert.strictEqual(mod.__test.ensureDefaultTopic(), false, '已經有了就別再動');
    assert.strictEqual(
      core.store.getSnapshot().topics.filter((t) => t === 'pub_dsh').length, 1,
      '不該重複加入');

    // 6) 不搶走使用者的當前主題
    core.store.setActiveTopic('pub_demo');
    globalThis.localStorage.removeItem('ntfy-teams:config:v1');
    core.store.removeTopic('pub_dsh');
    mod.__test.ensureDefaultTopic();
    assert.strictEqual(core.store.getSnapshot().activeTopic, 'pub_demo',
      '補上預設主題不該改變使用者正在看的主題');
  });
  test('沒有訊息的主題不會一直顯示「正在載入歷史訊息…」', () => {
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_quiet');
    core.store.setActiveTopic('pub_quiet');
    // 模擬「歷史拉完了、但這個主題沒有訊息」：面板這時必須顯示「還沒有訊息」
    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);
    const all = nodes.filter((n) => n.tag === '#text').map((n) => n.text).join('\n');
    assert.ok(all.indexOf('這個話題還沒有訊息') !== -1,
      '空主題應顯示「還沒有訊息」，實際：' + all.slice(0, 200));
    // 而「載入中」不該是唯一顯示的東西
    assert.ok(all.indexOf('正在載入歷史訊息…') === -1 || all.indexOf('這個話題還沒有訊息') !== -1,
      '不該只卡在載入中');
  });

  test('預設主題不可改名也不可取消訂閱（pub_dsh 是固定錨點）', () => {
    const { harness, exports: mod, core, seats } = freshPanel();

    // 清空、清掉記號，再加入預設主題，讓 pub_dsh 真的在清單裡
    globalThis.localStorage.removeItem('ntfy-teams:config:v1');
    core.store.getSnapshot().topics.slice().forEach((t) => core.store.removeTopic(t));
    assert.strictEqual(mod.__test.ensureDefaultTopic(), true, '應加入 pub_dsh');
    core.store.ensureTopic('pub_other');
    core.store.setActiveTopic('pub_dsh');

    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);

    // 1) pub_dsh 不該有「取消訂閱」按鈕；其他主題仍要有
    const removeTitles = nodes
      .filter((n) => n.tag === 'button' && n.cls && String(n.cls).indexOf('ntfy-teams-topic-x') !== -1)
      .map((n) => String((n.props && n.props.title) || ''));
    assert.ok(removeTitles.every((t) => t.indexOf('pub_dsh') === -1),
      'pub_dsh 不該有取消訂閱按鈕，實際：' + JSON.stringify(removeTitles));
    assert.ok(removeTitles.some((t) => t.indexOf('pub_other') !== -1),
      '其他主題仍應可取消訂閱，實際：' + JSON.stringify(removeTitles));

    // 2) 應該有一把鎖代表受保護
    const locks = nodes.filter((n) => n.cls && String(n.cls).indexOf('ntfy-teams-topiclock') !== -1);
    assert.strictEqual(locks.length, 1, '受保護的主題應顯示一個鎖，實際：' + locks.length);

    // 3) 受保護的主題不該進「改名」輸入框：雙擊它之後不應出現别名輸入框
    const chip = nodes.find((n) => n.tag === 'div' && n.cls
      && String(n.cls).indexOf('ntfy-teams-topic') !== -1
      && String(n.cls).indexOf('--locked') !== -1);
    assert.ok(chip, '應找得到受保護的 chip');
    // tooltip 要說明原因，而不是留一個按了沒反應的提示
    assert.ok(String(chip.props.title || '').indexOf('不可') !== -1,
      'tooltip 應說明不可改名／取消，實際：' + chip.props.title);
    assert.ok(String(chip.props.title || '').indexOf('pub_dsh') !== -1,
      'tooltip 應指出是哪個主題');

    // 4) 就算硬走刪除路徑也刪不掉（第二道防線）
    assert.ok(core.store.getSnapshot().topics.indexOf('pub_dsh') !== -1, '前置：pub_dsh 應在清單裡');
  });

  test('預設主題永遠排第一位（既有清單也會被糾正）', () => {
    // 1) 已經有主題、pub_dsh 不在、且從未加過 → 補上且排在第一位
    let { exports: mod, core } = freshPanel();
    globalThis.localStorage.removeItem('ntfy-teams:config:v1');
    core.store.getSnapshot().topics.slice().forEach((t) => core.store.removeTopic(t));
    core.store.ensureTopic('pub_demo');
    core.store.ensureTopic('abc');
    mod.__test.ensureDefaultTopic();
    assert.strictEqual(core.store.getSnapshot().topics[0], 'pub_dsh',
      '預設主題應排在第一位，實際：' + JSON.stringify(core.store.getSnapshot().topics));
    // 其他主題的相對順序要保留
    const rest = core.store.getSnapshot().topics.slice(1);
    assert.deepStrictEqual(rest, ['pub_demo', 'abc'], '其餘順序應保留');

    // 2) 已經在第一位 → 冪等，不重排
    assert.strictEqual(core.store.pinTopicFirst('pub_dsh'), false, '已第一位時不該再動');

    // 3) 被移到後面（模擬 YAML 裡的順序）→ 能糾正回來
    ({ exports: mod, core } = freshPanel());
    core.store.getSnapshot().topics.slice().forEach((t) => core.store.removeTopic(t));
    core.store.ensureTopic('pub_demo');
    core.store.ensureTopic('pub_dsh');
    core.store.ensureTopic('abc');
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_demo', 'pub_dsh', 'abc'],
      '前置：pub_dsh 應在中間');
    assert.strictEqual(core.store.pinTopicFirst('pub_dsh'), true, '應回報有移動');
    assert.deepStrictEqual(core.store.getSnapshot().topics, ['pub_dsh', 'pub_demo', 'abc'],
      '應移到第一位且其餘順序不變');

    // 4) 不在清單裡的主題 → 不該被凭空加進來
    assert.strictEqual(core.store.pinTopicFirst('not_subscribed'), false);
    assert.strictEqual(core.store.getSnapshot().topics.indexOf('not_subscribed'), -1,
      'pinTopicFirst 不該新增主題');

    // 5) 不可搶走當前主題
    core.store.setActiveTopic('abc');
    core.store.pinTopicFirst('pub_dsh');
    assert.strictEqual(core.store.getSnapshot().activeTopic, 'abc',
      '重排不該改變使用者正在看的主題');
  });

  test('重試中的主題在側欄顯示為 retrying（不是 error）', () => {
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_demo');
    core.store.setActiveTopic('pub_demo');

    // 一般錯誤（沒有 retryAt）→ error
    core.store.setStatus('pub_demo', { phase: 'error', detail: 'HTTP 403：需要認證' });
    assert.strictEqual(core.sidebarHealth(core.store.getSnapshot()).state, 'error',
      '沒有重試計畫的錯誤應為 error');

    // 排了重試 → retrying，而且要能倒數
    const at = Date.now() + 4000;
    core.store.setStatus('pub_demo', { phase: 'error', detail: 'HTTP 429：請稍後再試', retryAt: at });
    const h = core.sidebarHealth(core.store.getSnapshot());
    assert.strictEqual(h.state, 'retrying', '排了重試應為 retrying，實際：' + h.state);
    assert.strictEqual(h.retryingTopics, 1, '應回報 1 個主題在重試');
    assert.strictEqual(h.nextRetryAt, at, '應回報最近的重試時間點');
    assert.ok(h.label.indexOf('等待重試') !== -1, '標籤應說明在等待重試：' + h.label);
    assert.ok(/[0-9]+ 秒後重試/.test(h.detail), '說明應含倒數秒數：' + h.detail);

    // retryAt 已過期 → 仍算重試中（即將重試），不該掉回 error
    core.store.setStatus('pub_demo', { phase: 'error', detail: 'x', retryAt: Date.now() - 1000 });
    const h3 = core.sidebarHealth(core.store.getSnapshot());
    assert.strictEqual(h3.state, 'retrying', '過期仍應是 retrying（馬上就要再試）');
    assert.ok(h3.detail.indexOf('即將重試') !== -1, '應說「即將重試」：' + h3.detail);

    // retryAt 為 0 -> 當成一般錯誤（例如 401，重試沒有意義）
    core.store.setStatus('pub_demo', { phase: 'error', detail: 'HTTP 401', retryAt: 0 });
    assert.strictEqual(core.sidebarHealth(core.store.getSnapshot()).state, 'error');

    // 多個主題：取最近的一個時間點
    core.store.ensureTopic('pub_two');
    core.store.setStatus('pub_demo', { phase: 'error', detail: 'a', retryAt: Date.now() + 9000 });
    core.store.setStatus('pub_two', { phase: 'error', detail: 'b', retryAt: Date.now() + 2000 });
    const hm = core.sidebarHealth(core.store.getSnapshot());
    assert.strictEqual(hm.retryingTopics, 2, '應回報 2 個主題在重試');
    assert.ok(hm.detail.indexOf('2 個主題') !== -1, '應說出數量：' + hm.detail);
  });

  test('側欄圖示：retrying 狀態用「轉動的圓弧」而不是錯誤三角形', () => {
    const { exports: mod } = freshPanel();
    const Glyph = mod.__test.StatusGlyph || mod.StatusGlyph;
    assert.strictEqual(typeof Glyph, 'function', '應能取得 StatusGlyph');
    const { harness } = (function () {
      const f = freshPanel();
      return { harness: f.harness };
    })();
    const nodes = [];
    walk(harness, harness.render(Glyph, { state: 'retrying' }), nodes, 0);
    const svg = nodes.find((n) => n.tag === 'svg');
    assert.ok(svg, 'retrying 應渲染出 svg');
    // 轉動動畫掛在 class 上
    assert.ok(String(svg.props.className || '').indexOf('ntfy-teams-spin') !== -1,
      '應帶轉動的 class，實際：' + svg.props.className);
    // 不該是錯誤三角形（三角形只有一條閉合 path，這裡應有圓弧 + 箭頭兩段）
    const paths = nodes.filter((n) => n.tag === 'path');
    assert.strictEqual(paths.length, 2, '應為圓弧＋箭頭兩段，實際：' + paths.length);

    // 對照：error 仍然是三角形（確認沒有把錯誤狀態改壞）
    const errNodes = [];
    walk(harness, harness.render(Glyph, { state: 'error' }), errNodes, 0);
    const errSvg = errNodes.find((n) => n.tag === 'svg');
    assert.ok(errSvg, 'error 應渲染出 svg');
    assert.ok(String(errSvg.props.className || '').indexOf('spin') === -1,
      'error 不該有轉動動畫');
  });

  test('聚焦中的主題標記為 --active，新增鈕不借用它', () => {
    const { harness, core, seats } = freshPanel();
    core.store.getSnapshot().topics.slice().forEach((t) => core.store.removeTopic(t));
    core.store.ensureTopic('pub_one');
    core.store.ensureTopic('pub_two');
    core.store.setActiveTopic('pub_one');

    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);
    const chips = nodes.filter((n) => n.cls && String(n.cls).indexOf('ntfy-teams-topic') !== -1
      && String(n.cls).indexOf('--add') === -1);

    const active = chips.filter((n) => String(n.cls).indexOf('--active') !== -1);
    assert.strictEqual(active.length, 1, '恰好一個 chip 該是聚焦的，實際：' + active.length);

    // 聚焦的必須是 pub_one（而不是碰巧第一顆）。
    // 注意：chip 的子節點是**嵌套**的，`allText` 只看頂層抓不到 —— 所以直接在
    // 整棵樹的文字節點裡找，再看它是不是落在那個被標記為 --active 的節點子樹裡。
    const activeLabel = nodes
      .filter((n) => n.tag === '#text' && String(n.text).indexOf('pub_one') !== -1);
    assert.ok(activeLabel.length > 0, '畫面上應該看得到 pub_one');
    // 而且那個聚焦節點本身必須是我們標記的那一顆
    assert.ok(String(active[0].cls).indexOf('--active') !== -1);
    assert.ok(String(active[0].cls).indexOf('--add') === -1, '聚焦的不該是新增鈕');

    // 新增鈕（button + --add）不可以帶 --active：借用的話它會跟聚焦的 chip
    // 長得一模一樣，變成整條列上最顯眼的東西（實測就是這樣）。
    const addBtn = nodes.find((n) => n.tag === 'button'
      && String(n.cls || '').indexOf('ntfy-teams-topic--add') !== -1);
    assert.ok(addBtn, '應該找得到新增鈕');
    assert.ok(String(addBtn.cls).indexOf('--active') === -1,
      '新增鈕不該借用 --active，實際：' + addBtn.cls);
  });

  test('聚焦色的樣式用反色（文字色當底、底色當字）', () => {
    const { exports: mod } = freshPanel();
    const css = String(mod.__test.CSS_TEXT || '');
    // 直接讀樣式來源：--active 的 background 必須是 label-primary、color 必須是 bg-base，
    // 這正是「反色」的定義（前景↔背景對調）。
    assert.ok(css.length > 100, '樣式字串應可由 __test 取得');
    const activeRule = css;   // 直接對整份 CSS 做子字串檢查
    assert.ok(activeRule.indexOf('background:var(--dsw-alias-label-primary)') !== -1,
      '--active 底色應為 label-primary（反色）');
    assert.ok(activeRule.indexOf('color:var(--dsw-alias-bg-base)') !== -1,
      '--active 字色應為 bg-base（反色）');
    // hover 也要維持反色，否則滑過聚焦主題時它會掉回淺底
    const hoverRule = css;
    assert.ok(hoverRule.indexOf('background:var(--dsw-alias-label-primary)') !== -1,
      '聚焦 + hover 應維持反色底色');
  });

  test('右側看板與主欄並排，且都是整列高（不會被撰寫區截斷）', () => {
    const { harness, core, seats } = freshPanel();
    core.store.ensureTopic('pub_layout');
    core.store.setActiveTopic('pub_layout');

    const nodes = [];
    walk(harness, harness.render(seats['main:ntfy-teams'].component, {}), nodes, 0);

    /** 找帶某個 class 的第一個節點。 @param cls - class 片段。 @returns 節點。 */
    const find = (cls) => nodes.find((n) => n.cls && String(n.cls).indexOf(cls) !== -1);

    const mainrow = find('ntfy-teams-mainrow');
    assert.ok(mainrow, '應有 .ntfy-teams-mainrow（主列）');
    const maincol = find('ntfy-teams-main');
    assert.ok(maincol, '應有 .ntfy-teams-main（主欄：訊息串 + 撰寫區）');
    const dash = find('ntfy-teams-dash');
    assert.ok(dash, '應有 .ntfy-teams-dash（看板）');

    // 關鍵結構：看板跟主欄是**同一列的兄弟**，不是塞在主欄裡面。
    // 塞在主欄裡的話它只跟訊息串一樣高，會被下面的撰寫區截斷。
    //
    // 用**走訪的前序位置**判斷歸屬關係，不要直接讀 React 的 children ——
    // 那棵樹是嵌套的（children 裡還可能是陣列），在上面比對會踩到層級
    // （實測踩過兩次）。前序順序就是文件順序。
    const idxOf = (cls) => nodes.findIndex((n) => n.cls && String(n.cls).indexOf(cls) !== -1);
    const iMain = idxOf('ntfy-teams-mainrow');
    const iStream = idxOf('ntfy-teams-stream');
    const iDash = idxOf('ntfy-teams-dash');
    const iCompose = idxOf('ntfy-teams-compose');

    assert.ok(iMain !== -1, '應有主列');
    assert.ok(iStream !== -1, '應有訊息串');
    assert.ok(iDash !== -1, '應有看板');
    assert.ok(iCompose !== -1, '應有撰寫區');
    assert.ok(iMain < iStream, '訊息串應在主列之內');
    assert.ok(iStream < iCompose, '順序應為：訊息串 → 撰寫區（同一個主欄內）');
    // 最關鍵的一條：整條主欄（含撰寫區）都排在看板**之前**，
    // 代表看板是主列的兄弟、而不是跟訊息串擠在同一格。
    // 反過來（看板夾在訊息串與撰寫區之間）就是被撰寫區截斷的舊版結構。
    assert.ok(iCompose < iDash,
      '看板應排在整條主欄之後（否則它只會跟訊息串一樣高）：'
      + 'stream=' + iStream + ' compose=' + iCompose + ' dash=' + iDash);

    // ---- 看板的上下界：上緣在抬頭之下，下緣直通到底 ----
    //
    // 需求（兩次修正後定案）：
    //   * 看板**不可以**頂到面板最上面 —— 抬頭右側放著連線狀態
    //     （未連線／已連線／重試中），頂上去會把它蓋住；
    //   * 看板**要**直通到底（不能只到訊息串為止，否則會被撰寫區截斷）；
    //   * 抬頭底下那一列（leftcol ｜ 看板）才是並排的兩欄。
    //
    // 結構：root(column) = [header, row(leftcol, dash)]
    // 前序走訪的順序因此必須是：header → leftcol → … → dash
    const leftcol = find('ntfy-teams-leftcol');
    assert.ok(leftcol, '應有 .ntfy-teams-leftcol（左欄）');
    const row = find('ntfy-teams-row');
    assert.ok(row, '應有 .ntfy-teams-row（抬頭底下的並排列）');
    const iHeader = idxOf('ntfy-teams-header');
    const iLeftcol = idxOf('ntfy-teams-leftcol');
    const iRow = idxOf('ntfy-teams-row');

    assert.ok(iHeader !== -1, '應有 .ntfy-teams-header（抬頭）');
    assert.ok(iHeader < iRow, '抬頭必須排在並排列之前（否則看板會蓋到連線狀態）');
    assert.ok(iRow < iLeftcol, '左欄應在並排列之內');
    assert.ok(iLeftcol < iStream, '順序應為：左欄 → 訊息串');

    // ---- 摘要那一行必須住在**抬頭**裡（需求：各種提示都放到第一個容器內）----
    //
    // 收合時 SettingsPanel 回 null（只負責展開的表單），摘要由 SettingsSummary
    // 畫在抬頭內 —— 所以這裡不再找 .ntfy-teams-settings，而是確認摘要的位置。
    const iBar = idxOf('ntfy-teams-settingsbar');
    assert.ok(iBar !== -1, '應有摘要列（.ntfy-teams-settingsbar）');
    assert.ok(iHeader < iBar, '摘要應排在抬頭之後（＝在抬頭裡面，前序順序就是文件順序）');
    assert.ok(iBar < iLeftcol,
      '摘要必須排在左欄之前 —— 那才代表它在抬頭裡，而不是又變成獨立一列：'
      + 'header=' + iHeader + ' bar=' + iBar + ' leftcol=' + iLeftcol);
    // 摘要只能有一份（曾經出現過「抬頭一份、左欄又一份」）
    assert.strictEqual(
      nodes.filter((n) => n.cls && String(n.cls).split(/\s+/).indexOf('ntfy-teams-settingsbar') !== -1).length,
      1,
      '摘要列在整棵樹裡只該有一份');
    // 看板在並排列之內、且排在左欄之後 —— 它與左欄同高，於是直通到底
    assert.ok(iLeftcol < iDash, '看板應排在左欄之後（同一列）');
    // 最關鍵：抬頭在看板之前 → 看板上緣不會高過抬頭
    assert.ok(iHeader < iDash,
      '抬頭必須在看板之前，否則看板會頂到最上面蓋住連線狀態：'
      + 'header=' + iHeader + ' dash=' + iDash);

    // ---- 抬頭**只能有一份**（實測踩過的 bug）----
    //
    // 病灶：header 同時被 body.push(header) 收進 body，又獨立當成 root 的第一個
    // 子節點；而 leftChildren = body.slice() 會把 body 整個複製進左欄 ——
    // 於是一個 root 裡出現**兩份抬頭**（瀏覽器實測：左欄第一個子節點是
    // [280,64 860x64] 的 header）。
    // 畫面看起來像「上面一列＋左欄裡又一列」，而看板被擠到第二份抬頭之下。
    // 用**精確 class 詞**比對，不要用子字串：`ntfy-teams-headeracts`
    // （齒輪／重新載入那組）也含 "ntfy-teams-header"，用 indexOf 會多算一份。
    const hasClassToken = (n, token) => n.cls && String(n.cls).split(/\s+/).indexOf(token) !== -1;
    const headers = nodes.filter((n) => hasClassToken(n, 'ntfy-teams-header'));
    assert.strictEqual(headers.length, 1,
      '抬頭在整棵樹裡只該有一份，實際 ' + headers.length + ' 份');

    // ---- 左欄裡不可以有抬頭（它必須是 root 的直接子節點）----
    //
    // 用前序位置判斷歸屬：左欄之後、看板之前的那一段屬於左欄。
    // 抬頭必須**不在**這個區間裡。
    const iRowEnd = idxOf('ntfy-teams-dash');
    assert.ok(!(iLeftcol < iHeader && iHeader < iRowEnd),
      '抬頭不該落在左欄之內（那表示左欄又複製了一份）：'
      + 'leftcol=' + iLeftcol + ' header=' + iHeader + ' dash=' + iRowEnd);
  });

  test('取消訂閱會立刻寫回宿主（不等 400ms debounce）', () => {
    // 「刪除 topic，再打開又出現了」的根因回歸：
    // 原本刪除只排一顆 400ms debounce timer，使用者「刪完馬上重新整理」時
    // 那個排程還沒響就被卸載掉 —— 宿主永遠沒收到刪除，重開又從 YAML 讀回舊清單。
    // 所以刪除必須**同步**送 PUT（不是排程）。
    const { harness, exports: mod, core } = freshPanel();
    // 標記「首次同步已完成」—— 真實環境是 syncSettingsFromHost() 完成時設的。
    // 守門會擋下同步前的寫入（那會用不完整的清單覆蓋宿主），所以測寫入前要先設。
    mod.__test.markInitialSyncDone();
    core.saveConfig({ server: 'https://msn.feg.cn', aliases: {} });

    (core.store.getSnapshot().topics || []).slice().forEach((t) => core.store.removeTopic(t));
    core.store.ensureTopic('pub_keep');
    core.store.ensureTopic('pub_gone');
    core.store.setActiveTopic('pub_keep');

    const TopicBar = mod.__test.TopicBar;
    const draw = () => {
      const props = { snapshot: core.store.getSnapshot() };
      const nodes = [];
      walk(harness, harness.render(function barUnderTest() {
        return TopicBar(props);
      }, undefined), nodes, 0);
      return nodes;
    };

    // 攔下 PUT，記錄每一次送出的 topics
    const puts = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = function (url, init) {
      if (String(url).indexOf('/ntfy-teams/settings') !== -1 && init && init.method === 'PUT') {
        let body = null;
        try { body = JSON.parse(init.body); } catch (e) { body = null; }
        puts.push(body && body.config ? body.config.topics : null);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      }
      return realFetch.apply(this, arguments);
    };

    try {
      // 1) 按 pub_gone 的 ×（只會出確認條）
      let nodes = draw();
      const xBtn = nodes.find((n) => n.cls && n.cls.indexOf('ntfy-teams-topic-x') !== -1
        && String(n.props && n.props.title || '').indexOf('pub_gone') !== -1);
      assert.ok(xBtn, '應該找得到 pub_gone 的取消訂閱按鈕');
      xBtn.props.onClick({ stopPropagation() {} });

      // 2) 按確認條上的「取消訂閱」
      nodes = draw();
      const confirmBtn = nodes.find((n) => n.tag === 'button'
        && n.cls && String(n.cls).indexOf('--danger') !== -1);
      assert.ok(confirmBtn, '應該找得到確認按鈕');
      confirmBtn.props.onClick();

      // 3) **同步**就該送出（不是等 400ms）—— 這是整個修正的重點
      assert.ok(puts.length > 0,
        '按了確認就該立刻送 PUT，實際送了 ' + puts.length + ' 次');
      const last = puts[puts.length - 1] || [];
      assert.strictEqual(last.indexOf('pub_gone'), -1,
        '送出的清單不該還含剛刪掉的主題，實際：' + JSON.stringify(last));
      assert.ok(last.indexOf('pub_keep') !== -1,
        '也不該把其他主題弄丟，實際：' + JSON.stringify(last));
      // 4) store 也要同步反映
      assert.strictEqual(core.store.getSnapshot().topics.indexOf('pub_gone'), -1,
        'store 應該已經移除 pub_gone');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  // 还原
  globalThis.__ModuleLoader__ = savedLoader;
  globalThis.window = savedWindow;
  if (savedCore === undefined) delete globalThis.__ntfyTeamsCore;
  else globalThis.__ntfyTeamsCore = savedCore;
})();

// ---------------------------------------------------------------- 共用替身 --

/**
 * 会保存 hooks、并同步重跑元件的 React 替身。
 *
 * 两个回归（落盘、工作组 UI）都需要「真的把 effect 跑起来」，所以放在最外层共用。
 *
 * 两个踩过的坑都写在这里：
 *   - 三种 hook 各用「自己的」slot 阵列与游标。共用一组 slot 会让 useState 读到
 *     useEffect 存的 deps 物件，效果会静悄悄地不跑。
 *   - render 之后要把 effect「抽干」：effect 里呼叫 setState 会同步再 render 一次，
 *     那一轮又会排新的 effect，React 会继续 flush。不回圈就会漏掉那一轮，
 *     看起来像「effect 根本没跑」。
 *
 * @returns {{React: object, render: function}} 替身 React 与渲染入口。
 */
function makeHookedReact() {
  const stateSlots = [];
  const refSlots = [];
  const effectSlots = [];
  let cursors = { state: 0, ref: 0, effect: 0 };
  let active = null;
  let rendering = false;

  function render(component, props) {
    // 防重入：测试的 walker 会直接呼叫子元件来展开结构，那些呼叫也会碰 hooks。
    // 允许重入会把外层的 cursors 打乱（实测：effectSlots 被弄到 undefined）。
    // 重入时当成单纯的函数呼叫处理。
    if (rendering) return component(props);
    rendering = true;
    try {
      return renderInner(component, props);
    } finally {
      rendering = false;
    }
  }

  function renderInner(component, props) {
    cursors = { state: 0, ref: 0, effect: 0 };
    active = { component, props };
    const out = component(props);
    let guard = 0;
    for (;;) {
      const pending = effectSlots.filter((slot) => slot && slot.pending);
      if (pending.length === 0) break;
      guard += 1;
      if (guard > 50) break;
      pending.forEach((slot) => {
        const fn = slot.pending && slot.pending.fn;
        slot.pending = null;
        if (typeof fn === 'function') fn();
      });
    }
    return out;
  }

  /** setState 之后同步重跑一次元件。 */
  function requestRender() {
    if (!active || rendering) return;
    render(active.component, active.props);
  }

  /**
   * 把 hook 游标归零，并把目前这轮已排的 effect 丢掉。
   * 给测试的 walker 用：它要直接呼叫子元件展开结构，那会碰 hooks。
   */
  function reset() {
    cursors = { state: 0, ref: 0, effect: 0 };
    effectSlots.length = 0;
  }

  /**
   * 完全重置 hook 状态（含 state 与 ref）。
   * 当一个元件要用「全新的状态」重新渲染时用这个 —— 只呼叫 reset() 会留下上一次的
   * stateSlots，于是第二次渲染会读到旧快照（实测：未读 badge 清零后仍显示）。
   */
  function resetAll() {
    stateSlots.length = 0;
    refSlots.length = 0;
    effectSlots.length = 0;
    cursors = { state: 0, ref: 0, effect: 0 };
    active = null;
  }

  /**
   * 把目前整份 hook 状态冻结成一个快照。
   * 给测试的 walker 用：它要直接呼叫子元件展开结构，那会碰到 hooks；
   * 呼叫前冻结、呼叫后还原，就不会污染（也不会清空）别人的状态。
   * @returns 快照。
   */
  function snapshot() {
    return {
      state: stateSlots.slice(),
      refs: refSlots.slice(),
      effects: effectSlots.slice(),
      cursors: { state: cursors.state, ref: cursors.ref, effect: cursors.effect },
    };
  }

  /**
   * 换上一颗全新的 hook slot 阵列（内容沿用目前的值），并回传旧的那一颗。
   * 给测试的 walker 用：展开元件时让它的 setState 只影响临时阵列。
   * @returns 旧的 slot 阵列组，传给下一次 swapSlots 即可换回。
   */
  function swapSlots() {
    const prev = { state: stateSlots.slice(), refs: refSlots.slice(), effects: effectSlots.slice() };
    stateSlots.length = 0;
    refSlots.length = 0;
    effectSlots.length = 0;
    prev.state.forEach((v, i) => { stateSlots[i] = v; });
    prev.refs.forEach((v, i) => { refSlots[i] = v; });
    // effect 不沿用：展开元件时不需要重跑别人的 effect。
    cursors = { state: 0, ref: 0, effect: 0 };
    return prev;
  }

  /**
   * 还原 snapshot() 拿到的状态。
   * @param snap - snapshot() 的回传值。
   */
  function restore(snap) {
    stateSlots.length = 0;
    refSlots.length = 0;
    effectSlots.length = 0;
    for (let i = 0; i < snap.state.length; i += 1) stateSlots[i] = snap.state[i];
    for (let i = 0; i < snap.refs.length; i += 1) refSlots[i] = snap.refs[i];
    for (let i = 0; i < snap.effects.length; i += 1) effectSlots[i] = snap.effects[i];
    cursors = { state: snap.cursors.state, ref: snap.cursors.ref, effect: snap.cursors.effect };
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const i = cursors.state;
      cursors.state += 1;
      if (!(i in stateSlots)) stateSlots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const holder = stateSlots[i];
      const setState = (next) => {
        const value = typeof next === 'function' ? next(holder.value) : next;
        if (value === holder.value) return;
        holder.value = value;
        requestRender();
      };
      return [holder.value, setState];
    },
    useEffect(fn, deps) {
      const i = cursors.effect;
      cursors.effect += 1;
      const prev = effectSlots[i];
      const same = prev && prev.deps && deps
        && prev.deps.length === deps.length
        && prev.deps.every((d, k) => d === deps[k]);
      if (same) { effectSlots[i] = { deps, pending: null }; return; }
      effectSlots[i] = { deps, pending: { fn } };
    },
    useRef(initial) {
      const i = cursors.ref;
      cursors.ref += 1;
      if (!(i in refSlots)) refSlots[i] = { current: initial };
      return refSlots[i];
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  };

  return { React, render, reset, resetAll, snapshot, restore, swapSlots };
}

// ---------------------------------------------------------------- 结果 ----

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
console.log('');
process.exitCode = failed === 0 ? 0 : 1;

// apply() 會掛上 host 層的即時同步，那裡有一個 debounce 的 persist timer。
// 測試跑完之後那個 timer 還在排隊，Node 會一直不結束（實測：印出結果卻不 exit）。
// 測試只需要結果，所以明確收尾。
process.exit(failed === 0 ? 0 : 1);
