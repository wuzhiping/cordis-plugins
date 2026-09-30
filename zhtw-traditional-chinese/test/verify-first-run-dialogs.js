'use strict';
// Verify the first-run dialog suppression in the live GUI.
//
//   node test/verify-first-run-dialogs.js
//
// The two dialogs only appear on a fresh install (this deployment has already
// acknowledged the notice and has a provider), so the probe injects a stand-in with
// the REAL class names and structure the shipped components render, then checks:
//   1. the preview notice is hidden, tagged, and its own 继续 button was clicked
//   2. the API-key prompt is hidden and tagged, and NOTHING inside it is clicked
//   3. a dialog with neither marker is left alone (no collateral damage)
//   4. the fallback stylesheet exists and carries the :has() rules
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9407;
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'firstrun-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + dir,
    '--window-size=1400,950', 'about:blank'], { stdio: 'ignore' });
  let ws = null;
  try {
    let targets = null;
    for (let i = 0; i < 60; i += 1) { try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); break; } catch (_) { await sleep(250); } }
    const page = targets.find((t) => t.type === 'page');
    ws = new WebSocket(page.webSocketDebuggerUrl, { origin: 'http://127.0.0.1:' + PORT });
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } });
    const send = (method, params) => new Promise((res, rej) => { const i = ++id; pending.set(i, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
      return r.result ? r.result.value : undefined; };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
    for (let i = 0; i < 100; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.hHd-Xa_root')").catch(() => false)) break; }
    await sleep(2500);

    let allOk = true;
    const report = (label, ok, detail) => { console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  →  ' + detail); return ok; };

    // Stand-ins using the shipped class names: `jLrgrW_dialog` is the shared modal
    // chrome; `t1T8VW_*` belongs to the preview notice, `GL8Viq_*` to the key step.
    await ev(`(() => {
      const host = document.createElement('div');
      host.id = 'firstrun-probe';
      host.innerHTML = [
        '<div class="jLrgrW_dialog" role="dialog" aria-modal="true" id="probe-notice">',
        '  <div class="jLrgrW_title">預覽版說明</div>',
        '  <div class="t1T8VW_copy"><p>still in preview</p></div>',
        '  <div class="t1T8VW_actions"><button class="t1T8VW_primary" id="probe-notice-continue">繼續</button></div>',
        '</div>',
        '<div class="jLrgrW_dialog" role="dialog" aria-modal="true" id="probe-key">',
        '  <div class="jLrgrW_title">添加一個 API Key 開始使用</div>',
        '  <div class="GL8Viq_description">configure the official model</div>',
        '  <div class="GL8Viq_editor"><input id="probe-key-input"><button id="probe-key-save">儲存</button></div>',
        '</div>',
        '<div class="jLrgrW_dialog" role="dialog" aria-modal="true" id="probe-other">',
        '  <div class="jLrgrW_title">刪除確認</div><button id="probe-other-ok">刪除</button>',
        '</div>',
      ].join('');
      document.body.appendChild(host);
      // Record any click that lands inside the key dialog (must stay empty).
      window.__probeClicks = [];
      ['probe-notice-continue', 'probe-key-save', 'probe-other-ok'].forEach((bid) => {
        const b = document.getElementById(bid);
        if (b) b.addEventListener('click', () => window.__probeClicks.push(bid));
      });
      return true;
    })()`);
    await sleep(1500);

    const state = JSON.parse(await ev(`(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        if (!el) return { missing: true };
        const cs = getComputedStyle(el);
        return { display: cs.display, visibility: cs.visibility, tag: el.getAttribute('data-zhtw-suppressed') };
      };
      const style = document.querySelector('style[data-plugin-css="zhtw-traditional-chinese/first-run.css"]');
      return JSON.stringify({
        notice: read('probe-notice'),
        key: read('probe-key'),
        other: read('probe-other'),
        clicks: window.__probeClicks,
        stylePresent: !!style,
        styleText: style ? style.textContent.slice(0, 160) : null,
      });
    })()`));

    allOk = report('1. preview notice hidden + tagged', state.notice.display === 'none' && state.notice.tag === 'preview-notice', JSON.stringify(state.notice)) && allOk;
    allOk = report('1b. notice 繼續 clicked for the user (persists the ack)', (state.clicks || []).indexOf('probe-notice-continue') !== -1, 'clicks=' + JSON.stringify(state.clicks)) && allOk;
    allOk = report('2. API-key prompt hidden + tagged', state.key.display === 'none' && state.key.tag === 'api-key-prompt', JSON.stringify(state.key)) && allOk;
    allOk = report('2b. nothing inside the key prompt was clicked', (state.clicks || []).indexOf('probe-key-save') === -1, 'clicks=' + JSON.stringify(state.clicks)) && allOk;
    allOk = report('3. an unrelated dialog is untouched', state.other.display !== 'none' && !state.other.tag, JSON.stringify(state.other)) && allOk;
    allOk = report('4. fallback stylesheet present with :has() rules', state.stylePresent && /:has\(/.test(state.styleText || ''), JSON.stringify({ present: state.stylePresent, text: state.styleText })) && allOk;

    // 5. Force a stale marker: the marker class is neutralised, so the sweep cannot
    //    tell the dialog apart — the :has() fallback alone must still hide it.
    await ev(`(() => {
      const host = document.createElement('div');
      host.id = 'firstrun-fallback-probe';
      host.innerHTML = '<div class="jLrgrW_dialog" role="dialog" id="probe-stale">'
        + '<div class="PROBE_staleCopy"><p>copy</p></div>'
        + '<div class="GL8Viq_editor"><button id="probe-stale-save">儲存</button></div></div>';
      document.body.appendChild(host);
      window.__staleClicks = [];
      document.getElementById('probe-stale-save').addEventListener('click', () => window.__staleClicks.push('save'));
      return true;
    })()`);
    await sleep(1200);
    const stale = JSON.parse(await ev(`(() => {
      const el = document.getElementById('probe-stale');
      const cs = getComputedStyle(el);
      return JSON.stringify({ display: cs.display, tag: el.getAttribute('data-zhtw-suppressed'), clicks: window.__staleClicks });
    })()`));
    allOk = report('5. stale notice marker still hidden by the CSS fallback', stale.display === 'none' && stale.tag === 'api-key-prompt', JSON.stringify(stale)) && allOk;
    allOk = report('5b. stale key prompt never clicked', (stale.clicks || []).length === 0, 'clicks=' + JSON.stringify(stale.clicks)) && allOk;
    await ev("(() => { const h = document.getElementById('firstrun-fallback-probe'); if (h) h.remove(); return true; })()");

    await ev("(() => { const h = document.getElementById('firstrun-probe'); if (h) h.remove(); return true; })()");
    console.log('');
    console.log(allOk ? 'FIRST-RUN SUPPRESSION CHECKS PASSED' : 'SOME CHECKS FAILED');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
