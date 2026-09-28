'use strict';

// Contract test for the CLIENT half of fdep-api-request-bundle.
//
// A browser is not available here, so this test reproduces the two contracts
// the client bundle must satisfy and drives the real component tree:
//
//   1. The static-bundle wrapper: the file must call
//      `window.__ModuleLoader__.load({ id, factory })` and the factory must
//      accept the loader's `require` (there is no `React` global).
//   2. The slot contract: `apply(ctx)` must register through
//      `ctx.slots.inject(slotKey, () => ctx.slots.register(options, Component))`
//      with `options.name` equal to the slot key, and every registered
//      component must forward its slot props.
//
// It then renders the panel with a minimal hook dispatcher, finds the real
// buttons by walking the element tree, clicks them, and asserts the resulting
// state transitions. global fetch is stubbed.
//
// Run: node test/client-contract.test.js

const assert = require('node:assert/strict');
const path = require('node:path');

// The bundle source, read once: several checks assert on the stylesheet text
// (token names, the glyph's colour rule) rather than on a rendered tree.
const stylesheetSource = require('node:fs').readFileSync(
  path.join(__dirname, '..', 'lib', 'client.js'), 'utf8',
);

// ---- fake React (no global React exists in a static bundle) ----------------
let hookIndex = 0;
let hookStates = [];

function useState(initial) {
  const i = hookIndex;
  hookIndex += 1;
  if (!(i in hookStates)) {
    hookStates[i] = typeof initial === 'function' ? initial() : initial;
  }
  const setter = function (next) {
    hookStates[i] = typeof next === 'function' ? next(hookStates[i]) : next;
  };
  return [hookStates[i], setter];
}

const fakeReact = {
  createElement(type, props) {    const children = Array.prototype.slice.call(arguments, 2);
    // Real React exposes children as `props.children` as well as in the
    // element's own children slot. Components that render `props.children`
    // (our Button does) depend on that, so the harness must mimic it.
    const merged = Object.assign({}, props || {});
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type: type, props: merged, children: children };
  },
  useState: useState,
  useEffect() {},
};

// ---- fake DOM --------------------------------------------------------------
// The bundle must inject its stylesheet through `document`, because a static
// bundle has no `styles` builtin (that is a dynamic-Package global, like React
// and ctx). `styles` is deliberately NOT defined here, so a regression back to
// the builtin shows up as "no stylesheet was inserted".
const styleTags = [];
const removedTags = [];
globalThis.document = {
  head: {
    appendChild(node) { styleTags.push(node); },
  },
  createElement(tagName) {
    return {
      tagName: tagName,
      attrs: {},
      textContent: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k]; },
      remove() { removedTags.push(this); },
    };
  },
};
globalThis.console = console;

// ---- fake clipboard --------------------------------------------------------
// `copyText` writes through navigator.clipboard.writeText. Node exposes a global
// `navigator` (and it has no clipboard), and that global is an accessor, so it
// must be redefined rather than assigned.
let clipboardWrites = [];
function setClipboard(available) {
  clipboardWrites = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: available
      ? { clipboard: { writeText(text) { clipboardWrites.push(text); return Promise.resolve(); } } }
      : {},
    configurable: true,
    writable: true,
  });
}
setClipboard(true);

// ---- fake module loader ----------------------------------------------------
let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) { loaded = spec; },
  },
};

// ---- load the client bundle ------------------------------------------------
require(path.join(__dirname, '..', 'lib', 'client.js'));

let pass = 0;
function check(label, fn) {
  try {
    fn();
    pass += 1;
    console.log('  [ok]   ' + label);
  } catch (err) {
    console.log('  [FAIL] ' + label + ' :: ' + err.message);
    throw err;
  }
}

// ---- element-tree helpers --------------------------------------------------
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
    return;
  }
  if (node.type) visit(node);
  if (node.children) node.children.forEach((c) => walk(c, visit));
}

// The bundle registers WRAPPER components that forward slot props:
//   (props) => e(Inner, props)
// so a tree returned by a registered component is an element whose `type` is
// still a function. Resolve those until only host elements remain — this is
// what proves prop forwarding actually reaches the inner component.
function renderNode(node) {
  if (Array.isArray(node)) return node.map(renderNode);
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.type === 'function') {
    return renderNode(node.type(node.props));
  }
  if (node.children) {
    return Object.assign({}, node, { children: node.children.map(renderNode) });
  }
  return node;
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return node.children.map(textOf).join('');
  return '';
}

function findButton(tree, label) {
  let found = null;
  walk(tree, (n) => {
    if (n.type === 'button' && textOf(n).indexOf(label) !== -1) found = n;
  });
  return found;
}

