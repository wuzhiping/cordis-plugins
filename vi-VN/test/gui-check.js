#!/usr/bin/env node
'use strict';
// Verify the vi-VN locale in the RUNNING GUI (headless Edge/Chrome over CDP).
//
//   node test/gui-check.js                 # full check + screenshot + restore
//   node test/gui-check.js --shot out.png
//   node test/gui-check.js --keep-locale   # do not restore the language afterwards
//
// Checks, in order:
//   1. the locale catalog contains `vi-VN` and reports the Vietnamese dictionary
//   2. switching to it updates the active locale, `<html lang>` and the rendered
//      shell copy (server-rendered strings come through the patched translate)
//   3. Settings → General → Language lists "Tiếng Việt" and shows it selected
//   4. the selection survives a reload (durable Host preference)
//   5. a screenshot is written for visual review
//
// The language switch is the only user state it changes; unless --keep-locale is
// passed it restores the locale that was active on arrival.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const GUI = process.env.DSH_DEV_BASE || 'http://127.0.0.1:3080';
const PORT = Number(process.env.DSH_GUI_CHECK_PORT || 9335);
const argv = process.argv.slice(2);
const shotAt = argv.indexOf('--shot') !== -1 ? argv[argv.indexOf('--shot') + 1] : path.resolve(__dirname, '_shot-vi.png');
const keepLocale = argv.includes('--keep-locale');

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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }
      }, 30000);
    });
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error('page exception: ' + (result.exceptionDetails.exception ? result.exceptionDetails.exception.description : result.exceptionDetails.text));
    }
    return result.result ? result.result.value : undefined;
  }
}

const VISIBLE_TEXT = `(() => {
  const parts = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const value = (walker.currentNode.nodeValue || '').replace(/\\s+/g, ' ').trim();
    if (value !== '' && value.length < 160) parts.push(value);
  }
  return Array.from(new Set(parts));
})()`;

const CLICK_TEXT = (texts) => `(() => {
  const wanted = ${JSON.stringify(texts)};
  const nodes = Array.from(document.querySelectorAll('button,[role="button"],[role="menuitem"],[role="tab"],a,div,span'));
  const hit = nodes.find((node) => {
    const value = ((node.textContent || '').replace(/\\s+/g, ' ').trim() + ' ' + (node.getAttribute('aria-label') || '')).trim();
    return wanted.some((want) => value === want || value.indexOf(want) !== -1);
  });
  if (!hit) return null;
  hit.click();
  return (hit.getAttribute('aria-label') || hit.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
})()`;

async function waitFor(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await cdp.eval(expression).catch(() => undefined);
    if (value) return value;
    await sleep(250);
  }
  return undefined;
}

