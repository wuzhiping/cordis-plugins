// Browser entry for the jeeflow-panel bundle.
//
// Contributes ONE more `conversation.view` tab next to 對話 (chat, order 0)
// and 軌跡 (trajectory, order 10), showing a remote page in an iframe:
//
//     https://abc.feg.cn/jeeflow/ui/        (jeeflow 工作流引擎)
//
// The <iframe> is a module-level SINGLETON. On mount it is re-parented into
// the view's host div; on unmount it is parked in an offscreen keeper instead
// of being destroyed. Switching 工作流 → 對話 → 工作流 therefore does NOT
// reload the embedded app.
//
// This is a STATIC client plugin (see `dsh.client` in package.json), not a
// dynamic Package, so the dynamic-half restrictions do not apply:
// `require("react")`, `document`, `window` and browser timers are ordinary
// globals here.
window.__ModuleLoader__.load({
  id: "jeeflow-panel",
  factory: function (require) {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var e = React.createElement;

    // =====================================================================
    // 1. Tunables — 改这里就够了
    // =====================================================================
    /** 遠端頁面。要換成別的內嵌頁面只改這一行。 */
    var PANEL_URL = "https://abc.feg.cn/jeeflow/ui/";
    /** iframe 的無障礙標題。 */
    var PANEL_TITLE = "Jeeflow 工作流引擎";
    /** `conversation.view` entry id（一個 session 內唯一）。 */
    var VIEW_ID = "jeeflow";
    /** Tab 排序：chat = 0、trajectory = 10 → 20 排在「軌跡」右邊。 */
    var TAB_ORDER = 20;
    /** Locale namespace for這個 bundle。 */
    var NS = "jeeflow-panel";
    /** 載入超過這麼久還沒好，就提示可能被擋掉。 */
    var SLOW_MS = 9000;

    // =====================================================================
    // 2. 文案（zh 會被 zhtw-traditional-chinese 自動轉成繁體）
    // =====================================================================
    var zh = {
      "view.jeeflow": "工作流",
      "panel.reload": "重新整理",
      "panel.open": "另开新窗口",
      "panel.loading": "正在载入远程页面…",
      "panel.slow":
        "一直空白？这个页面可能不允许被 iframe 嵌入（X-Frame-Options / " +
        "frame-ancestors），或者需要先登录。可以点右上角「另开新窗口」直接打开。",
    };
    var en = {
      "view.jeeflow": "Jeeflow",
      "panel.reload": "Reload",
      "panel.open": "Open in new tab",
      "panel.loading": "Loading the remote page…",
      "panel.slow":
        "Still blank? The page may refuse to be framed (X-Frame-Options / " +
        "frame-ancestors) or need a sign-in first. Use “Open in new tab” " +
        "above to load it directly.",
    };

    /** Last-resort translator used only if the slot never hands us `t`. */
    function fallbackT(key) {
      if (zh[key] !== undefined) return zh[key];
      return en[key] !== undefined ? en[key] : key;
    }

    // =====================================================================
    // 3. 樣式
    // =====================================================================
    var STYLE_ID = "dsh-jeeflow-panel-style";
    var CSS = [
      // 根容器：viewArea 是 flex column，這裡把它撐滿；
      // min-height 是保底，避免上游高度算不出來時 iframe 塌成 0。
      ".jfp-root{box-sizing:border-box;flex:1 1 auto;min-height:460px;" +
        "flex-direction:column;gap:8px;display:flex;" +
        "padding:12px calc(var(--dsh-composer-side-clearance, 16px) + 16px) 16px}",

      // 工具列
      ".jfp-bar{flex:none;align-items:center;gap:8px;min-width:0;display:flex;" +
        "color:var(--dsw-alias-label-caption);" +
        "font-size:var(--dsh-content-font-size-secondary, 13px);line-height:20px}",
      ".jfp-url{min-width:0;text-overflow:ellipsis;white-space:nowrap;" +
        "overflow:hidden;font-variant-numeric:tabular-nums}",
      ".jfp-spacer{flex:1 1 auto}",
      ".jfp-btn{flex:none;align-items:center;gap:4px;display:inline-flex;" +
        "height:calc(24px + var(--dsh-content-font-delta, 0px));" +
        "padding:1px 10px;font:inherit;border:none;border-radius:24px;" +
        "background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
      ".jfp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);" +
        "color:var(--dsw-alias-label-secondary)}",

      // iframe 容器
      ".jfp-frameWrap{position:relative;flex:1 1 auto;min-height:320px;" +
        "border:.5px solid var(--dsw-alias-border-l1);border-radius:12px;" +
        "overflow:hidden;background:var(--dsw-alias-bg-base)}",
      ".jfp-frameHost{width:100%;height:100%;display:flex}",
      ".jfp-frame{display:block;flex:1 1 auto;width:100%;height:100%;" +
        "min-height:0;border:0;background:#fff}",

      // 載入遮罩
      ".jfp-overlay{position:absolute;inset:0;display:flex;padding:24px;" +
        "flex-direction:column;justify-content:center;align-items:center;" +
        "gap:8px;text-align:center;background:var(--dsw-alias-bg-base);" +
        "color:var(--dsw-alias-label-tertiary);" +
        "font-size:var(--dsh-content-font-size-secondary, 13px);line-height:20px}",
      ".jfp-hint{max-width:420px;color:var(--dsw-alias-label-caption)}",
    ].join("");

    /** Install the stylesheet once; the disposer removes it with the plugin. */
    function installStyles() {
      if (typeof document === "undefined") return function () {};
      if (document.getElementById(STYLE_ID) !== null) return function () {};
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode !== null && style.parentNode !== undefined) {
          style.parentNode.removeChild(style);
        }
      };
    }

    // =====================================================================
    // 4. 常駐 iframe：切 tab 不重新載入
    // =====================================================================
    /** Offscreen container that keeps the frame's document alive while parked. */
    var keeper = null;
    /** The one and only <iframe>, created lazily on first mount. */
    var frame = null;
    /** Whether the frame's first `load` already fired (survives remounts). */
    var frameLoaded = false;

    /** Create the singleton iframe + its offscreen keeper. Idempotent. */
    function ensureFrame() {
      if (frame !== null) return frame;
      if (typeof document === "undefined") throw new Error("jeeflow-panel: no document");
      var el = document.createElement("iframe");
      el.className = "jfp-frame";
      el.title = PANEL_TITLE;
      el.setAttribute("allow", "fullscreen; clipboard-read; clipboard-write");
      el.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      el.src = PANEL_URL;

      keeper = document.createElement("div");
      keeper.setAttribute("aria-hidden", "true");
      keeper.setAttribute("data-dsh-jeeflow-panel", "parked");
      // visibility:hidden (NOT display:none) — the document keeps running.
      keeper.style.cssText =
        "position:fixed;left:-20000px;top:0;width:1280px;height:900px;" +
        "visibility:hidden;pointer-events:none;";
      keeper.appendChild(el);
      document.body.appendChild(keeper);

      frame = el;
      return frame;
    }

    /** Move the singleton back to the offscreen keeper (unmount path). */
    function parkFrame() {
      if (frame === null || keeper === null) return;
      if (frame.parentNode === keeper) return;
      try {
        keeper.appendChild(frame);
      } catch (err) {
        /* parking is best-effort; a missing keeper only costs a reload */
      }
    }

    // =====================================================================
    // 5. 畫面
    // =====================================================================
    /**
     * The `conversation.view` body for this tab.
     * @param props - standard slot props; `t` comes from `locale: NS`.
     */
    function JeeflowView(props) {
      var t = props !== null && props !== undefined && typeof props.t === "function"
        ? props.t
        : fallbackT;

      var hostRef = React.useRef(null);
      // Seed from the singleton so a tab switch back does not flash the mask.
      var loadedPair = React.useState(function () {
        return frameLoaded;
      });
      var loaded = loadedPair[0];
      var setLoaded = loadedPair[1];
      var slowPair = React.useState(false);
      var slow = slowPair[0];
      var setSlow = slowPair[1];

      React.useEffect(function () {
        var host = hostRef.current;
        var el;
        try {
          el = ensureFrame();
        } catch (err) {
          return undefined; // no document (SSR / test): render the shell alone
        }
        if (host !== null && el.parentNode !== host) host.appendChild(el);
        setLoaded(frameLoaded);

        function onLoad() {
          frameLoaded = true;
          setLoaded(true);
          setSlow(false);
        }
        el.addEventListener("load", onLoad);
        var timer = setTimeout(function () {
          if (!frameLoaded) setSlow(true);
        }, SLOW_MS);

        return function () {
          clearTimeout(timer);
          el.removeEventListener("load", onLoad);
          parkFrame();
        };
      }, []);

      function reload() {
        var el;
        try {
          el = ensureFrame();
        } catch (err) {
          return;
        }
        // Same-value `src` assignment restarts the navigation. The frame is
        // cross-origin, so `el.contentWindow.location.reload()` would throw.
        el.src = PANEL_URL;
        frameLoaded = false;
        setLoaded(false);
        setSlow(false);
      }

      function openExternal() {
        try {
          window.open(PANEL_URL, "_blank", "noopener,noreferrer");
        } catch (err) {
          /* popup blocked — the address stays visible in the toolbar */
        }
      }

      return e(
        "div",
        { className: "jfp-root" },
        e(
          "div",
          { className: "jfp-bar" },
          e("span", { className: "jfp-url", title: PANEL_URL }, PANEL_URL),
          e("span", { className: "jfp-spacer" }),
          e(
            "button",
            { type: "button", className: "jfp-btn", title: t("panel.reload"), onClick: reload },
            "↻ " + t("panel.reload")
          ),
          e(
            "button",
            { type: "button", className: "jfp-btn", title: t("panel.open"), onClick: openExternal },
            "↗ " + t("panel.open")
          )
        ),
        e(
          "div",
          { className: "jfp-frameWrap" },
          // The iframe is appended here imperatively so it can be re-parented
          // instead of unmounted. React never renders children into this div.
          e("div", { className: "jfp-frameHost", ref: hostRef }),
          loaded
            ? null
            : e(
                "div",
                { className: "jfp-overlay" },
                e("div", null, t("panel.loading")),
                slow ? e("div", { className: "jfp-hint" }, t("panel.slow")) : null
              )
        )
      );
    }

    // =====================================================================
    // 6. Plugin body
    // =====================================================================
    /** Services this client half needs: the slot registry and the locale service. */
    var inject = ["slots", "locale"];

    /**
     * Client plugin body: install the stylesheet, register the dictionaries,
     * then contribute the tab. Every registration rides `ctx.effect`, so
     * unloading the plugin removes the tab again.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(installStyles, "jeeflow-panel: styles");
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "jeeflow-panel: dictionaries");

      var t = ctx.locale.bind(NS);
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register(
          {
            name: "conversation.view",
            id: VIEW_ID,
            order: TAB_ORDER,
            locale: NS,
            label: function () {
              return t("view.jeeflow");
            },
          },
          JeeflowView
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    // Test seam for test/smoke.js — the Loader ignores unknown keys.
    exports.__internals = {
      PANEL_URL: PANEL_URL,
      VIEW_ID: VIEW_ID,
      TAB_ORDER: TAB_ORDER,
      NS: NS,
      JeeflowView: JeeflowView,
      ensureFrame: ensureFrame,
      parkFrame: parkFrame,
      installStyles: installStyles,
      zh: zh,
      en: en,
      isFrameLoaded: function () {
        return frameLoaded;
      },
      reset: function () {
        frame = null;
        keeper = null;
        frameLoaded = false;
      },
    };
    return module.exports;
  },
});
