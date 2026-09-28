'use strict';

// Client (browser) plugin for fdep-api-request-bundle.
//
// Mounts two slot occupants:
//   - sidebar.panellist: the panel's glyph.
//   - main key="fdep-api-request": the FDEP request form.
//
// Styling uses only the shipped `--dsw-alias-*` theme tokens, so the panel
// follows the active light/dark theme and the surrounding shell instead of
// carrying its own palette. (An earlier revision used invented `--dsh-*`
// names, which do not exist, so every value fell back to a hard-coded dark
// grey and the panel looked detached in light mode.)
//
// Static bundle shape — this file is loaded by dsh-client-modules via
// `window.__ModuleLoader__.load({ id, factory })`. The factory receives
// `require` (a loader-provided function). There is NO `React` global.

const FDEP_URL = 'https://abc.feg.com.tw/oauth2/fdep';
const FDEP_PATH = '/oauth2/fdep';
const FDEP_HOST = 'abc.feg.com.tw';

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The value a docs entry carries is an EXAMPLE VALUE, not merely prose — its
// JSON type IS the field's type. `watchlist: ["1402","4904"]` means an array
// of strings; `an_code: "M26"` means a string. An earlier revision treated
// every value as descriptive text and rendered one text input per field, so an
// array parameter was sent as the string "1402,4904".
function kindOf(example) {
  if (Array.isArray(example)) return 'array';
  if (example === null) return 'null';
  switch (typeof example) {
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'string';
  }
}

function readDocs(rawDocs) {
  // `desc` is human-readable; everything else is an inbound parameter with an
  // example value that tells us its type.
  if (!isPlainObject(rawDocs)) return { desc: '', specs: [] };
  const desc = typeof rawDocs.desc === 'string' ? rawDocs.desc : '';
  const specs = [];
  for (const key of Object.keys(rawDocs)) {
    if (key === 'desc') continue;
    specs.push({ name: key, example: rawDocs[key], kind: kindOf(rawDocs[key]) });
  }
  return { desc, specs };
}

// How a field's example reads in the UI, and what the user should type.
function exampleText(spec) {
  try { return JSON.stringify(spec.example); } catch (_) { return String(spec.example); }
}

function placeholderFor(spec) {
  if (spec.kind === 'array') {
    return Array.isArray(spec.example) && spec.example.length
      ? spec.example.join(', ')
      : '項目一, 項目二';
  }
  if (spec.kind === 'boolean') return 'true / false';
  if (spec.kind === 'object') return '{ "key": "value" }';
  return typeof spec.example === 'string' ? spec.example : exampleText(spec);
}

// Turn one text box into the JSON value the API expects.
// Returns { empty } to omit the key, { error } to reject, or { value }.
function parseFieldValue(spec, text) {
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (t === '') return { empty: true };

  if (spec.kind === 'array') {
    // Comma, semicolon, or newline separated. CJK punctuation is accepted too
    // because the docs and the audience are Chinese.
    const parts = t.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return { empty: true };
    // Follow the example's element type so ["1402"] stays strings while
    // [1, 2] becomes numbers.
    const first = Array.isArray(spec.example) ? spec.example[0] : undefined;
    if (typeof first === 'number') {
      const nums = parts.map(Number);
      if (nums.some(Number.isNaN)) return { error: '需要數字，例如 ' + placeholderFor(spec) };
      return { value: nums };
    }
    if (typeof first === 'boolean') {
      return { value: parts.map((p) => /^(true|1|yes|y|是)$/i.test(p)) };
    }
    return { value: parts };
  }

  if (spec.kind === 'number') {
    const n = Number(t);
    if (Number.isNaN(n)) return { error: '需要一個數字' };
    return { value: n };
  }

  if (spec.kind === 'boolean') {
    if (/^(true|1|yes|y|是)$/i.test(t)) return { value: true };
    if (/^(false|0|no|n|否)$/i.test(t)) return { value: false };
    return { error: '需要 true 或 false' };
  }

  if (spec.kind === 'object' || spec.kind === 'null') {
    try { return { value: JSON.parse(t) }; }
    catch (_) { return { error: '需要合法的 JSON' }; }
  }

  return { value: t };
}

// Assemble the typed inbound object from the raw text boxes.
// Blank fields are OMITTED rather than sent as "" — these APIs document their
// filters as optional, and an empty string is not the same as "no filter".
function assembleInbound(docs, values) {
  const inbound = {};
  const errors = [];
  const specs = docs && docs.specs ? docs.specs : [];
  for (const spec of specs) {
    const parsed = parseFieldValue(spec, values[spec.name]);
    if (parsed.error) { errors.push(spec.name + ': ' + parsed.error); continue; }
    if (parsed.empty) continue;
    inbound[spec.name] = parsed.value;
  }
  return { inbound, errors };
}

// The raw docs payload (what `data.docs` carried): `desc` plus one key per field
// with its example value. The host half re-derives types from it, so the client
// never has to agree with the server on a schema.
function docsPayload(docs) {
  const payload = {};
  if (docs && docs.desc) payload.desc = docs.desc;
  const specs = docs && docs.specs ? docs.specs : [];
  for (const spec of specs) payload[spec.name] = spec.example;
  return payload;
}

