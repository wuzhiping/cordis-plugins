'use strict';

// Generates a standalone preview page for the panel, using the REAL component
// and the REAL stylesheet from lib/client.js.
//
//   node test/preview.js     ->  writes test/preview.html
//
// Why this exists: the browser rendering cannot be observed from the agent
// side, and restarting dsh web just to look at a padding value is expensive.
// The preview renders the actual component tree to static markup with the
// actual CSS, so layout, spacing, colour and the hover/focus rules can be
// reviewed before anything is installed.
//
// Fidelity note: the panel's STRUCTURE, CLASSES and TOKEN USAGE are exact.
// The --dsw-alias-* VALUES below are approximations taken from the shipped
// boot palette, because the live values are owned by the running theme. In
// the real GUI the tokens come from the theme layer, so the panel follows
// whatever light/dark palette is active.

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'preview.html');

// `--theme=dark` bakes the dark attribute into the page instead of leaving it
// to the toggle, so a headless screenshot can capture that palette.
const THEME_ARG = (process.argv.find((a) => a.startsWith('--theme=')) || '').split('=')[1];
const INITIAL_THEME = THEME_ARG === 'dark' ? 'dark' : 'light';
const OUT_FILE = THEME_ARG === 'dark'
  ? path.join(__dirname, 'preview-dark.html')
  : OUT;

// ---- fake React (same shim shape the contract test uses) -------------------
let hookIndex = 0;
let hookStates = [];

function useState(initial) {
  const i = hookIndex;
  hookIndex += 1;
  if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial;
  return [hookStates[i], function (next) {
    hookStates[i] = typeof next === 'function' ? next(hookStates[i]) : next;
  }];
}

const fakeReact = {
  createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2);
    const merged = Object.assign({}, props || {});
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type: type, props: merged, children: children };
  },
  useState: useState,
  useEffect() {},
};

// ---- fake DOM --------------------------------------------------------------
// The bundle injects its sheet through `document` (a static bundle has no
// `styles` builtin). The preview does not need the inserted tag — it inlines
// PANEL_CSS itself — but the stub must exist so apply() does not take the
// no-document early return.
globalThis.document = {
  head: { appendChild() {} },
  createElement() {
    return { attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, remove() {} };
  },
};

let captured = null;
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec; } } };

// ---- stub fetch ------------------------------------------------------------
let behaviour = 'ok';
globalThis.fetch = async function (url, init) {
  if (behaviour === 'cors') throw new TypeError('Failed to fetch');
  let body = {};
  try { body = JSON.parse(init.body); } catch (_) {}
  if (behaviour === 'http500') {
    return { ok: false, status: 500, async text() { return JSON.stringify({ error: 'internal error' }); } };
  }
  if (body.do === false) {
    return {
      ok: true, status: 200,
      async text() {
        // The real shape of twseMops.todayMaterial: the docs values are
        // EXAMPLE values, and their JSON types are the field types — note
        // `watchlist` is an array, not a string.
        return JSON.stringify({
          data: {
            docs: {
              an_code: 'M26',
              desc: '抓取 TWSE(上市) + TPEX(上櫃) 當日全市場重大訊息；'
                + '可選 watchlist(股號清單) / keyword(主旨關鍵詞) / an_code(條款) 過濾；'
                + '回傳 twse 與 tpex 各自結果及合併排序後的 merged 列表（最多 100 筆）',
              keyword: '資安',
              watchlist: ['1402', '4904'],
            },
          },
          trace_id: 'docs-7f3a91',
        });
      },
    };
  }
  return {
    ok: true, status: 200,
    async text() {
      return JSON.stringify({
        data: { echoed: body.inbound, ok: true, server: 'fdep-gw-02' },
        trace_id: 'b41c8e2d-5a77-4f10-9c3e-8d2a6f0b1e44',
      });
    },
  };
};

require(path.join(__dirname, '..', 'lib', 'client.js'));

const CSS = captured.factory.PANEL_CSS;

