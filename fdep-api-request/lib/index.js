'use strict';

// Host plugin for fdep-api-request-bundle.
//
// Registers a single model-facing tool `fdep_call` that wraps the FDEP API
// dispatch protocol documented in the fdep-api-request skill. The skill file
// remains the single source of truth for the workflow; this plugin only
// encodes the deterministic shape the model used to repeat by hand:
//
//   POST https://abc.feg.com.tw/oauth2/fdep
//   Content-Type: application/json
//   { api: <apiId>, do: <bool>, inbound: <object> }
//
// Two operations share the same tool: mode='docs' sends do:false and returns
// the parsed docs structure (with `desc` flagged); mode='execute' sends
// do:true with the provided inbound and returns the data payload plus the
// trace_id.

const FDEP_URL = 'https://abc.feg.com.tw/oauth2/fdep';

// ---------------------------------------------------------------------------
// apiKey — the gateway's authorization credential, for `do: true` only.
//
// Measured on 2026-11-18 against the live endpoint (see README "apiKey"):
//
//   body {api, do:true, inbound}                     -> 200, no authorization
//   body {api, do:true, inbound, apiKey: <mask71>}   -> the gateway accepts the
//                                                       shape and then runs its
//                                                       authorization step
//   body {..., apiKey: <mask67>}                     -> 500 "invalid key..."
//   body {..., apiKey: <raw sk-…>}                   -> 500 "invalid key..."
//   body {..., apiKey: <mask71 of a synthetic key>}  -> 500 "invalid key..."
//
// So the accepted shape is MASK.md's *display* formula (the key keeps its `sk-`
// inside the base64), which is what every other `abc.feg.com.tw` client in this
// workspace sends. MASK.md's "apiKey for abc.feg.com.tw" section describes a
// 67-character variant that drops the `sk-` from the inner string; that shape
// is rejected by this endpoint, so it is deliberately not used here.
//
// Sending it is not optional: an execute without a usable key would run
// unauthorized, so a missing credential fails the call instead of falling back.
// ---------------------------------------------------------------------------

/** Where the raw key lives, in preference order (the first hit wins). */
const API_KEY_REFS = ['AIFE_API_KEY', 'FEG_API_KEY', 'DEEPSEEK_API_KEY'];
/** A masked key is ~71 bytes; refuse anything absurd rather than masking it. */
const API_KEY_MAX = 4096;

/**
 * The credentials file DSH itself reads. `DSH_CREDENTIALS_PATH` wins when set
 * (the shipped dotenv-ish override), otherwise `$DSH_HOME/.credentials.yaml`.
 * @returns the absolute path.
 */
function credentialsFilePath() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const override = process.env.DSH_CREDENTIALS_PATH;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * Read one `refs:` entry out of the credentials YAML text.
 *
 * Deliberately a minimal line parser: the file is written by DSH and this needs
 * exactly one scalar from one block. It stops at the first unindented line, so a
 * same-named key in a later top-level block cannot be picked up by accident.
 *
 * @param text - the credentials file contents.
 * @param name - the reference name, e.g. `AIFE_API_KEY`.
 * @returns the raw value, or null.
 */
function readCredentialRef(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || name === '') return null;
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (!inRefs) continue;
    if (/^\S/.test(line)) break;
    const m = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!m || m[1] !== name) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value === '' ? null : value;
  }
  return null;
}

/**
 * Mask one key exactly as MASK.md's display formula specifies:
 * `"sk-" + base64(key + "@" + ISO)`. Reversible by construction — see MASK.md —
 * so the result is a credential: send it to `abc.feg.com.tw` and nowhere else.
 *
 * @param key - the raw `sk-…` key.
 * @param now - the timestamp to embed (tests pin this).
 * @returns the masked value.
 */
function maskApiKey(key, now) {
  if (typeof key !== 'string' || key === '') throw new Error('maskApiKey: key must be a non-empty string');
  const stamp = '@' + (now instanceof Date ? now : new Date()).toISOString();
  return 'sk-' + Buffer.from(key + stamp, 'utf8').toString('base64');
}

/**
 * Resolve the first available reference and return its masked form.
 * Never returns the raw key: the caller only ever forwards the masked value.
 *
 * @param options - `{ now, text }`; `text` lets tests skip the filesystem.
 * @returns `{ ok: true, apiKey, ref, source }` or `{ ok: false, error }`.
 */