// Everything about one api that the new session must know, rendered from the
// docs the panel already fetched — desc, one line per parameter (type + example
// value), and the exact payload shape `mode:"docs"` returns. Carrying it in the
// message means the model neither re-fetches the docs nor guesses field names,
// and the pasted message is a self-contained brief for this api id.
//
// The wording is zh-TW like the rest of the panel; the api id, field names and
// JSON stay verbatim because those are the wire contract.
function docsBlock(docs) {
  if (!docs) return [];
  const specs = docs && docs.specs ? docs.specs : [];
  const lines = ['', '這個 api 的文件（已取得 —— 請不要再呼叫 docs 端點）：'];
  if (docs.desc) lines.push('desc: ' + docs.desc);
  if (specs.length) {
    lines.push('參數（名稱: 型別 — 範例值；留空的欄位不送）：');
    for (const spec of specs) {
      lines.push('  ' + spec.name + ': ' + spec.kind + ' — ' + exampleText(spec));
    }
  } else {
    lines.push('參數：無（這個 api 不需要 inbound 欄位）');
  }
  lines.push('原始 docs 內容（與 fdep_call mode:"docs" 回傳的 data.docs 完全相同）：');
  lines.push(JSON.stringify(docsPayload(docs), null, 2));
  return lines;
}

function buildPrompt(apiId, inbound, docs) {
  const inboundJson = JSON.stringify(inbound || {}, null, 2);
  return [
    '請使用 fdep-api-request skill 呼叫下列 FDEP API。',
    '',
    'api: ' + (apiId || '<api_id>'),
  ].concat(docsBlock(docs)).concat([
    '',
    'inbound:',
    inboundJson,
    '',
    '步驟：',
    '1. 不要再取得文件 —— 上面的文件就是欄位名稱與型別的唯一依據。',
    '2. inbound 照上面送即可，空白的篩選條件已經省略。',
    '3. 用 fdep_call 工具（mode: "execute"）執行，並回報結果。',
  ]).join('\n');
}

// Same-origin route the host half registers. POSTing the brief here arms it as
// the *runtime context* of the session the panel is about to open: the host
// claims the first session that assembles after this request, so the new session
// starts with this api's docs in context — no paste needed for the model to know
// the fields. Best-effort: when it fails, the clipboard brief is the fallback.
var CONTEXT_ROUTE = '/plugins/fdep-api-request/context';

function armHostContext(apiId, docs, inbound) {
  return fetch(CONTEXT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiId: apiId, raw: docsPayload(docs), inbound: inbound || {} }),
  }).then(function (res) {
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  });
}

async function tryBrowserCall(apiId, mode, inbound) {
  // Direct browser fetch. CORS likely blocks this against FDEP; the caller
  // treats any failure as "fall back to the prompt path" rather than
  // hard-failing the form.
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl
    ? setTimeout(function () { try { ctrl.abort(); } catch (_) {} }, 15000)
    : null;
  try {
    const res = await fetch(FDEP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api: apiId, do: mode === 'execute', inbound: inbound || {} }),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      parsed = { _raw: text };
    }
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status, body: parsed, cors: false };
    }
    return { ok: true, body: parsed };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err), body: null, cors: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function copyText(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('clipboard unavailable'));
}

// ---------------------------------------------------------------------------
// stylesheet — shipped theme tokens only
// ---------------------------------------------------------------------------

