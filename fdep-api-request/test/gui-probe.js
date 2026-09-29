'use strict';

// Drives a headless browser over the Chrome DevTools Protocol against the
// RUNNING GUI, and reports what the DOM actually contains. Read-only: it
// navigates, queries, clicks the panel entry, and screenshots.
//
//   node test/gui-probe.js
//
// Why: the agent cannot view images, and the whole test suite renders the
// component with a FAKE React. A failure that only appears under real React
// would be invisible to every other check — so this inspects the genuine
// article instead.
//
// This is a SEPARATE headless instance, not the user's browser. It is a
// pre-check, not a substitute for looking at the real window.

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
const PORT = 9333;
const OUT_DIR = __dirname;

let WebSocket = null;
for (const p of WS_PATHS) { if (fs.existsSync(p)) { try { WebSocket = require(p); break; } catch (_) {} } }
if (!WebSocket) { console.error('ws not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- CDP client
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
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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

// ------------------------------------------------------------------- main
async function main() {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  if (!browser) { console.error('no Chrome/Edge found'); process.exit(2); }

  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gui-probe-'));
  console.log('browser : ' + browser);
  console.log('gui     : ' + GUI);
  console.log('profile : ' + profileDir);
  console.log('');

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*',
    '--user-data-dir=' + profileDir,
    '--window-size=1400,1000',
    'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  try {
    // Wait for the debugging endpoint.
    let targets = null;
    for (let i = 0; i < 60; i += 1) {
      try { targets = await httpJson('http://127.0.0.1:' + PORT + '/json/list'); break; } catch (_) { await sleep(250); }
    }
    if (!targets) throw new Error('devtools endpoint never came up');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');

    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const cdp = new Cdp(ws);

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: GUI });

    // Wait for the client plugin tree to come up: the sidebar must have panel
    // buttons before anything we care about exists.
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      await sleep(250);
      try {
        const n = await cdp.eval('document.querySelectorAll("button").length');
        if (n && n > 3) { ready = true; break; }
      } catch (_) { /* page still loading */ }
    }
    console.log('app booted: ' + ready + '  (buttons present)');
    await sleep(1200);

    // ---- 1. what does the sidebar offer? ----
    const sidebar = await cdp.eval(`(() => {
      const out = [];
      document.querySelectorAll('button, [role="button"], a').forEach((el) => {
        const t = (el.textContent || '').trim();
        const aria = el.getAttribute('aria-label') || '';
        const title = el.getAttribute('title') || '';
        const hasSvg = !!el.querySelector('svg');
        if ((t || aria || title) && (t.length < 40)) {
          out.push({ tag: el.tagName, text: t, aria: aria, title: title, svg: hasSvg });
        }
      });
      return out;
    })()`);
    console.log('');
    console.log('=== candidate sidebar controls ===');
    const interesting = sidebar.filter((c) => /MCP|FDEP|Gateway|API/i.test(c.text + c.aria + c.title));
    if (interesting.length === 0) {
      console.log('  (no control mentions MCP/FDEP/API)');
      console.log('  all controls: ' + JSON.stringify(sidebar.slice(0, 20)));
    } else {
      for (const c of interesting) {
        console.log('  <' + c.tag + '> text=' + JSON.stringify(c.text)
          + ' aria=' + JSON.stringify(c.aria) + ' title=' + JSON.stringify(c.title)
          + ' svg=' + c.svg);
      }
    }

    // ---- 2. does the OLD name survive anywhere? ----
    const names = await cdp.eval(`(() => {
      const html = document.body.innerHTML;
      return {
        mcp: (html.match(/MCP網關/g) || []).length,
        oldLabel: (html.match(/FDEP API/g) || []).length,
        oldTitle: (html.match(/FDEP API Request/g) || []).length,
        hexagon: (html.match(/M13\\.63 4\\.75/g) || []).length,
        greenToken: !!getComputedStyle(document.documentElement)
          .getPropertyValue('--dsw-alias-state-success-primary'),
      };
    })()`);
    console.log('');
    console.log('=== name occurrences in the live DOM ===');
    console.log('  "MCP網關"       : ' + names.mcp);
    console.log('  "FDEP API"          : ' + names.oldLabel + (names.oldLabel ? '   <-- OLD NAME PRESENT' : ''));
    console.log('  "FDEP API Request"  : ' + names.oldTitle + (names.oldTitle ? '   <-- OLD TITLE PRESENT' : ''));
    console.log('  hexagon path        : ' + names.hexagon);

    // ---- 3. open the panel and read it ----
    const clicked = await cdp.eval(`(() => {
      const all = Array.from(document.querySelectorAll('button, [role="button"]'));
      const hit = all.find((el) => /MCP網關|FDEP API/i.test(
        (el.textContent || '') + (el.getAttribute('aria-label') || '') + (el.getAttribute('title') || '')));
      if (!hit) return { clicked: false };
      hit.click();
      return { clicked: true, label: (hit.getAttribute('aria-label') || hit.textContent || '').trim() };
    })()`);
    console.log('');
    console.log('=== click the panel entry ===');
    console.log('  ' + JSON.stringify(clicked));

    if (clicked.clicked) {
      await sleep(1500);
      const panel = await cdp.eval(`(() => {
        const h2s = Array.from(document.querySelectorAll('h2')).map((h) => h.textContent.trim());
        const panelRoot = document.querySelector('.fdep');
        const oldPanelRoot = document.querySelector('.fdep-panel');
        const classes = panelRoot
          ? Array.from(new Set(Array.from(panelRoot.querySelectorAll('*'))
              .map((e) => e.className).filter((c) => typeof c === 'string')
              .flatMap((c) => c.split(/\\s+/)).filter((c) => c.startsWith('fdep'))))
          : [];
        const glyph = document.querySelector('.fdep-glyph');
        return {
          h2s: h2s,
          hasNewRoot: !!panelRoot,
          hasOldRoot: !!oldPanelRoot,
          classes: classes.slice(0, 40),
          glyphColor: glyph ? getComputedStyle(glyph).color : null,
          glyphShapes: glyph ? Array.from(glyph.querySelectorAll('path,circle')).length : 0,
          bodyChars: document.body.innerText.length,
        };
      })()`);
      console.log('');
      console.log('=== main panel DOM ===');
      console.log('  .fdep present (new root) : ' + panel.hasNewRoot);
      console.log('  .fdep-panel present (OLD): ' + panel.hasOldRoot + (panel.hasOldRoot ? '   <-- OLD CLASSES' : ''));
      console.log('  h2 headings              : ' + JSON.stringify(panel.h2s));
      console.log('  fdep classes             : ' + JSON.stringify(panel.classes));
      console.log('  glyph colour             : ' + panel.glyphColor);
      console.log('  glyph shapes             : ' + panel.glyphShapes);
    }

    // ---- 4. theme token diagnostics ----
    const tokens = await cdp.eval(`(() => {
      const root = document.documentElement;
      const body = document.body;
      const cs = getComputedStyle(root);
      const names = ['--dsw-alias-state-success-primary','--dsw-alias-state-warn-primary',
        '--dsw-alias-state-error-primary','--dsw-alias-label-primary','--dsw-alias-brand-primary',
        '--dsw-alias-bg-base','--dsw-alias-border-l1'];
      const onRoot = {};
      for (const n of names) onRoot[n] = cs.getPropertyValue(n);
      // Where is the success token actually defined, if anywhere?
      let definedAt = [];
      const walk = (el, depth) => {
        if (depth > 6) return;
        const v = getComputedStyle(el).getPropertyValue('--dsw-alias-state-success-primary');
        if (v && v.trim()) definedAt.push(el.tagName + '.' + (el.className || '').toString().slice(0, 30) + ' => ' + v.trim());
        Array.from(el.children).forEach((c) => walk(c, depth + 1));
      };
      walk(body, 0);
      const glyph = document.querySelector('.fdep-glyph');
      const svg = glyph ? glyph.querySelector('svg') : null;
      return {
        onRoot: onRoot,
        definedAt: definedAt.slice(0, 6),
        glyphColor: glyph ? getComputedStyle(glyph).color : null,
        glyphOpacity: glyph ? getComputedStyle(glyph).opacity : null,
        svgStroke: svg ? getComputedStyle(svg).stroke : null,
        // Every stylesheet on the page, so a missing insertion is visible.
        styles: Array.from(document.querySelectorAll('style')).map((s) => ({
          bytes: s.textContent.length,
          hasGlyphRule: s.textContent.indexOf('.fdep-glyph') !== -1,
          hasNewPanelRule: s.textContent.indexOf('.fdep__card') !== -1,
          hasOldPanelRule: s.textContent.indexOf('.fdep-panel') !== -1,
          dataPlugin: s.getAttribute('data-plugin'),
          head: s.textContent.slice(0, 60).replace(/\\s+/g, ' '),
        })),
        darkMarker: !!document.querySelector('[data-ds-dark-theme], body[data-ds-dark-theme]')
          || document.body.hasAttribute('data-ds-dark-theme'),
      };
    })()`);
    console.log('');
    console.log('=== theme token diagnostics ===');
    for (const [k, v] of Object.entries(tokens.onRoot)) {
      console.log('  ' + k.padEnd(36) + ' = ' + JSON.stringify(v));
    }
    console.log('  dark theme marker active : ' + tokens.darkMarker);
    console.log('');
    console.log('  where the success token is defined: ' + (tokens.definedAt.length ? '' : '(NOWHERE)'));
    tokens.definedAt.forEach((d) => console.log('    ' + d));
    console.log('');
    console.log('  glyph colour  : ' + tokens.glyphColor);
    console.log('  glyph opacity : ' + tokens.glyphOpacity);
    console.log('  svg stroke    : ' + tokens.svgStroke);
    console.log('');
    console.log('  our stylesheets:');
    tokens.styles.forEach((s) => console.log('    ' + JSON.stringify(s)));

    // ---- 4b. optional: exercise the api-id history dropdown ----
    // Opt-in because it clicks 取得文件, i.e. one real docs request to FDEP.
    //   DSH_PROBE_HISTORY=1 node test/gui-probe.js
    if (process.env.DSH_PROBE_HISTORY === '1') {
      const clickedFetch = await cdp.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').trim().indexOf('取得文件') !== -1);
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      await sleep(3000);   // a real endpoint round trip
      // 加入 pushes the fetched api into the right-hand list.
      const added = await cdp.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').trim().indexOf('加入') !== -1);
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`);
      await sleep(300);
      const listIds = await cdp.eval(`(() => Array.from(document.querySelectorAll('.fdep__listId'))
        .map((el) => el.textContent.trim()))()`);
      const openedMenu = await cdp.eval(`(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent || '').trim().indexOf('歷史') !== -1);
        if (!btn || btn.disabled) return false;
        btn.click();
        return true;
      })()`);
      await sleep(400);
      const historyOptions = await cdp.eval(`(() => Array.from(document.querySelectorAll('.fdep__menuItem'))
        .map((b) => b.textContent.trim()))()`);
      console.log('');
      console.log('=== api-id history + collected set (DSH_PROBE_HISTORY=1) ===');
      console.log('  取得文件 clicked : ' + clickedFetch);
      console.log('  加入 clicked     : ' + added);
      console.log('  list ids         : ' + JSON.stringify(listIds));
      console.log('  歷史 menu opened : ' + openedMenu);
      console.log('  stored options   : ' + JSON.stringify(historyOptions));
      console.log('  localStorage     : ' + await cdp.eval(`(() => {
        try { return localStorage.getItem('fdep-api-request/api-ids'); } catch (e) { return 'n/a'; }
      })()`));
      console.log('  status strip     : ' + JSON.stringify(await cdp.eval(`(() => {
        const el = document.querySelector('.fdep__status');
        return el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) : null;
      })()`)));
    }

    // ---- 5. screenshot for the record ----
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const out = path.join(OUT_DIR, '_gui-live.png');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('');
    console.log('screenshot: ' + out + '  (' + fs.statSync(out).size + ' bytes)');
    console.log('(this is the headless instance, not the user\'s window)');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
    await sleep(400);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => { console.error('PROBE FAILED:', err.message); process.exitCode = 1; });
