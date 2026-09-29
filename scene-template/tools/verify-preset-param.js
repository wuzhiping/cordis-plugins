'use strict';

// Verification harness for the scene list's `?preset=` parameter.
//
//   node tools/verify-preset-param.js
//
// Opens the RUNNING GUI (http://127.0.0.1:3080) in its own headless Chrome and
// reports what the real client bundle actually did:
//   1. every `scene/list` call, with its full query string — so `&preset=` is
//      visible rather than inferred;
//   2. the scene-list tooltip and the scenario chips in the live DOM;
//   3. the agent-preset roster and a real preset switch, then the `scene/list`
//      call that switch produced (a change must re-fetch).
//
// It uses a throwaway browser profile and restores the preset it found, so the
// user's own window and session are untouched. `fetch` is wrapped through
// `Page.addScriptToEvaluateOnNewDocument` because the CDP Network domain does
// not report every cross-origin request here.

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

/** Every `scene/list` call the page made, newest last. */
async function sceneCalls(cdp) {
  const raw = await cdp.eval('JSON.stringify((window.__stProbe || []).map((c) => c.url))');
  return JSON.parse(raw || '[]');
}

/** The composer panel's scenario chip row: its tooltip and its chips. */
function panelReader() {
  return `(() => {
    const rows = Array.from(document.querySelectorAll('[data-st-scroll]'));
    const tip = rows.map((el) => el.getAttribute('title') || '').filter((t) => t.length > 0);
    const chips = Array.from(document.querySelectorAll('[data-st-scroll] div'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => t.length > 0 && t.length < 60);
    return { tooltip: tip.slice(0, 2), chips: chips.slice(0, 8) };
  })()`;
}

/** The agent-preset chip (mode selector) in the composer. */
function presetChipReader() {
  return `(() => {
    const chip = Array.from(document.querySelectorAll('button')).find((el) => {
      const t = ((el.getAttribute('aria-label') || '') + (el.textContent || '')).trim();
      return /模式/.test(t) && !/權限/.test(t);
    });
    return chip ? { label: (chip.textContent || '').trim(), disabled: !!chip.disabled } : null;
  })()`;
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        window.__stProbe = [];
        const original = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url ? input.url : '');
          if (url.indexOf('/scene/') !== -1) window.__stProbe.push({ url });
          return original.apply(this, arguments);
        };
      })();`,
    });
    await cdp.send('Page.navigate', { url: GUI });

    let panel = false;
    for (let i = 0; i < 100; i += 1) {
      await sleep(400);
      try {
        const n = await cdp.eval('document.querySelectorAll("[data-st-scroll]").length');
        if (n && n > 0) { panel = true; break; }
      } catch (_) { /* still loading */ }
    }
    console.log('scene panel mounted: ' + panel);
    await sleep(2500);   // let the scene-list effects settle

    console.log('');
    console.log('=== scene/list calls at boot ===');
    const boot = await sceneCalls(cdp);
    for (const url of boot) console.log('  ' + url);
    console.log('  calls: ' + boot.length + ', carrying &preset=: ' + boot.filter((u) => /[?&]preset=/.test(u)).length);

    const dom = await cdp.eval(panelReader());
    const chip = await cdp.eval(presetChipReader());
    console.log('');
    console.log('=== DOM ===');
    console.log('  list tooltip  : ' + JSON.stringify(dom.tooltip));
    console.log('  scenario chips: ' + JSON.stringify(dom.chips));
    console.log('  preset chip   : ' + JSON.stringify(chip));

    // ---- switch the preset and watch the list re-fetch ----
    await cdp.eval(`(() => {
      const el = Array.from(document.querySelectorAll('button')).find((b) => {
        const t = ((b.getAttribute('aria-label') || '') + (b.textContent || '')).trim();
        return /模式/.test(t) && !/權限/.test(t);
      });
      if (el) el.click();
      return !!el;
    })()`);
    await sleep(1200);
    const menu = await cdp.eval(`(() => Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
      .map((el) => (el.textContent || '').trim()).filter((t) => t.length > 0).slice(0, 12))()`);
    console.log('');
    console.log('=== agent-preset roster (throwaway browser) ===');
    console.log('  ' + JSON.stringify(menu));

    const before = (await sceneCalls(cdp)).length;
    const target = chip && /標準模式/.test(chip.label) ? '办公模式' : '標準模式';
    const picked = await cdp.eval(`(() => {
      const want = ${JSON.stringify(target)};
      const hit = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
        .find((el) => (el.textContent || '').indexOf(want) !== -1);
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    console.log('  switching ' + (chip ? chip.label : '?') + ' -> ' + target + ': ' + picked);
    await sleep(6000);

    const after = await sceneCalls(cdp);
    const fresh = after.slice(before);
    console.log('');
    console.log('=== scene/list calls after the switch ===');
    for (const url of fresh) console.log('  ' + url);
    console.log('  new calls: ' + fresh.length + ' (0 means the list did NOT re-fetch)');
    console.log('  tooltip now: ' + JSON.stringify((await cdp.eval(panelReader())).tooltip));

    // Leave the throwaway browser on the preset it booted with.
    if (chip !== null) {
      await cdp.eval(`(() => {
        const el = Array.from(document.querySelectorAll('button')).find((b) => {
          const t = ((b.getAttribute('aria-label') || '') + (b.textContent || '')).trim();
          return /模式/.test(t) && !/權限/.test(t);
        });
        if (el) el.click();
        return !!el;
      })()`);
      await sleep(800);
      const restored = await cdp.eval(`(() => {
        const want = ${JSON.stringify(chip.label)};
        const hit = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'))
          .find((el) => (el.textContent || '').indexOf(want) !== -1);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(1500);
      console.log('  restored ' + chip.label + ': ' + restored);
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