function maskedApiKey(options) {
  const opts = options || {};
  const file = credentialsFilePath();
  let text = opts.text;
  if (typeof text !== 'string') {
    try {
      text = require('node:fs').readFileSync(file, 'utf8');
    } catch (err) {
      return {
        ok: false,
        error: 'execute 需要 apiKey，但讀不到憑證檔（' + file + '）：' + (err && err.message ? err.message : String(err)),
      };
    }
  }
  for (const ref of API_KEY_REFS) {
    const key = readCredentialRef(text, ref);
    if (!key) continue;
    if (key.length > API_KEY_MAX) {
      return { ok: false, error: '憑證 ' + ref + ' 長度不尋常（' + key.length + ' bytes），拒絕使用' };
    }
    try {
      return { ok: true, apiKey: maskApiKey(key, opts.now), ref, source: file };
    } catch (err) {
      return { ok: false, error: '遮蔽失敗（' + ref + '）：' + (err && err.message ? err.message : String(err)) };
    }
  }
  return {
    ok: false,
    error: '憑證檔裡找不到可用的 apiKey（試過 ' + API_KEY_REFS.join('、') + '）——檔案：' + file,
  };
}

/** Exact route the browser posts "run this api through the host" to. */
const CALL_ROUTE = '/plugins/fdep-api-request/call';
/** One call's own budget; the tool's registry timeout is the outer bound. */
const CALL_TIMEOUT_MS = 25000;

/**
 * The one place the FDEP request body is built.
 *
 * `do: false` (docs) is anonymous by contract and must NOT carry a key — the
 * gateway answers it without one, and sending one would run its authorization
 * step for a request that does not need it (measured: it then stalls).
 * `do: true` (execute) always carries the masked key; a missing credential is
 * an error, never a silent unauthenticated call.
 *
 * @param apiId - the api identifier.
 * @param doExec - true to execute, false to fetch docs.
 * @param inbound - the business argument object.
 * @param signal - external abort signal (optional).
 * @returns `{ ok, status, parsed, raw, error, keyRef }`.
 */
async function callFdep(apiId, doExec, inbound, signal, options) {
  const body = { api: apiId, do: doExec === true, inbound: inbound && typeof inbound === 'object' ? inbound : {} };
  let keyRef = null;
  if (body.do === true) {
    const cred = maskedApiKey(options);
    if (!cred.ok) return { ok: false, status: 0, parsed: null, raw: '', error: cred.error, keyRef: null };
    body.apiKey = cred.apiKey;
    keyRef = cred.ref;
  }

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, CALL_TIMEOUT_MS) : null;
  if (ctrl && signal) {
    if (signal.aborted) { try { ctrl.abort(); } catch (_) {} }
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', () => { try { ctrl.abort(); } catch (_) {} });
  }
  try {
    const res = await fetch(FDEP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    const raw = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      parsed = { _raw: raw };
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        parsed,
        raw,
        keyRef,
        error: 'upstream HTTP ' + res.status
          + (body.do === true ? '（已帶 apiKey' + (keyRef ? ' from ' + keyRef : '') + '）' : ''),
      };
    }
    return { ok: true, status: res.status, parsed, raw, keyRef, error: null };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      parsed: null,
      raw: '',
      keyRef,
      error: (aborted ? 'upstream did not answer within ' + CALL_TIMEOUT_MS + 'ms' : 'network error: ' + (err && err.message ? err.message : String(err)))
        + (body.do === true ? '（已帶 apiKey' + (keyRef ? ' from ' + keyRef : '') + '）' : ''),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Exact route the browser posts "arm this api's docs as context" to. */
const CONTEXT_ROUTE = '/plugins/fdep-api-request/context';
/** Prompt-context name; unique in the registry, and how it reads in a trace. */
const CONTEXT_NAME = 'fdep-api-request/docs';
/** Built-in runtime contexts sit at 110/115/120, scene-template's selection at 130;
 * the api docs follow them and precede nothing that matters. */
