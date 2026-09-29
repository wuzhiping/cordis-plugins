'use strict';
// Does hovering the card change the geometry the hide rule measures? Dispatch a real
// mouse move onto the card and sample its box + the plugin's state for a few seconds.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9401;
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoverprobe-'));
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

    // Start an in-page sampler that records every distinct card geometry.
    await ev(`(() => {
      window.__geo = [];
      let last = null;
      window.__geoTimer = setInterval(() => {
        const card = document.querySelector('.cute-clock-card');
        if (!card) return;
        const r = card.getBoundingClientRect();
        const cs = getComputedStyle(card);
        const marker = document.querySelector('[data-cute-clock-state]');
        const key = [Math.round(r.left), Math.round(r.top), +r.width.toFixed(1), +r.height.toFixed(1), cs.opacity, cs.transform, marker ? marker.getAttribute('data-cute-clock-state') : ''].join('|');
        if (key !== last) { last = key; window.__geo.push({ t: Math.round(performance.now()), box: [Math.round(r.left), Math.round(r.top), +r.width.toFixed(1), +r.height.toFixed(1)], opacity: cs.opacity, transform: cs.transform, marker: marker ? marker.getAttribute('data-cute-clock-state') : null }); }
      }, 100);
      return true;
    })()`);
    await sleep(2000);

    const target = JSON.parse(await ev(`(() => {
      const r = document.querySelector('.cute-clock-card').getBoundingClientRect();
      return JSON.stringify([Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]);
    })()`));
    console.log('card centre: ' + JSON.stringify(target));

    // Move the real pointer onto the card (CDP dispatches proper mouse events).
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'none' });
    await sleep(400);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target[0], y: target[1], button: 'none' });
    await sleep(2500);

    const hovered = await ev(`(() => { const c = document.querySelector('.cute-clock-card'); return JSON.stringify({ matchesHover: c.matches(':hover'), transform: getComputedStyle(c).transform, box: (function () { const r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() }); })()`);
    console.log('while hovering: ' + hovered);

    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 300, button: 'none' });
    await sleep(1200);

    const geo = JSON.parse(await ev('JSON.stringify(window.__geo || [])'));
    await ev('(() => { clearInterval(window.__geoTimer); return true; })()');
    console.log('');
    console.log('distinct states recorded: ' + geo.length);
    for (const g of geo.slice(0, 16)) {
      console.log('  t=' + String(g.t).padStart(6) + 'ms  box=' + JSON.stringify(g.box) + '  opacity=' + g.opacity + '  transform=' + g.transform + '  marker=' + g.marker);
    }
    console.log('');
    const ys = [...new Set(geo.map((g) => g.box[1]))];
    const ops = [...new Set(geo.map((g) => g.opacity))];
    console.log('distinct tops: ' + JSON.stringify(ys));
    console.log('distinct opacities: ' + JSON.stringify(ops));
    console.log(ops.length > 1 ? 'FLICKER: opacity changed while hovering' : 'no opacity change');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
