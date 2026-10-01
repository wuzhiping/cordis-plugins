#!/usr/bin/env node
/**
 * ntfy-teams browser end-to-end verification harness (task-4).
 *
 * Zero dependencies: launches the installed Chrome in --headless=new with
 * --remote-debugging-port, then speaks the Chrome DevTools Protocol over the
 * built-in Node 24 global WebSocket.
 *
 * Modes:
 *   probe   : boot the GUI and report sidebar text / localStorage / theme controls + shot
 *   theme   : inspect and exercise the light/dark toggle path
 *   full    : task-4 acceptance (panel select, live publish assert, light/live/dark, history)
 *   eval    : one-off Runtime.evaluate against a running/reused browser (debug helper)
 *
 * Never pass --virtual-time-budget: this SPA holds open streams and it hangs.
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHROME = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
const GUI_URL = 'http://127.0.0.1:3080/';
const OUT_DIR = __dirname;
const PANEL_LABEL = '團隊協同';        // task-6 redesign: Traditional Chinese (was 团队协同)
const LEGACY_LABELS = ['团队协同'];      // kept so the harness still works against the old build
const PANEL_ID = 'ntfy-teams';
const TOPIC = 'pub_demo';
const NTFY_BASE = 'https://msn.feg.cn';
// exact controls of the redesigned panel (lib/client.js)
const ADD_LABEL = '+ 訂閱主題';
const ADD_TITLE = '訂閱新的主題';
const TOPIC_INPUT_PH = 'topic 名称，例如 pub_demo';   // still Simplified in the source
// 摘要的編輯入口是**圖示按鈕**（鉛筆，沒有文字），所以只能用 aria-label 找它。
// 舊的「編輯」文字按鈕、以及抬頭那顆「共用設定」圖示按鈕都已移除。
const EDIT_ARIA = '編輯共用設定';
// 表單裡的「收合」按鈕已移除（需求）—— 收起改用抬頭那顆鉛筆切換。
const IDENTITY_PH = '例如 shawoo';
const SEND_LABEL = '傳送';
const SAVE_LABEL = '儲存';
const FALLBACK_MARKERS = ['核心模組未載入', '核心模块未加载'];
const MD = { BODY_FILE: path.join(__dirname, '_verify-md-body.txt'), SEC_FILE: path.join(__dirname, '_verify-sec-body.txt') };

// ---------------------------------------------------------------- utilities
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function log(...a) { console.log('[verify]', ...a); }
function logStep(...a) { console.log('\n=== ', ...a, '==='); }

// ---------------------------------------------------------------- CDP client
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); }
      catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`CDP ${msg.error.code} ${msg.error.message}`));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        this.events.push(msg);
        for (const fn of this.listeners) { try { fn(msg); } catch { /* ignore */ } }
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 45000);
    });
  }

  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// ---------------------------------------------------------------- browser
/** best-effort sweep of stale profiles from earlier crashed runs (disk is tight on this host) */
function sweepStaleProfiles() {
  try {
    const dirs = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ntfy-verify-'));
    let freed = 0;
    for (const n of dirs) {
      const p = path.join(os.tmpdir(), n);
      try {
        const st = fs.statSync(p);
        if (Date.now() - st.mtimeMs < 2 * 60 * 1000) continue; // recent: may belong to a live run
        fs.rmSync(p, { recursive: true, force: true });
        freed++;
      } catch { /* locked */ }
    }
    if (freed) log(`swept ${freed} stale temp profile(s)`);
  } catch { /* ignore */ }
}

async function launchChrome(opts = {}) {
  sweepStaleProfiles();
  const port = opts.port || (9300 + Math.floor(Math.random() * 400));
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-verify-'));
  const args = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-background-networking',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1400,900',
    '--hide-scrollbars',
    'about:blank',
  ];
  log(`launching chrome port=${port} user-data-dir=${userDataDir}`);
  const proc = spawn(CHROME, args, { stdio: 'ignore', detached: false });
  proc.on('exit', (code) => log(`chrome exited code=${code}`));

  // wait for the DevTools HTTP endpoint
  let version = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not up yet */ }
  }
  if (!version) throw new Error(`chrome DevTools endpoint never came up on port ${port}`);
  log('chrome:', version['Browser'], '|', version['User-Agent'].slice(0, 60));

  // pick a page target
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('no page target available');
  log('target:', target.id, target.url);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', (e) => reject(new Error('ws error: ' + (e.message || 'unknown'))), { once: true });
  });
  const cdp = new CDP(ws);
  cdp.port = port;
  cdp.target = target;
  cdp.userDataDir = userDataDir;
  cdp.proc = proc;
  return cdp;
}

async function setup(cdp) {
  const console_ = [];
  const errors = [];
  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || []).map((a) => {
        if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
        return a.description || a.type;
      }).join(' ');
      const rec = { type: msg.params.type, text };
      console_.push(rec);
      if (msg.params.type === 'error') errors.push(rec);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {};
      const text = d.exception?.description || d.text || 'unknown exception';
      errors.push({ type: 'exception', text });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error' || e.level === 'warning') {
        const rec = { type: `log.${e.level}`, text: e.text + (e.url ? ` (${e.url})` : '') };
        console_.push(rec);
        if (e.level === 'error') errors.push(rec);
      }
    }
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  cdp.console_ = console_;
  cdp.errors = errors;
}

// ---------------------------------------------------------------- page helpers
async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error('evaluate threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function navigate(cdp, url) {
  log('navigate ->', url);
  await cdp.send('Page.navigate', { url });
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const st = await evaluate(cdp, 'document.readyState');
      if (st === 'complete') return;
    } catch { /* navigating */ }
  }
  log('WARN: readyState never reached complete, continuing');
}

async function waitForText(cdp, needle, timeoutMs = 30000, label = 'text') {
  const t0 = Date.now();
  const esc = JSON.stringify(needle);
  while (Date.now() - t0 < timeoutMs) {
    try {
      const hit = await evaluate(cdp, `document.body && document.body.innerText.includes(${esc})`);
      if (hit) { log(`waitForText(${label}) found after ${Date.now() - t0}ms: ${JSON.stringify(needle)}`); return true; }
    } catch { /* ignore */ }
    await sleep(400);
  }
  log(`waitForText(${label}) TIMEOUT after ${timeoutMs}ms: ${JSON.stringify(needle)}`);
  return false;
}

async function bodyText(cdp) { return (await evaluate(cdp, 'document.body ? document.body.innerText : ""')) || ''; }

async function screenshot(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(r.data, 'base64');
  fs.writeFileSync(file, buf);
  log(`screenshot ${file} (${buf.length} bytes)`);
  return { file, bytes: buf.length };
}

/** panel root expression: outermost element carrying the plugin's own class prefix */
const PANEL_ROOT_EXPR = `(() => {
  const all = Array.from(document.querySelectorAll('[class*="ntfy-teams"]'));
  if (!all.length) return null;
  const top = all.find(el => !(el.parentElement && /ntfy-teams/.test(String(el.parentElement.className || ''))));
  return top || all[0];
})()`;

/** the PLUGIN PANEL root: `.ntfy-teams-root` is what lib/client.js renders inside the main slot.
 *  Falls back to the largest plugin-classed element that is NOT inside the sidebar nav. */
const PANEL_ROOT_JS = `(() => {
  const root = document.querySelector('[class*="ntfy-teams-root"]');
  if (root) return root;
  const all = Array.from(document.querySelectorAll('[class*="ntfy-teams"]'));
  const big = all.filter(el => !el.closest('nav') && el.getBoundingClientRect().width > 200)
    .sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
  return big[0] || null;
})()`;
const PLUGIN_ROOT_EXPR = 'plugin';

/** locate the smallest visible element whose trimmed innerText equals/contains the label.
 *  root: null (whole document) | 'plugin' (outermost [class*=ntfy-teams]) | any CSS selector */
async function findElement(cdp, label, { exact = true, tags = null, root = null } = {}) {
  const payload = JSON.stringify({ label, exact, tags, root });
  return evaluate(cdp, `(() => {
    const { label, exact, tags, root } = ${payload};
    let rootEl = document;
    if (root === 'plugin') {
      rootEl = ${PANEL_ROOT_JS};
      if (!rootEl) return { missingRoot: true, reason: 'no panel root ([class*=ntfy-teams-root] or large non-nav plugin element) in DOM' };
    } else if (root) {
      rootEl = document.querySelector(root);
      if (!rootEl) return { missingRoot: true, reason: 'selector not found: ' + root };
    }
    const sel = tags && tags.length ? tags.join(',') : '*';
    const all = Array.from(rootEl.querySelectorAll(sel));
    if (rootEl !== document && rootEl.matches && rootEl.matches(sel)) all.push(rootEl);
    const hits = [];
    for (const el of all) {
      const t = (el.innerText || el.textContent || '').trim();
      // SVG-only glyphs (e.g. the panellist entry) expose their name via title/aria-label, not text
      const attrs = [(el.getAttribute && el.getAttribute('title')) || '', (el.getAttribute && el.getAttribute('aria-label')) || '', el.placeholder || ''].join(' ').trim();
      const hay = (t + ' ' + attrs).trim();
      const ok = exact ? (t === label || attrs === label) : hay.includes(label);
      if (!ok) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || st.pointerEvents === 'none') continue;
      hits.push({ el, r, area: r.width * r.height });
    }
    if (!hits.length) return null;
    hits.sort((a, b) => a.area - b.area);
    const best = hits[0];
    const el = best.el;
    return {
      tag: el.tagName, id: el.id || null,
      cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 160) : null,
      role: el.getAttribute('role'), type: el.type || null,
      text: (el.innerText || el.textContent || '').trim().slice(0, 120),
      x: best.r.x + best.r.width / 2, y: best.r.y + best.r.height / 2,
      w: best.r.width, h: best.r.height,
      count: hits.length,
      trace: hits.slice(0, 6).map(h => ({ tag: h.el.tagName, id: h.el.id || null, text: (h.el.innerText||'').trim().slice(0,60), area: Math.round(h.area) })),
    };
  })()`);
}

/** JS expression returning a JSON snapshot of the PLUGIN PANEL subtree (never the sidebar glyph) */
const PLUGIN_DOM_EXPR = `(() => {
  const top = ${PANEL_ROOT_JS};
  if (!top) {
    return JSON.stringify({
      found: false,
      note: 'no panel root rendered (searched [class*=ntfy-teams-root], then large non-nav [class*=ntfy-teams])',
      sidebarGlyphPresent: !!document.querySelector('[class*="ntfy-teams-glyphwrap"]'),
      anyPluginNodes: document.querySelectorAll('[class*="ntfy-teams"]').length,
      bodyHasFallback: (document.body.innerText || '').includes('核心模块未加载'),
    });
  }
  return JSON.stringify({
    found: true, topTag: top.tagName,
    topCls: String(top.className).slice(0, 120),
    rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(top.getBoundingClientRect()),
    count: document.querySelectorAll('[class*="ntfy-teams"]').length,
    inputs: Array.from(top.querySelectorAll('input,textarea')).map(i => ({ tag: i.tagName, type: i.type, ph: i.placeholder, val: i.value })),
    buttons: Array.from(top.querySelectorAll('button')).map(b => ({ cls: String(b.className).slice(0, 60), text: (b.innerText || '').trim().slice(0, 30), aria: b.getAttribute('aria-label') })),
    text: (top.innerText || '').slice(0, 800),
    htmlHead: top.outerHTML.slice(0, 600),
  });
})()`;

