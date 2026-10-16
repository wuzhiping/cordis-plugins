// Browser entry for the sidebar-plugins-toggle bundle.
//
// 目的：側欄那一列「系统外掛」（官方 @deepseek-ai/dsh-client-ui-plugin-manager
// 註冊的 sidebar.panellist 條目，id = plugins）可以隱藏，而且「外掛」主面板
// 本身照常存在（設定 → 外掛 也照常）。
//
// 隱藏方式（三層保險，都不改 React 的資料）：
//   1. 一條 CSS 規則命中該列：`nav[class*="_panelList"] > button[class*="_panelRow"]`
//      再依 (a) aria-label 四種寫法（插件 / 外掛 / 系统外掛 / Plugins，另加 $="外掛"
//      後綴）或 (b) 由 ctx.slots.entriesOfSlot('sidebar.panellist') 依 order 排序算出的
//      `:nth-of-type(n)`（與側欄自己 syncPanels 的排序一致，不依賴文案）。
//   2. 同一組選擇器做一次 inline `style.display` 標記，MutationObserver 節流後重跑，
//      所以即使樣式表被別人動過、或 React 重建節點，仍然會再蓋上去。
//   3. 狀態存在 localStorage（預設隱藏），設定 → 一般 的核取方塊控制。
//
// 診斷：每次套用會把「有沒有命中、用哪一種選擇器、目前 DOM 的列標籤」寫成一個
// keyed slot 佔位鍵（plugins.row.config，該 owner 永遠不會 dispatch 這個 key，
// 所以不會渲染任何東西），供 cordis_inspect_query 讀取。