// The API-ID box is found by its id, never by its placeholder: the placeholder is
// localized UI text (zh-TW), so matching on it would turn the test into a
// translation canary instead of a contract check.
function findApiIdInput(tree) {
  let found = null;
  walk(tree, (n) => {
    if (n.type === 'input' && n.props.id === 'fdep-api-id') found = n;
  });
  return found;
}

function findAllInputs(tree) {
  const out = [];
  walk(tree, (n) => { if (n.type === 'input') out.push(n); });
  return out;
}

// Find the status strip carrying a given modifier class (e.g.
// 'fdep__status--ok'). Returns the element, or undefined.
function findStatus(tree, modifier) {
  let found;
  walk(tree, (n) => {
    const cls = n.props && n.props.className;
    if (typeof cls === 'string' && cls.indexOf('fdep__status') === 0
      && (!modifier || cls.indexOf(modifier) !== -1)) found = n;
  });
  return found;
}

// Collect every class name used anywhere in a rendered tree.
function classNames(tree) {
  const out = new Set();
  walk(tree, (n) => {
    const cls = n.props && n.props.className;
    if (typeof cls === 'string') cls.split(/\s+/).filter(Boolean).forEach((c) => out.add(c));
  });
  return out;
}

// ---- stubbed fetch ---------------------------------------------------------
let fetchCalls = [];
let fetchBehaviour = 'ok';
// Arms of the host runtime-context route, plus the order in which arming and
// session creation happened (`seq` also gets 'start' from the fake uiWorkspace).
let armCalls = [];
let armBehaviour = 'ok';
let seq = [];
globalThis.fetch = async function (url, init) {
  fetchCalls.push({ url, init });
  if (String(url).indexOf('/plugins/fdep-api-request/context') !== -1) {
    let sent = {};
    try { sent = JSON.parse(init.body); } catch (_) {}
    armCalls.push({ url, body: sent, afterStart: seq.indexOf('start') !== -1 });
    seq.push('arm');
    if (armBehaviour === 'fail') throw new TypeError('Failed to fetch');
    return {
      ok: true, status: 200,
      async json() { return { ok: true, armed: true, api_id: sent.apiId, chars: 100 }; },
      async text() { return JSON.stringify({ ok: true, armed: true }); },
    };
  }
  if (fetchBehaviour === 'cors') throw new TypeError('Failed to fetch');
  let body = {};
  try { body = JSON.parse(init.body); } catch (_) {}
  if (body.do === false) {
    return {
      ok: true, status: 200,
      async text() {
        return JSON.stringify({
          data: {
            docs: {
              desc: 'simplest example',
              name: 'aaa',
              watchlist: ['1402', '4904'],
              limit: 10,
            },
          },
          trace_id: 't-docs',
        });
      },
    };
  }
  return {
    ok: true, status: 200,
    async text() {
      return JSON.stringify({ data: { echoed: body.inbound }, trace_id: 't-exec' });
    },
  };
};

