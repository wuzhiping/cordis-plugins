// Browser entry for the sidebar-plugins-toggle bundle.
//
// 兩件事：
//   A. 側欄那一列「系统外掛」（官方 @deepseek-ai/dsh-client-ui-plugin-manager 註冊的
//      sidebar.panellist 條目，id = plugins）隱藏；「外掛」主面板照常存在。
//      這一個在 設定 → 一般 有核取方塊控制（預設開）。
//   B. 底部「更多」帳號選單裡的「意見反饋」與「登入」兩項隱藏；「設定」那項照常。
//      **永久隱藏，沒有開關**（2026-10-17 使用者要求）。
//
// A 的隱藏方式（三層保險）：
//   1. 一條 CSS 規則命中該列：`nav[class*="_panelList"] > button[class*="_panelRow"]`
//      再依 (a) aria-label 幾種寫法（插件 / 外掛 / 系统外掛 / Plugins，另加 $="外掛"
//      後綴）或 (b) 由 ctx.slots.entriesOfSlot('sidebar.panellist') 依 order 排序算出的
//      `:nth-of-type(n)`（與側欄自己 syncPanels 的排序一致，不依賴文案）。
//   2. 同一組選擇器做一次 inline `style.display` 標記，MutationObserver 重跑。
// B 的隱藏方式：帳號選單是按需渲染的（role="menuitem"），用 MutationObserver 在選單
//   出現時立刻動手（同一 tick 內完成，不等 150ms 節流，避免閃一下）。認的是**位置**：
//   帳號選單固定是 設定 / 意見反饋 / 登入（未登入）或 退出登入（已登入），所以隱藏第 2 項，
//   未登入時再隱藏第 3 項 —— 不看文字，換任何語系（vi-VN…）都成立；只有選單形狀不是 3 項
//   時才退回比對 MORE_LABELS（zh / zh-TW / en / vi）。只在帳號選單真的打開時（trigger 的
//   aria-expanded=true）才動手，不會誤傷別的選單。
//
// 診斷：每次套用會把「有沒有命中、用哪一種選擇器、選單看到哪些項目」寫成一個
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
    // 底部「更多」選單兩項的各種語系寫法（只當「選單形狀不是 3 項」時的後備；主要靠位置）。
    var MORE_LABELS = [
      "意见反馈", "意見反饋", "Feedback", "Phản hồi",
      "登录", "登入", "Sign in", "Đăng nhập"
    ];
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
      title: "隱藏側欄的「系统外掛」入口",
      desc: "取消勾選即恢復顯示。"
    };
    var en = {
      title: "Hide the “系统外掛” entry in the sidebar",
      desc: "Clear the box to show it again."
    };

    function readFlag(key) {
      try {
        return window.localStorage.getItem(key) !== "0";
      } catch (e) {
        return true;
      }
    }

    function writeFlag(key, hidden) {
      try {
        window.localStorage.setItem(key, hidden ? "1" : "0");
      } catch (e) {}
    }

    /** 設定 → 一般 的一列：標題 + 說明 + 核取方塊。文案與讀寫由 inject face 給。 */
    function ToggleRow(props) {
      var t = props.t;
      var state = React.useState(props.read);
      var hidden = state[0];
      var setState = state[1];
      var change = function (next) {
        setState(next);
        props.write(next);
      };
      return h("div", { className: "spt-row" },
        h("div", { className: "spt-rowText" },
          h("div", { className: "spt-title" }, t(props.titleKey)),
          h("div", { className: "spt-desc" }, t(props.descKey))),
        h("div", { className: "spt-control" },
          h("input", {
            type: "checkbox",
            className: "spt-check",
            checked: hidden,
            "aria-label": t(props.titleKey),
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

        /**
         * 底部「更多」帳號選單：永久隱藏「意見反饋」（第 2 項）與「登入」（第 3 項，僅未登入時）。
         *
         * 用**位置**而不是文字 —— 換任何語系都成立（越南語就是這樣漏掉的）。
         * 只在帳號選單真的打開時動手（trigger 的 aria-expanded=true），所以不會誤傷別的選單；
         * 選單形狀不是 3 項時才退回用 MORE_LABELS 文字比對。
         */
        function applyMenuItems() {
          var markers = toArray('[data-spt-more="1"]');
          var triggers = toArray('button[aria-haspopup="menu"][data-signed-out]');
          var open = false;
          var signedOut = false;
          for (var t = 0; t < triggers.length; t += 1) {
            if (triggers[t].getAttribute("aria-expanded") === "true") {
              open = true;
              signedOut = triggers[t].getAttribute("data-signed-out") === "true";
            }
          }
          var items = open ? toArray('[role="menuitem"]') : [];
          var knownShape = items.length === 3;
          var keep = [];
          var seen = [];
          for (var k = 0; k < items.length; k += 1) {
            var item = items[k];
            var text = String(item.textContent || "").replace(/\s+/g, "");
            if (text.length > 0 && seen.length < 4 && seen.indexOf(text) === -1) seen.push(text);
            var target = MORE_LABELS.indexOf(text) !== -1;
            if (!target && knownShape) {
              if (k === 1) target = true;
              else if (k === 2 && signedOut) target = true;
            }
            if (target) {
              item.style.display = "none";
              item.setAttribute("data-spt-more", "1");
              keep.push(item);
            }
          }
          for (var m = 0; m < markers.length; m += 1) {
            if (keep.indexOf(markers[m]) === -1) {
              markers[m].style.display = "";
              markers[m].removeAttribute("data-spt-more");
            }
          }
          return {
            hidden: keep.length,
            seen: seen,
            open: open,
            signedOut: signedOut,
            count: items.length,
            triggers: triggers.length
          };
        }

        /** 讀狀態 → 寫 CSS + inline 標記 → 發診斷。 */
        function pass() {
          var hidden = readFlag(STORAGE_KEY);
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

          var menu = applyMenuItems();

          var display = "-";
          var label = "-";
          if (matched.length > 0) {
            label = matched[0].getAttribute("aria-label") || "-";
            try {
              display = window.getComputedStyle(matched[0]).display;
            } catch (e) {}
          }
          var menuText = menu.seen.length === 0 ? "-" : menu.seen.join("|");
          if (menuText.length > 60) menuText = menuText.slice(0, 60);
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
            " trg=" + menu.triggers +
            " ag=" + (menu.open ? 1 : 0) +
            " sgn=" + (menu.signedOut ? 1 : 0) +
            " mi=" + menu.count +
            " more=" + menu.hidden +
            " mt=" + menuText +
            " loc=" + String(window.location.origin)
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

        /** 選單一出現就立刻套用（不等節流，避免項目先閃出來）。 */
        function onMutations() {
          if (countAll('[role="menuitem"]') > 0) {
            pass();
            return;
          }
          schedule();
        }

        ctx.effect(function () {
          // 舊版把「更多」兩項做成開關時留下的鍵，現在永久隱藏用不到。
          try {
            window.localStorage.removeItem("sidebar-plugins-toggle:more-hidden");
          } catch (e) {}
          document.head.appendChild(rowCss);
          document.head.appendChild(hideCss);
          pass();
          var observer = null;
          if (typeof MutationObserver === "function") {
            observer = new MutationObserver(onMutations);
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
            var marked = toArray('[data-spt-more="1"]');
            for (var j = 0; j < marked.length; j += 1) {
              marked[j].style.display = "";
              marked[j].removeAttribute("data-spt-more");
            }
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
        }, "sidebar-plugins-toggle: sidebar row and menu items");

        function faceFor(storageKey, titleKey, descKey) {
          return function () {
            return {
              read: function () {
                return readFlag(storageKey);
              },
              write: function (hidden) {
                writeFlag(storageKey, hidden);
                pass();
              },
              titleKey: titleKey,
              descKey: descKey
            };
          };
        }

        ctx.slots.inject("settings.general.item", function () {
          return ctx.slots.register({
            name: "settings.general.item",
            id: "sidebar-plugins-toggle",
            order: 13,
            locale: NS,
            inject: faceFor(STORAGE_KEY, "title", "desc")
          }, ToggleRow);
        });
      }
    };
  }
});
