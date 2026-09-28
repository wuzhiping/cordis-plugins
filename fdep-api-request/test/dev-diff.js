'use strict';

// Answers one question precisely: is the RUNNING host serving what is on disk
// right now?
//
//   node test/dev-diff.js      # exit 0 = in sync, 1 = drifted
//
// The module host appends a trailing `;` and a `//# sourceMappingURL=…`
// comment to every client bundle it serves, so a naive byte comparison always
// reports a mismatch. This strips that known suffix first, then compares the
// rest exactly — which is a self-maintaining check: no marker list to keep in
// sync with the source.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const ID = 'fdep-api-request-bundle';
const LOCAL = path.join(__dirname, '..', 'lib', 'client.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

// Empirically the response is the file's bytes VERBATIM as a prefix, with the
// terminator and source map comment appended after it. No trailing-newline
// munging, no transformation — so the check is simply a prefix test. (Two
// earlier guesses encoded a strip-then-append model and were each off by a
// byte; measured beats assumed.)
function inSyncWith(localText, servedRaw) {
  return servedRaw.startsWith(localText);
}

async function bootGraph() {
  const html = await (await fetch(BASE + '/')).text();
  const i = html.indexOf('__DSH_BOOT__');
  if (i === -1) throw new Error('__DSH_BOOT__ not found — is the host running?');
  const start = html.indexOf('{', html.indexOf('=', i));
  let depth = 0; let end = -1; let inStr = false; let esc = false;
  for (let k = start; k < html.length; k += 1) {
    const ch = html[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = k + 1; break; } }
  }
  return JSON.parse(html.slice(start, end));
}

async function main() {
  const local = fs.readFileSync(LOCAL, 'utf8');

  let boot;
  try {
    boot = await bootGraph();
  } catch (err) {
    console.error('cannot reach the host at ' + BASE + ': ' + err.message);
    process.exitCode = 2;
    return;
  }

  const mine = boot.entries.find((e) => e.id === ID);
  if (!mine) {
    console.error('the running graph has no entry for ' + ID);
    console.error('(the host booted before the bundle was installed, or it failed to compose)');
    process.exitCode = 2;
    return;
  }

  // The graph carries a relative reference (`plugins/??id/client.js&rev=…`), so it
  // must be resolved against the host root rather than concatenated.
  const servedRaw = await (await fetch(new URL(mine.url, BASE + '/'))).text();
  const served = servedRaw.slice(0, local.length);

  console.log('rev      : ' + mine.rev);
  console.log('url      : ' + mine.url);
  console.log('');
  console.log('local  : ' + Buffer.byteLength(local, 'utf8') + ' bytes  sha ' + sha(local));
  console.log('served : ' + Buffer.byteLength(served, 'utf8') + ' bytes  sha ' + sha(served)
    + '  (+' + (Buffer.byteLength(servedRaw, 'utf8') - Buffer.byteLength(served, 'utf8'))
    + ' bytes of appended sourceMappingURL)');
  console.log('');

  if (inSyncWith(local, servedRaw)) {
    console.log('IN SYNC — the host is serving the current file.');
    console.log('A browser reload will get exactly this content.');
    process.exitCode = 0;
    return;
  }

  console.log('DRIFTED — the host is serving something other than the current file.');
  const a = local.split('\n');
  const b = servedRaw.split('\n');
  let shown = 0;
  for (let k = 0; k < Math.max(a.length, b.length) && shown < 10; k += 1) {
    if (a[k] !== b[k]) {
      shown += 1;
      console.log('  line ' + (k + 1) + ':');
      console.log('    local : ' + JSON.stringify((a[k] || '').slice(0, 120)));
      console.log('    served: ' + JSON.stringify((b[k] || '').slice(0, 120)));
    }
  }
  if (shown === 0) {
    console.log('  (no line-level difference; only the trailing bytes differ)');
  }
  console.log('');
  console.log('If you just saved, wait ~1s (the watcher polls) and re-run.');
  process.exitCode = 1;
}

main().catch((err) => { console.error(err); process.exitCode = 2; });
