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

    // =========================================================================
    // 6. 元件 B —— 全域面板的大時鐘（main keyed）
    // =========================================================================
    var PETALS = ['🌸', '✿', '❀', '🌼', '✦', '❋', '·', '✿', '·'];

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
        }, '✿  ' + quote + '  ✿')
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
    // 8. 註冊三個座位
    //
    // 三個座位對所有工作階段一律渲染：這裡曾經按 agent preset 整塊退場
    // （辦公模式隱藏），會讀 SessionListState 自己判斷 —— 那個開關已移除。
    // =========================================================================
    function apply(ctx) {
      // ① CSS 注入（disposer 由 ctx.effect 自動管理）
      ctx.effect(installStyles, 'cute-clock: styles');

      // ② 幀級浮層 —— 漂浮的元氣小時鐘
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'cute-clock-overlay',
          order: 100
        }, function () {
          return e('div', { className: 'cute-clock-overlay' }, e(FloatingClock, null));
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
