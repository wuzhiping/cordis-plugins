'use strict';
// See the real first-run dialogs: unlock the preview notice by overriding its
// localStorage flag BEFORE the app boots, open Settings → 模型, and report the modal
// structure (classes, title, buttons) in one run. Read-only: nothing is clicked.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9405;
const SHOT = process.env.PROBE_SHOT || (process.env.TEMP + '/notice-modal.png');
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noticemodal-'));
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
    // No per-source override: clear the app's own keys so the notice re-appears.
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        try {
          const keys = Object.keys(localStorage).filter((k) => /settings|welcome|notice/i.test(k));
          window.__cleared = keys;
          keys.forEach((k) => localStorage.removeItem(k));
        } catch (e) { window.__cleared = String(e && e.message); }
      })();`,
    });
    await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 100; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.hHd-Xa_root')").catch(() => false)) break; }
    await sleep(2500);
    console.log('app-level keys cleared before boot: ' + await ev('JSON.stringify(window.__cleared || [])'));

    // Settings → 模型
    for (const label of ['設定', '模型']) {
      const ok = await ev(`(() => {
        const hit = [].slice.call(document.querySelectorAll('button, [role="button"], a, [role="tab"]'))
          .find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      console.log('clicked ' + label + ': ' + ok);
      await sleep(2200);
    }

    const modal = await ev(`(() => {
      const dialogs = [].slice.call(document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]'));
      return JSON.stringify(dialogs.map((d) => ({
        cls: d.className,
        role: d.getAttribute('role'),
        title: (d.querySelector('[class*=title],[class*=Title],h2,h3') || {}).textContent,
        buttons: [].slice.call(d.querySelectorAll('button')).map((b) => (b.textContent || '').trim()),
        box: (function () { const r = d.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })(),
        htmlHead: d.outerHTML.slice(0, 260),
      })));
    })()`);
    console.log('dialogs: ' + modal);

    // Also report any element whose text is the notice title, even outside role=dialog
    console.log('notice title nodes: ' + await ev(`(() => {
      const out = [];
      document.querySelectorAll('*').forEach((n) => {
        if (n.children.length === 0 && /预览版说明|預覽版說明|添加一个 API Key|添加一個 API Key/.test(n.textContent || '')) {
          const d = n.closest('[class]');
          out.push({ text: n.textContent.trim(), nodeCls: n.className, parentCls: d ? d.className : null, chain: (function () { const c = []; let p = n; for (let i = 0; i < 5 && p; i += 1) { c.push((p.tagName || '') + '.' + (typeof p.className === 'string' ? p.className : '')); p = p.parentElement; } return c; })() });
        }
      });
      return JSON.stringify(out.slice(0, 6));
    })()`));

    if (process.env.PROBE_SHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
      console.log('screenshot: ' + SHOT);
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