const PANEL_CSS = [
  '.fdep {',
  '  --fdep-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;',
  '  --fdep-line: var(--dsw-alias-border-l1, rgb(0 0 0 / 10%));',
  '  --fdep-line-strong: var(--dsw-alias-border-l2, rgb(0 0 0 / 18%));',
  '  --fdep-surface: var(--dsw-alias-bg-layer-1, #fff);',
  '  --fdep-surface-2: var(--dsw-alias-bg-layer-2, #f4f5f6);',
  '  --fdep-text: var(--dsw-alias-label-primary, #0f1115);',
  '  --fdep-text-2: var(--dsw-alias-label-secondary, #61666b);',
  '  --fdep-brand: var(--dsw-alias-brand-primary, #0f1115);',
  '  box-sizing: border-box;',
  '  height: 100%;',
  '  overflow-y: auto;',
  '  padding: 28px 24px 56px;',
  '  background: var(--dsw-alias-bg-base, #fff);',
  '  color: var(--fdep-text);',
  '  font-family: inherit;',
  '  font-size: 14px;',
  '  line-height: 20px;',
  '}',
  '.fdep *, .fdep *::before, .fdep *::after { box-sizing: border-box; }',
  // Left-aligned column (no `margin: 0 auto`): a main-slot panel starts at the column's
  // left edge, the way the shipped settings panels do it (`.section { max-width: 760px }`).
  '.fdep__shell { max-width: 680px; margin: 0; }',

  /* header */
  '.fdep__head { margin-bottom: 18px; }',
  '.fdep__title { margin: 0 0 8px; font-size: 19px; line-height: 26px; font-weight: 600; letter-spacing: -0.01em; }',
  '.fdep__meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
  '.fdep__chip {',
  '  display: inline-flex; align-items: center; gap: 6px;',
  '  height: 22px; padding: 0 9px;',
  '  border: 1px solid var(--fdep-line);',
  '  border-radius: 999px;',
  '  background: var(--fdep-surface-2);',
  '  color: var(--fdep-text-2);',
  '  font-size: 11px; line-height: 1; white-space: nowrap;',
  '}',
  '.fdep__chip b { font-weight: 600; letter-spacing: 0.04em; color: var(--fdep-brand); }',
  '.fdep__chip code { font-family: var(--fdep-mono); }',

  /* card */
  '.fdep__card {',
  '  border: 1px solid var(--fdep-line);',
  '  border-radius: 10px;',
  '  background: var(--fdep-surface);',
  '  padding: 14px 16px 16px;',
  '  margin-bottom: 12px;',
  '}',
  '.fdep__card--flush { padding: 0; overflow: hidden; }',

  /* step heading */
  '.fdep__step { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }',
  '.fdep__stepnum {',
  '  display: inline-flex; align-items: center; justify-content: center;',
  '  width: 18px; height: 18px; flex: none;',
  '  border: 1px solid var(--fdep-line);',
  '  border-radius: 50%;',
  '  background: var(--fdep-surface-2);',
  '  color: var(--fdep-text-2);',
  '  font-size: 10px; font-weight: 600; line-height: 1;',
  '}',
  '.fdep__steptitle { font-size: 13px; font-weight: 600; }',
  '.fdep__stepsuffix { margin-left: auto; font-size: 11px; color: var(--fdep-text-2); }',

  /* fields */
  '.fdep__label {',
  '  display: block; margin-bottom: 5px;',
  '  font-size: 11px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase;',
  '  color: var(--fdep-text-2);',
  '}',
  '.fdep__row { display: flex; gap: 8px; align-items: center; }',
  '.fdep__grow { flex: 1 1 auto; min-width: 0; }',
  '.fdep__input {',
  '  width: 100%; height: 34px; padding: 0 11px;',
  '  border: 1px solid var(--fdep-line);',
  '  border-radius: 7px;',
  '  background: var(--dsw-alias-bg-base, #fff);',
  '  color: var(--fdep-text);',
  '  font-family: inherit; font-size: 13px;',
  '  transition: border-color .12s ease;',
  '}',
  '.fdep__input::placeholder { color: var(--fdep-text-2); opacity: .65; }',
  '.fdep__input:hover { border-color: var(--fdep-line-strong); }',
  '.fdep__input:focus-visible { border-color: var(--fdep-brand); outline: 2px solid var(--fdep-brand); outline-offset: -1px; }',
  '.fdep__input--mono { font-family: var(--fdep-mono); }',
  '.fdep__input--list { height: auto; min-height: 34px; padding: 7px 11px; resize: vertical; line-height: 18px; }',
  '.fdep__fields { display: flex; flex-direction: column; gap: 12px; }',
  '.fdep__fieldhead { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }',
  '.fdep__fieldtype {',
  '  margin-left: auto; padding: 1px 6px;',
  '  border: 1px solid var(--fdep-line); border-radius: 999px;',
  '  background: var(--fdep-surface-2); color: var(--fdep-text-2);',
  '  font-size: 10px; font-family: var(--fdep-mono); line-height: 15px;',
  '}',
  '.fdep__fieldname { font-family: var(--fdep-mono); font-size: 12px; font-weight: 600; }',
  '.fdep__fielddesc { margin-top: 4px; font-size: 11px; line-height: 16px; color: var(--fdep-text-2); word-break: break-word; }',
  '.fdep__fielddesc code { font-family: var(--fdep-mono); }',
  '.fdep__empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--fdep-text-2); }',

  /* buttons */
  '.fdep__actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }',
  // Inside a step card the card already supplies the padding, so the row must not
  // add its own vertical margins.
  '.fdep__card .fdep__actions { margin: 0; }',
  '.fdep__note { margin: 10px 0 0; font-size: 11px; line-height: 16px; color: var(--fdep-text-2); }',
  '.fdep__btn {',
  '  display: inline-flex; align-items: center; justify-content: center; gap: 6px;',
  '  height: 34px; padding: 0 14px;',
  '  border: 1px solid var(--fdep-line);',
  '  border-radius: 7px;',
  '  background: var(--fdep-surface);',
  '  color: var(--fdep-text);',
  '  font-family: inherit; font-size: 13px; font-weight: 500; white-space: nowrap;',
  '  cursor: pointer;',
  '  transition: background .12s ease, border-color .12s ease, opacity .12s ease;',
  '}',
  '.fdep__btn:hover:not(:disabled) { background: var(--fdep-surface-2); border-color: var(--fdep-line-strong); }',
  '.fdep__btn:focus-visible { outline: 2px solid var(--fdep-brand); outline-offset: 1px; }',
  '.fdep__btn:disabled { opacity: .45; cursor: not-allowed; }',
  '.fdep__btn--primary { background: var(--fdep-brand); border-color: var(--fdep-brand); color: var(--dsw-alias-bg-base, #fff); }',
  '.fdep__btn--primary:hover:not(:disabled) { background: var(--fdep-brand); border-color: var(--fdep-brand); opacity: .86; }',
  '.fdep__btn--ghost { border-color: transparent; background: transparent; color: var(--fdep-text-2); }',
  '.fdep__btn--ghost:hover:not(:disabled) { background: var(--fdep-surface-2); color: var(--fdep-text); }',
  '.fdep__btn--sm { height: 26px; padding: 0 10px; font-size: 12px; }',

  /* spinner */
  '.fdep__spin {',
  '  width: 12px; height: 12px; flex: none;',
  '  border: 2px solid currentColor; border-right-color: transparent;',
  '  border-radius: 50%;',
  '  animation: fdep-spin .7s linear infinite;',
  '}',
  '@keyframes fdep-spin { to { transform: rotate(360deg); } }',
  '@media (prefers-reduced-motion: reduce) { .fdep__spin { animation-duration: 2.4s; } }',

  /* status strip */
  '.fdep__status {',
  '  --fdep-state: var(--fdep-text-2);',
  '  display: flex; gap: 9px; align-items: flex-start;',
  '  padding: 10px 12px;',
  '  margin-bottom: 12px;',
  '  border: 1px solid var(--fdep-line);',
  '  border-radius: 8px;',
  '  background: var(--fdep-surface);',
  '  font-size: 12px; line-height: 18px;',
  '}',
  '.fdep__status--ok { --fdep-state: var(--dsw-alias-state-success-primary, #0a7d43); }',
  '.fdep__status--info { --fdep-state: var(--dsw-alias-state-business-primary, #2563eb); }',
  '.fdep__status--warn { --fdep-state: var(--dsw-alias-state-warn-primary, #a35b00); }',
  '.fdep__status--err { --fdep-state: var(--dsw-alias-state-error-primary, #c62828); }',
  '.fdep__status--busy { --fdep-state: var(--fdep-brand); }',
  '.fdep__dot { width: 7px; height: 7px; flex: none; margin-top: 6px; border-radius: 50%; background: var(--fdep-state); }',
  '.fdep__statustitle { font-weight: 600; color: var(--fdep-state); }',
  '.fdep__statusbody { margin-top: 2px; color: var(--fdep-text-2); white-space: pre-wrap; word-break: break-word; }',

  /* output */
  '.fdep__bar { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid var(--fdep-line); background: var(--fdep-surface); }',
  '.fdep__barlabel { font-size: 11px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--fdep-text-2); }',
  '.fdep__barmeta { margin-left: auto; font-family: var(--fdep-mono); font-size: 11px; color: var(--fdep-text-2); }',
  '.fdep__pre {',
  '  margin: 0; padding: 12px;',
  '  max-height: 300px; overflow: auto;',
  '  background: var(--fdep-surface-2);',
  '  color: var(--fdep-text);',
  '  font-family: var(--fdep-mono); font-size: 11.5px; line-height: 17px;',
  '  white-space: pre-wrap; word-break: break-word;',
  '}',

  /* details */
  '.fdep__details { margin-top: 16px; border-top: 1px solid var(--fdep-line); padding-top: 12px; }',
  '.fdep__summary { cursor: pointer; font-size: 12px; color: var(--fdep-text-2); user-select: none; }',
  '.fdep__summary:hover { color: var(--fdep-text); }',
  '.fdep__details .fdep__pre { margin-top: 10px; border: 1px solid var(--fdep-line); border-radius: 8px; max-height: 180px; }',

  /* sidebar glyph — green in both themes via the success token */
  '.fdep-glyph {',
  '  display: inline-flex; align-items: center; justify-content: center;',
  // Measured in the running GUI: this resolves to #22c55e in light mode and a
  // brighter green under the dark theme, so no colour is hard-coded here.
  '  color: var(--dsw-alias-state-success-primary, #22c55e);',
  '  opacity: .78;',
  '  transition: opacity .12s ease;',
  '}',
  '.fdep-glyph--active { opacity: 1; }',
  '.fdep-glyph svg { display: block; }',
].join('\n');