// ---- render helpers --------------------------------------------------------
function renderNode(node) {
  if (Array.isArray(node)) return node.map(renderNode);
  if (node === null || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return renderNode(node.type(node.props));
  if (node.children) return Object.assign({}, node, { children: node.children.map(renderNode) });
  return node;
}

const ATTR_MAP = {
  className: 'class',
  htmlFor: 'for',
  strokeWidth: 'stroke-width',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeDasharray: 'stroke-dasharray',
  focusable: 'focusable',
  spellCheck: 'spellcheck',
  autoComplete: 'autocomplete',
  tabIndex: 'tabindex',
};

// HTML void elements take no closing tag at all.
const HTML_VOID = { input: true, br: true, hr: true, img: true, meta: true, link: true };
// SVG shapes live in foreign content, where the self-closing slash IS honoured
// and a bare `<path …>` would swallow everything that follows it.
const SVG_SELF_CLOSING = {
  path: true, circle: true, rect: true, line: true,
  polyline: true, polygon: true, use: true, stop: true, ellipse: true,
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function styleToString(style) {
  return Object.keys(style)
    .map((k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ':' + style[k])
    .join(';');
}

function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node);
  if (Array.isArray(node)) return node.map(toHtml).join('');
  const type = node.type;
  const props = node.props || {};
  if (typeof type === 'function') return toHtml(type(props));

  const attrs = [];
  for (const key of Object.keys(props)) {
    if (key === 'children') continue;
    // `key` is a React reconciliation hint and never reaches the DOM.
    if (key === 'key' || key === 'ref') continue;
    // Drop the handlers: the preview is static markup. Interactivity comes
    // from CSS (:hover/:focus-visible), which applies to plain elements.
    if (/^on[A-Z]/.test(key)) continue;
    const value = props[key];
    if (value === undefined || value === null || value === false) continue;
    if (key === 'disabled') {
      if (value) attrs.push('disabled');
      continue;
    }
    if (key === 'style' && typeof value === 'object') {
      attrs.push('style="' + escapeHtml(styleToString(value)) + '"');
      continue;
    }
    const name = ATTR_MAP[key] || key;
    attrs.push(name + '="' + escapeHtml(value) + '"');
  }
  const tail = attrs.length ? ' ' + attrs.join(' ') : '';
  if (HTML_VOID[type]) return '<' + type + tail + '>';
  if (SVG_SELF_CLOSING[type]) return '<' + type + tail + ' />';
  return '<' + type + tail + '>' + (node.children || []).map(toHtml).join('') + '</' + type + '>';
}

// ---- drive the component into each state ----------------------------------
function bootPanel() {
  const requireCalls = [];
  const plugin = captured.factory(function (name) {
    requireCalls.push(name);
    if (name === 'react') return fakeReact;
    throw new Error('unexpected require: ' + name);
  });

  const entries = {};
  const fakeCtx = {
    get(name) {
      if (name === 'uiWorkspace') return { startSession() {} };
      return undefined;
    },
    effect() {},
    slots: {
      inject(key, cb) {
        const disposer = cb();
        return disposer || function () {};
      },
      register(options, component) {
        entries[options.name] = { options: options, component: component };
        return function () {};
      },
    },
  };
  plugin.apply(fakeCtx);
  return entries;
}

const entries = bootPanel();
const Panel = entries['main'].component;
const Glyph = entries['sidebar.panellist'].component;

function render(props) {
  hookIndex = 0;
  return renderNode(Panel(props || {}));
}

async function stateEmpty() {
  hookStates = [];
  return render();
}

async function stateDocs() {
  hookStates = [];
  let tree = render();
  findInput(tree).props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  behaviour = 'ok';
  await findButton(tree, 'Fetch docs').props.onClick();
  return render();
}

async function stateRunning() {
  const tree = await stateDocs();
  findButton(tree, 'Run').props.onClick(); // not awaited: capture the busy frame
  const busy = render();
  await new Promise((r) => setTimeout(r, 0));
  return busy;
}

async function stateResult() {
  hookStates = [];
  let tree = render();
  findInput(tree).props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  behaviour = 'ok';
  await findButton(tree, 'Fetch docs').props.onClick();
  tree = render();
  findFieldById(tree, 'fdep-field-an_code').props.onChange({ target: { value: 'M26' } });
  findFieldById(tree, 'fdep-field-keyword').props.onChange({ target: { value: '資安' } });
  // The list field: comma or newline separated, assembled into a real array.
  findFieldById(tree, 'fdep-field-watchlist').props.onChange({ target: { value: '1402, 4904\n2330' } });
  tree = render();
  await findButton(tree, 'Run').props.onClick();
  return render();
}

async function stateCors() {
  hookStates = [];
  let tree = render();
  findInput(tree).props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  behaviour = 'cors';
  await findButton(tree, 'Fetch docs').props.onClick();
  behaviour = 'ok';
  return render();
}

async function stateError() {
  hookStates = [];
  let tree = render();
  findInput(tree).props.onChange({ target: { value: 'test.demo' } });
  tree = render();
  behaviour = 'http500';
  await findButton(tree, 'Fetch docs').props.onClick();
  behaviour = 'ok';
  return render();
}

function walk(node, visit) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  if (node.type) visit(node);
  if (node.children) node.children.forEach((c) => walk(c, visit));
}
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.children) return node.children.map(textOf).join('');
  return '';
}
function findButton(tree, label) {
  let found;
  walk(tree, (n) => { if (n.type === 'button' && textOf(n).indexOf(label) !== -1) found = n; });
  return found;
}
function findInput(tree) {
  let found;
  walk(tree, (n) => { if (n.type === 'input' && n.props.placeholder === 'e.g. test.demo') found = n; });
  return found;
}
// Find a field control by id — works for both <input> and <textarea>.
function findFieldById(tree, id) {
  let found;
  walk(tree, (n) => {
    if ((n.type === 'input' || n.type === 'textarea') && n.props.id === id) found = n;
  });
  return found;
}