async function main() {
  const browser = BROWSERS.find((candidate) => fs.existsSync(candidate));
  if (!browser) { console.error('no Chrome/Edge found'); process.exit(2); }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vi-check-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--no-default-browser-check', '--remote-debugging-port=' + PORT,
    '--remote-allow-origins=*', '--user-data-dir=' + profileDir,
    '--window-size=1440,1000', 'about:blank',
  ], { stdio: 'ignore' });

  const failures = [];
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 80; i += 1) {
      try {
        const response = await fetch('http://127.0.0.1:' + PORT + '/json/list');
        targets = await response.json();
        break;
      } catch (error) { await sleep(250); }
    }
    if (!targets) throw new Error('devtools endpoint never came up');
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

    const hook = await waitFor(cdp, 'window.__DSH_VI__ ? JSON.stringify(window.__DSH_VI__.snapshot()) : ""', 40000);
    const booted = await waitFor(cdp, 'document.querySelectorAll("button").length > 3 ? "yes" : ""', 20000);
    await sleep(1500);
    console.log('browser        : ' + browser);
    console.log('gui            : ' + GUI);
    console.log('booted         : ' + (booted === 'yes'));
    console.log('locale input   : ' + hook);
    const before = await cdp.eval('window.__DSH_VI__ ? JSON.stringify(window.__DSH_VI__.snapshot()) : ""');
    if (!before) {
      failures.push('window.__DSH_VI__ is missing — the vi-VN client plugin did not activate');
    } else {
      const snapshot = JSON.parse(before);
      console.log('initial locale : ' + JSON.stringify(snapshot));
      console.log('dictionary     : ' + JSON.stringify(await cdp.eval('window.__DSH_VI__ ? JSON.stringify({namespaces: window.__DSH_VI__.namespaces, keys: window.__DSH_VI__.keys}) : ""')));
      if (!snapshot.locales.some((entry) => entry.indexOf('vi-VN:') === 0)) failures.push('locale catalog does not list vi-VN (found: ' + snapshot.locales.join(', ') + ')');
    }

    // 2. Switch to Vietnamese through the public API (the picker does the same).
    console.log('switch         : ' + await cdp.eval('window.__DSH_VI__ ? (window.__DSH_VI__.setLocale("vi-VN"), "vi-VN") : "missing"'));
    await sleep(1800);
    const after = JSON.parse(await cdp.eval('window.__DSH_VI__ ? JSON.stringify(window.__DSH_VI__.snapshot()) : "{}"'));
    console.log('after switch   : ' + JSON.stringify(after));
    if (after.active !== 'vi-VN') failures.push('active locale is ' + JSON.stringify(after.active) + ', expected "vi-VN"');
    if (after.htmlLang !== 'vi-VN') failures.push('<html lang> is ' + JSON.stringify(after.htmlLang) + ', expected "vi-VN"');
    const samples = JSON.parse(await cdp.eval('window.__DSH_VI__ ? JSON.stringify({ settings: window.__DSH_VI__.translate("settings", "trigger"), language: window.__DSH_VI__.translate("settings.locale", "language.title"), common: window.__DSH_VI__.translate("common", "cancel") }) : "{}"'));
    console.log('samples        : ' + JSON.stringify(samples));
    if (samples.settings !== 'Cài đặt') failures.push('translate(settings,trigger) = ' + JSON.stringify(samples.settings));

    const texts = await cdp.eval(VISIBLE_TEXT);
    const probes = {
      'Phiên mới': 'new-session label',
      'Không gian làm việc': 'workspace label',
      'Tác vụ tự động': 'plugin panel label',
    };
    for (const [probe, meaning] of Object.entries(probes)) {
      const ok = texts.some((text) => text.indexOf(probe) !== -1);
      console.log('probe ' + meaning + ': ' + (ok ? 'PASS' : 'FAIL') + ' (' + probe + ')');
      if (!ok) failures.push('rendered copy has no "' + probe + '" (' + meaning + ')');
    }
    const chinese = texts.filter((text) => /[\u4e00-\u9fff]/.test(text));
    console.log('chinese left   : ' + chinese.length + (chinese.length ? ' e.g. ' + JSON.stringify(chinese.slice(0, 6)) : ''));

    if (shotAt) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(shotAt, Buffer.from(shot.data, 'base64'));
      console.log('screenshot     : ' + shotAt);
    }

    // 3. Settings → General → Language picker.
    let dialog = 0;
    let how = null;
    const keyBase = { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 3 };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...keyBase });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyBase });
    await sleep(1400);
    dialog = await cdp.eval('document.querySelectorAll("[role=dialog],[aria-modal=true]").length');
    if (dialog) how = 'Ctrl+Alt+,';
    if (!dialog) {
      // Fallback: the Settings entry lives in the account menu (bottom-left),
      // whose trigger is the only button named "Menu tài khoản"/"Account menu".
      const trigger = await cdp.eval(`(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const match = buttons.find((node) => /tài khoản|account|賬號|账号/i.test(node.getAttribute('aria-label') || ''));
        if (!match) return null;
        match.click();
        return (match.getAttribute('aria-label') || match.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      })()`);
      await sleep(900);
      const item = await cdp.eval(`(() => {
        const wanted = ['Cài đặt', 'Settings', '設定', '设置'];
        const items = Array.from(document.querySelectorAll('[role="menuitem"],button,[role="button"]'));
        const match = items.find((node) => {
          const text = (node.textContent || '').replace(/\\s+/g, ' ').trim();
          return wanted.some((want) => text.indexOf(want) === 0);
        });
        if (!match) return null;
        match.click();
        return (match.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      })()`);
      await sleep(1400);
      dialog = await cdp.eval('document.querySelectorAll("[role=dialog],[aria-modal=true]").length');
      if (dialog) how = 'account menu ' + JSON.stringify(trigger) + ' → ' + JSON.stringify(item);
    }
    console.log('settings open  : ' + dialog + ' via ' + JSON.stringify(how));
    if (!dialog) failures.push('could not open the Settings dialog');
    if (dialog) {
      const nav = await cdp.eval(CLICK_TEXT(['Chung', 'General', '一般', '通用']));
      console.log('general nav    : ' + JSON.stringify(nav));
      await sleep(900);
      const rowOpened = await cdp.eval(`(() => {
        const titles = ['Ngôn ngữ', 'Language', '語言', '语言'];
        const nodes = Array.from(document.querySelectorAll('div,span'));
        const title = nodes.find((node) => node.children.length === 0 && titles.includes((node.textContent || '').trim()));
        if (!title) return null;
        let row = title;
        for (let depth = 0; depth < 6 && row; depth += 1) {
          const button = row.querySelector ? row.querySelector('button[aria-haspopup="menu"]') : null;
          if (button) { button.click(); return title.textContent.trim(); }
          row = row.parentElement;
        }
        return null;
      })()`);
      console.log('language row   : ' + JSON.stringify(rowOpened));
      if (!rowOpened) failures.push('could not open the Language picker');
      await sleep(800);
      const items = await cdp.eval(`(() => {
        const labels = new Set();
        for (const item of document.querySelectorAll('[role="menuitem"],[role="option"],[role="menu"] *')) {
          const text = (item.textContent || '').trim();
          if (text && text.length < 40) labels.add(text);
        }
        return JSON.stringify(Array.from(labels));
      })()`);
      console.log('language menu  : ' + items);
      if (items.indexOf('Tiếng Việt') === -1) failures.push('Language menu has no "Tiếng Việt" row');
      const selector = await cdp.eval(`(() => {
        const buttons = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]'));
        const match = buttons.find((button) => (button.textContent || '').indexOf('Tiếng Việt') !== -1);
        return match ? (match.textContent || '').trim() : null;
      })()`);
      console.log('selected label : ' + JSON.stringify(selector));
      if (selector === null) failures.push('Language picker does not show "Tiếng Việt" as the selected language');
      if (shotAt) {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.resolve(path.dirname(shotAt), '_shot-vi-settings.png'), Buffer.from(shot.data, 'base64'));
      }
    }

    // 4. Persistence: the choice must come back through the Host preference.
    await cdp.send('Page.navigate', { url: GUI });
    await waitFor(cdp, 'window.__DSH_VI__ ? "yes" : ""', 40000);
    await sleep(1800);
    const persisted = JSON.parse(await cdp.eval('window.__DSH_VI__ ? JSON.stringify(window.__DSH_VI__.snapshot()) : "{}"'));
    console.log('after reload   : ' + JSON.stringify(persisted));
    if (persisted.active !== 'vi-VN') failures.push('Vietnamese selection did not survive a reload (active=' + JSON.stringify(persisted.active) + ')');
    if (persisted.htmlLang !== 'vi-VN') failures.push('<html lang> after reload is ' + JSON.stringify(persisted.htmlLang));

    // 5. Restore the locale that was active on arrival.
    if (!keepLocale && before) {
      const original = JSON.parse(before).active;
      if (original && persisted.active !== original) {
        await cdp.eval('window.__DSH_VI__ && window.__DSH_VI__.setLocale(' + JSON.stringify(original) + ')').catch(() => undefined);
        await sleep(1200);
        const restored = JSON.parse(await cdp.eval('window.__DSH_VI__ ? JSON.stringify(window.__DSH_VI__.snapshot()) : "{}"'));
        console.log('restored       : ' + JSON.stringify(restored.active) + ' (was ' + JSON.stringify(original) + ')');
      }
    }

    console.log('');
    if (failures.length === 0) {
      console.log('RESULT: PASS');
    } else {
      console.log('RESULT: FAIL');
      for (const failure of failures) console.log('  ! ' + failure);
      process.exitCode = 1;
    }
  } finally {
    try { if (ws) ws.close(); } catch (error) { /* ignore */ }
    try { child.kill(); } catch (error) { /* ignore */ }
    await sleep(400);
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (error) { /* ignore */ }
  }
}

main().catch((error) => {
  console.error('GUI CHECK FAILED: ' + (error && error.message ? error.message : error));
  process.exitCode = 1;
});
