'use strict';

// Dev helper: read the running host's __DSH_BOOT__ graph and report the
// served URL + revision for this bundle's client module.
//
//   node test/dev-boot.js

const BASE = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';

async function main() {
  const res = await fetch(BASE + '/');
  const html = await res.text();
  console.log('index    : ' + res.status + '  ' + html.length + ' bytes');

  const marker = '__DSH_BOOT__';
  const i = html.indexOf(marker);
  if (i === -1) {
    console.error('__DSH_BOOT__ not found in the index');
    console.error('head: ' + JSON.stringify(html.slice(0, 200)));
    process.exit(1);
  }
  // The payload is the object literal after the '=' that follows the marker.
  const eq = html.indexOf('=', i);
  const start = html.indexOf('{', eq);
  if (eq === -1 || start === -1) {
    console.error('__DSH_BOOT__ marker found but no object literal follows it');
    console.error('context: ' + JSON.stringify(html.slice(i - 40, i + 120)));
    process.exit(1);
  }
  // Brace-match to the end of the object literal.
  let depth = 0;
  let end = -1;
  let inStr = false;
  let esc = false;
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
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = k + 1; break; }
    }
  }
  const boot = JSON.parse(html.slice(start, end));

  console.log('graph rev : ' + boot.rev);
  console.log('entries   : ' + boot.entries.length);
  console.log('');

  const own = boot.entries.filter((e) => !e.id.startsWith('@deepseek-ai/'));
  console.log('non-core entries:');
  for (const e of own) {
    console.log('  id       : ' + e.id);
    console.log('  url      : ' + e.url);
    console.log('  rev      : ' + e.rev);
    console.log('  immediate: ' + !!e.immediately);
    console.log('');
  }

  const mine = boot.entries.find((e) => e.id === 'fdep-api-request-bundle');
  if (!mine) {
    console.log('fdep-api-request-bundle is NOT in the running graph.');
    console.log('(the host was started before the bundle was installed, or it failed to compose)');
    return;
  }

  // The graph carries a relative reference (`plugins/??id/client.js&rev=…`), so it
  // must be resolved against the host root rather than concatenated.
  const url = new URL(mine.url, BASE + '/').href;
  const bundleRes = await fetch(url);
  const body = await bundleRes.text();
  console.log('fetch ' + url);
  console.log('  status   : ' + bundleRes.status);
  console.log('  bytes    : ' + body.length);
  console.log('  etag     : ' + bundleRes.headers.get('etag'));
  console.log('  ctype    : ' + bundleRes.headers.get('content-type'));
  console.log('  first 90 : ' + JSON.stringify(body.slice(0, 90)));
  console.log('');
  console.log('For a byte-level comparison against lib/client.js — including the');
  console.log('sourceMappingURL comment the module host appends to every response —');
  console.log('run: node test/dev-diff.js');
}

main().catch((err) => { console.error(err); process.exit(1); });