const CONTEXT_ORDER = 140;
/** The armed brief is a hint, not a document: cap what enters the prompt. */
const CONTEXT_MAX = 8000;
/** One scenario's api set is a handful, not a catalogue. */
const ARM_MAX = 12;
/** An arm no session ever consumed is dropped, so it cannot leak into a much
 * later session. A bound session keeps its docs for that session's lifetime. */
const ARM_TTL_MS = 30 * 60 * 1000;
/** The only accepted body shape is one small api brief. */
const BODY_MAX = 256 * 1024;

/** @param value - anything from the wire. @returns a string, never undefined. */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * The prompt interpolates `{{name}}` groups and throws on an unknown variable,
 * so injected prose must never carry that shape: a docs payload that happened to
 * contain mustache syntax would otherwise break every later step of the session.
 * @param text - the text about to become prompt context.
 * @returns the same text with `{{` neutralised.
 */
function promptSafe(text) {
  return String(text).split('{{').join('{ {');
}

/**
 * Read one small request body, refusing anything oversized.
 * @param req - the HTTP request.
 * @returns the body as UTF-8 text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * One api's section: its id, the docs it was fetched with, and the inbound the
 * panel held for it.
 * @param apiId - the FDEP api identifier.
 * @param rawDocs - the raw `data.docs` payload (every key but `desc` is a field).
 * @param inbound - the typed inbound the panel would send.
 * @returns the section's lines.
 */
function renderOneApi(apiId, rawDocs, inbound) {
  const split = splitDocs(rawDocs);
  const lines = [];
  lines.push('api: ' + apiId);
  lines.push('desc: ' + (split.desc || '(無)'));
  lines.push('');
  lines.push('參數（名稱: 型別 — 範例值；留空的欄位不送）：');
  const names = Object.keys(split.params);
  if (names.length === 0) {
    lines.push('  （這個 api 不需要 inbound 欄位）');
  } else {
    for (const name of names) {
      let example;
      try {
        example = JSON.stringify(split.params[name]);
      } catch (_) {
        example = String(split.params[name]);
      }
      lines.push('  ' + name + ': ' + split.types[name] + ' — ' + example);
    }
  }
  lines.push('');
  lines.push('原始 docs 內容（與 fdep_call mode:"docs" 回傳的 data.docs 完全相同）：');
  try {
    lines.push(JSON.stringify(rawDocs || {}, null, 2));
  } catch (_) {
    lines.push('(無法序列化)');
  }
  lines.push('');
  lines.push('這個 api 的 inbound（面板目前的值；使用者另有指示時以使用者為準）：');
  try {
    lines.push(JSON.stringify(inbound || {}, null, 2));
  } catch (_) {
    lines.push('{}');
  }
  return lines;
}

/**
 * Render the brief the panel armed: one section per collected api. One scenario
 * regularly spans several FDEP apis, so the context carries the whole set — each
 * with its own docs and its own inbound — instead of a single call.
 * @param apis - `[{apiId, rawDocs, inbound}]`.
 * @returns the prompt-context text.
 */
function renderDocsContext(apis) {
  const set = Array.isArray(apis) ? apis.filter((entry) => entry && typeof entry.apiId === 'string' && entry.apiId !== '') : [];
  if (set.length === 0) return '';
  const lines = [];
  lines.push('GUI 的「MCP網關」面板把下列 ' + set.length + ' 個 FDEP api 的文件注入為本工作階段的背景上下文。');
  lines.push('請把它們當作欄位名稱與型別的唯一依據，不要再呼叫 docs；每個 api 各自帶著自己的 inbound。');
  for (const entry of set) {
    lines.push('');
    lines.push('============================================================');
    for (const line of renderOneApi(entry.apiId, entry.rawDocs, entry.inbound)) lines.push(line);
  }
  lines.push('');
  lines.push('============================================================');
  lines.push('要執行時，用 fdep_call 工具（mode:"execute"）帶對應 api 的 inbound；需要再確認欄位時才用 mode:"docs"。');
  lines.push('使用者指定哪個 api 就呼叫哪個；沒指定就先問。');
  return promptSafe(lines.join('\n'));
}

/**
 * Normalize a request body into the api set, accepting both the multi-api form
 * (`{apis: [...]}`) and the single-api form (`{apiId, raw, inbound}`).
 * @param payload - the parsed request body.
 * @returns `[{apiId, rawDocs, inbound}]` (empty when nothing usable was sent).
 */
