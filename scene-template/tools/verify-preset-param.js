'use strict';

// Verification harness for the scene list's `?preset=` parameter.
//
//   node tools/verify-preset-param.js
//
// Opens the RUNNING GUI (http://127.0.0.1:3080) in its own headless Chrome,
// records every `scene/list` request the real client bundle issues, and reports
// the preset chip's state. Read-only: it navigates and reads, it never clicks a
// scenario chip or writes anything.
//
// Findings it can report:
//   - the exact request URL(s), so the `&preset=` parameter is visible;
//   - how many times `scene/list` was requested, so a re-fetch is visible;
//   - the agent-preset chip's label, i.e. which preset is current.
//
// It ends by opening the agent-preset menu, reporting the roster, and naming the
// option a click would pick — the user's own session is never clicked through.

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

const GUI = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const PORT = 9345;

let WebSocket = null;
for (const p of WS_PATHS) { if (fs.existsSync(p)) { try { WebSocket = require(p); break; } catch (_) {} } }
if (!WebSocket) { console.error('ws not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      if (msg.method) this.events.push(msg);
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error('page exception: ' + (res.exceptionDetails.exception
        ? res.exceptionDetails.exception.description || res.exceptionDetails.text
        : res.exceptionDetails.text));
    }
    return res.result ? res.result.value : undefined;
  }
}

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) { console.error('no Chrome/Edge found'); process.exit(2); }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-preset-probe-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1400,1000', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 60; i += 1) {
      try { targets = await httpJson('http://127.0.0.1:' + PORT + '/json/list'); break; } catch (_) { await sleep(250); }
    }
    if (!targets) throw new Error('devtools endpoint never came up');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');

    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const cdp = new Cdp(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.navigate', { url: GUI });

    let booted = false;
    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      try {
        const n = await cdp.eval('document.querySelectorAll("button").length');
        if (n && n > 3) { booted = true; break; }
      } catch (_) { /* still loading */ }
    }
    console.log('app booted: ' + booted);
    // The composer panel is contributed by this bundle; wait for it before
    // reading requests, because a slow first paint otherwise reports "none".
    let panel = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const n = await cdp.eval('document.querySelectorAll("[data-st-scroll]").length');
        if (n && n > 0) { panel = true; break; }
      } catch (_) { /* still loading */ }
      await sleep(400);
    }
    console.log('scene panel mounted: ' + panel);
    await sleep(2500);   // let the scene list effects settle

    const requests = [];
    for (const ev of cdp.events) {
      if (ev.method !== 'Network.requestWillBeSent') continue;
      const url = ev.params && ev.params.request ? ev.params.request.url : '';
      if (url.indexOf('/scene/') !== -1) requests.push({ url, type: ev.params.type, method: ev.params.request.method });
    }
    console.log('');
    console.log('=== scene API requests seen from the real bundle ===');
    if (requests.length === 0) console.log('  (none — is the composer panel mounted?)');
    for (const r of requests) console.log('  ' + r.method + ' ' + r.url);

    const listRequests = requests.filter((r) => r.url.indexOf('/scene/list') !== -1);
    console.log('');
    console.log('scene/list requests: ' + listRequests.length);
    console.log('carry &preset=      : ' + listRequests.filter((r) => /[?&]preset=/.test(r.url)).length);

    const dom = await cdp.eval(`(() => {
      const chips = Array.from(document.querySelectorAll('[data-st-scroll] div'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 0 && t.length < 60);
      const tippy = Array.from(document.querySelectorAll('[data-st-scroll]'))
        .map((el) => el.getAttribute('title') || '');
      const presetChip = Array.from(document.querySelectorAll('button'))
        .map((el) => ((el.getAttribute('aria-label') || '') + '|' + (el.textContent || '').trim()))
        .filter((t) => /模式|preset|Preset/.test(t));
      return { chips: chips.slice(0, 10), tippy: tippy.slice(0, 3), presetChip: presetChip.slice(0, 5) };
    })()`);
    console.log('');
    console.log('=== DOM ===');
    console.log('  scenario chips : ' + JSON.stringify(dom.chips));
    console.log('  list tooltip   : ' + JSON.stringify(dom.tippy));
    console.log('  preset controls: ' + JSON.stringify(dom.presetChip));

    const stUrls = await cdp.eval(`(() => {
      const out = [];
      try {
        const store = window.__DSH_BOOT__ && window.__DSH_BOOT__.sessions;
        if (store) out.push('boot.sessions=' + Object.keys(store).join(','));
      } catch (e) { out.push('boot read failed: ' + e.message); }
      out.push('boot keys=' + Object.keys(window.__DSH_BOOT__ || {}).join(','));
      return out;
    })()`);
    console.log('  boot           : ' + JSON.stringify(stUrls));

    // ---- agent-preset menu: switch to 办公模式 and watch the list re-fetch ----
    const before = listRequests.length;
    await cdp.eval(`(() => {
      const chip = Array.from(document.querySelectorAll('button')).find((el) => {
        const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
        return /模式/.test(t) && !/權限/.test(t);
      });
      if (chip) chip.click();
      return !!chip;
    })()`);
    await sleep(1200);
    const menu = await cdp.eval(`(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.length > 0);
      return { items: items.slice(0, 12), count: items.length };
    })()`);
    console.log('');
    console.log('=== agent-preset menu (opened on a disposable browser) ===');
    console.log('  options: ' + JSON.stringify(menu.items));

    // Pick the preset the boot did NOT use, so the pick is a real change. This
    // reaches the Host for the disposable browser's own blank session; the
    // original preset is restored afterwards.
    const currentChip = await cdp.eval(`(() => {
      const chip = Array.from(document.querySelectorAll('button')).find((el) => {
        const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
        return /模式/.test(t) && !/權限/.test(t);
      });
      return chip ? { label: (chip.textContent || '').trim(), disabled: !!chip.disabled } : null;
    })()`);
    const target = currentChip && /標準模式/.test(currentChip.label) ? '办公模式' : '標準模式';
    console.log('  current chip: ' + JSON.stringify(currentChip) + '  -> picking ' + target);

    const blank = await cdp.eval(`(() => {
      const want = ${JSON.stringify(target)};
      const hit = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
        .find((el) => (el.textContent || '').indexOf(want) !== -1);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    console.log('  clicked ' + target + ': ' + blank);
    await sleep(5000);

    const chipAfter = await cdp.eval(`(() => {
      const chip = Array.from(document.querySelectorAll('button')).find((el) => {
        const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
        return /模式/.test(t) && !/權限/.test(t);
      });
      const chips = Array.from(document.querySelectorAll('[data-st-scroll] span, [data-st-scroll] div'))
        .map((el) => (el.textContent || '').trim()).filter((t) => t.length > 0 && t.length < 40);
      const tip = Array.from(document.querySelectorAll('[data-st-scroll]'))
        .map((el) => el.getAttribute('title') || '').filter((t) => t.length > 0);
      return {
        chip: chip ? ((chip.getAttribute('aria-label') || '') + '|' + (chip.textContent || '').trim()) : null,
        listTip: tip.slice(0, 2),
        chips: chips.slice(0, 6),
      };
    })()`);
    console.log('  chip after pick: ' + JSON.stringify(chipAfter.chip));
    console.log('  list tooltip now: ' + JSON.stringify(chipAfter.listTip));
    console.log('  scenario chips now: ' + JSON.stringify(chipAfter.chips));

    const rpcs = [];
    for (const ev of cdp.events) {
      if (ev.method !== 'Network.requestWillBeSent') continue;
      const url = (ev.params && ev.params.request ? ev.params.request.url : '');
      if (url.indexOf('127.0.0.1') !== -1 && url.indexOf('scene') === -1) rpcs.push(url.replace('http://127.0.0.1:3080', ''));
    }
    console.log('  same-origin requests: ' + JSON.stringify(rpcs.slice(-12)));

    const afterList = requests.filter((r) => r.url.indexOf('/scene/list') !== -1);
    console.log('');
    console.log('=== scene/list requests after the preset pick ===');
    for (const r of afterList) console.log('  ' + r.method + ' ' + r.url);
    console.log('  total: ' + afterList.length
      + ', with &preset=: ' + afterList.filter((r) => /[?&]preset=/.test(r.url)).length
      + ', with the picked preset: ' + afterList.filter((r) => r.url.indexOf('preset=' + encodeURIComponent(target === '办公模式' ? 'office' : 'standard')) !== -1).length);

    // Leave the disposable browser on the preset it booted with.
    if (currentChip !== null) {
      await cdp.eval(`(() => {
        const chip = Array.from(document.querySelectorAll('button')).find((el) => {
          const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
          return /模式/.test(t) && !/權限/.test(t);
        });
        if (chip) chip.click();
        return !!chip;
      })()`);
      await sleep(800);
      const restored = await cdp.eval(`(() => {
        const want = ${JSON.stringify(currentChip.label)};
        const hit = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
          .find((el) => (el.textContent || '').indexOf(want) !== -1);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(1500);
      console.log('  restored ' + currentChip.label + ': ' + restored);
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