function installStyles() {
  // A static bundle has NO `styles` builtin — that belongs to sandboxed
  // dynamic Packages, the same way the `React` and `ctx` globals do. An
  // earlier revision guarded on `typeof styles !== 'undefined'` and silently
  // returned a no-op, so the panel shipped with zero CSS in the real GUI while
  // the offline preview (which inlines PANEL_CSS itself) looked perfect.
  //
  // Inject through `document` instead. The official client plugins tag their
  // <style> with data-plugin, which is also how the HMR swap knows to remove
  // the previous generation's tag.
  if (typeof document === 'undefined' || !document.head) {
    return function noop() {};
  }
  const tag = document.createElement('style');
  tag.setAttribute('data-plugin', 'fdep-api-request-bundle');
  tag.textContent = PANEL_CSS;
  document.head.appendChild(tag);
  return function disposeStyles() {
    try { tag.remove(); } catch (_) { /* already detached */ }
  };
}

// ---------------------------------------------------------------------------
// presentational pieces
// ---------------------------------------------------------------------------

const STATUS_TITLES = {
  busy: 'Working',
  ok: 'Done',
  warn: 'Heads up',
  err: 'Failed',
  info: 'Note',
};

function makeStatus(e) {
  return function Status(props) {
    const status = props.status;
    if (!status) return null;
    const kind = status.kind || 'info';
    return e(
      'div',
      {
        className: 'fdep__status fdep__status--' + kind,
        role: 'status',
        'aria-live': 'polite',
      },
      e('span', { className: 'fdep__dot', 'aria-hidden': 'true' }),
      e(
        'div',
        { className: 'fdep__grow' },
        e('div', { className: 'fdep__statustitle' }, status.title || STATUS_TITLES[kind] || ''),
        status.detail ? e('div', { className: 'fdep__statusbody' }, status.detail) : null,
      ),
    );
  };
}

