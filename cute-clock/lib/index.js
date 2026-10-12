// cute-clock — Host half.
//
// Contributes the `cute-clock` bundle's host-side services. As of v0.2.0 the
// host only exposes a single route:
//
//   GET /cute-clock/mask-key
//
// It returns the MASK.md "apiKey for abc.feg.com.tw" variant of the AIFE_API_KEY
// so the client's usage widget can POST to the litellm console endpoint
// `https://abc.feg.com.tw/BDD/API/v1/litellm/console/usageKey`. The raw key
// never leaves the host process — the browser only sees the masked form, and
// that form is only useful for that one abc.feg.com.tw endpoint (per MASK.md
// §"Domain boundary").
//
// Why a route, not a static config: at apply time, the cordis service
// lookup may return a not-ready stub, and the lesson from ntfy-teams /
// scene-template is that the only reliable way to register a route is to
// use the inject pattern inside the apply body. Going through that same
// path is the only reason this file is more than four lines.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MASK_KEY_PATH = '/cute-clock/mask-key';
// Same order as the other host halves — AIFE first because the file on this
// machine uses AIFE_API_KEY. FEG_API_KEY would also work but returns 200 {} on
// that endpoint (probed earlier); DEEPSEEK is the last-resort fallback.
const MASK_KEY_REFS = ['AIFE_API_KEY', 'FEG_API_KEY', 'DEEPSEEK_API_KEY'];
const MASK_PREFIX = 'sk-';
const MAX_BODY = 256 * 1024;

function credentialsFilePath() {
  const override = process.env.DSH_CREDENTIALS_PATH;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * Read one `refs:` entry out of the credentials YAML text.
 *
 * A deliberately minimal line parser: stop at the first non-indented line
 * so a same-named key in a later top-level block cannot be picked up.
 *
 * @param text - the file contents.
 * @param name - the reference name, e.g. `AIFE_API_KEY`.
 * @returns the value, or null.
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
 * Mask a key in the shape the abc.feg.com.tw `usageKey` endpoint expects.
 *
 * This is **not** the MASK.md display formula (`mask(key)` produces 71 chars
 * with `sk-` inside `inner`). The endpoint strips the outer `sk-` to get to
 * `inner`, and assumes `inner` contains the raw key **without** the `sk-`
 * prefix, followed by `@<ISO>`. So the body is `key.slice(3) + '@' + ISO`,
 * base64-encoded, with a fresh `sk-` outer prefix. See MASK.md §"API
 * contract: `apiKey` for `abc.feg.com.tw`".
 *
 * @param key - the raw key, e.g. `sk-ExampleKeyReplaceMe001`.
 * @param now - the timestamp to embed (tests pin this).
 * @returns the 67-character `apiKey` value.
 */
function maskKey(key, now) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('maskKey: key must be a non-empty string');
  }
  const inner = key.startsWith(MASK_PREFIX) ? key.slice(MASK_PREFIX.length) : key;
  const stamp = '@' + (now instanceof Date ? now : new Date()).toISOString();
  return MASK_PREFIX + Buffer.from(inner + stamp, 'utf8').toString('base64');
}

/**
 * Resolve the first available reference and return its masked form.
 *
 * @param options - `{ now }`, for tests.
 * @returns `{ ok, masked, ref, source, error }`.
 */
function maskedCredential(options) {
  const opts = options || {};
  const file = credentialsFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { ok: false, error: '讀不到憑證檔（' + file + '）：' + (err && err.message ? err.message : String(err)) };
  }
  for (let i = 0; i < MASK_KEY_REFS.length; i += 1) {
    const ref = MASK_KEY_REFS[i];
    const key = readCredentialRef(text, ref);
    if (!key) continue;
    try {
      return { ok: true, masked: maskKey(key, opts.now), ref, source: file };
    } catch (err) {
      return { ok: false, error: '遮蔽失敗（' + ref + '）：' + (err && err.message ? err.message : String(err)) };
    }
  }
  return { ok: false, error: '憑證檔裡找不到可用的金鑰（試過 ' + MASK_KEY_REFS.join('、') + '）——檔案：' + file };
}

function apply(ctx) {
  // ctx.inject is the only reliable way — see the file header. A check, not
  // an assumption, because some test harnesses pass a stripped-down ctx.
  if (typeof ctx.inject !== 'function') {
    if (ctx.logger && typeof ctx.logger.error === 'function') {
      ctx.logger.error('[cute-clock] ctx.inject unavailable; mask-key route cannot be registered');
    }
    return;
  }

  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer;
    if (webServer === undefined || !webServer || typeof webServer.register !== 'function') {
      if (ctx.logger && typeof ctx.logger.error === 'function') {
        ctx.logger.error('[cute-clock] webServer service unavailable; the usage widget will stay empty');
      }
      return;
    }
    // Visible log: without it, a route that failed to register and a route
    // that registered fine are both just a 404 (this is the same gotcha
    // scene-template hit). A single console line is enough to distinguish
    // "the host is up" from "the route never bound".
    if (ctx.logger && typeof ctx.logger.log === 'function') {
      ctx.logger.log('[cute-clock] registering route: ' + MASK_KEY_PATH);
    }
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: MASK_KEY_PATH,
      handler: (req, res) => {
        const send = (status, payload) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify(payload));
        };
        if (req.method !== 'GET') {
          send(405, { ok: false, error: '只接受 GET' });
          return;
        }
        const result = maskedCredential({});
        if (!result.ok) {
          send(503, { ok: false, error: result.error });
          return;
        }
        send(200, { ok: true, maskKey: result.masked, ref: result.ref, source: result.source });
      },
    }), 'cute-clock: mask-key route');
  });
}

module.exports = {
  name: 'cute-clock',
  /** No statically required services; everything is read through ctx.inject. */
  inject: [],
  apply,
  /** Offline test surface: mask helpers are pure and worth pinning. */
  __test: {
    MASK_KEY_PATH,
    MASK_KEY_REFS,
    credentialsFilePath,
    readCredentialRef,
    maskKey,
    maskedCredential,
    MAX_BODY,
  },
};