/** real CDP mouse click at viewport coordinates (not a synthetic el.click()) */
async function clickAt(cdp, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: base.x, y: base.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

async function clickText(cdp, label, opts = {}) {
  const info = await findElement(cdp, label, opts);
  if (!info) { log(`clickText(${label}) -> element NOT FOUND`); return null; }
  log(`clickText(${label}) -> <${info.tag} id=${info.id} role=${info.role}> at ${Math.round(info.x)},${Math.round(info.y)} (candidates=${info.count})`);
  await clickAt(cdp, info.x, info.y);
  return info;
}

// ---------------------------------------------------------------- modes
async function withBrowser(fn, opts) {
  const cdp = await launchChrome(opts);
  try {
    await setup(cdp);
    return await fn(cdp);
  } finally {
    const dump = opts?.dumpConsole ? () => {} : null;
    if (dump) dump();
    cdp.close();
    const exited = new Promise((res) => cdp.proc.once('exit', res));
    try { cdp.proc.kill(); } catch { /* ignore */ }
    // on Windows chrome leaves renderer/crashpad children holding profile locks: kill the tree
    try {
      if (process.platform === 'win32' && cdp.proc.pid) {
        spawn('taskkill', ['/F', '/T', '/PID', String(cdp.proc.pid)], { stdio: 'ignore' });
      }
    } catch { /* ignore */ }
    await Promise.race([exited, sleep(5000)]);
    // chrome may hold the profile briefly; retry so profiles never accumulate (C: is tight)
    for (let i = 0; i < 6; i++) {
      try { fs.rmSync(cdp.userDataDir, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
    log(`profile cleanup: ${fs.existsSync(cdp.userDataDir) ? 'LEFT BEHIND ' + cdp.userDataDir : 'ok'}`);
  }
}

function reportConsole(cdp) {
  logStep('CONSOLE / ERROR CAPTURE');
  console.log(`console messages: ${cdp.console_.length}, errors: ${cdp.errors.length}`);
  for (const m of cdp.console_) console.log(`  [${m.type}] ${m.text.slice(0, 500)}`);
  for (const e of cdp.errors) console.log(`  !! [${e.type}] ${e.text.slice(0, 500)}`);
  const slotCrash = cdp.errors.filter((e) => /slot entry crashed/i.test(e.text));
  console.log(`slot-crash errors: ${slotCrash.length}`);
  return { total: cdp.console_.length, errors: cdp.errors, slotCrash };
}

function reportStorage(cdp) { return cdp; }

async function modeProbe(cdp) {
  await navigate(cdp, GUI_URL);
  await sleep(2500);
  const booted = await waitForText(cdp, '設定', 45000, 'sidebar-設定');
  const text = await bodyText(cdp);
  logStep('SIDEBAR TEXT (first 1500 chars)');
  console.log(text.slice(0, 1500));
  const storage = await evaluate(cdp, `JSON.stringify({ keys: Object.keys(localStorage), theme: Object.entries(localStorage).filter(([k]) => /theme|dark|light|appear/i.test(k)) })`);
  logStep('LOCALSTORAGE');
  console.log(storage);
  const themeCtl = await evaluate(cdp, `(() => {
    const out = { htmlClass: document.documentElement.className, bodyClass: document.body.className,
      dataTheme: document.documentElement.getAttribute('data-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      bg: getComputedStyle(document.body).backgroundColor };
    return JSON.stringify(out);
  })()`);
  logStep('THEME STATE');
  console.log(themeCtl);
  const shot = await screenshot(cdp, path.join(OUT_DIR, '_verify-probe-sidebar.png'));
  reportConsole(cdp);
  return { booted, shot, text, storage, themeCtl };
}

async function modeTheme(cdp) {
  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, '設定');
  await sleep(1000);
  const before = await evaluate(cdp, `JSON.stringify({ html: document.documentElement.className, body: document.body.className, theme: document.documentElement.dataset.theme || null, bg: getComputedStyle(document.body).backgroundColor, ls: Object.keys(localStorage) })`);
  logStep('BEFORE THEME PROBE'); console.log(before);

  // open 設定 (settings) and look for appearance controls
  const settingsInfo = await clickText(cdp, '設定', { exact: true });
  await sleep(2000);
  const settingsText = (await bodyText(cdp)).slice(0, 3000);
  logStep('AFTER CLICK 設定 — PAGE TEXT');
  console.log(settingsText);
  const controls = await evaluate(cdp, `(() => {
    const nodes = Array.from(document.querySelectorAll('button,[role=button],[role=tab],a,input,select,[role=switch],[role=radio]'));
    return JSON.stringify(nodes.filter(n => n.offsetParent !== null).slice(0, 120).map(n => ({
      tag: n.tagName, role: n.getAttribute('role'), type: n.type || null,
      label: (n.getAttribute('aria-label') || n.title || n.innerText || n.value || '').trim().slice(0, 50),
      cls: typeof n.className === 'string' ? n.className.slice(0, 60) : '',
    })));
  })()`);
  logStep('INTERACTIVE CONTROLS ON SETTINGS');
  console.log(controls);
  const after = await evaluate(cdp, `JSON.stringify({ html: document.documentElement.className, theme: document.documentElement.dataset.theme || null, ls: Object.entries(localStorage).filter(([k]) => /theme|dark|light|appear|mode/i.test(k)) })`);
  logStep('AFTER THEME PROBE STATE'); console.log(after);
  const s1 = await screenshot(cdp, path.join(OUT_DIR, '_verify-probe-settings-light.png'));
  reportConsole(cdp);
  return { before, settingsInfo, settingsText, controls, after, s1 };
}

// The acceptance flow (needs the plugin installed).
async function modeFull(cdp, argv) {
  const marker = argv.marker || `verify ${new Date().toISOString()} ${Math.random().toString(36).slice(2, 8)}`;
  const results = { marker, steps: [], ok: false };

  await navigate(cdp, GUI_URL);
  const booted = await waitForText(cdp, '設定', 45000, 'app-boot');
  results.booted = booted;
  await sleep(1500);

  logStep('SIDEBAR ENTRIES');
  const sidebar = await evaluate(cdp, `(() => {
    const els = Array.from(document.querySelectorAll('button,a,[role=button],[role=tab],li'));
    const seen = new Set(); const out = [];
    for (const el of els) {
      const t = (el.innerText || '').trim();
      if (!t || t.length > 30 || t.includes('\\n')) continue;
      if (seen.has(t)) continue; seen.add(t);
      const r = el.getBoundingClientRect();
      if (r.width < 2) continue;
      out.push({ t, id: el.id || null, cls: typeof el.className === 'string' ? el.className.slice(0, 60) : '', x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });
    }
    return JSON.stringify(out);
  })()`);
  console.log(sidebar);
  results.sidebar = JSON.parse(sidebar);

  logStep(`SELECT PANEL ${PANEL_LABEL}`);
  let panelClick = await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]', '[role=tab]'] });
  if (!panelClick) {
    log('retry: any element carrying the label (title/aria-label included)');
    panelClick = await clickText(cdp, PANEL_LABEL, { exact: false });
  }
  if (!panelClick) {
    log('retry: exact label match on any element');
    panelClick = await clickText(cdp, PANEL_LABEL, { exact: true });
  }
  results.panelClick = panelClick;
  if (!panelClick) {
    results.error = `sidebar entry ${PANEL_LABEL} not found`;
    console.log('FATAL:', results.error);
    logStep('DOM FALLBACK REPORT');
    console.log('plugin subtree:', await evaluate(cdp, PLUGIN_DOM_EXPR));
    console.log('body innerText (first 800):', (await bodyText(cdp)).slice(0, 800));
    reportConsole(cdp);
    return results;
  }
  await sleep(2500);

  logStep('PANEL DOM AFTER SELECT');
  const panelText = await bodyText(cdp);
  console.log(panelText.slice(0, 2500));
  results.panelTextInitial = panelText.slice(0, 2500);

  const hasHeader = panelText.includes(PANEL_LABEL);
  const hasHost = panelText.includes('msn.feg.cn');
  const hasTopic = panelText.includes(TOPIC);
  log(`panel checks -> header:${hasHeader} host:${hasHost} topic:${hasTopic}`);
  results.checks = { hasHeader, hasHost, hasTopic };

  logStep('PLUGIN SUBTREE SNAPSHOT');
  const dom = await evaluate(cdp, PLUGIN_DOM_EXPR);
  console.log(dom);
  results.pluginDom = JSON.parse(dom);

  if (!results.checks.hasTopic) {
    logStep('ADD TOPIC VIA PANEL + CONTROL (scoped to the plugin subtree)');
    // exact control from lib/client.js TopicBar: button text '+ 订阅 topic', title '订阅新的 topic'
    let plus = await findElement(cdp, ADD_LABEL, { exact: true, root: 'plugin' });
    if (!plus || plus.missingRoot) plus = await findElement(cdp, ADD_TITLE, { exact: false, root: 'plugin' });
    if (!plus || plus.missingRoot) plus = await findElement(cdp, '+ 订阅 topic', { exact: true, root: 'plugin' });
    if (!plus || plus.missingRoot) plus = await findElement(cdp, '订阅新的 topic', { exact: false, root: 'plugin' });
    if (!plus || plus.missingRoot) plus = await findElement(cdp, '+', { exact: true, root: 'plugin' });
    results.plusControl = plus;
    if (plus && !plus.missingRoot) {
      log('clicking add-topic control:', JSON.stringify(plus));
      await clickAt(cdp, plus.x, plus.y);
      await sleep(900);
      // the revealed inline input (autoFocus) is .ntfy-teams-input with placeholder 'topic 名称，例如 pub_demo'
      let input = await findElement(cdp, 'topic 名称，例如 pub_demo', { exact: false, root: 'plugin', tags: ['input'] });
      if (!input || input.missingRoot) {
        input = await evaluate(cdp, `(() => {
          const all = Array.from(document.querySelectorAll('[class*="ntfy-teams"] input'));
          const vis = all.filter(i => i.offsetParent !== null && !i.disabled && i.type !== 'password');
          if (!vis.length) return null;
          const i = vis[vis.length - 1];
          const r = i.getBoundingClientRect();
          return JSON.stringify({ ph: i.placeholder || null, type: i.type, x: r.x + r.width / 2, y: r.y + r.height / 2 });
        })()`);
        input = input ? Object.assign(JSON.parse(input), { viaPlaceholder: false }) : null;
      } else {
        input = { ph: 'topic 名称，例如 pub_demo', viaPlaceholder: true, x: input.x, y: input.y };
      }
      log('topic input:', JSON.stringify(input));
      results.topicInput = input;
      if (input) {
        await clickAt(cdp, input.x, input.y);
        await sleep(250);
        await cdp.send('Input.insertText', { text: TOPIC });
        await sleep(500);
        const typed = await evaluate(cdp, `(() => { const i = document.querySelector('[class*="ntfy-teams"] input'); return i ? i.value : null; })()`);
        log('input value after typing:', JSON.stringify(typed));
        results.topicInputValue = typed;
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await sleep(3000);
      } else {
        log('WARN: add control clicked but no visible non-password input appeared');
      }
    } else {
      results.plusMissing = true;
      log('WARN: no add-topic control found in the plugin subtree');
    }
    const t2 = await bodyText(cdp);
    results.checks.hasTopic = t2.includes(TOPIC);
    log('after + -> topic present:', results.checks.hasTopic);
    results.pluginDomAfterAdd = JSON.parse(await evaluate(cdp, PLUGIN_DOM_EXPR));
    console.log(results.pluginDomAfterAdd.text);
  }

  await screenshot(cdp, path.join(OUT_DIR, '_verify-01-light.png'));
  results.shot01 = path.join(OUT_DIR, '_verify-01-light.png');

  logStep(`PUBLISH MARKER TO ${NTFY_BASE}/${TOPIC}`);
  console.log('MARKER=' + marker);
  const { execFileSync } = require('node:child_process');
  let pubOut = '';
  try {
    pubOut = execFileSync('curl.exe', ['-s', '-S', '-X', 'POST', `${NTFY_BASE}/${TOPIC}`, '-d', marker], { encoding: 'utf8' });
  } catch (e) { pubOut = 'CURL ERROR: ' + (e.stdout || '') + (e.stderr || e.message); }
  console.log('curl stdout:', JSON.stringify(pubOut));
  results.publishOutput = pubOut;

  const liveOk = await waitForText(cdp, marker, 30000, 'live-marker');
  results.liveOk = liveOk;
  const liveText = await bodyText(cdp);
  const idx = liveText.indexOf(marker);
  results.markerExcerpt = idx >= 0 ? liveText.slice(Math.max(0, idx - 120), idx + 160) : null;
  log('marker excerpt:', JSON.stringify(results.markerExcerpt));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-02-live.png'));
  results.shot02 = path.join(OUT_DIR, '_verify-02-live.png');

  // ---- Lead-requested extra: TITLE rendering of a message row ----
  logStep('PUBLISH TITLED MESSAGE (title + body must render as separate lines)');
  const titleMarker = `標題測試 ${Date.now()}`;
  const bodyMarker = `titled body ${marker}`;
  console.log('TITLE=' + titleMarker + '\nBODY=' + bodyMarker);
  let titleOut = '';
  try {
    titleOut = execFileSync('curl.exe', ['-s', '-S', '-X', 'POST', `${NTFY_BASE}/${TOPIC}`,
      '-H', `Title: ${titleMarker}`, '-d', bodyMarker], { encoding: 'utf8' });
  } catch (e) { titleOut = 'CURL ERROR: ' + (e.stdout || '') + (e.stderr || e.message); }
  console.log('curl stdout:', JSON.stringify(titleOut));
  results.titlePublish = { title: titleMarker, body: bodyMarker, output: titleOut };

  const titleSeen = await waitForText(cdp, titleMarker, 30000, 'live-title');
  const bodyOfTitleSeen = titleSeen ? await waitForText(cdp, bodyMarker, 5000, 'live-title-body') : false;
  results.titleOk = titleSeen && bodyOfTitleSeen;
  const titled = await bodyText(cdp);
  const ti = titled.indexOf(titleMarker);
  results.titleExcerpt = ti >= 0 ? titled.slice(Math.max(0, ti - 60), ti + 220) : null;
  log('title visible:', titleSeen, '| body visible:', bodyOfTitleSeen);
  log('title excerpt:', JSON.stringify(results.titleExcerpt));
  // separate lines: the title and its body must appear in distinct text nodes / line-separated
  const rowStructure = await evaluate(cdp, `(() => {
    const all = Array.from(document.querySelectorAll('[class*="ntfy-teams"] *'));
    const hit = all.filter(el => (el.textContent || '').includes(${JSON.stringify(titleMarker)}));
    if (!hit.length) return JSON.stringify({ found: false });
    let el = hit[hit.length - 1];
    const chain = [];
    for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
      chain.push({ tag: el.tagName, cls: String(el.className).slice(0, 70), text: (el.innerText || '').slice(0, 200) });
    }
    return JSON.stringify({ found: true, chain });
  })()`);
  console.log('title row DOM chain:', rowStructure);
  results.titleRowStructure = JSON.parse(rowStructure);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-05-title.png'));
  results.shot05 = path.join(OUT_DIR, '_verify-05-title.png');

  logStep('DARK THEME TOGGLE');
  const theme = await toggleTheme(cdp);
  results.theme = theme;
  await sleep(1200);
  const darkState = await evaluate(cdp, `JSON.stringify({ html: document.documentElement.className, dataTheme: document.documentElement.dataset.theme || null, bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme })`);
  log('dark state:', darkState);
  results.darkState = JSON.parse(darkState);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-03-dark.png'));
  results.shot03 = path.join(OUT_DIR, '_verify-03-dark.png');

  if (argv['keep-theme'] !== true) {
    logStep('RESTORE THEME TO 跟隨系統 (preference lives in the Host user-settings doc, so it is global)');
    const restore = await toggleTheme(cdp, '跟隨系統');
    results.themeRestore = restore;
  }

  logStep('RELOAD + HISTORY CHECK');
  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot-2');
  await sleep(1500);
  const click2 = await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]', '[role=tab]'] });
  results.panelClick2 = click2;
  await sleep(3000);
  const afterReload = await bodyText(cdp);
  results.historyMarkerPresent = afterReload.includes(marker);
  const i2 = afterReload.indexOf(marker);
  results.historyExcerpt = i2 >= 0 ? afterReload.slice(Math.max(0, i2 - 120), i2 + 160) : null;
  results.historyTitlePresent = afterReload.includes(titleMarker);
  const i3 = afterReload.indexOf(titleMarker);
  results.historyTitleExcerpt = i3 >= 0 ? afterReload.slice(Math.max(0, i3 - 60), i3 + 220) : null;
  log('history marker present:', results.historyMarkerPresent, '| history title present:', results.historyTitlePresent);
  log('history excerpt:', JSON.stringify(results.historyExcerpt));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-04-history.png'));

  logStep('PLUGIN SUBTREE AFTER RELOAD (blank/error check)');
  const finalDom = JSON.parse(await evaluate(cdp, PLUGIN_DOM_EXPR));
  const pluginText = finalDom.text || '';
  results.pluginDomAfterReload = finalDom;
  results.pluginRectAfterReload = finalDom.rect || null;
  console.log('plugin rect:', JSON.stringify(finalDom.rect), 'visible text length:', pluginText.length);
  console.log(pluginText.slice(0, 1200));

  const cons = reportConsole(cdp);
  results.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  // blank-region / raw-error / core-missing heuristics, scoped to the plugin's own subtree
  results.rawErrorInPanel = /(Cannot read propert|\bTypeError\b|\bReferenceError\b|slot entry crashed|核心模块未加载|核心模組未載入)/i.test(pluginText);
  results.panelBlank = !finalDom.found || !finalDom.rect || finalDom.rect.w < 50 || finalDom.rect.h < 50 || pluginText.trim().length === 0;
  results.ok = !!(results.checks.hasHeader && results.checks.hasTopic && liveOk && results.titleOk
    && !results.rawErrorInPanel && !results.panelBlank
    && results.historyMarkerPresent && results.historyTitlePresent
    && cons.slotCrash.length === 0);
  logStep('RESULT');
  console.log(JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result.json'), JSON.stringify(results, null, 2));
  return results;
}

/** generic debug driver: navigate, optionally click a label, dump overlays + optional shot */
async function modeClick(cdp, argv) {
  await navigate(cdp, argv.url || GUI_URL);
  await waitForText(cdp, '設定', 45000, 'boot');
  await sleep(argv.settle ? Number(argv.settle) : 1500);
  if (argv.selector) {
    const box = await evaluate(cdp, `(() => {
      const el = document.querySelector(${JSON.stringify(argv.selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return JSON.stringify({ tag: el.tagName, cls: String(el.className).slice(0, 80), x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height });
    })()`);
    log('selector click:', argv.selector, '->', box);
    if (box) { const b = JSON.parse(box); await clickAt(cdp, b.x, b.y); }
    await sleep(argv.after ? Number(argv.after) : 2500);
  }
  if (argv.click) {
    const info = await clickText(cdp, argv.click, { exact: argv.exact === 'true' });
    log('clicked:', JSON.stringify(info));
    await sleep(argv.after ? Number(argv.after) : 2500);
  }
  const dump = await evaluate(cdp, `(() => {
    const overlays = Array.from(document.querySelectorAll('[role=dialog],[role=menu],[role=listbox],[class*=overlay],[class*=modal],[class*=dialog],[class*=Panel],[class*=sheet]'));
    return JSON.stringify(overlays.filter(e => e.offsetParent !== null).map(e => ({
      tag: e.tagName, role: e.getAttribute('role'),
      cls: typeof e.className === 'string' ? e.className.slice(0, 90) : '',
      text: (e.innerText || '').trim().slice(0, 400),
      rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(e.getBoundingClientRect()),
    })), null, 1);
  })()`);
  logStep('VISIBLE OVERLAYS'); console.log(dump);
  const html = await evaluate(cdp, `document.body.innerHTML.length`);
  log('body innerHTML length:', html);
  if (argv.shot) await screenshot(cdp, path.join(OUT_DIR, argv.shot));
  reportConsole(cdp);
  return { dump };
}

/**
 * Theme path, discovered by probing the live GUI:
 *   設定 (sidebar footer, class *VOzbGW_trigger) opens role=dialog .VOzbGW_panel
 *   whose 外觀 row offers 淺色 / 深色 / 跟隨系統 cubes (AppearanceRow of
 *   @deepseek-ai/dsh-client-ui-theme). The preference is persisted in the Host
 *   user-settings document under namespace `ui-theme` field `preference`
 *   (NOT localStorage), so the honest path is clicking the 深色 cube.
 */
/** diagnostic: why is the panel in a fallback state? (core global, served files, styles) */
async function modeCoreProbe(cdp) {
  const netUrls = [];
  await cdp.send('Network.enable');
  cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url); });

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'boot');
  await sleep(2500);
  const click = await clickText(cdp, PANEL_LABEL, { exact: false });
  await sleep(3000);

  const report = await evaluate(cdp, `(async () => {
    const PANEL_ROOT = ${PANEL_ROOT_JS};
    const out = {
      coreGlobalType: typeof window.__ntfyTeamsCore,
      moduleRootType: typeof window.moduleRoot,
      moduleRootKeys: (typeof window.moduleRoot === 'function') ? Object.getOwnPropertyNames(window.moduleRoot).slice(0, 10) : null,
      coreKeys: window.__ntfyTeamsCore ? Object.keys(window.__ntfyTeamsCore).slice(0, 40) : null,
      coreStore: !!(window.__ntfyTeamsCore && window.__ntfyTeamsCore.store),
      moduleLoaderIds: (window.__ModuleLoader__ && typeof window.__ModuleLoader__.ids === 'object') ? window.__ModuleLoader__.ids : null,
      pluginStyles: Array.from(document.querySelectorAll('style[data-plugin="ntfy-teams"]')).map(s => s.textContent.length),
      scriptsWithNtfy: Array.from(document.querySelectorAll('script[src]')).map(s => s.src).filter(u => /ntfy/i.test(u)),
    };
    out.coreJsFetch = {};
    for (const p of ['/plugins/ntfy-teams/core.js', '/plugins/ntfy-teams/client.js', '/plugins/ntfy-teams/lib/core.js', '/plugins/ntfy-teams/lib/client.js']) {
      try { const r = await fetch(p); out.coreJsFetch[p] = r.status + ' ' + (r.ok ? (await r.text()).slice(0, 80).replace(/\\s+/g, ' ') : ''); }
      catch (e) { out.coreJsFetch[p] = 'FETCH ERROR ' + e.message; }
    }
    const top = PANEL_ROOT;
    out.panel = top ? { rect: (r => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }))(top.getBoundingClientRect()), text: (top.innerText || '').slice(0, 400), html: top.outerHTML.slice(0, 900) } : null;
    out.styleTagInHead = Array.from(document.head.querySelectorAll('style')).some(s => s.dataset.plugin === 'ntfy-teams');
    out.bodyFallback = (document.body.innerText || '').includes('核心模块未加载');
    return JSON.stringify(out, null, 1);
  })()`);
  logStep('CORE PROBE');
  console.log(report);
  logStep('NETWORK REQUESTS MATCHING ntfy');
  const ntfyUrls = netUrls.filter((u) => /ntfy/i.test(u));
  console.log(JSON.stringify(ntfyUrls, null, 1));

  // decisive: compare the SERVED bundle against the ON-DISK source
  const bundleUrl = netUrls.find((u) => /ntfy-teams\/client\.js/.test(u) && u.includes('/plugins/'));
  const served = { bundleUrl: bundleUrl || null };
  if (bundleUrl) {
    try {
      const r = await fetch(bundleUrl);
      const text = await r.text();
      served.status = r.status;
      served.bytes = text.length;
      served.hasModuleRoot = /moduleRoot/.test(text);
      served.hasOldGlobalAssign = /__ntfyTeamsCore\s*=\s*api/.test(text);
      served.hasFallbackString = /核心模块未加载/.test(text);
      served.hasCoreFileCode = /root\.moduleRoot\s*=\s*function/.test(text);
      served.coreAssignCount = (text.match(/root\.moduleRoot\s*=\s*function/g) || []).length;
      served.hasCoreCall = /core\s*=\s*root\.moduleRoot\s*\(\s*\)/.test(text);
      served.coreDepMissingText = /没有在 lib\/client\.js 之前执行/.test(text);
      const k = text.indexOf('root.moduleRoot =');
      served.coreAssignContext = k >= 0 ? text.slice(Math.max(0, k - 700), k + 250) : null;
      served.ntfyFactoryIdPresent = /id:\s*['"]ntfy-teams['"]/.test(text);
      served.loaderLoadIdsTail = (text.match(/__ModuleLoader__\.load\(\s*\{[^}]{0,90}/g) || []).slice(-5);
      served.coreInsideClientFactory = (() => {
        const f = text.lastIndexOf("id: 'ntfy-teams'");
        if (f < 0 || k < 0) return null;
        return { factoryIndex: f, coreIndex: k, coreAfterFactory: k > f };
      })();
      const i = text.indexOf('moduleRoot');
      served.moduleRootSnippet = i >= 0 ? text.slice(Math.max(0, i - 200), i + 200) : null;
    } catch (e) { served.fetchError = e.message; }
    const disk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
    served.diskHasModuleRoot = /moduleRoot/.test(disk);
    served.diskBytes = disk.length;
    if (served.hasModuleRoot && served.diskHasModuleRoot) {
      const a = served.moduleRootSnippet || '';
      served.servedMatchesDisk = disk.includes(a.trim().slice(0, 80));
    }
  }
  logStep('SERVED BUNDLE vs DISK');
  console.log(JSON.stringify(served, null, 1));
  log('clicked:', JSON.stringify(click));
  const shot = await screenshot(cdp, path.join(OUT_DIR, '_verify-coreprobe.png'));
  reportConsole(cdp);
  return { report: JSON.parse(report), netUrls: ntfyUrls, served, shot };
}

function argvSafe() { return '_verify-coreprobe.png'; }

/** precise selection behaviour: glyph click vs shell row click, with exception deltas */
async function modePanelTest(cdp) {
  const state = async (tag) => {
    const json = await evaluate(cdp, `JSON.stringify({
      fallbackVisible: (document.body.innerText || '').includes('核心模块未加载'),
      headerVisible: Array.from(document.querySelectorAll('[class*="ntfy-teams-title"]')).filter(e => e.offsetParent !== null).length,
      roots: document.querySelectorAll('[class*="ntfy-teams-root"]').length,
      allNtfy: document.querySelectorAll('[class*="ntfy-teams"]').length,
      selected: Array.from(document.querySelectorAll('button[class*="panelRow"]')).filter(b => /团队协同/.test(b.innerText) && (b.getAttribute('aria-current') || b.getAttribute('aria-selected') || /active|selected/i.test(String(b.className)))).map(b => ({ cls: String(b.className).slice(0,80), aria: b.getAttribute('aria-selected') || b.getAttribute('aria-current') })),
    })`);
    log(`[${tag}] ${json} exceptionsSoFar=${cdp.errors.length}`);
    return JSON.parse(json);
  };

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'boot');
  await sleep(2000);
  const s0 = await state('before-any-click');

  const glyph = await evaluate(cdp, `(() => { const e = document.querySelector('[class*="ntfy-teams-glyphwrap"]'); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); })()`);
  log('glyph box:', glyph);
  const errBefore = cdp.errors.length;
  if (glyph) { const g = JSON.parse(glyph); await clickAt(cdp, g.x, g.y); }
  await sleep(2000);
  const s1 = await state('after-glyph-click');
  const glyphErrors = cdp.errors.slice(errBefore).map((e) => `${e.type}: ${e.text.split('\n')[0]}`);

  const row = await evaluate(cdp, `(() => { const b = Array.from(document.querySelectorAll('button[class*="panelRow"]')).find(x => /团队协同/.test(x.innerText)); if (!b) return null; const r = b.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width - 12, y: r.y + r.height/2, w: r.width }); })()`);
  log('shell row box (right edge):', row);
  const errBefore2 = cdp.errors.length;
  if (row) { const b = JSON.parse(row); await clickAt(cdp, b.x, b.y); }
  await sleep(2500);
  const s2 = await state('after-shell-row-click');
  const rowErrors = cdp.errors.slice(errBefore2).map((e) => `${e.type}: ${e.text.split('\n')[0]}`);

  await screenshot(cdp, path.join(OUT_DIR, '_verify-paneltest.png'));
  logStep('PANEL TEST SUMMARY');
  console.log(JSON.stringify({ s0, s1, s2, glyphErrors, rowErrors }, null, 1));
  reportConsole(cdp);
  return { s0, s1, s2, glyphErrors, rowErrors };
}

/** is the page actually running the NEW client code? (stale server-side bundle vs broken fix) */
async function modeBundleCheck(cdp) {
  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'boot');
  await sleep(2000);
  const click = await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a'] });
  await sleep(3000);
  const out = await evaluate(cdp, `(async () => {
    const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
    const url = srcs.find(u => /ntfy-teams/.test(u)) || null;
    const res = { url, windowCoreType: typeof window.__ntfyTeamsCore, scriptCount: srcs.length };
    if (url) {
      const text = await (await fetch(url)).text();
      res.bundleBytes = text.length;
      res.hasNewModuleRootDesign = /moduleRoot/.test(text);
      res.hasOldGlobalAssign = /root\\.__ntfyTeamsCore\\s*=|__ntfyTeamsCore\\s*=\\s*api/.test(text);
      const i = text.indexOf('moduleRoot');
      res.moduleRootSnippet = i >= 0 ? text.slice(Math.max(0, i - 260), i + 260) : null;
      const j = text.indexOf('核心模块未加载');
      res.fallbackSnippet = j >= 0 ? text.slice(Math.max(0, j - 400), j + 120) : null;
      res.serverFileMtimeHeader = null;
    }
    const st = await fetch('/plugins/ntfy-teams/lib/core.js').then(r => r.status).catch(() => -1);
    res.directCoreFetchStatus = st;
    return JSON.stringify(res, null, 1);
  })()`);
  logStep('BUNDLE CHECK');
  console.log(out);
  log('clicked:', JSON.stringify(click));
  const body = await bodyText(cdp);
  const fi = body.indexOf('核心模块未加载');
  log('panel fallback text present:', fi >= 0);
  if (fi >= 0) console.log('fallback context:', JSON.stringify(body.slice(Math.max(0, fi - 80), fi + 120)));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-bundlecheck.png'));
  reportConsole(cdp);
  return JSON.parse(out);
}

