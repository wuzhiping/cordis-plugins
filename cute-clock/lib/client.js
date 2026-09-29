// =============================================================================
// cute-clock · lib/client.js
// 一只住在 DSH Web GUI 角落里的猫咪时钟 🐱
//
// 注册三个位置：
//   1. shell.overlay      —— 永远飘在角落的小猫咪（右下角）
//   2. sidebar.panellist  —— 左栏图标 🕐
//   3. main (keyed)       —— 点图标后展开的"猫咪时钟"全局面板
//
// 办公模式（agent preset `office`）下三个位置全部退场：agent preset 无法
// enable/disable 客户端插件（preset 只在自己的 agent scope 里挂插件，而浏览器
// 名册在宿主启动时按 `dsh.client` 行组好），所以这里改为主动读「当前会话的
// preset」自行隐藏 —— 见 §0 与 apply() 里的三处 useHiddenHere()。
//
// 设计要点：
//   - 配色全部走 DSH 主题令牌（--dsw-*），明暗主题自动适配
//   - SVG 画一只圆脸小猫：耳朵、眼睛（会眨）、腮红、笑脸、爱心
//   - 秒针带轻微弹性，分针/时针平滑
//   - 问候语按时辰切换（早安/午安/晚安/夜深了…）
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
    // 0. 按当前会话的 agent preset 退场（办公模式隐藏）
    //
    // preset 不能 disable 客户端插件，所以由插件自己判断：当前主视图展示的
    // 会话跑在这些 preset 上时，浮层/图标/面板一律不渲染。想再挂别的模式，
    // 往 HIDDEN_PRESETS 里加 id 即可（登记的是 preset 的 config.id）。
    // =========================================================================
    var HIDDEN_PRESETS = ['office'];

    /**
     * 从 SessionListState 里取「当前会话」记录的 agentPreset。
     * 当前会话由主视图持有：ui-session 以 retainedBy.mainView > 0 标记它，
     * 行的 projectionValues.agentPreset 就是 ui-agent-preset 读的同一个键。
     */
    function currentPresetOf(state) {
      if (!state || !state.byId) return undefined;
      var ids = state.ids && state.ids.length ? state.ids : Object.keys(state.byId);
      for (var i = 0; i < ids.length; i++) {
        var row = state.byId[ids[i]];
        if (!row || !row.retainedBy) continue;
        if ((row.retainedBy.mainView || 0) > 0) {
          return row.projectionValues ? row.projectionValues.agentPreset : undefined;
        }
      }
      return undefined;
    }

    /**
     * 本槽位是否应当整块退场。
     * 这三个槽位都是 root scope，标准 props 带 useSessions（会话列表 + 当前
     * 选择）。钩子调用顺序恒定：props 是否可用由槽位决定，不随渲染变化。
     */
    function useHiddenHere(props) {
      var useSessions = props && props.useSessions;
      if (typeof useSessions !== 'function') return false;
      return HIDDEN_PRESETS.indexOf(useSessions(currentPresetOf)) !== -1;
    }

    // =========================================================================
    // 0.5 左栏图标 —— 与 DSH 其他面板图标同一套规矩
    //
    // 官方图标是 @deepseek-ai/dsh-client-ui-primitives 里的组件，但静态 bundle 的
    // require 拿不到 Harness 客户端包，所以照 fdep-api-request 的做法手写 inline SVG：
    //   - 16x16 viewBox，描边 1.5，stroke/fill 都用 currentColor
    //   - 尺寸用 owner 传进来的 props.size（侧栏给 16 或 18）
    //   - 不带自己的背景/悬停动画：悬停与激活底色由侧栏的 panelRow 负责
    // 图形是"猫耳 + 表盘 + 指针"，保住猫咪时钟的身份，同时是单色线稿。
    // =========================================================================
    function CatClockGlyph(props) {
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
          // 表盘
          e('circle', { cx: 8, cy: 8.6, r: 5.15 }),
          // 指针（时针 + 分针，同一折线）
          e('path', { d: 'M8 5.7v2.9l1.95 1.2' })
        )
      );
    }

    // =========================================================================
    // 1. CSS —— 全部用 DSH 主题令牌，切明暗主题自动适配
    // =========================================================================
    var CLOCK_CSS = [
      // ---------- 漂浮小组件 ----------
      '.cute-clock-overlay{',
      '  position:fixed;right:18px;bottom:18px;z-index:9999;',
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
      '  transition:transform .25s cubic-bezier(.34,1.56,.64,1),box-shadow .25s ease;',
      '  cursor:default;',
      '}',
      '.cute-clock-card:hover{',
      '  transform:translateY(-3px) rotate(-1deg);',
      '  box-shadow:0 12px 36px rgba(77,107,254,.22);',
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
      '.cute-clock-text{display:flex;flex-direction:column;gap:2px;min-width:0;line-height:1.2}',
      '.cute-clock-greet{font-size:10.5px;font-weight:700;color:var(--dsw-alias-brand-primary,#4d6bfe);letter-spacing:.5px}',
      '.cute-clock-slogan{font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary,#43506b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px;animation:cute-pop .5s cubic-bezier(.34,1.56,.64,1)}',
      '@keyframes cute-pop{0%{transform:scale(.86);opacity:0}100%{transform:scale(1);opacity:1}}',
      '.cute-clock-time{font-size:19px;font-weight:800;color:var(--dsw-alias-label-primary,#131926);font-variant-numeric:tabular-nums;letter-spacing:.3px}',
      '.cute-clock-date{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#6b7891)}',

      // ---------- 左栏图标 ----------
      // 只画图形：颜色靠 currentColor 继承侧栏行的 label-primary，悬停/激活的
      // 底色由侧栏的 .hHd-Xa_panelRow 提供（自带背景或缩放动画会和其他图标不一样）。
      '.cute-clock-glyph{display:inline-flex;align-items:center;justify-content:center}',
      '.cute-clock-glyph--active{opacity:1}',
      '.cute-clock-glyph svg{display:block}',

      // ---------- 全局面板 ----------
      '.cute-clock-page{',
      '  position:relative;',
      '  width:100%;height:100%;min-height:100%;',
      '  display:flex;flex-direction:column;align-items:center;justify-content:center;',
      '  gap:24px;padding:40px 24px;',
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
      '.cute-clock-bigquote{',
      '  margin-top:6px;padding:10px 22px;',
      '  font-size:13.5px;font-weight:600;',
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

      // 飘落的小花瓣
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

      // 让指针走得更流畅
      '.cute-clock-hand-minute,.cute-clock-hand-hour{transition:transform .25s cubic-bezier(.4,.0,.2,1)}',
    ].join('\n');

    // =========================================================================
    // 2. 工具函数
    // =========================================================================
    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function getGreeting(h) {
      if (h < 5)  return '🌙 夜深啦';
      if (h < 9)  return '🌅 早安呀';
      if (h < 11) return '☀️ 上午好';
      if (h < 13) return '🍱 午饭时间';
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
    // 活力满满的 slogan 弹药库 💪
    // 每一条都自带干劲，按时间段分桶，读起来更顺口。
    // 每次打开面板 / 刷新页面都会从当前时段里随机抽一条，所以每次都不一样。
    // 想加新句子，直接往对应数组里塞就行（数组长度不限）。
    // -------------------------------------------------------------------------
    var ENERGY_PACK = {
      morning: [
        '起床就是胜利，今天稳赢 ✨',
        '早安！元气已经加满 100% 💪',
        '先喝口水，再干翻今天 ☀️',
        '新的一天，新的超能力 🌱',
        '你一睁眼，今天就有救了 🌞',
        '今天的你，比昨天更能打 ⚡',
        '把懒虫按回去，冲鸭 🐣',
        '晨光这么好，适合干大事 🌅',
        '深呼吸，今天由我承包 🚀',
        '身体醒了，梦想也醒了 🔥',
        '状态在线，好运排队进场 🍀',
        '第一件事：把今天过漂亮 🌸',
        '你比你想象的更有劲 💫',
        '开工！今天也是闪闪发光的一天 ⭐',
        '早饭吃饱，天下我有 🍳'
      ],
      noon: [
        '吃饱了才有力气干活 🍱',
        '午后的我，电量满格 🔋',
        '饭香一入口，战斗力翻倍 🍚',
        '干饭人上线，干活人更强 💪',
        '歇五分钟，再战五小时 😤',
        '吃饱喝足，难题全部退散 🥢',
        '先把胃喂饱，再把事办成 🍜',
        '午饭是今天的第二次加油 ⛽',
        '能量已补充，请继续冲锋 🚀',
        '吃饱才有力气说"我可以" ✨',
        '一口饭一口干劲，绝配 😋',
        '中场休息结束，继续发光 🌟',
        '胃暖了，心也热了，干活去 🔥',
        '吃好这一顿，下午不认输 💥',
        '小憩一下，回来更猛 😴'
      ],
      afternoon: [
        '下午的太阳也拦不住我 ☀️',
        '再坚持一下，进度条在动 ⏳',
        '一口气干完，晚上才痛快 🎯',
        '你现在的努力，年底会替你还愿 🎁',
        '状态有点困？那就更酷一点 😎',
        '把大任务切成小口，一口一口吃 🍰',
        '进度 50%，气势 100% 💪',
        '别人在打盹，你在打怪 ⚔️',
        '慢一点没关系，别停就行 🐢',
        '来杯咖啡，把下午点亮 ☕',
        '手在动，梦在靠近 ✨',
        '你已经比刚才的自己更厉害了 📈',
        '难题只是还没被你拆开而已 🔧',
        '撑住，傍晚会给你奖励 🌈',
        '再推一把，今天不留遗憾 🏁'
      ],
      evening: [
        '今天辛苦了，你真的很能扛 🌆',
        '收工前，再漂亮地收个尾 🎬',
        '夕阳给你打光，继续发光 🌇',
        '白天没白费，晚上好好奖励自己 🍲',
        '努力了一天，值得一句"干得好" 👏',
        '把今天的疲惫兑成明天的底气 💪',
        '天黑之前，再赢一小局 🏆',
        '你认真起来的样子真好看 🌟',
        '收好今天的战绩，明天继续 📋',
        '下班是另一种开工：好好生活 🛋️',
        '路灯亮了，你的努力也亮着 💡',
        '今天你已经赢过了昨天的自己 🥇',
        '晚餐加个鸡腿，犒劳一下英雄 🍗',
        '慢慢走，稳稳赢 🚶',
        '今天的坑都填平了，厉害 🕳️'
      ],
      night: [
        '夜里也在努力的人，运气不会差 🌙',
        '早睡是明天最强的外挂 😴',
        '今天到此为止，明天继续赢 🌜',
        '别熬啦，梦里也能开挂 ✨',
        '睡饱了，明天才有力气嚣张 💤',
        '把烦恼交给月亮，晚安 🌌',
        '月亮在充电，你也是 🔋',
        '好好休息，也是一种努力 🛏️',
        '明天的你，会谢谢今晚早睡的你 🙏',
        '夜深了，英雄也要下线休息 🦸',
        '梦里继续通关，晚安 💫',
        '今晚的安静，是明天的马力 🌠',
        '手机放下，好运上线 🍀',
        '睡个好觉，明天继续发光 ⭐',
        '收工睡觉，明天再战 💪'
      ]
    };

    // 随机抽一条（可选 scope 限定时间段；rand 可注入，方便测试）
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

    // 兼容旧调用：按时辰抽一条活力 slogan（每次调用结果都可能不同）
    function getQuote(h) {
      return pickEnergySlogan(bucketOf(h));
    }

    var WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    // =========================================================================
    // 3. 猫咪时钟脸（SVG）—— 一只圆脸小猫
    // =========================================================================
    function CatClockSVG(props) {
      var now = props.now || new Date();
      var size = props.size || 100; // 视图盒尺寸

      var h = now.getHours() % 12;
      var m = now.getMinutes();
      var s = now.getSeconds();

      var secAngle = s * 6;
      var minAngle = m * 6 + s * 0.1;
      var hourAngle = h * 30 + m * 0.5;

      // 视口中心 (50, 52)，半径 36
      var cx = 50, cy = 52, r = 36;
      function pt(angle, dist) {
        var rad = (angle - 90) * Math.PI / 180;
        return [cx + Math.cos(rad) * dist, cy + Math.sin(rad) * dist];
      }

      // 12 个刻度
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

      // 指针端点
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
        // 内耳粉色
        e('path', { key: 'iear-l', d: 'M 27 18 L 28 10 L 35 16 Z', fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.55 }),
        e('path', { key: 'iear-r', d: 'M 73 18 L 72 10 L 65 16 Z', fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.55 }),
        // 钟面
        e('circle', {
          key: 'face',
          cx: cx, cy: cy, r: r,
          fill: 'var(--dsw-specific-bubble,#e4e9f7)',
          stroke: 'var(--dsw-alias-border-l2,#c9d0da)',
          strokeWidth: 1.5
        }),
        // 刻度
        ticks,
        // 左腮红
        e('circle', { key: 'blush-l', cx: 33, cy: 60, r: 3.2, fill: 'var(--dsw-alias-state-error-primary,#dc2626)', opacity: 0.28 }),
        // 右腮红
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
        // 笑脸
        e('path', {
          key: 'mouth',
          d: 'M 44 60 Q 50 65 56 60',
          fill: 'none',
          stroke: 'var(--dsw-alias-label-primary,#131926)',
          strokeWidth: 1.4,
          strokeLinecap: 'round'
        }),
        // 时针
        e('line', {
          key: 'hour',
          className: 'cute-clock-hand-hour',
          x1: cx, y1: cy, x2: hourEnd[0], y2: hourEnd[1],
          stroke: 'var(--dsw-alias-label-primary,#131926)',
          strokeWidth: 3,
          strokeLinecap: 'round'
        }),
        // 分针
        e('line', {
          key: 'min',
          className: 'cute-clock-hand-minute',
          x1: cx, y1: cy, x2: minEnd[0], y2: minEnd[1],
          stroke: 'var(--dsw-alias-label-primary,#131926)',
          strokeWidth: 2,
          strokeLinecap: 'round'
        }),
        // 秒针
        e('line', {
          key: 'sec',
          className: 'cute-clock-hand-second',
          x1: cx, y1: cy, x2: secEnd[0], y2: secEnd[1],
          stroke: 'var(--dsw-alias-state-error-primary,#dc2626)',
          strokeWidth: 1.4,
          strokeLinecap: 'round'
        }),
        // 中心轴
        e('circle', { key: 'hub', cx: cx, cy: cy, r: 2.4, fill: 'var(--dsw-alias-brand-primary,#4d6bfe)' }),
        e('circle', { key: 'hub-inner', cx: cx, cy: cy, r: 1, fill: 'var(--dsw-alias-bg-layer-1,#ffffff)' }),
        // 头顶爱心
        e('g', { key: 'heart', className: 'cute-clock-heart' },
          e('path', {
            d: 'M 50 11 C 47 7, 41 8, 41 13 C 41 17, 50 22, 50 22 C 50 22, 59 17, 59 13 C 59 8, 53 7, 50 11 Z',
            fill: 'var(--dsw-alias-state-error-primary,#dc2626)'
          })
        )
      );
    }

    // =========================================================================
    // 4. 钩子：每秒更新一次
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

    // 每次挂载都抽一条全新的活力 slogan（useState 的惰性初始值只在本组件第一次渲染时调用）
    function useEnergySlogan(h) {
      var _a = useState(function () { return pickEnergySlogan(bucketOf(h)); }),
          slogan = _a[0], setSlogan = _a[1];
      useEffect(function () {
        setSlogan(pickEnergySlogan(bucketOf(h)));
      }, [h]);
      return slogan;
    }

    // =========================================================================
    // 5. 组件 A —— 漂浮小组件（shell.overlay）
    // =========================================================================
    function FloatingClock() {
      var now = useNow();
      var h = now.getHours();
      var m = now.getMinutes();
      var s = now.getSeconds();
      var time = pad(h) + ':' + pad(m) + ':' + pad(s);
      var date = (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + WEEKDAYS[now.getDay()];
      var slogan = useEnergySlogan(h);

      return e('div', { className: 'cute-clock-card', title: '点我去看看完整时钟页～' },
        e('div', { className: 'cute-clock-face' },
          e(CatClockSVG, { now: now, size: 108 })
        ),
        e('div', { className: 'cute-clock-text' },
          e('div', { className: 'cute-clock-greet' }, getGreeting(h)),
          e('div', { className: 'cute-clock-slogan', key: slogan, title: slogan }, slogan),
          e('div', { className: 'cute-clock-time' }, time),
          e('div', { className: 'cute-clock-date' }, date)
        )
      );
    }

    // =========================================================================
    // 6. 组件 B —— 全局面板的大时钟（main keyed）
    // =========================================================================
    var PETALS = ['🌸', '✿', '❀', '🌼', '✦', '❋', '·', '✿', '·'];

    function PetalRain() {
      // 用 useMemo 让 24 片花瓣只生成一次（位置/延迟）
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
      // 每次打开/刷新面板都抽一条新的活力 slogan；点一下也能换一条
      var _q = useState(function () { return pickEnergySlogan(bucketOf(h)); }),
          quote = _q[0], setQuote = _q[1];
      useEffect(function () {
        setQuote(pickEnergySlogan(bucketOf(h)));
      }, [h]);
      function rollSlogan() {
        var next = pickEnergySlogan(bucketOf(h));
        // 极小概率抽到同一条：再抽一次，保证点了一定有变化
        if (next === quote) next = pickEnergySlogan(bucketOf(h));
        setQuote(next);
      }

      return e('div', { className: 'cute-clock-page' },
        e(PetalRain, null),
        e('div', { className: 'cute-clock-bigface' },
          e(CatClockSVG, { now: now, size: 110 })
        ),
        e('div', { className: 'cute-clock-bigtime' }, time),
        e('div', { className: 'cute-clock-bigdate' }, date),
        e('div', {
          className: 'cute-clock-bigquote',
          key: quote,
          title: '点一下，换一条活力 slogan 💪',
          onClick: rollSlogan
        }, '✿  ' + quote + '  ✿')
      );
    }

    // =========================================================================
    // 7. 样式注入 + 清理（按 ctx.effect 规则）
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
    // 8. 注册三个座位
    // =========================================================================
    function apply(ctx) {
      // ① CSS 注入（disposer 由 ctx.effect 自动管理）
      ctx.effect(installStyles, 'cute-clock: styles');

      // ② 帧级浮层 —— 漂浮的猫咪小组件（办公模式的会话下整块退场）
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({
          name: 'shell.overlay',
          id: 'cute-clock-overlay',
          order: 100
        }, function (slotProps) {
          if (useHiddenHere(slotProps)) return null;
          return e('div', { className: 'cute-clock-overlay' }, e(FloatingClock, null));
        });
      });

      // ③ 左栏图标 —— 点击切换到时钟面板
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'cute-clock',
          order: 30,
          label: function () { return '猫咪时钟'; }
        }, function (iconProps) {
          if (useHiddenHere(iconProps)) return null;
          return e(CatClockGlyph, {
            size: iconProps && iconProps.size,
            active: iconProps && iconProps.active,
            onClick: function () {
              if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
                var current = iconProps && iconProps.active;
                // 当前已经是这个面板 → 切回会话；否则切到时钟面板
                ctx.layout.selectPanel(current ? null : 'cute-clock');
              }
            }
          });
        });
      });

      // ④ 全局面板本体（main keyed, key 必须等于 panellist 的 id）
      ctx.slots.inject('main', function () {
        return ctx.slots.register({
          name: 'main',
          key: 'cute-clock'
        }, function (slotProps) {
          var hidden = useHiddenHere(slotProps);
          // 办公模式：如果人正停在时钟页上，顺手切回会话，避免主栏空着
          useEffect(function () {
            if (hidden && ctx.layout && typeof ctx.layout.selectPanel === 'function') {
              ctx.layout.selectPanel(null);
            }
          }, [hidden]);
          if (hidden) return null;
          return e(BigClockPage, null);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