// ---- the test --------------------------------------------------------------
async function main() {
  console.log('=== 1. static-bundle wrapper contract ===');
  check('client.js called window.__ModuleLoader__.load', () => {
    assert.ok(loaded, 'the loader was never invoked');
  });
  check('load() carries the bundle id', () => {
    assert.equal(loaded.id, 'fdep-api-request-bundle');
  });
  check('load() carries a factory function', () => {
    assert.equal(typeof loaded.factory, 'function');
  });

  console.log('\n=== 2. factory contract ===');
  const requireCalls = [];
  function fakeRequire(name) {
    requireCalls.push(name);
    if (name === 'react') return fakeReact;
    throw new Error('unexpected require: ' + name);
  }
  let plugin = null;
  check('factory(require) returns a plugin object', () => {
    plugin = loaded.factory(fakeRequire);
    assert.ok(plugin && typeof plugin === 'object');
  });
  check('factory pulled react through the loader require', () => {
    assert.ok(requireCalls.includes('react'), 'require("react") was not called');
  });
  check('plugin declares inject and apply', () => {
    // `slots` is the only HARD dependency. `uiWorkspace` is optional and is
    // resolved with ctx.inject() inside apply(), so a composition without the
    // workspace plugin still renders the panel instead of parking it.
    assert.deepEqual(plugin.inject, ['slots']);
    assert.equal(typeof plugin.apply, 'function');
  });

  console.log('\n=== 3. apply() registers both slots ===');
  const injections = [];
  const registrations = [];
  const effects = [];
  const ctxInjectCalls = [];
  const fakeCtx = {
    // Optional services must NOT come from ctx.get(): `ReflectService._getImpl`
    // only answers for a provider whose fiber is already ACTIVE, so reading it
    // once here is the bug the "New session" button used to hit (section 12).
    get(name) {
      throw new Error('ctx.get("' + name + '") — optional services resolve through ctx.inject()');
    },
    inject(deps, callback) {
      ctxInjectCalls.push(deps.join(','));
      const disposer = callback({
        uiWorkspace: { startSession() { fakeCtx.startedSession = true; seq.push('start'); } },
      });
      return function () { if (typeof disposer === 'function') disposer(); };
    },
    effect(cb, label) { effects.push({ cb, label }); },
    slots: {
      inject(slotKey, cb) {
        injections.push(slotKey);
        const disposer = cb();
        registrations.push({ slotKey, disposer });
        return function () {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return function disposeEntry() {};
      },
    },
  };
  plugin.apply(fakeCtx);

  check('uiWorkspace is requested through ctx.inject (lazy, not via inject:)', () => {
    assert.deepEqual(ctxInjectCalls, ['uiWorkspace'], 'saw: ' + JSON.stringify(ctxInjectCalls));
  });

  check('slots.inject called for sidebar.panellist', () => {
    assert.ok(injections.includes('sidebar.panellist'), 'saw: ' + injections.join(','));
  });
  check('slots.inject called for main', () => {
    assert.ok(injections.includes('main'), 'saw: ' + injections.join(','));
  });

  const registrationsOnly = registrations.filter((r) => r.options);
  check('exactly two slot entries registered', () => {
    assert.equal(registrationsOnly.length, 2, 'saw ' + registrationsOnly.length);
  });

  const panelEntry = registrationsOnly.find((r) => r.options.name === 'sidebar.panellist');
  const mainEntry = registrationsOnly.find((r) => r.options.name === 'main');
  check('panellist entry carries id/order/label and name==slot key', () => {
    assert.ok(panelEntry, 'panellist entry missing');
    assert.equal(panelEntry.options.name, 'sidebar.panellist');
    assert.equal(panelEntry.options.id, 'fdep-api-request');
    assert.equal(panelEntry.options.order, 50);
    assert.equal(panelEntry.options.label(), 'MCP Gateway');
  });
  check('main entry carries key and name==slot key', () => {
    assert.ok(mainEntry, 'main entry missing');
    assert.equal(mainEntry.options.name, 'main');
    assert.equal(mainEntry.options.key, 'fdep-api-request');
  });
  check('both entries are components', () => {
    assert.equal(typeof panelEntry.component, 'function');
    assert.equal(typeof mainEntry.component, 'function');
  });

  console.log('\n=== 4. ctx.effect receives a FACTORY, not a bare disposer ===');
  check('one effect registered and it is wrapped in a factory', () => {
    assert.equal(effects.length, 1, 'saw ' + effects.length + ' effects');
    // A cordis effect calls cb() and uses the RESULT as the disposer. If the
    // bundle passed a bare disposer instead of a factory, calling cb() would
    // tear the stylesheet down immediately.
    const before = removedTags.length;
    const disposer = effects[0].cb();
    assert.equal(typeof disposer, 'function', 'effect callback did not return a disposer');
    assert.equal(removedTags.length, before, 'effect callback removed the stylesheet on call');
    disposer();
    assert.ok(removedTags.length > before, 'disposer did not remove the stylesheet tag');
  });
  check('stylesheet is injected through document, not a `styles` builtin', () => {
    // The exact production bug: a static bundle has no `styles` global, so a
    // guard on it silently skipped the insertion and the panel rendered naked.
    assert.equal(typeof globalThis.styles, 'undefined', 'the harness must not define `styles`');
    assert.equal(styleTags.length, 1, 'expected exactly one <style> tag, saw ' + styleTags.length);
    const tag = styleTags[0];
    assert.equal(tag.tagName, 'style');
    assert.ok(tag.textContent.indexOf('.fdep {') !== -1, 'the tag does not carry the panel sheet');
    assert.ok(tag.textContent.indexOf('.fdep-glyph') !== -1, 'the tag does not carry the glyph rule');
  });
  check('the style tag is tagged so the HMR swap can own it', () => {
    // Official client plugins set data-plugin; the reload driver removes the
    // previous generation's tag by that marker.
    assert.equal(styleTags[0].getAttribute('data-plugin'), 'fdep-api-request-bundle');
  });

  console.log('\n=== 5. render the sidebar glyph ===');
  let iconTree = null;
  let iconSvg = null;
  check('glyph renders as an inline SVG mark, not a letter', () => {
    iconTree = renderNode(panelEntry.component({ size: 20, active: true }));
    assert.ok(iconTree, 'glyph returned nothing');
    walk(iconTree, (n) => { if (n.type === 'svg') iconSvg = n; });
    assert.ok(iconSvg, 'no <svg> in the glyph tree');
    assert.equal(textOf(iconTree), '', 'the glyph should carry no text');
  });
  check('glyph inherits colour instead of hard-coding it', () => {
    assert.equal(iconSvg.props.stroke, 'currentColor');
    assert.equal(iconSvg.props['aria-hidden'], 'true');
  });
  check('glyph is a hexagon core, not a bare letter', () => {
    const shapes = [];
    walk(iconTree, (n) => { if (n.type === 'path' || n.type === 'circle') shapes.push(n); });
    assert.equal(shapes.length, 2, 'expected a hexagon path plus a core circle');
    const path = shapes.find((s) => s.type === 'path');
    const core = shapes.find((s) => s.type === 'circle');
    // Pointy-top hexagon: six vertices expressed as a closed path.
    assert.match(path.props.d, /^M8 1\.5 /, 'hexagon path should start at the top vertex');
    assert.match(path.props.d, /z$/, 'hexagon path should be closed');
    assert.equal(core.props.fill, 'currentColor', 'the core should be filled');
    assert.ok(Number(core.props.r) > 0, 'the core should have a radius');
  });
  check('glyph colour comes from the green success token', () => {
    // The SVG paints with currentColor; the stylesheet decides what that is.
    // Asserting the token here keeps the "green" requirement testable without
    // pinning a hex value that would be wrong in one of the two themes.
    assert.match(stylesheetSource, /\.fdep-glyph \{[^}]*--dsw-alias-state-success-primary/s);
  });
  check('glyph forwards the active flag into its className', () => {
    assert.match(iconTree.props.className, /fdep-glyph--active/);
    const idle = renderNode(panelEntry.component({ size: 20, active: false }));
    assert.doesNotMatch(idle.props.className, /active/);
  });
  check('glyph respects the requested size', () => {
    assert.equal(iconTree.props.style.width, '20px');
    assert.equal(iconSvg.props.width, 20);
  });

  console.log('\n=== 6. render the main panel and drive it ===');
  const MainComp = mainEntry.component;
  function render(slotProps) {
    hookIndex = 0; // hook order resets each render; state persists
    // Resolve the wrapper chain down to host elements, exercising the same
    // prop-forwarding path the slot renderer uses.
    return renderNode(MainComp(slotProps || {}));
  }

  let tree = render();
  check('API ID starts prefilled with the default api', () => {
    assert.equal(
      findApiIdInput(tree).props.value,
      'twseMops.todayMaterial',
    );
  });
  check('panel heading matches the sidebar label', () => {
    // A nav entry and the panel it opens must agree on the name.
    let heading = null;
    walk(tree, (n) => { if (n.type === 'h2') heading = textOf(n); });
    assert.equal(heading, 'MCP Gateway');
    assert.equal(panelEntry.options.label(), 'MCP Gateway');
  });
  check('panel renders with an API ID input', () => {
    assert.ok(findApiIdInput(tree), 'api id input missing');
  });
  check('panel renders the four action buttons', () => {
    for (const label of ['取得文件', '執行', '複製提示', '開新工作階段']) {
      assert.ok(findButton(tree, label), 'missing button: ' + label);
    }
  });
  check('Run is disabled until docs are fetched', () => {
    assert.equal(findButton(tree, '執行').props.disabled, true);
  });
  check('the session fallbacks are disabled until docs are fetched', () => {
    // Fixing this was a user report: "New session" used to be clickable with no
    // docs loaded, and the brief it produced then had no context at all.
    assert.equal(findButton(tree, '複製提示').props.disabled, true);
    assert.equal(findButton(tree, '開新工作階段').props.disabled, true);
  });

  // --- type an api id ---
  const apiInput = findApiIdInput(tree);
  apiInput.props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  check('typing updates the controlled input value', () => {
    assert.equal(findApiIdInput(tree).props.value, 'test.demo');
  });

  // --- click Fetch docs ---
  fetchCalls = [];
  await findButton(tree, '取得文件').props.onClick();
  tree = render();
  check('fetch docs hit the FDEP endpoint with do:false', () => {
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'https://abc.feg.com.tw/oauth2/fdep');
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.api, 'test.demo');
    assert.equal(sent.do, false);
  });
  check('param form appeared with one control per docs field', () => {
    // Three docs fields (name, watchlist, limit) plus the api-id box.
    const inputs = findAllInputs(tree);
    assert.equal(inputs.length, 3, 'expected 3 <input> elements, saw ' + inputs.length
      + ': ' + JSON.stringify(inputs.map((i) => i.props.id)));
    assert.ok(inputs.some((i) => i.props.id === 'fdep-field-name'), 'no control for field "name"');
    assert.ok(inputs.some((i) => i.props.id === 'fdep-field-limit'), 'no control for field "limit"');
  });
  check('an array field renders a textarea, not a single-line input', () => {
    // The reported bug: `watchlist` is an array in the docs but the form sent
    // a string. A list needs its own control.
    let listBox = null;
    walk(tree, (n) => { if (n.type === 'textarea' && n.props.id === 'fdep-field-watchlist') listBox = n; });
    assert.ok(listBox, 'no textarea for the array field "watchlist"');
    assert.ok(!findAllInputs(tree).some((i) => i.props.id === 'fdep-field-watchlist'),
      'the array field must not also render as a plain input');
  });
  check('each field shows its inferred type and example', () => {
    const types = [];
    walk(tree, (n) => {
      if (n.props && n.props.className === 'fdep__fieldtype') types.push(textOf(n));
    });
    assert.deepEqual(types.sort(), ['array', 'number', 'string']);
    let desc = '';
    walk(tree, (n) => {
      if (n.props && n.props.className === 'fdep__fielddesc'
        && textOf(n).indexOf('watchlist') !== -1) desc = textOf(n);
    });
  });
  check('status strip reports the docs result', () => {
    const strip = findStatus(tree, 'fdep__status--ok');
    assert.ok(strip, 'no ok status strip rendered');
    // The count and the docs desc are data; the frame around them is zh-TW UI text.
    assert.match(textOf(strip), /共 3 個參數/);
    assert.match(textOf(strip), /simplest example/);
    assert.match(textOf(strip), /列表欄位可用逗號分隔多個值/);
  });
  check('status strip is an announced live region', () => {
    const strip = findStatus(tree, 'fdep__status--ok');
    assert.equal(strip.props.role, 'status');
    assert.equal(strip.props['aria-live'], 'polite');
  });
  check('Run is enabled after docs arrive', () => {
    assert.equal(findButton(tree, '執行').props.disabled, false);
  });
  check('the session fallbacks enable after docs arrive too', () => {
    // The brief they produce is only a complete context once the api's fields
    // are known, so both stay inert until Fetch docs succeeded.
    assert.equal(findButton(tree, '複製提示').props.disabled, false);
    assert.equal(findButton(tree, '開新工作階段').props.disabled, false);
  });

  // --- fill the fields and run ---
  const nameInput = findAllInputs(tree).find((i) => i.props.id === 'fdep-field-name');
  nameInput.props.onChange({ target: { value: 'aaa' } });
  const limitInput = findAllInputs(tree).find((i) => i.props.id === 'fdep-field-limit');
  limitInput.props.onChange({ target: { value: '25' } });
  let listBox = null;
  walk(tree, (n) => { if (n.type === 'textarea' && n.props.id === 'fdep-field-watchlist') listBox = n; });
  listBox.props.onChange({ target: { value: '1402, 4904\n2330' } });
  tree = render();
  fetchCalls = [];
  await findButton(tree, '執行').props.onClick();
  tree = render();
  check('run sends the array field AS AN ARRAY', () => {
    assert.equal(fetchCalls.length, 1);
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.do, true);
    assert.deepEqual(sent.inbound.watchlist, ['1402', '4904', '2330'],
      'watchlist must arrive as an array, got ' + JSON.stringify(sent.inbound.watchlist));
    assert.ok(Array.isArray(sent.inbound.watchlist));
  });
  check('a numeric field is sent as a number, not a string', () => {
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.strictEqual(sent.inbound.limit, 25);
    assert.equal(typeof sent.inbound.limit, 'number');
  });
  check('the typed object is what the copied prompt carries too', () => {
    // The fallback path must not reintroduce the bug the form just fixed.
    let promptText = '';
    walk(tree, (n) => {
      if (n.type === 'pre' && textOf(n).indexOf('fdep-api-request skill') !== -1) promptText = textOf(n);
    });
    assert.match(promptText, /"watchlist": \[/);
    assert.match(promptText, /"limit": 25/);
  });
  check('run sent do:true with the fully typed inbound', () => {
    assert.equal(fetchCalls.length, 1);
    const sent = JSON.parse(fetchCalls[0].init.body);
    assert.equal(sent.do, true);
    assert.deepEqual(sent.inbound, {
      name: 'aaa',
      watchlist: ['1402', '4904', '2330'],
      limit: 25,
    });
  });
  check('result block rendered', () => {
    let sawResult = false;
    walk(tree, (n) => {
      if (n.type === 'pre' && textOf(n).indexOf('t-exec') !== -1) sawResult = true;
    });
    assert.ok(sawResult, 'result pre block missing');
  });

  console.log('\n=== 7. CORS failure keeps the form usable ===');
  // fresh render state
  hookStates = [];
  tree = render();
  const apiInput2 = findApiIdInput(tree);
  apiInput2.props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  fetchBehaviour = 'cors';
  await findButton(tree, '取得文件').props.onClick();
  fetchBehaviour = 'ok';
  tree = render();
  check('CORS failure is explained in a warning strip', () => {
    const strip = findStatus(tree, 'fdep__status--warn');
    assert.ok(strip, 'no warn status strip rendered');
    assert.match(textOf(strip), /被擋下/);
    assert.match(textOf(strip), /fdep_call|複製提示/);
  });
  check('the pre-built prompt is always available as a fallback', () => {
    let sawPrompt = false;
    walk(tree, (n) => {
      if (n.type === 'pre' && textOf(n).indexOf('fdep-api-request skill') !== -1) sawPrompt = true;
    });
    assert.ok(sawPrompt, 'pre-built prompt block missing');
  });

  console.log('\n=== 8. New session: carry the api brief, then open a session ===');
  // Section 7 left the panel without docs (a failed fetch clears them), and the
  // fallbacks are docs-gated now — so fetch again, exactly as a user would.
  fetchBehaviour = 'ok';
  fetchCalls = [];
  await findButton(tree, '取得文件').props.onClick();
  tree = render();
  check('docs are back, so the fallbacks are live again', () => {
    assert.equal(findButton(tree, '開新工作階段').props.disabled, false);
  });
  // Fill two boxes: the re-fetch above reset them, and the brief's inbound is
  // what makes the arm worth asserting on.
  findAllInputs(tree).find((i) => i.props.id === 'fdep-field-name')
    .props.onChange({ target: { value: 'aaa' } });
  findAllInputs(tree).find((i) => i.props.id === 'fdep-field-limit')
    .props.onChange({ target: { value: '25' } });
  let watchBox = null;
  walk(tree, (n) => { if (n.type === 'textarea' && n.props.id === 'fdep-field-watchlist') watchBox = n; });
  watchBox.props.onChange({ target: { value: '1402, 4904' } });
  tree = render();
  setClipboard(true);
  armCalls = [];
  seq = [];
  armBehaviour = 'ok';
  const apiIdAtNewSession = findApiIdInput(tree).props.value;
  await findButton(tree, '開新工作階段').props.onClick();
  check('uiWorkspace.startSession was called', () => {
    assert.equal(fakeCtx.startedSession, true);
  });
  check('New session armed the host runtime context, before the session existed', () => {
    assert.equal(armCalls.length, 1, 'expected exactly one context arm, saw ' + armCalls.length);
    assert.equal(armCalls[0].body.apiId, apiIdAtNewSession);
    assert.equal(armCalls[0].afterStart, false, 'the arm must reach the host BEFORE startSession()');
    assert.ok(seq.indexOf('arm') !== -1 && seq.indexOf('arm') < seq.indexOf('start'),
      'arm/start order was ' + JSON.stringify(seq));
  });
  check('the armed payload is the raw docs shape plus the TYPED inbound', () => {
    const raw = armCalls[0].body.raw;
    assert.equal(raw.desc, 'simplest example');
    assert.equal(raw.name, 'aaa');
    assert.deepEqual(raw.watchlist, ['1402', '4904']);
    assert.equal(raw.limit, 10);
    // The fields the test filled earlier must arrive with their JSON shapes — an
    // array as an array, a number as a number (the arm must not downgrade them
    // to the raw text the boxes hold).
    assert.deepEqual(armCalls[0].body.inbound.watchlist, ['1402', '4904']);
    assert.equal(armCalls[0].body.inbound.limit, 25);
    assert.equal(armCalls[0].body.inbound.name, 'aaa');
  });
  check('the api brief reached the clipboard before navigating away', () => {
    assert.equal(clipboardWrites.length, 1, 'expected exactly one clipboard write');
    assert.match(clipboardWrites[0], /請使用 fdep-api-request skill 呼叫下列 FDEP API/);
    assert.ok(
      clipboardWrites[0].indexOf('api: ' + apiIdAtNewSession) !== -1,
      'the clipboard brief does not name the current api id (' + apiIdAtNewSession + ')',
    );
  });
  check('the brief carries the fetched docs, so the new session starts with context', () => {
    // This is the point of the button: the new session's first message must
    // already know the api's fields, their types and the example values.
    const brief = clipboardWrites[0];
    assert.match(brief, /這個 api 的文件（已取得/);
    assert.match(brief, /desc: simplest example/);
    assert.match(brief, /參數（名稱: 型別/);
    assert.match(brief, /name: string — "aaa"/);
    assert.match(brief, /watchlist: array — \["1402","4904"\]/);
    assert.match(brief, /原始 docs 內容/);
    assert.match(brief, /請不要再呼叫 docs 端點|不要再取得文件/);
  });
  check('the status strip tells the user the brief is on the clipboard', () => {
    tree = render();
    const strip = findStatus(tree, 'fdep__status--info');
    assert.ok(strip, 'no info status strip after New session');
    assert.match(textOf(strip), /剪貼簿/);
    assert.match(textOf(strip), /文件已注入/);
  });

  console.log('\n=== 8b. an unreachable host degrades to the clipboard path ===');
  // The arm route belongs to the host half; a composition without webServer (or
  // a failed request) must not cost the user the clipboard brief.
  armBehaviour = 'fail';
  armCalls = [];
  seq = [];
  fakeCtx.startedSession = false;
  setClipboard(true);
  await findButton(tree, '開新工作階段').props.onClick();
  tree = render();
  check('the session still opens and the brief is still copied', () => {
    assert.equal(fakeCtx.startedSession, true);
    assert.equal(clipboardWrites.length, 1);
    assert.equal(armCalls.length, 1, 'the arm should still have been attempted');
  });
  check('the status strip says the host context was unavailable', () => {
    const strip = findStatus(tree, 'fdep__status--warn');
    assert.ok(strip, 'a failed arm should surface as a warning, not an error');
    assert.match(textOf(strip), /宿主端上下文不可用/);
    assert.match(textOf(strip), /剪貼簿/);
  });
  armBehaviour = 'ok';

  console.log('\n=== 9. presentation contract (theme tokens, not hard-coded colours) ===');
  check('every CSS custom property is a real shipped token or fdep-local', () => {
    // The shipped design system exposes --dsw-alias-* (plus --dsw-specific-*).
    // An invented prefix silently falls back to a hard-coded value, which is
    // exactly how the first revision ended up looking detached in light mode.
    const names = new Set();
    const re = /var\(\s*(--[a-z0-9-]+)/g;
    let m;
    while ((m = re.exec(stylesheetSource)) !== null) names.add(m[1]);
    const offenders = [];
    for (const name of names) {
      const ok = name.startsWith('--dsw-') || name.startsWith('--fdep-');
      if (!ok) offenders.push(name);
    }
    assert.deepEqual(offenders, [], 'invented token names: ' + offenders.join(', '));
  });
  check('the deprecated --dsh-* prefix is gone', () => {
    assert.ok(!/var\(\s*--dsh-/.test(stylesheetSource), 'client.js still reads a --dsh-* variable');
  });
  check('the stylesheet routes through the theme, not a private palette', () => {
    for (const token of [
      '--dsw-alias-bg-base',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-primary',
      '--dsw-alias-state-error-primary',
    ]) {
      assert.ok(stylesheetSource.indexOf('var(' + token) !== -1, 'stylesheet never uses ' + token);
    }
  });
  check('dark mode is not hard-coded', () => {
    // The theme layer owns light/dark; the bundle must not fork on it.
    assert.ok(!/data-ds-dark-theme/.test(stylesheetSource), 'client.js hard-codes a dark-theme selector');
  });

  console.log('\n=== 10. interaction & state coverage ===');
  hookStates = [];
  tree = render();
  check('empty state explains what to do before docs are fetched', () => {
    const empty = [];
    walk(tree, (n) => { if (n.props && n.props.className === 'fdep__empty') empty.push(textOf(n)); });
    assert.ok(empty.some((t) => /先取得文件/.test(t)), 'no empty-state hint: ' + JSON.stringify(empty));
  });
  check('no status strip is rendered before any action', () => {
    assert.equal(findStatus(tree), undefined, 'a status strip rendered in the initial state');
  });
  check('step markers and parameter placeholder are present', () => {
    const classes = classNames(tree);
    assert.ok(classes.has('fdep__stepnum'), 'no step number badge');
    assert.ok(classes.has('fdep__chip'), 'no endpoint chip');
  });

  // Enter in the API ID field should trigger the docs fetch.
  const apiInput3 = findApiIdInput(tree);
  apiInput3.props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  fetchCalls = [];
  const apiInput4 = findApiIdInput(tree);
  await apiInput4.props.onKeyDown({ key: 'Enter' });
  check('Enter in the API ID field fetches the docs', () => {
    assert.equal(fetchCalls.length, 1, 'Enter did not trigger a fetch');
    assert.equal(JSON.parse(fetchCalls[0].init.body).do, false);
  });
  check('the docs field renders as a monospace input', () => {
    tree = render();
    const cls = findApiIdInput(tree).props.className;
    assert.match(cls, /fdep__input--mono/);
  });

  console.log('\n=== 11. React comes from the loader require, never a global ===');
  check('the test environment defines no global React', () => {
    // If it did, every render assertion above would be meaningless.
    assert.equal(typeof globalThis.React, 'undefined');
  });
  check('factory fails when require("react") throws', () => {
    // Behavioural proof that React is sourced from the loader-provided
    // require rather than a global: break that require and the factory must
    // fail. A regex on the source cannot distinguish a parameter from a
    // module-scope global, so we assert the dependency instead.
    let threw = false;
    try {
      loaded.factory(function (name) {
        if (name === 'react') throw new Error('react unavailable');
        throw new Error('unexpected require: ' + name);
      });
    } catch (err) {
      threw = true;
    }
    assert.equal(threw, true, 'factory built a plugin without react');
  });

  console.log('\n=== 12. uiWorkspace arriving LATE (the "Service unavailable" bug) ===');
  // This entry is `dsh.client.immediately`, so apply() regularly runs before the
  // workspace plugin provides uiWorkspace — and ctx.get() only answers for an
  // already-active provider. The panel must therefore mount either way and start
  // working the moment the service shows up, without a reload.
  let fireLateInject = null;
  let lateStarted = false;
  const lateRegistrations = [];
  const lateCtx = {
    get(name) { throw new Error('ctx.get("' + name + '") used for an optional service'); },
    inject(deps, callback) {
      assert.deepEqual(deps, ['uiWorkspace']);
      // Nothing fires yet — this is "the workspace plugin has not loaded".
      fireLateInject = () => callback({
        uiWorkspace: { startSession() { lateStarted = true; } },
      });
      return function () {};
    },
    effect() {},
    slots: {
      inject(slotKey, cb) { cb(); return function () {}; },
      register(options, component) {
        lateRegistrations.push({ options, component });
        return function () {};
      },
    },
  };
  const latePlugin = loaded.factory(fakeRequire);
  check('the panel mounts even while uiWorkspace is still missing', () => {
    latePlugin.apply(lateCtx);
    assert.ok(lateRegistrations.some((r) => r.options.name === 'main'), 'main panel was not registered');
    assert.ok(lateRegistrations.some((r) => r.options.name === 'sidebar.panellist'), 'sidebar entry was not registered');
  });

  const lateMainEntry = lateRegistrations.find((r) => r.options.name === 'main');
  hookStates = [];   // independent instance: fresh hook state
  function renderLate() {
    hookIndex = 0;   // hook order resets each render; state persists (see render())
    return renderNode(lateMainEntry.component({}));
  }
  let lateTree = renderLate();
  setClipboard(true);
  check('without docs the two fallbacks are inert in this instance too', () => {
    assert.equal(findButton(lateTree, '開新工作階段').props.disabled, true);
  });
  // The button is docs-gated now, so this instance has to fetch docs first —
  // which is also the order a user follows.
  fetchBehaviour = 'ok';
  fetchCalls = [];
  await findButton(lateTree, '取得文件').props.onClick();
  lateTree = renderLate();
  check('docs arrived, so New session is live even though uiWorkspace is not', () => {
    assert.equal(findButton(lateTree, '開新工作階段').props.disabled, false);
  });
  await findButton(lateTree, '開新工作階段').props.onClick();
  lateTree = renderLate();
  check('clicking New session before the service appears reports it, and opens nothing', () => {
    const strip = findStatus(lateTree, 'fdep__status--err');
    assert.ok(strip, 'no error status strip');
    assert.match(textOf(strip), /服務不可用/);
    assert.equal(lateStarted, false, 'a session was opened without the service');
    assert.equal(clipboardWrites.length, 0, 'the clipboard was written before the service was known');
  });

  check('the deferred provider eventually fires (harness sanity)', () => {
    assert.equal(typeof fireLateInject, 'function', 'nothing was registered with ctx.inject');
    fireLateInject();
  });
  await findButton(lateTree, '開新工作階段').props.onClick();
  lateTree = renderLate();
  check('once the service appears, New session opens a session and copies the prompt', () => {
    assert.equal(lateStarted, true, 'startSession was not called after the service arrived');
    assert.equal(clipboardWrites.length, 1, 'the prompt was not copied');
    assert.match(clipboardWrites[0], /請使用 fdep-api-request skill/);
  });

  console.log('\nAll ' + pass + ' client-contract checks passed.');
}

main().catch((err) => {
  console.error('\nCLIENT CONTRACT TEST FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
