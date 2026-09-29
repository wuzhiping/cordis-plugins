'use strict';
// Two live checks against the running GUI, both read-only:
//   1. the MCP網關 rename (sidebar label + panel heading, and no "MCP Gateway" left)
//   2. a Simplified-character sweep of what is ACTUALLY rendered, using the
//      zhtw bundle's own S2T table as the oracle: a character is only reported when
//      the shipped conversion would change it.
//
//   node test/verify-mcp-and-simplified.js [--click <label>]...
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
const PORT = 9367;
const SHOT = process.env.PROBE_SHOT || (process.env.TEMP + '/zhtw-sweep.png');

// The oracle: the exact character map + phrases the bundle converts with.
const TABLES = 'C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/zhtw-traditional-chinese/lib/client.js';
const tbl = fs.readFileSync(TABLES, 'utf8');
const phrases = JSON.parse(tbl.match(/var S2T_PHRASES = (\[[\s\S]*?\n {4}\]);/)[1]);
const chars = JSON.parse(tbl.match(/var S2T_CHARS = (\{[\s\S]*?\n {4}\});/)[1]);
const phraseFirst = new Map();
for (const pair of phrases.slice().sort((a, b) => b[0].length - a[0].length)) {
  const first = pair[0].charAt(0);
  if (!phraseFirst.has(first)) phraseFirst.set(first, []);
  phraseFirst.get(first).push(pair);
}
/** Exactly what the bundle would render for this text. */
function convert(text) {
  let out = ''; let i = 0;
  while (i < text.length) {
    const bucket = phraseFirst.get(text.charAt(i));
    let hit = null;
    if (bucket) for (const p of bucket) if (text.substr(i, p[0].length) === p[0]) { hit = p; break; }
    if (hit) { out += hit[1]; i += hit[0].length; continue; }
    const ch = text.charAt(i);
    out += chars[ch] !== undefined ? chars[ch] : ch;
    i += 1;
  }
  return out;
}
/** Every node/attribute whose text the bundle would still change. */
const SWEEP = `(() => {
  const out = [];
  const seen = new Set();
  const consider = (where, text) => {
    if (!text) return;
    const t = text.trim();
    if (t.length === 0 || t.length > 200) return;
    const key = where + '|' + t;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ where, text: t });
  };
  const walk = (node) => {
    if (node.nodeType === 3) { consider('text', node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      if (node.getAttribute) consider(attr, node.getAttribute(attr));
    }
    node.childNodes.forEach(walk);
  };
  walk(document.body);
  return JSON.stringify(out);
})()`;

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

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhtw-sweep-'));
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
    // Ready = the sidebar shell is mounted, not just "some buttons exist": a slow
    // first paint otherwise yields a blank page and a meaningless empty sweep.
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      await sleep(400);
      ready = await cdp.eval("!!document.querySelector('.hHd-Xa_root') && document.querySelectorAll('button').length > 8").catch(() => false);
      if (ready) break;
    }
    console.log('sidebar ready: ' + ready);
    await sleep(3000);

    const sweep = async (label) => {
      const raw = JSON.parse(await cdp.eval(SWEEP));
      const misses = [];
      for (const item of raw) {
        const converted = convert(item.text);
        if (converted !== item.text) misses.push({ where: item.where, now: item.text, wouldBe: converted });
      }
      console.log('');
      console.log('=== ' + label + ' — strings the S2T table would still change: ' + misses.length + ' ===');
      for (const m of misses.slice(0, 15)) console.log('  [' + m.where + '] ' + JSON.stringify(m.now) + '  ->  ' + JSON.stringify(m.wouldBe));
      if (misses.length > 15) console.log('  … ' + (misses.length - 15) + ' more');
      return misses.length;
    };

    // 1. the rename
    const mcp = await cdp.eval(`(() => {
      const labels = [].slice.call(document.querySelectorAll('button, [role="button"]'))
        .map((el) => (el.textContent || '').trim())
        .filter((t) => /MCP/.test(t) && t.length < 40);
      return JSON.stringify({
        sidebar: [...new Set(labels)],
        oldLabelPresent: document.body.innerHTML.indexOf('MCP Gateway') !== -1,
      });
    })()`);
    console.log('=== MCP rename (sidebar) ===');
    console.log(mcp);

    const clicked = await cdp.eval(`(() => {
      const hit = [].slice.call(document.querySelectorAll('button, [role="button"]'))
        .find((b) => /MCP/.test((b.textContent || '') + (b.getAttribute('aria-label') || '')));
      if (!hit) return false;
      hit.click();
      return true;
    })()`);
    await sleep(2500);
    const heading = await cdp.eval("(() => { const h = document.querySelector('.fdep__title'); return h ? h.textContent.trim() : null; })()");
    console.log('panel opened: ' + clicked + ', heading: ' + JSON.stringify(heading));
    if (process.env.PROBE_SHOT) {
      const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(process.env.PROBE_SHOT, Buffer.from(shot0.data, 'base64'));
      console.log('panel screenshot: ' + process.env.PROBE_SHOT);
    }
    await sweep('主畫面 + MCP網關面板');

    for (const label of process.argv.slice(2).filter((a) => a !== '--click')) {
      const ok = await cdp.eval(`(() => {
        const hit = [].slice.call(document.querySelectorAll('button, [role="button"]'))
          .find((b) => ((b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')).indexOf(${JSON.stringify(label)}) !== -1);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(2200);
      console.log('');
      console.log('--- clicked ' + JSON.stringify(label) + ': ' + ok + ' ---');
      await sweep('view "' + label + '"');
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log('');
    console.log('screenshot: ' + SHOT);
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
