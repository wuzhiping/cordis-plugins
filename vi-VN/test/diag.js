#!/usr/bin/env node
'use strict';
// Diagnostic: load the GUI in a headless browser, report console errors, failed
// requests, whether the vi-VN module was fetched, and the live locale state.
//
//   node test/diag.js

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
const PORT = Number(process.env.DSH_DIAG_PORT || 9336);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data.toString()); } catch (error) { return; }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        this.events.push(message);
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
    if (result.exceptionDetails) return { exception: result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text };
    return result.result ? result.result.value : undefined;
  }
}

async function main() {
  const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vi-diag-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });
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
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Network.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: GUI });
    for (let i = 0; i < 100; i += 1) {
      await sleep(250);
      const buttons = await cdp.eval('document.querySelectorAll("button").length');
      if (buttons > 3) break;
    }
    await sleep(2500);

    console.log('html[lang]      : ' + JSON.stringify(await cdp.eval('document.documentElement.lang')));
    console.log('title           : ' + JSON.stringify(await cdp.eval('document.title')));
    console.log('module loader   : ' + JSON.stringify(await cdp.eval('Object.keys(window.__ModuleLoader__ || {})')));
    console.log('boot rev        : ' + JSON.stringify(await cdp.eval('window.__DSH_BOOT__ && window.__DSH_BOOT__.rev')));
    console.log('boot has vi-VN  : ' + JSON.stringify(await cdp.eval('JSON.stringify((window.__DSH_BOOT__ && window.__DSH_BOOT__.entries || []).filter(function(e){return String(e.id||"").indexOf("vi-VN") !== -1;}))')));
    console.log('vi-VN requested : ' + JSON.stringify(cdp.events.filter((e) => e.method === 'Network.requestWillBeSent' && JSON.stringify(e.params.request.url).indexOf('vi-VN') !== -1).map((e) => e.params.request.url)));
    const failed = cdp.events.filter((e) => e.method === 'Network.loadingFailed');
    console.log('failed requests : ' + failed.length);
    for (const event of failed.slice(0, 10)) console.log('   ' + JSON.stringify(event.params));
    const consoleMessages = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled');
    const logs = cdp.events.filter((e) => e.method === 'Log.entryAdded');
    console.log('console messages: ' + consoleMessages.length + ', log entries: ' + logs.length);
    for (const event of consoleMessages.slice(-15)) {
      const args = (event.params.args || []).map((arg) => arg.value !== undefined ? arg.value : arg.description).join(' ');
      console.log('   [' + event.params.type + '] ' + String(args).slice(0, 300));
    }
    for (const event of logs.slice(-15)) {
      console.log('   [log:' + event.params.entry.level + '] ' + String(event.params.entry.text).slice(0, 300));
    }
    console.log('vi hook         : ' + JSON.stringify(await cdp.eval('window.__DSH_VI__ ? JSON.stringify({keys: window.__DSH_VI__.keys, namespaces: window.__DSH_VI__.namespaces, snapshot: window.__DSH_VI__.snapshot(), events: window.__DSH_VI__.events, error: window.__DSH_VI__.error}) : "missing"')));
    console.log('vi sample       : ' + JSON.stringify(await cdp.eval('window.__DSH_VI__ ? JSON.stringify([window.__DSH_VI__.translate("settings","trigger"), window.__DSH_VI__.translate("settings.locale","language.title"), window.__DSH_VI__.translate("common","save")]) : null')));
    console.log('set vi-VN       : ' + JSON.stringify(await cdp.eval('window.__DSH_VI__ ? (window.__DSH_VI__.setLocale("vi-VN"), "called") : "missing"')));
    await sleep(1500);
    console.log('after switch    : ' + JSON.stringify(await cdp.eval('window.__DSH_VI__ ? JSON.stringify({snapshot: window.__DSH_VI__.snapshot(), events: window.__DSH_VI__.events, error: window.__DSH_VI__.error, sample: [window.__DSH_VI__.translate("settings","trigger"), window.__DSH_VI__.translate("settings.locale","language.title")]}) : "missing"')));
    console.log('lang after      : ' + JSON.stringify(await cdp.eval('document.documentElement.lang')));
    const keyBase = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 2 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyBase });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyBase });
    await sleep(1200);
    console.log('dialog after ^, : ' + JSON.stringify(await cdp.eval('document.querySelectorAll("[role=dialog],[aria-modal=true]").length')));
    const accountTrigger = await cdp.eval(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const match = buttons.find((node) => {
        const label = (node.getAttribute('aria-label') || '');
        return /tài khoản|account|賬號|账号/i.test(label);
      });
      if (!match) return null;
      match.click();
      return (match.getAttribute('aria-label') || match.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    })()`);
    await sleep(900);
    console.log('account trigger : ' + JSON.stringify(accountTrigger));
    console.log('account items   : ' + JSON.stringify(await cdp.eval('JSON.stringify(Array.from(document.querySelectorAll("[role=menuitem],button,[role=button]")).map(function(n){return (n.textContent||"").replace(/\\s+/g," ").trim();}).filter(function(t){return t && t.length < 40;}))')));
    console.log('dialog after acc: ' + JSON.stringify(await cdp.eval('document.querySelectorAll("[role=dialog],[aria-modal=true]").length')));
    const buttons = await cdp.eval(`JSON.stringify(Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"]')).map(function(b){return ((b.getAttribute('aria-label')||'') + '|' + ((b.textContent||'').replace(/\\s+/g,' ').trim()) + '|' + (b.className && b.className.baseVal !== undefined ? '' : String(b.className||'').slice(0,40))).slice(0,120);}))`);
    console.log('buttons         : ' + buttons);
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* ignore */ }
    try { child.kill(); } catch (error) { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

main().catch((error) => { console.error('DIAG FAILED: ' + (error && error.message ? error.message : error)); process.exitCode = 1; });
