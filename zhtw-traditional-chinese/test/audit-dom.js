#!/usr/bin/env node
'use strict';
// Audit the RUNNING GUI: which rendered strings are still Simplified Chinese?
//
//   node test/audit-dom.js                  # summary + every miss
//   node test/audit-dom.js --dump out.tsv   # also write every string found
//   node test/audit-dom.js --limit 80       # cap the per-section listing
//
// Two kinds of miss are reported, because they need different fixes:
//
//   PATH MISS  the string contains a character the table already knows (a
//              Simplified character that has a mapping) — so this text never
//              travelled through the locale lookup at all (hardcoded literal,
//              or a surface that bypasses `t()`).
//   TABLE GAP  the string contains a character the table has never heard of.
//              Only a human can say whether that character is Simplified (needs
//              a mapping) or already Traditional (fine) — the output shows the
//              character with its context so the call is reviewable.
//
// Read-only: it navigates, waits for boot, reads the DOM, and exits.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { readTables, makeConverter, CJK } = require('./s2t');
const { readOpenCC, defaultOpenCCDir } = require('./opencc');

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
const PORT = Number(process.env.DSH_AUDIT_PORT || 9334);

const args = process.argv.slice(2);
const dumpAt = args.indexOf('--dump') !== -1 ? args[args.indexOf('--dump') + 1] : null;
const limitAt = args.indexOf('--limit') !== -1 ? Number(args[args.indexOf('--limit') + 1]) : 60;
const LIMIT = Number.isFinite(limitAt) && limitAt > 0 ? limitAt : 60;
// --click 設定,插件 opens surfaces that are not on the boot screen, so the audit
// can look at them too (comma separated; first visible match wins).
const clicks = args.indexOf('--click') !== -1
  ? String(args[args.indexOf('--click') + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)
  : [];
// --eval "<expression>" reads one expression out of the live page. Handy for
// things the DOM walk cannot see, e.g. the computed style of a pseudo-element.
const evalExpr = args.indexOf('--eval') !== -1 ? args[args.indexOf('--eval') + 1] : null;
// --shot <file> saves a screenshot of the state that was just read (so a CSS
// change can be looked at, which no amount of DOM reading can replace).
const shotAt = args.indexOf('--shot') !== -1 ? args[args.indexOf('--shot') + 1] : null;
// --clip x,y,w,h (+ --scale) zooms into one region — the only way to look closely at
// a 56px rail or a pseudo-element from the outside.
const clipAt = args.indexOf('--clip') !== -1
  ? String(args[args.indexOf('--clip') + 1] || '').split(',').map(Number)
  : null;
const clipScale = args.indexOf('--scale') !== -1 ? Number(args[args.indexOf('--scale') + 1]) || 4 : 4;

let WebSocket = null;
for (const p of WS_PATHS) { if (fs.existsSync(p)) { try { WebSocket = require(p); break; } catch (_) {} } }
if (!WebSocket) { console.error('ws not found (looked in ' + WS_PATHS.join(', ') + ')'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
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

const COLLECT = `(() => {
  const out = [];
  const seen = new Set();
  const push = (text, where, node) => {
    const value = String(text || '').replace(/\\s+/g, ' ').trim();
    if (value === '' || value.length > 160) return;
    if (!/[\\u4e00-\\u9fff]/.test(value)) return;
    const el = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
    let cls = '';
    if (el && el.getAttribute) cls = el.getAttribute('class') || '';
    const key = value + '\\u0000' + where + '\\u0000' + cls;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: value, where: where, tag: el ? el.tagName : '', cls: cls.slice(0, 90) });
  };
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'label', 'data-tooltip'];
  const visit = (root) => {
    const nodes = root.querySelectorAll('*');
    for (const el of nodes) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      for (const name of ATTRS) {
        const v = el.getAttribute(name);
        if (v) push(v, name, el);
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const v = el.value;
        if (v && el.type !== 'password') push(v, 'value', el);
      }
      for (const child of el.childNodes) {
        if (child.nodeType === 3) push(child.nodeValue, 'text', child);
      }
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  if (document.title) push(document.title, 'document.title', document.documentElement);
  return out;
})()`;

async function main() {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) { console.error('no Chrome/Edge found'); process.exit(2); }
  const tables = readTables();
  const convert = makeConverter(tables);
  const knownChars = new Set(Object.keys(tables.chars));

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zhtw-audit-'));
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
      try {
        const res = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        targets = await res.json();
        break;
      } catch (_) { await sleep(250); }
    }
    if (!targets) throw new Error('devtools endpoint never came up');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: GUI });

    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      try {
        const n = await cdp.eval('document.querySelectorAll("button").length');
        if (n && n > 3) { ready = true; break; }
      } catch (_) { /* still loading */ }
    }
    await sleep(1500);
    console.log('browser  : ' + browser);
    console.log('gui      : ' + GUI);
    console.log('booted   : ' + ready);
    console.log('table    : ' + tables.phrases.length + ' phrases, ' + knownChars.size + ' characters');
    console.log('');

    // Optionally open more surfaces before reading the DOM.
    for (const label of clicks) {
      const clicked = await cdp.eval(`(() => {
        const els = Array.from(document.querySelectorAll('button,[role="button"],a,[role="tab"],[role="menuitem"]'));
        const el = els.find((e) => (((e.textContent || '') + ' ' + (e.getAttribute('aria-label') || '')
          + ' ' + (e.getAttribute('title') || '')).indexOf(${JSON.stringify(label)}) !== -1));
        if (!el) return false;
        el.click();
        return true;
      })()`);
      console.log('click ' + JSON.stringify(label) + ': ' + clicked);
      await sleep(1200);
    }
    if (clicks.length) console.log('');

    if (evalExpr) {
      const value = await cdp.eval(evalExpr);
      console.log('eval ' + JSON.stringify(evalExpr.slice(0, 60)) + ' ->');
      console.log('  ' + (typeof value === 'string' ? value : JSON.stringify(value)));
      console.log('');
    }

    if (shotAt) {
      const shotParams = { format: 'png' };
      if (clipAt && clipAt.length === 4) {
        shotParams.clip = { x: clipAt[0], y: clipAt[1], width: clipAt[2], height: clipAt[3], scale: clipScale };
      }
      const shot = await cdp.send('Page.captureScreenshot', shotParams);
      fs.writeFileSync(shotAt, Buffer.from(shot.data, 'base64'));
      console.log('screenshot: ' + shotAt + '  (' + fs.statSync(shotAt).size + ' bytes)');
      console.log('');
    }

    const items = await cdp.eval(COLLECT);
    const strings = new Set();
    const pathMisses = new Map();   // string -> {where, cls}
    const gaps = new Map();         // char -> {count, example}
    for (const item of items) {
      strings.add(item.text);
      const chars = [];
      for (const ch of item.text) {
        if (!CJK.test(ch)) continue;
        if (knownChars.has(ch)) chars.push(ch);
        else {
          const entry = gaps.get(ch) || { count: 0, example: item.text, where: item.where };
          entry.count += 1;
          gaps.set(ch, entry);
        }
      }
      if (chars.length) pathMisses.set(item.text, item);
    }

    console.log('rendered strings with CJK : ' + strings.size + '  (nodes: ' + items.length + ')');
    console.log('PATH MISSES (table knows the char) : ' + pathMisses.size);
    console.log('TABLE GAPS  (char unknown)        : ' + gaps.size + ' distinct characters');
    console.log('');

    const missRows = Array.from(pathMisses.values())
      .sort((a, b) => a.text.localeCompare(b.text));
    console.log('=== PATH MISSES — these never went through the conversion ===');
    if (missRows.length === 0) console.log('  (none)');
    for (const row of missRows.slice(0, LIMIT)) {
      console.log('  [' + row.where + '] ' + JSON.stringify(row.text));
      if (row.text !== convert(row.text)) console.log('        would become: ' + JSON.stringify(convert(row.text)));
      if (row.cls) console.log('        <' + row.tag + ' class="' + row.cls + '">');
    }
    if (missRows.length > LIMIT) console.log('  … ' + (missRows.length - LIMIT) + ' more');
    console.log('');

    const gapRows = Array.from(gaps.entries())
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    // Split the unknown characters the way a reviewer would: ones OpenCC itself
    // would convert are leftovers (bugs); the rest are already Traditional.
    const openccDir = args.opencc || defaultOpenCCDir();
    let leftovers = [];
    if (fs.existsSync(path.join(openccDir, 'STCharacters.txt'))) {
      const stChars = readOpenCC(path.join(openccDir, 'STCharacters.txt'));
      const twVariants = readOpenCC(path.join(openccDir, 'TWVariants.txt'));
      leftovers = gapRows.filter(([ch]) => {
        const st = stChars.get(ch);
        return st !== undefined && (twVariants.get(st) || st) !== ch;
      });
    }
    console.log('=== STILL SIMPLIFIED on screen (OpenCC would convert these) ===');
    if (leftovers.length === 0) console.log('  (none)');
    for (const [ch, info] of leftovers) {
      console.log('  ' + ch + ' (' + info.count + ')  [' + info.where + ']  …' + info.example.slice(0, 60) + '…');
    }
    console.log('');

    console.log('=== already Traditional on screen (' + gapRows.length + ' distinct characters) ===');
    for (const [ch, info] of gapRows.slice(0, LIMIT)) {
      console.log('  ' + ch + ' (' + info.count + ')  [' + info.where + ']  …'
        + info.example.slice(0, 60) + '…');
    }
    if (gapRows.length > LIMIT) console.log('  … ' + (gapRows.length - LIMIT) + ' more');
    console.log('');

    if (dumpAt) {
      const lines = ['#\twhere\ttag\tclass\ttext'];
      for (const item of items) {
        lines.push(['', item.where, item.tag, item.cls, item.text].join('\t'));
      }
      fs.writeFileSync(dumpAt, lines.join('\n') + '\n', 'utf8');
      console.log('dumped ' + items.length + ' strings to ' + dumpAt);
    }
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error('AUDIT FAILED: ' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
