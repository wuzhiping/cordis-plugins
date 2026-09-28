'use strict';

// Dev loop for this bundle. Watches the sources and, on every save, runs the
// fast offline checks, regenerates the preview page, and reports whether the
// RUNNING host picked the change up.
//
//   node test/dev.js                 # watch until Ctrl+C
//   node test/dev.js --once          # run the checks once and exit
//   node test/dev.js --no-events     # skip the SSE connection
//
// Why this exists: the three tiers of this bundle have very different reload
// costs, and conflating them is what makes plugin development feel slow.
//
//   tier 1  offline, instant      contract tests + preview page
//   tier 2  live, no restart      lib/client.js  -> host re-reads, SSE
//                                 broadcasts `rebuilt`, browser swaps the
//                                 plugin in place
//   tier 3  live, needs restart   lib/index.js   -> Node imports it once at
//                                 boot; only a host restart re-evaluates it
//
// So the loop for UI work is tier 1 then tier 2 (save and look), and a host
// restart is only ever needed when the tool definition itself changes.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const ONCE = process.argv.includes('--once');
const NO_EVENTS = process.argv.includes('--no-events');

const WATCH = [
  { file: path.join(ROOT, 'lib', 'client.js'), tier: 2 },
  { file: path.join(ROOT, 'lib', 'index.js'), tier: 3 },
  { file: path.join(ROOT, 'test', 'preview.js'), tier: 1 },
];

// ---------------------------------------------------------------- utilities
function stamp() {
  const d = new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function log(msg) { console.log('[' + stamp() + '] ' + msg); }
function indent(msg) { console.log('           ' + msg); }

function runNode(rel, args) {
  const res = spawnSync(process.execPath, [path.join(ROOT, rel)].concat(args || []), {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return {
    ok: res.status === 0,
    out: (res.stdout || '') + (res.stderr || ''),
  };
}

// Read the running host's graph and pull out this bundle's revision.
async function servedRev() {
  try {
    const html = await (await fetch(BASE + '/')).text();
    const i = html.indexOf('__DSH_BOOT__');
    if (i === -1) return { rev: null, why: 'no __DSH_BOOT__ in index' };
    const start = html.indexOf('{', html.indexOf('=', i));
    if (start === -1) return { rev: null, why: 'no payload object' };
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
    const boot = JSON.parse(html.slice(start, end));
    const mine = boot.entries.find((e) => e.id === 'fdep-api-request-bundle');
    if (!mine) return { rev: null, why: 'bundle not in the running graph' };
    return { rev: mine.rev };
  } catch (err) {
    return { rev: null, why: (err && err.message) || String(err) };
  }
}

// ---------------------------------------------------------------- check runs
function runOfflineChecks(which) {
  if (which === 'all' || which === 'client') {
    const t = runNode(path.join('test', 'client-contract.test.js'));
    const m = t.out.match(/All (\d+) client-contract checks passed/);
    log('  contract  ' + (t.ok ? 'PASSED (' + (m ? m[1] : '?') + ' checks)' : 'FAILED'));
    if (!t.ok) indent(t.out.trim().split('\n').slice(-6).join('\n           '));
  }
  if (which === 'all' || which === 'host') {
    const t = runNode(path.join('test', 'host-integration.test.js'));
    const m = t.out.match(/All (\d+) checks passed/);
    log('  host test ' + (t.ok ? 'PASSED (' + (m ? m[1] : '?') + ' checks)' : 'FAILED'));
    if (!t.ok) indent(t.out.trim().split('\n').slice(-6).join('\n           '));
  }
  const p = runNode(path.join('test', 'preview.js'));
  const m = p.out.match(/panel classes used: (\d+)/);
  log('  preview   ' + (p.ok ? 'regenerated (' + (m ? m[1] : '?') + ' classes verified)' : 'FAILED'));
  if (!p.ok) indent(p.out.trim().split('\n').slice(-6).join('\n           '));
}

// ---------------------------------------------------------------- SSE
function startEventChannel(onFrame) {
  let cancelled = false;
  (async () => {
    for (;;) {
      if (cancelled) return;
      try {
        const res = await fetch(BASE + '/plugins/events', {
          headers: { accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const event = (block.split('\n').find((l) => l.startsWith('event:')) || '').slice(6).trim();
            const data = block.split('\n').filter((l) => l.startsWith('data:'))
              .map((l) => l.slice(5).trim()).join('');
            if (!data) continue;
            try { onFrame(event || 'message', JSON.parse(data)); } catch (_) { /* ignore */ }
          }
        }
      } catch (_) {
        // Host down or channel dropped: back off and retry, quietly.
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => { cancelled = true; };
}

// ---------------------------------------------------------------- main
async function main() {
  log('FDEP bundle dev loop');
  log('  watching lib/client.js (tier 2), lib/index.js (tier 3), test/preview.js (tier 1)');
  log('  host: ' + BASE);

  const first = await servedRev();
  if (first.rev) log('  served rev: ' + first.rev);
  else log('  served rev: unavailable (' + first.why + ')');
  console.log('');

  log('initial checks');
  runOfflineChecks('all');
  console.log('');

  if (NO_EVENTS) log('SSE channel disabled (--no-events)');
  else {
    startEventChannel((event, frame) => {
      if (frame.id === 'fdep-api-request-bundle') {
        log('  HMR       rebuilt frame -> ' + frame.rev);
        indent('the browser swaps this plugin in place; no refresh needed');
      } else if (frame.entries) {
        log('  HMR       graph frame (' + frame.entries.length + ' entries)');
      } else if (event !== 'message' || frame.id) {
        log('  HMR       ' + event + ' ' + JSON.stringify(frame));
      }
    });
    log('listening on /plugins/events');
  }

  if (ONCE) {
    // The SSE retry loop keeps the event loop alive by design, so a one-shot
    // run must exit explicitly rather than waiting for it to drain.
    process.exit(0);
  }

  console.log('');
  log('watching for changes… (Ctrl+C to stop)');
  console.log('');

  let pending = new Map();
  let timer = null;

  function flush() {
    timer = null;
    const touched = Array.from(pending.values());
    pending = new Map();
    for (const entry of touched) {
      log('changed  ' + path.relative(ROOT, entry.file) + '  (tier ' + entry.tier + ')');
    }
    const tier = Math.max.apply(null, touched.map((e) => e.tier));
    if (tier === 3) {
      log('  host test  (the tool definition changed)');
      runOfflineChecks('host');
      log('  NOTE       lib/index.js is imported once at boot — restart dsh web to apply it live');
    } else {
      runOfflineChecks('client');
    }
    servedRev().then((after) => {
      if (after.rev) log('  served rev ' + after.rev + (after.rev === first.rev ? ' (unchanged?)' : ' (host re-read the file)'));
      else indent('served rev unavailable: ' + after.why);
    });
    console.log('');
  }

  const byFile = new Map(WATCH.map((w) => [w.file, w]));
  for (const w of WATCH) {
    try {
      fs.watch(w.file, { persistent: true }, () => {
        pending.set(w.file, byFile.get(w.file));
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 180);
      });
    } catch (err) {
      log('cannot watch ' + w.file + ': ' + err.message);
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
