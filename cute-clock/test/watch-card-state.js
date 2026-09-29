'use strict';
// Watch the clock card for ~25s with NO interaction and report every visibility
// change with the geometry that caused it. This is the "it sometimes doesn't show
// even though nothing blocks it" case: a stale/hidden blocker rect, or a focus
// reading that flips on its own.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9399;
const SECONDS = Number(process.env.PROBE_SECONDS || 25);
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcard-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + dir,
    '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 60; i += 1) { try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); break; } catch (_) { await sleep(250); } }
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result ? r.result.value : undefined; };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 100; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.cute-clock-card')").catch(() => false)) break; }
    await sleep(3000);

    // Install an in-page watcher: sample every 200ms and record only CHANGES, with
    // the blocker rects and focus reading that the plugin itself would compute.
    await ev(`(() => {
      const SEL = '.uV2eYG_input,[contenteditable="true"],textarea,[data-st-scroll],#st-top,#st-wall';
      window.__watch = [];
      let last = null;
      window.__watchTimer = setInterval(() => {
        const card = document.querySelector('.cute-clock-card');
        if (!card) return;
        const marker = document.querySelector('[data-cute-clock-state]');
        const cs = getComputedStyle(card);
        const cr = card.getBoundingClientRect();
        const blockers = [].slice.call(document.querySelectorAll(SEL)).map((el) => {
          const r = el.getBoundingClientRect();
          const pad = 8;
          const overlaps = !(cr.right + pad <= r.left || r.right + pad <= cr.left || cr.bottom + pad <= r.top || r.bottom + pad <= cr.top);
          return { cls: (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 26), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], overlaps: overlaps, visibility: getComputedStyle(el).visibility, display: getComputedStyle(el).display };
        });
        const active = document.activeElement;
        const focusish = !!(active && active.closest && active.closest('[contenteditable="true"],textarea,.uV2eYG_input,.uV2eYG_root'));
        const state = { opacity: cs.opacity, visibility: cs.visibility, marker: marker ? marker.getAttribute('data-cute-clock-state') : null, focusish: focusish, overlapping: blockers.filter((b) => b.overlaps) };
        const key = JSON.stringify([state.opacity, state.visibility, state.marker, state.overlapping.length]);
        if (key !== last) { last = key; window.__watch.push({ t: Math.round(performance.now()), state: state }); }
      }, 200);
      return true;
    })()`);

    console.log('watching for ' + SECONDS + 's (no interaction)…');
    await sleep(SECONDS * 1000);
    const watch = JSON.parse(await ev('JSON.stringify(window.__watch || [])'));
    console.log('recorded changes: ' + watch.length);
    for (const entry of watch) {
      const s = entry.state;
      console.log('  t=' + String(entry.t).padStart(6) + 'ms  opacity=' + s.opacity + ' visibility=' + s.visibility
        + ' marker=' + s.marker + ' focusish=' + s.focusish
        + ' overlapping=' + JSON.stringify(s.overlapping.map((b) => b.cls + '[' + b.rect.join(',') + '] vis=' + b.visibility + ' display=' + b.display)));
    }
    if (watch.length > 1) console.log('\nNOTE: more than one state = the card changed on its own.');

    await ev('(() => { clearInterval(window.__watchTimer); return true; })()');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
