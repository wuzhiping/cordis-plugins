'use strict';
// Regression: hovering the card must not change its measured box (that was the
// flicker: a 3px lift moved the measured rect across the hide boundary, so the card
// hid under the pointer, came back, hid again…).
//
//   node test/verify-no-flicker.js
//
// Two cases:
//   1. parked just OUTSIDE the keep-away threshold — hovering must not hide it
//   2. parked just INSIDE it — hiding is correct and must not oscillate
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9403;
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noflicker-'));
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

    // Park the card `gap` px above the top edge of the TOPMOST blocker (the composer
    // or the template wall), aligned with the blocker's right edge. Measuring the
    // real blocker instead of guessing keeps this deterministic across layouts.
    // gap > 8 (keep-away) => no overlap; gap = 0 => overlap.
    const park = async (gap) => {
      await ev(`(() => {
        const SEL = '.uV2eYG_input,[contenteditable="true"],textarea,[data-st-scroll],#st-top,#st-wall';
        const card = document.querySelector('.cute-clock-card');
        const c = card.getBoundingClientRect();
        let top = Infinity;
        let right = 0;
        [].slice.call(document.querySelectorAll(SEL)).forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;
          if (r.top < top) top = r.top;
          if (r.right > right) right = r.right;
        });
        if (!isFinite(top)) return 'no blocker';
        const y = Math.round(top - c.height - ${JSON.stringify(0)} - (${gap}));
        const x = Math.round(right - c.width);
        let s = document.getElementById('flicker-probe-style');
        if (!s) { s = document.createElement('style'); s.id = 'flicker-probe-style'; document.head.appendChild(s); }
        s.textContent = '.cute-clock-overlay{top:' + y + 'px!important;bottom:auto!important;left:' + x + 'px!important;right:auto!important}';
        return 'parked at ' + x + ',' + y + ' (blocker top ' + Math.round(top) + ', gap ' + ${JSON.stringify(0)} + ')';
      })()`);
      await sleep(1800);
    };

    const BLOCKERS = `(() => {
      const SEL = '.uV2eYG_input,[contenteditable="true"],textarea,[data-st-scroll],#st-top,#st-wall';
      const card = document.querySelector('.cute-clock-card').getBoundingClientRect();
      const pad = 8;
      return JSON.stringify([].slice.call(document.querySelectorAll(SEL)).map((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return null;
        const apart = card.right + pad <= r.left || r.right + pad <= card.left || card.bottom + pad <= r.top || r.bottom + pad <= card.top;
        return { cls: (typeof el.className === 'string' ? el.className : el.tagName).slice(0, 24), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], overlaps: !apart };
      }).filter(Boolean));
    })()`;

    const SAMPLE = `(() => {
      const card = document.querySelector('.cute-clock-card');
      const r = card.getBoundingClientRect();
      const cs = getComputedStyle(card);
      const marker = document.querySelector('[data-cute-clock-state]');
      return JSON.stringify({ box: [Math.round(r.left), Math.round(r.top), +r.width.toFixed(1), +r.height.toFixed(1)], opacity: cs.opacity, transform: cs.transform, state: marker ? marker.getAttribute('data-cute-clock-state') : null, hover: card.matches(':hover') });
    })()`;

    const hoverFor = async (ms) => {
      const t = JSON.parse(await ev(`(() => { const r = document.querySelector('.cute-clock-card').getBoundingClientRect(); return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]); })()`));
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t[0], y: t[1], button: 'none' });
      await sleep(ms);
      return t;
    };

    let allOk = true;
    const report = (label, ok, detail) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  →  ' + detail); return ok; };

    // 1. just outside the threshold: hover must neither move the box nor hide it
    await park(24);
    console.log('blockers while parked outside: ' + await ev(BLOCKERS));
    const before = await ev(SAMPLE);
    const centre = await hoverFor(2500);
    const after = await ev(SAMPLE);
    const b = JSON.parse(before), a = JSON.parse(after);
    allOk = report('1. hover, no overlap: box unchanged', JSON.stringify(b.box) === JSON.stringify(a.box), before + '  ->  ' + after) && allOk;
    allOk = report('2. hover, no overlap: still visible', a.opacity === '1' && a.state === 'shown' && a.hover, 'hover=' + a.hover + ' opacity=' + a.opacity + ' state=' + a.state) && allOk;

    // count opacity changes while the pointer rests on the card
    await ev(`(() => {
      window.__flip = [];
      const card = document.querySelector('.cute-clock-card');
      let last = getComputedStyle(card).opacity;
      window.__flipTimer = setInterval(() => {
        const now = getComputedStyle(card).opacity;
        if (now !== last) { last = now; window.__flip.push({ t: Math.round(performance.now()), opacity: now }); }
      }, 80);
      return true;
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: centre[0], y: centre[1], button: 'none' });
    await sleep(3000);
    const flips = JSON.parse(await ev('JSON.stringify(window.__flip || [])'));
    await ev('(() => { clearInterval(window.__flipTimer); return true; })()');
    allOk = report('3. hovering for 3s: opacity never flips', flips.length === 0, 'flips=' + JSON.stringify(flips)) && allOk;

    // 2. just inside the threshold: hiding is correct, and must stay hidden (no oscillation)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'none' });
    await sleep(600);
    await ev(`(() => { window.__flip2 = []; let last = getComputedStyle(document.querySelector('.cute-clock-card')).opacity; window.__flipTimer2 = setInterval(() => { const now = getComputedStyle(document.querySelector('.cute-clock-card')).opacity; if (now !== last) { last = now; window.__flip2.push({ t: Math.round(performance.now()), opacity: now }); } }, 80); return true; })()`);
    await park(0);
    const inside = await ev(SAMPLE);
    await hoverFor(2500);
    const insideAfter = await ev(SAMPLE);
    const flips2 = JSON.parse(await ev('JSON.stringify(window.__flip2 || [])'));
    await ev('(() => { clearInterval(window.__flipTimer2); return true; })()');
    allOk = report('4. overlapping: hidden', JSON.parse(insideAfter).opacity === '0', inside + '  ->  ' + insideAfter) && allOk;
    allOk = report('5. overlapping + hover: no oscillation', flips2.length <= 2, 'flips=' + JSON.stringify(flips2)) && allOk;

    await ev("(() => { const s = document.getElementById('flicker-probe-style'); if (s) s.remove(); return true; })()");
    console.log('');
    console.log(allOk ? 'NO-FLICKER CHECKS PASSED' : 'SOME CHECKS FAILED');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
