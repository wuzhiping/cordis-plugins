'use strict';
// Confirm the MCP網關 panel header shows ONLY the title: no endpoint chips, and no
// POST / oauth2 / host text anywhere in the panel.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9397;
const SHOT = process.env.PROBE_SHOT || (process.env.TEMP + '/mcp-header.png');
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphead-'));
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
    for (let i = 0; i < 100; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.hHd-Xa_root')").catch(() => false)) break; }
    await sleep(2500);
    const clicked = await ev(`(() => {
      const hit = [].slice.call(document.querySelectorAll('button, [role="button"]'))
        .find((b) => /MCP/.test((b.textContent || '') + (b.getAttribute('aria-label') || '')));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    await sleep(2500);
    console.log('panel opened: ' + clicked);
    console.log(await ev(`(() => {
      const head = document.querySelector('.fdep__head');
      const panel = document.querySelector('.fdep');
      const h = document.querySelector('.fdep__title');
      const hr = head ? head.getBoundingClientRect() : null;
      const text = panel ? (panel.textContent || '') : '';
      return JSON.stringify({
        title: h ? h.textContent.trim() : null,
        headerBox: hr ? [Math.round(hr.left), Math.round(hr.top), Math.round(hr.width), Math.round(hr.height)] : null,
        chips: document.querySelectorAll('.fdep__chip').length,
        metaRow: document.querySelectorAll('.fdep__meta').length,
        headerHtml: head ? head.outerHTML.slice(0, 200) : null,
        leaks: { POST: text.indexOf('POST') !== -1, oauth2: text.indexOf('oauth2') !== -1, host: text.indexOf('abc.feg.com.tw') !== -1, skill: text.indexOf('skill:') !== -1 },
      });
    })()`));

    const box = JSON.parse(await ev(`(() => {
      const r = document.querySelector('.fdep').getBoundingClientRect();
      return JSON.stringify({ x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), w: Math.round(r.width), h: 150 });
    })()`));
    const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1.6 } });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot: ' + SHOT);
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