/** add a topic through the panel's own + control (honest UI path) */
async function addTopicViaPanel(cdp, topic) {
  let plus = await findElement(cdp, ADD_LABEL, { exact: true, root: 'plugin' });
  if (!plus || plus.missingRoot) plus = await findElement(cdp, ADD_TITLE, { exact: false, root: 'plugin' });
  if (!plus || plus.missingRoot) plus = await findElement(cdp, '+ 订阅 topic', { exact: true, root: 'plugin' });
  if (!plus || plus.missingRoot) { log('addTopic: + control NOT FOUND'); return { ok: false, reason: 'no + control' }; }
  await clickAt(cdp, plus.x, plus.y);
  await sleep(900);
  let input = await findElement(cdp, TOPIC_INPUT_PH, { exact: false, root: 'plugin', tags: ['input'] });
  if (!input || input.missingRoot) input = await findElement(cdp, 'topic', { exact: false, root: 'plugin', tags: ['input'] });
  if (!input || input.missingRoot) { log('addTopic: input NOT FOUND'); return { ok: false, reason: 'no input' }; }
  await clickAt(cdp, input.x, input.y);
  await sleep(250);
  await cdp.send('Input.insertText', { text: topic });
  await sleep(400);
  const typed = await evaluate(cdp, `(() => { const i = document.querySelector('[class*="ntfy-teams"] input'); return i ? i.value : null; })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(3000);
  return { ok: true, typed };
}

/** type into a located control; clear=true selects existing text first (Ctrl+A) */
async function typeInto(cdp, box, text, { clear = false } = {}) {
  await clickAt(cdp, box.x, box.y);
  await sleep(200);
  if (clear) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await sleep(150);
  }
  await cdp.send('Input.insertText', { text });
  await sleep(300);
}

/** full structural snapshot of the redesigned panel (workgroup layout + markdown + security) */
const PANEL_STRUCT_EXPR = `(() => {
  const root = document.querySelector('[class*="ntfy-teams-root"]');
  const fallbacks = ['核心模組未載入', '核心模块未加载'];
  if (!root) return JSON.stringify({ found: false, bodyFallback: fallbacks.some(m => (document.body.innerText || '').includes(m)) });
  const q = (s) => Array.from(root.querySelectorAll(s));
  const txt = (el) => el ? (el.innerText || '').trim().slice(0, 160) : null;
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const stream = root.querySelector('.ntfy-teams-stream');
  return JSON.stringify({
    found: true,
    rootRect: rect(root),
    header: {
      grouplogo: q('.ntfy-teams-grouplogo').length,
      grouplogoRect: rect(root.querySelector('.ntfy-teams-grouplogo')),
      title: txt(root.querySelector('.ntfy-teams-title')),
      subtitle: txt(root.querySelector('.ntfy-teams-subtitle')),
      chip: txt(root.querySelector('.ntfy-teams-chip')),
    },
    groupbar: {
      groupbarClassPresent: q('.ntfy-teams-groupbar').length,
      topicsContainerClassPresent: q('.ntfy-teams-topics').length,
      chips: q('.ntfy-teams-topic').map(el => (el.innerText || '').trim().slice(0, 40)),
      addControl: txt(root.querySelector('.ntfy-teams-topics button:last-of-type')),
    },
    stream: {
      present: q('.ntfy-teams-stream').length,
      rect: rect(stream),
      msgs: q('.ntfy-teams-msg').length,
      avatars: q('.ntfy-teams-avatar').length,
      senders: q('.ntfy-teams-sender').map(txt),
      youBadges: q('.ntfy-teams-you').map(txt),
      clocks: q('.ntfy-teams-clock').map(txt),
      days: q('.ntfy-teams-day').map(txt),
      msgbody: q('.ntfy-teams-msgbody').length,
    },
    compose: {
      present: q('.ntfy-teams-compose').length,
      meta: txt(root.querySelector('.ntfy-teams-composemeta')),
      textareaPh: (root.querySelector('.ntfy-teams-textarea') || {}).placeholder || null,
      sendBtnText: txt(root.querySelector('.ntfy-teams-sendbtn')),
    },
    md: {
      containers: q('.ntfy-teams-md').length,
      h1: q('.ntfy-teams-md h1').length, h2: q('.ntfy-teams-md h2').length, h3: q('.ntfy-teams-md h3').length,
      strong: q('.ntfy-teams-md strong').length, em: q('.ntfy-teams-md em').length, del: q('.ntfy-teams-md del').length,
      code: q('.ntfy-teams-md code').length, pre: q('.ntfy-teams-md pre').length,
      lang: q('.ntfy-teams-md-lang').map(txt),
      ul: q('.ntfy-teams-md ul').length, ol: q('.ntfy-teams-md ol').length, li: q('.ntfy-teams-md li').length,
      blockquote: q('.ntfy-teams-md blockquote').length, hr: q('.ntfy-teams-md hr').length,
      anchors: q('.ntfy-teams-md a').map(a => ({ href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel'), text: (a.innerText || '').trim().slice(0, 60) })),
      rawlinks: q('.ntfy-teams-md-rawlink').map(txt),
      preTexts: q('.ntfy-teams-md pre').map(p => p.innerText),
    },
    security: {
      scriptEls: root.querySelectorAll('script').length,
      imgEls: root.querySelectorAll('img').length,
      javascriptAnchors: q('a').filter(a => String(a.getAttribute('href') || '').toLowerCase().startsWith('javascript:')).length,
      alertCount: (typeof window.__alertCount === 'number') ? window.__alertCount : null,
      onerrorAttrs: root.querySelectorAll('[onerror]').length,
    },
  });
})()`;

/** curl POST that PRESERVES newlines (--data-binary; -d would strip them) */
function publishRaw(body, title, topic = TOPIC) {
  const { execFileSync } = require('node:child_process');
  const args = ['-s', '-S', '-X', 'POST', `${NTFY_BASE}/${topic}`, '--data-binary', '@-',
    '-H', 'Content-Type: text/plain; charset=utf-8'];
  if (title) args.push('-H', `Title: ${title}`);
  return execFileSync('curl.exe', args, { encoding: 'utf8', input: body });
}

/** read the topic's stored history straight from ntfy (independent of the panel) */
function fetchTopicHistory() {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('curl.exe', ['-s', '-S', `${NTFY_BASE}/${TOPIC}/json?poll=1&since=all`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return out.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .map(l => { try { return JSON.parse(l.replace(/^data:\s*/, '')); } catch { return null; } })
    .filter((m) => m && m.event !== 'open');
}

/** set the 顯示名稱 through the panel's shared settings block.
 *  task-10 DOM: 摘要住在**抬頭**裡，用它的鉛筆圖示「切換」展開／收起（表單裡沒有收合按鈕）。
 *  舊的 `.ntfy-teams-conn` 那一列、'連線與認證設定' aria-label、以及抬頭那顆
 *  「共用設定」圖示按鈕都已經移除（圖示按鈕跟「編輯」功能重複，而且畫的像太陽）。 */
async function setIdentity(cdp, name) {
  let opened = { via: null };
  const edit = await findElement(cdp, EDIT_ARIA, { exact: true, root: 'plugin', tags: ['button'] });
  if (edit && !edit.missingRoot) {
    await clickAt(cdp, edit.x, edit.y);
    await sleep(1200);
    opened = { via: '編輯', box: edit };
  } else {
    return { ok: false, reason: '找不到摘要裡的「編輯」按鈕（抬頭那個齒輪已經移除了）' };
  }
  const input = await findElement(cdp, IDENTITY_PH, { exact: false, root: 'plugin', tags: ['input'] });
  if (!input || input.missingRoot) return { ok: false, reason: 'identity input not found after expanding', opened };
  await typeInto(cdp, input, name, { clear: true });
  const typed = await evaluate(cdp, `(() => { const i = document.getElementById('ntfy-teams-identity'); return i ? i.value : null; })()`);
  const save = await findElement(cdp, SAVE_LABEL, { exact: true, root: 'plugin' });
  if (!save || save.missingRoot) return { ok: false, reason: '儲存 button not found', typed, opened };
  await clickAt(cdp, save.x, save.y);
  await sleep(1500);
  const hint = await evaluate(cdp, `(() => { const n = document.querySelector('[class*="ntfy-teams-hint"]'); return n ? (n.innerText||'').trim() : null; })()`);
  // capture the shared settings block's texts WHILE IT IS STILL OPEN ('送出訊息時顯示為 …' lives here now)
  const connTexts = await evaluate(cdp, `(() => {
    const c = document.querySelector('[class*="ntfy-teams-settings"]');
    if (!c) return null;
    return JSON.stringify(Array.from(c.querySelectorAll('span,label')).map(s => (s.innerText || '').trim()).filter(Boolean));
  })()`);
  // 收起：再點一次鉛筆（它就是切換）。
  const closeToggle = await findElement(cdp, EDIT_ARIA, { exact: true, root: 'plugin', tags: ['button'] });
  if (closeToggle && !closeToggle.missingRoot) { await clickAt(cdp, closeToggle.x, closeToggle.y); await sleep(900); }
  const subtitle = await evaluate(cdp, `(() => { const e = document.querySelector('[class*="ntfy-teams-subtitle"]'); return e ? (e.innerText||'').trim() : null; })()`);
  const summary = await evaluate(cdp, `(() => { const e = document.querySelector('.ntfy-teams-settingsbar'); return e ? (e.innerText||'').trim() : null; })()`);
  return { ok: true, typed, saveHint: hint, connTexts, opened, subtitle, summary };
}

/** send FROM the panel composer (click the 傳送 button, not a fetch) */
async function sendFromComposer(cdp, body) {
  const ta = await findElement(cdp, '輸入訊息', { exact: false, root: 'plugin', tags: ['textarea'] });
  if (!ta || ta.missingRoot) return { ok: false, reason: 'composer textarea not found' };
  await typeInto(cdp, ta, body);
  const typed = await evaluate(cdp, `(() => { const t = document.querySelector('[class*="ntfy-teams-textarea"]'); return t ? t.value : null; })()`);
  const btn = await findElement(cdp, SEND_LABEL, { exact: true, root: 'plugin', tags: ['button'] });
  if (!btn || btn.missingRoot) return { ok: false, reason: '傳送 button not found', typed };
  log('clicking', SEND_LABEL, JSON.stringify(btn));
  await clickAt(cdp, btn.x, btn.y);
  await sleep(2500);
  return { ok: true, typed, sendBtn: btn };
}

/** task-6 acceptance: workgroup layout + #username identity + markdown + security + legacy steps */
async function modeFull2(cdp, argv) {
  const identity = argv.identity || 'shawoo';
  const stamp = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const res = { task: 'task-6', identity, ok: false };

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  res.sidebarRows = JSON.parse(await evaluate(cdp, `JSON.stringify(Array.from(document.querySelectorAll('button[class*="panelRow"]')).map(b => (b.innerText || '').trim()))`));
  log('sidebar rows:', JSON.stringify(res.sidebarRows));

  logStep(`SELECT PANEL ${PANEL_LABEL}`);
  let panelClick = await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  if (!panelClick) panelClick = await clickText(cdp, PANEL_LABEL, { exact: false });
  res.panelClick = panelClick;
  if (!panelClick) {
    res.error = `sidebar entry ${PANEL_LABEL} not found`;
    console.log('FATAL:', res.error, '| sidebar:', JSON.stringify(res.sidebarRows));
    console.log('plugin dom:', await evaluate(cdp, PLUGIN_DOM_EXPR));
    reportConsole(cdp);
    return res;
  }
  await sleep(2500);

  logStep('1. WORKGROUP STRUCTURE (before topic)');
  res.structureBeforeTopic = JSON.parse(await evaluate(cdp, PANEL_STRUCT_EXPR));
  console.log(JSON.stringify(res.structureBeforeTopic, null, 1));

  logStep(`ADD TOPIC ${TOPIC} VIA PANEL CONTROL`);
  const added = await addTopicViaPanel(cdp, TOPIC);
  res.addTopic = added;
  log('addTopic:', JSON.stringify(added));
  await sleep(2500);
  res.structureAfterTopic = JSON.parse(await evaluate(cdp, PANEL_STRUCT_EXPR));
  console.log('groupbar chips:', JSON.stringify(res.structureAfterTopic.groupbar.chips));

  await screenshot(cdp, path.join(OUT_DIR, '_verify-01-light.png'));
  res.shot01 = path.join(OUT_DIR, '_verify-01-light.png');

  logStep('2. SENDER IDENTITY via the panel connection row');
  res.identity = await setIdentity(cdp, identity);
  log('setIdentity:', JSON.stringify(res.identity));
  const subtitleAfter = await evaluate(cdp, `(() => { const e = document.querySelector('[class*="ntfy-teams-subtitle"]'); return e ? (e.innerText||'').trim() : null; })()`);
  res.subtitleAfterIdentity = subtitleAfter;

  const idBody = `identity send ${stamp} ${rand}`;
  res.identitySend = await sendFromComposer(cdp, idBody);
  res.identityBody = idBody;
  log('sendFromComposer:', JSON.stringify(res.identitySend));
  const idSeen = await waitForText(cdp, idBody, 25000, 'identity-send-visible');
  res.identitySendVisible = idSeen;
  await sleep(1200);
  res.structureAfterSend = JSON.parse(await evaluate(cdp, PANEL_STRUCT_EXPR));
  console.log('senders:', JSON.stringify(res.structureAfterSend.stream.senders));
  console.log('youBadges:', JSON.stringify(res.structureAfterSend.stream.youBadges));
  console.log('compose meta:', JSON.stringify(res.structureAfterSend.compose.meta));
  const hist1 = fetchTopicHistory();
  const mine = hist1.filter(m => String(m.message || '').includes(idBody));
  res.identityPayload = mine.map(m => ({ id: m.id, title: m.title === undefined ? null : m.title, message: m.message }));
  res.identityTitleExact = mine.length > 0 && mine.some(m => m.title === `@${identity}`);
  log(`title seen in ntfy payload: ${JSON.stringify(res.identityPayload.map(m => m.title))} ; expected @${identity} -> ${res.identityTitleExact}`);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-07-identity.png'));
  res.shot07 = path.join(OUT_DIR, '_verify-07-identity.png');

  logStep('3. MARKDOWN');
  const mdBody = [
    '# 一級標題 heading',
    '## 二級標題 sub',
    '### 三級標題 subsub',
    '',
    '**粗體bold** 與 *斜體italic* 與 ~~刪除strike~~ 與 `inline code`',
    '',
    '- 項目 A',
    '- 項目 B',
    '',
    '> 引用 blockquote 行',
    '',
    '```js',
    'const x = 1;',
    '  const y = 2;',
    '```',
    '',
    '[官方連結](https://msn.feg.cn/pub_demo) 與裸網址 https://msn.feg.cn/pub_demo 到此',
  ].join('\n');
  res.markdownBody = mdBody;
  res.mdPublish = publishRaw(mdBody, '@md_probe');
  log('md publish:', JSON.stringify(res.mdPublish).slice(0, 200));
  const mdSeen = await waitForText(cdp, '一級標題 heading', 30000, 'markdown-visible');
  res.markdownVisible = mdSeen;
  await sleep(1500);
  res.structureAfterMd = JSON.parse(await evaluate(cdp, PANEL_STRUCT_EXPR));
  const m = res.structureAfterMd.md;
  console.log('md counts:', JSON.stringify({ h1: m.h1, h2: m.h2, h3: m.h3, strong: m.strong, em: m.em, del: m.del, code: m.code, pre: m.pre, ul: m.ul, li: m.li, blockquote: m.blockquote, anchors: m.anchors.length, lang: m.lang }));
  console.log('anchors:', JSON.stringify(m.anchors));
  console.log('preTexts:', JSON.stringify(m.preTexts));
  const wantFence = 'const x = 1;\n  const y = 2;';
  res.markdown = {
    found: {
      h1: m.h1 > 0, h2: m.h2 > 0, h3: m.h3 > 0, strong: m.strong > 0, em: m.em > 0, del: m.del > 0,
      code: m.code > 0, pre: m.pre > 0, ul: m.ul > 0, li: m.li >= 2, blockquote: m.blockquote > 0,
      anchorHttps: m.anchors.some(a => /^https:\/\//.test(String(a.href))),
      fenceVerbatim: m.preTexts.some(t => t.replace(/\r/g, '') === wantFence),
    },
    counts: { h1: m.h1, h2: m.h2, h3: m.h3, strong: m.strong, em: m.em, del: m.del, code: m.code, pre: m.pre, ul: m.ul, li: m.li, blockquote: m.blockquote },
    anchors: m.anchors, preTexts: m.preTexts, wantFence,
  };
  log('markdown assertions:', JSON.stringify(res.markdown.found));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-06-markdown.png'));
  res.shot06 = path.join(OUT_DIR, '_verify-06-markdown.png');

  logStep('4. SECURITY (javascript: link + raw HTML)');
  await evaluate(cdp, `(() => { window.__alertCount = 0; window.alert = function () { window.__alertCount++; }; window.confirm = function () { window.__alertCount++; return false; }; return true; })()`);
  const secBody = [
    'malicious link [click me](javascript:alert(1)) 與 javascript:alert(1) 裸字串',
    'raw html: <img src=x onerror=alert(1)> and <script>alert(1)</script> end',
  ].join('\n');
  res.securityBody = secBody;
  res.secPublish = publishRaw(secBody, '@sec_probe');
  log('sec publish:', JSON.stringify(res.secPublish).slice(0, 200));
  const secSeen = await waitForText(cdp, 'malicious link', 30000, 'security-visible');
  res.securityVisible = secSeen;
  await sleep(1500);
  const secStruct = JSON.parse(await evaluate(cdp, PANEL_STRUCT_EXPR));
  res.structureAfterSec = secStruct;
  const s = secStruct.security;
  const secExcerpt = await evaluate(cdp, `(() => {
    const rows = Array.from(document.querySelectorAll('[class*="ntfy-teams-md"]'));
    const hit = rows.find(r => (r.innerText || '').includes('malicious link'));
    return hit ? hit.innerText.slice(0, 400) : null;
  })()`);
  res.securityExcerpt = secExcerpt;
  res.security = {
    raw: s,
    noJavascriptAnchor: s.javascriptAnchors === 0,
    noScriptOrImg: s.scriptEls === 0 && s.imgEls === 0,
    noAlertDialog: s.alertCount === 0,
    // core.parseMarkdown turns an unsafe [x](javascript:...) into LITERAL TEXT (no node at all),
    // so the client-side .ntfy-teams-md-rawlink span is defence-in-depth that this input cannot reach.
    rawlinkSpans: secStruct.md.rawlinks.length,
    rawlinkPresent: secStruct.md.rawlinks.length > 0,
    javascriptLiteralText: typeof secExcerpt === 'string' && secExcerpt.includes('javascript:alert(1)'),
    imgTagLiteralText: typeof secExcerpt === 'string' && secExcerpt.includes('<img src=x onerror=alert(1)>'),
    scriptTagLiteralText: typeof secExcerpt === 'string' && secExcerpt.includes('<script>alert(1)</script>'),
  };
  log('security result:', JSON.stringify(res.security, null, 1));
  console.log('security row text:', JSON.stringify(secExcerpt));

  logStep('5. LIVE PUSH + LIGHT/LIVE/DARK + HISTORY (legacy steps kept)');
  const marker = `verify2 ${new Date().toISOString()} ${rand}`;
  res.marker = marker;
  res.livePublish = publishRaw(marker, '');
  log('live publish:', JSON.stringify(res.livePublish).slice(0, 200));
  res.liveSeen = await waitForText(cdp, marker, 30000, 'live-marker');
  log('live marker visible:', res.liveSeen);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-02-live.png'));
  res.shot02 = path.join(OUT_DIR, '_verify-02-live.png');

  logStep('DARK THEME');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1200);
  res.darkState = JSON.parse(await evaluate(cdp, `JSON.stringify({ bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme })`));
  log('dark state:', JSON.stringify(res.darkState));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-03-dark.png'));
  res.shot03 = path.join(OUT_DIR, '_verify-03-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  logStep('RELOAD + HISTORY');
  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot-2');
  await sleep(1500);
  const click2 = await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  res.panelClick2 = click2;
  await sleep(3500);
  const after = await bodyText(cdp);
  res.history = {
    marker: after.includes(marker),
    identityBody: after.includes(idBody),
    markdownHeading: after.includes('一級標題 heading'),
    securityText: after.includes('malicious link'),
  };
  const domAfter = JSON.parse(await evaluate(cdp, PLUGIN_DOM_EXPR));
  res.pluginDomAfterReload = domAfter;
  res.structureAfterReload = JSON.parse(await evaluate(cdp, PANEL_STRUCT_EXPR));
  log('history:', JSON.stringify(res.history));
  log('stream after reload: msgs=', res.structureAfterReload.stream.msgs, 'senders=', JSON.stringify(res.structureAfterReload.stream.senders));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-04-history.png'));
  res.shot04 = path.join(OUT_DIR, '_verify-04-history.png');

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map(e => `${e.type}: ${e.text}`.slice(0, 300)) };
  res.fallbackShown = FALLBACK_MARKERS.some(x => after.includes(x));
  res.ok = !!(
    res.structureAfterTopic.found && res.structureAfterTopic.stream.present && res.structureAfterTopic.compose.present
    && res.structureAfterTopic.header.title === PANEL_LABEL && res.structureAfterTopic.header.grouplogo > 0
    && res.identity.ok && res.identityTitleExact && res.identitySendVisible
    && res.markdownVisible && Object.values(res.markdown.found).every(Boolean)
    && res.securityVisible && res.security.noJavascriptAnchor && res.security.noScriptOrImg
    && res.security.noAlertDialog && res.security.javascriptLiteralText
    && res.security.imgTagLiteralText && res.security.scriptTagLiteralText
    && res.liveSeen && res.history.marker && res.history.identityBody && res.history.markdownHeading
    && !res.fallbackShown && cons.slotCrash.length === 0
  );
  logStep('TASK-6 RESULT');
  console.log(JSON.stringify({ ok: res.ok, identity: res.identity, identityTitleExact: res.identityTitleExact, identityPayload: res.identityPayload, markdown: res.markdown.found, security: res.security, history: res.history, sidebarRows: res.sidebarRows }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-6.json'), JSON.stringify(res, null, 2));
  return res;
}

/** sidebar unread badge: text + geometry vs the host row / title / icon */
const BADGE_EXPR = `(() => {
  const badge = document.querySelector('.ntfy-teams-unreadbadge');
  const rows = Array.from(document.querySelectorAll('button[class*="panelRow"]'));
  const row = rows.find(b => ((b.innerText || '') + (b.getAttribute('title') || '')).includes('團隊協同')) || null;
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right), bottom: Math.round(b.bottom) }; };
  const hit = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  let titleEl = null, iconEl = null;
  if (row) {
    const cands = Array.from(row.querySelectorAll('span,div'))
      .filter(e => (e.innerText || '').trim() === '團隊協同');
    cands.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.width * ra.height - rb.width * rb.height; });
    titleEl = cands[0] || null;
    iconEl = row.querySelector('[class*="ntfy-teams-glyphwrap"]') || row.querySelector('svg');
  }
  const br = R(badge), rr = R(row), tr = R(titleEl), ir = R(iconEl);
  const cs = badge ? getComputedStyle(badge) : null;
  return JSON.stringify({
    badge: badge ? { text: badge.textContent, cls: String(badge.className), rect: br, position: cs.position, top: cs.top, left: cs.left, zIndex: cs.zIndex, fontSize: cs.fontSize, offsetParentVisible: badge.offsetParent !== null, ariaHidden: badge.getAttribute('aria-hidden') } : null,
    badgeCount: document.querySelectorAll('.ntfy-teams-unreadbadge').length,
    rowCount: rows.length,
    row: rr, rowCls: row ? String(row.className).slice(0, 90) : null,
    rowTitle: tr, rowTitleCls: titleEl ? String(titleEl.className).slice(0, 60) : null, rowTitleText: titleEl ? (titleEl.innerText || '').trim() : null,
    rowIcon: ir, rowIconCls: iconEl ? String(iconEl.className).slice(0, 60) : null,
    badgeInsideRow: !!br && !!rr && br.left >= rr.left - 1 && br.right <= rr.right + 1 && br.top >= rr.top - 1 && br.bottom <= rr.bottom + 1,
    badgeOverlapsTitle: hit(br, tr),
    badgeOverlapsIcon: hit(br, ir),
    gapBadgeRightToTitleLeft: (br && tr) ? Math.round(tr.left - br.right) : null,
    glyphwrapPosition: iconEl ? getComputedStyle(iconEl).position : null,
  });
})()`;

async function badgeText(cdp) {
  return evaluate(cdp, `(() => { const e = document.querySelector('.ntfy-teams-unreadbadge'); return e ? e.textContent : null; })()`);
}

async function waitBadge(cdp, expected, timeoutMs = 20000, label = 'badge') {  const t0 = Date.now();
  let seen = null;
  while (Date.now() - t0 < timeoutMs) {
    seen = await badgeText(cdp);
    if (expected === null ? seen === null : seen === expected) {
      log(`waitBadge(${label}) ok after ${Date.now() - t0}ms: ${JSON.stringify(seen)}`);
      return { ok: true, text: seen, ms: Date.now() - t0 };
    }
    await sleep(400);
  }
  log(`waitBadge(${label}) TIMEOUT after ${timeoutMs}ms: wanted ${JSON.stringify(expected)}, saw ${JSON.stringify(seen)}`);
  return { ok: false, text: seen, ms: Date.now() - t0 };
}

/** wait until the badge text differs from prevText (robust when unread carries over from an earlier stage) */
async function waitBadgeChange(cdp, prevText, timeoutMs = 25000, label = 'badge-change') {
  const t0 = Date.now();
  let seen = await badgeText(cdp);
  while (Date.now() - t0 < timeoutMs) {
    seen = await badgeText(cdp);
    if (seen !== null && seen !== prevText) {
      log(`waitBadgeChange(${label}) ok after ${Date.now() - t0}ms: ${JSON.stringify(prevText)} -> ${JSON.stringify(seen)}`);
      return { ok: true, text: seen, prev: prevText, ms: Date.now() - t0 };
    }
    await sleep(300);
  }
  log(`waitBadgeChange(${label}) TIMEOUT after ${timeoutMs}ms: still ${JSON.stringify(seen)}`);
  return { ok: false, text: seen, prev: prevText, ms: Date.now() - t0 };
}

/** click a topic chip inside the panel's topic bar (NOT the add control, NOT the × remove button) */
async function selectTopicChip(cdp, topic) {
  // container class was renamed .ntfy-teams-topics -> .ntfy-teams-groupbar in the badge fix; try both, then the root
  let chip = await findElement(cdp, topic, { exact: true, root: '.ntfy-teams-groupbar', tags: ['span'] });
  if (!chip || chip.missingRoot) chip = await findElement(cdp, topic, { exact: true, root: '.ntfy-teams-topics', tags: ['span'] });
  if (!chip || chip.missingRoot) chip = await findElement(cdp, topic, { exact: true, root: '.ntfy-teams-root', tags: ['span'] });
  if (!chip || chip.missingRoot) return { ok: false, reason: 'chip span not found in topic bar' };
  await clickAt(cdp, chip.x, chip.y);
  await sleep(1800);
  const active = await evaluate(cdp, `(() => {
    const chips = Array.from(document.querySelectorAll('.ntfy-teams-topic'));
    const hit = chips.find(c => (c.innerText || '').includes(${JSON.stringify(topic)}));
    return hit ? /ntfy-teams-topic--active/.test(String(hit.className)) : null;
  })()`);
  return { ok: true, chip, active };
}

/** make sure the 團隊協同 panel is mounted (its effect starts SSE + loadPersisted) */
async function openPanel(cdp) {
  if (await evaluate(cdp, `!!document.querySelector('[class*="ntfy-teams-root"]')`)) return { ok: true, alreadyOpen: true };
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  for (let i = 0; i < 25; i++) {
    await sleep(400);
    if (await evaluate(cdp, `!!document.querySelector('[class*="ntfy-teams-root"]')`)) return { ok: true };
  }
  return { ok: false };
}

/** task-7: sidebar unread COUNT badge + read/unread semantics */
async function modeBadge(cdp, argv) {
  const topicB = argv.topicB || 'pub_demo_b';
  const res = { task: 'task-7', topicA: TOPIC, topicB, ok: false };
  const ts = Date.now();

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  res.badgeAtStart = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  log('STEP 1 badge at start (must be absent):', JSON.stringify(res.badgeAtStart.badge), 'count=', res.badgeAtStart.badgeCount);

  logStep(`SUBSCRIBE ${TOPIC} AND ${topicB} VIA PANEL`);
  res.addA = await addTopicViaPanel(cdp, TOPIC);
  await sleep(2000);
  res.addB = await addTopicViaPanel(cdp, topicB);
  await sleep(2500);
  res.chips = await evaluate(cdp, `JSON.stringify(Array.from(document.querySelectorAll('.ntfy-teams-topic')).map(c => (c.innerText||'').trim()))`);
  log('topic chips:', res.chips);
  res.containerClasses = await evaluate(cdp, `JSON.stringify({ groupbar: document.querySelectorAll('.ntfy-teams-groupbar').length, topics: document.querySelectorAll('.ntfy-teams-topics').length })`);
  log('topic-bar container classes present:', res.containerClasses);

  logStep(`MAKE ${TOPIC} THE ACTIVE TOPIC (panel open)`);
  res.selectA = await selectTopicChip(cdp, TOPIC);
  log('select A:', JSON.stringify({ ok: res.selectA.ok, active: res.selectA.active }));
  await sleep(1500);
  res.badgeAfterSubscribe = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  log('STEP 2 badge with 2 topics, none unread:', JSON.stringify(res.badgeAfterSubscribe.badge), 'count=', res.badgeAfterSubscribe.badgeCount);

  logStep(`STEP 3 PUBLISH TO NON-ACTIVE ${topicB} (live SSE)`);
  const body1 = `badge probe ${ts} #1`;
  res.pub1 = publishRaw(body1, '', topicB);
  log('curl stdout:', JSON.stringify(res.pub1).slice(0, 200));
  res.wait1 = await waitBadge(cdp, '1', 25000, 'expect-1');
  res.badge1 = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  console.log('STEP 4 badge geometry:', JSON.stringify(res.badge1, null, 1));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-08-badge.png'));
  res.shot08 = path.join(OUT_DIR, '_verify-08-badge.png');

  logStep('STEP 5 SECOND PUBLISH -> badge 2');
  const body2 = `badge probe ${ts} #2`;
  res.pub2 = publishRaw(body2, '', topicB);
  res.wait2 = await waitBadge(cdp, '2', 20000, 'expect-2');
  res.badge2 = JSON.parse(await evaluate(cdp, BADGE_EXPR));

  logStep('STEP 6 READ IT -> badge must disappear');
  res.selectB = await selectTopicChip(cdp, topicB);
  await sleep(1500);
  res.waitGone = await waitBadge(cdp, null, 20000, 'expect-gone-after-read');
  res.badgeAfterRead = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  log('badge after reading B:', JSON.stringify(res.badgeAfterRead.badge), 'count=', res.badgeAfterRead.badgeCount);

  logStep('STEP 6b LIVE ARRIVAL ON THE **ACTIVE** TOPIC MUST NOT COUNT');
  const body3 = `badge probe ${ts} #3 (active topic)`;
  res.pub3 = publishRaw(body3, '', topicB);
  await waitForText(cdp, body3, 25000, 'active-topic-live');
  await sleep(2500);
  res.badgeAfterActiveArrival = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  log('badge after live arrival on ACTIVE topic:', JSON.stringify(res.badgeAfterActiveArrival.badge), '(expected absent)');

  logStep('STEP 7 STAGE 1: unread>0, then reload with NO persist trigger');
  res.selectA2 = await selectTopicChip(cdp, TOPIC);
  await sleep(1200);
  const body4 = `badge probe ${ts} #4 (before reload)`;
  res.pub4 = publishRaw(body4, '', topicB);
  res.wait3 = await waitBadge(cdp, '1', 25000, 'expect-1-again');
  res.badgeBeforeReload = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  log('badge before reload:', JSON.stringify(res.badgeBeforeReload.badge));
  // in-memory store vs what is actually on disk, at the moment the badge reads 1
  res.divergence = JSON.parse(await evaluate(cdp, `(() => {
    const mem = (window.__ntfyTeamsCore && window.__ntfyTeamsCore.store) ? window.__ntfyTeamsCore.store.getSnapshot().unreadByTopic : null;
    let per = null;
    try { const raw = localStorage.getItem('ntfy-teams:store:v1'); per = raw ? JSON.parse(raw).unreadByTopic : null; } catch (e) { per = 'ERR ' + e.message; }
    return JSON.stringify({ memory: mem, persisted: per });
  })()`));
  log('in-memory unread vs persisted unread:', JSON.stringify(res.divergence));

  logStep('DARK SHOT (badge visible) + restore theme');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1200);
  res.badgeDark = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  const darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  log('badge in dark:', JSON.stringify(res.badgeDark.badge && res.badgeDark.badge.text), 'bg=', JSON.stringify(darkBg));
  res.darkBg = darkBg;
  await screenshot(cdp, path.join(OUT_DIR, '_verify-09-badge-dark.png'));
  res.shot09 = path.join(OUT_DIR, '_verify-09-badge-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot-2');
  await sleep(2500);
  res.openPanelAfterReload1 = await openPanel(cdp);   // mount the panel so loadPersisted() runs
  await sleep(3500);
  const badgeAfterReloadText = await badgeText(cdp);
  res.badgeAfterReload = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  res.badgeSurvivesReload = badgeAfterReloadText !== null;
  log('STAGE 1 badge after reload (+panel mounted):', JSON.stringify(badgeAfterReloadText), '-> survives:', res.badgeSurvivesReload);
  const ls = await evaluate(cdp, `(() => { try { const raw = localStorage.getItem('ntfy-teams:store:v1'); if (!raw) return null; const o = JSON.parse(raw); return JSON.stringify({ topics: o.topics, activeTopic: o.activeTopic, unreadByTopic: o.unreadByTopic }); } catch (e) { return 'ERR ' + e.message; } })()`);
  res.persistedStore = ls;
  log('persisted store after reload:', ls);

  logStep('STEP 7 STAGE 2: unread>0, then a persist trigger (chip click) before reload');
  const body5 = `badge probe ${ts} #5 (stage 2)`;
  const badgeBeforeStage2 = await badgeText(cdp);
  res.badgeBeforeStage2 = badgeBeforeStage2;
  res.pub5 = publishRaw(body5, '', topicB);
  res.wait4 = await waitBadgeChange(cdp, badgeBeforeStage2, 25000, 'stage2-increment');
  res.persistTrigger = await selectTopicChip(cdp, TOPIC);   // select() -> saveSubscriptions()
  await sleep(1500);
  res.persistedAfterTrigger = await evaluate(cdp, `(() => { try { const raw = localStorage.getItem('ntfy-teams:store:v1'); const o = raw ? JSON.parse(raw) : null; return o ? JSON.stringify(o.unreadByTopic) : null; } catch (e) { return 'ERR'; } })()`);
  log('persisted unread AFTER a chip-click trigger:', res.persistedAfterTrigger);
  res.badgeBeforeReload2 = JSON.parse(await evaluate(cdp, BADGE_EXPR));

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot-3');
  await sleep(2500);
  res.openPanelAfterReload2 = await openPanel(cdp);
  await sleep(3500);
  res.badgeAfterReload2Text = await badgeText(cdp);
  res.badgeAfterReload2 = JSON.parse(await evaluate(cdp, BADGE_EXPR));
  res.badgeSurvivesReloadWithTrigger = res.badgeAfterReload2Text !== null;
  log('STAGE 2 badge after reload (+panel mounted):', JSON.stringify(res.badgeAfterReload2Text), '-> survives:', res.badgeSurvivesReloadWithTrigger);

  if (argv['three-digit'] !== false) {
    logStep('STEP 8 THREE-DIGIT CAP (count driven through the plugin store API, not 100 real publishes)');
    res.capDriver = await evaluate(cdp, `(() => {
      const c = window.__ntfyTeamsCore;
      if (!c || !c.store || typeof c.store.addMessages !== 'function') return 'NO_CORE';
      const now = Math.floor(Date.now() / 1000);
      const msgs = [];
      for (let i = 0; i < 100; i++) {
        msgs.push({ id: 'capProbe' + ${ts} + '_' + i, time: now, event: 'message', topic: ${JSON.stringify(topicB)}, message: 'cap probe ' + i, tags: [], priority: 3, source: 'sse', server: 'https://msn.feg.cn' });
      }
      return String(c.store.addMessages(${JSON.stringify(topicB)}, msgs, 'sse'));
    })()`);
    log('store.addMessages(...,"sse") reported added =', res.capDriver);
    await sleep(2000);
    res.badgeCap = JSON.parse(await evaluate(cdp, BADGE_EXPR));
    log('CAP badge text:', JSON.stringify(res.badgeCap.badge && res.badgeCap.badge.text), 'rect:', JSON.stringify(res.badgeCap.badge && res.badgeCap.badge.rect));
    log('CAP geometry: gap=', res.badgeCap.gapBadgeRightToTitleLeft, 'overlapsTitle=', res.badgeCap.badgeOverlapsTitle, 'insideRow=', res.badgeCap.badgeInsideRow);
    await screenshot(cdp, path.join(OUT_DIR, '_verify-10-badge99.png'));
    res.shot10 = path.join(OUT_DIR, '_verify-10-badge99.png');
  }

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map(e => `${e.type}: ${e.text}`.slice(0, 300)) };
  res.checks = {
    absentAtStart: res.badgeAtStart.badgeCount === 0,
    absentAfterSubscribe: res.badgeAfterSubscribe.badgeCount === 0,
    badgeOne: res.wait1.ok && res.badge1.badge && res.badge1.badge.text === '1',
    badgeTwo: res.wait2.ok && res.badge2.badge && res.badge2.badge.text === '2',
    goneAfterRead: res.waitGone.ok && res.badgeAfterRead.badgeCount === 0,
    activeTopicNoCount: res.badgeAfterActiveArrival.badgeCount === 0,
    insideRow: res.badge1.badgeInsideRow,
    darkLegible: res.badgeDark.badge !== null && /rgb\(2[0-9], 2[0-9], 2[0-9]\)/.test(darkBg),
  };
  res.findings = {
    badgeOverlapsTitle: res.badge1.badgeOverlapsTitle,
    badgeOverlapPxIntoTitle: -res.badge1.gapBadgeRightToTitleLeft,
    badgeSurvivesReloadWithoutTrigger: res.badgeSurvivesReload,
    badgeSurvivesReloadWithTrigger: res.badgeSurvivesReloadWithTrigger,
    unreadPersistedOnUnreadChange: res.divergence && JSON.stringify(res.divergence.memory) === JSON.stringify(res.divergence.persisted),
    deadCssClassGroupbar: res.containerClasses,
  };
  res.ok = Object.values(res.checks).every(Boolean) && cons.slotCrash.length === 0;
  logStep('TASK-7 RESULT');
  console.log(JSON.stringify({
    ok: res.ok,
    checks: res.checks,
    findings: res.findings,
    badge1Text: res.badge1.badge && res.badge1.badge.text,
    badge2Text: res.badge2.badge && res.badge2.badge.text,
    badgeDarkText: res.badgeDark.badge && res.badgeDark.badge.text,
    geometry: { badge: res.badge1.badge && res.badge1.badge.rect, row: res.badge1.row, title: res.badge1.rowTitle, icon: res.badge1.rowIcon, gapBadgeRightToTitleLeft: res.badge1.gapBadgeRightToTitleLeft, insideRow: res.badge1.badgeInsideRow, overlapsTitle: res.badge1.badgeOverlapsTitle, overlapsIcon: res.badge1.badgeOverlapsIcon, glyphwrapPosition: res.badge1.glyphwrapPosition, cssTop: res.badge1.badge && res.badge1.badge.top, cssLeft: res.badge1.badge && res.badge1.badge.left, zIndex: res.badge1.badge && res.badge1.badge.zIndex },
    divergence: res.divergence,
    persistedAfterTrigger: res.persistedAfterTrigger,
    badgeAfterReloadStage1: res.badgeAfterReload.badge,
    badgeAfterReloadStage2: res.badgeAfterReload2.badge,
    console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-7.json'), JSON.stringify(res, null, 2));
  return res;
}

/** raw (undecoded) ntfy history text for a topic — lets us quote the literal JSON line */
function fetchTopicRaw(topic = TOPIC) {
  const { execFileSync } = require('node:child_process');
  return execFileSync('curl.exe', ['-s', '-S', `${NTFY_BASE}/${topic}/json?poll=1&since=all`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

/** find the rendered stream row containing a body marker and read its sender line */
async function rowSenderForBody(cdp, marker) {
  const raw = await evaluate(cdp, `(() => {
    const rows = Array.from(document.querySelectorAll('[class*="ntfy-teams-msg"]'));
    const hit = rows.find(r => ((r.innerText || '') + (r.textContent || '')).includes(${JSON.stringify(marker)}));
    if (!hit) return JSON.stringify({ found: false, rowCount: rows.length });
    const s = hit.querySelector('[class*="ntfy-teams-sender"]');
    const you = hit.querySelector('[class*="ntfy-teams-you"]');
    return JSON.stringify({
      found: true,
      sender: s ? (s.innerText || '').trim() : null,
      senderCls: s ? String(s.className) : null,
      youBadge: you ? (you.innerText || '').trim() : null,
      rowText: (hit.innerText || '')
    });
  })()`);
  return JSON.parse(raw);
}

/** task-8: sender sigil '#' — send path, legacy '@' display, and the negative control */
async function modeSigil(cdp, argv) {
  const identity = argv.identity || 'hashtagprobe';
  const res = { task: 'task-8', identity, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep(`SUBSCRIBE ${TOPIC} VIA PANEL`);
  res.addTopic = await addTopicViaPanel(cdp, TOPIC);
  await sleep(2500);

  logStep(`1. SET DISPLAY NAME ${identity} VIA THE PANEL`);
  res.identitySet = await setIdentity(cdp, identity);
  log('setIdentity:', JSON.stringify(res.identitySet));
  await sleep(1200);
  res.identityHint = res.identitySet && res.identitySet.connTexts ? res.identitySet.connTexts : null;
  res.identityHintAfterClose = await evaluate(cdp, `(() => {
    const conn = document.querySelector('[class*="ntfy-teams-conn"]');
    if (!conn) return null;
    const spans = Array.from(conn.querySelectorAll('span')).map(s => (s.innerText || '').trim()).filter(Boolean);
    return JSON.stringify(spans);
  })()`);
  log('connection row texts (captured while open):', res.identityHint);
  log('connection row texts (after close):', res.identityHintAfterClose);
  res.composerMeta = await evaluate(cdp, `(() => { const e = document.querySelector('[class*="ntfy-teams-composemeta"]'); return e ? (e.innerText || '').trim() : null; })()`);
  log('composer meta line:', JSON.stringify(res.composerMeta));
  res.subtitle = await evaluate(cdp, `(() => { const e = document.querySelector('[class*="ntfy-teams-subtitle"]'); return e ? (e.innerText || '').trim() : null; })()`);
  log('subtitle:', JSON.stringify(res.subtitle));

  logStep('2/3. SEND FROM THE COMPOSER THEN READ NTFY HISTORY');
  const body = `sigil send ${ts} ${rand}`;
  res.body = body;
  res.send = await sendFromComposer(cdp, body);
  log('sendFromComposer:', JSON.stringify(res.send));
  res.sendVisible = await waitForText(cdp, body, 25000, 'sigil-send-visible');
  await sleep(1500);

  const raw = fetchTopicRaw();
  res.rawLine = raw.split(/\r?\n/).find((l) => l.includes(body)) || null;
  log('RAW ntfy JSON line:', res.rawLine);
  const hist = fetchTopicHistory();
  const mine = hist.filter((m) => String(m.message || '').includes(body));
  res.payload = mine.map((m) => ({ id: m.id, title: m.title === undefined ? null : m.title, message: m.message }));
  res.titleExactHash = mine.some((m) => m.title === `#${identity}`);
  log(`stored title(s): ${JSON.stringify(res.payload.map((m) => m.title))} | expected #${identity} -> ${res.titleExactHash}`);

  logStep('4. RENDERED SENDER + COMPOSER LABEL');
  res.rowSelf = await rowSenderForBody(cdp, body);
  log('own row:', JSON.stringify(res.rowSelf));
  res.composerMetaAfterSend = await evaluate(cdp, `(() => { const e = document.querySelector('[class*="ntfy-teams-composemeta"]'); return e ? (e.innerText || '').trim() : null; })()`);
  log('composer meta after send:', JSON.stringify(res.composerMetaAfterSend));

  logStep('5. LEGACY @ TITLE FROM OUTSIDE -> must DISPLAY as #legacyuser');
  const legacyBody = `legacy probe ${ts} ${rand}`;
  res.legacyBody = legacyBody;
  res.legacyPublish = publishRaw(legacyBody, '@legacyuser');
  log('legacy curl stdout:', JSON.stringify(res.legacyPublish).slice(0, 200));
  res.legacyVisible = await waitForText(cdp, legacyBody, 25000, 'legacy-visible');
  await sleep(1500);
  res.rowLegacy = await rowSenderForBody(cdp, legacyBody);
  log('legacy row:', JSON.stringify(res.rowLegacy));

  logStep('6. NEGATIVE CONTROL: plain title -> 未具名成員');
  const negBody = `negative probe ${ts} ${rand}`;
  res.negBody = negBody;
  res.negPublish = publishRaw(negBody, 'just a title');
  log('negative curl stdout:', JSON.stringify(res.negPublish).slice(0, 200));
  res.negVisible = await waitForText(cdp, negBody, 25000, 'negative-visible');
  await sleep(1500);
  res.rowNeg = await rowSenderForBody(cdp, negBody);
  log('negative row:', JSON.stringify(res.rowNeg));

  await screenshot(cdp, path.join(OUT_DIR, '_verify-11-sigil.png'));
  res.shot11 = path.join(OUT_DIR, '_verify-11-sigil.png');

  logStep('THEME + CONSOLE');
  const bg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  res.bgBefore = bg;
  if (/rgb\((1?\d|2[0-9]), (1?\d|2[0-9]), (1?\d|2[0-9])\)/.test(bg)) {
    res.themeRestore = await toggleTheme(cdp, '跟隨系統');
  }
  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  res.checks = {
    identitySet: !!(res.identitySet && res.identitySet.ok),
    identityHintHash: typeof res.identityHint === 'string' && res.identityHint.includes('#' + identity) && !res.identityHint.includes('@' + identity),
    composerMetaHash: typeof res.composerMeta === 'string' && res.composerMeta.includes('#' + identity),
    sendVisible: res.sendVisible,
    storedTitleExactHash: res.titleExactHash,
    rawLineHasHashTitle: typeof res.rawLine === 'string' && res.rawLine.includes(`"title":"#${identity}"`),
    renderedSenderHash: !!(res.rowSelf && res.rowSelf.found && res.rowSelf.sender === '#' + identity),
    legacyDisplayedHash: !!(res.rowLegacy && res.rowLegacy.found && res.rowLegacy.sender === '#legacyuser'),
    negativeIsAnonDash: !!(res.rowNeg && res.rowNeg.found && res.rowNeg.sender === '--'),
    noSlotCrash: cons.slotCrash.length === 0,
  };
  res.ok = Object.values(res.checks).every(Boolean);
  logStep('TASK-8 RESULT');
  console.log(JSON.stringify({
    ok: res.ok,
    checks: res.checks,
    identity: { set: res.identitySet, hint: res.identityHint, composerMeta: res.composerMeta, subtitle: res.subtitle },
    rawLine: res.rawLine,
    payload: res.payload,
    rows: { self: res.rowSelf, legacy: res.rowLegacy, negative: res.rowNeg },
    composerMetaAfterSend: res.composerMetaAfterSend,
    console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-8.json'), JSON.stringify(res, null, 2));
  return res;
}

/** a REAL mouse double-click through CDP input (clickCount 1 then 2 => browser synthesizes dblclick) */
async function doubleClickAt(cdp, x, y) {
  const b = { x: Math.round(x), y: Math.round(y), button: 'left' };
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b, clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, clickCount: 1 });
  await sleep(45);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...b, clickCount: 2 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...b, clickCount: 2 });
  await sleep(700);
}

/** chip state for a topic, in both normal and inline-editing form */
const chipInfoExpr = (topic) => `(() => {
  const T = ${JSON.stringify(topic)};
  const editingChip = document.querySelector('.ntfy-teams-topic--editing');
  const chip = editingChip || Array.from(document.querySelectorAll('.ntfy-teams-topic'))
    .find(c => (c.getAttribute('title') || '').includes(T));
  const nameEl = chip ? chip.querySelector('.ntfy-teams-topicname') : null;
  const dot = chip ? chip.querySelector('.ntfy-teams-aliasdot') : null;
  const input = chip ? chip.querySelector('.ntfy-teams-aliasinput') : null;
  const bar = document.querySelector('.ntfy-teams-groupbar') || document.querySelector('.ntfy-teams-topics');
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  let cfg = null;
  try { const raw = localStorage.getItem('ntfy-teams:config:v1'); cfg = raw ? JSON.parse(raw) : null; } catch (e) { cfg = 'ERR'; }
  const activeChips = Array.from(document.querySelectorAll('.ntfy-teams-topic')).filter(c => /--active/.test(String(c.className))).map(c => (c.querySelector('.ntfy-teams-topicname') || {}).textContent || null);
  return JSON.stringify({
    chipCount: document.querySelectorAll('.ntfy-teams-topic').length,
    chip: chip ? { rect: R(chip), cls: String(chip.className), title: chip.getAttribute('title'), active: /--active/.test(String(chip.className)), editing: /--editing/.test(String(chip.className)) } : null,
    name: nameEl ? (nameEl.textContent || '').trim() : null,
    dot: dot ? { present: true, title: dot.getAttribute('title') } : null,
    input: input ? { rect: R(input), placeholder: input.placeholder, value: input.value, title: input.getAttribute('title'), ariaLabel: input.getAttribute('aria-label') } : null,
    bar: bar ? { rect: R(bar), scrollW: bar.scrollWidth, clientW: bar.clientWidth, overflowX: bar.scrollWidth > bar.clientWidth } : null,
    dblclicks: (typeof window.__dblclickCount === 'number') ? window.__dblclickCount : null,
    activeChips,
    cfgAliases: cfg && cfg.aliases ? cfg.aliases : null,
    cfgKeys: cfg ? Object.keys(cfg) : null,
  });
})()`;

/** task-9: topic aliases — real double-click rename, Enter/blur/Esc, persistence, real topic unchanged */
async function modeAlias(cdp, argv) {
  const topic = argv.topic || 'pub_demo_alias';
  const alias = argv.alias || '研發組';
  const res = { task: 'task-9', topic, alias, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const chipInfo = async () => JSON.parse(await evaluate(cdp, chipInfoExpr(topic)));

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep(`1/2. SUBSCRIBE ${topic}; chip must show the TOPIC NAME and no alias dot`);
  res.addTopic = await addTopicViaPanel(cdp, topic);
  await sleep(2800);
  res.initial = await chipInfo();
  log('initial chip:', JSON.stringify({ name: res.initial.name, dot: res.initial.dot, chip: res.initial.chip, cfgAliases: res.initial.cfgAliases }));

  await evaluate(cdp, `(() => { window.__dblclickCount = 0; document.addEventListener('dblclick', function () { window.__dblclickCount++; }, true); return true; })()`);

  logStep('3. REAL CDP DOUBLE-CLICK ON THE CHIP');
  const chipBox = res.initial.chip && res.initial.chip.rect;
  if (!chipBox) { res.error = 'chip rect not found'; console.log('FATAL', res.error); reportConsole(cdp); return res; }
  const beforeActive = await evaluate(cdp, `(() => { const s = window.__ntfyTeamsCore && window.__ntfyTeamsCore.store; return s ? s.getSnapshot().activeTopic : null; })()`);
  await doubleClickAt(cdp, chipBox.x + chipBox.w / 2, chipBox.y + chipBox.h / 2);
  await sleep(800);
  res.editing = await chipInfo();
  // NOTE: while editing, the chip's .ntfy-teams-topicname span is replaced by the input, so compare the
  // authoritative store value instead of chip label text.
  res.activeTopicBefore = beforeActive;
  res.activeTopicEditing = await evaluate(cdp, `(() => { const s = window.__ntfyTeamsCore && window.__ntfyTeamsCore.store; return s ? s.getSnapshot().activeTopic : null; })()`);
  log('while editing:', JSON.stringify({ chip: res.editing.chip, name: res.editing.name, input: res.editing.input, dblclicks: res.editing.dblclicks, activeTopicBefore: res.activeTopicBefore, activeTopicEditing: res.activeTopicEditing, bar: res.editing.bar }, null, 1));
  res.noTopicSwitch = res.activeTopicBefore === topic && res.activeTopicEditing === topic && !!(res.editing.chip && res.editing.chip.active) && !!(res.editing.chip && res.editing.chip.editing);

  logStep(`4. TYPE ALIAS ${alias} + ENTER (must repaint WITHOUT a reload)`);
  const inputBox = res.editing.input && res.editing.input.rect;
  if (!inputBox) {
    res.error = 'alias input did not appear after double-click';
    console.log('FATAL:', res.error, '| chip info:', JSON.stringify(res.editing));
    await screenshot(cdp, path.join(OUT_DIR, '_verify-12-alias.png'));
    reportConsole(cdp);
    return res;
  }
  await typeInto(cdp, { x: inputBox.x + inputBox.w / 2, y: inputBox.y + inputBox.h / 2 }, alias);
  res.typedAliasValue = await evaluate(cdp, `(() => { const i = document.querySelector('.ntfy-teams-aliasinput'); return i ? i.value : null; })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(1500);
  res.afterCommit = await chipInfo();
  log('after Enter (no reload):', JSON.stringify({ name: res.afterCommit.name, dot: res.afterCommit.dot, chipTitle: res.afterCommit.chip && res.afterCommit.chip.title, cfgAliases: res.afterCommit.cfgAliases, editing: res.afterCommit.chip && res.afterCommit.chip.editing }, null, 1));

  logStep('8a. SEND WHILE ALIASED (alias must be display-only)');
  const body = `alias send ${ts} ${rand}`;
  res.body = body;
  res.send = await sendFromComposer(cdp, body);
  res.sendVisible = await waitForText(cdp, body, 25000, 'alias-send-visible');
  await sleep(1200);
  res.rawLineRealTopic = fetchTopicRaw(topic).split(/\r?\n/).find((l) => l.includes(body)) || null;
  res.rawLineOnPlainTopic = fetchTopicRaw(TOPIC).split(/\r?\n/).find((l) => l.includes(body)) || null;
  log('RAW line on the REAL topic:', res.rawLineRealTopic);
  log('same body on the plain topic (must be null):', res.rawLineOnPlainTopic);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-12-alias.png'));
  res.shot12 = path.join(OUT_DIR, '_verify-12-alias.png');

  logStep('5. RELOAD -> alias must SURVIVE');
  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot-2');
  await sleep(2500);
  res.openPanel = await openPanel(cdp);
  await sleep(3000);
  res.afterReload = await chipInfo();
  log('after reload:', JSON.stringify({ name: res.afterReload.name, dot: !!res.afterReload.dot, cfgAliases: res.afterReload.cfgAliases }));

  logStep('7. ESC MUST CANCEL');
  const chip2 = (res.afterReload.chip && res.afterReload.chip.rect) || chipBox;
  await doubleClickAt(cdp, chip2.x + chip2.w / 2, chip2.y + chip2.h / 2);
  await sleep(700);
  const escState = JSON.parse(await evaluate(cdp, chipInfoExpr(topic)));
  res.escInputAppeared = !!(escState.input && escState.input.rect);
  if (res.escInputAppeared) {
    await typeInto(cdp, { x: escState.input.rect.x + escState.input.rect.w / 2, y: escState.input.rect.y + escState.input.rect.h / 2 }, '暫存不要送出');
    res.escTypedValue = await evaluate(cdp, `(() => { const i = document.querySelector('.ntfy-teams-aliasinput'); return i ? i.value : null; })()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await sleep(1200);
    res.afterEsc = await chipInfo();
    log('after Esc:', JSON.stringify({ name: res.afterEsc.name, dot: !!res.afterEsc.dot, cfgAliases: res.afterEsc.cfgAliases, typedDuringEsc: res.escTypedValue }));
  }

  logStep('6. CLEAR THE FIELD + ENTER -> fall back to the TOPIC NAME');
  const chip3 = (res.afterEsc && res.afterEsc.chip && res.afterEsc.chip.rect) || chip2;
  await doubleClickAt(cdp, chip3.x + chip3.w / 2, chip3.y + chip3.h / 2);
  await sleep(700);
  const clearState = JSON.parse(await evaluate(cdp, chipInfoExpr(topic)));
  res.clearInputAppeared = !!(clearState.input && clearState.input.rect);
  if (res.clearInputAppeared) {
    await typeInto(cdp, { x: clearState.input.rect.x + clearState.input.rect.w / 2, y: clearState.input.rect.y + clearState.input.rect.h / 2 }, '', { clear: true });
    res.emptiedValue = await evaluate(cdp, `(() => { const i = document.querySelector('.ntfy-teams-aliasinput'); return i ? i.value : null; })()`);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(1500);
    res.afterClear = await chipInfo();
    log('after clearing:', JSON.stringify({ name: res.afterClear.name, dot: !!res.afterClear.dot, chipTitle: res.afterClear.chip && res.afterClear.chip.title, cfgAliases: res.afterClear.cfgAliases }, null, 1));
  }

  logStep('THEME + CONSOLE');
  const bg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  res.bgBefore = bg;
  if (/rgb\((1?\d|2[0-9]), (1?\d|2[0-9]), (1?\d|2[0-9])\)/.test(bg)) res.themeRestore = await toggleTheme(cdp, '跟隨系統');
  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  const c0 = res.initial, c1 = res.editing, c2r = res.afterCommit, c3r = res.afterReload, c4 = res.afterEsc || {}, c5 = res.afterClear || {};
  res.checks = {
    initialShowsTopicName: c0.name === topic && !c0.dot,
    realDoubleClickFired: !!(c1.dblclicks && c1.dblclicks >= 1),
    aliasInputAppeared: !!(c1.input && c1.input.rect),
    placeholderIsTopic: !!(c1.input && c1.input.placeholder === topic),
    noTopicSwitch: !!res.noTopicSwitch,
    chipInsideBarWhileEditing: !!(c1.chip && c1.bar && c1.chip.rect.left >= c1.bar.rect.left - 1 && c1.chip.rect.right <= c1.bar.rect.right + 1 && !c1.bar.overflowX),
    chipDidNotJump: !!(c1.chip && c0.chip && Math.abs(c1.chip.rect.y - c0.chip.rect.y) <= 2),
    aliasShownWithoutReload: c2r.name === alias,
    aliasDotPresent: !!(c2r.dot && c2r.dot.present),
    chipTitleHasAliasAndTopic: !!(c2r.chip && c2r.chip.title && c2r.chip.title.includes(alias) && c2r.chip.title.includes(topic)),
    configPersisted: !!(c2r.cfgAliases && c2r.cfgAliases[topic] === alias),
    aliasSurvivedReload: c3r.name === alias,
    escCancelled: !!c4.name && c4.name === alias,
    clearFallsBackToTopic: c5.name === topic && !c5.dot,
    clearRemovedFromConfig: !!(c5.cfgAliases && c5.cfgAliases[topic] === undefined),
    sendWorksAliased: !!res.sendVisible,
    publishedToRealTopic: typeof res.rawLineRealTopic === 'string' && res.rawLineRealTopic.includes(`"topic":"${topic}"`) && res.rawLineOnPlainTopic === null,
    noSlotCrash: cons.slotCrash.length === 0,
  };
  res.ok = Object.values(res.checks).every(Boolean);
  logStep('TASK-9 RESULT');
  console.log(JSON.stringify({
    ok: res.ok, checks: res.checks,
    rects: { chipBefore: c0.chip && c0.chip.rect, chipEditing: c1.chip && c1.chip.rect, inputEditing: c1.input && c1.input.rect, bar: c1.bar && c1.bar.rect },
    aliasFlow: { initialName: c0.name, editingName: c1.name, afterCommitName: c2r.name, afterCommitTitle: c2r.chip && c2r.chip.title, afterReloadName: c3r.name, afterEscName: c4.name, afterClearName: c5.name },
    cfgAliases: { afterCommit: c2r.cfgAliases, afterReload: c3r.cfgAliases, afterClear: c5.cfgAliases, keys: c5.cfgKeys },
    rawLineRealTopic: res.rawLineRealTopic,
    dblclicks: c1.dblclicks,
    console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-9.json'), JSON.stringify(res, null, 2));
  return res;
}

/** task-10: shared settings block state, rects and texts */
const SETTINGS_EXPR = `(() => {
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const blocks = Array.from(document.querySelectorAll('.ntfy-teams-settings'));
  const bars = Array.from(document.querySelectorAll('.ntfy-teams-settingsbar'));
  const open = blocks.filter(b => /--open/.test(String(b.className)));
  const bar = bars[0] || null;
  const topicsBar = document.querySelector('.ntfy-teams-groupbar') || document.querySelector('.ntfy-teams-topics');
  const chips = Array.from(document.querySelectorAll('.ntfy-teams-topic'));
  const header = document.querySelector('.ntfy-teams-header');
  const stream = document.querySelector('.ntfy-teams-stream');
  const composer = document.querySelector('.ntfy-teams-compose');
  return JSON.stringify({
    settingsCount: blocks.length,
    settingsBarCount: bars.length,
    openCount: open.length,
    openCls: blocks[0] ? String(blocks[0].className) : null,
    barText: bar ? (bar.innerText || '').trim() : null,
    barItems: bar ? Array.from(bar.querySelectorAll('.ntfy-teams-settingitem')).map(s => (s.innerText || '').trim()) : [],
    note: bar ? (() => { const n = bar.querySelector('.ntfy-teams-settingnote'); return n ? (n.innerText || '').trim() : null; })() : null,
    editButton: bar ? !!Array.from(bar.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || '') === EDIT_ARIA) : false,
    // 摘要必須住在抬頭裡（需求：各種提示都放到第一個容器內）。
    barInsideHeader: !!(header && bar && header.contains(bar)),
    headerActs: header ? Array.from(header.querySelectorAll('.ntfy-teams-headeracts button')).map(b => (b.getAttribute('aria-label') || (b.innerText || '').trim())) : [],
    openHeadText: open.length ? (open[0].innerText || '').trim().slice(0, 300) : null,
    fields: { identity: !!document.getElementById('ntfy-teams-identity'), server: !!document.getElementById('ntfy-teams-server'), mode: !!document.getElementById('ntfy-teams-mode') },
    rects: { settingsBlock: blocks[0] ? R(blocks[0]) : null, settingsBar: bar ? R(bar) : null, topicsBar: topicsBar ? R(topicsBar) : null, header: header ? R(header) : null, stream: stream ? R(stream) : null, composer: composer ? R(composer) : null, firstChip: chips[0] ? R(chips[0]) : null },
    chipCount: chips.length,
    chipNames: chips.map(c => (c.querySelector('.ntfy-teams-topicname') || {}).textContent || null).filter(Boolean),
    chipTexts: chips.map(c => (c.querySelector('.ntfy-teams-topicname') || {}).textContent || null),
    activeTopicStore: (() => { const s = window.__ntfyTeamsCore && window.__ntfyTeamsCore.store; return s ? s.getSnapshot().activeTopic : null; })(),
    subtitle: (() => { const e = document.querySelector('.ntfy-teams-subtitle'); return e ? (e.innerText || '').trim() : null; })(),
    composerMeta: (() => { const e = document.querySelector('.ntfy-teams-composemeta'); return e ? (e.innerText || '').trim() : null; })(),
    // 抬頭的「共用設定」圖示按鈕已移除（跟摘要的「編輯」重複），這裡應該永遠是 null。
    gearPressed: null,
    // 抬頭的「共用設定」圖示按鈕已移除 → 永遠找不到，這裡固定 false。
    gearFound: false,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  });
})()`;

/** task-10: ONE shared settings block, collapsed by default, expand/collapse, no chip overlap */
async function modeSettings(cdp, argv) {
  const topicA = argv.topicA || TOPIC;
  const topicB = argv.topicB || 'pub_demo_alias';
  const name = argv.identity || 'sharedname';
  const res = { task: 'task-10', topicA, topicB, name, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const info = async () => JSON.parse(await evaluate(cdp, SETTINGS_EXPR));

  await navigate(cdp, GUI_URL);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep('1. SUBSCRIBE TWO TOPICS');
  res.addA = await addTopicViaPanel(cdp, topicA);
  await sleep(2200);
  res.addB = await addTopicViaPanel(cdp, topicB);
  await sleep(2800);
  // adding a topic makes IT active, so pin the active topic back to topicA — otherwise the send
  // and the live probe go to the wrong topic (this bit me on the first run of this mode)
  res.selectA = await selectTopicChip(cdp, topicA);
  await sleep(1800);
  res.collapsed = await info();
  log('active topic pinned to:', res.collapsed.activeTopicStore, '| selectA ok=', !!(res.selectA && res.selectA.ok));
  log('collapsed state:', JSON.stringify({ settingsCount: res.collapsed.settingsCount, settingsBarCount: res.collapsed.settingsBarCount, openCount: res.collapsed.openCount, barText: res.collapsed.barText, barItems: res.collapsed.barItems, note: res.collapsed.note, editButton: res.collapsed.editButton, fields: res.collapsed.fields, chipCount: res.collapsed.chipCount, chipNames: res.collapsed.chipNames, subtitle: res.collapsed.subtitle }, null, 1));

  logStep('5. RECTS: settings bar vs topic bar');
  const r = res.collapsed.rects;
  console.log('rects:', JSON.stringify(r, null, 1));
  const overlap = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  res.rectChecks = {
    settingsBarAboveTopicsBar: !!(r.settingsBar && r.topicsBar && r.settingsBar.bottom <= r.topicsBar.top + 1),
    noOverlapSettingsVsTopics: !overlap(r.settingsBar, r.topicsBar),
    noOverlapSettingsVsHeader: !overlap(r.settingsBar, r.header),
    chipsInsideViewport: !!(r.firstChip && r.firstChip.top >= 0 && r.firstChip.bottom <= res.collapsed.viewport.h),
    chipsNotPushedOffScreen: !!(r.topicsBar && r.stream && r.topicsBar.bottom <= r.stream.top + 1 && r.firstChip && r.firstChip.bottom < res.collapsed.viewport.h),
    streamStillVisible: !!(r.stream && r.stream.h > 100),
  };
  log('rect checks:', JSON.stringify(res.rectChecks));

  logStep('3. CLICK 編輯 -> fields must appear');
  res.editClick = await clickText(cdp, EDIT_ARIA, { exact: true, tags: ['button'] });
  await sleep(1400);
  res.expanded = await info();
  log('expanded state:', JSON.stringify({ openCount: res.expanded.openCount, openCls: res.expanded.openCls, fields: res.expanded.fields, openHeadText: res.expanded.openHeadText && res.expanded.openHeadText.slice(0, 160) }, null, 1));

  logStep(`SET DISPLAY NAME ${name} + 儲存`);
  const idInput = await findElement(cdp, IDENTITY_PH, { exact: false, root: 'plugin', tags: ['input'] });
  if (!idInput || idInput.missingRoot) { res.error = 'identity input not found while expanded'; console.log('FATAL', res.error); reportConsole(cdp); return res; }
  await typeInto(cdp, idInput, name, { clear: true });
  res.typed = await evaluate(cdp, `(() => { const i = document.getElementById('ntfy-teams-identity'); return i ? i.value : null; })()`);
  const save = await findElement(cdp, SAVE_LABEL, { exact: true, root: 'plugin', tags: ['button'] });
  await clickAt(cdp, save.x, save.y);
  await sleep(1600);
  res.savedNote = await evaluate(cdp, `(() => { const n = document.querySelector('.ntfy-teams-hint'); return n ? (n.innerText || '').trim() : null; })()`);
  res.expandedAfterSave = await info();
  log('after save: typed=', JSON.stringify(res.typed), 'note=', JSON.stringify(res.savedNote), 'composerMeta=', JSON.stringify(res.expandedAfterSave.composerMeta));

  logStep('4. CLICK 鉛筆再點一次 -> back to summary only');
  res.collapseClick = await clickText(cdp, EDIT_ARIA, { exact: true, tags: ['button'] });
  await sleep(1400);
  res.afterCollapse = await info();
  log('after collapse:', JSON.stringify({ openCount: res.afterCollapse.openCount, fields: res.afterCollapse.fields, barText: res.afterCollapse.barText, barItems: res.afterCollapse.barItems, composerMeta: res.afterCollapse.composerMeta, subtitle: res.afterCollapse.subtitle }, null, 1));

  logStep('6. SEND FROM THE COMPOSER -> title must be #name');
  const body = `settings send ${ts} ${rand}`;
  res.body = body;
  res.send = await sendFromComposer(cdp, body);
  res.sendVisible = await waitForText(cdp, body, 25000, 'settings-send-visible');
  await sleep(1200);
  res.rawLine = fetchTopicRaw(topicA).split(/\r?\n/).find((l) => l.includes(body)) || null;
  log('RAW line:', res.rawLine);

  logStep('LIVE PUSH STILL WORKS');
  const liveMarker = `settings live ${ts} ${rand}`;
  res.liveMarker = liveMarker;
  res.livePublish = publishRaw(liveMarker, '', topicA);
  res.liveSeen = await waitForText(cdp, liveMarker, 25000, 'settings-live');
  log('live marker visible:', res.liveSeen);

  await screenshot(cdp, path.join(OUT_DIR, '_verify-13-settings.png'));
  res.shot13 = path.join(OUT_DIR, '_verify-13-settings.png');

  logStep('7b. 鉛筆切換來回（點開 → 再點一次收起）');
  // 原本這裡在驗「抬頭那顆共用設定齒輪也是入口」。那顆按鈕已經移除：
  // 它跟摘要裡的「編輯」做同一件事，而且圖示畫得像太陽、本來就不像設定。
  // 所以現在只驗鉛筆的來回：點開 → 再點一次收起。
  const editBtn = await findElement(cdp, EDIT_ARIA, { exact: true, root: 'plugin', tags: ['button'] });
  res.editEntryFound = !!(editBtn && !editBtn.missingRoot);
  res.gearFound = false;   // 保留欄位讓下游報告不用改，值固定為「沒有齒輪」
  if (res.editEntryFound) {
    await clickAt(cdp, editBtn.x, editBtn.y);
    await sleep(1500);
    res.afterGear = await info();
    log('after 編輯 click:', JSON.stringify({ openCount: res.afterGear.openCount, fields: res.afterGear.fields }));
    if (res.afterGear.openCount > 0) {
      // 收起：同一顆鉛筆再點一次。
      await clickAt(cdp, editBtn.x, editBtn.y);
      await sleep(1000);
    }
  }

  logStep('DARK SHOT + restore theme');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1200);
  res.darkInfo = await info();
  const darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  log('dark bg:', darkBg, 'settingsBarText:', JSON.stringify(res.darkInfo.barText));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-14-settings-dark.png'));
  res.shot14 = path.join(OUT_DIR, '_verify-14-settings-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  const c1 = res.collapsed, c2 = res.expanded, c3 = res.afterCollapse;
  res.checks = {
    exactlyOneSettingsBlock: c1.settingsCount === 1,
    exactlyOneSummaryBar: c1.settingsBarCount === 1,
    collapsedByDefault: c1.openCount === 0,
    fieldsAbsentCollapsed: !c1.fields.identity && !c1.fields.server && !c1.fields.mode,
    summaryHasHost: typeof c1.barText === 'string' && c1.barText.includes('msn.feg.cn'),
    summaryHasNoAuth: c1.barItems.includes('無認證'),
    summaryHasNoName: c1.barItems.includes('尚未設定名稱'),
    // 「全部主題共用」這類說明字眼已移除（需求）→ 摘要裡不該再有那個註記。
    summaryHasNoSharedNote: c1.note === null,
    editButtonPresent: c1.editButton === true,
    twoTopicsSubscribed: c1.chipNames.length === 2,
    activeTopicPinnedToA: c1.activeTopicStore === topicA,
    settingsAboveTopics: res.rectChecks.settingsBarAboveTopicsBar,
    noOverlapWithTopics: res.rectChecks.noOverlapSettingsVsTopics,
    noOverlapWithHeader: res.rectChecks.noOverlapSettingsVsHeader,
    chipsNotPushedOffScreen: res.rectChecks.chipsNotPushedOffScreen,
    streamStillVisible: res.rectChecks.streamStillVisible,
    editExpands: c2.openCount === 1 && c2.fields.identity && c2.fields.server && c2.fields.mode,
    expandedSaysAllTopics: typeof c2.openHeadText === 'string' && c2.openHeadText.includes('所有主題生效'),
    saveTook: res.savedNote === '已儲存' && res.typed === name,
    summaryShowsNameAfterSave: typeof c3.barText === 'string' && c3.barText.includes('#' + name),
    composerShowsName: typeof c3.composerMeta === 'string' && c3.composerMeta.includes('以 #' + name + ' 的身分傳送'),
    collapseHidesFields: c3.openCount === 0 && !c3.fields.identity && !c3.fields.server && !c3.fields.mode,
    sentTitleIsHashName: typeof res.rawLine === 'string' && res.rawLine.includes(`"title":"#${name}"`),
    livePushWorks: res.liveSeen,
    noSlotCrash: cons.slotCrash.length === 0,
  };
  res.findings = {
    editEntryExpands: res.afterGear ? res.afterGear.openCount > 0 : null,
    // 抬頭的圖示入口已移除（跟摘要的「編輯」重複做同一件事）。
    gearRemoved: res.gearFound === false,
  };
  res.ok = Object.values(res.checks).every(Boolean);
  logStep('TASK-10 RESULT');
  console.log(JSON.stringify({
    ok: res.ok, checks: res.checks, findings: res.findings,
    summaryBarText: c1.barText, summaryItems: c1.barItems, subtitle: c1.subtitle,
    rects: c1.rects, rectChecks: res.rectChecks,
    expandedFields: c2.fields, expandedHead: c2.openHeadText && c2.openHeadText.slice(0, 120),
    afterCollapseBarText: c3.barText, composerMeta: c3.composerMeta,
    rawLine: res.rawLine, liveSeen: res.liveSeen,
    console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-10.json'), JSON.stringify(res, null, 2));
  return res;
}

/** per-row geometry + computed styles for the alignment checks */
const rowInfoExpr = (marker) => `(() => {
  const stream = document.querySelector('.ntfy-teams-stream');
  const rows = Array.from(document.querySelectorAll('.ntfy-teams-msg'));
  const row = rows.find(r => (r.innerText || '').includes(${JSON.stringify(marker)}));
  if (!row) return JSON.stringify({ found: false, rowCount: rows.length });
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const cs = getComputedStyle(row);
  const body = row.querySelector('.ntfy-teams-msgbody');
  const bodyCs = body ? getComputedStyle(body) : null;
  const senderEl = row.querySelector('.ntfy-teams-sender');
  return JSON.stringify({
    found: true,
    cls: String(row.className),
    flexDirection: cs.flexDirection,
    rowRect: R(row),
    bodyTextAlign: bodyCs ? bodyCs.textAlign : null,
    bodyFlex: bodyCs ? bodyCs.flex : null,
    bodyRect: R(body),
    avatarRect: R(row.querySelector('.ntfy-teams-avatar')),
    senderText: senderEl ? (senderEl.textContent || '').trim() : null,
    senderCls: senderEl ? String(senderEl.className) : null,
    clockText: (() => { const c = row.querySelector('.ntfy-teams-clock'); return c ? (c.textContent || '').trim() : null; })(),
    children: Array.from(row.children).map(c => String(c.className)),
    headingTexts: Array.from(row.querySelectorAll('.ntfy-teams-md h3')).map(h => (h.textContent || '').trim()),
    text: (row.innerText || '').slice(0, 200),
    streamRect: stream ? R(stream) : null,
    rowPad: { left: Math.round(parseFloat(cs.paddingLeft) || 0), right: Math.round(parseFloat(cs.paddingRight) || 0) },
    streamPad: stream ? { left: Math.round(parseFloat(getComputedStyle(stream).paddingLeft) || 0), right: Math.round(parseFloat(getComputedStyle(stream).paddingRight) || 0) } : null,
    contentRight: R(row) ? R(row).right - Math.round(parseFloat(cs.paddingRight) || 0) : null,
  });
})()`;

/** task-11: own messages right-aligned + `--` for a missing sender */
async function modeAlign(cdp, argv) {
  const topic = argv.topic || TOPIC;
  const name = argv.identity || 'selfprobe';
  const res = { task: 'task-11', topic, name, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const rowInfo = async (marker) => JSON.parse(await evaluate(cdp, rowInfoExpr(marker)));

  // --- stale-bundle guard: capture the served combo URL and compare it with the on-disk build ---
  const netUrls = [];
  await cdp.send('Network.enable');
  cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url); });

  await navigate(cdp, `${GUI_URL}?verify=${ts}`);   // cache-busting query
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep('STALE-BUNDLE PROOF');
  const bundleUrl = netUrls.find((u) => /ntfy-teams\/client\.js/.test(u) && u.includes('/plugins/'));
  const disk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  res.bundle = { url: bundleUrl || null, rev: bundleUrl ? ((bundleUrl.match(/rev=([0-9a-f]+)/) || [])[1] || null) : null, diskBytes: disk.length };
  if (bundleUrl) {
    const served = await (await fetch(bundleUrl)).text();
    res.bundle.servedBytes = served.length;
    res.bundle.servedContainsExactDiskBytes = served.includes(disk);
    res.bundle.servedHasRowReverseNeedle = served.includes('ntfy-teams-msg--self{flex-direction:row-reverse');
    res.bundle.servedHasAnonName = /ANON_NAME = '--'/.test(served);
    res.bundle.diskHasRowReverseNeedle = disk.includes('ntfy-teams-msg--self{flex-direction:row-reverse');
    res.bundle.diskHasAnonName = /ANON_NAME = '--'/.test(disk);
    res.bundle.diskSha256 = require('node:crypto').createHash('sha256').update(disk).digest('hex').slice(0, 16);
  }
  log('bundle proof:', JSON.stringify(res.bundle, null, 1));

  logStep('1. SUBSCRIBE + SET DISPLAY NAME THROUGH THE PANEL (編輯)');
  res.addTopic = await addTopicViaPanel(cdp, topic);
  await sleep(2500);
  res.identity = await setIdentity(cdp, name);
  log('setIdentity:', JSON.stringify({ ok: res.identity.ok, typed: res.identity.typed, via: res.identity.opened && res.identity.opened.via, summary: res.identity.summary }));
  res.selectChip = await selectTopicChip(cdp, topic);
  await sleep(1500);

  logStep('2. SEED THREE MESSAGES');
  const otherMarker = `other body ${ts} ${rand}`;
  const ownMarker = `own body ${ts} ${rand}`;
  const plainTitle = `PLAIN-TITLE-Z-${rand}`;
  const plainMarker = `plain body ${ts} ${rand}`;
  res.markers = { otherMarker, ownMarker, plainTitle, plainMarker };
  res.pubOther = publishRaw(otherMarker, '#otherguy', topic);
  res.ownSend = await sendFromComposer(cdp, ownMarker);
  res.pubPlain = publishRaw(plainMarker, plainTitle, topic);
  res.otherSeen = await waitForText(cdp, otherMarker, 25000, 'other');
  res.ownSeen = await waitForText(cdp, ownMarker, 25000, 'own');
  res.plainSeen = await waitForText(cdp, plainMarker, 25000, 'plain');
  await sleep(2000);

  logStep('3. PER-ROW GEOMETRY + COMPUTED STYLES');
  res.otherRow = await rowInfo(otherMarker);
  res.selfRow = await rowInfo(ownMarker);
  res.anonRow = await rowInfo(plainMarker);
  console.log('OTHER row:', JSON.stringify(res.otherRow));
  console.log('SELF row :', JSON.stringify(res.selfRow));
  console.log('ANON row :', JSON.stringify(res.anonRow));

  res.bodyHasUnnamed = await evaluate(cdp, `(document.body.textContent || '').includes('未具名')`);
  res.anonClassCount = await evaluate(cdp, `document.querySelectorAll('.ntfy-teams-msg--anon').length`);

  logStep('LIGHT SHOT');
  await screenshot(cdp, path.join(OUT_DIR, '_verify-15-align-light.png'));
  res.shot15 = path.join(OUT_DIR, '_verify-15-align-light.png');

  logStep('DARK SHOT + restore theme');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1200);
  res.darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  res.selfRowDark = await rowInfo(ownMarker);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-16-align-dark.png'));
  res.shot16 = path.join(OUT_DIR, '_verify-16-align-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  const o = res.otherRow, s = res.selfRow, a = res.anonRow;
  const near = (x, y, tol) => Math.abs(x - y) <= tol;
  res.checks = {
    threeRowsFound: !!(o.found && s.found && a.found),
    otherIsNotSelf: !/--self/.test(o.cls),
    otherAvatarLeftOfBody: !!(o.avatarRect && o.bodyRect && o.avatarRect.left < o.bodyRect.left),
    otherBodyNearStreamLeft: !!(o.bodyRect && o.streamRect && (o.bodyRect.left - o.streamRect.left) < 80),
    selfHasSelfClass: /ntfy-teams-msg--self/.test(s.cls),
    selfFlexRowReverse: s.flexDirection === 'row-reverse',
    selfBodyRightAligned: s.bodyTextAlign === 'right',
    selfBodyFlexNotStretch: String(s.bodyFlex).startsWith('0 1 auto'),
    selfBodyHugsRowContentRight: !!(s.bodyRect && s.contentRight && Math.abs(s.bodyRect.right - s.contentRight) <= 2),
    selfBodyDoesNotStretchLeft: !!(s.bodyRect && o.streamRect && s.bodyRect.left > (o.streamRect.left + o.streamRect.w / 2)),
    selfAvatarLeftOfBody: !!(s.avatarRect && s.bodyRect && s.avatarRect.left < s.bodyRect.left),
    selfChildrenBodyThenAvatar: Array.isArray(s.children) && s.children.length === 2 && /msgbody/.test(s.children[0]) && /avatar/.test(s.children[1]),
    anonSenderIsDashDash: a.senderText === '--',
    anonSenderClass: /ntfy-teams-sender--anon/.test(String(a.senderCls)),
    anonRowHasAvatar: !!a.avatarRect,
    anonRowNotSelf: !/--self/.test(a.cls),
    anonBodyShowsPlainTitle: Array.isArray(a.headingTexts) && a.headingTexts.includes(plainTitle),
    noUnnamedWordAnywhere: res.bodyHasUnnamed === false,
    sentTitleStillHashName: (() => { const line = fetchTopicRaw(topic).split(/\r?\n/).find((l) => l.includes(ownMarker)); return typeof line === 'string' && line.includes(`"title":"#${name}"`); })(),
    noSlotCrash: cons.slotCrash.length === 0,
    bundleNotStale: !!(res.bundle.servedContainsExactDiskBytes && res.bundle.servedHasRowReverseNeedle && res.bundle.servedHasAnonName),
  };
  res.ok = Object.values(res.checks).every(Boolean);
  res.metrics = {
    // the literal "body right edge within ~10px of the STREAM's right edge" cannot hold by design:
    // stream padding-right AND row padding-right both sit outside the row's content box.
    streamRight: o.streamRect && o.streamRect.right,
    streamPadRight: o.streamPad && o.streamPad.right,
    rowPadRight: o.rowPad && o.rowPad.right,
    selfBodyRight: s.bodyRect && s.bodyRect.right,
    selfRowContentRight: s.contentRight,
    deltaBodyRightToStreamRight: (s.bodyRect && o.streamRect) ? o.streamRect.right - s.bodyRect.right : null,
    deltaExplainedByPadding: (o.streamPad && o.rowPad) ? o.streamPad.right + o.rowPad.right : null,
    note: 'self body.right === row content-box right edge (the maximum achievable); the leftover gap is stream+row padding',
  };
  logStep('TASK-11 RESULT');
  console.log(JSON.stringify({
    ok: res.ok,
    checks: res.checks,
    bundle: res.bundle,
    rows: {
      other: { cls: o.cls, flex: o.flexDirection, avatar: o.avatarRect, body: o.bodyRect, sender: o.senderText, align: o.bodyTextAlign },
      self: { cls: s.cls, flex: s.flexDirection, avatar: s.avatarRect, body: s.bodyRect, align: s.bodyTextAlign, flexBody: s.bodyFlex, children: s.children, sender: s.senderText },
      anon: { cls: a.cls, flex: a.flexDirection, avatar: a.avatarRect, body: a.bodyRect, sender: a.senderText, headings: a.headingTexts },
      streamRect: o.streamRect,
    },
    bodyHasUnnamed: res.bodyHasUnnamed,
    metrics: res.metrics,
    console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-11.json'), JSON.stringify(res, null, 2));
  return res;
}

/** parse both rgb()/rgba() and color(srgb r g b / a) as Chrome computes color-mix() to */
function parseColorCss(css) {
  if (!css) return null;
  let m = /rgba?\(([^)]+)\)/.exec(css);
  if (m) { const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/.exec(css);
  if (m) return { r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255, a: m[4] === undefined ? 1 : parseFloat(m[4]) };
  if (css === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  return null;
}

/** ordered stream children (rows + day headers) with computed backgrounds and colour maths */
const STREAM_EXPR = `(() => {
  const stream = document.querySelector('.ntfy-teams-stream');
  if (!stream) return JSON.stringify({ found: false });
  const R = (el) => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const parse = (c) => {
    if (!c) return null;
    let m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (m) { const p = m[1].split(',').map((s) => parseFloat(s)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/.exec(c);
    if (m) return { r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255, a: m[4] === undefined ? 1 : parseFloat(m[4]) };
    if (c === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    return null;
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b)); return (l1 + 0.05) / (l2 + 0.05); };
  const rgb = (c) => c ? 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')' : null;

  const panelBg = (() => {
    let n = stream;
    while (n) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.999) return c;
      n = n.parentElement;
    }
    const b = parse(getComputedStyle(document.body).backgroundColor);
    return (b && b.a >= 0.999) ? b : { r: 255, g: 255, b: 255, a: 1 };
  })();
  const firstRowEl = stream.querySelector('.ntfy-teams-msg');
  const tok = (el, k) => { try { return el ? getComputedStyle(el).getPropertyValue(k).trim() : ''; } catch (e) { return ''; } };
  const seq = [];
  let idx = 0;
  Array.from(stream.children).forEach((child) => {
    const cls = String(child.className);
    const isMsg = /ntfy-teams-msg\\b/.test(cls) && !/ntfy-teams-msg(body|head)/.test(cls);
    if (isMsg) {
      const cs = getComputedStyle(child);
      const bg = parse(cs.backgroundColor) || { r: 0, g: 0, b: 0, a: 0 };
      const sender = child.querySelector('.ntfy-teams-sender');
      seq.push({
        kind: 'msg', index: idx, cls,
        alt: /ntfy-teams-msg--alt/.test(cls),
        self: /ntfy-teams-msg--self/.test(cls),
        anon: /ntfy-teams-msg--anon/.test(cls),
        bgRaw: cs.backgroundColor,
        bgComposite: rgb(over(bg, panelBg)),
        sender: sender ? (sender.textContent || '').trim() : null,
        rect: R(child),
        text: (child.innerText || '').slice(0, 60).replace(/\\n/g, ' '),
      });
      idx += 1;
    } else if (/ntfy-teams-day/.test(cls)) {
      seq.push({ kind: 'day', cls, label: (child.innerText || '').trim(), rect: R(child) });
    }
  });

  const msgs = seq.filter((s) => s.kind === 'msg');
  const bgOf = (i) => { const m = msgs.find((x) => x.index === i); return m ? (parse(m.bgRaw) || { r: 0, g: 0, b: 0, a: 0 }) : null; };
  const comp = (i) => { const c = bgOf(i); return c ? over(c, panelBg) : null; };
  const lumDelta = (i, j) => { const a = comp(i), b = comp(j); return (a && b) ? Math.abs(lum(a) - lum(b)) : null; };
  const contrast = (i, j) => { const a = comp(i), b = comp(j); return (a && b) ? ratio(a, b) : null; };
  const selfMsg = msgs.find((m) => m.self);
  const si = selfMsg ? selfMsg.index : null;

  return JSON.stringify({
    found: true,
    streamRect: R(stream),
    panelBgRaw: getComputedStyle(stream).backgroundColor,
    panelBgComposite: rgb(panelBg) + ' (effective base behind rows)',
    layer1: tok(firstRowEl, '--dsw-alias-bg-layer-1'),
    layer2: tok(firstRowEl, '--dsw-alias-bg-layer-2'),
    bgBase: tok(firstRowEl, '--dsw-alias-bg-base'),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    sequence: seq,
    rowCount: msgs.length,
    indices: msgs.map((m) => m.index),
    altFlags: msgs.map((m) => m.alt),
    bgRawPerIndex: msgs.map((m) => m.bgRaw),
    bgCompositePerIndex: msgs.map((m) => m.bgComposite),
    selfIndex: si,
    selfBgRaw: selfMsg ? selfMsg.bgRaw : null,
    selfBgComposite: selfMsg ? selfMsg.bgComposite : null,
    anonIndex: (msgs.find((m) => m.anon) || {}).index,
    metrics: {
      lumDelta_1_vs_0: lumDelta(1, 0),
      contrast_1_vs_0: contrast(1, 0),
      lumDelta_self_vs_base: si === null ? null : lumDelta(si, 0),
      contrast_self_vs_base: si === null ? null : contrast(si, 0),
      lumDelta_self_vs_stripe: si === null ? null : lumDelta(si, 1),
    },
    dayHeaders: seq.filter((s) => s.kind === 'day').map((d) => ({ label: d.label, rect: d.rect })),
    seqOrder: seq.map((s) => s.kind === 'day' ? 'DAY:' + (s.label || '') : 'msg#' + s.index + (s.alt ? '(alt)' : '')),
  });
})()`;

/** task-12: subtle alternating row background */
async function modeStripe(cdp, argv) {
  const name = argv.identity || 'stripeprobe';
  const topic = argv.topic || `pub_stripe_${Date.now().toString(36)}`;
  const res = { task: 'task-12', topic, name, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);

  const netUrls = [];
  await cdp.send('Network.enable');
  cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url); });

  await navigate(cdp, `${GUI_URL}?verify=${ts}`);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep('STALE-BUNDLE PROOF');
  const bundleUrl = netUrls.find((u) => /ntfy-teams\/client\.js/.test(u) && u.includes('/plugins/'));
  const disk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  res.bundle = { rev: bundleUrl ? ((bundleUrl.match(/rev=([0-9a-f]+)/) || [])[1] || null) : null, diskBytes: disk.length };
  if (bundleUrl) {
    const served = await (await fetch(bundleUrl)).text();
    res.bundle.servedBytes = served.length;
    res.bundle.servedContainsExactDiskBytes = served.includes(disk);
    res.bundle.servedHasAltStripeNeedle = served.includes('.ntfy-teams-msg--alt{background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%');
    res.bundle.servedHasAltFlag = /alt: rowIndex % 2 === 1/.test(served);
    res.bundle.diskHasAltStripeNeedle = disk.includes('.ntfy-teams-msg--alt{background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%');
    res.bundle.diskSha256 = require('node:crypto').createHash('sha256').update(disk).digest('hex').slice(0, 16);
  }
  log('bundle proof:', JSON.stringify({ rev: res.bundle.rev, servedBytes: res.bundle.servedBytes, exactDiskBytes: res.bundle.servedContainsExactDiskBytes, stripeNeedle: res.bundle.servedHasAltStripeNeedle, altFlag: res.bundle.servedHasAltFlag, sha: res.bundle.diskSha256 }));

  logStep('1. SUBSCRIBE A FRESH EMPTY TOPIC + SET IDENTITY VIA PANEL');
  res.addTopic = await addTopicViaPanel(cdp, topic);
  await sleep(2500);
  res.identity = await setIdentity(cdp, name);
  await sleep(1200);

  logStep('SEED 3 YESTERDAY + 4 TODAY (store API) THEN SEND ONE OWN MESSAGE');
  const now = Math.floor(Date.now() / 1000);
  const day = now - 86400;
  const mk = (i, t, title, msg) => ({ id: `stripe_${ts}_${i}`, time: t, expires: t + 3600, event: 'message', topic, title: title || '', message: msg, tags: [], priority: 3, source: 'history', server: 'https://msn.feg.cn' });
  const seeded = [
    mk(1, day - 300, '#olderone', `yesterday A ${rand}`),
    mk(2, day - 200, '', `yesterday B ${rand}`),
    mk(3, day - 100, 'PLAIN-STRIPE-' + rand, `yesterday C ${rand}`),
    mk(4, now - 400, '#todayone', `today A ${rand}`),
    mk(5, now - 300, '', `today B ${rand}`),
    mk(6, now - 200, '#todaytwo', `today C ${rand}`),
    mk(7, now - 100, '', `today D ${rand}`),
  ];
  res.seeded = await evaluate(cdp, `(() => {
    const c = window.__ntfyTeamsCore;
    if (!c || !c.store || typeof c.store.addMessages !== 'function') return 'NO_CORE';
    return String(c.store.addMessages(${JSON.stringify(topic)}, ${JSON.stringify(seeded)}, 'history'));
  })()`);
  log('store.addMessages(history) added:', res.seeded);
  await sleep(1800);
  if (String(res.seeded) === '0') {
    log('WARN: store added 0 rows — already present for this topic? using a fresh topic name is required');
  }

  const ownMarker = `own stripe ${ts} ${rand}`;
  res.ownMarker = ownMarker;
  res.ownSend = await sendFromComposer(cdp, ownMarker);
  res.ownSeen = await waitForText(cdp, ownMarker, 25000, 'own-stripe');
  await sleep(2500);

  logStep('2. ORDERED STREAM + COMPUTED BACKGROUNDS');
  res.stream = JSON.parse(await evaluate(cdp, STREAM_EXPR));
  console.log('sequence   :', JSON.stringify(res.stream.seqOrder));
  console.log('altFlags   :', JSON.stringify(res.stream.altFlags));
  console.log('bgRaw      :', JSON.stringify(res.stream.bgRawPerIndex));
  console.log('bgComposite:', JSON.stringify(res.stream.bgCompositePerIndex));
  console.log('layer1=', JSON.stringify(res.stream.layer1), 'layer2=', JSON.stringify(res.stream.layer2), 'panelBg=', JSON.stringify(res.stream.panelBgRaw));
  console.log('selfIndex=', res.stream.selfIndex, 'selfBgRaw=', JSON.stringify(res.stream.selfBgRaw), 'anonIndex=', res.stream.anonIndex);
  console.log('metrics:', JSON.stringify(res.stream.metrics));
  console.log('dayHeaders:', JSON.stringify(res.stream.dayHeaders));

  logStep('5. HOVER TEST');
  const stripeRow = (res.stream.sequence || []).find((s) => s.kind === 'msg' && s.alt && !s.self);
  const selfRow = (res.stream.sequence || []).find((s) => s.kind === 'msg' && s.self);
  const hoverProbe = async (row) => {
    if (!row) return null;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: row.rect.left + Math.round(row.rect.w / 2), y: row.rect.top + Math.round(row.rect.h / 2) });
    await sleep(800);
    const bg = await evaluate(cdp, `(() => { const rows = Array.from(document.querySelectorAll('.ntfy-teams-msg')); const r = rows[${row.index}]; return r ? getComputedStyle(r).backgroundColor : null; })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 });
    await sleep(600);
    return bg;
  };
  res.hoverStripe = stripeRow ? { before: stripeRow.bgRaw, after: await hoverProbe(stripeRow) } : null;
  res.hoverSelf = selfRow ? { before: selfRow.bgRaw, after: await hoverProbe(selfRow) } : null;
  log('hover striped:', JSON.stringify(res.hoverStripe));
  log('hover self   :', JSON.stringify(res.hoverSelf));

  logStep('LIGHT SHOT');
  await screenshot(cdp, path.join(OUT_DIR, '_verify-20-stripe2-light.png'));
  res.shot20 = path.join(OUT_DIR, '_verify-20-stripe2-light.png');

  logStep('DARK SHOT + restore theme');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1300);
  res.darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  res.streamDark = JSON.parse(await evaluate(cdp, STREAM_EXPR));
  log('dark bgRaw:', JSON.stringify(res.streamDark.bgRawPerIndex), 'layer1=', JSON.stringify(res.streamDark.layer1), 'layer2=', JSON.stringify(res.streamDark.layer2));
  res.hoverSelfDark = selfRow ? { before: (res.streamDark.sequence.find((s) => s.kind === 'msg' && s.self) || {}).bgRaw, after: await hoverProbe(selfRow) } : null;
  log('hover self (dark):', JSON.stringify(res.hoverSelfDark));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-21-stripe2-dark.png'));
  res.shot21 = path.join(OUT_DIR, '_verify-21-stripe2-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  if (argv.suggest === true || argv.suggest === 'true') {   // opt-in: the build is now the fix itself
    logStep('AESTHETIC PREVIEW: candidate stripe = label-primary at 3% (temporary <style>, plugin untouched)');
    const tokRead = async () => evaluate(cdp, `(() => { const r = document.querySelector('.ntfy-teams-msg'); return r ? JSON.stringify({ labelPrimary: getComputedStyle(r).getPropertyValue('--dsw-alias-label-primary').trim(), layer1: getComputedStyle(r).getPropertyValue('--dsw-alias-bg-layer-1').trim(), layer2: getComputedStyle(r).getPropertyValue('--dsw-alias-bg-layer-2').trim() }) : null; })()`);
    const applyCandidate = () => evaluate(cdp, `(() => {
      let s = document.getElementById('__stripe_preview');
      if (!s) { s = document.createElement('style'); s.id = '__stripe_preview'; document.head.appendChild(s); }
      // NOTE: no !important, and the --self rules are repeated AFTER --alt so the preview mirrors the
      // plugin's own rule order (where --self intentionally wins over the stripe).
      s.textContent = '.ntfy-teams-msg--alt{background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);}'
        + '.ntfy-teams-msg--alt:hover{background:var(--dsw-alias-bg-layer-1);}'
        + '.ntfy-teams-msg--self{background:var(--dsw-alias-bg-layer-1);}'
        + '.ntfy-teams-msg--self:hover{background:var(--dsw-alias-bg-layer-2);}';
      return true;
    })()`);
    res.suggest = { pct: 3, tokensLight: JSON.parse((await tokRead()) || '{}') };
    await applyCandidate();
    await sleep(900);
    res.suggest.light = JSON.parse(await evaluate(cdp, STREAM_EXPR));
    await screenshot(cdp, path.join(OUT_DIR, '_verify-19-stripe-suggested-light.png'));
    res.shot19 = path.join(OUT_DIR, '_verify-19-stripe-suggested-light.png');
    await toggleTheme(cdp, '深色');
    await sleep(1200);
    res.suggest.tokensDark = JSON.parse((await tokRead()) || '{}');
    await applyCandidate();
    await sleep(700);
    res.suggest.dark = JSON.parse(await evaluate(cdp, STREAM_EXPR));
    res.themeRestore2 = await toggleTheme(cdp, '跟隨系統');
    await evaluate(cdp, `(() => { const s = document.getElementById('__stripe_preview'); if (s) s.remove(); return true; })()`);
    const si = (o) => o.altFlags.indexOf(true);
    const selfStillSolid = (o) => { const c = parseColorCss(o.selfBgRaw); const s = parseColorCss(o.bgRawPerIndex[si(o)]); return !!c && c.a === 1 && !!s && s.a < 1 && c.r !== s.r; };
    res.suggest.result = {
      light: { stripeRaw: res.suggest.light.bgRawPerIndex[si(res.suggest.light)], composite: res.suggest.light.bgCompositePerIndex[si(res.suggest.light)], baseComposite: res.suggest.light.bgCompositePerIndex[0], lumDelta: res.suggest.light.metrics.lumDelta_1_vs_0, contrast: res.suggest.light.metrics.contrast_1_vs_0, tokens: res.suggest.tokensLight, selfBgRaw: res.suggest.light.selfBgRaw, selfStillSolid: selfStillSolid(res.suggest.light) },
      dark: { stripeRaw: res.suggest.dark.bgRawPerIndex[si(res.suggest.dark)], composite: res.suggest.dark.bgCompositePerIndex[si(res.suggest.dark)], baseComposite: res.suggest.dark.bgCompositePerIndex[0], lumDelta: res.suggest.dark.metrics.lumDelta_1_vs_0, contrast: res.suggest.dark.metrics.contrast_1_vs_0, tokens: res.suggest.tokensDark, selfBgRaw: res.suggest.dark.selfBgRaw, selfStillSolid: selfStillSolid(res.suggest.dark) },
    };
    log('suggested 3% ink stripe → light:', JSON.stringify(res.suggest.result.light));
    log('suggested 3% ink stripe → dark :', JSON.stringify(res.suggest.result.dark));
  }

  const st = res.stream;
  const expectedAlt = st.indices.map((i) => i % 2 === 1);
  // a day header that genuinely sits BETWEEN two messages (there is also a leading header)
  const boundary = (() => {
    for (let i = 1; i < st.sequence.length - 1; i += 1) {
      if (st.sequence[i].kind === 'day') {
        const before = st.sequence.slice(0, i).filter((s) => s.kind === 'msg').pop();
        const after = st.sequence.slice(i + 1).find((s) => s.kind === 'msg');
        if (before && after) return { before, after, header: st.sequence[i] };
      }
    }
    return null;
  })();
  const beforeDay = boundary && boundary.before;
  const afterDay = boundary && boundary.after;
  const stripeIdx0 = st.altFlags.indexOf(true);
  const selfRowInfo = (st.sequence || []).find((s) => s.kind === 'msg' && s.self);
  const stripeC = parseColorCss(st.bgRawPerIndex[stripeIdx0]) || { r: 0, g: 0, b: 0, a: 0 };
  const selfC = parseColorCss(st.selfBgRaw) || { r: 0, g: 0, b: 0, a: 0 };
  const sameRgb = (a, b) => Math.round(a.r) === Math.round(b.r) && Math.round(a.g) === Math.round(b.g) && Math.round(a.b) === Math.round(b.b);
  res.checks = {
    eightRows: st.rowCount === 8,
    dayHeaderPresent: st.dayHeaders.length >= 1,
    altFlagsExpected: JSON.stringify(st.altFlags) === JSON.stringify(expectedAlt),
    noTwoAdjacentStriped: st.altFlags.every((v, i) => i === 0 || !(v && st.altFlags[i - 1])),
    // continuity: a per-day reset would make the first row after the header non-alt. With the
    // preceding row non-alt (3-row first day), a continued alternation must flip it to alt.
    alternationContinuesAcrossDayHeader: !!(beforeDay && afterDay && afterDay.alt === !beforeDay.alt && afterDay.alt === true),
    stripeDiffersFromBase: st.bgRawPerIndex[stripeIdx0] !== st.bgRawPerIndex[0],
    stripeConsistentAcrossRows: (() => { const s = st.bgRawPerIndex.filter((_, i) => st.altFlags[i] && i !== st.selfIndex); return new Set(s).size === 1; })(),
    baseConsistentAcrossRows: (() => { const s = st.bgRawPerIndex.filter((_, i) => !st.altFlags[i]); return new Set(s).size === 1; })(),
    selfOverridesStripe: !!(selfRowInfo && selfRowInfo.self && st.selfBgRaw && st.selfBgRaw !== st.bgRawPerIndex[stripeIdx0]),
    // the self row uses the token at 100%: its solid rgb equals the stripe's base rgb at alpha 1
    // the self row is opaque layer-1 and must NOT resolve to the stripe's colour.
    // (Before task-13 the stripe was layer-1@45%; now it is a 3% ink mix, so compare composited
    //  results rather than raw RGB equality with the stripe colour.)
    selfOpaqueAndNotStripe: selfC.a === 1 && st.bgCompositePerIndex[st.selfIndex] !== st.bgCompositePerIndex[stripeIdx0],
    anonRowPresent: st.anonIndex !== undefined,
    stripeIsTranslucent: stripeC.a > 0 && stripeC.a < 1,
    lightStripeVisible: st.metrics.contrast_1_vs_0 >= 1.02,
    darkStripeVisible: res.streamDark.metrics.contrast_1_vs_0 >= 1.02,
    selfSolidInLight: selfC.a === 1,
    selfSolidInDark: (() => { const c = parseColorCss(res.streamDark.selfBgRaw); return !!c && c.a === 1; })(),
    hoverChangesStriped: !!(res.hoverStripe && res.hoverStripe.before !== res.hoverStripe.after),
    selfHoverChangesInLight: !!(res.hoverSelf && res.hoverSelf.before !== res.hoverSelf.after),
    selfHoverChangesInDark: !!(res.hoverSelfDark && res.hoverSelfDark.before !== res.hoverSelfDark.after),
    darkStripeDiffers: res.streamDark.bgRawPerIndex[res.streamDark.altFlags.indexOf(true)] !== res.streamDark.bgRawPerIndex[res.streamDark.altFlags.indexOf(false)],
    noSlotCrash: cons.slotCrash.length === 0,
    bundleNotStale: !!(res.bundle.servedContainsExactDiskBytes && res.bundle.servedHasAltStripeNeedle && res.bundle.servedHasAltFlag),
  };
  res.ok = Object.values(res.checks).every(Boolean);
  res.aesthetic = {
    light: { stripe: st.bgCompositePerIndex[stripeIdx0], base: st.bgCompositePerIndex[0], lumDelta: st.metrics.lumDelta_1_vs_0, contrastRatio: st.metrics.contrast_1_vs_0 },
    dark: (() => { const d = res.streamDark; const si = d.altFlags.indexOf(true); return { stripe: d.bgCompositePerIndex[si], base: d.bgCompositePerIndex[0], lumDelta: d.metrics.lumDelta_1_vs_0, contrastRatio: d.metrics.contrast_1_vs_0 }; })(),
    selfVsBaseLight: { lumDelta: st.metrics.lumDelta_self_vs_base, contrastRatio: st.metrics.contrast_self_vs_base },
  };
  logStep('TASK-12 RESULT');
  console.log(JSON.stringify({
    ok: res.ok, checks: res.checks, aesthetic: res.aesthetic,
    altFlags: st.altFlags, bgRaw: st.bgRawPerIndex, bgComposite: st.bgCompositePerIndex,
    layer1Light: st.layer1, layer1Dark: res.streamDark.layer1, seqOrder: st.seqOrder,
    dayHeaders: st.dayHeaders, selfIndex: st.selfIndex, selfBgRaw: st.selfBgRaw,
    hover: { striped: res.hoverStripe, self: res.hoverSelf },
    console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-12.json'), JSON.stringify(res, null, 2));
  return res;
}

/** per-row avatar/clock/body geometry + clock legibility maths */
const CLOCK_EXPR = `(() => {
  const stream = document.querySelector('.ntfy-teams-stream');
  if (!stream) return JSON.stringify({ found: false });
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const parse = (c) => {
    if (!c) return null;
    let m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (m) { const p = m[1].split(',').map((s) => parseFloat(s)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/.exec(c);
    if (m) return { r: parseFloat(m[1]) * 255, g: parseFloat(m[2]) * 255, b: parseFloat(m[3]) * 255, a: m[4] === undefined ? 1 : parseFloat(m[4]) };
    return null;
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const l1 = Math.max(lum(a), lum(b)), l2 = Math.min(lum(a), lum(b)); return (l1 + 0.05) / (l2 + 0.05); };
  const opaqueBg = (el) => { let n = el; while (n) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a >= 0.999) return c; n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const rowBgOf = (row) => { const c = parse(getComputedStyle(row).backgroundColor) || { r: 0, g: 0, b: 0, a: 0 }; return over(c, opaqueBg(row.parentElement || row)); };
  const rows = Array.from(document.querySelectorAll('.ntfy-teams-msg'));
  const streamCs = getComputedStyle(stream);
  const dayHeaders = Array.from(stream.children).filter((c) => /ntfy-teams-day/.test(String(c.className)));
  const emptyEl = stream.querySelector('.ntfy-teams-empty') || document.querySelector('.ntfy-teams-empty');
  return JSON.stringify({
    found: true,
    stream: R(stream),
    streamScrollW: stream.scrollWidth,
    streamClientW: stream.clientWidth,
    streamPad: {
      left: parseFloat(streamCs.paddingLeft) || 0,
      right: parseFloat(streamCs.paddingRight) || 0,
      top: parseFloat(streamCs.paddingTop) || 0,
      bottom: parseFloat(streamCs.paddingBottom) || 0,
      raw: streamCs.padding,
    },
    dayHeaders: dayHeaders.map((d) => ({ label: (d.innerText || '').trim(), rect: R(d) })),
    empty: emptyEl ? { rect: R(emptyEl), title: (emptyEl.innerText || '').trim().slice(0, 120) } : null,
    rows: rows.map((row, i) => {
      const cls = String(row.className);
      const av = row.querySelector('.ntfy-teams-avatar');
      const box = row.querySelector('.ntfy-teams-msgav');
      const clk = row.querySelector('.ntfy-teams-clock');
      const body = row.querySelector('.ntfy-teams-msgbody');
      const head = row.querySelector('.ntfy-teams-msghead');
      const headClk = head ? head.querySelector('.ntfy-teams-clock') : null;
      const cs = clk ? getComputedStyle(clk) : null;
      const fg = cs ? parse(cs.color) : null;
      const bg = rowBgOf(row);
      const cr = R(clk), ar = R(av), br = R(box);
      return {
        i, cls, self: /--self/.test(cls), anon: /--anon/.test(cls),
        row: R(row), avatar: ar, box: br, clock: cr, body: R(body),
        text: (row.innerText || '').slice(0, 90).replace(/\\n/g, ' '),
        clockText: clk ? (clk.textContent || '') : null,
        clockInBox: !!(clk && box && box.contains(clk)),
        clockInHead: !!headClk,
        clockBelowAvatar: !!(cr && ar && cr.top >= ar.bottom - 1),
        clockFontSize: cs ? cs.fontSize : null,
        clockLineHeight: cs ? cs.lineHeight : null,
        clockColor: cs ? cs.color : null,
        clockContrast: (fg && bg) ? Number(ratio(fg, bg).toFixed(3)) : null,
        msgavWidth: br ? br.w : null,
        avatarWidth: ar ? ar.w : null,
        padRight: parseFloat(getComputedStyle(row).paddingRight) || 0,
        senderW: (() => { const s = row.querySelector('.ntfy-teams-sender'); return s ? Math.round(s.getBoundingClientRect().width) : null; })(),
        senderText: (() => { const s = row.querySelector('.ntfy-teams-sender'); return s ? (s.textContent || '').trim() : null; })(),
        boxChildren: box ? Array.from(box.children).map((c) => String(c.className)) : null,
      };
    }),
  });
})()`;

/** task-14: timestamp under the avatar — the alignment ("tidy") claim */
async function modeClock(cdp, argv) {
  const name = argv.identity || 'clockprobe';
  const topic = argv.topic || `pub_clock_${Date.now().toString(36)}`;
  const res = { task: 'task-14', topic, name, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);

  const netUrls = [];
  await cdp.send('Network.enable');
  cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url); });

  await navigate(cdp, `${GUI_URL}?verify=${ts}`);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep('STALE-BUNDLE PROOF');
  const bundleUrl = netUrls.find((u) => /ntfy-teams\/client\.js/.test(u) && u.includes('/plugins/'));
  const disk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  res.bundle = { rev: bundleUrl ? ((bundleUrl.match(/rev=([0-9a-f]+)/) || [])[1] || null) : null, diskBytes: disk.length };
  if (bundleUrl) {
    const served = await (await fetch(bundleUrl)).text();
    res.bundle.servedBytes = served.length;
    res.bundle.servedContainsExactDiskBytes = served.includes(disk);
    res.bundle.servedHasMsgavNeedle = served.includes('.ntfy-teams-msgav{display:flex;flex-direction:column');
    res.bundle.servedHasMsgavClass = served.includes('ntfy-teams-msgav');
    res.bundle.diskHasMsgavNeedle = disk.includes('.ntfy-teams-msgav{display:flex;flex-direction:column');
    res.bundle.diskSha256 = require('node:crypto').createHash('sha256').update(disk).digest('hex').slice(0, 16);
  }
  log('bundle proof:', JSON.stringify({ rev: res.bundle.rev, exactDiskBytes: res.bundle.servedContainsExactDiskBytes, msgavNeedle: res.bundle.servedHasMsgavNeedle, sha: res.bundle.diskSha256 }));

  logStep('1. SUBSCRIBE + SET IDENTITY VIA PANEL');
  res.addTopic = await addTopicViaPanel(cdp, topic);
  await sleep(2500);
  res.identity = await setIdentity(cdp, name);
  await sleep(1200);

  logStep('SEED: short name, long name, no-sender, TALL body, NO-TIME row, then one own message');
  const now = Math.floor(Date.now() / 1000);
  const mk = (i, t, title, msg, extra) => Object.assign({ id: `clock_${ts}_${i}`, time: t, expires: t + 3600, event: 'message', topic, title: title || '', message: msg, tags: [], priority: 3, source: 'history', server: 'https://msn.feg.cn' }, extra || {});
  const tallBody = 'tall body ' + rand + '\n\n```js\n' + Array.from({ length: 6 }, (_, k) => `line ${k} of the code block`).join('\n') + '\n```';
  const seeded = [
    mk(1, now - 900, '#a', `short name ${rand}`),
    mk(2, now - 800, '#alongnamehere', `long name ${rand}`),
    mk(3, now - 700, '', `no sender ${rand}`),
    mk(4, now - 600, '#tallbody', tallBody),
    mk(5, now - 500, '#notimeprobe', `no time field ${rand}`, { id: `clocknotime_${ts}` }),
  ];
  delete seeded[4].time;   // the no-time row must genuinely lack the field
  res.seeded = await evaluate(cdp, `(() => {
    const c = window.__ntfyTeamsCore;
    if (!c || !c.store || typeof c.store.addMessages !== 'function') return 'NO_CORE';
    return String(c.store.addMessages(${JSON.stringify(topic)}, ${JSON.stringify(seeded)}, 'history'));
  })()`);
  log('store.addMessages(history) added:', res.seeded);
  await sleep(1800);

  const ownMarker = `own clock ${ts} ${rand}`;
  res.ownMarker = ownMarker;
  res.ownSend = await sendFromComposer(cdp, ownMarker);
  res.ownSeen = await waitForText(cdp, ownMarker, 25000, 'own-clock');
  await sleep(2500);

  logStep('2/3/4. PER-ROW GEOMETRY');
  res.themeGuardLight = await ensureTheme(cdp, 'light');
  log('theme guard (light phase):', JSON.stringify(res.themeGuardLight));
  res.light = JSON.parse(await evaluate(cdp, CLOCK_EXPR));
  for (const r of res.light.rows) {
    const av = r.avatar ? `${r.avatar.left}-${r.avatar.right}` : 'none';
    const ck = r.clock ? `${r.clock.left}-${r.clock.right}` : 'NO-CLOCK-ELEMENT';
    const bl = r.body ? r.body.left : 'none';
    log(`#${r.i} ${r.self ? 'SELF' : r.anon ? 'ANON' : '    '} avatar=${av} bodyLeft=${bl} clock=${ck} text=${JSON.stringify(r.clockText)} inBox=${r.clockInBox} inHead=${r.clockInHead} belowAvatar=${r.clockBelowAvatar} fs=${r.clockFontSize} contrast=${r.clockContrast} msgavW=${r.msgavWidth} avatarW=${r.avatarWidth}`);
  }

  logStep('9. LIGHT SHOT');
  await screenshot(cdp, path.join(OUT_DIR, '_verify-22-clock-light.png'));
  res.shot22 = path.join(OUT_DIR, '_verify-22-clock-light.png');

  logStep('9. DARK SHOT + restore theme');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1300);
  res.darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  res.dark = JSON.parse(await evaluate(cdp, CLOCK_EXPR));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-23-clock-dark.png'));
  res.shot23 = path.join(OUT_DIR, '_verify-23-clock-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  const L = res.light.rows;
  const nonOwn = L.filter((r) => !r.self);
  const own = L.find((r) => r.self);
  // identify rows by their body text; the no-time row now has NO clock element at all
  const findText = (needle) => L.find((r) => String(r.text || '').includes(needle));
  const noTime = findText('no time field');
  const shortRow = findText('short name');
  const timed = L.filter((r) => r !== noTime);
  const avatarLefts = nonOwn.map((r) => r.avatar.left);
  const bodyLefts = nonOwn.map((r) => r.body.left);
  const spread = (a) => Math.max(...a) - Math.min(...a);
  res.checks = {
    sixRows: L.length === 6,
    clockAlwaysInMsgavBox: timed.every((r) => r.clockInBox === true),
    clockNeverInMsghead: L.every((r) => r.clockInHead === false),
    clockBelowAvatarEveryRow: timed.every((r) => r.clockBelowAvatar === true),
    msgavChildOrderAvatarThenClock: timed.every((r) => Array.isArray(r.boxChildren) && /avatar/.test(String(r.boxChildren[0])) && /clock/.test(String(r.boxChildren[1]))),
    nonOwnAvatarLeftIdentical: spread(avatarLefts) === 0,
    nonOwnBodyLeftIdentical: spread(bodyLefts) === 0,
    // names really do differ in width, while avatar/body left stay identical (body is a stretched
    // flex item, so its WIDTH is constant by design — the name span is where the variation shows)
    variedNameWidths: new Set(nonOwn.map((r) => r.senderW)).size >= 2,
    ownRowRightAligned: !!(own && Math.abs(own.body.right - (own.row.right - 7)) <= 2),
    ownClockOnRightHalf: !!(own && res.light.stream && own.clock.left > res.light.stream.left + res.light.stream.w / 2),
    msgavWidthMatchesSpec: L.every((r) => r.msgavWidth === 38),
    noHorizontalOverflow: res.light.streamScrollW <= res.light.streamClientW + 1,
    clockTextIsTime: timed.every((r) => /\d{1,2}:\d{2}/.test(String(r.clockText || ''))),
    // task-14 follow-up fix: a row with NO time must render NO clock element (not an empty one)
    noTimeRowFound: !!noTime,
    noTimeRowHasNoClockElement: !!(noTime && noTime.clockText === null && !noTime.clock && Array.isArray(noTime.boxChildren) && noTime.boxChildren.length === 1 && /avatar/.test(String(noTime.boxChildren[0]))),
    // the no-time row must not be TALLER than a comparable single-line row: that is what a stray
    // empty clock box would cause. (It is legitimately ~6px shorter: the avatar-only column is
    // 34px tall vs 48px for avatar+clock, while the body is 42px either way.)
    noTimeRowNotTallerThanSingleLineRow: !!(noTime && shortRow && noTime.row.h <= shortRow.row.h),
    noTimeRowDoesNotMisalignOthers: spread(avatarLefts) === 0 && spread(bodyLefts) === 0,
    clockLegibleLight: timed.every((r) => typeof r.clockContrast === 'number' && r.clockContrast >= 4.5),
    clockLegibleDark: res.dark.rows.filter((r) => r.clockText !== null).every((r) => typeof r.clockContrast === 'number' && r.clockContrast >= 4.5),
    noSlotCrash: cons.slotCrash.length === 0,
    bundleNotStale: !!(res.bundle.servedContainsExactDiskBytes && res.bundle.servedHasMsgavNeedle && res.bundle.servedHasMsgavClass),
  };
  res.ok = Object.values(res.checks).every(Boolean);
  res.metrics = {
    avatarLefts, bodyLefts,
    avatarLeftSpread: spread(avatarLefts),
    bodyLeftSpread: spread(bodyLefts),
    ownClock: own ? own.clock : null,
    ownBody: own ? own.body : null,
    noTimeRow: noTime ? { i: noTime.i, clockText: noTime.clockText, clockElementPresent: !!noTime.clock, boxChildren: noTime.boxChildren, rowH: noTime.row.h, boxH: noTime.box.h } : null,
    shortRowH: shortRow ? shortRow.row.h : null,
    senderWidths: nonOwn.map((r) => ({ name: r.senderText, w: r.senderW })),
    noTimeRowVsShortRowHeight: (noTime && shortRow) ? { noTime: noTime.row.h, short: shortRow.row.h } : null,
    lightClockFontSize: timed[0] && timed[0].clockFontSize,
    lightClockContrast: timed.map((r) => r.clockContrast),
    darkClockContrast: res.dark.rows.filter((r) => r.clockText !== null).map((r) => r.clockContrast),
    darkClockFontSize: (res.dark.rows.find((r) => r.clockText !== null) || {}).clockFontSize,
    rowHeights: L.map((r) => r.row.h),
  };
  logStep('TASK-14 RESULT');
  console.log(JSON.stringify({
    ok: res.ok, checks: res.checks, metrics: res.metrics,
    rows: L.map((r) => ({ i: r.i, self: r.self, anon: r.anon, avatarLeft: r.avatar.left, bodyLeft: r.body.left, clock: r.clock, clockText: r.clockText, clockBelowAvatar: r.clockBelowAvatar, clockInHead: r.clockInHead, msgavW: r.msgavWidth, avatarW: r.avatarWidth, contrast: r.clockContrast, h: r.row.h })),
    bundle: res.bundle, console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-14.json'), JSON.stringify(res, null, 2));
  return res;
}

/** the theme preference is HOST-GLOBAL, so a run may start in either theme. Force the expected one
 *  before measuring, otherwise a "light" phase can silently record dark values. */
async function ensureTheme(cdp, want = 'light') {
  const bg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  const isDark = /rgb\((1?\d|2[0-9]), (1?\d|2[0-9]), (1?\d|2[0-9])\)/.test(bg);
  const ok = want === 'dark' ? isDark : !isDark;
  if (ok) return { changed: false, bg, theme: isDark ? 'dark' : 'light' };
  const r = await toggleTheme(cdp, want === 'dark' ? '深色' : '跟隨系統');
  await sleep(900);
  const bg2 = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  return { changed: true, from: bg, bg: bg2, theme: want, toggle: r };
}

/** task-15: asymmetric stream padding (right larger) + alignment must survive */
async function modePadding(cdp, argv) {
  const name = argv.identity || 'padprobe';
  const topicA = argv.topic || `pub_pad_${Date.now().toString(36)}`;
  const topicEmpty = `${topicA}_empty`;
  const res = { task: 'task-15', topicA, topicEmpty, name, ok: false };
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);

  const netUrls = [];
  await cdp.send('Network.enable');
  cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url); });

  await navigate(cdp, `${GUI_URL}?verify=${ts}`);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep('STALE-BUNDLE PROOF');
  const bundleUrl = netUrls.find((u) => /ntfy-teams\/client\.js/.test(u) && u.includes('/plugins/'));
  const disk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  res.bundle = { rev: bundleUrl ? ((bundleUrl.match(/rev=([0-9a-f]+)/) || [])[1] || null) : null, diskBytes: disk.length };
  if (bundleUrl) {
    const served = await (await fetch(bundleUrl)).text();
    res.bundle.servedBytes = served.length;
    res.bundle.servedContainsExactDiskBytes = served.includes(disk);
    res.bundle.servedHasPaddingNeedle = served.includes('.ntfy-teams-stream{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 44px 20px 26px');
    res.bundle.diskHasPaddingNeedle = disk.includes('padding:16px 44px 20px 26px');
    res.bundle.diskSha256 = require('node:crypto').createHash('sha256').update(disk).digest('hex').slice(0, 16);
  }
  log('bundle proof:', JSON.stringify({ rev: res.bundle.rev, exactDiskBytes: res.bundle.servedContainsExactDiskBytes, paddingNeedle: res.bundle.servedHasPaddingNeedle, sha: res.bundle.diskSha256 }));

  logStep('SETUP: subscribe + identity + seed (short, tall, day header) + own send');
  res.addTopic = await addTopicViaPanel(cdp, topicA);
  await sleep(2500);
  res.identity = await setIdentity(cdp, name);
  await sleep(1000);
  const now = Math.floor(Date.now() / 1000);
  const day = now - 86400;
  const mk = (i, t, title, msg) => ({ id: `pad_${ts}_${i}`, time: t, expires: t + 3600, event: 'message', topic: topicA, title: title || '', message: msg, tags: [], priority: 3, source: 'history', server: 'https://msn.feg.cn' });
  const tallBody = 'tall body ' + rand + '\n\n```js\n' + Array.from({ length: 5 }, (_, k) => `line ${k}`).join('\n') + '\n```';
  const seeded = [
    mk(1, day - 100, '#yesterdayguy', `yesterday short ${rand}`),
    mk(2, now - 300, '#tallguy', tallBody),
    mk(3, now - 200, '', `today no sender ${rand}`),
  ];
  res.seeded = await evaluate(cdp, `(() => {
    const c = window.__ntfyTeamsCore;
    if (!c || !c.store || typeof c.store.addMessages !== 'function') return 'NO_CORE';
    return String(c.store.addMessages(${JSON.stringify(topicA)}, ${JSON.stringify(seeded)}, 'history'));
  })()`);
  await sleep(1500);
  const ownMarker = `own padding ${ts} ${rand}`;
  res.ownMarker = ownMarker;
  res.ownSend = await sendFromComposer(cdp, ownMarker);
  res.ownSeen = await waitForText(cdp, ownMarker, 25000, 'own-padding');
  await sleep(2500);

  logStep('1/2. PADDING + EFFECTIVE INSETS');
  res.themeGuard = await ensureTheme(cdp, 'light');
  log('theme guard:', JSON.stringify(res.themeGuard));
  res.geo = JSON.parse(await evaluate(cdp, CLOCK_EXPR));
  const st = res.geo;
  log('streamPad:', JSON.stringify(st.streamPad), 'stream:', JSON.stringify(st.stream), 'scrollW/clientW:', st.streamScrollW, '/', st.streamClientW);
  const nonOwn = st.rows.filter((r) => !r.self);
  const own = st.rows.find((r) => r.self);
  const leftInset = nonOwn.length && nonOwn[0].avatar ? nonOwn[0].avatar.left - st.stream.left : null;
  const rightInset = own && own.body ? st.stream.right - own.body.right : null;
  log('left inset (stream.left -> avatar.left) =', leftInset, '| right inset (own body.right -> stream.right) =', rightInset);
  log('non-own avatarLefts =', JSON.stringify(nonOwn.map((r) => r.avatar.left)), 'bodyLefts =', JSON.stringify(nonOwn.map((r) => r.body.left)));
  log('own body right =', own && own.body.right, 'own row right =', own && own.row.right, 'own clock =', JSON.stringify(own && own.clock));
  log('day headers:', JSON.stringify(st.dayHeaders));

  logStep('LIGHT SHOT');
  await screenshot(cdp, path.join(OUT_DIR, '_verify-25-padding-light.png'));
  res.shot25 = path.join(OUT_DIR, '_verify-25-padding-light.png');

  logStep('EMPTY STATE: subscribe a second, empty topic and select it');
  res.addEmpty = await addTopicViaPanel(cdp, topicEmpty);
  await sleep(3000);
  res.geoEmpty = JSON.parse(await evaluate(cdp, CLOCK_EXPR));
  log('empty state:', JSON.stringify(res.geoEmpty.empty), '| streamPad:', JSON.stringify(res.geoEmpty.streamPad));
  const em = res.geoEmpty.empty;
  if (em && res.geoEmpty.stream) {
    log('empty insets: left =', em.rect.left - res.geoEmpty.stream.left, 'right =', res.geoEmpty.stream.right - em.rect.right);
  }
  await screenshot(cdp, path.join(OUT_DIR, '_verify-27-padding-empty.png'));
  res.shot27 = path.join(OUT_DIR, '_verify-27-padding-empty.png');
  // back to the populated topic for the dark shot
  await selectTopicChip(cdp, topicA);
  await sleep(2000);

  logStep('DARK SHOT + restore theme');
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1300);
  res.darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  res.geoDark = JSON.parse(await evaluate(cdp, CLOCK_EXPR));
  await screenshot(cdp, path.join(OUT_DIR, '_verify-26-padding-dark.png'));
  res.shot26 = path.join(OUT_DIR, '_verify-26-padding-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  const spread = (a) => Math.max(...a) - Math.min(...a);
  const avatarLefts = nonOwn.map((r) => r.avatar.left);
  const bodyLefts = nonOwn.map((r) => r.body.left);
  const timed = st.rows.filter((r) => r.clock);
  const dayHdr = st.dayHeaders[0];
  res.checks = {
    paddingLeftIs26: st.streamPad.left === 26,
    paddingRightIs44: st.streamPad.right === 44,
    paddingRightLargerThanLeft: st.streamPad.right > st.streamPad.left,
    noHorizontalOverflow: st.streamScrollW <= st.streamClientW + 1,
    alignmentNonOwnAvatarLeftSame: spread(avatarLefts) === 0,
    alignmentNonOwnBodyLeftSame: spread(bodyLefts) === 0,
    clocksStillUnderAvatars: timed.every((r) => r.clockInBox === true && r.clockBelowAvatar === true),
    ownRowStillRightAligned: !!(own && Math.abs(own.body.right - (own.row.right - own.padRight)) <= 1),
    ownClockOnRightHalf: !!(own && own.clock.left > st.stream.left + st.stream.w / 2),
    dayHeaderInsidePadding: !!(dayHdr && dayHdr.rect.left >= st.stream.left + st.streamPad.left - 1 && dayHdr.rect.right <= st.stream.right - st.streamPad.right + 1),
    emptyStateInsidePadding: !!(em && res.geoEmpty.stream && em.rect.left >= res.geoEmpty.stream.left + res.geoEmpty.streamPad.left - 1 && em.rect.right <= res.geoEmpty.stream.right - res.geoEmpty.streamPad.right + 1),
    emptyStateRendered: !!em,
    tallRowStillAligned: (() => { const tall = st.rows.find((r) => String(r.text || '').includes('tall body')); return !!(tall && tall.avatar.left === avatarLefts[0] && tall.body.left === bodyLefts[0]); })(),
    noSlotCrash: cons.slotCrash.length === 0,
    bundleNotStale: !!(res.bundle.servedContainsExactDiskBytes && res.bundle.servedHasPaddingNeedle),
  };
  res.ok = Object.values(res.checks).every(Boolean);
  res.metrics = {
    padding: st.streamPad,
    streamRect: st.stream,
    leftInsetToAvatar: leftInset,
    rightInsetToOwnBodyRight: rightInset,
    ownBodyRight: own && own.body.right,
    scrollW: st.streamScrollW, clientW: st.streamClientW,
    avatarLefts, bodyLefts,
    rowHeights: st.rows.map((r) => r.row.h),
    dayHeader: dayHdr || null,
    empty: em ? { rect: em.rect, leftInset: em.rect.left - res.geoEmpty.stream.left, rightInset: res.geoEmpty.stream.right - em.rect.right, title: em.title } : null,
    contentWidthNonOwn: nonOwn[0] && nonOwn[0].body.w,
  };
  logStep('TASK-15 RESULT');
  console.log(JSON.stringify({ ok: res.ok, checks: res.checks, metrics: res.metrics, bundle: res.bundle, console: res.console }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-15.json'), JSON.stringify(res, null, 2));
  return res;
}

/** unread divider + scroll state of the stream */
const UNREAD_EXPR = `(() => {
  const stream = document.querySelector('.ntfy-teams-stream');
  if (!stream) return JSON.stringify({ found: false });
  const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) }; };
  const divider = stream.querySelector('.ntfy-teams-newline');
  const kids = Array.from(stream.children);
  const di = divider ? kids.indexOf(divider) : -1;
  const before = di > 0 ? kids[di - 1] : null;
  const after = (di >= 0 && di < kids.length - 1) ? kids[di + 1] : null;
  const isMsg = (el) => !!el && /ntfy-teams-msg\\b/.test(String(el.className)) && !/ntfy-teams-msg(body|head|av)/.test(String(el.className));
  const sr = R(stream), dr = divider ? R(divider) : null;
  const chips = Array.from(document.querySelectorAll('.ntfy-teams-topic'));
  const store = (() => { try { const raw = localStorage.getItem('ntfy-teams:store:v1'); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } })();
  const snap = (window.__ntfyTeamsCore && window.__ntfyTeamsCore.store) ? window.__ntfyTeamsCore.store.getSnapshot() : null;
  return JSON.stringify({
    found: true,
    scrollTop: Math.round(stream.scrollTop),
    scrollHeight: stream.scrollHeight,
    clientHeight: stream.clientHeight,
    streamRect: sr,
    dividerCount: stream.querySelectorAll('.ntfy-teams-newline').length,
    divider: divider ? { rect: dr, text: (divider.innerText || '').trim(), aria: divider.getAttribute('aria-label'), role: divider.getAttribute('role'), inDomOrderBetween: !!(isMsg(before) && isMsg(after)) } : null,
    dividerVisibleInBox: dr ? (dr.top >= sr.top - 1 && dr.top <= sr.bottom) : null,
    dividerFullyVisible: dr ? (dr.top >= sr.top - 1 && dr.bottom <= sr.bottom + 1) : null,
    lastReadRow: isMsg(before) ? { rect: R(before), text: (before.innerText || '').slice(0, 40).replace(/\\n/g, ' ') } : null,
    firstUnreadRow: isMsg(after) ? { rect: R(after), text: (after.innerText || '').slice(0, 40).replace(/\\n/g, ' ') } : null,
    rowCount: kids.filter(isMsg).length,
    chips: chips.map((c) => ({ text: (c.innerText || '').trim().slice(0, 40), title: c.getAttribute('title'), unread: /ntfy-teams-topic--unread/.test(String(c.className)), badge: (() => { const b = c.querySelector('.ntfy-teams-badge'); return b ? (b.textContent || '').trim() : null; })() })),
    activeTopic: snap ? snap.activeTopic : null,
    snapshotUnread: snap ? snap.unreadByTopic : null,
    snapshotLastRead: snap ? snap.lastReadIdByTopic : null,
    persistedLastRead: store && store.lastReadIdByTopic ? store.lastReadIdByTopic : null,
    persistedUnread: store && store.unreadByTopic ? store.unreadByTopic : null,
  });
})()`;

/** task-16: scroll-to-last-read + unread divider */
async function modeUnread(cdp, argv) {
  const stamp = Date.now();
  const topicA = argv.topicA || `pub_unreadA_${stamp.toString(36)}`;
  const topicB = argv.topicB || `pub_unreadB_${stamp.toString(36)}`;
  const res = { task: 'task-16', topicA, topicB, ok: false };
  const rand = Math.random().toString(36).slice(2, 7);
  // every injected batch must be strictly LATER than the previous one, otherwise the messages sort
  // before the cursor and no divider can ever appear (this bit me on the first run of this mode)
  const T0 = Math.floor(Date.now() / 1000);
  const read = async () => JSON.parse(await evaluate(cdp, UNREAD_EXPR));
  const inject = async (topic, n, tag, source, tStart) => evaluate(cdp, `(() => {
    const c = window.__ntfyTeamsCore;
    if (!c || !c.store || typeof c.store.addMessages !== 'function') return 'NO_CORE';
    const base = ${Number(tStart)};
    const msgs = [];
    for (let i = 0; i < ${n}; i += 1) {
      msgs.push({ id: 'unj_' + ${JSON.stringify(tag)} + '_' + i, time: base + i, expires: base + i + 3600, event: 'message', topic: ${JSON.stringify(topic)}, title: '#seed', message: ${JSON.stringify(tag)} + ' ' + i, tags: [], priority: 3, source: ${JSON.stringify(source || 'history')}, server: 'https://msn.feg.cn' });
    }
    return String(c.store.addMessages(${JSON.stringify(topic)}, msgs, ${JSON.stringify(source || 'history')}));
  })()`);

  const netUrls = [];
  await cdp.send('Network.enable');
  cdp.on((m) => { if (m.method === 'Network.requestWillBeSent') netUrls.push(m.params.request.url); });

  await navigate(cdp, `${GUI_URL}?verify=${stamp}`);
  await waitForText(cdp, '設定', 45000, 'app-boot');
  await sleep(1500);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(2500);

  logStep('STALE-BUNDLE PROOF');
  const bundleUrl = netUrls.find((u) => /ntfy-teams\/client\.js/.test(u) && u.includes('/plugins/'));
  const disk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  res.bundle = { rev: bundleUrl ? ((bundleUrl.match(/rev=([0-9a-f]+)/) || [])[1] || null) : null, diskBytes: disk.length };
  if (bundleUrl) {
    const served = await (await fetch(bundleUrl)).text();
    res.bundle.servedBytes = served.length;
    res.bundle.servedContainsExactDiskBytes = served.includes(disk);
    res.bundle.servedHasNewlineNeedle = served.includes('.ntfy-teams-newline{display:flex');
    res.bundle.servedHasMarkReadToLatest = served.includes('markReadToLatest');
    res.bundle.diskSha256 = require('node:crypto').createHash('sha256').update(disk).digest('hex').slice(0, 16);
  }
  log('bundle proof:', JSON.stringify({ rev: res.bundle.rev, exactDiskBytes: res.bundle.servedContainsExactDiskBytes, newlineNeedle: res.bundle.servedHasNewlineNeedle, markReadToLatest: res.bundle.servedHasMarkReadToLatest, sha: res.bundle.diskSha256 }));

  logStep('1. SUBSCRIBE A AND B; make B active');
  res.addA = await addTopicViaPanel(cdp, topicA);
  await sleep(2200);
  res.addB = await addTopicViaPanel(cdp, topicB);
  await sleep(2500);
  res.selectB = await selectTopicChip(cdp, topicB);
  await sleep(1500);

  logStep('SEED A with 30 history messages, then view A and mark a baseline cursor');
  res.seedA = await inject(topicA, 30, 'old', 'history', T0 - 3600);
  await sleep(1500);
  res.selectA = await selectTopicChip(cdp, topicA);
  await sleep(2000);
  res.onAFirstVisit = await read();
  log('first visit to A: dividerCount=', res.onAFirstVisit.dividerCount, 'scrollTop=', res.onAFirstVisit.scrollTop, 'lastRead=', JSON.stringify(res.onAFirstVisit.snapshotLastRead));
  res.baselineInject = await inject(topicA, 1, 'base', 'sse', T0 - 300);
  await sleep(1500);
  res.afterBaseline = await read();
  log('after baseline sse while viewing A: lastRead=', JSON.stringify(res.afterBaseline.snapshotLastRead[topicA]), 'unread=', JSON.stringify(res.afterBaseline.snapshotUnread[topicA]));

  logStep('2. GO BACK TO B (A not active) AND INJECT 3 SSE MESSAGES INTO A');
  res.selectB2 = await selectTopicChip(cdp, topicB);
  await sleep(1500);
  res.injectUnread = await inject(topicA, 3, 'new', 'sse', T0 - 120);
  await sleep(2000);
  res.withUnread = await read();
  log('A unread now =', JSON.stringify(res.withUnread.snapshotUnread[topicA]), '| A lastRead =', JSON.stringify(res.withUnread.snapshotLastRead[topicA]));
  log('chips:', JSON.stringify(res.withUnread.chips));
  log('B stream dividerCount =', res.withUnread.dividerCount, '(B is active, must be 0)');

  logStep('4. SCROLL-TO-DIVIDER TEST: scrollTop := 0 on B, then switch to A');
  await evaluate(cdp, `(() => { const s = document.querySelector('.ntfy-teams-stream'); if (s) s.scrollTop = 0; return true; })()`);
  await sleep(700);
  res.beforeSwitch = await read();
  log('BEFORE switch: active =', res.beforeSwitch.activeTopic, 'scrollTop =', res.beforeSwitch.scrollTop, 'scrollHeight =', res.beforeSwitch.scrollHeight, 'clientHeight =', res.beforeSwitch.clientHeight);
  res.switchClick = await selectTopicChip(cdp, topicA);
  await sleep(2500);
  res.afterSwitch = await read();
  log('AFTER switch : active =', res.afterSwitch.activeTopic, 'scrollTop =', res.afterSwitch.scrollTop);
  log('divider:', JSON.stringify(res.afterSwitch.divider));
  log('dividerVisibleInBox =', res.afterSwitch.dividerVisibleInBox, '| fullyVisible =', res.afterSwitch.dividerFullyVisible);
  log('lastReadRow:', JSON.stringify(res.afterSwitch.lastReadRow));
  log('firstUnreadRow:', JSON.stringify(res.afterSwitch.firstUnreadRow));

  logStep('8. LIGHT SHOT (divider on screen)');
  await screenshot(cdp, path.join(OUT_DIR, '_verify-31-unread-light.png'));
  res.shot31 = path.join(OUT_DIR, '_verify-31-unread-light.png');

  logStep('5. AFTER onSeen: the marker now PERSISTS (new design); the cursor must advance');
  await sleep(2500);
  res.afterSeen = await read();
  log('after onSeen: dividerCount =', res.afterSeen.dividerCount, 'visible =', res.afterSeen.dividerVisibleInBox, '| lastRead =', JSON.stringify(res.afterSeen.snapshotLastRead[topicA]));
  log('persisted lastRead =', JSON.stringify(res.afterSeen.persistedLastRead && res.afterSeen.persistedLastRead[topicA]));
  await selectTopicChip(cdp, topicB);
  await sleep(1500);
  res.backToA = await selectTopicChip(cdp, topicA);
  await sleep(2200);
  res.afterReturn = await read();
  log('after B->A round trip: dividerCount =', res.afterReturn.dividerCount);

  logStep('7. OWN MESSAGE WHILE VIEWING A -> no divider');
  const ownMarker = `own unread ${stamp} ${rand}`;
  res.ownMarker = ownMarker;
  res.ownSend = await sendFromComposer(cdp, ownMarker);
  res.ownSeen = await waitForText(cdp, ownMarker, 25000, 'own-unread');
  await sleep(2000);
  res.afterOwn = await read();
  log('after own send: dividerCount =', res.afterOwn.dividerCount, 'scrollTop =', res.afterOwn.scrollTop);

  logStep('8b. DARK SHOT: fresh unread on A, view it, shoot the divider');
  await selectTopicChip(cdp, topicB);
  await sleep(1500);
  // the own message was published at real wall-clock time, so this batch must be LATER than it,
  // otherwise it sorts before the cursor and no divider can appear (same trap as before)
  res.darkT = Math.floor(Date.now() / 1000) + 1;
  res.injectDark = await inject(topicA, 2, 'darkun', 'sse', res.darkT);
  await sleep(1800);
  res.theme = await toggleTheme(cdp, '深色');
  await sleep(1200);
  res.darkBg = await evaluate(cdp, `getComputedStyle(document.body).backgroundColor`);
  await evaluate(cdp, `(() => { const s = document.querySelector('.ntfy-teams-stream'); if (s) s.scrollTop = 0; return true; })()`);
  await sleep(600);
  res.switchDark = await selectTopicChip(cdp, topicA);
  await sleep(2500);
  res.afterSwitchDark = await read();
  log('DARK: dividerCount =', res.afterSwitchDark.dividerCount, 'divider =', JSON.stringify(res.afterSwitchDark.divider), 'visible =', res.afterSwitchDark.dividerVisibleInBox);
  await screenshot(cdp, path.join(OUT_DIR, '_verify-32-unread-dark.png'));
  res.shot32 = path.join(OUT_DIR, '_verify-32-unread-dark.png');
  res.themeRestore = await toggleTheme(cdp, '跟隨系統');

  logStep('6. NEGATIVE CONTROL: bogus lastReadId (pruned history) -> NO divider');
  // ⚠️ 這一段原本靠「先寫 localStorage 的舊 key 再重新載入」來製造『掛載時就有未讀線』。
  // 那個前提已經不成立：外掛完全不用 localStorage，未讀與「讀到哪」都只活在記憶體，
  // 重新載入一律重來（見 README 的「為什麼要拿掉 localStorage」）。
  // 所以這裡不再偽造持久化資料 —— 留著只會製造假的綠燈。
  res.bogusWrite = 'SKIPPED: 不再有 localStorage 持久化（未讀不跨重新載入）';
  log('bogus payload write:', res.bogusWrite);
  await navigate(cdp, `${GUI_URL}?verify=${stamp}b`);
  await waitForText(cdp, '設定', 45000, 'app-boot-2');
  await sleep(2000);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(3000);
  res.negativeBeforeEntry = await read();
  log('negative BEFORE entering A: active =', res.negativeBeforeEntry.activeTopic, 'chips =', JSON.stringify(res.negativeBeforeEntry.chips));
  res.negativeEnter = await selectTopicChip(cdp, topicA);
  await sleep(2500);
  res.negativeAfterEntry = await read();
  log('negative AFTER entering A: dividerCount =', res.negativeAfterEntry.dividerCount, 'chips =', JSON.stringify(res.negativeAfterEntry.chips));

  logStep('DIAGNOSIS: in-session chip switch vs unread already present at MOUNT');
  // The in-session path asserted above never draws the divider. To prove WHERE it breaks, build a
  // topic whose unread + cursor exist BEFORE a page load (real published messages, so they survive a
  // reload) and see whether the mount render draws the divider.
  const topicC = `${topicA}_mount`;
  res.mountTopic = topicC;
  res.addC = await addTopicViaPanel(cdp, topicC);
  await sleep(2500);
  const pubReal = (msg) => publishRaw(msg, '#realguy', topicC);
  res.mountPubs = [];
  for (let i = 0; i < 3; i += 1) { res.mountPubs.push(pubReal(`real ${i} ${stamp}`)); await sleep(900); }
  await sleep(2500);
  res.mountAfterActive = await read();
  res.mountCursor = res.mountAfterActive.snapshotLastRead[topicC];
  log('after 3 REAL messages while viewing C: lastRead =', JSON.stringify(res.mountCursor), 'unread =', JSON.stringify(res.mountAfterActive.snapshotUnread[topicC]));
  await selectTopicChip(cdp, topicB);
  await sleep(1500);
  for (let i = 0; i < 2; i += 1) { res.mountPubs.push(pubReal(`real unread ${i} ${stamp}`)); await sleep(900); }
  await sleep(2500);
  res.mountWithUnread = await read();
  log('C unread with C not active =', JSON.stringify(res.mountWithUnread.snapshotUnread[topicC]), '| chip badge =', JSON.stringify((res.mountWithUnread.chips.find((c) => String(c.text).includes(topicC)) || {}).badge));
  // ⚠️ 這裡原本偽造 `activeTopic` 寫進 localStorage 的舊 key，好讓「重新載入後仍停在 C」
  // 而畫出未讀線。那個持久化已經移除（外掛完全不用 localStorage），
  // 所以重新載入後不會停在 C、未讀也歸零 —— 再寫舊 key 只是往瀏覽器裡塞垃圾。
  res.mountPayload = 'SKIPPED: 不再有 localStorage 持久化（未讀／activeTopic 不跨重新載入）';
  log('payload before mount:', res.mountPayload);
  await navigate(cdp, `${GUI_URL}?verify=${stamp}c`);
  await waitForText(cdp, '設定', 45000, 'app-boot-3');
  await sleep(2000);
  await clickText(cdp, PANEL_LABEL, { exact: false, tags: ['button', 'a', '[role=button]'] });
  await sleep(3500);
  res.mountAfterLoad = await read();
  log('MOUNT path: active =', res.mountAfterLoad.activeTopic, 'dividerCount =', res.mountAfterLoad.dividerCount, 'divider =', JSON.stringify(res.mountAfterLoad.divider));
  log('MOUNT path scrollTop =', res.mountAfterLoad.scrollTop, 'scrollHeight =', res.mountAfterLoad.scrollHeight, 'clientHeight =', res.mountAfterLoad.clientHeight);
  if (res.mountAfterLoad.divider) {
    log('MOUNT divider visible =', res.mountAfterLoad.dividerVisibleInBox, 'fully =', res.mountAfterLoad.dividerFullyVisible);
    await screenshot(cdp, path.join(OUT_DIR, '_verify-30-unread-mount.png'));
    res.shot30 = path.join(OUT_DIR, '_verify-30-unread-mount.png');
  }

  const cons = reportConsole(cdp);
  res.console = { total: cons.total, slotCrash: cons.slotCrash.length, errors: cons.errors.map((e) => `${e.type}: ${e.text}`.slice(0, 300)) };

  const chipA = res.withUnread.chips.find((c) => String(c.text).includes(topicA)) || {};
  const chipB = res.withUnread.chips.find((c) => String(c.text).includes(topicB)) || {};
  const div = res.afterSwitch.divider;
  const countInDivider = div ? (div.text.match(/(\d+)/) || [])[1] : null;
  res.checks = {
    chipAHasUnreadClass: chipA.unread === true,
    chipAHasBadge: chipA.badge === '3',
    chipAUnreadTitleSuffix: !!(chipA.title && /未讀\s*3\s*則/.test(chipA.title)),
    chipBHasNoUnread: chipB.unread === false && !chipB.badge,
    bStreamNoDivider: res.withUnread.dividerCount === 0,
    dividerShownOnA: !!div,
    dividerTextHasCount: !!(div && /3\s*則新訊息/.test(div.text)),
    dividerCountMatchesBadge: countInDivider === '3',
    dividerHasSeparatorRole: !!(div && div.role === 'separator' && /未讀訊息\s*3\s*則/.test(String(div.aria))),
    dividerBetweenLastReadAndFirstUnread: !!(div && res.afterSwitch.lastReadRow && res.afterSwitch.firstUnreadRow && res.afterSwitch.lastReadRow.rect.top < div.rect.top && div.rect.top < res.afterSwitch.firstUnreadRow.rect.top && div.inDomOrderBetween),
    scrolledFromTop: res.beforeSwitch.scrollTop === 0 && res.afterSwitch.scrollTop > 0,
    dividerVisibleInViewport: res.afterSwitch.dividerVisibleInBox === true,
    dividerFullyVisible: res.afterSwitch.dividerFullyVisible === true,
    // task-17: the marker now PERSISTS after being seen; what must change is the CURSOR
    dividerPersistsAfterSeen: res.afterSeen.dividerCount === 1 && res.afterSeen.dividerVisibleInBox === true,
    cursorAdvancedToNewest: !!(res.afterSeen.snapshotLastRead && res.afterSeen.snapshotLastRead[topicA] && res.afterSeen.snapshotLastRead[topicA] !== res.afterBaseline.snapshotLastRead[topicA]),
    cursorPersisted: !!(res.afterSeen.persistedLastRead && res.afterSeen.persistedLastRead[topicA] === res.afterSeen.snapshotLastRead[topicA]),
    dividerStaysGoneAfterRoundTrip: res.afterReturn.dividerCount === 0,
    ownMessageNoDivider: res.afterOwn.dividerCount === 0,
    bogusCursorNoDivider: res.negativeAfterEntry.dividerCount === 0,
    negativeEntryZeroesBadge: !(res.negativeAfterEntry.chips.find((c) => String(c.text).includes(topicA)) || {}).badge,
    darkDividerShown: res.afterSwitchDark.dividerCount === 1 && res.afterSwitchDark.dividerVisibleInBox === true,
    noSlotCrash: cons.slotCrash.length === 0,
    bundleNotStale: !!(res.bundle.servedContainsExactDiskBytes && res.bundle.servedHasNewlineNeedle && res.bundle.servedHasMarkReadToLatest),
  };
  res.ok = Object.values(res.checks).every(Boolean);
  logStep('TASK-16 RESULT');
  console.log(JSON.stringify({
    ok: res.ok, checks: res.checks,
    unreadChips: { chipA, chipB },
    scroll: { before: { scrollTop: res.beforeSwitch.scrollTop, scrollHeight: res.beforeSwitch.scrollHeight, clientHeight: res.beforeSwitch.clientHeight }, after: { scrollTop: res.afterSwitch.scrollTop, scrollHeight: res.afterSwitch.scrollHeight, clientHeight: res.afterSwitch.clientHeight } },
    divider: div, lastReadRow: res.afterSwitch.lastReadRow, firstUnreadRow: res.afterSwitch.firstUnreadRow,
    cursor: { baseline: res.afterBaseline.snapshotLastRead[topicA], afterSeen: res.afterSeen.snapshotLastRead[topicA], persisted: res.afterSeen.persistedLastRead[topicA] },
    negative: { written: res.bogusWrite, beforeEntryChips: res.negativeBeforeEntry.chips, afterEntryDividerCount: res.negativeAfterEntry.dividerCount, afterEntryChips: res.negativeAfterEntry.chips },
    dark: { dividerCount: res.afterSwitchDark.dividerCount, divider: res.afterSwitchDark.divider, visible: res.afterSwitchDark.dividerVisibleInBox },
    bundle: res.bundle, console: res.console,
  }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, '_verify-result-16.json'), JSON.stringify(res, null, 2));
  return res;
}

async function toggleTheme(cdp, target = '深色') {
  const state = async () => JSON.parse(await evaluate(cdp, `JSON.stringify({
    html: document.documentElement.className,
    dataTheme: document.documentElement.dataset.theme || null,
    bg: getComputedStyle(document.body).backgroundColor,
    scheme: getComputedStyle(document.documentElement).colorScheme,
    ls: Object.keys(localStorage)
  })`));

  log('theme before:', JSON.stringify(await state()));
  const opened = await clickText(cdp, '設定', { exact: true });
  if (!opened) return { ok: false, reason: '設定 button not found' };
  const dialogReady = await waitForText(cdp, '外觀', 15000, 'settings-dialog-外觀');
  if (!dialogReady) return { ok: false, reason: 'settings dialog did not open' };

  const cube = await clickText(cdp, target, { exact: true });
  if (!cube) return { ok: false, reason: `appearance cube ${target} not found` };
  await sleep(1500);
  const after = await state();
  log('theme after clicking', target, ':', JSON.stringify(after));

  // close the settings dialog with Escape so the panel shot is unobstructed
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(1200);
  const dialogGone = !(await bodyText(cdp)).includes('跟隨系統');
  log('settings dialog closed:', dialogGone);

  const wantsDark = target === '深色';
  const isDark = after.scheme === 'dark' || /dark/i.test(after.html) || after.dataTheme === 'dark' || parseRgbLuma(after.bg) < 90;
  return {
    ok: wantsDark ? isDark : !isDark,
    wants: wantsDark ? 'dark' : 'light',
    isDark,
    via: `設定 → 外觀 → ${target}`, cube, after, dialogGone,
  };
}

function parseRgbLuma(css) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
  if (!m) return 255;
  return 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
}

// ---------------------------------------------------------------- main
async function main() {
  const [mode = 'probe', ...rest] = process.argv.slice(2);
  const argv = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { argv[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true; }
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let r;
  if (mode === 'probe') r = await withBrowser(modeProbe);
  else if (mode === 'theme') r = await withBrowser(modeTheme);
  else if (mode === 'full') r = await withBrowser((cdp) => modeFull(cdp, argv));
  else if (mode === 'click') r = await withBrowser((cdp) => modeClick(cdp, argv));
  else if (mode === 'coreprobe') r = await withBrowser(modeCoreProbe);
  else if (mode === 'paneltest') r = await withBrowser(modePanelTest);
  else if (mode === 'bundlecheck') r = await withBrowser(modeBundleCheck);
    else if (mode === 'full2') r = await withBrowser((cdp) => modeFull2(cdp, argv));
  else if (mode === 'badge') r = await withBrowser((cdp) => modeBadge(cdp, argv));
  else if (mode === 'sigil') r = await withBrowser((cdp) => modeSigil(cdp, argv));
  else if (mode === 'alias') r = await withBrowser((cdp) => modeAlias(cdp, argv));
  else if (mode === 'settings') r = await withBrowser((cdp) => modeSettings(cdp, argv));
  else if (mode === 'align') r = await withBrowser((cdp) => modeAlign(cdp, argv));
  else if (mode === 'stripe') r = await withBrowser((cdp) => modeStripe(cdp, argv));
  else if (mode === 'clock') r = await withBrowser((cdp) => modeClock(cdp, argv));
  else if (mode === 'padding') r = await withBrowser((cdp) => modePadding(cdp, argv));
  else if (mode === 'unread') r = await withBrowser((cdp) => modeUnread(cdp, argv));
  else if (mode === 'themetest') r = await withBrowser(async (cdp) => {
    await navigate(cdp, GUI_URL);
    await waitForText(cdp, '設定', 45000, 'boot');
    await sleep(1500);
    const t = await toggleTheme(cdp, argv.target || '深色');
    await sleep(1000);
    await screenshot(cdp, path.join(OUT_DIR, argv.shot || '_verify-probe-dark.png'));
    reportConsole(cdp);
    console.log(JSON.stringify(t, null, 2));
    return t;
  });
  else if (mode === 'eval') r = await withBrowser(async (cdp) => {
    await navigate(cdp, argv.url || GUI_URL);
    await sleep(3000);
    console.log(await evaluate(cdp, argv.expr || 'document.body.innerText'));
    reportConsole(cdp);
  });
  else { console.error('unknown mode', mode); process.exit(2); }
  return r;
}

main().then(() => { log('done'); process.exit(0); })
  .catch((e) => { console.error('[verify] FAILED:', e.stack || e.message); process.exit(1); });