// ---- page ------------------------------------------------------------------
const TOKENS_LIGHT = [
  '--dsw-alias-bg-base: #ffffff;',
  '--dsw-alias-bg-layer-1: #ffffff;',
  '--dsw-alias-bg-layer-2: #f4f5f6;',
  '--dsw-alias-bg-overlay: #ffffff;',
  '--dsw-alias-border-l1: rgb(0 0 0 / 10%);',
  '--dsw-alias-border-l2: rgb(0 0 0 / 18%);',
  '--dsw-alias-brand-primary: #0f1115;',
  '--dsw-alias-label-primary: #0f1115;',
  '--dsw-alias-label-secondary: #61666b;',
  '--dsw-alias-state-error-primary: #c62828;',
  // Measured from the running GUI rather than guessed: the live light-theme
  // success token computes to #22c55e.
  '--dsw-alias-state-success-primary: #22c55e;',
  '--dsw-alias-state-warn-primary: #a35b00;',
  '--dsw-specific-sidebar-fill: #f7f8f9;',
].join('\n    ');

const TOKENS_DARK = [
  '--dsw-alias-bg-base: #151517;',
  '--dsw-alias-bg-layer-1: #1c1c1f;',
  '--dsw-alias-bg-layer-2: #242428;',
  '--dsw-alias-bg-overlay: #242428;',
  '--dsw-alias-border-l1: rgb(255 255 255 / 12%);',
  '--dsw-alias-border-l2: rgb(255 255 255 / 22%);',
  '--dsw-alias-brand-primary: #f9fafb;',
  '--dsw-alias-label-primary: #f9fafb;',
  '--dsw-alias-label-secondary: #cfd3d6;',
  '--dsw-alias-state-error-primary: #f87171;',
  '--dsw-alias-state-success-primary: #4ade80;',
  '--dsw-alias-state-warn-primary: #fbbf24;',
  '--dsw-specific-sidebar-fill: #101012;',
].join('\n    ');

