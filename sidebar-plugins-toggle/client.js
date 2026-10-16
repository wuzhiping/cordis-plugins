// Browser entry for the sidebar-plugins-toggle bundle.
//
// 目的：側欄那一列「系统外掛」（官方 @deepseek-ai/dsh-client-ui-plugin-manager
// 註冊的 sidebar.panellist 條目，id = plugins，order 0）可以隱藏，而且
// 「外掛」主面板本身照常存在（設定 → 外掛 也照常）。
//
// 做法：一條 CSS 規則（display:none）命中那一列，不碰任何 DOM 節點 ——
// React 重繪、側欄收合、語系切換都不會讓它失效。列的 aria-label 在
// 各語系下是 pluginManager 命名空間的 "panel"：zh 基底 = 插件、
// zhtw-traditional-chinese 會把它改寫成 外掛 再改名為 系统外掛、en = Plugins，
// 四種都列進選擇器；`nav[class*="_panelList"] > button[class*="_panelRow"]`
// 這一層則確保只命中側欄的列（不含「設定 → 外掛」那一項）。
//
// 偏好存在 localStorage（單一瀏覽器），預設隱藏；取消勾選即恢復顯示。

window.__ModuleLoader__.load({
  id: "sidebar-plugins-toggle",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;

    var NS = "sidebarPluginsToggle";
    var STORAGE_KEY = "sidebar-plugins-toggle:hidden";

    var ROW_LABELS = ["系统外掛", "外掛", "插件", "Plugins"];
    var ROW_SELECTOR = ROW_LABELS.map(function (label) {
      return 'nav[class*="_panelList"] > button[class*="_panelRow"][aria-label="' + label + '"]';
    }).join(",");
    var HIDE_CSS = ROW_SELECTOR + "{display:none !important;}";

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
      desc: "取消勾選後，側欄會重新顯示這個入口。外掛管理頁面本身不受影響。"
    };
    var en = {
      title: "Hide the “系统外掛” entry in the sidebar",
      desc: "Clear the box to show the Plugins entry again. The Plugins page itself is unaffected."
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
          h("div", { className: "spt-desc" }, t("desc"))),
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

        var applyHidden = function () {};
        ctx.effect(function () {
          var rowCss = document.createElement("style");
          rowCss.setAttribute("data-sidebar-plugins-toggle", "row-css");
          rowCss.textContent = ROW_CSS;
          var hideCss = document.createElement("style");
          hideCss.setAttribute("data-sidebar-plugins-toggle", "hide-row");
          document.head.appendChild(rowCss);
          document.head.appendChild(hideCss);
          applyHidden = function () {
            hideCss.textContent = readHidden() ? HIDE_CSS : "";
          };
          applyHidden();
          return function () {
            applyHidden = function () {};
            if (rowCss.parentNode !== null) rowCss.parentNode.removeChild(rowCss);
            if (hideCss.parentNode !== null) hideCss.parentNode.removeChild(hideCss);
          };
        }, "sidebar-plugins-toggle: sidebar row style");

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
                  applyHidden();
                }
              };
            }
          }, ToggleRow);
        });
      }
    };
  }
});