function readArmedApis(payload) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const out = [];
  if (payload !== null && payload !== undefined && Array.isArray(payload.apis)) {
    for (const entry of payload.apis) {
      if (!isObject(entry)) continue;
      const apiId = str(entry.apiId).trim();
      if (apiId === '' || !isObject(entry.raw)) continue;
      out.push({
        apiId,
        rawDocs: entry.raw,
        inbound: isObject(entry.inbound) ? entry.inbound : {},
      });
      if (out.length >= ARM_MAX) break;
    }
    return out;
  }
  const apiId = str(payload && payload.apiId).trim();
  if (apiId === '' || !isObject(payload && payload.raw)) return [];
  out.push({
    apiId,
    rawDocs: payload.raw,
    inbound: isObject(payload.inbound) ? payload.inbound : {},
  });
  return out;
}

function parseInbound(value) {
  // Accept the inbound argument either as a JSON string or as an object.
  // Strings are the most common failure mode for models that hand-write
  // tool arguments, so we normalize without surprising the object case.
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
      throw new Error('inbound string must parse to a JSON object');
    } catch (err) {
      throw new Error('inbound string is not valid JSON object (' + err.message + ')');
    }
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  throw new Error('inbound must be a JSON object');
}

function kindOfExample(example) {
  if (Array.isArray(example)) {
    if (!example.length) return 'array';
    return 'array<' + kindOfExample(example[0]) + '>';
  }
  if (example === null) return 'null';
  switch (typeof example) {
    case 'number': return Number.isInteger(example) ? 'integer' : 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'string';
  }
}

function splitDocs(rawDocs) {
  // The skill describes `docs` as: every field except `desc` is an inbound
  // parameter. Surface that split to the model so it doesn't have to
  // re-derive the rule on every call.
  //
  // Each remaining value is an EXAMPLE, and its JSON type is the field's type.
  // Reporting the type next to the example is what stops a caller from sending
  // an array parameter as a comma-joined string.
  if (!rawDocs || typeof rawDocs !== 'object') {
    return { desc: '', params: {}, types: {}, unknown: true };
  }
  const desc = typeof rawDocs.desc === 'string' ? rawDocs.desc : '';
  const params = {};
  const types = {};
  for (const key of Object.keys(rawDocs)) {
    if (key === 'desc') continue;
    params[key] = rawDocs[key];
    types[key] = kindOfExample(rawDocs[key]);
  }
  return { desc, params, types, unknown: false };
}

