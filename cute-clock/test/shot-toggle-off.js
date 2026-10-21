'use strict';
// 截「开关关闭」状态，可指定主题：node test/shot-toggle-off.js <out.png> [light|dark]
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
const OUT = process.argv[2];
const THEME = process.argv[3] || 'dark';
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toggshot-'));
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

    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 120; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.cute-clock-glyph')").catch(() => false)) break; }
    await sleep(2000);

    // 先按主题设定（light 时清掉深色 class，用 prefers-color-scheme 模拟更稳）
    if (THEME === 'light') {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }).catch(() => {});
      await ev(`(() => {
        document.documentElement.classList.remove('dark', 'dsw-dark', 'theme-dark');
        document.documentElement.setAttribute('data-theme', 'light');
        try { localStorage.setItem('dsh-theme', 'light'); } catch (e) {}
      })()`);
      await send('Page.reload');
      for (let i = 0; i < 120; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.cute-clock-glyph')").catch(() => false)) break; }
      await sleep(2000);
    }

    await ev(`(() => {
      const hit = Array.from(document.querySelectorAll('span,button,div,a'))
        .find((el) => el.className && String(el.className).indexOf('cute-clock-glyph') >= 0);
      const row = hit && (hit.closest('[class*="panelRow"]') || hit.parentElement);
      if (hit) hit.click();
      if (row && row !== hit) row.click();
    })()`);
    for (let i = 0; i < 40; i += 1) { await sleep(250); if (await ev("!!document.querySelector('.cute-toggle')")) break; }
    await sleep(800);

    // 确保是「关」状态
    const was = await ev(`(() => {
      const input = document.querySelector('[data-cute-toggle="floating-visible"] input');
      if (!input) return 'no-input';
      if (input.checked) input.click();
      return input.checked ? 'still-on' : 'now-off';
    })()`);
    await sleep(900);
    const info = await ev(`(() => {
      const box = document.querySelector('[data-cute-toggle="floating-visible"]');
      const knob = box.querySelector('.cute-toggle__knob');
      const input = box.querySelector('input');
      return {
        dataOn: box.getAttribute('data-on'),
        label: box.textContent.replace(/\\s+/g, ' ').trim(),
        overlayPresent: !!document.querySelector('[data-cute-clock-float]'),
        trackBg: getComputedStyle(input).backgroundColor,
        knobBg: getComputedStyle(knob).backgroundColor,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    })()`);
    console.log('was=' + was + '  ' + JSON.stringify(info));

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot: ' + OUT);

    // 收尾：清掉键，恢复默认
    await ev(`try { localStorage.removeItem('cute-clock:floating-visible'); } catch (e) {}`);
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
