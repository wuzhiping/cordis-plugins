// =============================================================================
// cute-clock · lib/client.js
// 一個住在 DSH Web GUI 角落裡的元氣時鐘 🕐
//
// 註冊三個位置：
//   1. shell.overlay      —— 永遠飄在右下角的元氣小時鐘（問候語 + slogan + 時分秒）
//   2. sidebar.panellist  —— 左欄圖示 🕐
//   3. main (keyed)       —— 點圖示後展開的"元氣時鐘"全域面板
//
// 設計要點：
//   - 配色全部走 DSH 主題令牌（--dsw-*），明暗主題自動適配
//   - SVG 畫一個圓潤鐘面：圓耳、眼睛（會眨）、腮紅、笑臉、愛心
//   - 秒針帶輕微彈性，分針/時針平滑
//   - 問候語按時辰切換（早安/午安/晚安/夜深了…）
//   - 三個座位對所有 agent preset 一律渲染（舊版的「辦公模式退場」已移除）
// =============================================================================

window.__ModuleLoader__.load({
  id: 'cute-clock',
  factory: function (require) {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useMemo = React.useMemo;
    var e = React.createElement;

    var inject = ['slots'];

    // =========================================================================
    // 0. 左欄圖示 —— 與 DSH 其他面板圖示同一套規矩
    //
    // 官方圖示是 @deepseek-ai/dsh-client-ui-primitives 裡的元件，但靜態 bundle 的
    // require 拿不到 Harness 使用者端包，所以照 fdep-api-request 的做法手寫 inline SVG：
    //   - 16x16 viewBox，描邊 1.5，stroke/fill 都用 currentColor
    //   - 尺寸用 owner 傳進來的 props.size（側欄給 16 或 18）
    //   - 不帶自己的背景/懸停動畫：懸停與啟用底色由側欄的 panelRow 負責
    // 圖形是"圓耳 + 錶盤 + 指針"，保住元氣時鐘的身份，同時是單色線稿。
    // =========================================================================
    function EnergyClockGlyph(props) {
      var size = (props && props.size) || 18;
      var active = !!(props && props.active);
      return e('span', {
        className: 'cute-clock-glyph' + (active ? ' cute-clock-glyph--active' : ''),
        style: { width: size + 'px', height: size + 'px' },
        onClick: props && props.onClick
      },
        e('svg', {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false'
        },
          // 左耳 / 右耳
          e('path', { d: 'M4.75 4.45 4.25 1.9 6.7 3.3' }),
          e('path', { d: 'M11.25 4.45 11.75 1.9 9.3 3.3' }),
          // 表盤
          e('circle', { cx: 8, cy: 8.6, r: 5.15 }),
          // 指針（時針 + 分針，同一折線）
          e('path', { d: 'M8 5.7v2.9l1.95 1.2' })
        )
      );
    }

    // =========================================================================
    // 1. CSS —— 全部用 DSH 主題令牌，切明暗主題自動適配
    // =========================================================================
    var CLOCK_CSS = [
      // ---------- 漂浮小元件 ----------
      // 位置：右下角，`bottom:33px` 比原本的 18px 再高 15px（`right` 維持 18px）。
      '.cute-clock-overlay{',
      '  position:fixed;right:18px;bottom:33px;z-index:9999;',
      '  pointer-events:auto;user-select:none;',
      '  font-family:var(--sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif)',
      '}',
      '.cute-clock-card{',
      '  display:flex;align-items:center;gap:12px;',
      '  padding:10px 16px 10px 12px;',
      '  background:var(--dsw-alias-bg-layer-1,#ffffff);',
      '  border:1.5px solid var(--dsw-alias-border-l2,#c9d0da);',
      '  border-radius:22px;',
      '  box-shadow:var(--dsw-elevation-panel,0 6px 26px rgba(15,23,42,.10));',
      '  transition:box-shadow .25s ease;',
      '  cursor:default;',
      '}',
      // Hover 只改陰影，**不改幾何**：`.cute-clock-card` 的外框就是隱藏判斷要量的那個
      // 盒子，任何位移／旋轉都會讓量到的矩形改變 —— 卡片稍微移一下就跨過判定邊界，
      // 於是「隱藏 → 滑鼠離開 → 顯示 → 又 hover」來回跳，看起來就是閃爍。
      // （實測舊版：hover 讓 top 639→633、高度 89→94。）
      '.cute-clock-card:hover{',
      '  box-shadow:0 12px 36px rgba(77,107,254,.22);',
      '}',
      // ---------- 讓位模式（輸入區和角落卡片重疊時）----------
      // 擋到輸入區就**整塊隱藏**：淡出 + `visibility:hidden`（連帶讓出點擊，
      // 也不必再管 pointer-events）。沒有任何殘留的小圖標或藥丸 ——
      // 右下角完全讓給輸入區，焦點離開後卡片自己淡回來。
      '.cute-clock-card--away{',
      '  opacity:0;visibility:hidden;pointer-events:none;',
      '}',
      '.cute-clock-face{position:relative;width:54px;height:54px;flex:none}',
      '.cute-clock-svg{width:100%;height:100%;overflow:visible;display:block}',
      '.cute-clock-eye{transform-origin:center;animation:cute-blink 4.6s infinite}',
      '.cute-clock-eye.right{animation-delay:.08s}',
      '@keyframes cute-blink{0%,92%,96%,100%{transform:scaleY(1)}94%{transform:scaleY(.1)}}',
      '.cute-clock-ear{transform-origin:center bottom;animation:cute-twitch 5.4s infinite}',
      '.cute-clock-ear.right{animation-delay:1.3s}',
      '@keyframes cute-twitch{0%,86%,100%{transform:rotate(0)}90%{transform:rotate(-7deg)}92%{transform:rotate(6deg)}}',
      '.cute-clock-hand-second{transition:transform .18s cubic-bezier(.34,1.56,.64,1)}',
      '.cute-clock-heart{transform-origin:center;animation:cute-pulse 1.4s ease-in-out infinite}',
      '@keyframes cute-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.22)}}',
      // 文字欄固定寬度，卡片寬度才不會隨 slogan 長短跳動 —— 也就是「窄 15px」
      // 能真的量得出來：這一欄比之前的最大值少 15px（見 README 的實測數字）。
      // 太長的 slogan 照舊截斷（`text-overflow:ellipsis`），完整句子在 hover 的
      // `title` 裡。
      '.cute-clock-text{display:flex;flex-direction:column;gap:2px;width:165px;min-width:0;line-height:1.2}',
      '.cute-clock-greet{font-size:10.5px;font-weight:700;color:var(--dsw-alias-brand-primary,#4d6bfe);letter-spacing:.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.cute-clock-slogan{font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary,#43506b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;animation:cute-pop .5s cubic-bezier(.34,1.56,.64,1)}',
      '@keyframes cute-pop{0%{transform:scale(.86);opacity:0}100%{transform:scale(1);opacity:1}}',
      // 時分秒用等寬數字：秒數每秒變一次，比例字型的寬度會跟著跳，卡片外框也跟著
      // 動 —— 那就等於「每秒抖一下」，同樣會擾動隱藏判斷。等寬之後寬度固定。
      '.cute-clock-time{font-size:19px;font-weight:800;color:var(--dsw-alias-label-primary,#131926);font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;letter-spacing:.3px}',
      '.cute-clock-date{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7891)}',

      // ---------- 左欄圖示 ----------
      // 只畫圖形：顏色靠 currentColor 繼承側欄行的 label-primary，懸停/啟用的
      // 底色由側欄的 .hHd-Xa_panelRow 提供（自帶背景或縮放動畫會和其他圖示不一樣）。
      '.cute-clock-glyph{display:inline-flex;align-items:center;justify-content:center}',
      '.cute-clock-glyph--active{opacity:1}',
      '.cute-clock-glyph svg{display:block}',

      // ---------- 全域面板 ----------
      // 內容整組往左 50px：這個面板的寬度包含左欄，光靠 flex 居中會讓鐘面、時間、
      // slogan 全部落在整頁中線偏右；`transform` 只挪位置不改排版，所以內部仍各自
      // 居中（背景那層 `::before` 也一起移，不會露邊）。
      '.cute-clock-page{',
      '  position:relative;',
      '  width:100%;height:100%;min-height:100%;',
      '  display:flex;flex-direction:column;align-items:center;justify-content:center;',
      '  gap:24px;padding:40px 24px;',
      '  transform:translateX(-50px) translateY(-40px);',
      '  background:radial-gradient(circle at 50% 30%,var(--dsw-alias-bg-layer-1,#ffffff) 0%,var(--dsw-alias-bg-base,#f6f7f9) 70%);',
      '  font-family:var(--sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif);',
      '  overflow:hidden;',
      '}',
      '.cute-clock-page::before{',
      '  content:"";position:absolute;inset:0;pointer-events:none;',
      '  background-image:',
      '    radial-gradient(circle at 20% 80%,var(--dsw-alias-brand-primary,#4d6bfe) 0,transparent 8%),',
      '    radial-gradient(circle at 80% 20%,var(--dsw-alias-state-business-primary,#7c3aed) 0,transparent 8%),',
      '    radial-gradient(circle at 90% 90%,var(--dsw-alias-state-warn-primary,#d97706) 0,transparent 6%);',
      '  opacity:.08;',
      '}',
      '.cute-clock-bigface{position:relative;width:min(360px,80vw);height:min(360px,80vw);z-index:1;filter:drop-shadow(0 18px 40px rgba(77,107,254,.18))}',
      '.cute-clock-bigtime{',
      '  font-size:min(72px,14vw);font-weight:800;',
      '  color:var(--dsw-alias-label-primary,#131926);',
      '  font-variant-numeric:tabular-nums;letter-spacing:2px;line-height:1;',
      '  text-align:center;z-index:1;',
      '  text-shadow:0 4px 18px rgba(77,107,254,.12);',
      '}',
      '.cute-clock-bigdate{',
      '  font-size:min(18px,3vw);font-weight:600;',
      '  color:var(--dsw-alias-label-secondary,#43506b);',
      '  text-align:center;z-index:1;',
      '}',
      // 大頁面的 slogan：13.5px → 27px（×2）→ 54px（×2）都偏大，最後取 54 的 60%
      // ＝32px（約原始 2.4 倍）。行高與內距同比縮，`max-width` 讓長句自然換行。
      '.cute-clock-bigquote{',
      '  margin-top:6px;padding:12px 29px;max-width:min(760px,88vw);',
      '  font-size:32px;line-height:1.3;font-weight:700;text-align:center;',
      '  color:var(--dsw-alias-brand-primary,#4d6bfe);',
      '  background:var(--dsw-alias-interactive-bg-hover,rgba(77,107,254,.08));',
      '  border-radius:999px;z-index:1;',
      '  cursor:pointer;user-select:none;',
      '  animation:cute-pop .5s cubic-bezier(.34,1.56,.64,1);',
      '}',
      '.cute-clock-bigquote:hover{',
      '  background:var(--dsw-alias-brand-primary,#4d6bfe);',
      '  color:var(--dsw-alias-bg-layer-1,#ffffff);',
      '  transform:scale(1.04);',
      '}',
      '.cute-clock-bigquote:active{transform:scale(.97)}',
      '@keyframes cute-wiggle{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-3px) rotate(.6deg)}}',

      // 飄落的小花瓣
      '.cute-clock-petal{',
      '  position:absolute;top:-30px;font-size:18px;opacity:0;pointer-events:none;',
      '  animation:cute-fall linear infinite;',
      '}',
      '@keyframes cute-fall{',
      '  0%{transform:translateY(-30px) rotate(0);opacity:0}',
      '  10%{opacity:.8}',
      '  90%{opacity:.8}',
      '  100%{transform:translateY(110vh) rotate(540deg);opacity:0}',
      '}',

      // 讓指針走得更流暢
      '.cute-clock-hand-minute,.cute-clock-hand-hour{transition:transform .25s cubic-bezier(.4,.0,.2,1)}',

      // ====================== 浮層開關（視窗左下角）======================
      // 只有一顆 46×26 的膠囊開關，沒有說明文字。
      // 先以 `left:18px;bottom:18px` 定位在 `.cute-clock-page` 內；page 自帶 transform
      // 會讓這個座標偏掉，所以元件掛載後用 `measurePageCompensation()` 量出實際
      // 需要補的位移，再以 inline `transform` 把它釘回**視窗左下角** 18/18
      // （不在 CSS 裡寫死補償值 —— 那會隨 DSH 版面變而失效）。
      // 開關本體是原生 `<input type="checkbox">`（Tab / Space 可用，role=switch），
      // 只把外觀用 `appearance:none` 重畫成膠囊。
      '.cute-toggle{',
      '  position:absolute;left:18px;bottom:18px;z-index:6;',
      '  display:flex;align-items:center;',
      '  padding:4px 6px;border-radius:999px;',
      '  background:var(--dsw-alias-bg-layer-1,#ffffff);',
      '  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      '  box-shadow:0 4px 16px rgba(15,23,42,.18);',
      '  user-select:none;',
      '  transition:box-shadow .2s ease,border-color .2s ease;',
      '}',
      '.cute-toggle:hover{',
      '  border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      '  box-shadow:0 6px 22px rgba(15,23,42,.28);',
      '}',
      '.cute-toggle__switch{position:relative;display:inline-flex;flex:none;width:46px;height:26px;cursor:pointer}',
      '.cute-toggle__input{',
      '  position:absolute;inset:0;width:100%;height:100%;margin:0;',
      '  appearance:none;-webkit-appearance:none;',
      '  background:var(--dsw-alias-bg-layer-2,#e6e9ef);',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      '  border-radius:999px;cursor:pointer;outline:none;',
      '  transition:background .22s ease,border-color .22s ease,box-shadow .22s ease;',
      '}',
      '.cute-toggle__input:checked{',
      '  background:var(--dsw-alias-brand-primary,#4d6bfe);',
      '  border-color:var(--dsw-alias-brand-primary,#4d6bfe);',
      '}',
      '.cute-toggle__input:focus-visible{box-shadow:0 0 0 3px rgba(77,107,254,.35)}',
      '.cute-toggle__knob{',
      '  position:absolute;top:3px;left:3px;',
      '  width:18px;height:18px;border-radius:50%;',
      // 滑塊顏色用「表面色」而不是固定白色：開啟時軌道是 brand-primary，
      // 但這個 token 在深色主題解析成近白（#f9fafb）而不是藍色 —— 白色滑塊
      // 會跟軌道融成一塊（實測 input/knob 都是 rgb(255,255,255)）。
      // 改用 bg-layer-1（深色 #232324 / 淺色 #ffffff）就能在兩種主題下都拉開對比。
      '  background:var(--dsw-alias-bg-layer-1,#ffffff);',
      '  border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.18));',
      '  box-shadow:0 1px 3px rgba(0,0,0,.28);',
      '  pointer-events:none;',
      '  transition:transform .24s cubic-bezier(.34,1.56,.64,1),background .2s;',
      '}',
      '.cute-toggle__input:checked + .cute-toggle__knob{transform:translateX(20px)}',
      '.cute-toggle__input:disabled{cursor:wait;opacity:.6}',

      // ====================== 用量小卡（cute-usage）======================
      // 位置：釘在**視窗**右上角。
      //
      // 為什麼不是 `position:absolute` 或 `position:fixed` 簡單解：
      //   - absolute 的話，卡片作為 `.cute-clock-page` 子節點，會被 page 的
      //     `transform:translateX(-50px) translateY(-40px)` 推走，視窗上看
      //     top = page.top + 18 - 40 = -22（偏上）。
      //   - fixed 的話，CSS 規則是 fixed 元素的 containing block 是「最近的
      //     有 transform 的祖先」，page 仍然把卡片捕獲了，視窗上看一樣是 -22。
      //   - portal 到 document.body 不可用：DSH 用的 React 太舊，沒有
      //     `React.createPortal`。
      //
      // 解法：仍然 absolute 在 page 內，但卡片自己加 `transform:translate(2px, 40px)`
      // 把 page 的反向推回來。視窗上的最終位置：
      //   right 邊 = (page.right - 18) + 50 = viewport.right - 18
      //   top    = (page.top + 18) + 40 = 18
      // 50 / 40 這兩個數字跟 page 的 transform 配對 —— 將來如果 DSH 改了 page 的
      // transform，這兩個值要手動跟著校準。
      //
      // 配色全部走 DSH 主題令牌 —— 切明暗主題自動跟。
      '.cute-usage{',
      '  position:absolute;right:18px;top:18px;z-index:5;',
      '  width:200px;',
      '  background:var(--dsw-alias-bg-layer-1,#ffffff);',
      '  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      '  border-radius:12px;',
      '  box-shadow:0 4px 16px rgba(0,0,0,.10);',
      '  font-family:var(--sans,-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC","Microsoft YaHei",sans-serif);',
      '  color:var(--dsw-alias-label-primary,#131926);',
      '  user-select:none;cursor:pointer;',
      '  overflow:hidden;',
      '  transition:width .2s ease,box-shadow .2s ease;',
      '}',
      '.cute-usage--expanded{width:268px;cursor:default}',
      '.cute-usage--err{box-shadow:0 4px 16px rgba(217,119,6,.18)}',
      '.cute-usage__head{',
      '  display:flex;align-items:center;justify-content:space-between;',
      '  padding:8px 12px;',
      '  border-bottom:1px solid transparent;',
      '  transition:border-color .15s;',
      '}',
      '.cute-usage--expanded .cute-usage__head{border-bottom-color:var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.cute-usage__title{font-size:11px;font-weight:700;letter-spacing:.5px;color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.cute-usage__chev{font-size:10px;color:var(--dsw-alias-label-tertiary,#6b7891);margin-left:6px;transition:transform .15s}',
      '.cute-usage--expanded .cute-usage__chev{transform:rotate(180deg)}',
      '.cute-usage__summary{padding:6px 12px 10px 12px}',
      '.cute-usage__line{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}',
      '.cute-usage__used{color:var(--dsw-alias-label-primary,#131926)}',
      '.cute-usage__sep{color:var(--dsw-alias-label-tertiary,#6b7891);font-weight:400}',
      '.cute-usage__budget{color:var(--dsw-alias-label-secondary,#43506b);font-weight:600}',
      '.cute-usage__period{color:var(--dsw-alias-label-tertiary,#6b7891);font-weight:400;font-size:11px;margin-left:2px}',
      '.cute-usage__bar{',
      '  height:4px;background:var(--dsw-alias-bg-layer-2,#f0f2f5);',
      '  border-radius:2px;margin-top:6px;overflow:hidden;',
      '}',
      '.cute-usage__bar-fill{',
      '  height:100%;',
      '  background:var(--dsw-alias-state-warn-primary,#d97706);',
      '  transition:width .3s ease;',
      '}',
      '.cute-usage__pct{font-size:10px;color:var(--dsw-alias-label-tertiary,#6b7891);margin-top:3px;text-align:right}',
      '.cute-usage__detail{padding:8px 12px 10px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08))}',
      '.cute-usage__row{display:flex;justify-content:space-between;align-items:center;font-size:11px;line-height:1.55}',
      '.cute-usage__k{color:var(--dsw-alias-label-tertiary,#6b7891)}',
      '.cute-usage__v{color:var(--dsw-alias-label-primary,#131926);font-weight:600;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}',
      '.cute-usage__mono{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-weight:500}',
      '.cute-usage__sep-row{height:6px}',
      '.cute-usage__actions{padding-top:8px;display:flex;justify-content:flex-end}',
      '.cute-usage__btn{',
      '  background:transparent;',
      '  border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      '  border-radius:6px;',
      '  padding:3px 9px;',
      '  font-size:10.5px;color:var(--dsw-alias-label-secondary,#43506b);',
      '  cursor:pointer;',
      '  transition:background .12s,border-color .12s;',
      '}',
      '.cute-usage__btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,#f0f2f5);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.18))}',
      '.cute-usage__btn:disabled{opacity:.5;cursor:not-allowed}',
      '.cute-usage__err-tip{',
      '  padding:0 12px 8px 12px;',
      '  font-size:10px;color:var(--dsw-alias-state-warn-primary,#d97706);',
      '  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      '}',
    ].join('\n');

    // =========================================================================
    // 2. 工具函式
    // =========================================================================
    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function getGreeting(h) {
      if (h < 5)  return '🌙 夜深啦';
      if (h < 9)  return '🌅 早安呀';
      if (h < 11) return '☀️ 上午好';
      if (h < 13) return '🍱 午飯時間';
      if (h < 14) return '😴 小憩一下';
      if (h < 18) return '🌤️ 下午好';
      if (h < 19) return '🌆 傍晚啦';
      if (h < 22) return '🌃 晚上好';
      return '🌙 夜深啦';
    }

    function bucketOf(h) {
      if (h < 9)        return 'morning';
      if (h < 14)       return 'noon';
      if (h < 18)       return 'afternoon';
      if (h < 22)       return 'evening';
      return 'night';
    }

    // -------------------------------------------------------------------------
    // 活力滿滿的 slogan 彈藥庫 💪
    // 每一條都自帶幹勁，按時間段分桶，讀起來更順口。
    // 每次開啟面板 / 重新整理頁面都會從當前時段裡隨機抽一條，所以每次都不一樣。
    // 想加新句子，直接往對應陣列裡塞就行（陣列長度不限）。
    // -------------------------------------------------------------------------
    var ENERGY_PACK = {
      morning: [
        '起床就是勝利，今天穩贏 ✨',
        '早安！元氣已經加滿 100% 💪',
        '先喝口水，再幹翻今天 ☀️',
        '新的一天，新的超能力 🌱',
        '你一睜眼，今天就有救了 🌞',
        '今天的你，比昨天更能打 ⚡',
        '把懶蟲按回去，衝鴨 🐣',
        '晨光這麼好，適合幹大事 🌅',
        '深呼吸，今天由我承包 🚀',
        '身體醒了，夢想也醒了 🔥',
        '狀態在線，好運排隊進場 🍀',
        '第一件事：把今天過漂亮 🌸',
        '你比你想象的更有勁 💫',
        '開工！今天也是閃閃發光的一天 ⭐',
        '早飯吃飽，天下我有 🍳'
      ],
      noon: [
        '吃飽了才有力氣幹活 🍱',
        '午後的我，電量滿格 🔋',
        '飯香一入口，戰鬥力翻倍 🍚',
        '幹飯人上線，幹活人更強 💪',
        '歇五分鐘，再戰五小時 😤',
        '吃飽喝足，難題全部退散 🥢',
        '先把胃喂飽，再把事辦成 🍜',
        '午飯是今天的第二次加油 ⛽',
        '能量已補充，請繼續衝鋒 🚀',
        '吃飽才有力氣說"我可以" ✨',
        '一口飯一口幹勁，絕配 😋',
        '中場休息結束，繼續發光 🌟',
        '胃暖了，心也熱了，幹活去 🔥',
        '吃好這一頓，下午不認輸 💥',
        '小憩一下，回來更猛 😴'
      ],
      afternoon: [
        '下午的太陽也攔不住我 ☀️',
        '再堅持一下，進度條在動 ⏳',
        '一口氣幹完，晚上才痛快 🎯',
        '你現在的努力，年底會替你還願 🎁',
        '狀態有點困？那就更酷一點 😎',
        '把大任務切成小口，一口一口吃 🍰',
        '進度 50%，氣勢 100% 💪',
        '別人在打盹，你在打怪 ⚔️',
        '慢一點沒關係，別停就行 🐢',
        '來杯咖啡，把下午點亮 ☕',
        '手在動，夢在靠近 ✨',
        '你已經比剛才的自己更厲害了 📈',
        '難題只是還沒被你拆開而已 🔧',
        '撐住，傍晚會給你獎勵 🌈',
        '再推一把，今天不留遺憾 🏁'
      ],
      evening: [
        '今天辛苦了，你真的很能扛 🌆',
        '收工前，再漂亮地收個尾 🎬',
        '夕陽給你打光，繼續發光 🌇',
        '白天沒白費，晚上好好獎勵自己 🍲',
        '努力了一天，值得一句"幹得好" 👏',
        '把今天的疲憊兌成明天的底氣 💪',
        '天黑之前，再贏一小局 🏆',
        '你認真起來的樣子真好看 🌟',
        '收好今天的戰績，明天繼續 📋',
        '下班是另一種開工：好好生活 🛋️',
        '路燈亮了，你的努力也亮着 💡',
        '今天你已經贏過了昨天的自己 🥇',
        '晚餐加個雞腿，犒勞一下英雄 🍗',
        '慢慢走，穩穩贏 🚶',
        '今天的坑都填平了，厲害 🕳️'
      ],
      night: [
        '夜裡也在努力的人，運氣不會差 🌙',
        '早睡是明天最強的外掛 😴',
        '今天到此為止，明天繼續贏 🌜',
        '別熬啦，夢裡也能開掛 ✨',
        '睡飽了，明天才有力氣囂張 💤',
        '把煩惱交給月亮，晚安 🌌',
        '月亮在充電，你也是 🔋',
        '好好休息，也是一種努力 🛏️',
        '明天的你，會謝謝今晚早睡的你 🙏',
        '夜深了，英雄也要下線休息 🦸',
        '夢裡繼續通關，晚安 💫',
        '今晚的安靜，是明天的馬力 🌠',
        '手機放下，好運上線 🍀',
        '睡個好覺，明天繼續發光 ⭐',
        '收工睡覺，明天再戰 💪'
      ]
    };

    // 隨機抽一條（可選 scope 限定時間段；rand 可注入，方便測試）
    function pickEnergySlogan(scope, rand) {
      var r = typeof rand === 'function' ? rand : Math.random;
      var list = ENERGY_PACK[scope];
      if (!list || !list.length) {
        var all = [];
        for (var k in ENERGY_PACK) {
          if (Object.prototype.hasOwnProperty.call(ENERGY_PACK, k)) all = all.concat(ENERGY_PACK[k]);
        }
        list = all;
      }
      return list[Math.floor(r() * list.length)] || list[0];
    }

    // 相容舊呼叫：按時辰抽一條活力 slogan（每次呼叫結果都可能不同）
    function getQuote(h) {
      return pickEnergySlogan(bucketOf(h));
    }

    var WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

    // =========================================================================
    // 2.5 浮層開關的共享狀態（全域、可持久化）
    //
    // 需求：「頁面 UI 裡加一個開關，能全域關閉右下角那塊浮動時鐘，預設開著」。
    //
    // 這裡刻意**不用 Context**：兩個消費者（`shell.overlay` 的浮動卡片、`main` 的
    // 全局面板）是兩個互不相干的 slot，沒有共同祖先可以掛 Provider；而
    // `React.createPortal` 在這個版本的 React 也不可用。所以用一個模組層級的
    // 小 store + 訂閱，任何一個座位改了狀態，另一個立刻跟著變。
    //
    // 持久化：`localStorage`（跨工作階段、跨重載都記得；預設 = 顯示）。
    // 讀寫全部包 try/catch —— 隱私模式 / 停用儲存時不該讓整個插件炸掉。
    // =========================================================================
    var FLOAT_VISIBLE_KEY = 'cute-clock:floating-visible';

    function readFloatVisible() {
      try {
        var raw = window.localStorage.getItem(FLOAT_VISIBLE_KEY);
        if (raw === null) return true;          // 沒存過 → 預設顯示
        return raw !== '0';                     // '0' 才算關閉
      } catch (err) {
        return true;                            // 讀不到就當作預設值，不影響渲染
      }
    }

    function writeFloatVisible(visible) {
      try {
        window.localStorage.setItem(FLOAT_VISIBLE_KEY, visible ? '1' : '0');
      } catch (err) {
        // 存不了就只在本次生命週期內生效，不拋錯
      }
    }

    var floatVisible = readFloatVisible();
    var floatListeners = [];

    function currentFloatVisible() {
      return floatVisible;
    }

    function setFloatVisible(visible) {
      var next = !!visible;
      if (next === floatVisible) return;
      floatVisible = next;
      writeFloatVisible(next);
      var snapshot = floatListeners.slice();
      for (var i = 0; i < snapshot.length; i += 1) {
        try { snapshot[i](); } catch (err) { /* 單一訂閱者出錯不影響其他人 */ }
      }
    }

    function subscribeFloatVisible(listener) {
      floatListeners.push(listener);
      return function unsubscribe() {
        var idx = floatListeners.indexOf(listener);
        if (idx >= 0) floatListeners.splice(idx, 1);
      };
    }

    /**
     * 訂閱「浮動時鐘是否顯示」。
     *
     * 優先用 `React.useSyncExternalStore`（React 18+，不會有撕裂讀取）；
     * 拿不到就退化為 `useState` + `useEffect` 訂閱 —— 行為一致，只是多一次 render。
     * DSH 出貨的 React 版本不一定有這個 hook，所以兩條路都要留。
     *
     * @returns 目前是否顯示浮動時鐘（預設 true）。
     */
    function useFloatVisible() {
      if (typeof React.useSyncExternalStore === 'function') {
        // eslint-disable-next-line react-hooks/rules-of-hooks
        return React.useSyncExternalStore(subscribeFloatVisible, currentFloatVisible, currentFloatVisible);
      }
      // eslint-disable-next-line react-hooks/rules-of-hooks
      var pair = useState(function () { return readFloatVisible(); });
      var value = pair[0];
      var setValue = pair[1];
      // eslint-disable-next-line react-hooks/rules-of-hooks
      useEffect(function () {
        function sync() { setValue(currentFloatVisible()); }
        sync();                                 // 掛載時先對齊 store 現值
        return subscribeFloatVisible(sync);
      }, []);
      return value;
    }

    // =========================================================================
    // 3. 元氣時鐘的錶面（SVG）—— 一個圓潤鐘面
    // =========================================================================
    function EnergyClockSVG(props) {
      var now = props.now || new Date();
      var size = props.size || 100; // 檢視盒尺寸

      var h = now.getHours() % 12;
      var m = now.getMinutes();
      var s = now.getSeconds();

      var secAngle = s * 6;
      var minAngle = m * 6 + s * 0.1;
      var hourAngle = h * 30 + m * 0.5;

      // 視口中心 (50, 52)，半徑 36
      var cx = 50, cy = 52, r = 36;
      function pt(angle, dist) {
        var rad = (angle - 90) * Math.PI / 180;
        return [cx + Math.cos(rad) * dist, cy + Math.sin(rad) * dist];
      }

      // 12 個刻度
      var ticks = [];
      for (var i = 0; i < 12; i++) {
        var isMajor = i % 3 === 0;
        var a = i * 30;
        var p1 = pt(a, isMajor ? 32 : 33);
        var p2 = pt(a, isMajor ? 28 : 31);
        ticks.push(e('line', {
          key: 'tick-' + i,
          x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1],
          stroke: 'var(--dsw-alias-label-secondary,#43506b)',
          strokeWidth: isMajor ? 2 : 1,
          strokeLinecap: 'round',
          opacity: isMajor ? 0.9 : 0.45
        }));
      }

      // 指針端點
      var hourEnd = pt(hourAngle, 18);
      var minEnd = pt(minAngle, 26);
      var secEnd = pt(secAngle, 30);

      return e('svg', {
        className: 'cute-clock-svg',
        viewBox: '0 0 100 ' + size,
        xmlns: 'http://www.w3.org/2000/svg'
      },
        // 左耳
        e('path', {
          key: 'ear-l',
          className: 'cute-clock-ear left',
          d: 'M 22 22 L 25 4 L 40 16 Z',
          fill: 'var(--dsw-alias-brand-primary,#4d6bfe)',
          stroke: 'var(--dsw-alias-border-l3,#aeb7c4)',
          strokeWidth: 1.2,
          strokeLinejoin: 'round'
        }),
        // 右耳
        e('path', {
          key: 'ear-r',
          className: 'cute-clock-ear right',
          d: 'M 78 22 L 75 4 L 60 16 Z',
          fill: 'var(--dsw-alias-brand-primary,#4d6bfe)',
          stroke: 'var(--dsw-alias-border-l3,#aeb7c4)',
          strokeWidth: 1.2,
          strokeLinejoin: 'round'
        }),
        // 內耳粉色
        e('path', { key: 'iear-l', d: 'M 27 18 L 28 10 L 35 16 Z', fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.55 }),
        e('path', { key: 'iear-r', d: 'M 73 18 L 72 10 L 65 16 Z', fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.55 }),
        // 鐘面
        e('circle', {
          key: 'face',
          cx: cx, cy: cy, r: r,
          fill: 'var(--dsw-specific-bubble,#e4e9f7)',
          stroke: 'var(--dsw-alias-border-l2,#c9d0da)',
          strokeWidth: 1.5
        }),
        // 刻度
        ticks,
        // 左腮紅
        e('circle', { key: 'blush-l', cx: 33, cy: 60, r: 3.2, fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.28 }),
        // 右腮紅
        e('circle', { key: 'blush-r', cx: 67, cy: 60, r: 3.2, fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.28 }),
        // 左眼
        e('circle', {
          key: 'eye-l',
          className: 'cute-clock-eye left',
          cx: 40, cy: 50, r: 2.6,
          fill: 'var(--dsw-alias-label-primary,#131926)'
        }),
        // 右眼
        e('circle', {
          key: 'eye-r',
          className: 'cute-clock-eye right',
          cx: 60, cy: 50, r: 2.6,
          fill: 'var(--dsw-alias-label-primary,#131926)'
        }),
        // 笑臉
        e('path', {
          key: 'mouth',
          d: 'M 44 60 Q 50 65 56 60',
          fill: 'none',
          stroke: 'var(--dsw-alias-label-primary,#131926)',
          strokeWidth: 1.4,
          strokeLinecap: 'round'
        }),
        // 時針
        e('line', {
          key: 'hour',
          className: 'cute-clock-hand-hour',
          x1: cx, y1: cy, x2: hourEnd[0], y2: hourEnd[1],
          stroke: 'var(--dsw-alias-label-primary,#131926)',
          strokeWidth: 3,
          strokeLinecap: 'round'
        }),
        // 分針
        e('line', {
          key: 'min',
          className: 'cute-clock-hand-minute',
          x1: cx, y1: cy, x2: minEnd[0], y2: minEnd[1],
          stroke: 'var(--dsw-alias-label-primary,#131926)',
          strokeWidth: 2,
          strokeLinecap: 'round'
        }),
        // 秒針
        e('line', {
          key: 'sec',
          className: 'cute-clock-hand-second',
          x1: cx, y1: cy, x2: secEnd[0], y2: secEnd[1],
          stroke: 'var(--dsw-alias-state-error-primary,#dc2626)',
          strokeWidth: 1.4,
          strokeLinecap: 'round'
        }),
        // 中心軸
        e('circle', { key: 'hub', cx: cx, cy: cy, r: 2.4, fill: 'var(--dsw-alias-brand-primary,#4d6bfe)' }),
        e('circle', { key: 'hub-inner', cx: cx, cy: cy, r: 1, fill: 'var(--dsw-alias-bg-layer-1,#ffffff)' }),
        // 頭頂愛心
        e('g', { key: 'heart', className: 'cute-clock-heart' },
          e('path', {
            d: 'M 50 11 C 47 7, 41 8, 41 13 C 41 17, 50 22, 50 22 C 50 22, 59 17, 59 13 C 59 8, 53 7, 50 11 Z',
            fill: 'var(--dsw-alias-state-error-primary,#dc2626)'
          })
        )
      );
    }

    // =========================================================================
    // 4. 鉤子：每秒更新一次
    // =========================================================================
    function useNow() {
      var _a = useState(function() { return new Date(); }),
          now = _a[0], setNow = _a[1];
      useEffect(function() {
        var id = setInterval(function() { setNow(new Date()); }, 1000);
        return function() { clearInterval(id); };
      }, []);
      return now;
    }

    // 每次掛載都抽一條全新的活力 slogan（useState 的惰性初始值只在本元件第一次渲染時呼叫）
    function useEnergySlogan(h) {
      var _a = useState(function () { return pickEnergySlogan(bucketOf(h)); }),
          slogan = _a[0], setSlogan = _a[1];
      useEffect(function () {
        setSlogan(pickEnergySlogan(bucketOf(h)));
      }, [h]);
      return slogan;
    }

    // =========================================================================
    // 4.5 讓位：輸入區被擋住時，角落卡片自動收起
    //
    // 為什麼要量而不是判斷佈局：卡片是 `position:fixed` 的右下角浮層，而「輸入區」
    // 是頁面自己排版的 —— 輸入卡片、輸入框上方的場景面板、下方的模板牆，高度都會
    // 隨內容變（hero 與一般會話也不同）。所以這裡只看「這些區塊的實際外框」有沒有
    // 和卡片的實際外框相交，既不去猜 DSH 的 class hash，也不假設任何一種版面。
    //
    // 選到的元素：
    //   .uV2eYG_input          主輸入框（DSH 的輸入卡片）
    //   [data-st-scroll]       scene-template 插件的場景面板／模板牆（掛在輸入區）
    //   #st-top / #st-wall     同上，scene-template 的座位 id（換版時可望保命）
    // =========================================================================

    /** 讓位的安全距離：兩者邊界再靠近 8px 就先收起來。 */
    var CLOCK_KEEP_AWAY = 8;
    /** 幾何重算的節奏（ms）——輸入框會長高、模板牆會換一批，太慢會漏、rAF 太貴。 */
    var CLOCK_MEASURE_MS = 300;
    /** 會和角落卡片搶位置的輸入區元素（依可靠度排序：DSH 的欄位名 → 插件的資料屬性 → 座位 id）。 */
    var CLOCK_BLOCKERS = '.uV2eYG_input,[contenteditable="true"],textarea,[data-st-scroll],#st-top,#st-wall';

    /**
     * 收集「輸入區」的實際外框。回傳空陣列代表這個畫面沒有輸入區（例如設定頁），
     * 此時不需要讓位。
     * @returns 可視矩形陣列。
     */
    function blockingRects() {
      if (typeof document === 'undefined') return [];
      var found = document.querySelectorAll(CLOCK_BLOCKERS);
      var rects = [];
      for (var i = 0; i < found.length; i += 1) {
        var node = found[i];
        if (typeof node.getBoundingClientRect !== 'function') continue;
        var rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;   // 隱藏中的元素
        rects.push(rect);
      }
      return rects;
    }

    /** 卡片是否和任何一個輸入區外框相交（含安全距離）。 */
    function cardIsBlocked(cardRect, rects, pad) {
      for (var i = 0; i < rects.length; i += 1) {
        var r = rects[i];
        var apart = cardRect.right + pad <= r.left || r.right + pad <= cardRect.left
          || cardRect.bottom + pad <= r.top || r.bottom + pad <= cardRect.top;
        if (!apart) return true;
      }
      return false;
    }

    /**
     * 訂閱「輸入區的幾何有沒有變」。
     * 輸入框長高、模板牆換一批、dock（佇列、context meter）冒出來、視窗縮放、
     * 切換會話都會改動幾何，所以用 ResizeObserver + MutationObserver + resize/scroll
     * 三路一起盯，再加一個低頻 interval 當保險。
     * @param onGeometry - 幾何變化時呼叫。
     * @param onFocus - 焦點進出輸入框時呼叫，帶 true＝聚焦。
     * @returns 解除訂閱。
     */
    function subscribeComposerGeometry(onGeometry) {
      if (typeof document === 'undefined' || typeof window === 'undefined') return function () {};
      var raf = 0;
      function schedule() {
        if (raf) return;
        raf = window.requestAnimationFrame(function () { raf = 0; onGeometry(); });
      }
      var observer = null;
      if (typeof MutationObserver === 'function') {
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
      }
      var resizeObserver = null;
      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(schedule);
        resizeObserver.observe(document.body);
      }
      window.addEventListener('resize', schedule);
      window.addEventListener('scroll', schedule, true);
      // 取樣節奏就是這裡的 interval：幾何與焦點都在 measure() 裡一起重讀。
      var timer = setInterval(schedule, CLOCK_MEASURE_MS);

      schedule();
      return function dispose() {
        if (raf) window.cancelAnimationFrame(raf);
        if (observer) observer.disconnect();
        if (resizeObserver) resizeObserver.disconnect();
        window.removeEventListener('resize', schedule);
        window.removeEventListener('scroll', schedule, true);
        clearInterval(timer);
      };
    }

    /**
     * 角落卡片是否該隱藏。
     *
     * **只看幾何**：卡片外框真的壓到輸入區外框（含安全距離）才藏。曾經多一條
     * 「焦點在輸入框裡就藏」，結果是**誤判來源**：composer 常常自己拿到焦點
     * （切工作區、開新工作階段、載入後自動聚焦），而且焦點會一直留著 —— 明明沒有
     * 任何重疊，卡片卻整場不出現。實測：靜置 25 秒後無重疊、`focusish=true`、卡片
     * 已隱藏。現在焦點不再是條件，IntersectionObserver 的量測也照舊只回報幾何。
     *
     * 幾何變化由 300ms 取樣 + ResizeObserver/MutationObserver/resize/scroll 觸發，
     * 不看焦點、也不看是哪個工作階段。
     * @param cardRef - 卡片的 ref。
     * @returns true＝隱藏。
     */    function useAutoYield(cardRef) {
      var pair = useState(false);
      var hidden = pair[0];
      var setHidden = pair[1];

      useEffect(function () {
        function measure() {
          var card = cardRef.current;
          if (!card || typeof card.getBoundingClientRect !== 'function') {
            setHidden(false);
            return;
          }
          var rect = card.getBoundingClientRect();
          // 隱藏期間卡片外框會塌成 0：這時不重算，等它顯示回來再判。
          if (rect.width === 0 && rect.height === 0) return;
          setHidden(cardIsBlocked(rect, blockingRects(), CLOCK_KEEP_AWAY));
        }
        return subscribeComposerGeometry(measure);
      }, []);

      return hidden;
    }

    // =========================================================================
    // 5. 元件 A —— 漂浮小時鐘（shell.overlay）
    // =========================================================================
    function FloatingClock() {
      var now = useNow();
      var h = now.getHours();
      var m = now.getMinutes();
      var s = now.getSeconds();
      var time = pad(h) + ':' + pad(m) + ':' + pad(s);
      var date = (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + WEEKDAYS[now.getDay()];
      var slogan = useEnergySlogan(h);

      // 擋到輸入區就**整塊隱藏**：沒有小藥丸、沒有殘留的角落元素，右下角完全讓給
      // 輸入區；不再重疊時自己回來。判斷只看幾何（見 useAutoYield 的註解：焦點
      // 條件會誤判，因為 composer 常常自己拿到焦點且一直不放）。
      var cardRef = React.useRef(null);
      var hidden = useAutoYield(cardRef);

      var card = e('div', {
          ref: cardRef,
          'data-cute-clock-card': '1',
          className: 'cute-clock-card' + (hidden ? ' cute-clock-card--away' : ''),
          title: '點我去看看完整時鐘頁～',
        },
        e('div', { className: 'cute-clock-face' },
          e(EnergyClockSVG, { now: now, size: 108 })
        ),
        e('div', { className: 'cute-clock-text' },
          e('div', { className: 'cute-clock-greet' }, getGreeting(h)),
          e('div', { className: 'cute-clock-slogan', key: slogan, title: slogan }, slogan),
          e('div', { className: 'cute-clock-time' }, time),
          e('div', { className: 'cute-clock-date' }, date)
        )
      );

      return e('div', {
        className: 'cute-clock-overlay',
        // 'hidden' / 'shown' 只是給驗證與除錯看的標記，畫面行為不依賴它。
        'data-cute-clock-state': hidden ? 'hidden' : 'shown',
      }, card);
    }

    /**
     * 浮動卡片外面再包一層：它是唯一訂閱「顯示 / 隱藏」的地方。
     *
     * 為什麼要包：`ctx.slots.register` 的渲染函式本身不是 React 組件（不能放 hook），
     * 所以訂閱必須落在一個真正的組件裡。關閉時**整個 `.cute-clock-overlay`
     * 都不渲染**（連同 `position:fixed` 的定位盒一起消失），而不是只藏卡片 ——
     * 這樣右下角真的乾乾淨淨，也不會留下會吃點擊的透明層。
     *
     * `data-cute-clock-float="on|off"` 給驗證探針讀。
     */
    function FloatingClockSlot() {
      var visible = useFloatVisible();
      if (!visible) return null;
      return e('div', {
        className: 'cute-clock-overlay',
        'data-cute-clock-float': 'on',
      }, e(FloatingClock, null));
    }

    // =========================================================================
    // 6. 元件 B —— 全域面板的大時鐘（main keyed）
    // =========================================================================
    var PETALS = ['🌸', '✿', '❀', '🌼', '✦', '❋', '·', '✿', '·'];

    /**
     * 量出「要補多少位移」才能把絕對定位的子節點釘回內容區左下角。
     *
     * 為什麼不寫死：`.cute-clock-page` 自己帶 `transform`（補側欄偏移），子節點的
     * 絕對座標系因此不是視窗，而 transform 的實際值會隨 DSH 版面變（實測這版
     * 是 translateX(-190px) translateY(96px)）。寫死一變就飄掉，所以掛載時量：
     *
     *   目標點 = (內容區左緣 + 18, 視窗高 - 18)
     *   「內容區左緣」取最近的 `overflow:hidden` 祖先（centerCol / frame）——
     *   側欄把視窗左邊 0–208 整條佔住了，直接貼視窗左緣的開關會被側欄蓋掉
     *   （實測 elementFromPoint 命中的是側欄的 label）。
     *
     * @returns {{dx:number,dy:number}|null} 量不到（節點消失 / SSR）時回傳 null。
     */
    function measureCornerCompensation(node) {
      if (!node || typeof node.getBoundingClientRect !== 'function') return null;
      var page = node.parentElement ? node.parentElement.closest('.cute-clock-page') : null;
      if (!page) return null;
      var pr = page.getBoundingClientRect();
      if (!pr.width || !pr.height) return null;

      var bound = window.innerWidth || 0;
      var el = page.parentElement;
      while (el && el !== document.documentElement) {
        var s = window.getComputedStyle(el);
        if (s.overflow !== 'visible' && s.overflow !== '') {
          var br = el.getBoundingClientRect();
          if (br.width > 0) { bound = br.left; break; }
        }
        el = el.parentElement;
      }

      var nr = node.getBoundingClientRect();
      return {
        dx: Math.round(bound + 18 - nr.left),
        dy: Math.round(((window.innerHeight || 0) - 18) - nr.bottom),
      };
    }

    /**
     * 「右下角浮動時鐘」開關 —— 釘在**內容區左下角**，只有一顆膠囊開關，沒有說明文字。
     *
     * 位置靠 `measureCornerCompensation` 在掛載後量出補償值再套用；第一次 render
     * 先放在看不見的地方（`left:-9999px`），量完才歸位，避免在側欄上閃一下。
     *
     * 它和 `FloatingClockSlot` 訂閱同一份 store，所以切換後右下角立刻出現 / 消失；
     * 狀態寫進 localStorage（預設＝顯示）。
     */
    function FloatVisibleToggle() {
      var visible = useFloatVisible();
      var readyPair = useState(false);
      var ready = readyPair[0];
      var setReady = readyPair[1];
      var compPair = useState(null);
      var comp = compPair[0];
      var setComp = compPair[1];
      var boxRef = React.useRef(null);

      // 掛載後量一次位置補償值，並啟用開關（避免 localStorage 未讀完時誤點）。
      useEffect(function () {
        setComp(measureCornerCompensation(boxRef.current));
        setReady(true);
      }, []);

      function onChange() {
        setFloatVisible(!currentFloatVisible());
      }

      // 第一次 render 先落在 CSS 的 left:18px;bottom:18px（page 內座標），
      // effect 裡量出補償值再套 translate 歸位。不能先隱藏到 -9999px —— 那樣
      // 量到的是隱藏後的位置，補償值會變成 +10000 之類的垃圾。
      var style = comp
        ? { transform: 'translate(' + comp.dx + 'px,' + comp.dy + 'px)' }
        : undefined;

      return e('div', {
        ref: boxRef,
        className: 'cute-toggle',
        style: style,
        'data-cute-toggle': 'floating-visible',
        'data-on': visible ? '1' : '0',
        title: visible ? '隱藏右下角浮動時鐘' : '顯示右下角浮動時鐘',
      },
        e('label', { className: 'cute-toggle__switch' },
          e('input', {
            type: 'checkbox',
            className: 'cute-toggle__input',
            checked: visible,
            disabled: !ready,
            role: 'switch',
            'aria-checked': visible ? 'true' : 'false',
            'aria-label': '右下角浮動時鐘',
            onChange: onChange,
          }),
          e('span', { className: 'cute-toggle__knob' })
        )
      );
    }

    function PetalRain() {
      // 用 useMemo 讓 18 片花瓣只生成一次（位置／延遲）
      var petals = useMemo(function() {
        var out = [];
        for (var i = 0; i < 18; i++) {
          out.push({
            key: 'p-' + i,
            left: Math.random() * 100,
            delay: Math.random() * 12,
            duration: 9 + Math.random() * 9,
            char: PETALS[Math.floor(Math.random() * PETALS.length)],
            size: 12 + Math.random() * 14
          });
        }
        return out;
      }, []);
      return e('div', null,
        petals.map(function(p) {
          return e('span', {
            key: p.key,
            className: 'cute-clock-petal',
            style: {
              left: p.left + '%',
              animationDelay: p.delay + 's',
              animationDuration: p.duration + 's',
              fontSize: p.size + 'px'
            }
          }, p.char);
        })
      );
    }

    function BigClockPage() {
      var now = useNow();
      var h = now.getHours();
      var m = now.getMinutes();
      var s = now.getSeconds();
      var time = pad(h) + ':' + pad(m) + ':' + pad(s);
      var date = (now.getMonth() + 1) + '月' + now.getDate() + '日  ' + WEEKDAYS[now.getDay()];
      // 每次打開／重新整理面板都抽一條新的活力 slogan；點一下也能換一條
      var _q = useState(function () { return pickEnergySlogan(bucketOf(h)); }),
          quote = _q[0], setQuote = _q[1];
      useEffect(function () {
        setQuote(pickEnergySlogan(bucketOf(h)));
      }, [h]);
      function rollSlogan() {
        var next = pickEnergySlogan(bucketOf(h));
        // 極小機率抽到同一條：再抽一次，保證點了一定有變化
        if (next === quote) next = pickEnergySlogan(bucketOf(h));
        setQuote(next);
      }

      return e('div', { className: 'cute-clock-page' },
        e(PetalRain, null),
        e('div', { className: 'cute-clock-bigface' },
          e(EnergyClockSVG, { now: now, size: 110 })
        ),
        e('div', { className: 'cute-clock-bigtime' }, time),
        e('div', { className: 'cute-clock-bigdate' }, date),
        e('div', {
          className: 'cute-clock-bigquote',
          key: quote,
          title: '點一下，換一條活力 slogan 💪',
          onClick: rollSlogan
        }, '✿  ' + quote + '  ✿'),
        // 全域開關：關掉右下角那塊浮動時鐘（預設顯示，狀態存 localStorage）
        e(FloatVisibleToggle, null),
        // 用量小卡：使用 `position:fixed; right:18px; top:18px;`，視窗-相對定位，
        // 不被 `.cute-clock-page` 的 transform 拉走。仍在這個 React 子樹裡，
        // 所以 mount/unmount 跟 BigClockPage 走（切到主面板就出現，切走就消失）。
        e(UsageCard, null)
      );
    }

    // =========================================================================
    // 7. 樣式注入 + 清理（按 ctx.effect 規則）
    // =========================================================================
    function installStyles() {
      var style = document.createElement('style');
      style.setAttribute('data-plugin', 'cute-clock');
      style.textContent = CLOCK_CSS;
      document.head.appendChild(style);
      return function dispose() {
        if (style && style.parentNode) style.parentNode.removeChild(style);
      };
    }

    // =========================================================================
    // 8. 用量小卡（cute-usage）
    //
    // 從 `https://abc.feg.com.tw/BDD/API/v1/litellm/console/usageKey` 拉今日用量。
    // 契約（per MASK.md §"API contract: apiKey for abc.feg.com.tw"）：
    //   POST {apiKey: "sk-..."}  ← apiKey 是 67 字元的遮蔽形
    //
    // apiKey 由宿主算好後透過 `GET /cute-clock/mask-key` 給瀏覽器；
    // 瀏覽器永遠拿不到原文。失敗時不自動重試（避免錯誤的雪崩），
    // 等使用者在卡片上按「重新整理」再試。
    //
    // 預設摺疊：spend / max_budget（後端給的，例如 $28.99 / $1,000）+ 進度條 +
    //             週期（7d）+ 下次重置日期；展開才看 user_id / role / models。
    //
    // 2026-10-12 第二次重設計：之前筆者把它當成「每日 usage」端點（按天聚合
    // 的 results[] 陣列），那是 litellm 標準 `/usage` 端點的形狀。實際上
    // `/BDD/API/v1/litellm/console/usageKey` 走的是 `/key/info` 形狀：
    //   p.res = { spend, max_budget, budget_duration, budget_reset_at,
    //             models, teams, user_id, user_email, user_role, ... }
    // 也就是「這把 key 跟它的額度」，不是「這一天用量」。已重寫 summarizeUsage
    // 對應這個結構。
    // =========================================================================
    var USAGE_URL = 'https://abc.feg.com.tw/BDD/API/v1/litellm/console/usageKey';
    var MASK_KEY_PATH = '/cute-clock/mask-key';
    var USAGE_FETCH_TIMEOUT_MS = 8000;

    /**
     * 取得遮蔽金鑰，失敗時回空字串（不 throw）。
     * 只快取**成功**的結果；失敗就下次重試 —— 否則宿主晚一步就緒
     * 就永遠拿不到。callers 用 `if (key) ...` 決定是否帶 apiKey。
     */
    var maskKeyCache = null;
    var maskKeyPending = null;
    function getMaskKey() {
      if (typeof maskKeyCache === 'string') return Promise.resolve(maskKeyCache);
      if (maskKeyPending) return maskKeyPending;
      var p = fetch(MASK_KEY_PATH, { headers: { accept: 'application/json' } })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (out) {
          var key = out && typeof out.maskKey === 'string' ? out.maskKey : '';
          if (key === '') throw new Error('回應沒有 maskKey');
          maskKeyCache = key;
          return key;
        })
        .catch(function (err) {
          console.warn('[cute-clock] mask key unavailable; usage card will skip apiKey:',
            err && err.message ? err.message : err);
          return '';
        });
      maskKeyPending = p;
      var clear = function () { maskKeyPending = null; };
      p.then(clear, clear);
      return p;
    }

    /**
     * 從 usageKey 端點拿今日用量。回傳正規化後的摘要：
     *   { date, used, savings, prompt, output, cacheRead, requests,
     *     failed, model, keyAlias, fetchedAt, ok, error? }
     * 失敗時 `ok: false` + `error: '...'`，其它欄位用 0 / '—' 填。
     */
    function fetchUsage() {
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var killer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, USAGE_FETCH_TIMEOUT_MS);
      return getMaskKey().then(function (key) {
        // 即便沒拿到金鑰也照發請求（後端目前不強制），只是 body 沒 apiKey
        var body = key ? { apiKey: key } : {};
        return fetch(USAGE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined,
        });
      }).then(function (res) {
        clearTimeout(killer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function (payload) {
        return summarizeUsage(payload);
      }).catch(function (err) {
        clearTimeout(killer);
        return {
          ok: false, error: err && err.message ? err.message : String(err),
          used: 0, savings: 0, prompt: 0, output: 0, cacheRead: 0,
          requests: 0, failed: 0, model: '—', keyAlias: '—',
          date: '—', fetchedAt: new Date().toISOString(),
        };
      });
    }

    /**
     * 把 litellm `/key/info` 響應收成 UI 用的扁平形狀。
     *
     * 2026-10-12 重設計：這個端點回的是「**這把 key 的額度狀態**」，
     * 不是「今日用量」。欄位是 key / user / budget 的快照。
     *
     * 重要欄位：
     *   p.res.spend              ← 當前週期已用
     *   p.res.max_budget         ← 週期總額度（null/0 表示無限額）
     *   p.res.budget_duration    ← '7d' / '30d' / '24h' 等
     *   p.res.budget_reset_at    ← 下次重置的 ISO timestamp
     *   p.res.user_id            ← 這把 key 屬於哪個 user
     *   p.res.user_email         ← user email
     *   p.res.user_role          ← internal_user_viewer / etc
     *   p.res.models             ← 允許的 model 陣列
     *   p.res.teams              ← 屬於哪些 team（陣列或單一）
     *   p.res.created_at         ← key 建立時間
     *   p.res.updated_at         ← key 更新時間
     *   p.res.max_parallel_requests / tpm_limit / rpm_limit ← 速率限制（可能空）
     *
     * `ok: false` 時 `error` 有值，UI 改為錯誤狀態。
     */
    function summarizeUsage(payload) {
      if (!payload || !payload.res) {
        return {
          ok: false, error: '回應沒有 res',
          used: 0, budget: 0, period: '—', resetAt: '—',
          userId: '—', userEmail: '—', role: '—',
          models: '—', teams: '—', createdAt: '—', updatedAt: '—',
          fetchedAt: new Date().toISOString(),
        };
      }
      var r = payload.res;
      var models = Array.isArray(r.models) ? r.models.join(', ') : '—';
      var teams = Array.isArray(r.teams) ? r.teams.join(', ') : (r.teams || '—');
      return {
        ok: true,
        used: numberOr0(r.spend),
        budget: numberOr0(r.max_budget),
        period: r.budget_duration || '—',
        resetAt: r.budget_reset_at || '—',
        userId: r.user_id || '—',
        userEmail: r.user_email || '—',
        role: r.user_role || '—',
        models: models,
        teams: teams,
        createdAt: r.created_at || '—',
        updatedAt: r.updated_at || '—',
        maxParallel: r.max_parallel_requests || '—',
        tpm: r.tpm_limit || '—',
        rpm: r.rpm_limit || '—',
        fetchedAt: new Date().toISOString(),
      };
    }
    function numberOr0(v) {
      var n = Number(v);
      return isFinite(n) ? n : 0;
    }

    function fmtUsd(n) {
      // 不帶貨幣符號 —— 金額這個字就代表「$」，再寫一次只是冗餘
      var v = Number(n) || 0;
      return v.toFixed(2);
    }
    function fmtInt(n) {
      var v = Number(n) || 0;
      return v.toLocaleString('en-US');
    }
    /**
     * 解析 ISO（UTC）字串，回傳**本地時區**的日期與時分。
     * 舊版本直接 regex `YYYY-MM-DD` 跟 `HH:MM` 段，會把後端回傳的 UTC 時間
     * 當成本地時間顯示（差 8 小時）。用 `new Date(...)` 讓瀏覽器按使用者的時區轉。
     */
    function fmtDate(iso) {
      if (typeof iso !== 'string' || iso.length < 10) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) {
        // 解析失敗退回到舊行為：直接抓前 10 字（忽略時區，但至少有東西可看）
        var m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? m[2] + '/' + m[3] : '—';
      }
      var mm = String(d.getMonth() + 1);
      var dd = String(d.getDate());
      return (mm.length < 2 ? '0' + mm : mm) + '/' + (dd.length < 2 ? '0' + dd : dd);
    }
    function fmtTime(iso) {
      if (typeof iso !== 'string' || iso.length < 16) return '—';
      var d = new Date(iso);
      if (isNaN(d.getTime())) {
        // 解析失敗退回到舊行為：直接 regex HH:MM
        var m = iso.match(/T(\d{2}:\d{2})/);
        return m ? m[1] : '—';
      }
      var hh = String(d.getHours());
      var mm = String(d.getMinutes());
      return (hh.length < 2 ? '0' + hh : hh) + ':' + (mm.length < 2 ? '0' + mm : mm);
    }

    /**
     * 摺疊 / 展開的用量小卡。
     * 內部管自己 state（expanded / data / loading / error / lastFetch），
     * 不依賴外部 props。每次切工作階段都會 re-mount 一次（overlay slot），
     * 所以新 mount 會重抓。
     */
    function UsageCard() {
      var expandedPair = useState(false);
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];
      var dataPair = useState(null);
      var data = dataPair[0];
      var setData = dataPair[1];
      var loadingPair = useState(false);
      var loading = loadingPair[0];
      var setLoading = loadingPair[1];
      var fetchingPair = useState(false);
      var fetching = fetchingPair[0];
      var setFetching = fetchingPair[1];

      // 拉資料。不輪詢、不快取 —— 每次元件 mount（= 切到主面板）都會
      // 走一次 fetchUsage 拿最新值；手動按「重新整理」也會再拉一次。
      // `fetching` 只擋連點（避免重複請求），不做 TTL gate。
      function refresh() {
        if (fetching) return;
        setFetching(true);
        setLoading(!data);  // 第一次顯示「載入中…」；之後背景刷新
        fetchUsage().then(function (d) {
          setData(d);
        }).then(function () {
          setFetching(false);
          setLoading(false);
        });
      }

      // mount 時拉一次（每次切到主面板都會 re-mount，所以「每次激活都更新」
      // 這條自然滿足 —— 不需要任何背景輪詢）
      useEffect(function () { refresh(); }, []);

      var d = data || {
        ok: false, error: '載入中…',
        used: 0, budget: 0, period: '—', resetAt: '—',
        userId: '—', userEmail: '—', role: '—',
        models: '—', teams: '—', createdAt: '—', updatedAt: '—',
        maxParallel: '—', tpm: '—', rpm: '—',
        fetchedAt: '',
      };
      var used = d.used;
      var budget = d.budget;
      var pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : null;
      var hasBudget = budget > 0;

      // .cute-clock-page 在視窗上是 (left=230, top=-40)，
      // 因為 page 自帶 `transform:translateX(-50px) translateY(-40px)`
      // （DSH 為了補償側欄偏移的設計）。卡片是 page 子節點，被這個 transform 推走。
      //
      // 數學（讓卡片視窗上落在 (viewport-18, 18)）：
      //   page.left in viewport = 230, page.right in viewport = 1398
      //   卡片 `right:18` 在 page 內 → viewport right = 1398 - 18 = 1380（離 viewport.right 差 2px，是 page 寬度算的結果）
      //   卡片 `top:18` 在 page 內 → viewport top = -40 + 18 = -22
      //   修正：transform: translate(2px, 40px) 把卡片往右 2 / 往下 40。
      //
      // `position:fixed` 也試過 —— 但 fixed 元素的 containing block 規則會被
      // 任何有 transform 的祖先捕獲，page 自身就把 fixed 捕獲了，仍被推走。
      // `createPortal` 在 DSH 的 React 版本裡不存在。
      return e('div', {
        className: 'cute-usage' + (expanded ? ' cute-usage--expanded' : '') + (d.ok ? '' : ' cute-usage--err'),
        style: { transform: 'translate(2px, 40px)' },
        onClick: function (ev) {
          if (ev.target.closest && ev.target.closest('.cute-usage__btn')) return;
          setExpanded(!expanded);
        }
      },
        // 抬頭（永遠可見）
        e('div', { className: 'cute-usage__head' },
          e('span', { className: 'cute-usage__title' }, '💰 用量'),
          e('span', { className: 'cute-usage__chev' }, expanded ? '▴' : '▾')
        ),
        // 摺疊態：$28.99 / $1,000 (7d) + 進度條 + 剩餘時間
        e('div', { className: 'cute-usage__summary' },
          e('div', { className: 'cute-usage__line' },
            e('span', { className: 'cute-usage__used' }, fmtUsd(used)),
            hasBudget && e('span', { className: 'cute-usage__sep' }, ' / '),
            hasBudget && e('span', { className: 'cute-usage__budget' }, fmtUsd(budget)),
            d.period && d.period !== '—' && e('span', { className: 'cute-usage__period' }, ' (' + d.period + ')')
          ),
          pct !== null && e('div', { className: 'cute-usage__bar' },
            e('div', { className: 'cute-usage__bar-fill', style: { width: pct + '%' } })
          ),
          e('div', { className: 'cute-usage__pct' },
            pct !== null
              ? (pct + '% · 重置 ' + fmtDate(d.resetAt))
              : (d.resetAt !== '—' ? '重置 ' + fmtDate(d.resetAt) : ''))
        ),
        // 展開態：明細
        expanded && e('div', { className: 'cute-usage__detail' },
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, '用戶'),
            e('span', { className: 'cute-usage__v' }, d.userEmail)
          ),
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, 'ID'),
            e('span', { className: 'cute-usage__v cute-usage__mono' }, d.userId)
          ),
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, '角色'),
            e('span', { className: 'cute-usage__v' }, d.role)
          ),
          e('div', { className: 'cute-usage__sep-row' }),
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, '允許模型'),
            e('span', { className: 'cute-usage__v' }, d.models)
          ),
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, 'Team'),
            e('span', { className: 'cute-usage__v cute-usage__mono' }, d.teams)
          ),
          (d.maxParallel !== '—' || d.tpm !== '—' || d.rpm !== '—') && e('div', { className: 'cute-usage__sep-row' }),
          d.maxParallel !== '—' && e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, '並行上限'),
            e('span', { className: 'cute-usage__v' }, String(d.maxParallel))
          ),
          d.tpm !== '—' && e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, 'TPM'),
            e('span', { className: 'cute-usage__v' }, String(d.tpm))
          ),
          d.rpm !== '—' && e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, 'RPM'),
            e('span', { className: 'cute-usage__v' }, String(d.rpm))
          ),
          e('div', { className: 'cute-usage__sep-row' }),
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, '建立'),
            e('span', { className: 'cute-usage__v' }, fmtDate(d.createdAt))
          ),
          e('div', { className: 'cute-usage__row' },
            e('span', { className: 'cute-usage__k' }, '更新'),
            e('span', { className: 'cute-usage__v' }, fmtDate(d.updatedAt) + ' ' + fmtTime(d.updatedAt))
          ),
          e('div', { className: 'cute-usage__actions' },
            e('button', {
              className: 'cute-usage__btn',
              onClick: function (ev) {
                ev.stopPropagation();
                refresh();
              },
              disabled: fetching,
              title: '重新整理'
            }, fetching ? '更新中…' : '重新整理')
          )
        ),
        // 錯誤時疊加提示
        !d.ok && e('div', { className: 'cute-usage__err-tip' }, d.error || '載入失敗')
      );
    }

    // =========================================================================
    // 8. 註冊三個座位
    //
    // 三個座位對所有工作階段一律渲染：這裡曾經按 agent preset 整塊退場
    // （辦公模式隱藏），會讀 SessionListState 自己判斷 —— 那個開關已移除。
    // =========================================================================
    function apply(ctx) {
      // ① CSS 注入（disposer 由 ctx.effect 自動管理）
      ctx.effect(installStyles, 'cute-clock: styles');

      // ② 幀級浮層 —— 漂浮的元氣小時鐘（受面板上的「右下角浮動時鐘」開關控制）
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'cute-clock-overlay',
          order: 100
        }, function () {
          return e(FloatingClockSlot, null);
        });
      });

      // ③ 左欄圖示 —— 點選切換到時鐘面板
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cute-clock',
          order: 30,
          label: function () { return '元氣時鐘'; }
        }, function (iconProps) {
          return e(EnergyClockGlyph, {
            size: iconProps && iconProps.size,
            active: iconProps && iconProps.active,
            onClick: function () {
              if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
                var current = iconProps && iconProps.active;
                // 當前已經是這個面板 → 切回工作階段；否則切到時鐘面板
                ctx.layout.selectPanel(current ? null : 'cute-clock');
              }
            }
          });
        });
      });

      // ④ 全域面板本體（main keyed, key 必須等於 panellist 的 id）
      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: 'cute-clock'
        }, function () {
          return e(BigClockPage, null);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