window.__ModuleLoader__.load({
  id: "sidebar-plugins-toggle",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;

    var NS = "sidebarPluginsToggle";
    var STORAGE_KEY = "sidebar-plugins-toggle:hidden";
    var PANEL_ID = "plugins";
    var NAV_SEL = 'nav[class*="_panelList"]';
    var ROW_SEL = NAV_SEL + ' > button[class*="_panelRow"]';
    var PANEL_LABELS = ["系统外掛", "外掛", "插件", "Plugins"];
    var DIAG_SLOT = "plugins.row.config";
    var DIAG_PREFIX = "spt-diag:";

    // 列外觀照 ui-settings-general / ui-theme 的既有列：下框線、標題 + 說明、右側控制項。
    var ROW_CSS = [
      ".spt-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}",
      ".spt-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}",
      ".spt-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}",
      ".spt-desc{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px}",
      ".spt-control{align-items:center;gap:8px;display:inline-flex}",
      ".spt-check{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}"
    ].join("");

    var zh = {
      title: "隱藏側欄的「系统外掛」選單",
      "desc.hidden": "目前已隱藏：側欄看不到這個入口。取消勾選即恢復顯示；外掛管理頁面本身不受影響。",
      "desc.shown": "目前顯示中：側欄看得到這個入口。勾選即隱藏；外掛管理頁面本身不受影響。"
    };
    var en = {
      title: "Hide the “系统外掛” entry in the sidebar",
      "desc.hidden": "Currently hidden: the sidebar entry is gone. Clear the box to show it again; the Plugins page itself is unaffected.",
      "desc.shown": "Currently shown: the sidebar entry is visible. Tick the box to hide it; the Plugins page itself is unaffected."
    };

    function readHidden() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== "0";
      } catch (e) {
        return true;
      }
    }

    function writeHidden(hidden) {
      try {
        window.localStorage.setItem(STORAGE_KEY, hidden ? "1" : "0");
      } catch (e) {}
    }

    /** 設定 → 一般 裡的那一列：標題 + 說明 + 核取方塊。 */
    function ToggleRow(props) {
      var t = props.t;
      var setHidden = props.setHidden;
      var state = React.useState(readHidden);
      var hidden = state[0];
      var setState = state[1];
      var change = function (next) {
        setState(next);
        writeHidden(next);
        setHidden(next);
      };
      return h("div", { className: "spt-row" },
        h("div", { className: "spt-rowText" },
          h("div", { className: "spt-title" }, t("title")),
          h("div", { className: "spt-desc" }, t(hidden ? "desc.hidden" : "desc.shown"))),
        h("div", { className: "spt-control" },
          h("input", {
            type: "checkbox",
            className: "spt-check",
            checked: hidden,
            "aria-label": t("title"),
            onChange: function (event) {
              change(event.target.checked);
            }
          })));
    }

    return {
      inject: ["slots", "locale"],
      apply: function (ctx) {
        ctx.effect(function () {
          var zhDispose = ctx.locale.register(NS, "zh", zh);
          var zhTwDispose = ctx.locale.register(NS, "zh-TW", zh);
          var enDispose = ctx.locale.register(NS, "en", en);
          return function () {
            enDispose();
            zhTwDispose();
            zhDispose();
          };
        }, "sidebar-plugins-toggle: dictionaries");

        var labelRules = [];
        for (var i = 0; i < PANEL_LABELS.length; i += 1) {
          labelRules.push(ROW_SEL + '[aria-label="' + PANEL_LABELS[i] + '"]');
        }
        labelRules.push(ROW_SEL + '[aria-label$="外掛"]');
        var labelSelector = labelRules.join(",");

        /** 由 slot 條目（與側欄 syncPanels 相同的 order 排序）推出那一列的位置。 */
        function nthRule() {
          try {
            var entries = ctx.slots.entriesOfSlot("sidebar.panellist");
            var rows = [];
            for (var k = 0; k < entries.length; k += 1) {
              var options = entries[k].options;
              rows.push({ id: options.id, order: options.order == null ? 0 : options.order });
            }
            rows.sort(function (a, b) {
              return a.order - b.order;
            });
            for (var j = 0; j < rows.length; j += 1) {
              if (rows[j].id === PANEL_ID) {
                return { index: j + 1, selector: ROW_SEL + ":nth-of-type(" + (j + 1) + ")" };
              }
            }
          } catch (e) {}
          return null;
        }

        var rowCss = document.createElement("style");
        rowCss.setAttribute("data-sidebar-plugins-toggle", "row-css");
        rowCss.textContent = ROW_CSS;
        var hideCss = document.createElement("style");
        hideCss.setAttribute("data-sidebar-plugins-toggle", "hide-row");

        var diagDispose = null;
        var lastDiag = null;

        function publishDiag(text) {
          if (text === lastDiag) return;
          lastDiag = text;
          if (diagDispose !== null) {
            try {
              diagDispose();
            } catch (e) {}
            diagDispose = null;
          }
          try {
            diagDispose = ctx.slots.inject(DIAG_SLOT, function () {
              return ctx.slots.register({ name: DIAG_SLOT, key: DIAG_PREFIX + text }, function () {
                return null;
              });
            });
          } catch (e) {}
        }

        function countAll(selector) {
          try {
            return document.querySelectorAll(selector).length;
          } catch (e) {
            return -1;
          }
        }

        function toArray(selector) {
          try {
            return Array.prototype.slice.call(document.querySelectorAll(selector));
          } catch (e) {
            return [];
          }
        }

        /** 讀狀態 → 寫 CSS + inline 標記 → 發診斷。 */
        function pass() {
          var hidden = readHidden();
          var nth = nthRule();
          var hideRules = nth === null ? labelRules : labelRules.concat([nth.selector]);
          var matched = [];
          var by = "none";

          hideCss.textContent = hidden ? hideRules.join(",") + "{display:none !important;}" : "";

          if (hidden) {
            matched = toArray(labelSelector);
            if (matched.length > 0) {
              by = "label";
            } else if (nth !== null) {
              matched = toArray(nth.selector);
              if (matched.length > 0) by = "nth";
            }
            for (var k = 0; k < matched.length; k += 1) matched[k].style.display = "none";
          } else {
            // 顯示狀態：把我們蓋過去的 inline 樣式收回，交給原本的樣式。
            var rows = toArray(ROW_SEL);
            for (var j = 0; j < rows.length; j += 1) rows[j].style.display = "";
          }

          var display = "-";
          var label = "-";
          if (matched.length > 0) {
            label = matched[0].getAttribute("aria-label") || "-";
            try {
              display = window.getComputedStyle(matched[0]).display;
            } catch (e) {}
          }
          publishDiag(
            "h=" + (hidden ? 1 : 0) +
            " nav=" + countAll(NAV_SEL) +
            " row=" + countAll(ROW_SEL) +
            " sel=" + countAll(labelSelector) +
            " nth=" + (nth === null ? "none" : nth.index) +
            " m=" + matched.length +
            " by=" + by +
            " lab=" + label +
            " disp=" + display +
            " css=" + hideCss.textContent.length +
            " loc=" + String(window.location.origin) +
            " vis=" + String(document.visibilityState)
          );
        }

        var scheduled = null;

        function schedule() {
          if (scheduled !== null) return;
          scheduled = window.setTimeout(function () {
            scheduled = null;
            pass();
          }, 150);
        }

        ctx.effect(function () {
          document.head.appendChild(rowCss);
          document.head.appendChild(hideCss);
          pass();
          var observer = null;
          if (typeof MutationObserver === "function") {
            observer = new MutationObserver(schedule);
            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ["aria-label", "class"]
            });
          }
          return function () {
            if (scheduled !== null) {
              window.clearTimeout(scheduled);
              scheduled = null;
            }
            if (observer !== null) observer.disconnect();
            var rows = toArray(ROW_SEL);
            for (var k = 0; k < rows.length; k += 1) rows[k].style.display = "";
            if (rowCss.parentNode !== null) rowCss.parentNode.removeChild(rowCss);
            if (hideCss.parentNode !== null) hideCss.parentNode.removeChild(hideCss);
            if (diagDispose !== null) {
              try {
                diagDispose();
              } catch (e) {}
              diagDispose = null;
            }
            lastDiag = null;
          };
        }, "sidebar-plugins-toggle: sidebar row");

        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "sidebar-plugins-toggle",
            order: 13,
            locale: NS,
            inject: function () {
              return {
                setHidden: function (hidden) {
                  writeHidden(hidden);
                  pass();
                }
              };
            }
          }, ToggleRow);
        });
      }
    };
  }
});
