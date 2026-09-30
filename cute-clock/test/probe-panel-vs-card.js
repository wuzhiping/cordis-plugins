'use strict';
// 量「全局面板内容」和「角落浮动卡片」的矩形，判断是否重叠。
// 用法: node test/probe-panel-vs-card.js [視窗高]
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
const HEIGHT = Number(process.argv[2] || 950);
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pvsc-'));
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

    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 120; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.cute-clock-card')").catch(() => false)) break; }
    await sleep(2500);
    await ev(`(() => {
      const hit = Array.from(document.querySelectorAll('span,button,div,a'))
        .find((el) => el.className && String(el.className).indexOf('cute-clock-glyph') >= 0);
      if (!hit) return 'no-glyph';
      hit.click();
      const row = hit.closest('[class*="panelRow"]') || hit.parentElement;
      if (row && row !== hit) row.click();
      return 'clicked';
    })()`);
    for (let i = 0; i < 40; i += 1) { await sleep(250); if (await ev("!!document.querySelector('.cute-clock-page')")) break; }
    await sleep(1500);

    // 先把 slogan 换成最长的一条（会换成两行、变更宽），量最坏情况
    if (process.env.WORST_CASE) {
      await ev(`(() => { const q = document.querySelector('.cute-clock-bigquote'); if (q) q.textContent = '✿  你現在的努力，年底會替你還願 🎁  ✿'; })()`);
      await sleep(600);
      // 让卡片的让位逻辑（300ms 采样 + MutationObserver）跑一会儿，观察它是否自动收起
      const trace = [];
      for (let i = 0; i < 10; i += 1) {
        await sleep(400);
        trace.push(await ev(`(document.querySelector('[data-cute-clock-state]') || {}).getAttribute
          ? document.querySelector('[data-cute-clock-state]').getAttribute('data-cute-clock-state') : 'n/a'`));
      }
      console.log('卡片状态轨迹(每400ms): ' + JSON.stringify(trace));
    }

    const out = await ev(`(() => {
      const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }; };
      const overlaps = (a, b) => a && b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
      const page = document.querySelector('.cute-clock-page');
      const card = document.querySelector('.cute-clock-card');
      const cardState = document.querySelector('[data-cute-clock-state]');
      const items = {};
      for (const [k, sel] of [['face', '.cute-clock-bigface'], ['time', '.cute-clock-bigtime'],
                              ['date', '.cute-clock-bigdate'], ['quote', '.cute-clock-bigquote']]) {
        items[k] = box(page.querySelector(sel));
      }
      const cb = box(card);
      const res = {};
      for (const k of Object.keys(items)) res[k + ' vs card'] = overlaps(items[k], cb);
      return {
        viewport: [window.innerWidth, window.innerHeight],
        card: cb,
        cardState: cardState ? cardState.getAttribute('data-cute-clock-state') : null,
        panel: box(page),
        items: items,
        overlaps: res,
        quoteText: page.querySelector('.cute-clock-bigquote').textContent.trim(),
      };
    })()`);
    console.log(JSON.stringify(out, null, 1));

    if (process.env.PROBE_SHOT) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot.data, 'base64'));
      console.log('screenshot: ' + process.env.PROBE_SHOT);
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
