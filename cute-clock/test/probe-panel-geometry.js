'use strict';
// 量「元氣時鐘」全局面板（main keyed）的排版；可把容器临时挪 40px 做前后对比。
// 用法: node test/probe-panel-geometry.js [視窗高] [shiftPx]
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
const HEIGHT = Number(process.argv[2] || 950);
const SHIFT = Number(process.argv[3] || 0);
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panelgeo-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + dir,
    '--window-size=1400,' + HEIGHT, 'about:blank'], { stdio: 'ignore' });
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
    for (let i = 0; i < 120; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.cute-clock-card')").catch(() => false)) break; }
    await sleep(2500);

    const measure = () => ev(`(() => {
      const page = document.querySelector('.cute-clock-page');
      const pr = page.getBoundingClientRect();
      const cs = getComputedStyle(page);
      const items = [
        ['.cute-clock-bigface', '大鐘面'],
        ['.cute-clock-bigtime', '大字時間'],
        ['.cute-clock-bigdate', '日期'],
        ['.cute-clock-bigquote', 'slogan'],
      ].map(([sel, label]) => {
        const el = page.querySelector(sel);
        if (!el) return { label: label, missing: true };
        const r = el.getBoundingClientRect();
        return { label: label, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) };
      }).filter((x) => !x.missing);
      return {
        viewport: [window.innerWidth, window.innerHeight],
        panel: [Math.round(pr.left), Math.round(pr.top), Math.round(pr.width), Math.round(pr.height)],
        panelCss: { padding: cs.padding, gap: cs.gap, transform: cs.transform },
        items: items,
        gapAboveClock: items[0].top - Math.round(pr.top),
        gapBelowSlogan: Math.round(pr.bottom) - items[items.length - 1].bottom,
      };
    })()`);

    const clicked = await ev(`(() => {
      const hit = Array.from(document.querySelectorAll('span,button,div,a'))
        .find((el) => el.className && String(el.className).indexOf('cute-clock-glyph') >= 0);
      if (!hit) return 'no-glyph';
      hit.click();
      const row = hit.closest('[class*="panelRow"]') || hit.parentElement;
      if (row && row !== hit) row.click();
      return 'clicked';
    })()`);

    let ok = false;
    for (let i = 0; i < 40; i += 1) { await sleep(250); ok = await ev("!!document.querySelector('.cute-clock-page')").catch(() => false); if (ok) break; }
    if (!ok) { console.log(JSON.stringify({ clicked, panelFound: false })); return; }
    await sleep(1200);

    const before = await measure();

    if (SHIFT) {
      // 只做“预测”用：给容器加等价于 padding 变化的位移，量一次预期结果
      await ev(`(() => {
        const s = document.createElement('style');
        s.textContent = '.cute-clock-page{padding-bottom:${40 + 2 * SHIFT}px!important}';
        document.head.appendChild(s);
      })()`);
      await sleep(400);
    }
    const after = await measure();

    console.log(JSON.stringify({ clicked, before, shifted: SHIFT ? after : null }, null, 1));
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