module.exports = {
  name: 'fdep-api-request-bundle',
  inject: ['tools'],
  apply(ctx) {
    // ---------------------------------------------------------------------
    // Runtime context: the docs of one api, armed for the session the panel
    // opens next.
    //
    // The panel is a root-scoped `main` occupant: it never learns the new
    // session's id (uiWorkspace.startSession() returns void), so the binding has
    // to be inferred. What the assembly context actually carries is
    // `assembleContextFor(agent, signal)`'s result:
    //
    //     { agent, scope: agent, signal? }        (dsh-agent/lib/index.js)
    //
    // i.e. `agent` IS the session (Agent.id is a SessionId), and `scope` is that
    // same object. (The published `AssembleContext` type only documents
    // `{ scope?, signal? }`, so this cannot be read off the .d.ts — the guard in
    // host-integration.test.js checks the implementation instead.)
    //
    // The claim rule: an arm belongs to a session that did NOT exist when it was
    // posted. Which sessions already existed is learned from the assemblies
    // themselves — every session that assembles is recorded, and the arm snapshots
    // that set. This matters: the first revision claimed the first assembly of any
    // kind, and in practice that was the session the *user was chatting in* (which
    // assembles every step), so the docs were injected into the wrong conversation
    // while the freshly opened one got nothing.
    // ---------------------------------------------------------------------
    const arm = { text: '', at: 0, sessionId: null, known: null };
    /** Every session seen assembling since this plugin mounted. */
    const seenSessions = new Set();
    /** Set once the provider is actually registered; surfaced in the arm reply. */
    let hooked = false;

    /** The session id behind an assembly context (`agent` first, `scope` as the fallback). */
    function sessionIdOf(assembleContext) {
      if (assembleContext === undefined || assembleContext === null) return '';
      const agent = assembleContext.agent !== undefined && assembleContext.agent !== null
        ? assembleContext.agent
        : assembleContext.scope;
      return agent !== undefined && agent !== null && typeof agent.id === 'string' ? agent.id : '';
    }

    /**
     * The prompt-context provider: called once per assembly. An empty string
     * means "no contribution" — the assembler drops empty contexts, so a session
     * that was never armed adds nothing at all.
     * @param assembleContext - the assembly context (`{ agent, scope, signal? }`).
     * @returns the runtime-context text.
     */
    function docsContextText(assembleContext) {
      const sessionId = sessionIdOf(assembleContext);
      if (sessionId !== '') seenSessions.add(sessionId);
      if (arm.text === '') return '';
      if (arm.sessionId !== null) {
        // Bound: only that one session keeps receiving the docs, for its lifetime.
        return sessionId === arm.sessionId ? arm.text : '';
      }
      // Unclaimed. Only a session that was NOT already alive when the arm was
      // posted may take it, and only while the arm is fresh.
      if (sessionId === '') return '';
      if (Date.now() - arm.at > ARM_TTL_MS) {
        arm.text = '';
        return '';
      }
      if (arm.known !== null && arm.known.has(sessionId)) return '';
      arm.sessionId = sessionId;
      return arm.text;
    }

    /**
     * Route handler: one arm (or disarm) request per "New session" click.
     * @param req - the HTTP request.
     * @param res - the HTTP response.
     */
    async function handleContextArm(req, res) {
      const send = (status, payload) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'POST') {
        send(405, { ok: false, reason: 'method not allowed' });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        send(413, { ok: false, reason: err && err.message ? err.message : 'body rejected' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        send(400, { ok: false, reason: 'invalid json' });
        return;
      }
      const apis = readArmedApis(payload);
      if (apis.length === 0) {
        // No docs to inject: clear the arm, so a later session cannot inherit a
        // brief the user has moved on from.
        arm.text = '';
        arm.at = 0;
        arm.sessionId = null;
        arm.known = null;
        send(200, { ok: true, armed: false, hooked: hooked });
        return;
      }
      const text = renderDocsContext(apis).slice(0, CONTEXT_MAX);
      arm.text = text;
      arm.at = Date.now();
      arm.sessionId = null;
      // Snapshot the sessions that are already alive (they have assembled at least
      // once): none of them may take this arm — only the session the panel is about
      // to open can.
      arm.known = new Set(seenSessions);
      send(200, {
        ok: true,
        armed: true,
        // `hooked: false` means the arm was stored but nothing will ever read it
        // (no `systemPrompt` in this composition) — the panel tells the user to
        // rely on the clipboard brief instead of pretending the context worked.
        hooked: hooked,
        api_ids: apis.map((entry) => entry.apiId),
        chars: text.length,
        known_sessions: arm.known.size,
        binds: 'the first session opened after this request',
      });
    }

    /** `systemPrompt` is optional: without it the panel's clipboard path still works. */
    function registerDocsContext(systemPrompt) {
      hooked = true;
      return systemPrompt.context({
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        text: docsContextText,
      });
    }

    /**
     * Route handler: run an api through the host, so the panel's 執行 never has to
     * hold the key. Execute only — docs is anonymous and the panel already talks
     * to the gateway directly for it, so this route cannot be used to proxy
     * arbitrary traffic.
     *
     * @param req - the HTTP request.
     * @param res - the HTTP response.
     */
    async function handleCallRoute(req, res) {
      const send = (status, payload) => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'POST') {
        send(405, { ok: false, error: '只接受 POST' });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch (err) {
        send(413, { ok: false, error: err && err.message ? err.message : 'body rejected' });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (err) {
        send(400, { ok: false, error: 'invalid json' });
        return;
      }
      const apiId = str(payload && payload.api).trim();
      if (apiId === '' || apiId.length > 200) {
        send(400, { ok: false, error: 'api 必須是非空的字串' });
        return;
      }
      if (payload && payload.do !== true) {
        // Keeping the route execute-only is what makes "docs carries no key"
        // true by construction rather than by convention.
        send(400, { ok: false, error: '這個路由只接受 do: true（查文件請直接呼叫端點）' });
        return;
      }
      const inbound = payload && typeof payload.inbound === 'object' && payload.inbound !== null && !Array.isArray(payload.inbound)
        ? payload.inbound
        : {};
      const result = await callFdep(apiId, true, inbound);
      // The masked key is never echoed back — only whether one was used and where
      // it came from.
      send(result.ok ? 200 : (result.status ? 502 : 500), {
        ok: result.ok,
        status: result.status,
        body: result.parsed,
        error: result.error,
        keyRef: result.keyRef,
      });
    }

    /** `webServer` is optional: without it the panel cannot arm the context. */
    function registerArmRoute(webServer) {
      return webServer.register({
        kind: 'exact',
        path: CONTEXT_ROUTE,
        handler: handleContextArm,
      });
    }

    /** Same optional service, second route: the panel's execute goes through here. */
    function registerCallRoute(webServer) {
      return webServer.register({
        kind: 'exact',
        path: CALL_ROUTE,
        handler: handleCallRoute,
      });
    }

    if (typeof ctx.inject === 'function') {
      // Optional services, resolved lazily: a composition without either still
      // mounts the tool (and the panel still copies its brief).
      ctx.inject(['systemPrompt'], (scope) => {
        ctx.effect(() => registerDocsContext(scope.systemPrompt), 'fdep-api-request: docs prompt context');
      });
      ctx.inject(['webServer'], (scope) => {
        ctx.effect(() => registerArmRoute(scope.webServer), 'fdep-api-request: docs arm route');
        ctx.effect(() => registerCallRoute(scope.webServer), 'fdep-api-request: execute call route');
      });
    } else if (typeof ctx.get === 'function') {
      const systemPrompt = ctx.get('systemPrompt');
      if (systemPrompt !== undefined && systemPrompt !== null) {
        ctx.effect(() => registerDocsContext(systemPrompt), 'fdep-api-request: docs prompt context');
      }
      const webServer = ctx.get('webServer');
      if (webServer !== undefined && webServer !== null) {
        ctx.effect(() => registerArmRoute(webServer), 'fdep-api-request: docs arm route');
        ctx.effect(() => registerCallRoute(webServer), 'fdep-api-request: execute call route');
      }
    }

    // `ctx.tools.register()` already binds its disposer to the CALLING fiber,
    // so disposing this plugin's fiber unregisters the tool automatically.
    // Do NOT wrap the returned disposer in `ctx.effect(dispose, …)`: cordis
    // calls the effect callback immediately and treats its RETURN value as
    // the disposer, so passing `dispose` itself unregisters the tool the
    // instant it is registered (verified: schemas() came back empty).
    ctx.tools.register({
      name: 'fdep_call',
      description:
        'Call the FDEP API as documented by the fdep-api-request skill. ' +
        'Set mode="docs" with an empty inbound to fetch the parameter schema for an api_id; ' +
        'set mode="execute" with the filled inbound object (using exactly the field names returned by docs, excluding `desc`) to run the call. ' +
        'Execute is authorized by the gateway: this tool attaches the apiKey itself (from the local credentials file), so never put an apiKey in `inbound`. ' +
        'The skill remains the source of truth for the workflow; this tool only encodes the deterministic POST shape so the model does not have to repeat it by hand.',
      // `parameters` is a RAW JSON Schema object, which the registry projects
      // verbatim into the model-facing schema. This is the documented
      // wire-level form ("the wire-level counterpart shared with subagents,
      // workflows, and MCP") and is what MCP servers register with.
      //
      // The alternative — the dsh-tools ParameterSchemaSpec DSL plus
      // `defineTool(...)` — buys registry-side argument validation, but it
      // requires `require('@deepseek-ai/dsh-tools')` to resolve. That
      // resolution depends on whether the loader preserves symlinks: a
      // `link:` profile install resolves back to its real path and then
      // cannot see the DSH tree (verified). Since a missing import would
      // leave the tool unregistered, we take the dependency-free form and
      // validate every argument in `execute` below instead.
      parameters: {
        type: 'object',
        properties: {
          api_id: {
            type: 'string',
            description: 'FDEP API identifier, e.g. "test.demo". Required for both modes.',
          },
          mode: {
            type: 'string',
            enum: ['docs', 'execute'],
            description: '"docs" returns the parameter schema; "execute" runs the call.',
          },
          inbound: {
            type: 'object',
            additionalProperties: true,
            description:
              'Argument object. For mode="docs" pass {} (the tool ignores it). ' +
              'For mode="execute" pass one key per non-desc field returned by docs, with the values you want to send.',
          },
        },
        required: ['api_id', 'mode'],
        additionalProperties: false,
      },
      output: {
        // The registry validates every RETURNED value against this schema and
        // fails the call as "returned invalid output" if it does not match
        // exactly one `oneOf` branch. The three envelopes below are mutually
        // exclusive by their required keys — the earlier revision required
        // only `api_id` on the execute branch, so a docs result matched both
        // and every successful docs call was reported as invalid output.
        schema: {
          oneOf: [
            {
              type: 'object',
              description: 'docs mode result',
              properties: {
                api_id: { type: 'string' },
                desc: { type: 'string' },
                params: { type: 'object', additionalProperties: true },
                types: { type: 'object', additionalProperties: true },
                raw: { type: 'object', additionalProperties: true },
              },
              required: ['api_id', 'desc', 'params'],
            },
            {
              type: 'object',
              description: 'execute mode result',
              properties: {
                api_id: { type: 'string' },
                trace_id: { type: 'string' },
                data: {},
                inbound_sent: { type: 'object', additionalProperties: true },
              },
              required: ['api_id', 'data'],
            },
            {
              type: 'object',
              description: 'error result',
              properties: {
                api_id: { type: 'string' },
                mode: { type: 'string' },
                error: { type: 'string' },
                upstream_status: { type: 'number' },
                upstream_body: {},
              },
              required: ['api_id', 'error'],
            },
          ],
        },
        render(args, value) {
          const title = '[fdep_call] ' + (args.mode || '?') + ' ' + (args.api_id || '');
          const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          return [{ type: 'text', text: title + '\n\n' + body }];
        },
        presentationMeta(args, value) {
          return { kind: 'fdep_call', mode: args && args.mode, api_id: args && args.api_id };
        },
      },
      async execute(args, exec) {
        const params = args || {};
        const apiId = typeof params.api_id === 'string' ? params.api_id.trim() : '';
        const mode = params.mode;
        if (!apiId) {
          throw new Error('api_id must be a non-empty string');
        }
        if (mode !== 'docs' && mode !== 'execute') {
          throw new Error('mode must be "docs" or "execute"');
        }

        let inbound;
        try {
          inbound = parseInbound(params.inbound);
        } catch (err) {
          return { api_id: apiId, mode, error: err.message };
        }

        // One place builds the body: docs stays anonymous, execute carries the
        // masked apiKey (see callFdep). A missing credential is an error result,
        // never a silent unauthenticated execute.
        const result = await callFdep(apiId, mode === 'execute', inbound, exec && exec.signal ? exec.signal : undefined);
        if (!result.ok) {
          const out = {
            api_id: apiId,
            mode,
            error: result.error,
          };
          if (result.status) out.upstream_status = result.status;
          if (result.parsed) out.upstream_body = result.parsed;
          return out;
        }
        const parsed = result.parsed;

        if (mode === 'docs') {
          const docs = parsed && parsed.data && parsed.data.docs;
          const split = splitDocs(docs);
          return {
            api_id: apiId,
            desc: split.desc,
            // `params` holds each field's EXAMPLE value; `types` names the JSON
            // shape to send. Pass the values in inbound with those shapes —
            // list fields must be arrays, not comma-joined strings.
            params: split.params,
            types: split.types,
            raw: docs || parsed,
          };
        }

        return {
          api_id: apiId,
          trace_id: parsed && parsed.trace_id,
          data: parsed && parsed.data !== undefined ? parsed.data : parsed,
          inbound_sent: inbound,
        };
      },
      timeoutMs: 30000,
      isConcurrencySafe() {
        // Each call may be retried independently; no shared mutable state.
        return true;
      },
    });
  },
  /** Offline test surface: the credential helpers are pure and worth pinning. */
  __test: {
    CALL_ROUTE,
    API_KEY_REFS,
    credentialsFilePath,
    readCredentialRef,
    maskApiKey,
    maskedApiKey,
    callFdep,
  },
};