function makeSpinner(e) {
  return function Spinner() {
    return e('span', { className: 'fdep__spin', 'aria-hidden': 'true' });
  };
}

function makeButton(e) {
  return function Button(props) {
    const variant = props.variant || 'default';
    // The default look is the bare `.fdep__btn` rule; only non-default
    // variants add a modifier, so the markup never carries a class that has
    // no rule behind it.
    const variantClass = variant === 'default' ? '' : ' fdep__btn--' + variant;
    const size = props.size === 'sm' ? ' fdep__btn--sm' : '';
    const className = 'fdep__btn' + variantClass + size;
    return e(
      'button',
      {
        type: 'button',
        className: className,
        disabled: !!props.disabled,
        onClick: props.onClick,
        title: props.title,
        'aria-label': props.ariaLabel,
      },
      props.children,
    );
  };
}

function makeTextField(e) {
  return function TextField(props) {
    return e('input', {
      id: props.id,
      type: 'text',
      className: 'fdep__input' + (props.mono ? ' fdep__input--mono' : ''),
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder,
      spellCheck: false,
      autoComplete: 'off',
      'aria-label': props.ariaLabel,
      onChange: props.onChange,
      onKeyDown: props.onKeyDown,
    });
  };
}

function makeGlyph(e) {
  // Rendered inside the shell's own 56px rail button, which supplies the hit
  // area, hover and focus chrome — so this is only the mark itself.
  //
  // The mark is a hexagonal node with a filled core: the usual "gateway"
  // reading, and legible at 18–20px where a literal plug or hub-with-spokes
  // turns to mush.
  //
  // Colour is NOT set here. The SVG paints with `currentColor` and the
  // stylesheet decides what that is (the green success token), so the mark
  // stays green in both themes without this file knowing about themes at all.
  return function Glyph(props) {
    const size = (props && props.size) || 18;
    const active = !!(props && props.active);
    return e(
      'span',
      {
        className: 'fdep-glyph' + (active ? ' fdep-glyph--active' : ''),
        style: { width: size + 'px', height: size + 'px' },
      },
      e(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // Pointy-top hexagon, circumradius 6.5 about (8, 8).
        e('path', { d: 'M8 1.5 13.63 4.75v6.5L8 14.5 2.37 11.25v-6.5z' }),
        // Filled core: the node at the centre of the gateway.
        e('circle', { cx: 8, cy: 8, r: 1.75, fill: 'currentColor', stroke: 'none' }),
      ),
    );
  };
}

// ---------------------------------------------------------------------------
// main panel
// ---------------------------------------------------------------------------

