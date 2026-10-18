#!/usr/bin/env node
'use strict';
// Unit-check the surface layer's scoping rules in the live page. The MinIO and
// file-share views only render inside a non-blank session, which the automated
// check cannot create without sending a message, so this injects representative
// DOM under their real class prefixes and verifies:
//
//   - UI copy inside .ms- / .fs- roots is translated
//   - user/remote data inside .ms-row / .fs-row / .ntfy-teams-md is untouched
//   - switching the locale back restores the injected original text
//
//   node test/surface-unit.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const GUI = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const PORT = Number(process.env.DSH_SURFACE_UNIT_PORT || 9349);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message; try { message = JSON.parse(event.data.toString()); } catch (error) { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 45000);
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('page exception: ' + (result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text));
    return result.result ? result.result.value : undefined;
  }
}

const FIXTURE = `(() => {
  document.getElementById('vi-surface-fixture')?.remove();
  const root = document.createElement('div');
  root.id = 'vi-surface-fixture';
  root.style.display = 'none';
  root.innerHTML = [
    '<div class="ms-root">',
    '  <p class="ms-title">🪣 MinIO</p>',
    '  <div class="ms-empty">連線至 MinIO…</div>',
    '  <button class="ms-btn">重新整理</button>',
    '  <div class="ms-row"><span>歷史</span></div>',
    '</div>',
    '<div class="fs-root">',
    '  <div class="fs-empty">下載</div>',
    '  <button class="fs-btn">刷新</button>',
    '  <div class="fs-row"><span>重新整理</span></div>',
    '</div>',
    '<div class="ntfy-teams-md"><p>已訂閱 4 個主題</p></div>'
  ].join('');
  document.body.appendChild(root);
  return true;
})()`;

const SNAPSHOT = `(() => {
  const root = document.getElementById('vi-surface-fixture');
  const text = (selector) => { const el = root.querySelector(selector); return el ? (el.textContent || '').trim() : null; };
  return JSON.stringify({
    minioTitle: text('.ms-title'),
    minioEmpty: text('.ms-empty'),
    minioButton: text('.ms-btn'),
    minioRow: text('.ms-row'),
    shareEmpty: text('.fs-empty'),
    shareButton: text('.fs-btn'),
    shareRow: text('.fs-row'),
    ntfyMarkdown: text('.ntfy-teams-md')
  });
})()`;

async function main() {
  const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
  if (!browser) { console.error('no Chrome/Edge found'); process.exit(2); }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-unit-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1200,800', 'about:blank',
  ], { stdio: 'ignore' });
  const failures = [];
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 80; i += 1) {
      try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); break; } catch (error) { await sleep(250); }
    }
    const page = targets.find((target) => target.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: GUI });
    for (let i = 0; i < 160; i += 1) {
      await sleep(250);
      if (await cdp.eval('window.__DSH_VI__ ? "y" : ""').catch(() => '')) break;
    }
    await sleep(1500);
    for (let i = 0; i < 10; i += 1) {
      const ok = await cdp.eval('window.__DSH_VI__ ? (window.__DSH_VI__.setLocale("vi-VN"), true) : false').catch(() => false);
      if (ok) break; await sleep(500);
    }
    await sleep(1500);
    await cdp.eval(FIXTURE);
    await cdp.eval('window.__DSH_VI__.surfaceSweep()');
    await sleep(400);
    const after = JSON.parse(await cdp.eval(SNAPSHOT));
    console.log('translated     : ' + JSON.stringify(after));
    const expected = {
      minioTitle: '🪣 MinIO',
      minioEmpty: 'Đang kết nối tới MinIO…',
      minioButton: 'Làm mới',
      shareEmpty: 'Tải xuống',
      shareButton: 'Làm mới',
      minioRow: '歷史',
      shareRow: '重新整理',
      ntfyMarkdown: '已訂閱 4 個主題'
    };
    for (const [key, value] of Object.entries(expected)) {
      if (after[key] !== value) failures.push(key + ' = ' + JSON.stringify(after[key]) + ', expected ' + JSON.stringify(value));
    }
    // Switching away must restore the injected original text.
    await cdp.eval('window.__DSH_VI__.setLocale("en")');
    await sleep(1200);
    console.log('after switch   : ' + JSON.stringify(await cdp.eval('({ snapshot: window.__DSH_VI__.snapshot(), active: window.__DSH_VI__.surfaceActive(), counts: window.__DSH_VI__.surface() })')));
    const restored = JSON.parse(await cdp.eval(SNAPSHOT));
    console.log('restored       : ' + JSON.stringify(restored));
    if (restored.minioEmpty !== '連線至 MinIO…') failures.push('restore did not bring the original ms- text back: ' + JSON.stringify(restored.minioEmpty));
    if (restored.shareButton !== '刷新') failures.push('restore did not bring the original fs- text back: ' + JSON.stringify(restored.shareButton));
    await cdp.eval('document.getElementById("vi-surface-fixture")?.remove()');
    await cdp.eval('window.__DSH_VI__.setLocale("zh-TW")').catch(() => undefined);

    console.log('');
    if (failures.length === 0) console.log('RESULT: PASS');
    else { console.log('RESULT: FAIL'); for (const failure of failures) console.log('  ! ' + failure); process.exitCode = 1; }
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* ignore */ }
    try { child.kill(); } catch (error) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

main().catch((error) => { console.error('SURFACE UNIT FAILED: ' + (error && error.message ? error.message : error)); process.exitCode = 1; });
