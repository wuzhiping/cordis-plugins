'use strict';
// Geometry reconnaissance: where does the floating clock sit, and what element is
// the composer? Reports bounding boxes so the overlap rule can be built on real
// numbers instead of guessed class hashes.
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
const PORT = 9373;

let WebSocket = null;
for (const p of WS_PATHS) { if (fs.existsSync(p)) { try { WebSocket = require(p); break; } catch (_) {} } }
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
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  const card = document.querySelector('.cute-clock-card');
  const overlay = document.querySelector('.cute-clock-overlay');
  // Every element that looks like a composer/editor surface.
  const editables = [].slice.call(document.querySelectorAll('[contenteditable="true"], textarea'))
    .map((el) => ({ cls: el.className, box: box(el), ph: el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || '' }));
  // ancestors of the first editable
  const chain = [];
  let n = document.querySelector('[contenteditable="true"], textarea');
  for (let i = 0; i < 8 && n; i += 1) { chain.push({ tag: n.tagName, cls: (typeof n.className === 'string' ? n.className : ''), box: box(n) }); n = n.parentElement; }
  return JSON.stringify({
    viewport: [window.innerWidth, window.innerHeight],
    card: box(card), overlay: box(overlay),
    editables, chain,
    composerCandidates: [].slice.call(document.querySelectorAll('[class*="composer" i], [class*="Composer"]'))
      .map((el) => ({ cls: (typeof el.className === 'string' ? el.className : ''), box: box(el) })).slice(0, 12),
  });
})()`;

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geom-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
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
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 100; i += 1) { await sleep(400); if (await cdp.eval("!!document.querySelector('.hHd-Xa_root') && !!document.querySelector('.cute-clock-card')").catch(() => false)) break; }
    await sleep(3000);
    console.log(await cdp.eval(REPORT));
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
