'use strict';
// Sweep the Settings sub-pages (the largest text surface in the GUI) for text the
// zhtw bundle would still convert, split into Simplified-only characters vs
// zh-TW phrasing preferences.
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
const PORT = 9371;

const TABLES = 'C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/zhtw-traditional-chinese/lib/client.js';
const tbl = fs.readFileSync(TABLES, 'utf8');
const phrases = JSON.parse(tbl.match(/var S2T_PHRASES = (\[[\s\S]*?\n {4}\]);/)[1]);
const chars = JSON.parse(tbl.match(/var S2T_CHARS = (\{[\s\S]*?\n {4}\});/)[1]);
const ST = 'C:/Users/shawoo/AppData/Local/Temp/zhtw-opencc/STCharacters.txt';
const simplifiedOnly = new Set();
for (const line of fs.readFileSync(ST, 'utf8').split('\n')) {
  if (line === '' || line[0] === '#') continue;
  const tab = line.indexOf('\t');
  if (tab > 0 && line.slice(0, tab).trim().length === 1) simplifiedOnly.add(line.slice(0, tab).trim());
}
const phraseFirst = new Map();
for (const pair of phrases.slice().sort((a, b) => b[0].length - a[0].length)) {
  const first = pair[0].charAt(0);
  if (!phraseFirst.has(first)) phraseFirst.set(first, []);
  phraseFirst.get(first).push(pair);
}
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

const SWEEP = `(() => {
  const out = []; const seen = new Set();
  const consider = (text) => {
    if (!text) return;
    const t = String(text).trim();
    if (t.length === 0 || t.length > 400) return;
    if (seen.has(t)) return;
    seen.add(t); out.push(t);
  };
  const walk = (node) => {
    if (node.nodeType === 3) { consider(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') return;
    for (const attr of ['aria-label', 'title', 'placeholder']) if (node.getAttribute) consider(node.getAttribute(attr));
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
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhtw-settings-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1500,1100', 'about:blank'], { stdio: 'ignore' });
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
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      await sleep(400);
      ready = await cdp.eval("!!document.querySelector('.hHd-Xa_root')").catch(() => false);
      if (ready) break;
    }
    console.log('ready: ' + ready);
    await sleep(2000);

    // open 設定
    await cdp.eval(`(() => {
      const hit = [].slice.call(document.querySelectorAll('button, [role="button"], a'))
        .find((b) => /設定/.test((b.textContent || '') + (b.getAttribute('aria-label') || '')));
      if (hit) hit.click();
      return !!hit;
    })()`);
    await sleep(2500);

    // every nav item inside settings
    const navs = JSON.parse(await cdp.eval(`(() => {
      const out = [];
      document.querySelectorAll('button, [role="button"], a, [role="tab"]').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (t && t.length < 24) out.push(t);
      });
      return JSON.stringify([...new Set(out)]);
    })()`));
    console.log('settings nav candidates: ' + JSON.stringify(navs));

    const genuine = new Map();
    const phrasing = new Map();
    const sweep = async (label) => {
      const texts = JSON.parse(await cdp.eval(SWEEP));
      let g = 0; let p = 0;
      for (const t of texts) {
        const c = convert(t);
        if (c === t) continue;
        const charLevel = [...t].map((ch) => (chars[ch] !== undefined ? chars[ch] : ch)).join('');
        const isGenuine = charLevel !== t && [...t].some((ch) => simplifiedOnly.has(ch));
        if (isGenuine) {
          g += 1;
          if (!genuine.has(t)) { genuine.set(t, c); console.log('  [SIMPLIFIED] ' + JSON.stringify(t.slice(0, 80)) + ' -> ' + JSON.stringify(c.slice(0, 80))); }
        } else { p += 1; if (!phrasing.has(t)) phrasing.set(t, c); }
      }
      console.log('--- ' + label + ': Simplified=' + g + ' phrasing=' + p);
    };

    await sweep('設定(首頁)');
    for (const nav of navs) {
      if (/設定|返回|關閉|收起/.test(nav)) continue;
      const ok = await cdp.eval(`(() => {
        const want = ${JSON.stringify('')} + ${JSON.stringify(nav)};
        const hit = [].slice.call(document.querySelectorAll('button, [role="button"], a, [role="tab"]'))
          .find((b) => (b.textContent || '').trim() === want);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      if (!ok) continue;
      await sleep(1800);
      await sweep('設定 / ' + nav);
    }

    console.log('');
    console.log('=== 總結 (Settings) ===');
    console.log('genuine Simplified strings: ' + genuine.size);
    for (const [a, b] of genuine) console.log('  ' + JSON.stringify(a.slice(0, 70)) + ' -> ' + JSON.stringify(b.slice(0, 70)));
    console.log('zh-TW phrasing differences: ' + phrasing.size);
    for (const [a, b] of [...phrasing].slice(0, 25)) console.log('  ' + JSON.stringify(a.slice(0, 60)) + ' -> ' + JSON.stringify(b.slice(0, 60)));
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
