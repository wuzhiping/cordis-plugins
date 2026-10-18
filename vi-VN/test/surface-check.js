#!/usr/bin/env node
'use strict';
// Verify the vi-VN surface layer on the deployment's hardcoded-Chinese plugin
// surfaces (cute-clock, MCP網關, 管線看板, 團隊協同, MinIO tab, file-share).
//
//   node test/surface-check.js                 # report + PASS/FAIL
//   node test/surface-check.js --shot-dir test # also save per-panel screenshots
//
// For each sidebar panel it reports the in-scope Chinese leftovers and the
// Vietnamese samples; hard failures are: surface layer inactive, sidebar panel
// labels still Chinese, or a targeted panel keeping more than a few Chinese
// strings. Restores the locale it found.

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
const PORT = Number(process.env.DSH_SURFACE_PORT || 9338);
const shotDir = process.argv.indexOf('--shot-dir') !== -1 ? process.argv[process.argv.indexOf('--shot-dir') + 1] : null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data.toString()); } catch (error) { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error('page exception: ' + (result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text));
    return result.result ? result.result.value : undefined;
  }
}

const PREFIXES = ['cute-clock-', 'cute-usage__', 'fdep', 'ntfy-teams-', 'kw-', 'ms-', 'fs-'];
const TARGET_LABELS = {
  'Đồng hồ năng lượng': 'cute-clock',
  'Cổng MCP': 'MCP gateway',
  'Bảng quy trình': 'pipeline board',
  'Cộng tác nhóm': 'team collaboration',
};

const SCOPE_REPORT = `(() => {
  const prefixes = ${JSON.stringify(PREFIXES)};
  const dataPrefixes = ['ntfy-teams-md', 'ntfy-teams-msg', 'ntfy-teams-message', 'ms-row', 'fs-row', 'ntfy-teams-link', 'ntfy-teams-tag'];
  const inScope = (node) => {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el !== document.body) {
      const cls = el.getAttribute && el.getAttribute('class');
      if (cls) {
        for (const token of cls.split(/\\s+/)) {
          if (dataPrefixes.some((prefix) => token.indexOf(prefix) === 0)) return false;
          for (const prefix of prefixes) if (token.indexOf(prefix) === 0) return true;
          if (token === 'hHd-Xa_panelRow') return false;
        }
      }
      if (el.getAttribute && el.getAttribute('role') === 'tab') return true;
      el = el.parentElement;
    }
    return false;
  };
  const chinese = [];
  const vietnamese = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (text === '' || text.length > 120) continue;
    if (!inScope(node)) continue;
    if (/[\\u4e00-\\u9fff]/.test(text)) { if (chinese.length < 30) chinese.push(text); }
    else if (/[\\u00c0-\\u1ef9]/.test(text)) { if (vietnamese.length < 30) vietnamese.push(text); }
  }
  // Tooltips / aria labels / placeholders are UI copy too.
  for (const el of document.querySelectorAll('[placeholder],[title],[aria-label]')) {
    if (!inScope(el)) continue;
    for (const name of ['placeholder', 'title', 'aria-label']) {
      const value = el.getAttribute(name);
      if (!value || !/[\\u4e00-\\u9fff]/.test(value)) continue;
      const label = '[' + name + '] ' + value;
      if (chinese.length < 30 && chinese.indexOf(label) === -1) chinese.push(label);
    }
  }
  const scopes = new Set();
  for (const el of document.querySelectorAll('[class]')) {
    const cls = String(el.getAttribute('class') || '');
    for (const token of cls.split(/\\s+/)) if (prefixes.some((p) => token.indexOf(p) === 0)) scopes.add(token);
  }
  return JSON.stringify({ chinese, vietnamese, scopes: Array.from(scopes).slice(0, 8) });
})()`;

