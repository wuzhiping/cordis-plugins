// Browser entry for the scene-template bundle.
//
// Registered into the lazy CJS module table that dsh-client-modules scans, and
// served at /plugins/scene-template/client.js because package.json declares
// `dsh.client.platform: "web"` (the host row in cordis.patch.yml is what makes
// the registry discover this file).
//
// This is a STATIC client plugin, not a dynamic Package, so the dynamic-half
// restrictions do not apply: `require("react")`, browser timers, `document`
// and `window` are all ordinary globals here. It talks to no host half — the
// mock data lives in this file behind `api` (see "接真接口" below).
window.__ModuleLoader__.load({
  id: "scene-template",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var e = React.createElement;

    // ---------------------------------------------------------------------
    // 1. 樣式:藏掉橫向捲動條(改由“按住內容拖”平移)+ 專家寵物的動效
    // ---------------------------------------------------------------------
    var PET = 44;      // 透明正方形邊長
    var PET_AIR = 44;  // 面板上方給懸空寵物留的空氣(= 面板 marginTop)
    var PET_HANG = 6;  // 寵物中心相對"面板右上角點"偏進來多少
                       // (0 = 正好騎在角上但會被列右邊界裁;6 既掛得住角又不裁、也不壓內容)
    var SKEL_BG = "#e6ecf4";
    // 骨架 chip 的寬度表(故意長短不一,像真的名稱)
    var SKEL_CHIPS = [188, 150, 214, 168];
    var SKEL_BRANCHES = [132, 108, 156];

    // 場景清單的真介面。靜態 bundle 跑在瀏覽器裡,該地址回 access-control-allow-origin: *,
    // 所以可以直接 fetch(動態原型因為客戶端沙箱遮蔽 fetch,走 host 半邊的 ctx.web.fetch)。
    var SCENE_API = "https://abc.feg.com.tw/BDD/API/AI/dsh/scene/list";
    var SCENE_DETAIL_API = "https://abc.feg.com.tw/BDD/API/AI/dsh/scene/detail";
    var SCENE_SUGGEST_API = "https://abc.feg.com.tw/BDD/API/AI/dsh/scene/suggestion_template";
    var SCENE_API_ORIGIN = "https://abc.feg.com.tw";
    var SCENE_API_TIMEOUT = 8000;

    /** POST 一個 JSON body(bundle 跑在瀏覽器裡,預檢 OPTIONS 已確認 allow-methods 含 POST)。 */
    function postJson(url, body, timeoutMs) {
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var killer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (err) {} } }, timeoutMs || SCENE_API_TIMEOUT);
      return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (out) {
        clearTimeout(killer);
        return out;
      }, function (err) {
        clearTimeout(killer);
        throw err;
      });
    }

    /** 把遠端 payload 收成 §3.1 契約;形狀不對就抛,交給上層回退到 mock。 */
    function normalizeScenarios(payload) {
      var list = Array.isArray(payload)
        ? payload
        : (payload && Array.isArray(payload.scenarios)
            ? payload.scenarios
            : (payload && payload.data && Array.isArray(payload.data) ? payload.data : null));
      if (!list || list.length === 0) throw new Error("unexpected scene list payload");
      return list.map(function (s) {
        if (!s || typeof s.id !== "string" || typeof s.name !== "string") {
          throw new Error("scene entry missing id/name");
        }
        return {
          id: s.id,
          name: s.name,
          icon: s.icon === undefined || s.icon === null ? null : String(s.icon),
          hasDynamicTemplates: !!s.hasDynamicTemplates,
        };
      });
    }

    /** 遠端給的 previewUrl / thumbnailUrl 可能是相對路徑(預覽今天是 /share/ehr/pages/dev/preview/…),補上 API 域名。 */
    function resolveApiUrl(u) {
      if (typeof u !== "string" || u.length === 0) return u;
      return u.charAt(0) === "/" ? SCENE_API_ORIGIN + u : u;
    }

    /** §2.3 的模板對象(詳情與推薦共用)。 */
    function normalizeTemplates(list) {
      return (Array.isArray(list) ? list : []).map(function (t) {
        return {
          id: t.id,
          title: t.title,
          subtitle: t.subtitle === undefined ? null : t.subtitle,
          icon: t.icon === undefined ? null : t.icon,
          thumbnailUrl: resolveApiUrl(t.thumbnailUrl),
          previewUrl: resolveApiUrl(t.previewUrl),
          contentType: t.contentType || "html",
        };
      });
    }

    /** 把遠端 payload 收成 §3.2 契約;形狀不對就抛。 */
    function normalizeDetail(payload) {
      if (!payload || typeof payload.id !== "string" || typeof payload.name !== "string") {
        throw new Error("unexpected scene detail payload");
      }
      return {
        id: payload.id,
        name: payload.name,
        description: typeof payload.description === "string" ? payload.description : "",
        icon: payload.icon === undefined || payload.icon === null ? null : String(payload.icon),
        hasDynamicTemplates: !!payload.hasDynamicTemplates,
        branches: (Array.isArray(payload.branches) ? payload.branches : []).map(function (b) {
          return { id: b.id, name: b.name, preset: typeof b.preset === "string" ? b.preset : "" };
        }),
        templates: normalizeTemplates(payload.templates),
      };
    }

    function sourceTipFor(label, source) {
      if (source === "remote") return label + "：遠端 API（abc.feg.com.tw）";
      if (source === "mock") return label + "：mock（遠端 API 失敗，已回退）";
      return "";
    }

    // 模擬網路延遲:讓各處 loading 過渡在靜態 bundle 裡也看得見。
    // 接真介面時把 LATENCY 全設 0（或把 delayed 換成真的 fetch）即可。
    var LATENCY = { list: 520, detail: 420, dynamic: 760, recommend: 640, preview: 300 };

    function delayed(ms, value) {
      if (!ms) return Promise.resolve(value);
      return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, ms); });
    }

    var CSS_TEXT = "[data-st-scroll]::-webkit-scrollbar{display:none}"
      + "[data-st-scroll]{scrollbar-width:none;-ms-overflow-style:none}"
      + "@keyframes st-pet-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}"
      + "@keyframes st-pet-hop{0%{transform:translateY(0) scale(1)}30%{transform:translateY(-7px) scale(1.06)}"
      + "60%{transform:translateY(0) scale(.98)}100%{transform:translateY(0) scale(1)}}"
      + "@keyframes st-pet-blink{0%,90%,100%{transform:scaleY(1)}94%{transform:scaleY(.12)}}"
      + "@keyframes st-pet-sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}"
      + "@keyframes st-skel-pulse{0%,100%{opacity:.45}50%{opacity:1}}"
      + "@keyframes st-in{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}"
      + ".st-skel{animation:st-skel-pulse 1.25s ease-in-out infinite}"
      + ".st-in{animation:st-in .22s ease-out 1}"
      + ".st-pet-float{animation:st-pet-float 3.4s ease-in-out infinite}"
      + ".st-pet-hop{animation:st-pet-hop .55s ease-out 1}"
      + ".st-pet-eyes{transform-box:fill-box;transform-origin:center;animation:st-pet-blink 5.4s ease-in-out infinite}"
      + ".st-pet-sway{animation:st-pet-sway 4.6s ease-in-out infinite}";

    function installStyles() {
      var tag = document.createElement("style");
      tag.dataset.pluginCss = "scene-template/styles";
      tag.textContent = CSS_TEXT;
      document.head.appendChild(tag);
      return function () { tag.remove(); };
    }

    // ---------------------------------------------------------------------
    // 2. mock 數據 —— 接真接口時只改本段的 `api`
    // ---------------------------------------------------------------------
    function posterSvg(icon, hue) {
      var a = "hsl(" + hue + ",74%,60%)";
      var b = "hsl(" + (hue + 38) + ",72%,42%)";
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="296" viewBox="0 0 400 296">'
        + '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
        + '<stop offset="0%" stop-color="' + a + '"/>'
        + '<stop offset="100%" stop-color="' + b + '"/>'
        + '</linearGradient></defs>'
        + '<rect width="400" height="296" fill="url(#g)"/>'
        + '<circle cx="330" cy="60" r="90" fill="rgba(255,255,255,0.10)"/>'
        + '<circle cx="60" cy="250" r="70" fill="rgba(255,255,255,0.08)"/>'
        + '<text x="200" y="165" font-size="104" text-anchor="middle">' + icon + '</text>'
        + '<rect x="28" y="228" width="150" height="12" rx="6" fill="rgba(255,255,255,0.55)"/>'
        + '<rect x="28" y="250" width="96" height="12" rx="6" fill="rgba(255,255,255,0.32)"/>'
        + '</svg>';
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    }

    function previewPage(title, subtitle, sections) {
      var cards = sections.map(function (pair) {
        return '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:12px;margin:8px 0;">'
          + "<b>" + pair[0] + "</b> " + pair[1] + "</div>";
      }).join("");
      return "data:text/html;charset=utf-8," + encodeURIComponent(
        '<html><body style="font-family:system-ui,sans-serif;padding:24px;background:#f8fafc;">'
        + '<h2 style="margin:0 0 4px;color:#0f172a;">' + title + "</h2>"
        + '<p style="margin:0 0 12px;color:#64748b;font-size:13px;">' + subtitle + "</p>"
        + cards
        + "</body></html>"
      );
    }

    function tpl(id, title, icon, subtitle, sections, hue) {
      return {
        id: id, title: title, icon: icon, subtitle: subtitle,
        thumbnailUrl: posterSvg(icon, hue),
        previewUrl: previewPage(title, subtitle, sections),
        contentType: "html",
      };
    }

    var TEMPLATES = {
      scn_writing: [
        tpl("tpl_meeting", "會議紀要與決議看板", "📋", "決議 / 待辦 / 責任人 / 時間點", [
          ["議題:", "Q3 產品規劃與資源分配"],
          ["決議:", "優先推進 P0 流程改造,其餘進候選池"],
          ["待辦:", "張三—使用者訪談提綱(週三);李四—PRD 初稿(週五)"],
        ], 210),
        tpl("tpl_paper", "學術論文標準骨架", "📑", "摘要 / 方法 / 結果 / 結論", [
          ["摘要", "本研究探討 X 現象對 Y 指標的影響機制……"],
          ["方法", "採用 A+B 雙階段流程,樣本 N=320,A/B 對照……"],
          ["結論", "Z 方法在效率與效果上均更優,局限在於樣本單一"],
        ], 190),
        tpl("tpl_outline", "長文寫作大綱模板", "🧭", "開篇 / 主體三段 / 收束", [
          ["開篇", "用一個具體場景或一組數據切入"],
          ["主體", "三段遞進:現象 → 歸因 → 方案"],
          ["收束", "回到開頭場景,給一句可執行的建議"],
        ], 262),
        tpl("tpl_story", "品牌故事與文案腳本", "🎬", "痛點 / 轉折 / 證據 / 行動號召", [
          ["痛點", "使用者現在怎麼湊合解決的"],
          ["轉折", "我們改變了哪一個環節"],
          ["證據", "一個客戶的一句話 + 一個數字"],
        ], 24),
      ],
      scn_code: [
        tpl("tpl_review", "代碼評審檢查清單", "✅", "正確性 / 可讀性 / 邊界 / 性能", [
          ["正確性", "空值、越界、並發、異常路徑是否都有處理"],
          ["可讀性", "命名是否能自解釋;函數是否只做一件事"],
          ["邊界", "空輸入、超大輸入、超時與重試"],
        ], 220),
        tpl("tpl_postmortem", "缺陷復盤模板", "🩹", "現象 / 根因 / 修復 / 防復發", [
          ["現象", "什麼時候、誰遇到、影響面多大"],
          ["根因", "直接原因與更深一層的設計原因"],
          ["防復發", "補哪條測試、加哪個告警、改哪段流程"],
        ], 160),
        tpl("tpl_api", "API 設計與兼容性說明卡", "🔌", "入參 / 出參 / 版本 / 廢棄策略", [
          ["入參", "必選與可選、校驗規則、預設值"],
          ["兼容", "哪些改動算破壞性,如何灰度"],
          ["廢棄", "提前多久公告,保留幾個版本"],
        ], 282),
        tpl("tpl_migration", "數據遷移執行方案", "🚚", "摸底 / 雙寫 / 切換 / 回滾", [
          ["摸底", "數據量、臟數據、不可遷移項"],
          ["切換", "雙寫時長、灰度比例、觀測指標"],
          ["回滾", "觸發條件與回滾腳本誰執行"],
        ], 200),
      ],
      scn_analysis: [
        tpl("tpl_dashboard", "經營看板速覽", "📊", "收入 / 毛利 / 費用 / 現金", [
          ["收入", "同比 +12%,環比 +3%,主要由新品拉動"],
          ["毛利", "毛利率下滑 1.8pct,原材料漲價是主因"],
          ["現金", "經營性現金流覆蓋 2.3 個月,需盯應收賬期"],
        ], 205),
        tpl("tpl_attrib", "指標異動歸因框架", "🔍", "拆解 / 定位 / 驗證 / 結論", [
          ["拆解", "量 × 價 × 結構,先拆到可解釋的最小項"],
          ["定位", "找出貢獻度最大的兩項,排除口徑變更"],
          ["結論", "一句話結論 + 一條可執行動作"],
        ], 340),
        tpl("tpl_competitor", "競品對比記分卡", "⚖️", "維度 / 我方 / 對手 / 差距", [
          ["功能覆蓋", "我方 8/12 項,對手 10/12 項"],
          ["性能", "我方 P95 1.2s,對手 0.8s"],
          ["結論", "優先補 2 個高頻缺口,性能進 Q4 路線圖"],
        ], 30),
        tpl("tpl_forecast", "捲動預測與情景假設", "📈", "基準 / 樂觀 / 悲觀 / 觸發條件", [
          ["基準", "按現有轉化率外推,季度目標 +8%"],
          ["悲觀", "獲客成本再漲 15% 時的缺口"],
          ["觸發", "連續兩週低於預測線則啟動預案"],
        ], 250),
      ],
      scn_meeting: [
        tpl("tpl_minutes", "會議紀要標準模板", "🗒️", "背景 / 決議 / 待辦 / 風險", [
          ["背景", "為什麼開這個會,期望產出是什麼"],
          ["決議", "逐條寫清“定了什麼”,不寫討論過程"],
          ["待辦", "動詞開頭 + 負責人 + 截止時間"],
        ], 172),
        tpl("tpl_action", "行動項跟蹤表", "📌", "編號 / 事項 / 負責人 / 狀態", [
          ["A-01", "補齊灰度開關文檔 — 張三 — 進行中"],
          ["A-02", "確認三方接口超時策略 — 李四 — 待開始"],
          ["A-03", "回歸用例覆蓋支付回滾 — 王五 — 已完成"],
        ], 215),
        tpl("tpl_retro", "復盤會引導提綱", "🔄", "事實 / 感受 / 歸因 / 改進", [
          ["事實", "只寫發生了什麼,不帶評價"],
          ["歸因", "哪些是流程問題,哪些是能力問題"],
          ["改進", "只留三條,每條有負責人"],
        ], 300),
        tpl("tpl_onepage", "一頁紙決策備忘", "📄", "問題 / 選項 / 建議 / 影響", [
          ["問題", "一句話說清要決定什麼"],
          ["選項", "A/B 兩個方案的代價與收益"],
          ["建議", "推薦哪個 + 什麼條件下改主意"],
        ], 45),
      ],
      scn_translate: [
        tpl("tpl_glossary", "術語表模板", "📚", "原文 / 譯文 / 詞性 / 備注", [
          ["deployment", "部署 / 上線", "名詞", "面向運維時用“上線”"],
          ["session", "工作階段 / 工作階段", "名詞", "尊重產品既有譯法"],
          ["rollback", "回滾 / 復原", "動詞", "介面文案優先“回滾”"],
        ], 192),
        tpl("tpl_l10n_check", "本地化檢查清單", "🌐", "術語 / 語氣 / 長度 / 變量", [
          ["術語", "與術語表一致,同一概念不混用兩種譯法"],
          ["長度", "按鈕類文案不超過原文 1.3 倍,避免截斷"],
          ["變量", "佔位符、複數、日期格式是否都保留正確"],
        ], 275),
        tpl("tpl_style", "語氣風格指南", "🎨", "正式度 / 人稱 / 縮寫 / 術語口徑", [
          ["正式度", "面向客戶用中性偏正式,內部可口語"],
          ["人稱", "統一用“你/我們”,避免被動語態堆疊"],
          ["縮寫", "首次出現給全稱,後續統一縮寫"],
        ], 330),
        tpl("tpl_review_en", "譯文評審記錄表", "🧐", "問題類型 / 位置 / 建議 / 結論", [
          ["術語", "第 3 段 “session” 與術語表不一致"],
          ["語氣", "第 7 段偏命令式,建議改請求式"],
          ["結論", "術語與語氣必須改,其餘可接受"],
        ], 205),
      ],
      scn_review: [
        tpl("tpl_evidence", "評審證據清單", "🧾", "控制點 / 證據 / 責任部門 / 結論", [
          ["訪問控制", "權限矩陣截圖 + 季度複核記錄"],
          ["變更管理", "變更單抽樣 20 筆,全部雙人複核"],
          ["日誌留存", "保留 180 天,滿足內控要求"],
        ], 0),
        tpl("tpl_remediation", "整改計畫模板", "🛠️", "問題 / 風險等級 / 措施 / 時限", [
          ["高", "未做離職即時回收 — 30 天內接入統一賬號"],
          ["中", "日誌告警閾值偏鬆 — 下個迭代調整"],
          ["低", "文檔未版本化 — 納入知識庫治理"],
        ], 35),
        tpl("tpl_matrix", "控制點矩陣", "🧮", "控制域 / 要求 / 現狀 / 差距", [
          ["身份", "統一賬號 + 雙因素", "部分滿足", "外包賬號未納管"],
          ["數據", "分級分類 + 加密", "滿足", "無"],
          ["審計", "操作留痕可追溯", "部分滿足", "導出行為未記錄"],
        ], 215),
        tpl("tpl_qna", "評審問答預演稿", "🎤", "高頻問題 / 追問 / 回答要點", [
          ["問", "為什麼這條控制點沒做到?"],
          ["追問", "什麼時間能補上,誰負責?"],
          ["要點", "坦白現狀 + 明確期限 + 給出證據"],
        ], 265),
      ],
    };

    var DYNAMIC_TEMPLATES = {
      scn_writing: [
        tpl("tpl_weekly", "本週工作週報", "📅", "完成 / 進行中 / 下週計畫 / 風險", [
          ["完成:", "接入輸入區三級選擇,聯調通過"],
          ["進行中:", "動態模板觸發時機與防抖策略"],
          ["下週:", "真實 API 取代 mock,補埋點"],
        ], 205),
        tpl("tpl_brief", "項目簡報一頁紙", "📰", "背景 / 目標 / 範圍 / 里程碑 / 風險", [
          ["背景:", "輸入區互動標準化,減少重復描述"],
          ["目標:", "把上下文壓縮成一個最小自洽的輸入包"],
          ["里程碑:", "M1 組件化 → M2 接真 API → M3 持久化"],
        ], 255),
        tpl("tpl_recap", "階段復盤紀要", "🧭", "做對了什麼 / 做錯了什麼 / 下一步", [
          ["做對:", "先用 mock 跑通互動,再換真數據"],
          ["做錯:", "過早寫死寬度與 DOM 猜測"],
          ["下一步:", "把面板做成可配置的 slot 組件"],
        ], 25),
      ],
      scn_analysis: [
        tpl("tpl_metric", "指標口徑說明卡", "📐", "指標 / 口徑 / 來源 / 負責人", [
          ["指標:", "月度經常性收入(MRR)"],
          ["口徑:", "只計入已生效合同,不含試用"],
          ["來源:", "計費系統日快照,負責人:數據組"],
        ], 200),
        tpl("tpl_attrib_card", "異動歸因結論卡", "🔍", "現象 / 主因 / 證據 / 行動", [
          ["現象:", "本月轉化率環比 -2.1pct"],
          ["主因:", "主推渠道流量結構調整,長尾占比上升"],
          ["行動:", "低轉化渠道改投素材,兩週後復看"],
        ], 335),
        tpl("tpl_scenario", "情景測算卡", "📉", "假設 / 結果區間 / 觸發線", [
          ["假設:", "獲客成本 +10% / 轉化率不變"],
          ["結果:", "季度收入落在 -4% ~ +1% 區間"],
          ["觸發:", "連續兩週低於中位線則啟用預案 B"],
        ], 155),
      ],
    };

    var SCENARIOS = [
      {
        id: "scn_writing",
        name: "長篇內容創作與結構化改寫",
        icon: "✍️",
        description: "寫作場景:面向散文、論文與營銷文案,提供結構梳理、長文寫作與語氣潤色三類分支提示詞。",
        hasDynamicTemplates: true,
        branches: [
          { id: "br_essay", name: "靈感速記與片段整理", preset: "請幫我把以下零散片段整理成一篇結構清晰、過渡自然的散文,保留我原本的語氣:\n\n" },
          { id: "br_long", name: "深度長文與論證結構", preset: "請圍繞下面的主題寫一篇約 2000 字的深度文章,要求有清晰的三段式論證、每段有小標題,並在結尾給出一句結論:\n\n主題:" },
          { id: "br_polish", name: "語氣潤色與表達優化", preset: "請潤色以下文字:保持原意,提升準確性與可讀性,並在最後列出三處最值得改的地方:\n\n" },
          { id: "br_outline", name: "標題提煉與摘要生成", preset: "請為以下內容提煉三個標題(克制 / 中性 / 有吸引力各一),並寫一段不超過 120 字的摘要:\n\n" },
        ],
      },
      {
        id: "scn_code",
        name: "代碼編寫、調試與漸進式重構",
        icon: "💻",
        description: "編程場景:覆蓋腳本編寫、線上缺陷定位與遺留模塊重構,按語言與運行環境給出可直接執行的提示詞。",
        hasDynamicTemplates: false,
        branches: [
          { id: "br_script", name: "Python 腳本生成與參數校驗", preset: "請用 Python 寫一個腳本:帶參數校驗、錯誤處理與 --help 說明,並在注釋裡說明關鍵取捨:\n\n需求:" },
          { id: "br_debug", name: "線上缺陷快速定位", preset: "請幫我定位以下線上缺陷:先列出三種最可能的原因並排序,再給出驗證方法,最後給最小修復補丁:\n\n現象:" },
          { id: "br_refactor", name: "遺留模塊漸進式重構", preset: "請為下面的遺留代碼設計漸進式重構方案:分三批改,每批都能獨立上線,說明每批的風險與回歸重點:\n\n" },
          { id: "br_test", name: "單元測試與邊界用例補全", preset: "請為以下函數補齊單元測試,覆蓋正常路徑、邊界值與異常分支,並指出當前實現裡最可疑的一處:\n\n" },
        ],
      },
      {
        id: "scn_analysis",
        name: "財報與經營數據分析",
        icon: "📊",
        description: "分析場景:從財報、經營報表與埋點數據中提取關鍵指標,輸出結論、歸因鏈路與下一步行動建議。",
        hasDynamicTemplates: true,
        branches: [
          { id: "br_quarter", name: "季度財報要點提取", preset: "請從下面的財報內容裡提取要點:先給三條結論,再列關鍵指標(含同比/環比),最後標出異常項:\n\n" },
          { id: "br_attrib", name: "指標異動歸因分析", preset: "請對以下指標異動做歸因:按量、價、結構三層拆解,給出主因假設與驗證方法,並說明還需要哪些數據:\n\n" },
          { id: "br_competitor", name: "競品對比與差距量化", preset: "請把以下競品資訊整理成對比記分卡:按維度打分,指出我們最該補的兩項,並估算補齊成本:\n\n" },
        ],
      },
      {
        id: "scn_meeting",
        name: "會議紀要與行動項跟蹤",
        icon: "🗂️",
        description: "協作場景:把會議轉寫整理成決議、待辦與責任人清單,並標註風險、依賴與待確認事項。",
        hasDynamicTemplates: false,
        branches: [
          { id: "br_decision", name: "決議與待辦提取", preset: "請把下面的會議記錄整理成:決議清單(定了什麼)、待辦清單(動詞開頭 + 負責人 + 截止時間),不要保留討論過程:\n\n" },
          { id: "br_risk", name: "風險、依賴與待確認項", preset: "請從下面的會議記錄裡挑出風險、外部依賴和還沒說清的問題,按影響程度排序,並寫出各自需要誰來拍板:\n\n" },
          { id: "br_merge", name: "多會議串講與合併", preset: "請把下面多次會議的記錄合併成一份進展總覽:按主題而不是按時間組織,標出觀點變化與仍未收斂的分歧:\n\n" },
        ],
      },
      {
        id: "scn_translate",
        name: "多語種技術文檔翻譯與本地化",
        icon: "🌐",
        description: "本地化場景:面向產品文檔與介面文案,兼顧術語一致性、語氣風格與長度約束,適配不同地區的表達習慣。",
        hasDynamicTemplates: false,
        branches: [
          { id: "br_glossary", name: "術語一致性與譯法校驗", preset: "請按術語表校驗以下譯文:列出不一致的術語(原文 → 當前譯法 → 建議譯法),並說明理由:\n\n" },
          { id: "br_ui", name: "介面文案精簡本地化", preset: "請把以下介面文案本地化:保持簡潔,按鈕類不超過原文 1.3 倍長度,並保留全部佔位符與複數形式:\n\n" },
          { id: "br_doc", name: "長文技術翻譯與校對", preset: "請翻譯並校對以下技術文檔:術語統一、語氣中性、代碼與命令保持原樣,翻譯後列出不確定的 3 處:\n\n" },
        ],
      },
      {
        id: "scn_review",
        name: "合規與安全評審材料準備",
        icon: "🛡️",
        description: "評審場景:把現狀材料整理成合規論證、風險評級與整改計畫三件套,並預演評審委員可能追問的問題。",
        hasDynamicTemplates: false,
        branches: [
          { id: "br_gap", name: "控制點差距自查", preset: "請對照以下控制點做差距自查:逐條給出“滿足/部分滿足/不滿足”、現有證據和缺口,最後按風險排序:\n\n" },
          { id: "br_plan", name: "風險評級與整改計畫", preset: "請基於下面的發現做風險評級(高/中/低)並給出整改計畫:措施、責任人、時限、驗收標準:\n\n" },
          { id: "br_rehearsal", name: "評審問答預演", preset: "請扮演嚴格的評審委員,針對下面的材料提出 10 個最可能被追問的問題,並給出建議的回答要點:\n\n" },
        ],
      },
    ];

    var RECOMMEND_POOL = [];
    Object.keys(TEMPLATES).forEach(function (key) {
      TEMPLATES[key].forEach(function (t) { RECOMMEND_POOL.push(t); });
    });
    Object.keys(DYNAMIC_TEMPLATES).forEach(function (key) {
      DYNAMIC_TEMPLATES[key].forEach(function (t) { RECOMMEND_POOL.push(t); });
    });

    // mock 的場景詳情(遠端失敗/未配時的回退路徑)。注意帶上 icon 與 hasDynamicTemplates
    // —— 前者是海報卡/膠囊的圖標,後者是"要不要在輸入後再拉一次動態模板"的開關。
    function scenarioDetail(id) {
      for (var i = 0; i < SCENARIOS.length; i += 1) {
        if (SCENARIOS[i].id === id) {
          var s = SCENARIOS[i];
          return {
            id: s.id, name: s.name, description: s.description, icon: s.icon,
            hasDynamicTemplates: s.hasDynamicTemplates,
            branches: s.branches,
            templates: TEMPLATES[s.id] || [],
          };
        }
      }
      return null;
    }

    function findTemplateById(id) {
      var pool = RECOMMEND_POOL;
      for (var i = 0; i < pool.length; i += 1) if (pool[i].id === id) return pool[i];
      return null;
    }

    // 選中資料同步給宿主半邊(lib/index.js):它把這些資料註冊成模型的 runtime context。
    // 靜態 bundle 的客戶端跑在瀏覽器裡,沒有動態 Package 的 host.call —— 所以走一條
    // DSH 自己的同源路由(宿主半邊用 webServer.register 開在 /plugins/scene-template/ 下)。
    var SELECTION_ROUTE = "/plugins/scene-template/selection";

    function syncSelection(payload) {
      return fetch(SELECTION_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      });
    }

    /**
     * 介面用到的全部數據入口。今天讀的是本檔案裡的 mock;
     * 接真接口時只改這一個對象(例如換成 fetch('/api/scenarios') 或宿主 RPC),
     * 上層組件一行都不用動。
     */
    var api = {
      listScenarios: function () {
        // 真接口 + 失敗回退:超時/非 2xx/形狀不對 → 用本檔案裡的 mock,
        // 並把 source 帶回去(介面上 hover 場景列可確認來源)。
        // 清單是 GET,回應只有一個弱 etag(沒有 cache-control / last-modified),所以每次加一個
        // 唯一查詢參數 —— 瀏覽器或中間快取都不可能把舊清單餵回來,新工作階段一定拿到最新。
        // (不用 fetch 的 cache:"no-store":它會帶上 cache-control 請求頭,把簡單請求變成需要 preflight)
        var ctrl = typeof AbortController === "function" ? new AbortController() : null;
        var killer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (err) {} } }, SCENE_API_TIMEOUT);
        return fetch(SCENE_API + "?_t=" + Date.now(), {
          headers: { accept: "application/json" },
          signal: ctrl ? ctrl.signal : undefined,
        }).then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }).then(function (payload) {
          return { scenarios: normalizeScenarios(payload), source: "remote" };
        }).catch(function (err) {
          console.warn("[scene-template] scene list remote failed, falling back to mock:", err && err.message ? err.message : err);
          return delayed(LATENCY.list, {
            scenarios: SCENARIOS.map(function (s) {
              return { id: s.id, name: s.name, icon: s.icon, hasDynamicTemplates: s.hasDynamicTemplates };
            }),
            source: "mock",
          });
        }).then(function (out) {
          clearTimeout(killer);
          return out;
        });
      },
      getScenario: function (id) {
        // 真接口(POST {id}) + 失敗回退:超時/非 2xx/形狀不對 → 用本檔案裡的 mock。
        return postJson(SCENE_DETAIL_API, { id: id }).then(function (payload) {
          return { detail: normalizeDetail(payload), source: "remote" };
        }).catch(function (err) {
          console.warn("[scene-template] scene detail remote failed, falling back to mock:", err && err.message ? err.message : err);
          return delayed(LATENCY.detail, { detail: scenarioDetail(id), source: "mock" });
        });
      },
      getDynamicTemplates: function (scenarioId, input) {
        // 沒到觸發條件時不延遲(這條本來就不該發請求)
        if (!input || input.length < 20) return Promise.resolve([]);
        return delayed(LATENCY.dynamic, DYNAMIC_TEMPLATES[scenarioId] || []);
      },
      // 推薦:POST /scene/suggestion_template {scene_id, content}。遠端每次回一批(陣列),
      // 所以「換一批」就是再調一次;cursor 只在回退到本檔案 mock 池子時才有用。
      recommend: function (sceneId, content, cursor) {
        return postJson(SCENE_SUGGEST_API, { scene_id: sceneId, content: content }).then(function (list) {
          return { templates: normalizeTemplates(list), source: "remote" };
        }).catch(function (err) {
          console.warn("[scene-template] suggestion remote failed, falling back to mock:", err && err.message ? err.message : err);
          var size = 4;
          var total = RECOMMEND_POOL.length;
          var raw = typeof cursor === "number" ? cursor : 0;
          var start = ((raw % total) + total) % total;
          var count = Math.min(size, total);
          var batch = [];
          for (var i = 0; i < count; i += 1) batch.push(RECOMMEND_POOL[(start + i) % total]);
          return delayed(LATENCY.recommend, {
            templates: batch,
            source: "mock",
            nextCursor: start + count,
            batchIndex: Math.floor(start / count) + 1,
            total: Math.ceil(total / count),
          });
        });
      },
      getPreview: function (id) {
        var hit = findTemplateById(id);
        if (!hit) return Promise.resolve(null);
        return delayed(LATENCY.preview, { previewUrl: hit.previewUrl, contentType: hit.contentType });
      },
    };
    // ---------------------------------------------------------------------
    // mock 段結束
    // ---------------------------------------------------------------------

    // 一個模塊內的小事件總線:兩個面板共用“當前選擇”狀態。
    var listeners = new Set();
    function emit(evt) { listeners.forEach(function (fn) { try { fn(evt); } catch (err) {} }); }
    function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
    function setSelection(next) { emit({ type: "set", payload: next }); }
    function clearSelection() { emit({ type: "clear" }); }
    function useSharedSelection() {
      var pair = React.useState(null);
      var sel = pair[0];
      var setSel = pair[1];
      React.useEffect(function () {
        return subscribe(function (evt) {
          if (evt.type === "set") setSel(evt.payload);
          else if (evt.type === "clear") setSel(null);
        });
      }, []);
      return [sel, setSel];
    }

    /**
     * 手動重新整理:點寵物 → 總線上發 'refresh',兩個面板各自把請求重跑一次(靠 tick 當依賴)。
     */
    function useRefreshTick() {
      var pair = React.useState(0);
      var tick = pair[0];
      var setTick = pair[1];
      React.useEffect(function () {
        return subscribe(function (evt) {
          if (evt.type === "refresh") setTick(function (t) { return t + 1; });
        });
      }, []);
      return tick;
    }

    // conversation.composer.dock 只在 variant === 'composer' 時渲染,而 hero(新建空工作階段)
    // 沒有它 —— 那時由 st-top-templates 這個 entry 頂上(見 HeroTemplateEntry)。
    var dockState = { bottomMounted: false };
    function useBottomDockFlag() {
      var pair = React.useState(dockState.bottomMounted);
      var on = pair[0];
      var setOn = pair[1];
      React.useEffect(function () {
        return subscribe(function (evt) {
          if (evt.type === "bottom-dock") setOn(evt.payload);
        });
      }, []);
      return on;
    }

    function selectDraft(state) {
      if (!state || typeof state.draft !== "string") return "";
      return state.draft;
    }

    /** The composer's contenteditable (Lexical), used only to read the current layout. */
    function findComposerEl() {
      var sels = [
        '[data-composer] [contenteditable="true"]',
        "[data-composer-textarea]",
        "[data-composer] textarea",
        '[contenteditable="true"]',
        "textarea",
      ];
      for (var i = 0; i < sels.length; i += 1) {
        var el = document.querySelector(sels[i]);
        if (el) return el;
      }
      return null;
    }

    /**
     * Whether the composer is in its hero (brand-new session) variant. The shipped
     * conversation code marks the stack with
     * `clsx(composerStack, hero && composerHero)`, and CSS-module hashing keeps the
     * `composerHero` local suffix, so a substring match is stable enough.
     */
    function isHeroLayout() {
      var el = findComposerEl();
      if (!el) return false;
      var node = el;
      for (var i = 0; node && i < 12; i += 1, node = node.parentElement) {
        var cls = node.getAttribute ? node.getAttribute("class") : null;
        if (!cls) continue;
        if (cls.indexOf("composerHero") >= 0) return true;
        if (cls.indexOf("composerStack") >= 0) return false;
      }
      return false;
    }

    // 按住內容左右拖曳平移。pointerdown 不捕獲指針 —— 否則 mouseup/click 會被
    // 重定向到捲動容器,chip 收不到 click(能拖但點不中);越過 4px 閾值後才捕獲。
    function useDragPan() {
      var ref = React.useRef(null);
      var drag = React.useRef({ active: false, moved: false, startX: 0, startLeft: 0, pointerId: undefined });

      function onPointerDown(ev) {
        var el = ref.current;
        if (!el) return;
        if (ev.pointerType === "touch") return;   // 觸屏交給原生滑動
        if (ev.button !== undefined && ev.button !== 0) return;
        drag.current = {
          active: true, moved: false,
          startX: ev.clientX, startLeft: el.scrollLeft,
          pointerId: ev.pointerId,
        };
      }

      function onPointerMove(ev) {
        var el = ref.current;
        var s = drag.current;
        if (!el || !s.active) return;
        var dx = ev.clientX - s.startX;
        if (!s.moved) {
          if (Math.abs(dx) < 4) return;
          s.moved = true;
          try {
            if (el.setPointerCapture && s.pointerId !== undefined) el.setPointerCapture(s.pointerId);
          } catch (err) {}
        }
        el.scrollLeft = s.startLeft - dx;
      }

      function endDrag() { drag.current.active = false; }

      function onClickCapture(ev) {
        if (!drag.current.moved) return;
        drag.current.moved = false;
        ev.stopPropagation();
        ev.preventDefault();
      }

      return {
        ref: ref,
        handlers: {
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: endDrag,
          onPointerCancel: endDrag,
          onPointerLeave: endDrag,
          onClickCapture: onClickCapture,
        },
      };
    }

    var POSTER_W = 200;
    var COVER_H = 148;

    // 與輸入卡片**同一個盒子**：
    //   inputBar 的根 `.uV2eYG_root{padding:0 var(--dsh-composer-side-clearance)}` 裡才是卡片
    //   `.uV2eYG_card{width:100%;max-width:var(--dsh-composer-card-max-width)}`；
    //   而本 entry 經 SlotOutlet(display:contents) 直接是 `composerStack` 的子項，和 inputBar 平級
    //   —— 所以 100% 就是 composerStack 的寬度，減掉兩側 clearance 之後與卡片完全重合。
    // 注意別抄 TodoPanel 的 `.lXshSW_root`：它多減了 4 個 dock-inset，那是它自己那層嵌套的
    //   "浮起提示卡"幾何，照抄會讓面板比輸入卡片每側窄 16px。
    // hero 會話也成立：`.wSkVaW_composerHero{width:min(card-max + 2*clearance,100%)}` 把 stack
    //   居中撐到卡片寬 + 兩側 clearance，兩邊都在同一個 stack 裡居中。
    var PANEL_WIDTH = "calc(100%"
      + " - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance))";
    var PANEL_MAX = "var(--dsh-composer-card-max-width)";

    var panelBase = {
      boxSizing: "border-box",
      width: PANEL_WIDTH,
      maxWidth: PANEL_MAX,
      margin: "0 auto",
      flex: "none",
      // 左右 14px = 輸入框內文的起點(.uV2eYG_input padding-left / placeholder inset-left 都是 14px),
      // 所以 chips 的左邊緣和輸入文字的起點對齊。
      padding: "8px 14px",
      background: "transparent",
      border: "none",
      borderRadius: 0,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      fontSize: 12, color: "#0f172a",
    };

    var S = {
      panel: panelBase,
      // 場景/分支面板:寵物騎著面板**右上角**掛在外面(45° 斜),左右都不佔槽位 ——
      // chips 回到與輸入文字同一列;marginTop 是給它懸空留的空氣(它懸在面板外的空白裡,
      // 不會壓到面板上方那一行 hero 工作區 chip,也不會把輸入框往下推)。
      panelPet: { ...panelBase, position: "relative", marginTop: PET_AIR },
      petBox: {
        // 透明正方形:無背景、無邊框,只有寵物本體;中心落在面板右上角點附近。
        // 它是可點的 —— 點一下 = 手動重新整理(重新拉場景清單與詳情)。
        position: "absolute",
        right: PET_HANG - PET / 2, top: -PET_HANG - PET / 2,
        width: PET, height: PET,
        cursor: "pointer",
      },
      // 45° 斜掛(右上角是 +45°,和左上角鏡像):旋轉只作用在寵物本體上,不帶動表情氣泡
      petRotate: { width: "100%", height: "100%", transform: "rotate(0deg)" },
      // 氣泡放寵物另一側(鏡像後在盒子左上方),仍在面板上方留的空氣裡,
      // 不會探出工作階段列右邊界被裁
      petBubble: { position: "absolute", top: 2, right: PET - 4, fontSize: 13, lineHeight: 1 },
      row: {
        display: "flex", alignItems: "center", gap: 6,
        marginTop: 4, marginBottom: 4, minWidth: 0,
      },
      scroller: {
        display: "flex", flexWrap: "nowrap", gap: 6,
        flex: "1 1 auto", minWidth: 0,
        overflowX: "auto", overflowY: "hidden",
        paddingBottom: 2,
        cursor: "grab", userSelect: "none", touchAction: "pan-x",
      },
      // 場景清單是主選擇，比分支那一檔大一號(big=true)：字號、內距、字重都上調。
      chip: function (selected, color, big) {
        return {
          flex: "0 0 auto",
          padding: big ? "7px 15px" : "4px 11px",
          border: "1px solid " + (selected ? (color || "#2563eb") : "#cbd5e1"),
          borderRadius: 999,
          background: selected ? (color || "#2563eb") : "#f8fafc",
          color: selected ? "#fff" : "#0f172a",
          cursor: "pointer",
          fontSize: big ? 14 : 13,
          fontWeight: big ? 500 : 400,
          lineHeight: 1.35,
          userSelect: "none", whiteSpace: "nowrap",
        };
      },
      // 骨架:與真實元素同尺寸、同圓角,只是灰底 + 呼吸(見 CSS_TEXT 的 .st-skel)
      skelChip: function (big, width) {
        return {
          flex: "0 0 auto",
          width: width, height: big ? 34 : 25,
          borderRadius: 999, background: SKEL_BG,
        };
      },
      skelPoster: {
        flex: "0 0 auto",
        width: POSTER_W,
        border: "2px solid #e2e8f0",
        borderRadius: 14,
        background: "#fff",
        overflow: "hidden",
        position: "relative",
        textAlign: "left",
        boxShadow: "0 1px 3px rgba(15, 23, 42, 0.08)",
      },
      skelCover: { height: COVER_H, background: SKEL_BG },
      skelLine: function (width) {
        return { height: 10, width: width, marginTop: 10, borderRadius: 6, background: SKEL_BG };
      },
      poster: function (selected) {
        return {
          flex: "0 0 auto",
          width: POSTER_W,
          border: "2px solid " + (selected ? "#0ea5e9" : "#e2e8f0"),
          borderRadius: 14,
          background: "#fff",
          cursor: "pointer",
          overflow: "hidden",
          position: "relative",
          boxShadow: selected ? "0 8px 22px rgba(14, 165, 233, 0.28)" : "0 1px 3px rgba(15, 23, 42, 0.08)",
          transition: "transform 0.15s, box-shadow 0.15s",
          textAlign: "left",
        };
      },
      cover: { height: COVER_H, background: "#f1f5f9", overflow: "hidden" },
      coverImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
      coverIcon: {
        width: "100%", height: "100%",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 56, lineHeight: 1,
      },
      badge: {
        position: "absolute", top: 8, right: 8,
        width: 24, height: 24, borderRadius: "50%",
        background: "#0ea5e9", color: "#fff",
        fontSize: 14, lineHeight: "24px", fontWeight: 700, textAlign: "center",
        boxShadow: "0 2px 6px rgba(14, 165, 233, 0.45)",
      },
      posterBody: { padding: "9px 11px 12px" },
      posterTitle: {
        fontSize: 13, fontWeight: 700, color: "#0f172a", lineHeight: 1.3,
        overflow: "hidden", textOverflow: "ellipsis",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      },
      posterSub: {
        fontSize: 11, color: "#64748b", marginTop: 4, lineHeight: 1.35,
        overflow: "hidden",
        display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
      },
      strip: {
        display: "flex", gap: 12, marginTop: 8,
        overflowX: "auto", overflowY: "hidden",
        paddingBottom: 2,
        cursor: "grab", userSelect: "none", touchAction: "pan-x",
      },
      empty: { fontSize: 11, color: "#94a3b8", padding: "4px 0", flex: "0 0 auto" },
      header: {
        display: "flex", alignItems: "center",
        gap: 8, minWidth: 0, marginBottom: 4,
      },
      headRight: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 },
      headLeft: { display: "flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" },
      hint: { fontSize: 10, color: "#94a3b8", fontWeight: 400 },
      // 選中的場景:左側主位,品牌色膠囊;右側帶一個關閉 ✕(點它 = 清空選擇、回到場景清單)
      scenarioBadge: {
        display: "inline-flex", alignItems: "center", gap: 6,
        padding: "3px 6px 3px 12px", borderRadius: 999,
        background: "var(--dsw-alias-brand-primary, #2563eb)",
        color: "#fff", fontSize: 13, fontWeight: 700, lineHeight: 1.4,
        boxShadow: "0 2px 10px rgba(37, 99, 235, 0.28)",
        maxWidth: "62%", minWidth: 0,
      },
      scenarioBadgeIcon: { fontSize: 14, lineHeight: 1, flexShrink: 0 },
      scenarioBadgeText: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      badgeClose: {
        flexShrink: 0, width: 18, height: 18, padding: 0, marginLeft: 2,
        border: "none", borderRadius: 999, cursor: "pointer",
        background: "rgba(255, 255, 255, 0.22)", color: "#fff",
        fontSize: 11, lineHeight: 1,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
      },
      recommendBtn: {
        border: "1px solid #c9d6e4", background: "#f8fafc", color: "#0f172a",
        padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600,
        cursor: "pointer", whiteSpace: "nowrap",
      },
      selectedSummary: { fontSize: 11, color: "#64748b" },
      clearBtn: {
        border: "1px solid #dbe3ec", background: "transparent",
        color: "#64748b", cursor: "pointer", fontSize: 11,
        padding: "3px 9px", borderRadius: 999, whiteSpace: "nowrap",
      },
      previewModal: {
        position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
        background: "#fff", borderRadius: 12,
        width: "min(860px, 90vw)", height: "min(640px, 82vh)",
        display: "flex", flexDirection: "column", overflow: "hidden",
        zIndex: 99999, boxShadow: "0 24px 60px rgba(15, 23, 42, 0.3)",
      },
      previewBackdrop: { position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.5)", zIndex: 99998 },
      previewHeader: {
        padding: "10px 14px", borderBottom: "1px solid #e2e8f0",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        fontWeight: 600, fontSize: 13,
      },
      previewClose: {
        border: "1px solid #cbd5e1", background: "transparent",
        padding: "4px 10px", borderRadius: 6, fontSize: 12, cursor: "pointer",
      },
      previewBody: { flex: 1, position: "relative", display: "flex", flexDirection: "column" },
      previewOverlay: {
        position: "absolute", inset: 0, background: "#fff",
        display: "flex", flexDirection: "column", gap: 12,
        alignItems: "center", justifyContent: "center",
        color: "#94a3b8", fontSize: 12, padding: "0 32px", textAlign: "center",
      },
      previewHint: { color: "#b45309", fontSize: 11, lineHeight: 1.5, maxWidth: 420 },
      previewSkel: { width: "72%", height: 12, borderRadius: 6, background: SKEL_BG },
      iframe: { flex: 1, border: "none", width: "100%" },
    };

    /**
     * 專家寵物:內聯 SVG(不依賴任何外部資源或字體),透明正方形,掛在面板**右上角**外(扶正不斜)。
     * state 變化時給 hop 動畫換 key → React 重掛載 → 動畫重放一次;
     * 表情氣泡:未選場景 💭 → 已選場景 💡 → 已選分支 ✨。
     * 層級:petBox(定位在角點)> petRotate(歸零)> hop(狀態變化重放)> svg(float);
     *       氣泡放在 petBox 裡、在寵物左側,不跟著轉。
     */
    function ExpertPet(props) {
      var state = props && props.state ? props.state : "idle";
      var bubble = state === "branch" ? "✨" : (state === "scenario" ? "💡" : "💭");
      function line(x1, y1, x2, y2) {
        return e("line", {
          x1: x1, y1: y1, x2: x2, y2: y2,
          stroke: "#2563eb", strokeWidth: 2.6, strokeLinecap: "round",
        });
      }
      return e("div", {
        style: S.petBox,
        onClick: props && props.onClick ? props.onClick : undefined,
        title: props && props.title ? props.title : undefined,
      },
        e("div", { className: "st-pet-sway", style: S.petRotate },
          e("div", { key: state, className: "st-pet-hop", style: { width: "100%", height: "100%" } },
            e("svg", {
              viewBox: "0 0 64 64", width: "100%", height: "100%",
              className: "st-pet-float", focusable: "false",
          },
            // 天線
            line(32, 8.5, 32, 15),
            e("circle", { cx: 32, cy: 6.4, r: 3.4, fill: "#f59e0b" }),
            // 兩側耳栓
            e("rect", { x: 3, y: 28, width: 7, height: 12, rx: 3.5, fill: "#bfdbfe" }),
            e("rect", { x: 54, y: 28, width: 7, height: 12, rx: 3.5, fill: "#bfdbfe" }),
            // 頭
            e("rect", { x: 9, y: 13, width: 46, height: 40, rx: 14, fill: "#eef5ff", stroke: "#2563eb", strokeWidth: 2.6 }),
            // 眼睛(圓框眼鏡 = 專家感)+ 眨眼
            e("g", { className: "st-pet-eyes" },
              e("circle", { cx: 23.5, cy: 32, r: 6.8, fill: "#fff", stroke: "#2563eb", strokeWidth: 2 }),
              e("circle", { cx: 40.5, cy: 32, r: 6.8, fill: "#fff", stroke: "#2563eb", strokeWidth: 2 }),
              e("line", { x1: 30.3, y1: 32, x2: 33.7, y2: 32, stroke: "#2563eb", strokeWidth: 2, strokeLinecap: "round" }),
              e("circle", { cx: 23.5, cy: 32.6, r: 2.9, fill: "#0f172a" }),
              e("circle", { cx: 40.5, cy: 32.6, r: 2.9, fill: "#0f172a" }),
            ),
            // 微笑 + 腮紅
            e("path", { d: "M25.5 43.5 q6.5 5 13 0", fill: "none", stroke: "#2563eb", strokeWidth: 2.2, strokeLinecap: "round" }),
            e("circle", { cx: 16, cy: 40, r: 2.6, fill: "#fca5a5", opacity: 0.65 }),
            e("circle", { cx: 48, cy: 40, r: 2.6, fill: "#fca5a5", opacity: 0.65 }),
          ),
        ),
        ),
        e("span", { style: S.petBubble }, bubble),
      );
    }

    function TopScenarioPanel(props) {
      var selPair = useSharedSelection();
      var sel = selPair[0];
      var scenariosPair = React.useState(null);   // null = 載入中(顯示骨架)
      var scenarios = scenariosPair[0];
      var setScenarios = scenariosPair[1];
      var sourcePair = React.useState(null);
      var scenarioSource = sourcePair[0];
      var setScenarioSource = sourcePair[1];
      var activePair = React.useState(null);      // null = 場景詳情載入中
      var active = activePair[0];
      var setActive = activePair[1];
      var detailSourcePair = React.useState(null);
      var detailSource = detailSourcePair[0];
      var setDetailSource = detailSourcePair[1];
      // 宿主回報的"會注入什麼 / 上次組裝結果",只放在寵物的 hover 提示裡(不佔版面)
      var injectTipPair = React.useState(null);
      var injectTip = injectTipPair[0];
      var setInjectTip = injectTipPair[1];
      var actions = props ? props.inputActions : undefined;
      // 座位把當前的 session 一起給下來:換會話/新開會話時用它當依賴,重新拉一次
      var sessionId = props ? props.sessionId : undefined;
      // 手動重新整理(點寵物)遞增這個計數,把它加到請求依賴上即可重跑
      var tick = useRefreshTick();
      var scenarioPan = useDragPan();
      var branchPan = useDragPan();
      var scenarioChosen = !!(sel && sel.scenarioId);
      var branchesLoading = scenarioChosen && !active;

      // 場景清單:依賴 sessionId + tick —— 新開會話/切會話/點寵物都會重拉
      // (已有資料時不閃骨架,靜默換成新的)
      React.useEffect(function () {
        var cancel = false;
        api.listScenarios().then(function (r) {
          if (cancel) return;
          setScenarios((r && r.scenarios) || []);
          setScenarioSource((r && r.source) || null);
        }).catch(function (err) {
          console.error(err);
          if (!cancel) setScenarios([]);
        });
        return function () { cancel = true; };
      }, [sessionId, tick]);

      var scenarioId = sel && sel.scenarioId;
      // 場景詳情:除場景 id 外也跟 session 走
      React.useEffect(function () {
        if (!scenarioId) { setActive(null); setDetailSource(null); return; }
        var cancel = false;
        api.getScenario(scenarioId).then(function (r) {
          if (cancel || !r) return;
          setActive(r.detail || null);
          setDetailSource(r.source || null);
        }).catch(console.error);
        return function () { cancel = true; };
      }, [scenarioId, sessionId, tick]);

      // 把選中(場景/分支/模板)同步給宿主半邊 —— 它會注入每次模型步的 runtime context。
      // 依賴只放"會被注入的那幾個值",避免每次渲染都發一次請求。
      var selectedScenarioId = sel && sel.scenarioId ? sel.scenarioId : null;
      var selectedBranchId = sel && sel.branchId ? sel.branchId : null;
      var selectedTemplateId = sel && sel.templateId ? sel.templateId : null;
      var selectedPreviewUrl = sel && sel.templatePreviewUrl ? sel.templatePreviewUrl : null;
      var detailDescription = active && active.id === selectedScenarioId
        && typeof active.description === "string" ? active.description : null;
      React.useEffect(function () {
        if (!sessionId) return undefined;
        var cancel = false;
        syncSelection({
          sessionId: sessionId,
          selection: selectedScenarioId ? {
            scenarioId: selectedScenarioId,
            scenarioName: (sel && sel.scenarioName) || null,
            scenarioDescription: detailDescription,
            branchId: selectedBranchId,
            branchName: (sel && sel.branchName) || null,
            templateId: selectedTemplateId,
            templateTitle: (sel && sel.templateTitle) || null,
            previewUrl: selectedPreviewUrl,
          } : null,
        }).then(function (r) {
          if (cancel || !r) return;
          setInjectTip(typeof r.tip === "string" && r.tip.length > 0 ? r.tip : null);
        }).catch(function (err) {
          console.warn("[scene-template] selection sync failed:", err);
        });
        return function () { cancel = true; };
      }, [sessionId, selectedScenarioId, selectedBranchId, selectedTemplateId, selectedPreviewUrl, detailDescription]);

      // 選中/切換分支 → 用官方 inputActions.setDraft() 整體取代草稿。
      // composer 是 Lexical 編輯器,直接改 DOM 會被編輯器狀態沖掉。
      var branchId = sel && sel.branchId;
      var activeId = active && active.id;
      React.useEffect(function () {
        if (!branchId || !active) return;
        if (!actions || typeof actions.setDraft !== "function") return;
        var br = active.branches.filter(function (b) { return b.id === branchId; })[0];
        if (br) actions.setDraft(br.preset);
      }, [branchId, activeId]);

      function selectScenario(id) {
        if (sel && sel.scenarioId === id) {
          clearSelection();
        } else {
          var s = scenarios ? scenarios.filter(function (x) { return x.id === id; })[0] : null;
          setSelection({
            scenarioId: id, scenarioName: s && s.name,
            branchId: null, branchName: null,
            templateId: null, templateTitle: null, templatePreviewUrl: null,
          });
        }
      }

      function selectBranch(id) {
        if (!active) return;
        if (sel && sel.branchId === id) {
          setSelection({ ...sel, branchId: null, branchName: null });
        } else {
          var br = active.branches.filter(function (b) { return b.id === id; })[0];
          setSelection({ ...sel, branchId: id, branchName: br && br.name });
        }
      }

      var chosen = scenarioChosen && scenarios
        ? scenarios.filter(function (s) { return s.id === sel.scenarioId; })[0]
        : null;
      var chosenIcon = chosen && chosen.icon ? chosen.icon : "✨";
      var petState = scenarioChosen ? (sel.branchId ? "branch" : "scenario") : "idle";
      // 數據源只放在 hover 提示裡:一眼能確認到底是遠端還是回退 mock,又不佔版面
      var sourceTip = scenarioSource === "remote"
        ? "場景清單：遠端 API（abc.feg.com.tw）"
        : (scenarioSource === "mock" ? "場景清單：mock（遠端 API 失敗，已回退）" : "");

      return e("div", { style: S.panelPet },
        e(ExpertPet, {
          state: petState,
          onClick: function () { emit({ type: "refresh" }); },
          title: "點我重新整理：重新拉一次場景清單與詳情" + (injectTip ? "\n" + injectTip : ""),
        }),
        // 標題欄:只包含"當前場景"那一個徽章 —— 徽章右邊的 ✕ 就是關閉(清空選擇、回到場景清單),
        // 不再單獨放"換場景"按鈕,也不再顯示 "→ 分支名"。
        scenarioChosen && e("div", { style: S.header },
          e("div", { style: S.scenarioBadge },
            e("span", { style: S.scenarioBadgeIcon }, chosenIcon),
            e("span", { style: S.scenarioBadgeText }, sel.scenarioName || "已選場景"),
            e("button", {
              style: S.badgeClose,
              onClick: clearSelection,
              title: "清除場景選擇",
              "aria-label": "清除場景選擇",
            }, "✕"),
          ),
        ),
        // 未選場景:只給場景 chips(載入中給骨架);選中後收合,點徽章上的 ✕ 回到這裡。
        !scenarioChosen && e("div", { style: S.row },
          e("div", {
            key: scenarios === null ? "sk" : "ok",
            className: "st-in",
            ref: scenarioPan.ref,
            "data-st-scroll": "1",
            title: sourceTip,
            style: S.scroller,
            ...scenarioPan.handlers,
          },
            scenarios === null
              ? SKEL_CHIPS.map(function (w, i) {
                  return e("div", { key: "sk" + i, className: "st-skel", style: S.skelChip(true, w) });
                })
              : scenarios.length === 0
                ? e("span", { style: S.empty }, "暫無場景資料")
                : scenarios.map(function (s) {
                    return e("div", {
                      key: s.id,
                      style: S.chip(sel && sel.scenarioId === s.id, undefined, true),
                    onClick: function () { selectScenario(s.id); },
                  }, s.name);
                }),
          ),
        ),
        // 分支 chips(無靜態標籤)。詳情載入中時給骨架。
        active && active.branches && active.branches.length > 0 && e("div", { style: S.row },
          e("div", {
            key: "br-ok",
            className: "st-in",
            ref: branchPan.ref,
            "data-st-scroll": "1",
            title: sourceTipFor("場景詳情", detailSource),
            style: S.scroller,
            ...branchPan.handlers,
          },
            active.branches.map(function (b) {
              return e("div", {
                key: b.id,
                style: S.chip(sel && sel.branchId === b.id, "#7c3aed"),
                onClick: function () { selectBranch(b.id); },
                title: "選中會用該分支的 preset 覆蓋輸入框內容",
              }, b.name + " ↘");
            }),
          ),
        ),
        branchesLoading && e("div", { style: S.row },
          e("div", { key: "br-sk", className: "st-in", style: S.scroller },
            SKEL_BRANCHES.map(function (w, i) {
              return e("div", { key: "brsk" + i, className: "st-skel", style: S.skelChip(false, w) });
            }),
          ),
        ),
      );
    }

    function TemplatePanel(props) {
      var selPair = useSharedSelection();
      var sel = selPair[0];
      var activePair = React.useState(null);
      var active = activePair[0];
      var setActive = activePair[1];
      var detailSourcePair = React.useState(null);
      var detailSource = detailSourcePair[0];
      var setDetailSource = detailSourcePair[1];
      var dynPair = React.useState([]);
      var dynTemplates = dynPair[0];
      var setDynTemplates = dynPair[1];
      var dynLoadingPair = React.useState(false);
      var dynLoading = dynLoadingPair[0];
      var setDynLoading = dynLoadingPair[1];
      var recPair = React.useState([]);
      var recommended = recPair[0];
      var setRecommended = recPair[1];
      var infoPair = React.useState(null);
      var recInfo = infoPair[0];
      var setRecInfo = infoPair[1];
      var recSourcePair = React.useState(null);
      var recSource = recSourcePair[0];
      var setRecSource = recSourcePair[1];
      var loadingPair = React.useState(false);
      var recLoading = loadingPair[0];
      var setRecLoading = loadingPair[1];
      var modalPair = React.useState(null);
      var preview = modalPair[0];
      var setPreview = modalPair[1];
      var loadedPair = React.useState(false);
      var previewLoaded = loadedPair[0];
      var setPreviewLoaded = loadedPair[1];
      var slowPair = React.useState(false);
      var previewSlow = slowPair[0];
      var setPreviewSlow = slowPair[1];
      var recCursor = React.useRef(0);
      var lastScenario = React.useRef(undefined);
      var stripPan = useDragPan();

      var useInputSafe = props && typeof props.useInput === "function"
        ? props.useInput
        : function () { return ""; };
      var draft = useInputSafe(selectDraft);
      var sessionId = props ? props.sessionId : undefined;
      var tick = useRefreshTick();

      var scenarioId = sel && sel.scenarioId;
      var noScenario = !scenarioId;
      React.useEffect(function () {
        if (!scenarioId) { setActive(null); setDetailSource(null); return; }
        var cancel = false;
        api.getScenario(scenarioId).then(function (r) {
          if (cancel || !r) return;
          setActive(r.detail || null);
          setDetailSource(r.source || null);
        }).catch(console.error);
        return function () { cancel = true; };
      }, [scenarioId, sessionId, tick]);

      // 場景切換(含取消選中 → undefined)就丟掉推薦批次,交回該場景自己的模板。
      // 未選場景時 batch 必須為空 —— 推薦是按場景給的。
      React.useEffect(function () {
        if (lastScenario.current === scenarioId) return;
        lastScenario.current = scenarioId;
        setRecommended([]);
        setRecInfo(null);
        setRecSource(null);
      }, [scenarioId]);

      var activeId = active && active.id;
      var hasDynamic = active && active.hasDynamicTemplates;
      var branchId = sel && sel.branchId;
      React.useEffect(function () {
        if (!active || !hasDynamic) { setDynTemplates([]); setDynLoading(false); return; }
        if (draft.length < 20) { setDynTemplates([]); setDynLoading(false); return; }
        var handle = setTimeout(function () {
          setDynLoading(true);
          api.getDynamicTemplates(active.id, draft, branchId).then(function (list) {
            setDynTemplates(list || []);
            var allIds = new Set([].concat(
              (active.templates || []).map(function (t) { return t.id; }),
              (list || []).map(function (t) { return t.id; })
            ));
            if (sel && sel.templateId && !allIds.has(sel.templateId)) {
              setSelection({ ...sel, templateId: null, templateTitle: null, templatePreviewUrl: null });
            }
          }).catch(console.error).then(function () { setDynLoading(false); });
        }, 600);
        return function () { clearTimeout(handle); };
      }, [draft, activeId, branchId, sessionId]);

      function loadRecommend() {
        if (noScenario || !active) return;   // 不選場景/詳情未回來就不拉推薦
        setRecLoading(true);
        Promise.resolve(api.recommend(scenarioId, draft, recCursor.current)).then(function (res) {
          setRecommended(res.templates || []);
          setRecSource(res.source || null);
          if (typeof res.batchIndex === "number") {
            // 回退到本檔案 mock 池子時才有批次號(可以繼續翻批)
            recCursor.current = res.nextCursor || recCursor.current;
            setRecInfo({ batch: res.batchIndex, total: res.total });
          } else {
            setRecInfo(null);   // 遠端的推薦是"一次一批",沒有批次號
          }
        }, function (err) {
          console.error("[scene-template] recommend failed:", err);
        }).then(function () {
          setRecLoading(false);
        });
      }

      function exitRecommend() {
        setRecommended([]);
        setRecInfo(null);
        setRecSource(null);
      }

      var allTemplates = React.useMemo(function () {
        if (noScenario) return [];   // 未選場景:一律不展示任何模板
        if (recommended.length > 0) return recommended;
        if (!active) return [];
        var seen = new Set();
        var out = [];
        [].concat(active.templates || [], dynTemplates || []).forEach(function (t) {
          if (!seen.has(t.id)) { seen.add(t.id); out.push(t); }
        });
        return out;
      }, [noScenario, active, dynTemplates, recommended]);

      var inRecommend = recommended.length > 0;

      function selectTemplate(tpl) {
        // 選中模板時連 previewUrl 一起放進選擇:宿主半邊要用它取"案例內容"注入上下文。
        if (sel && sel.templateId === tpl.id) {
          setSelection({ ...sel, templateId: null, templateTitle: null, templatePreviewUrl: null });
        } else {
          setSelection({ ...sel, templateId: tpl.id, templateTitle: tpl.title, templatePreviewUrl: tpl.previewUrl || null });
        }
      }

      // 預覽直接用模板對象裡 API 給的 previewUrl(遠端是相對路徑,normalize 時已補成絕對);
      // 只有模板沒帶 previewUrl 時才去問 §3.4 接口。
      function openPreview(tpl) {
        setPreviewLoaded(false);
        setPreviewSlow(false);
        if (tpl.previewUrl) {
          setPreview({ url: tpl.previewUrl, title: tpl.title });
          return;
        }
        setPreview({ url: null, title: tpl.title });
        api.getPreview(tpl.id).then(function (r) {
          if (r && r.previewUrl) setPreview({ url: r.previewUrl, title: tpl.title });
        }).catch(function (err) { console.warn("[scene-template] preview failed:", err); });
      }

      function closePreview() {
        setPreview(null);
        setPreviewLoaded(false);
        setPreviewSlow(false);
      }

      var wallLoading = !active || recLoading;

      // 彈窗開著但 iframe 還沒 load 時,2.5s 後提示可能是被後端擋住了嵌入
      React.useEffect(function () {
        if (!preview || !preview.url || previewLoaded) return undefined;
        var handle = setTimeout(function () { setPreviewSlow(true); }, 2500);
        return function () { clearTimeout(handle); };
      }, [preview && preview.url, previewLoaded]);

      var hintText = null;
      if (wallLoading) hintText = "載入中…";
      else if (dynLoading) hintText = "動態模板載入中…";
      else if (allTemplates.length > 0) {
        if (inRecommend) {
          hintText = recInfo
            ? "推薦第 " + recInfo.batch + "/" + recInfo.total + " 批 · 按住拖曳 · 雙擊預覽"
            : "推薦 " + allTemplates.length + " 個 · 按住拖曳 · 雙擊預覽";
        } else {
          hintText = "共 " + allTemplates.length + " 個 · 按住拖曳查看 · 雙擊預覽";
        }
      }

      var emptyText = null;
      if (!wallLoading && allTemplates.length === 0) {
        if (active && active.hasDynamicTemplates) emptyText = "在輸入框輸入 ≥20 字觸發動態模板,或點右上角「✨ 推薦」";
        else emptyText = "該場景暫無模板,可點右上角「✨ 推薦」";
      }

      var panelStyle = props && props.order !== undefined
        ? { ...S.panel, order: props.order }
        : S.panel;

      // 未選場景:第三部分整塊不渲染(模板是按場景推薦的,沒有場景就沒有可展示的內容)。
      if (noScenario) return null;

      return e(React.Fragment, null,
        e("div", { style: panelStyle },
          e("div", { style: S.header },
            e("div", { style: S.headLeft },
              e("span", { style: S.hint }, hintText || ""),
              !inRecommend && !dynLoading && dynTemplates.length > 0 && e("span", { style: { color: "#0284c7", fontSize: 11 } },
                "+" + dynTemplates.length + " 動態"
              ),
            ),
            e("div", { style: S.headRight },
              e("button", {
                style: S.recommendBtn,
                onClick: loadRecommend,
                disabled: recLoading || !active,
                title: "換一批模板(按場景 + 目前輸入問 /scene/suggestion_template)"
                  + (recSource ? "\n" + sourceTipFor("推薦", recSource) : ""),
              }, recLoading ? "重新整理中…" : (inRecommend ? "🔄 換一批" : "✨ 推薦")),
              inRecommend && e("button", { style: S.clearBtn, onClick: exitRecommend }, "返回場景模板"),
              sel && sel.templateId && e("span", { style: S.selectedSummary },
                "已選: " + (sel.templateTitle || "")
              ),
            ),
          ),
          wallLoading
            ? e("div", { key: "wall-sk", className: "st-in", style: S.strip },
                [0, 1, 2].map(function (i) {
                  return e("div", { key: "skp" + i, style: S.skelPoster },
                    e("div", { className: "st-skel", style: S.skelCover }),
                    e("div", { style: S.posterBody },
                      e("div", { className: "st-skel", style: S.skelLine("70%") }),
                      e("div", { className: "st-skel", style: S.skelLine("45%") }),
                    ),
                  );
                }),
              )
            : emptyText
            ? e("div", { key: "wall-empty", className: "st-in", style: { fontSize: 11, color: "#94a3b8", textAlign: "center", padding: "8px 0" } }, emptyText)
            : e("div", {
                    key: "wall-ok",
                    className: "st-in",
                    ref: stripPan.ref,
                    "data-st-scroll": "1",
                    title: inRecommend ? sourceTipFor("推薦", recSource) : sourceTipFor("模板列表", detailSource),
                    style: S.strip,
                    ...stripPan.handlers,
                  },
                    allTemplates.map(function (tpl) {
                      return e("div", {
                        key: tpl.id,
                        style: S.poster(sel && sel.templateId === tpl.id),
                        onClick: function () { selectTemplate(tpl); },
                        onDoubleClick: function () { openPreview(tpl); },
                        title: tpl.title + " · 單擊選擇 / 雙擊預覽",
                      },
                        e("div", { style: S.cover },
                          tpl.thumbnailUrl
                            ? e("img", { src: tpl.thumbnailUrl, alt: tpl.title, style: S.coverImg, draggable: false })
                            : e("div", { style: S.coverIcon }, tpl.icon || "📎"),
                        ),
                        sel && sel.templateId === tpl.id && e("div", { style: S.badge }, "✓"),
                        e("div", { style: S.posterBody },
                          e("div", { style: S.posterTitle }, tpl.title),
                          tpl.subtitle && e("div", { style: S.posterSub }, tpl.subtitle),
                        ),
                      );
                    }),
                  ),
        ),
        preview && e("div", { style: S.previewBackdrop, onClick: closePreview },
          e("div", { style: S.previewModal, onClick: function (ev) { ev.stopPropagation(); } },
            e("div", { style: S.previewHeader },
              e("span", null, "預覽 · " + preview.title),
              e("button", { style: S.previewClose, onClick: closePreview }, "關閉"),
            ),
            e("div", { style: S.previewBody },
              preview.url && e("iframe", {
                src: preview.url,
                style: S.iframe,
                sandbox: "",
                onLoad: function () { setPreviewLoaded(true); },
              }),
              !previewLoaded && e("div", { style: S.previewOverlay },
                e("div", { className: "st-skel", style: S.previewSkel }),
                e("div", { className: "st-skel", style: S.previewSkel }),
                e("span", null, "預覽載入中…"),
                previewSlow && e("span", { style: S.previewHint },
                  "一直空白？可能這個預覽地址還沒回 HTML，或後端不允許 iframe 嵌入（X-Frame-Options / frame-ancestors）。"
                ),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * The hero (brand-new session) template wall, registered as its own dock entry.
     *
     * SlotOutlet's anchor is `display: contents`, so a list slot's entries are laid
     * out by the PARENT — this entry's root element is a direct flex item of
     * `composerStack` (a flex column). `order: 2` therefore sorts it after the
     * composer card (everything else there is order 0), which is exactly where
     * `conversation.composer.dock` would have put it in a normal session.
     *
     * In a normal session this entry renders `null` (no element, no flex item) and the
     * composer-dock copy takes over.
     */
    function HeroTemplateEntry(props) {
      var bottomMounted = useBottomDockFlag();
      var heroLayout = isHeroLayout();
      if (!heroLayout && bottomMounted) return null;
      return e(TemplatePanel, { ...props, order: 2 });
    }

    // 底部 dock 的包裝:標記它已掛載,讓 hero 回退副本收合。
    function BottomTemplatePanel(props) {
      React.useEffect(function () {
        dockState.bottomMounted = true;
        emit({ type: "bottom-dock", payload: true });
        return function () {
          dockState.bottomMounted = false;
          emit({ type: "bottom-dock", payload: false });
        };
      }, []);
      return e(TemplatePanel, props);
    }

    /** Services this client half needs: the slot registry. */
    var inject = ["slots"];

    /**
     * Client plugin body: hide the scrollbars, then contribute the two docks.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(installStyles, "scene-template: scrollbar styles");
      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register(
          { name: "conversation.input.dock", id: "st-top", order: 1 },
          function (props) { return e(TopScenarioPanel, props); }
        );
      });
      // hero 工作階段下的模板牆:獨立 entry,靠自身的 flex order 落到輸入卡片之後。
      ctx.slots.inject("conversation.input.dock", function () {
        return ctx.slots.register(
          { name: "conversation.input.dock", id: "st-top-templates", order: 2 },
          function (props) { return e(HeroTemplateEntry, props); }
        );
      });
      ctx.slots.inject("conversation.composer.dock", function () {
        return ctx.slots.register(
          { name: "conversation.composer.dock", id: "st-bottom", order: 100 },
          function (props) { return e(BottomTemplatePanel, props); }
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
