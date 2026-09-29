'use strict';
// Read the floating card's box (size + position) so the -15px / +15px request can be
// checked as a number instead of by eye.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9395;
const SHOT = process.env.PROBE_SHOT || (process.env.TEMP + '/card-box.png');
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbox-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + dir,
    '--window-size=1400,950', 'about:blank'], { stdio: 'ignore' });
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

    console.log(await ev(`(() => {
      const card = document.querySelector('.cute-clock-card');
      const overlay = document.querySelector('[data-cute-clock-state]');
      const cr = card.getBoundingClientRect();
      const cs = getComputedStyle(overlay);
      // Natural (unclipped) width of each text line: the widest one is what sizes
      // the column, and therefore the card.
      const lines = ['.cute-clock-greet', '.cute-clock-slogan', '.cute-clock-time', '.cute-clock-date'].map((sel) => {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        const prev = el.style.width;
        el.style.width = 'max-content';
        const natural = Math.round(el.getBoundingClientRect().width);
        el.style.width = prev;
        return { sel: sel, rendered: Math.round(r.width), natural: natural, text: (el.textContent || '').slice(0, 22) };
      });
      const text = document.querySelector('.cute-clock-text');
      return JSON.stringify({
        viewport: [window.innerWidth, window.innerHeight],
        card: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.width), Math.round(cr.height)],
        gapRight: Math.round(window.innerWidth - cr.right),
        gapBottom: Math.round(window.innerHeight - cr.bottom),
        overlayCss: { right: cs.right, bottom: cs.bottom },
        textColumn: Math.round(text.getBoundingClientRect().width),
        lines: lines,
        cardParts: { padding: getComputedStyle(card).padding, gap: getComputedStyle(card).gap, face: Math.round(document.querySelector('.cute-clock-face').getBoundingClientRect().width) },
      });
    })()`));

    if (process.env.PROBE_SHOT) {
      const box = JSON.parse(await ev(`(() => {
        const r = document.querySelector('.cute-clock-card').getBoundingClientRect();
        return JSON.stringify({ x: Math.max(0, Math.round(r.left) - 24), y: Math.max(0, Math.round(r.top) - 24), w: Math.round(r.width) + 48, h: Math.round(r.height) + 48 });
      })()`));
      const shot = await send('Page.captureScreenshot', {
        format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 2 },
      });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('screenshot: ' + SHOT + '  clip=' + JSON.stringify(box));
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