async function main() {
  const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
  if (!browser) { console.error('no Chrome/Edge found'); process.exit(2); }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-surface-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });
  const failures = [];
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 80; i += 1) {
      try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); break; }
      catch (error) { await sleep(250); }
    }
    const page = targets.find((target) => target.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: GUI });
    for (let i = 0; i < 120; i += 1) {
      await sleep(250);
      if (await cdp.eval('window.__DSH_VI__ ? "yes" : ""').catch(() => '')) break;
    }
    await sleep(1800);
    const initial = await cdp.eval('window.__DSH_VI__ ? JSON.stringify(window.__DSH_VI__.snapshot()) : ""');
    console.log('initial locale : ' + initial);
    await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.setLocale("vi-VN")');
    await sleep(2000);
    await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.surfaceSweep()');
    await sleep(600);
    console.log('surface        : ' + await cdp.eval('JSON.stringify({ active: window.__DSH_VI__.surfaceActive(), counts: window.__DSH_VI__.surface() })'));
    const surfaceState = JSON.parse(await cdp.eval('JSON.stringify({ active: window.__DSH_VI__.surfaceActive(), counts: window.__DSH_VI__.surface() })'));
    if (!surfaceState.active) failures.push('surface layer is not active under vi-VN');
    if (!surfaceState.counts || surfaceState.counts.exact < 200) failures.push('surface dictionaries did not load (exact=' + (surfaceState.counts && surfaceState.counts.exact) + ')');

    // Sidebar rows: labels must be Vietnamese, not Chinese.
    const rows = JSON.parse(await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('.hHd-Xa_panelRow')).map((row) => ({
      label: (row.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),
      text: (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    })))`));
    console.log('sidebar rows   : ' + JSON.stringify(rows));
    const chineseLabels = rows.filter((row) => /[\u4e00-\u9fff]/.test(row.label + ' ' + row.text));
    if (chineseLabels.length) failures.push('sidebar labels still Chinese: ' + JSON.stringify(chineseLabels.map((row) => row.label)));

    for (let index = 0; index < rows.length; index += 1) {
      const clicked = await cdp.eval(`(() => { const rows = document.querySelectorAll('.hHd-Xa_panelRow'); if (!rows[${index}]) return null; const row = rows[${index}]; row.click(); return (row.getAttribute('aria-label') || row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60); })()`);
      await sleep(1200);
      await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.surfaceSweep()');
      await sleep(500);
      const report = JSON.parse(await cdp.eval(SCOPE_REPORT));
      const target = Object.keys(TARGET_LABELS).find((label) => String(clicked).indexOf(label) !== -1);
      console.log('=== [' + index + '] ' + JSON.stringify(clicked) + (target ? '  (' + TARGET_LABELS[target] + ')' : '') + ' ===');
      console.log('  scopes  : ' + JSON.stringify(report.scopes));
      console.log('  vi      : ' + JSON.stringify(report.vietnamese.slice(0, 8)));
      console.log('  zh left : ' + report.chinese.length + ' ' + JSON.stringify(report.chinese.slice(0, 8)));
      if (target && report.chinese.length > 3) failures.push(target + ' keeps ' + report.chinese.length + ' Chinese strings (e.g. ' + JSON.stringify(report.chinese.slice(0, 4)) + ')');
      if (target && report.vietnamese.length === 0) failures.push(target + ' shows no Vietnamese copy at all');
      if (shotDir) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(shotDir, 'surface-' + index + '.png'), Buffer.from(shot.data, 'base64'));
      }
    }

    // ntfy-teams has a second surface: its in-panel settings form (identity,
    // auth mode, credentials, connection test). It is collapsed by default, so
    // open it explicitly and re-check.
    const teamRow = await cdp.eval(`(() => {
      const rows = Array.from(document.querySelectorAll('.hHd-Xa_panelRow'));
      const hit = rows.find((row) => /Cộng tác nhóm|團隊協同|团队协同/.test((row.getAttribute('aria-label') || '') + ' ' + (row.textContent || '')));
      if (!hit) return null; hit.click(); return true;
    })()`);
    await sleep(1500);
    const settingsToggle = await cdp.eval(`(() => {
      const bar = document.querySelector('.ntfy-teams-settingsbar') || document.querySelector('.ntfy-teams-settings');
      if (!bar) return null;
      const button = bar.querySelector('button');
      if (!button) return null; button.click();
      return (button.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 50);
    })()`);
    await sleep(1200);
    await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.surfaceSweep()');
    await sleep(500);
    const settingsReport = JSON.parse(await cdp.eval(SCOPE_REPORT));
    console.log('ntfy settings  : toggle=' + JSON.stringify(settingsToggle) + ' zh left=' + settingsReport.chinese.length + ' ' + JSON.stringify(settingsReport.chinese.slice(0, 6)));
    if (settingsToggle === null) failures.push('could not open the ntfy-teams settings panel');
    if (settingsReport.chinese.length > 2) failures.push('ntfy-teams settings keeps ' + settingsReport.chinese.length + ' Chinese strings: ' + JSON.stringify(settingsReport.chinese.slice(0, 5)));
    if (shotDir) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, 'screenshot-ntfy-settings.png'), Buffer.from(shot.data, 'base64'));
    }
    // Collapse the settings form, activate a topic and check the composer /
    // priority toolbar / topic tooltips (the second ntfy surface).
    await cdp.eval(`(() => { const button = document.querySelector('.ntfy-teams-settings--open .ntfy-teams-btn'); if (button) button.click(); return true; })()`).catch(() => undefined);
    await sleep(600);
    const topicClicked = await cdp.eval(`(() => { const topic = document.querySelector('.ntfy-teams-topic'); if (!topic) return null; topic.click(); return (topic.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40); })()`);
    await sleep(2000);
    await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.surfaceSweep()');
    await sleep(500);
    const composerReport = JSON.parse(await cdp.eval(SCOPE_REPORT));
    console.log('ntfy composer  : topic=' + JSON.stringify(topicClicked) + ' zh left=' + composerReport.chinese.length + ' ' + JSON.stringify(composerReport.chinese.slice(0, 6)));
    if (topicClicked !== null && composerReport.chinese.length > 2) failures.push('ntfy-teams composer keeps ' + composerReport.chinese.length + ' Chinese strings: ' + JSON.stringify(composerReport.chinese.slice(0, 5)));
    if (shotDir) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, 'surface-composer.png'), Buffer.from(shot.data, 'base64'));
    }

    // MinIO tab: opens in a conversation, so create a session first.
    const newSession = await cdp.eval(`(() => {
      const wanted = ['Phiên mới', 'New session', '新工作階段', '新会话'];
      const nodes = Array.from(document.querySelectorAll('button,[role="button"],a'));
      const hit = nodes.find((node) => wanted.some((want) => ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')).indexOf(want) !== -1));
      if (!hit) return null;
      hit.click();
      return ((hit.getAttribute('aria-label') || hit.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    })()`);
    console.log('new session    : ' + JSON.stringify(newSession));
    await sleep(2500);
    console.log('tabs           : ' + JSON.stringify(await cdp.eval(`(() => {
      const out = [];
      for (const node of document.querySelectorAll('[role="tab"], button')) {
        const text = ((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || '')).replace(/\\s+/g, ' ').trim();
        if (text && /MinIO|分享|檔案|文件|share|file/i.test(text)) out.push(text.slice(0, 60));
      }
      return out.slice(0, 20);
    })()`)));
    console.log('minio nodes    : ' + JSON.stringify(await cdp.eval(`(() => {
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
      while (walker.nextNode()) {
        const text = (walker.currentNode.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (/MinIO/i.test(text) && out.length < 10) out.push(text.slice(0, 60));
      }
      return out;
    })()`)));
    const minioTab = await cdp.eval(`(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"],button'));
      const hit = tabs.find((node) => /MinIO|檔案分享|文件分享|File share/i.test(((node.getAttribute('aria-label') || '') + ' ' + (node.textContent || ''))));
      if (!hit) return null;
      hit.click();
      return ((hit.getAttribute('aria-label') || hit.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    })()`);
    console.log('minio tab      : ' + JSON.stringify(minioTab));
    await sleep(2000);
    await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.surfaceSweep()');
    await sleep(500);
    const minioReport = JSON.parse(await cdp.eval(SCOPE_REPORT));
    console.log('=== MinIO tab ===');
    console.log('  scopes  : ' + JSON.stringify(minioReport.scopes));
    console.log('  vi      : ' + JSON.stringify(minioReport.vietnamese.slice(0, 8)));
    console.log('  zh left : ' + minioReport.chinese.length + ' ' + JSON.stringify(minioReport.chinese.slice(0, 8)));
    if (minioTab && minioReport.chinese.length > 8) failures.push('MinIO tab keeps ' + minioReport.chinese.length + ' Chinese strings');
    if (shotDir) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(shotDir, 'surface-minio.png'), Buffer.from(shot.data, 'base64'));
    }

    // Restore the locale that was active on arrival.
    const original = JSON.parse(initial).active;
    if (original && original !== 'vi-VN') {
      await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.setLocale(' + JSON.stringify(original) + ')').catch(() => undefined);
      await sleep(1200);
      console.log('restored       : ' + JSON.stringify(await cdp.eval('window.__DSH_VI__ ? window.__DSH_VI__.snapshot().active : ""')));
    }

    console.log('');
    if (failures.length === 0) console.log('RESULT: PASS');
    else {
      console.log('RESULT: FAIL');
      for (const failure of failures) console.log('  ! ' + failure);
      process.exitCode = 1;
    }
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* ignore */ }
    try { child.kill(); } catch (error) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

main().catch((error) => { console.error('SURFACE CHECK FAILED: ' + (error && error.message ? error.message : error)); process.exitCode = 1; });