function makeMainPanel(e, React, services) {
  const useState = React.useState;
  const Status = makeStatus(e);
  const Spinner = makeSpinner(e);
  const Button = makeButton(e);
  const TextField = makeTextField(e);

  function FdepPanel(slotProps) {
    // The slot system injects hooks and lifecycle helpers here (inputActions,
    // useInput, renderSlot, …). This panel is self-contained, but the slot
    // props are still forwarded so a wrapping SlotProvider keeps working.
    void slotProps;

    // Prefilled with the API this panel is used for most (TWSE/TPEX 當日重大訊息),
    // so "Fetch docs" is one click away. The field stays editable for any api_id.
    const [apiId, setApiId] = useState('twseMops.todayMaterial');
    const [docs, setDocs] = useState(null);
    const [params, setParams] = useState({});
    const [status, setStatus] = useState(null);
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(null); // null | 'docs' | 'execute'
    const [copied, setCopied] = useState(null); // null | 'prompt' | 'result'

    function flashCopied(what) {
      setCopied(what);
      setTimeout(function () { setCopied(null); }, 1700);
    }

    function setParam(name, value) {
      setParams(function (prev) {
        const next = {};
        for (const k of Object.keys(prev)) next[k] = prev[k];
        next[name] = value;
        return next;
      });
    }

    async function onFetchDocs() {
      const id = apiId.trim();
      if (!id) {
        setStatus({ kind: 'warn', title: '需要 API ID', detail: '請先輸入 api_id，例如 test.demo。' });
        return;
      }
      setBusy('docs');
      setStatus({ kind: 'busy', title: '取得文件中', detail: 'POST ' + FDEP_HOST + FDEP_PATH + '（do: false）' });
      const r = await tryBrowserCall(id, 'docs', {});
      setBusy(null);
      if (!r.ok) {
        setDocs(null);
        setParams({});
        setResult(null);
        setStatus(
          r.cors
            ? {
                kind: 'warn',
                title: '瀏覽器請求被擋下',
                detail:
                  '看起來是網路或 CORS 被拒（' + r.error + '）。\n' +
                  '宿主端的 fdep_call 工具沒有這個限制 —— 請用「複製提示」帶到工作階段裡執行。',
              }
            : {
                kind: 'err',
                title: '取得文件失敗',
                detail: r.error + '\n' + JSON.stringify(r.body, null, 2),
              },
        );
        return;
      }
      const split = readDocs(r.body && r.body.data && r.body.data.docs);
      setDocs(split);
      const fresh = {};
      for (const spec of split.specs) fresh[spec.name] = '';
      setParams(fresh);
      const count = split.specs.length;
      const kinds = split.specs.map((s) => s.kind);
      const hasArray = kinds.indexOf('array') !== -1;
      setStatus({
        kind: 'ok',
        title: '已取得文件，共 ' + count + ' 個參數',
        detail: (split.desc || '填好下面的欄位後執行。')
          + (hasArray ? '\n列表欄位可用逗號分隔多個值。' : ''),
      });
    }

    async function onRun() {
      const id = apiId.trim();
      if (!id) {
        setStatus({ kind: 'warn', title: '需要 API ID', detail: '請先輸入 api_id。' });
        return;
      }
      if (!docs) {
        setStatus({ kind: 'warn', title: '尚未取得文件', detail: '請先取得文件，才知道 inbound 有哪些欄位。' });
        return;
      }
      const assembled = assembleInbound(docs, params);
      if (assembled.errors.length) {
        setStatus({
          kind: 'err',
          title: '請檢查欄位值',
          detail: assembled.errors.join('\n'),
        });
        return;
      }
      const inbound = assembled.inbound;
      setBusy('execute');
      setStatus({ kind: 'busy', title: '執行 ' + id, detail: 'POST（do: true）' });
      const r = await tryBrowserCall(id, 'execute', inbound);
      setBusy(null);
      if (!r.ok) {
        setResult(r.body);
        setStatus(
          r.cors
            ? {
                kind: 'warn',
                title: '瀏覽器請求被擋下',
                detail:
                  '看起來是網路或 CORS 被拒（' + r.error + '）。\n' +
                  '請改用宿主端 fdep_call 工具 —— 複製下面的提示帶到工作階段執行。',
              }
            : { kind: 'err', title: '執行失敗', detail: r.error },
        );
        return;
      }
      setResult(r.body);
      setStatus({ kind: 'ok', title: '完成', detail: '回應顯示在下方。' });
    }

    async function onCopyPrompt() {
      // Same assembled, typed inbound as the visible block below and as the Run
      // path — a list field must not travel as a comma-joined string here either.
      const text = buildPrompt(apiId.trim(), assembleInbound(docs, params).inbound, docs);
      try {
        await copyText(text);
        flashCopied('prompt');
      } catch (_) {
        setStatus({
          kind: 'warn',
          title: '無法使用剪貼簿',
          detail: '請展開下方「預先組好的 skill 提示」手動複製。',
        });
      }
    }

    async function onCopyResult() {
      try {
        await copyText(JSON.stringify(result, null, 2));
        flashCopied('result');
      } catch (_) {
        setStatus({ kind: 'warn', title: '無法使用剪貼簿', detail: '請手動選取回應文字複製。' });
      }
    }

    async function onNewSession() {
      const uiWorkspace = services.uiWorkspace;
      if (!uiWorkspace || typeof uiWorkspace.startSession !== 'function') {
        setStatus({
          kind: 'err',
          title: '服務不可用',
          detail: '這個組合裡沒有掛載 uiWorkspace。',
        });
        return;
      }
      // The TYPED inbound, assembled exactly like the form's own Run path — the
      // docs field types decide the shapes, so a list never travels as a
      // comma-joined string (neither in the clipboard brief nor in the context).
      const briefInbound = assembleInbound(docs, params).inbound;
      // 1. Arm the docs as the new session's runtime context. This has to reach
      //    the host BEFORE the session exists: the host binds the brief to the
      //    first session that assembles after this request.
      let armed = false;
      try {
        const reply = await armHostContext(apiId.trim(), docs, briefInbound);
        armed = !!(reply && reply.armed);
      } catch (err) {
        armed = false;
        console.warn('[fdep-api-request] could not arm the host context:', err && err.message ? err.message : err);
      }
      // 2. Put the brief on the clipboard too. The panel is a `main` occupant, so
      //    opening a session replaces it on screen — without this the user has to
      //    walk back to the panel just to press "Copy prompt".
      let copied = false;
      try {
        await copyText(buildPrompt(apiId.trim(), briefInbound, docs));
        copied = true;
      } catch (_) {
        copied = false;
      }
      // 3. Open the session.
      try {
        uiWorkspace.startSession();
        const context = armed
          ? '這個 api 的文件已注入它的上下文。'
          : '宿主端上下文不可用 —— 提示本身就帶著文件。';
        const paste = copied
          ? '提示也已在剪貼簿 —— 貼上（Ctrl/Cmd+V）就能說明要做什麼。'
          : '剪貼簿不可用 —— 請展開「預先組好的 skill 提示」手動複製。';
        setStatus({ kind: armed ? 'info' : 'warn', title: '已開啟新工作階段', detail: context + ' ' + paste });
      } catch (err) {
        setStatus({ kind: 'err', title: '無法開啟工作階段', detail: (err && err.message) || String(err) });
      }
    }

    const specs = docs ? docs.specs : [];
    const ready = !busy && !!docs;
    // The prompt must carry the SAME typed object the browser path would send,
    // otherwise the copy-and-paste fallback reintroduces the bug the form just
    // fixed (an array arriving as a string). It also carries the fetched docs.
    const promptInbound = assembleInbound(docs, params).inbound;
    const prompt = buildPrompt(apiId.trim(), promptInbound, docs);

    const field = function (spec) {
      const name = spec.name;
      const value = params[name];
      const isList = spec.kind === 'array';
      // A list field gets a textarea: one value per line reads better than a
      // comma string once the list is longer than a few entries, and the
      // parser accepts commas too.
      const control = isList
        ? e('textarea', {
            id: 'fdep-field-' + name,
            className: 'fdep__input fdep__input--list',
            rows: 2,
            value: value === undefined || value === null ? '' : String(value),
            placeholder: placeholderFor(spec),
            spellCheck: false,
            'aria-label': name,
            onChange: function (ev) { setParam(name, ev.target.value); },
          })
        : e(TextField, {
            id: 'fdep-field-' + name,
            value: value,
            placeholder: placeholderFor(spec),
            ariaLabel: name,
            onChange: function (ev) { setParam(name, ev.target.value); },
          });
      return e(
        'div',
        { key: name },
        e(
          'div',
          { className: 'fdep__fieldhead' },
          e('label', { className: 'fdep__fieldname', htmlFor: 'fdep-field-' + name }, name),
          e('span', { className: 'fdep__fieldtype' }, spec.kind),
        ),
        control,
        e(
          'div',
          { className: 'fdep__fielddesc' },
          isList ? '以逗號或換行分隔。' : '',
          '範例：',
          e('code', null, exampleText(spec)),
        ),
      );
    };

    return e(
      'div',
      { className: 'fdep', 'aria-busy': busy ? 'true' : 'false' },
      e(
        'div',
        { className: 'fdep__shell' },

        // ---- header ----
        e(
          'header',
          { className: 'fdep__head' },
          e('h2', { className: 'fdep__title' }, 'MCP Gateway'),
          e(
            'div',
            { className: 'fdep__meta' },
            e('span', { className: 'fdep__chip' }, e('b', null, 'POST'), e('code', null, FDEP_PATH)),
            e('span', { className: 'fdep__chip' }, FDEP_HOST),
            e('span', { className: 'fdep__chip' }, 'skill: fdep-api-request'),
          ),
        ),

        e(Status, { status: status }),

        // ---- step 1 ----
        e(
          'section',
          { className: 'fdep__card' },
          e(
            'div',
            { className: 'fdep__step' },
            e('span', { className: 'fdep__stepnum' }, '1'),
            e('span', { className: 'fdep__steptitle' }, '選擇 API'),
          ),
          e('label', { className: 'fdep__label', htmlFor: 'fdep-api-id' }, 'API ID'),
          e(
            'div',
            { className: 'fdep__row' },
            e(TextField, {
              id: 'fdep-api-id',
              value: apiId,
              placeholder: '例：test.demo',
              mono: true,
              ariaLabel: 'API ID',
              onChange: function (ev) { setApiId(ev.target.value); },
              onKeyDown: function (ev) { if (ev.key === 'Enter') onFetchDocs(); },
            }),
            e(
              Button,
              { onClick: onFetchDocs, disabled: !!busy },
              busy === 'docs' ? e(Spinner, null) : null,
              busy === 'docs' ? '載入中…' : '取得文件',
            ),
          ),
        ),

        // ---- step 2 ----
        e(
          'section',
          { className: 'fdep__card' },
          e(
            'div',
            { className: 'fdep__step' },
            e('span', { className: 'fdep__stepnum' }, '2'),
            e('span', { className: 'fdep__steptitle' }, '參數'),
            e(
              'span',
              { className: 'fdep__stepsuffix' },
              docs ? specs.length + ' 個欄位' : '來自文件',
            ),
          ),
          docs
            ? specs.length
              ? e('div', { className: 'fdep__fields' }, specs.map(field))
              : e('p', { className: 'fdep__empty' }, '這個 API 沒有參數，直接執行即可。')
            : e('p', { className: 'fdep__empty' }, '先取得文件，才知道這個 API 需要哪些欄位。'),
        ),

        // ---- step 3 ----
        e(
          'section',
          { className: 'fdep__card' },
          e(
            'div',
            { className: 'fdep__step' },
            e('span', { className: 'fdep__stepnum' }, '3'),
            e('span', { className: 'fdep__steptitle' }, '執行'),
            e(
              'span',
              { className: 'fdep__stepsuffix' },
              busy === 'execute' ? '執行中…' : (docs ? '已取得文件' : '尚未取得文件'),
            ),
          ),
          e(
            'div',
            { className: 'fdep__actions' },
            e(
              Button,
              { variant: 'primary', onClick: onRun, disabled: !ready },
              busy === 'execute' ? e(Spinner, null) : null,
              busy === 'execute' ? '執行中…' : '執行',
            ),
            e(
              Button,
              { onClick: onCopyPrompt, disabled: !ready },
              copied === 'prompt' ? '已複製' : '複製提示',
            ),
            // Both fallbacks need the docs: the brief only becomes a complete
            // context once the api's fields are known, so the buttons stay inert
            // until Fetch docs succeeds.
            e(Button, { onClick: onNewSession, disabled: !ready }, '開新工作階段'),
          ),
          e(
            'p',
            { className: 'fdep__note' },
            '「開新工作階段」會把這份 api 文件注入新工作階段的上下文，並把完整提示複製到剪貼簿。',
          ),
        ),

        // ---- result ----
        result
          ? e(
              'section',
              { className: 'fdep__card fdep__card--flush' },
              e(
                'div',
                { className: 'fdep__bar' },
                e('span', { className: 'fdep__barlabel' }, '回應'),
                result && result.trace_id
                  ? e('span', { className: 'fdep__barmeta' }, 'trace ' + result.trace_id)
                  : null,
                e(
                  Button,
                  { variant: 'ghost', size: 'sm', onClick: onCopyResult, ariaLabel: '複製回應' },
                  copied === 'result' ? '已複製' : '複製',
                ),
              ),
              e('pre', { className: 'fdep__pre' }, JSON.stringify(result, null, 2)),
            )
          : null,

        // ---- fallback prompt ----
        e(
          'details',
          { className: 'fdep__details' },
          e('summary', { className: 'fdep__summary' }, '預先組好的 skill 提示（貼到新工作階段）'),
          e('pre', { className: 'fdep__pre' }, prompt),
        ),
      ),
    );
  }

  return FdepPanel;
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

function pluginFactory(require) {
  const React = require('react');
  const e = React.createElement;

  const Glyph = makeGlyph(e);

  return {
    // `slots` is the only HARD dependency: without it there is nothing to mount.
    // `uiWorkspace` is OPTIONAL and is therefore NOT listed here — declaring it
    // would park the whole plugin in a composition without the workspace plugin,
    // hiding the sidebar entry too.
    //
    // It must also be resolved LAZILY, through ctx.inject() below. This entry is
    // `dsh.client.immediately`, so apply() can run before the workspace plugin
    // has provided the service — and `ctx.get(name)` only answers for a service
    // whose providing fiber is already active (`ReflectService._getImpl` filters
    // on `fiber.state === ACTIVE`). Reading it once inside apply() is exactly why
    // "New session" used to answer "Service unavailable" forever, in a GUI where
    // the service was in fact mounted all along.
    inject: ['slots'],
    apply(ctx) {
      const services = { uiWorkspace: undefined };
      if (typeof ctx.inject === 'function') {
        ctx.inject(['uiWorkspace'], function (scope) {
          services.uiWorkspace = scope.uiWorkspace;
          return function () { services.uiWorkspace = undefined; };
        });
      }
      const Panel = makeMainPanel(e, React, services);

      // `ctx.effect(fn, label)` invokes `fn` immediately and uses its RETURN
      // VALUE as the disposer, so an already-built disposer must be wrapped in
      // a factory or it tears the stylesheet down at once.
      const disposeStyles = installStyles();
      ctx.effect(function () { return disposeStyles; }, 'fdep-api-request:styles.dispose');

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'fdep-api-request',
            order: 50,
            label: function () { return 'MCP Gateway'; },
          },
          function (iconProps) { return e(Glyph, iconProps); },
        );
      });

      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          { name: 'main', key: 'fdep-api-request' },
          function (slotProps) { return e(Panel, slotProps); },
        );
      });
    },
  };
}

// The exact stylesheet this plugin installs, exposed as a property of the
// factory so an offline harness can render with the real CSS instead of a
// hand-copied approximation. Attached unconditionally because the property
// must survive whichever load path runs; the browser never reads it.
pluginFactory.PANEL_CSS = PANEL_CSS;

// dsh-client-modules loads us via window.__ModuleLoader__.load with a
// loader-provided `require`. When the file is required from Node (tests,
// preview generation), fall back to module.exports so the same factory is
// reachable either way.
if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
  window.__ModuleLoader__.load({
    id: 'fdep-api-request-bundle',
    factory: pluginFactory,
  });
} else if (typeof module !== 'undefined' && module.exports) {
  module.exports = pluginFactory;
}
