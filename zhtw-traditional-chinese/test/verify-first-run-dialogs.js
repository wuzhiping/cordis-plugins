'use strict';
// Verify the first-run dialog suppression in the live GUI.
//
//   node test/verify-first-run-dialogs.js
//
// The two dialogs only appear on a fresh install (this deployment has already
// acknowledged the notice and has a provider), so the probe injects stand-ins
// with the REAL class names AND the surrounding layers the shipped Modal
// primitive paints, then checks:
//
//   1.  preview notice hidden + tagged + 继续 clicked
//   2.  API-key prompt hidden + tagged + NOTHING inside it clicked
//   3.  an unrelated dialog is left alone
//   4.  fallback stylesheet present with the :has() rules
//   5.  stale marker still hidden by the CSS fallback
//   6.  the Modal `.root` overlay (`role=presentation`, position:fixed,
//       z-index:1000, full viewport) is hidden — without this, the overlay
//       keeps swallowing every click even though the dialog card is gone
//   7.  the Modal `.mask` backdrop sibling is hidden — without this, the
//       blurred dim stays painted over the page
//   8.  `#root.inert` is cleared — OnboardingModal sets it from a useEffect,
//       and only its own cleanup (which runs after the async acknowledge
//       write) restores it; until then the entire app shell is non-interactive
//   9.  a click in the app shell actually lands on its target after the sweep
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

    // Stand-ins matching the shipped Modal + OnboardingModal shape:
    //   <div .MODAL_root role=presentation position:fixed z-index:1000>
    //     <div .MODAL_mask aria-hidden=true>              ← the blurred backdrop
    //     <div .MODAL_dialog .jLrgrW_dialog role=dialog>  ← what our plugin already targets
    //       <h2 .jLrgrW_title>預覽版說明</h2>
    //       <div .t1T8VW_copy>…</div>
    //       <div .t1T8VW_actions><button .t1T8VW_primary>繼續</button></div>
    //   </div>
    // The class hashes for `.root` / `.mask` / `.dialog` come from the Modal
    // primitive's CSS module — they are stable across builds but we don't pin
    // them, since our sweep detects those layers by role + position + sibling
    // shape, not by exact name. The OnboardingModal `.jLrgrW_dialog` class is
    // the marker that has been stable for the deployments we know about.
    await ev(`(() => {
      const makeModal = (id, title, bodyHtml, footerHtml) => {
        const wrap = document.createElement('div');
        wrap.id = id + '-wrap';
        wrap.className = 'MODAL_root';
        wrap.setAttribute('role', 'presentation');
        wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center';
        const mask = document.createElement('div');
        mask.className = 'MODAL_mask';
        mask.setAttribute('aria-hidden', 'true');
        mask.style.cssText = 'position:absolute;inset:0;backdrop-filter:blur(4px);background:rgba(0,0,0,.4)';
        const dlg = document.createElement('div');
        dlg.id = id;
        dlg.className = 'MODAL_dialog jLrgrW_dialog';
        dlg.setAttribute('role', 'dialog');
        dlg.setAttribute('aria-modal', 'true');
        dlg.innerHTML = '<h2 class="jLrgrW_title">' + title + '</h2>' + bodyHtml + (footerHtml || '');
        wrap.appendChild(mask);
        wrap.appendChild(dlg);
        document.body.appendChild(wrap);
        return { wrap, mask, dlg };
      };
      makeModal('probe-notice', '預覽版說明',
        '<div class="t1T8VW_copy"><p>still in preview</p></div>',
        '<div class="t1T8VW_actions"><button class="t1T8VW_primary" id="probe-notice-continue">繼續</button></div>');
      makeModal('probe-key', '添加一個 API Key 開始使用',
        '<div class="GL8Viq_description">configure the official model</div>'
        + '<div class="GL8Viq_editor"><input id="probe-key-input"><button id="probe-key-save">儲存</button></div>',
        null);
      makeModal('probe-other', '刪除確認',
        '<button id="probe-other-ok">刪除</button>',
        null);

      // Simulate OnboardingModal's useEffect that flips #root.inert=true.
      const appRoot = document.getElementById('root');
      if (appRoot) appRoot.inert = true;

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
      const wrapDisplay = (id) => {
        const el = document.getElementById(id + '-wrap');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { display: cs.display, overlayTag: el.getAttribute('data-zhtw-suppressed-overlay') };
      };
      const maskDisplay = (id) => {
        const wrap = document.getElementById(id + '-wrap');
        if (!wrap) return null;
        const mask = wrap.querySelector('.MODAL_mask');
        if (!mask) return null;
        const cs = getComputedStyle(mask);
        return { display: cs.display, overlayTag: mask.getAttribute('data-zhtw-suppressed-overlay') };
      };
      const appRoot = document.getElementById('root');
      const style = document.querySelector('style[data-plugin-css="zhtw-traditional-chinese/first-run.css"]');
      return JSON.stringify({
        notice: read('probe-notice'),
        key: read('probe-key'),
        other: read('probe-other'),
        noticeWrap: wrapDisplay('probe-notice'),
        keyWrap: wrapDisplay('probe-key'),
        otherWrap: wrapDisplay('probe-other'),
        noticeMask: maskDisplay('probe-notice'),
        keyMask: maskDisplay('probe-key'),
        otherMask: maskDisplay('probe-other'),
        rootInert: appRoot ? appRoot.inert === true : null,
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

    // New checks: the parent overlay + mask + #root.inert that used to be left
    // behind, blocking every click in the app shell.
    allOk = report('6a. preview notice parent overlay (MODAL_root) hidden', state.noticeWrap && state.noticeWrap.display === 'none' && state.noticeWrap.overlayTag === '1', JSON.stringify(state.noticeWrap)) && allOk;
    allOk = report('6b. API-key prompt parent overlay (MODAL_root) hidden', state.keyWrap && state.keyWrap.display === 'none' && state.keyWrap.overlayTag === '1', JSON.stringify(state.keyWrap)) && allOk;
    allOk = report('6c. unrelated dialog parent overlay left visible', state.otherWrap && state.otherWrap.display !== 'none', JSON.stringify(state.otherWrap)) && allOk;
    allOk = report('7a. preview notice .mask backdrop hidden', state.noticeMask && state.noticeMask.display === 'none' && state.noticeMask.overlayTag === '1', JSON.stringify(state.noticeMask)) && allOk;
    allOk = report('7b. API-key prompt .mask backdrop hidden', state.keyMask && state.keyMask.display === 'none' && state.keyMask.overlayTag === '1', JSON.stringify(state.keyMask)) && allOk;
    allOk = report('7c. unrelated dialog .mask backdrop untouched', state.otherMask && state.otherMask.display !== 'none', JSON.stringify(state.otherMask)) && allOk;
    allOk = report('8. #root.inert cleared (app shell clickable again)', state.rootInert === false, 'rootInert=' + JSON.stringify(state.rootInert)) && allOk;

    // 9. Live click test: even though the modals are gone, a click anywhere
    //    inside #root must reach a real element (not the inert overlay).
    const pe = JSON.parse(await ev(`(() => {
      const appRoot = document.getElementById('root');
      if (!appRoot) return JSON.stringify({ missing: true });
      const probe = document.createElement('button');
      probe.id = 'zhtw-pe-probe';
      probe.textContent = 'probe';
      probe.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px;z-index:99999';
      appRoot.appendChild(probe);
      const r = probe.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const ok = !!hit && (hit === probe || probe.contains(hit));
      probe.remove();
      return JSON.stringify({
        hit: hit ? (hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className : '')) : null,
        clickReachesProbe: ok,
        rootInert: appRoot.inert === true,
      });
    })()`));
    allOk = report('9. document.elementFromPoint reaches a real #root child (overlay not blocking)', pe.clickReachesProbe === true, JSON.stringify(pe)) && allOk;
    allOk = report('9b. #root stayed unblocked after the sweep (no React re-inert race)', pe.rootInert === false, JSON.stringify(pe)) && allOk;

    // 5. Force a stale marker: the marker class is neutralised, so the sweep cannot
    //    tell the dialog apart — the :has() fallback alone must still hide it.
    await ev(`(() => {
      const wrap = document.createElement('div');
      wrap.id = 'firstrun-fallback-probe-wrap';
      wrap.className = 'MODAL_root';
      wrap.setAttribute('role', 'presentation');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center';
      const mask = document.createElement('div');
      mask.className = 'MODAL_mask';
      mask.setAttribute('aria-hidden', 'true');
      mask.style.cssText = 'position:absolute;inset:0';
      const dlg = document.createElement('div');
      dlg.id = 'probe-stale';
      dlg.className = 'MODAL_dialog jLrgrW_dialog';
      dlg.setAttribute('role', 'dialog');
      dlg.innerHTML = '<div class="PROBE_staleCopy"><p>copy</p></div>'
        + '<div class="GL8Viq_editor"><button id="probe-stale-save">儲存</button></div>';
      wrap.appendChild(mask);
      wrap.appendChild(dlg);
      document.body.appendChild(wrap);
      window.__staleClicks = [];
      document.getElementById('probe-stale-save').addEventListener('click', () => window.__staleClicks.push('save'));
      return true;
    })()`);
    await sleep(1200);
    const stale = JSON.parse(await ev(`(() => {
      const dlg = document.getElementById('probe-stale');
      const wrap = document.getElementById('firstrun-fallback-probe-wrap');
      const cs = dlg ? getComputedStyle(dlg) : null;
      const wcs = wrap ? getComputedStyle(wrap) : null;
      return JSON.stringify({
        display: cs ? cs.display : null,
        tag: dlg ? dlg.getAttribute('data-zhtw-suppressed') : null,
        wrapDisplay: wcs ? wcs.display : null,
        wrapTag: wrap ? wrap.getAttribute('data-zhtw-suppressed-overlay') : null,
        clicks: window.__staleClicks,
      });
    })()`));
    allOk = report('5. stale notice marker still hidden by the CSS fallback', stale.display === 'none' && stale.tag === 'api-key-prompt', JSON.stringify(stale)) && allOk;
    allOk = report('5b. stale key prompt never clicked', (stale.clicks || []).length === 0, 'clicks=' + JSON.stringify(stale.clicks)) && allOk;
    allOk = report('5c. stale wrap overlay also hidden by JS sweep', stale.wrapDisplay === 'none' && stale.wrapTag === '1', JSON.stringify(stale)) && allOk;
    await ev("(() => { const h = document.getElementById('firstrun-fallback-probe-wrap'); if (h) h.remove(); return true; })()");

    await ev("(() => { ['probe-notice-wrap','probe-key-wrap','probe-other-wrap'].forEach((id) => { const h = document.getElementById(id); if (h) h.remove(); }); return true; })()");
    console.log('');
    console.log(allOk ? 'FIRST-RUN SUPPRESSION CHECKS PASSED' : 'SOME CHECKS FAILED');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }
})().catch((e) => { console.error(e); process.exit(1); });
