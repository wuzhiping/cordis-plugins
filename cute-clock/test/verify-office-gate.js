'use strict';
// The gate case: switch the session to 办公模式 (the preset the clock used to hide
// under) and confirm the clock stays on screen. The disposable browser restores
// the preset it found.
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
const PORT = 9365;
const SHOT = process.env.TEMP + '/cute-clock-office.png';

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

const CHIP = `(() => {
  const chip = [].slice.call(document.querySelectorAll('button')).find((el) => {
    const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
    return /模式/.test(t) && !/權限/.test(t);
  });
  return chip ? chip.textContent.trim() : null;
})()`;
const VISIBLE = `JSON.stringify({
  chip: ${CHIP},
  card: !!document.querySelector('.cute-clock-card'),
  panelEntry: [].slice.call(document.querySelectorAll('button')).some((b) => /元氣時鐘/.test(b.textContent || '')),
})`;

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-office-'));
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
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 90; i += 1) { await sleep(400); if (await cdp.eval("document.querySelectorAll('button').length > 5").catch(() => false)) break; }
    await sleep(2000);

    const original = await cdp.eval(CHIP);
    console.log('preset before: ' + original);
    console.log('before switch: ' + await cdp.eval(VISIBLE));

    const target = original && /標準模式/.test(original) ? '办公模式' : '標準模式';
    await cdp.eval(`(() => {
      const chip = [].slice.call(document.querySelectorAll('button')).find((el) => {
        const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
        return /模式/.test(t) && !/權限/.test(t);
      });
      if (chip) chip.click();
      return !!chip;
    })()`);
    await sleep(1000);
    const picked = await cdp.eval(`(() => {
      const want = ${JSON.stringify(target)};
      const hit = [].slice.call(document.querySelectorAll('[role="menuitem"], [role="option"]'))
        .find((el) => (el.textContent || '').indexOf(want) !== -1);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    console.log('switched to ' + target + ': ' + picked);
    await sleep(5000);
    console.log('after switch : ' + await cdp.eval(VISIBLE));

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('screenshot: ' + SHOT);

    // restore the preset this browser booted with
    if (original) {
      await cdp.eval(`(() => {
        const chip = [].slice.call(document.querySelectorAll('button')).find((el) => {
          const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
          return /模式/.test(t) && !/權限/.test(t);
        });
        if (chip) chip.click();
        return !!chip;
      })()`);
      await sleep(900);
      const restored = await cdp.eval(`(() => {
        const want = ${JSON.stringify(original)};
        const hit = [].slice.call(document.querySelectorAll('[role="menuitem"], [role="option"]'))
          .find((el) => (el.textContent || '').indexOf(want) !== -1);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(1500);
      console.log('restored ' + original + ': ' + restored);
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
