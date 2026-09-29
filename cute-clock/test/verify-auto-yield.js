'use strict';
// Verify the clock's auto-hide against the live GUI.
//
//   node test/verify-auto-yield.js
//
//   1. normal window   — card visible, and it must NOT overlap any blocker
//   2. forced overlap  — slide the card onto the input area; it must HIDE
//                        (faded + hidden + click-through, and NOTHING left behind)
//   3. overlap gone    — the card comes back
//   4. composer focus  — focusing the input hides the card even without overlap
//   5. blur            — the card comes back
//   6. narrow window   — the card never overlaps the input area at 760px
//
// Read-only against the user's session: it only moves its own clock card.
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
const PORT = 9379;
const SHOT = process.env.PROBE_SHOT || (process.env.TEMP + '/yield-verify.png');

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

const STATE = `(() => {
  const SEL = '.uV2eYG_input,[contenteditable="true"],textarea,[data-st-scroll],#st-top,#st-wall';
  // The plugin renders one overlay inside its slot wrapper, so the state marker
  // (not a count of .cute-clock-overlay) is the honest "how many clocks" probe.
  const mounts = document.querySelectorAll('[data-cute-clock-state]').length;
  const cards = document.querySelectorAll('.cute-clock-card').length;
  const leftovers = document.querySelectorAll('.cute-clock-hint').length;
  const card = document.querySelector('.cute-clock-card');
  if (!card) return JSON.stringify({ mounts: mounts, cards: cards, leftovers: leftovers, card: false });
  // Client rects so a parent transform is reflected — the probe moves the overlay
  // itself, so the card's own box would lie.
  const rects = [].slice.call(card.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  const r = rects.length ? {
    left: Math.min.apply(null, rects.map((x) => x.left)),
    top: Math.min.apply(null, rects.map((x) => x.top)),
    right: Math.max.apply(null, rects.map((x) => x.right)),
    bottom: Math.max.apply(null, rects.map((x) => x.bottom)),
  } : { left: 0, top: 0, right: 0, bottom: 0 };
  const cs = getComputedStyle(card);
  const blockers = [].slice.call(document.querySelectorAll(SEL)).map((el) => el.getBoundingClientRect())
    .filter((b) => b.width > 0 || b.height > 0);
  const pad = 8;
  const overlap = blockers.some((b) => !(r.right + pad <= b.left || b.right + pad <= r.left || r.bottom + pad <= b.top || b.bottom + pad <= r.top));
  const ov = document.querySelector('[data-cute-clock-state]');
  return JSON.stringify({
    mounts: mounts,
    cards: cards,
    leftovers: leftovers,
    card: [Math.round(r.left), Math.round(r.top), Math.round(r.right - r.left), Math.round(r.bottom - r.top)],
    overlap: overlap,
    opacity: cs.opacity,
    visibility: cs.visibility,
    clickThrough: cs.pointerEvents === 'none',
    focused: (() => { const a = document.activeElement; return !!(a && a.closest && a.closest('[contenteditable="true"],textarea,.uV2eYG_input')); })(),
    pluginState: ov ? ov.getAttribute('data-cute-clock-state') : null,
  });
})()`;

/** Park the overlay ON the input area. Positions the element itself (no transform),
 *  so the card's own box — the one the plugin measures — really overlaps. */
const NUDGE = (left, top) => `(() => {
  let s = document.getElementById('yield-probe-nudge');
  if (!s) { s = document.createElement('style'); s.id = 'yield-probe-nudge'; document.head.appendChild(s); }
  s.textContent = '.cute-clock-overlay{left:' + ${JSON.stringify(String(left))} + 'px!important;top:' + ${JSON.stringify(String(top))} + 'px!important;right:auto!important;bottom:auto!important}';
  return true;
})()`;

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yield-verify-'));
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
    for (let i = 0; i < 100; i += 1) {
      await sleep(400);
      if (await cdp.eval("!!document.querySelector('.cute-clock-card') && !!document.querySelector('.hHd-Xa_root')").catch(() => false)) break;
    }
    await sleep(3000);

    const step = async (label, expect, settleMs) => {
      // Read a few times and keep the last sample: the card fades for 250ms and the
      // plugin samples every 300ms, so a single early read can catch it mid-flight.
      const wait = settleMs === undefined ? 1200 : settleMs;
      let state = null;
      const deadline = Date.now() + wait;
      do {
        state = JSON.parse(await cdp.eval(STATE));
        await sleep(250);
      } while (Date.now() < deadline);
      const ok = expect(state);
      console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  →  ' + JSON.stringify(state));
      return ok;
    };

    let allOk = true;
    // The composer sometimes takes focus on its own during boot, and a focused
    // composer legitimately hides the card — so blur before the baseline step.
    await cdp.eval("(() => { const e = document.querySelector('.uV2eYG_input,[contenteditable=\"true\"],textarea'); if (e && e.blur) e.blur(); return true; })()");
    await sleep(1500);
    allOk = await step('1. normal window: one clock, card visible, no overlap', (s) => s.mounts === 1 && s.cards === 1 && !s.overlap && s.opacity === '1') && allOk;

    // 2. overlap: park the card directly on the editor's box.
    const target = await cdp.eval(`(() => {
      const ed = document.querySelector('.uV2eYG_input,[contenteditable="true"],textarea');
      const card = document.querySelector('.cute-clock-card');
      if (!ed || !card) return null;
      const e = ed.getBoundingClientRect(), c = card.getBoundingClientRect();
      return [Math.round(e.left + (e.width - c.width) / 2), Math.round(e.top + (e.height - c.height) / 2)];
    })()`);
    await cdp.eval(NUDGE(target[0], target[1]));
    await sleep(2200);
    allOk = await step('2. forced overlap: card HIDES, nothing left behind', (s) =>
      s.mounts === 1 && s.overlap && s.opacity === '0' && s.visibility === 'hidden' && s.clickThrough && s.leftovers === 0 && s.pluginState === 'hidden') && allOk;

    const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot1.data, 'base64'));

    // 3. overlap removed → card returns
    await cdp.eval("(() => { const s = document.getElementById('yield-probe-nudge'); if (s) s.remove(); const e = document.querySelector('.uV2eYG_input,[contenteditable=\"true\"],textarea'); if (e && e.blur) e.blur(); return true; })()");
    await sleep(2000);
    allOk = await step('3. overlap gone: card is back', (s) => !s.overlap && s.opacity === '1' && s.pluginState === 'shown') && allOk;

    // 4. focus
    await cdp.eval("(() => { const e = document.querySelector('.uV2eYG_input,[contenteditable=\"true\"],textarea'); if (e) e.focus(); return !!e; })()");
    await sleep(1800);
    allOk = await step('4. composer focus: card hides while typing', (s) => s.focused && s.opacity === '0' && s.visibility === 'hidden' && s.leftovers === 0) && allOk;

    // 5. blur
    await cdp.eval("(() => { const e = document.querySelector('.uV2eYG_input,[contenteditable=\"true\"],textarea'); if (e && e.blur) e.blur(); return true; })()");
    await sleep(1500);
    allOk = await step('5. blur: card comes back', (s) => !s.focused && s.opacity === '1') && allOk;

    // 6. narrow window
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(2200);
    allOk = await step('6. narrow window (760px): card never overlaps the input area', (s) => !s.overlap || s.opacity === '0') && allOk;
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    console.log('');
    console.log('screenshot (card hidden over the composer): ' + SHOT);
    console.log(allOk ? 'ALL AUTO-HIDE CHECKS PASSED' : 'SOME CHECKS FAILED');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
