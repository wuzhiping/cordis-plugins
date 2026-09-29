'use strict';
// Broad Simplified sweep: open each named surface in turn and report only text the
// bundle's own S2T table would still change, split into "genuine Simplified" (the
// character is Simplified-only) and "zh-TW phrasing" (already Traditional, but the
// table's phrase list prefers another word — e.g. 文件 → 檔案).
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
const PORT = 9369;

const TABLES = 'C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/zhtw-traditional-chinese/lib/client.js';
const tbl = fs.readFileSync(TABLES, 'utf8');
const phrases = JSON.parse(tbl.match(/var S2T_PHRASES = (\[[\s\S]*?\n {4}\]);/)[1]);
const chars = JSON.parse(tbl.match(/var S2T_CHARS = (\{[\s\S]*?\n {4}\});/)[1]);
// Simplified-only characters: STCharacters.txt lists them (the source side).
const ST = 'C:/Users/shawoo/AppData/Local/Temp/zhtw-opencc/STCharacters.txt';
const simplifiedOnly = new Set();
if (fs.existsSync(ST)) {
  for (const line of fs.readFileSync(ST, 'utf8').split('\n')) {
    if (line === '' || line[0] === '#') continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const key = line.slice(0, tab).trim();
    if (key.length === 1) simplifiedOnly.add(key);
  }
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
function classify(text) {
  const converted = convert(text);
  if (converted === text) return null;
  // Does any character differ by the single-character map (⇒ a Simplified glyph)?
  const charLevel = [...text].map((c) => (chars[c] !== undefined ? chars[c] : c)).join('');
  const genuine = [...text].some((c) => simplifiedOnly.has(c))
    && charLevel !== text;
  return { converted, genuine };
}

const SWEEP = `(() => {
  const out = [];
  const seen = new Set();
  const consider = (where, text) => {
    if (!text) return;
    const t = String(text).trim();
    if (t.length === 0 || t.length > 300) return;
    const key = t;
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

const VIEWS = (process.env.PROBE_VIEWS || '元氣時鐘,外掛,MCP網關,今日重訊,設定,工作區').split(',').map((s) => s.trim()).filter(Boolean);

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhtw-broad-'));
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
    let ready = false;
    for (let i = 0; i < 100; i += 1) {
      await sleep(400);
      ready = await cdp.eval("!!document.querySelector('.hHd-Xa_root') && document.querySelectorAll('button').length > 8").catch(() => false);
      if (ready) break;
    }
    console.log('sidebar ready: ' + ready + '  (STCharacters entries: ' + simplifiedOnly.size + ')');
    await sleep(2500);

    const genuineTotal = new Map();
    const phrasingTotal = new Map();

    const sweep = async (label) => {
      const raw = JSON.parse(await cdp.eval(SWEEP));
      let genuine = 0;
      let phrasing = 0;
      for (const item of raw) {
        const hit = classify(item.text);
        if (hit === null) continue;
        if (hit.genuine) {
          genuine += 1;
          genuineTotal.set(item.text, hit.converted);
          console.log('  [SIMPLIFIED] ' + JSON.stringify(item.text.slice(0, 70)) + '  ->  ' + JSON.stringify(hit.converted.slice(0, 70)));
        } else {
          phrasing += 1;
          phrasingTotal.set(item.text, hit.converted);
        }
      }
      console.log('=== ' + label + ': Simplified=' + genuine + '  zh-TW phrasing=' + phrasing + ' ===');
    };

    await sweep('主畫面(會話)');
    for (const view of VIEWS) {
      const ok = await cdp.eval(`(() => {
        const want = ${JSON.stringify('')} + ${JSON.stringify(VIEWS[0])};
        const hit = [].slice.call(document.querySelectorAll('button, [role="button"]'))
          .find((b) => ((b.textContent || '') + (b.getAttribute('aria-label') || '') + (b.getAttribute('title') || '')).indexOf(${JSON.stringify(view)}) !== -1);
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
      await sleep(2400);
      console.log('');
      console.log('--- ' + view + ' (clicked: ' + ok + ') ---');
      await sweep(view);
    }

    console.log('');
    console.log('=== 總結 ===');
    console.log('genuine Simplified strings: ' + genuineTotal.size);
    if (genuineTotal.size) for (const [now, would] of genuineTotal) console.log('  ' + JSON.stringify(now) + ' -> ' + JSON.stringify(would));
    console.log('zh-TW phrasing differences (still valid Traditional): ' + phrasingTotal.size);
    for (const [now, would] of [...phrasingTotal].slice(0, 20)) console.log('  ' + JSON.stringify(now.slice(0, 50)) + ' -> ' + JSON.stringify(would.slice(0, 50)));
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
