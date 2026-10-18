#!/usr/bin/env node
'use strict';
// Collect the Chinese strings that are still untranslated on the plugin
// surfaces after the surface layer has run. Feeds tools/surface-extra.json.
//
//   node test/collect-zh.js [--out test/_leftovers.json]

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
const PORT = Number(process.env.DSH_COLLECT_PORT || 9344);
const out = process.argv.indexOf('--out') !== -1 ? process.argv[process.argv.indexOf('--out') + 1] : path.join(__dirname, '_leftovers.json');
const PREFIXES = ['cute-clock-', 'cute-usage__', 'fdep', 'ntfy-teams-', 'kw-', 'ms-', 'fs-'];
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

const COLLECT = `(() => {
  const prefixes = ${JSON.stringify(PREFIXES)};
  const dataPrefixes = ['ntfy-teams-md', 'ntfy-teams-msg', 'ntfy-teams-message', 'ms-row', 'fs-row', 'ntfy-teams-link', 'ntfy-teams-tag', 'ntfy-teams-demotag'];
  const skipTags = { PRE: 1, CODE: 1, SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };
  const scopeOf = (node) => {
    let el = node.parentElement;
    while (el && el !== document.body) {
      if (skipTags[el.tagName] === 1) return null;
      const cls = String(el.getAttribute && el.getAttribute('class') || '');
      for (const token of cls.split(/\\s+/)) {
        if (dataPrefixes.some((prefix) => token.indexOf(prefix) === 0)) return null;
      }
      for (const token of cls.split(/\\s+/)) {
        for (const prefix of prefixes) if (token.indexOf(prefix) === 0) return prefix + (token.slice(prefix.length) || '');
      }
      if (el.getAttribute && el.getAttribute('role') === 'tab') return 'tab';
      el = el.parentElement;
    }
    return null;
  };
  const found = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
  while (walker.nextNode()) {
    const text = (walker.currentNode.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (!text || text.length > 200) continue;
    if (!/[\\u4e00-\\u9fff]/.test(text)) continue;
    const scope = scopeOf(walker.currentNode);
    if (!scope) continue;
    found.push({ text, scope });
  }
  return JSON.stringify(found);
})()`;

async function main() {
  const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-collect-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });
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
    for (let i = 0; i < 120; i += 1) {
      await sleep(250);
      if (await cdp.eval('window.__DSH_VI__ ? "y" : ""').catch(() => '')) break;
    }
    await sleep(2000);
    let switched = false;
    for (let i = 0; i < 20 && !switched; i += 1) {
      switched = await cdp.eval('window.__DSH_VI__ ? (window.__DSH_VI__.setLocale("vi-VN"), true) : false').catch(() => false);
      if (!switched) await sleep(500);
    }
    await sleep(2000);
    const collected = new Map();
    const rows = await cdp.eval('document.querySelectorAll(".hHd-Xa_panelRow").length');
    for (let index = 0; index < rows; index += 1) {
      await cdp.eval('document.querySelectorAll(".hHd-Xa_panelRow")[' + index + '].click()');
      await sleep(1200);
      await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.surfaceSweep()');
      await sleep(500);
      const report = JSON.parse(await cdp.eval(COLLECT));
      for (const item of report) {
        if (!collected.has(item.text)) collected.set(item.text, { text: item.text, scopes: [] });
        const entry = collected.get(item.text);
        if (!entry.scopes.includes(item.scope)) entry.scopes.push(item.scope);
      }
    }
    const list = [...collected.values()].sort((a, b) => a.text.localeCompare(b.text));
    fs.writeFileSync(out, JSON.stringify(list, null, 1) + '\n', 'utf8');
    console.log('leftovers: ' + list.length + ' → ' + out);
    for (const item of list.slice(0, 60)) console.log('  [' + item.scopes.join(',') + '] ' + JSON.stringify(item.text));
    await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.setLocale(' + JSON.stringify('zh-TW') + ')').catch(() => undefined);
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* ignore */ }
    try { child.kill(); } catch (error) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

main().catch((error) => { console.error('COLLECT FAILED: ' + (error && error.message ? error.message : error)); process.exitCode = 1; });
