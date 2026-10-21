'use strict';
// 验证「右下角浮动时钟」开关：
//   1) 默认显示（localStorage 里没有键）
//   2) 关 → 浮动层整个消失
//   3) 重载 → 仍然关着（持久化）
//   4) 再开 → 浮动层回来
//   5) 重载 → 仍然开着
// 用法: node test/verify-float-toggle.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const WS = 'D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws';
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const PORT = 9401;
const WebSocket = require(WS);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = BROWSERS.find((p) => fs.existsSync(p));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'floattoggle-'));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--remote-allow-origins=*', '--user-data-dir=' + dir,
    '--window-size=1400,950', 'about:blank'], { stdio: 'ignore' });

  let ws = null;
  const results = [];
  const assert = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  };

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

    await send('Page.enable'); await send('Runtime.enable');

    const load = async () => {
      await send('Page.navigate', { url: 'http://127.0.0.1:3080' });
      for (let i = 0; i < 120; i += 1) { await sleep(400); if (await ev("!!document.querySelector('.cute-clock-navicon, .cute-clock-glyph')").catch(() => false)) break; }
      await sleep(2000);
    };
    const openPanel = async () => {
      await ev(`(() => {
        const hit = Array.from(document.querySelectorAll('span,button,div,a'))
          .find((el) => el.className && String(el.className).indexOf('cute-clock-glyph') >= 0);
        if (!hit) return 'no-glyph';
        hit.click();
        const row = hit.closest('[class*="panelRow"]') || hit.parentElement;
        if (row && row !== hit) row.click();
        return 'clicked';
      })()`);
      for (let i = 0; i < 40; i += 1) { await sleep(250); if (await ev("!!document.querySelector('.cute-clock-page')")) return true; }
      return false;
    };
    const floatState = () => ev(`(() => {
      const overlay = document.querySelector('[data-cute-clock-float]');
      const card = document.querySelector('.cute-clock-card');
      return {
        overlayPresent: !!overlay,
        cardPresent: !!card,
        cardVisible: card ? getComputedStyle(card).visibility : 'n/a',
        stored: (() => { try { return localStorage.getItem('cute-clock:floating-visible'); } catch (e) { return 'ERR'; } })(),
      };
    })()`);
    const toggleState = () => ev(`(() => {
      const box = document.querySelector('[data-cute-toggle="floating-visible"]');
      if (!box) return { present: false };
      const input = box.querySelector('input');
      const b = box.getBoundingClientRect();
      // 内容区左缘 = 最近的、真正“收缩”过的 overflow:hidden 祖先
      // （外层 frame 从 0 开始、整页裁切；真正划出内容区的是更里层的 centerCol）
      let boundLeft = null;
      let el = box.parentElement;
      while (el && el !== document.documentElement) {
        const s = getComputedStyle(el);
        if (s.overflow !== 'visible' && s.overflow !== '') {
          const br = el.getBoundingClientRect();
          if (br.width > 0) {
            if (boundLeft === null) boundLeft = br.left;
            else boundLeft = Math.max(boundLeft, br.left);
          }
        }
        el = el.parentElement;
      }
      if (boundLeft === null) boundLeft = 0;
      const cx = Math.round(b.left + b.width / 2);
      const cy = Math.round(b.top + b.height / 2);
      const hitEl = document.elementFromPoint(cx, cy);
      return {
        present: true,
        dataOn: box.getAttribute('data-on'),
        checked: !!input.checked,
        disabled: !!input.disabled,
        text: box.textContent.trim(),
        box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)],
        boundLeft: Math.round(boundLeft),
        gapFromContentLeft: Math.round(b.left - boundLeft),
        gapBottom: Math.round(window.innerHeight - b.bottom),
        clickable: !!(hitEl && box.contains(hitEl)),
        viewport: [window.innerWidth, window.innerHeight],
      };
    })()`);
    const clickSwitch = () => ev(`(() => {
      const input = document.querySelector('[data-cute-toggle="floating-visible"] input');
      if (!input) return 'no-input';
      input.click();
      return 'clicked';
    })()`);

    // 清掉可能殘留的設定，測「預設」
    await load();
    await ev(`try { localStorage.removeItem('cute-clock:floating-visible'); } catch (e) {}`);
    await load();

    console.log('\n[1] 默认状态（localStorage 无键）');
    let s = await floatState();
    assert('默认显示浮动层', s.overlayPresent && s.cardPresent, JSON.stringify(s));
    assert('默认未写 localStorage', s.stored === null, 'stored=' + s.stored);
    assert('打开面板', await openPanel());
    let t = await toggleState();
    assert('开关键存在', t.present === true);
    assert('开关默认=开', t.dataOn === '1' && t.checked === true && t.disabled === false, JSON.stringify(t));
    assert('开关没有文字说明', t.text === '', 'text=' + JSON.stringify(t.text));
    assert('开关在左下角（内容区左缘+18, 底部18）',
      Math.abs(t.gapFromContentLeft - 18) <= 2 && Math.abs(t.gapBottom - 18) <= 2,
      'gapFromContentLeft=' + t.gapFromContentLeft + ' gapBottom=' + t.gapBottom +
      ' boundLeft=' + t.boundLeft + ' viewport=' + t.viewport);
    assert('开关可点（没被侧栏/浮层盖住）', t.clickable === true, 'clickable=' + t.clickable);

    console.log('\n[2] 点开关 → 关闭');
    await clickSwitch();
    await sleep(600);
    s = await floatState();
    assert('浮动层整个消失', !s.overlayPresent && !s.cardPresent, JSON.stringify(s));
    assert('已写入 localStorage=0', s.stored === '0', 'stored=' + s.stored);
    t = await toggleState();
    assert('开关变成关', t.dataOn === '0' && t.checked === false, JSON.stringify(t));

    console.log('\n[3] 重载页面 → 关闭状态保持');
    await load();
    s = await floatState();
    assert('重载后仍然隐藏', !s.overlayPresent, JSON.stringify(s));
    assert('面板里开关仍是关', (await openPanel()) && (await toggleState()).dataOn === '0');

    console.log('\n[4] 再点一次 → 打开（全局）');
    await clickSwitch();
    await sleep(600);
    s = await floatState();
    assert('浮动层回来', s.overlayPresent && s.cardPresent, JSON.stringify(s));
    assert('已写入 localStorage=1', s.stored === '1', 'stored=' + s.stored);
    t = await toggleState();
    assert('开关变成开', t.dataOn === '1' && t.checked === true, JSON.stringify(t));

    console.log('\n[5] 重载页面 → 打开状态保持');
    await load();
    s = await floatState();
    assert('重载后仍然显示', s.overlayPresent && s.cardPresent, JSON.stringify(s));

    // 收尾：恢复到默认（清键），别把测试状态留给你
    await ev(`try { localStorage.removeItem('cute-clock:floating-visible'); } catch (e) {}`);
    console.log('\n已清理测试写入的 localStorage 键');
  } finally {
    try { if (ws) ws.close(); } catch (_) {}
    try { child.kill(); } catch (_) {}
  }

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + (failed.length ? '❌ ' + failed.length + ' 项失败' : '✅ 全部通过（' + results.length + ' 项）'));
  if (failed.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
