'use strict';
// 臨時（可删）：截我的輸入框外觀，和宿主主輸入框並排比較。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CFG = path.join(__dirname, '..', 'config.yml');
const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9649;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cfgBefore = fs.readFileSync(CFG, 'utf8');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-cmp-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile, '--window-size=1500,1000', '--no-first-run',
    '--no-default-browser-check', '--force-device-scale-factor=2'], { stdio: 'ignore' });
  let ws = null;
  try {
    let list = null;
    for (let i = 0; i < 80; i += 1) {
      try { list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (list && list.length) break; } catch (e) { /* wait */ }
      await sleep(250);
    }
    const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || list[0];
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    let id = 0;
    const pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    });
    const send = (method, params) => { id += 1; const my = id; return new Promise((res, rej) => { pend.set(my, { res, rej }); ws.send(JSON.stringify({ id: my, method, params: params || {} })); }); };
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result ? r.result.value : undefined;
    };
    const waitFor = async (expr, ms) => {
      const end = Date.now() + ms;
      for (;;) { if (await ev('!!(' + expr + ')')) return true; if (Date.now() > end) return false; await sleep(200); }
    };
    /** 截元素成 base64。 @param sel - 選擇器。 @param pad - 邊距。 @param scale - 倍率。 @returns Promise<base64|null>。 */
    async function shotB64(sel, pad, scale) {
      const clip = await ev(`JSON.stringify((() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return null;
        return { x: Math.max(0, r.left - ${pad}), y: Math.max(0, r.top - ${pad}),
          width: r.width + ${pad * 2}, height: r.height + ${pad * 2}, scale: ${scale} };
      })())`);
      if (!clip || clip === 'null') return null;
      const s = await send('Page.captureScreenshot', { format: 'png', clip: JSON.parse(clip) });
      return s.data;
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:3080/?cmp=' + Date.now() });
    await waitFor('document.body', 60000);
    await sleep(3500);

    // 1) 宿主首頁的輸入卡
    const hostShot = await shotB64('[class*="_card"]', 10, 2);
    if (hostShot) fs.writeFileSync(path.join(__dirname, '_verify-78-host-input.png'), Buffer.from(hostShot, 'base64'));
    console.log('  宿主輸入卡: ' + (hostShot ? 'OK' : '找不到'));

    // 2) 開面板，截我的輸入框那一列
    const row = await ev(`(() => {
      const rows = Array.from(document.querySelectorAll('[class*="panelRow"]'));
      const r = rows.find((x) => x.textContent.indexOf('團隊協同') !== -1);
      if (r) { r.click(); return true; }
      return false;
    })()`);
    console.log('  開面板: ' + row);
    await waitFor("document.querySelector('.ntfy-teams-textarea')", 25000);
    await sleep(2500);
    const myShot = await shotB64('.ntfy-teams-composerow', 10, 2);
    if (myShot) fs.writeFileSync(path.join(__dirname, '_verify-79-my-input.png'), Buffer.from(myShot, 'base64'));
    console.log('  我的輸入列: ' + (myShot ? 'OK' : '找不到'));

    // 量兩邊的視覺規格
    const m = await ev(`JSON.stringify((() => {
      const mine = document.querySelector('.ntfy-teams-textarea');
      const card = document.querySelector('[class*="_card"]');
      const R = (el) => { if (!el) return null; const c = getComputedStyle(el);
        return { border: c.borderTopWidth + ' ' + c.borderTopStyle + ' ' + c.borderTopColor,
                 radius: c.borderRadius, shadow: c.boxShadow === 'none' ? 'none' : c.boxShadow.slice(0, 60),
                 bg: c.backgroundColor }; };
      return { 我的輸入框: R(mine), 宿主輸入卡: R(card) };
    })())`);
    console.log('');
    console.log(m);
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    try { chrome.kill(); } catch (e) { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    const now = fs.readFileSync(CFG, 'utf8');
    if (now !== cfgBefore) { fs.writeFileSync(CFG, cfgBefore); console.log('  config.yml 有變動 → 已還原'); }
    else { console.log('  config.yml 未變動'); }
  }
}
main().catch((e) => { console.error('爆了：', e && e.message); process.exit(1); });
