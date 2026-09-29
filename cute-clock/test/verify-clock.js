'use strict';
// Verify cute-clock → 元氣時鐘 in the running GUI: the panel label, the floating
// card, and the full clock page — while the current session runs the office
// preset (the case the removed gate used to blank out).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS_PATHS = [
  'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws',
  'D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/ws',
];
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const GUI = 'http://127.0.0.1:3080';
const PORT = 9363;
const SHOT = process.env.PROBE_SHOT || (process.env.TEMP + '/cute-clock-check.png');

let WebSocket = null;
for (const p of WS_PATHS) { if (fs.existsSync(p)) { try { WebSocket = require(p); break; } catch (_) {} } }
if (!WebSocket) { console.error('ws not found'); process.exit(2); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); } }); }
  send(method, params) { const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000); }); }
  async eval(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result ? r.result.value : undefined; }
}

const REPORT = `(() => {
  const out = {};
  const panel = [].slice.call(document.querySelectorAll('button, [role="button"]'))
    .filter((b) => /元氣時鐘|猫咪时钟|貓咪時鐘/.test((b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')));
  out.panelEntries = panel.map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim());
  const card = document.querySelector('.cute-clock-card');
  out.floatingCard = card ? {
    greet: (card.querySelector('.cute-clock-greet') || {}).textContent,
    slogan: (card.querySelector('.cute-clock-slogan') || {}).textContent,
    time: (card.querySelector('.cute-clock-time') || {}).textContent,
    date: (card.querySelector('.cute-clock-date') || {}).textContent,
    title: card.getAttribute('title'),
    faces: card.querySelectorAll('.cute-clock-svg').length,
  } : null;
  const page = document.querySelector('.cute-clock-page');
  out.bigPage = page ? {
    time: (page.querySelector('.cute-clock-bigtime') || {}).textContent,
    date: (page.querySelector('.cute-clock-bigdate') || {}).textContent,
    quote: (page.querySelector('.cute-clock-bigquote') || {}).textContent,
    petals: page.querySelectorAll('.cute-clock-petal').length,
  } : null;
  out.presetChip = (() => {
    const chip = [].slice.call(document.querySelectorAll('button')).find((el) => {
      const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
      return /模式/.test(t) && !/權限/.test(t);
    });
    return chip ? (chip.textContent || '').trim() : null;
  })();
  out.catWords = (document.body.innerText.match(/猫咪|貓咪|猫/g) || []).length;
  return JSON.stringify(out);
})()`;

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-probe-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1400,1000', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 60; i += 1) { try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); break; } catch (_) { await sleep(250); } }
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: GUI });

    let ready = false;
    for (let i = 0; i < 90; i += 1) {
      await sleep(400);
      const ok = await cdp.eval("!!document.querySelector('.cute-clock-card') || document.querySelectorAll('button').length > 5").catch(() => false);
      if (ok) { ready = true; break; }
    }
    console.log('app booted: ' + ready);
    await sleep(2500);
    console.log('--- before opening the panel ---');
    console.log(await cdp.eval(REPORT));

    const clicked = await cdp.eval(`(() => {
      const hit = [].slice.call(document.querySelectorAll('button, [role="button"]'))
        .find((b) => /元氣時鐘/.test((b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    await sleep(1800);
    console.log('--- opened the clock panel: ' + clicked + ' ---');
    console.log(await cdp.eval(REPORT));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot: ' + SHOT);
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