const PAGE_CSS = [
  '* { box-sizing: border-box; }',
  'html, body { margin: 0; padding: 0; }',
  'body {',
  '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;',
  '  background: var(--page-bg);',
  '  color: var(--page-fg);',
  '  transition: background .15s ease, color .15s ease;',
  '}',
  ':root {',
  '  --page-bg: #eef0f2;',
  '  --page-fg: #0f1115;',
  '  --page-muted: #61666b;',
  '  --page-card: #ffffff;',
  '  --page-line: rgb(0 0 0 / 10%);',
  '}',
  '[data-theme="dark"] {',
  '  --page-bg: #0c0c0e;',
  '  --page-fg: #f9fafb;',
  '  --page-muted: #adb2b8;',
  '  --page-card: #1a1a1d;',
  '  --page-line: rgb(255 255 255 / 12%);',
  '}',
  '.wrap { max-width: 1120px; margin: 0 auto; padding: 28px 20px 80px; }',
  '.head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 6px; }',
  '.head h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }',
  '.head p { margin: 0; font-size: 13px; color: var(--page-muted); }',
  '.note { margin: 14px 0 22px; padding: 12px 14px; border: 1px solid var(--page-line); border-radius: 10px; background: var(--page-card); font-size: 12.5px; line-height: 19px; color: var(--page-muted); }',
  '.note b { color: var(--page-fg); }',
  '.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }',
  '.seg { display: inline-flex; border: 1px solid var(--page-line); border-radius: 8px; overflow: hidden; background: var(--page-card); }',
  '.seg button { appearance: none; border: 0; background: transparent; color: var(--page-muted); font: inherit; font-size: 12.5px; padding: 7px 13px; cursor: pointer; border-right: 1px solid var(--page-line); }',
  '.seg button:last-child { border-right: 0; }',
  '.seg button[aria-pressed="true"] { background: var(--page-fg); color: var(--page-bg); font-weight: 600; }',
  '.spacer { flex: 1 1 auto; }',
  '.label { font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--page-muted); }',
  '',
  '.shots { display: grid; gap: 22px; }',
  '.shot { border: 1px solid var(--page-line); border-radius: 14px; overflow: hidden; background: var(--page-card); }',
  '.shot__cap { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--page-line); }',
  '.shot__cap b { font-size: 13px; font-weight: 620; }',
  '.shot__cap span { font-size: 12px; color: var(--page-muted); }',
  '.shot__body { background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }',
  '.shot__body .fdep { height: auto; }',
  '',
  '.rail { display: flex; align-items: center; gap: 18px; padding: 16px 18px; border: 1px solid var(--page-line); border-radius: 14px; background: var(--dsw-specific-sidebar-fill); }',
  '.railbox { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 9px; background: transparent; }',
  '.railbox.is-active { background: var(--dsw-alias-bg-layer-2); }',
  '.raillabel { font-size: 12.5px; color: var(--dsw-alias-label-secondary); }',
  '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { } }',
].join('\n');

function esc(s) { return escapeHtml(s); }

async function main() {
  const states = [
    ['empty', 'Initial', 'Nothing loaded yet — the empty state tells the user what the first action is.', await stateEmpty()],
    ['docs', 'Docs loaded', 'Fields are discovered from the response; each carries its own description.', await stateDocs()],
    ['running', 'In flight', 'The trigger button swaps to a spinner and the status strip reports the request.', await stateRunning()],
    ['result', 'Completed', 'The response gets its own flush card with a trace id and a copy action.', await stateResult()],
    ['cors', 'Warning (CORS)', 'A blocked browser fetch explains the fallback instead of failing silently.', await stateCors()],
    ['error', 'Failure', 'A real upstream error is reported as a failed state.', await stateError()],
  ];

  const railActive = toHtml(renderNode(Glyph({ size: 20, active: true })));
  const railIdle = toHtml(renderNode(Glyph({ size: 20, active: false })));

  const html = `<!doctype html>
<html lang="en" data-theme="${INITIAL_THEME}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FDEP API Request — panel preview</title>
<style>
:root {
    ${TOKENS_LIGHT}
}
[data-theme="dark"] {
    ${TOKENS_DARK}
}
${PAGE_CSS}
${CSS}
</style>
</head>
<body>
<div class="wrap">

  <div class="head">
    <h1>FDEP API Request — panel preview</h1>
    <p>rendered from the real component and the real stylesheet</p>
  </div>

  <div class="note">
    <b>What is exact:</b> the component tree, the class names, the layout, and every
    <code>var(--dsw-alias-*)</code> reference — this markup and this CSS are produced by
    <code>lib/client.js</code> itself, not re-typed.<br>
    <b>What is approximate:</b> the token <i>values</i> in this page. The live values belong to the
    running theme, so they were taken from the shipped boot palette. In the real GUI the panel
    inherits whatever light/dark palette is active — toggle below to see both extremes.<br>
    <b>Interactivity:</b> hover and keyboard focus are real (they are pure CSS). State
    <i>transitions</i> are frozen per snapshot, which is why each state has its own card.
  </div>

  <div class="toolbar">
    <div class="seg" id="theme">
      <button type="button" data-theme-set="light" aria-pressed="true">Light</button>
      <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
    </div>
    <span class="spacer"></span>
    <span class="label">sidebar glyph, at rail size</span>
    <div class="rail">
      <span class="railbox is-active">${railActive}</span>
      <span class="railbox">${railIdle}</span>
      <span class="raillabel">selected / idle</span>
    </div>
  </div>

  <div class="shots">
${states.map(([id, title, caption, tree]) => `    <section class="shot" id="shot-${id}">
      <div class="shot__cap"><b>${esc(title)}</b><span>${esc(caption)}</span></div>
      <div class="shot__body">${toHtml(tree)}</div>
    </section>`).join('\n')}
  </div>

</div>
<script>
(function () {
  var root = document.documentElement;
  var buttons = document.querySelectorAll('[data-theme-set]');
  function set(theme) {
    root.setAttribute('data-theme', theme);
    buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme));
    });
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () { set(b.dataset.themeSet); });
  });
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) set('dark');
})();
</script>
</body>
</html>
`;

  // ---- validate the generated markup before writing it --------------------
  const problems = [];

  // 1. Every class used in the shot markup must have a rule in the stylesheet.
  //    This is what caught `fdep__btn--default`, a modifier the component
  //    emitted while no rule existed for it.
  const usedClasses = new Set();
  const classAttr = /class="([^"]*)"/g;
  let cm;
  while ((cm = classAttr.exec(html)) !== null) {
    cm[1].split(/\s+/).filter(Boolean).forEach((c) => usedClasses.add(c));
  }
  for (const cls of usedClasses) {
    // Preview-page chrome (shot/rail/wrap/…) is not part of the panel sheet.
    if (!cls.startsWith('fdep')) continue;
    if (CSS.indexOf('.' + cls) === -1) problems.push('class with no CSS rule: .' + cls);
  }

  // 2. SVG shapes must be self-closing, or the HTML parser treats every
  //    following sibling as their child and the glyph disappears.
  //    Note: a naive /<path[^>]*>\s*<path/ cannot tell `<path … />` from
  //    `<path …>` because `[^>]*` also swallows the slash. Match the whole
  //    tag and inspect its ending instead.
  const svgShapeTags = html.match(/<(path|circle|rect|line|polyline|polygon|ellipse|use)\b[^>]*>/g) || [];
  const unclosedShapes = svgShapeTags.filter((t) => !/\/>$/.test(t));
  if (unclosedShapes.length) {
    problems.push('SVG shape not self-closed: ' + unclosedShapes[0]);
  }

  // 3. React-only props must not leak into the markup.
  if (/\skey="/.test(html)) problems.push('React `key` prop leaked into the HTML');
  if (/\son[A-Z][a-z]+="/.test(html)) problems.push('an event handler leaked into the HTML');

  // 4. No invented token prefix may survive anywhere in the page.
  if (/--dsh-/.test(html)) problems.push('deprecated --dsh-* token referenced');

  if (problems.length) {
    console.error('PREVIEW VALIDATION FAILED:');
    problems.forEach((p) => console.error('  - ' + p));
    process.exit(1);
  }

  fs.writeFileSync(OUT_FILE, html, 'utf8');
  console.log('wrote ' + OUT_FILE);
  console.log('  states: ' + states.map((s) => s[0]).join(', '));
  console.log('  stylesheet bytes: ' + CSS.length);
  console.log('  panel classes used: ' + usedClasses.size + ' (all have rules)');
  console.log('  initial theme: ' + INITIAL_THEME);
  console.log('  open it with: start "" "' + OUT_FILE + '"');
}

main().catch((err) => {
  console.error('PREVIEW GENERATION FAILED');
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
