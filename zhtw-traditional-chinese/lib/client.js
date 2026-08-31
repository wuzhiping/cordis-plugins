// Browser entry for the zhtw-traditional-chinese bundle.
// Registered into the lazy CJS module table that dsh-client-modules scans.
// The factory body is plain JS that closes over the S2T tables; no other
// dynamic plugin id is required at runtime.

window.__ModuleLoader__.load({
  id: "zhtw-traditional-chinese",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    // === S→T phrase table (multi-char, applied before single-char table) ===
    var S2T_PHRASES = [
      ["默认设置","預設設定"], ["开发者","開發者"], ["开发人员","開發人員"],
      ["保存成功","儲存成功"], ["保存失败","儲存失敗"], ["自动保存","自動儲存"],
      ["已保存","已儲存"], ["未保存","未儲存"], ["加载失败","載入失敗"],
      ["加载中","載入中"], ["已加载","已載入"], ["提交成功","送出成功"],
      ["提交失败","送出失敗"], ["操作失败","操作失敗"], ["操作成功","操作成功"],
      ["复制成功","複製成功"], ["复制失败","複製失敗"], ["粘贴失败","貼上失敗"],
      ["删除成功","刪除成功"], ["删除失败","刪除失敗"], ["编辑失败","編輯失敗"],
      ["已连接","已連線"], ["未连接","未連線"], ["连接中","連線中"],
      ["断开连接","中斷連線"], ["重新连接","重新連線"],
      ["已发送","已傳送"], ["发送中","傳送中"], ["发送失败","傳送失敗"],
      ["发送者","寄件者"], ["接收者","收件者"],
      ["打开方式","開啟方式"], ["设置","設定"], ["配置文件","設定檔"],
      ["系统设置","系統設定"], ["用户设置","使用者設定"], ["环境变量","環境變數"],
      ["软件","軟體"], ["硬件","硬體"], ["文件","檔案"], ["文件夹","資料夾"],
      ["网络","網路"], ["联网","連線"], ["程序","程式"], ["进程","行程"],
      ["内存","記憶體"], ["磁盘","磁碟"], ["硬盘","硬碟"], ["打印","列印"],
      ["信息","資訊"], ["消息","訊息"], ["服务器","伺服器"], ["客户端","用戶端"],
      ["数据库","資料庫"], ["字段","欄位"], ["用户","使用者"], ["账户","帳戶"],
      ["登录","登入"], ["注销","登出"], ["界面","介面"], ["菜单","選單"],
      ["按钮","按鈕"], ["字体","字型"], ["鼠标","滑鼠"], ["键盘","鍵盤"],
      ["屏幕","螢幕"], ["视频","影片"], ["音频","音訊"], ["图片","圖片"],
      ["图像","影像"], ["链接","連結"], ["网址","網址"], ["主页","首頁"],
      ["网站","網站"], ["浏览器","瀏覽器"], ["下载","下載"], ["上传","上傳"],
      ["搜索","搜尋"], ["查找","尋找"], ["替换","取代"], ["页面","頁面"],
      ["网页","網頁"], ["书签","書籤"], ["缓存","快取"], ["日志","日誌"],
      ["记录","記錄"], ["通讯录","通訊錄"], ["通讯","通訊"], ["电话","電話"],
      ["短信","簡訊"], ["邮件","郵件"], ["聊天","聊天"], ["对话","對話"],
      ["会话","工作階段"], ["语音","語音"], ["视频通话","視訊通話"],
      ["电话会议","電話會議"], ["文件传输","檔案傳輸"], ["上传文件","上傳檔案"],
      ["下载文件","下載檔案"], ["总览","總覽"], ["概况","概況"], ["概览","總覽"],
      ["步骤","步驟"], ["计划","計畫"], ["任务","任務"], ["草稿","草稿"],
      ["复制","複製"], ["粘贴","貼上"], ["撤销","撤銷"], ["恢复","復原"],
      ["备份","備份"], ["默认","預設"], ["错误","錯誤"], ["失败","失敗"],
      ["成功","成功"], ["开始","開始"], ["结束","結束"], ["取消","取消"],
      ["确定","確定"], ["确认","確認"], ["关闭","關閉"], ["打开","開啟"],
      ["保存","儲存"], ["删除","刪除"], ["编辑","編輯"], ["窗口","視窗"],
      ["视图","檢視"], ["回复","回覆"], ["启用","啟用"], ["禁用","停用"],
      ["未定义","未定義"], ["不支持","不支援"], ["终端","終端機"], ["调用","呼叫"],
      ["返回","返回"], ["前进","前進"], ["刷新","重新整理"], ["更多","更多"],
      ["收起","收合"], ["展开","展開"], ["全选","全選"], ["反选","反選"],
      ["清空","清空"], ["切换","切換"], ["显示","顯示"], ["隐藏","隱藏"],
      ["开启","開啟"], ["锁定","鎖定"], ["解锁","解鎖"], ["拖动","拖曳"],
      ["拖拽","拖曳"], ["滚动","捲動"], ["排序","排序"], ["筛选","篩選"],
      ["过滤","過濾"], ["布局","版面"], ["主题","主題"], ["外观","外觀"],
      ["浅色","淺色"], ["深色","深色"], ["自动","自動"], ["跟随系统","跟隨系統"],
      ["自定义","自訂"], ["未读","未讀"], ["已读","已讀"], ["全部","全部"],
      ["置顶","置頂"], ["取消置顶","取消置頂"], ["公开","公開"], ["共享","共用"],
      ["只读","唯讀"], ["读写","讀寫"], ["管理员","管理員"],
      ["普通用户","一般使用者"], ["游客","訪客"], ["所有者","擁有者"],
      ["是否继续","是否繼續"], ["是否删除","是否刪除"], ["是否保存","是否儲存"],
      ["是否退出","是否離開"]
    ];

    // === S→T single-character table ===
    var S2T_CHARS = {
      "后":"後","发":"發","这":"這","来":"來","个":"個","会":"會","时":"時",
      "没":"沒","让":"讓","为":"為","与":"與","里":"裡","吗":"嗎","说":"說",
      "请":"請","读":"讀","写":"寫","听":"聽","见":"見","觉":"覺","认":"認",
      "识":"識","议":"議","论":"論","计":"計","划":"劃","创":"創","业":"業",
      "务":"務","动":"動","态":"態","体":"體","实":"實","现":"現","进":"進",
      "输":"輸","库":"庫","应":"應","该":"該","过":"過","网":"網","页":"頁",
      "图":"圖","标":"標","记":"記","录":"錄","号":"號","码":"碼","键":"鍵",
      "错":"錯","误":"誤","弹":"彈","帮":"幫","设":"設","编":"編","辑":"輯",
      "删":"刪","复":"復","贴":"貼","隐":"隱","显":"顯","内":"內","并":"並",
      "关":"關","闭":"閉","开":"開","启":"啟","暂":"暫","长":"長","宽":"寬",
      "难":"難","简":"簡","单":"單","繁":"繁","强":"強","减":"減","变":"變",
      "换":"換","转":"轉","导":"導","统":"統","万":"萬","亿":"億","击":"擊",
      "断":"斷","继":"繼","续":"續","连":"連","选":"選","择":"擇","区":"區",
      "块":"塊","颗":"顆","种":"種","样":"樣","条":"條","双":"雙","对":"對",
      "话":"話","语":"語","词":"詞","栏":"欄","档":"檔","张":"張","声":"聲",
      "乐":"樂","剧":"劇","视":"視","频":"頻","桥":"橋","车":"車","飞":"飛",
      "机":"機","陆":"陸","树":"樹","叶":"葉","风":"風","云":"雲","雾":"霧",
      "电":"電","颜":"顏","红":"紅","黄":"黃","蓝":"藍","绿":"綠","银":"銀",
      "铜":"銅","铁":"鐵","头":"頭","脑":"腦","脏":"臟","肿":"腫","脉":"脈",
      "胆":"膽","腊":"臘","脱":"脫","脸":"臉","艺":"藝","节":"節","药":"藥",
      "营":"營","养":"養","卫":"衛","厂":"廠","场":"場","环":"環","墙":"牆",
      "厅":"廳","铺":"鋪","仓":"倉","县":"縣","乡":"鄉","镇":"鎮","庄":"莊",
      "园":"園","楼":"樓","层":"層","队":"隊","员":"員","职":"職","产":"產",
      "质":"質","准":"準","测":"測","试":"試","验":"驗","审":"審","类":"類",
      "别":"別","规":"規","则":"則","战":"戰","争":"爭","胜":"勝","败":"敗",
      "赢":"贏","赛":"賽","运":"運","馆":"館","学":"學","师":"師","奖":"獎",
      "励":"勵","处":"處","罚":"罰","诉":"訴","讼":"訟","决":"決","据":"據",
      "证":"證","料":"料","笔":"筆","枪":"槍","箭":"箭","马":"馬","舰":"艦",
      "轮":"輪","缆":"纜","钢":"鋼","铝":"鋁","锡":"錫","铅":"鉛","塑":"塑",
      "胶":"膠","纺":"紡","织":"織","丝":"絲","绸":"綢","缎":"緞","锦":"錦",
      "绣":"繡","纱":"紗","裤":"褲","袜":"襪","领":"領","带":"帶","瓶":"瓶",
      "碟":"碟","盘":"盤","筷":"筷","锅":"鍋","盖":"蓋","柜":"櫃","灯":"燈",
      "门":"門","锁":"鎖","钥":"鑰","钟":"鐘","龙":"龍","凤":"鳳","龟":"龜",
      "齿":"齒","龄":"齡","众":"眾","币":"幣","泽":"澤","浊":"濁","济":"濟",
      "涂":"塗","涌":"湧","涨":"漲","润":"潤","溃":"潰","滥":"濫","滞":"滯",
      "渗":"滲","潜":"潛","炽":"熾","烫":"燙","烛":"燭","烟":"煙","烦":"煩",
      "热":"熱","焕":"煥","爱":"愛","爷":"爺","牵":"牽","牺":"犧","犹":"猶",
      "狭":"狹","独":"獨","猎":"獵","猫":"貓","献":"獻","猪":"豬","玛":"瑪",
      "画":"畫","畅":"暢","疯":"瘋","症":"症","痪":"瘓","痴":"癡","皱":"皺",
      "盏":"盞","盐":"鹽","监":"監","瞒":"瞞","瞩":"矚","矫":"矯","矾":"礬",
      "碍":"礙","碱":"鹼","签":"籤","箫":"簫","篇":"篇","篱":"籬","紧":"緊",
      "绪":"緒","缠":"纏","绘":"繪","绞":"絞","缔":"締","缕":"縷","缝":"縫",
      "缩":"縮","纵":"縱","纤":"纖","细":"細","终":"終","绕":"繞","结":"結",
      "绝":"絕","络":"絡","绳":"繩","维":"維","综":"綜","缅":"緬","缆":"纜",
      "绿":"綠","缀":"綴","缈":"緲","缓":"緩","缔":"締","缕":"縷","缘":"緣",
      "缚":"縛","缤":"繽","缥":"縹","缦":"縵","缨":"纓","缴":"繳"
    };

    function convertS2T(text) {
      if (typeof text !== "string" || text.length === 0) return text;
      for (var i = 0; i < S2T_PHRASES.length; i++) {
        var pair = S2T_PHRASES[i];
        if (text.indexOf(pair[0]) !== -1) text = text.split(pair[0]).join(pair[1]);
      }
      var result = "";
      for (var j = 0; j < text.length; j++) {
        var ch = text[j];
        result += (S2T_CHARS[ch] !== undefined ? S2T_CHARS[ch] : ch);
      }
      return result;
    }

    // === zh-TW choice persistence ===
    // The framework's `locale.preference` schema only accepts 'zh'/'en', so
    // `host.set('preference', 'zh-TW')` is rejected by the host and the choice
    // is never saved. On restart the async settings mirror then calls adopt(),
    // which re-applies the persisted preference (or the browser language) and
    // overrides the zh-TW forced at plugin boot -- hence the user must re-select
    // Traditional Chinese after every restart. Fix: record the choice in
    // localStorage and re-assert zh-TW after adopt() unless the user explicitly
    // picked zh/en (which the framework itself persists).
    var STORAGE_KEY = "zhtw-traditional-chinese:preference";

    function readStoredChoice() {
      try {
        if (typeof localStorage === "undefined") return null;
        return localStorage.getItem(STORAGE_KEY);
      } catch (e) {
        return null;
      }
    }

    function writeStoredChoice(id) {
      try {
        if (typeof localStorage === "undefined") return;
        localStorage.setItem(STORAGE_KEY, id);
      } catch (e) {}
    }

    // === feg.cn brand replacement (rebrand) ===
    // Pure CSS + copy override, no React dependency:
    // - Sidebar logo row (hHd-Xa_logoRow): hide the DeepSeek fish mark and
    //   wordmark, show the BRAND_NAME text instead.
    // - Hero headline (pXSMma_headline): hide the fish mark, center the title,
    //   override the copy with BRAND_HEADLINE.
    // - document.title / favicon / PWA manifest are rebranded too.
    // NOTE: hHd-Xa_* / pXSMma_* are CSS-module hashes emitted by the DSH build;
    // they can go stale after a DSH upgrade and need to be refreshed.
    var BRAND_NAME = "at-worker harness @AIFE";
    var BRAND_HEADLINE = {
      "zh": "欢迎使用 at-worker harness",
      "zh-TW": "歡迎使用 at-worker harness",
      "en": "Welcome to at-worker harness"
    };
    var BRAND_STRINGS = {
      conversation: { "hero.headline": BRAND_HEADLINE }
    };
    var BRAND_CSS = [
      // Sidebar logo row: hide fish mark / wordmark / collapsed rail fish; show text brand via ::before.
      ".hHd-Xa_logoRow{justify-content:space-between;padding-left:12px}",
      ".hHd-Xa_brandMark{display:none!important}",
      ".hHd-Xa_brandName{display:none!important}",
      ".hHd-Xa_railMark{display:none!important}",
      '.hHd-Xa_brand::before{content:"' + BRAND_NAME + '";font-size:18px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-primary);white-space:nowrap}',
      // Hero headline: hide fish and preview badge, center the title.
      ".pXSMma_headline{grid-template-columns:1fr auto 1fr;justify-content:center}",
      ".pXSMma_fishHitbox{display:none!important}",
      ".pXSMma_headlineText{grid-area:1/2}",
      ".pXSMma_previewBadge{display:none!important}"
    ].join("");
    var BRAND_FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#16324f"/><text x="32" y="45" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="32" font-weight="700" fill="#ffffff">f</text></svg>';

    function applyBranding() {
      if (typeof document === "undefined") return function noop() {};
      var disposers = [];

      // 1) Brand CSS (appended at the end of head so it overrides the framework).
      var tag = document.createElement("style");
      tag.dataset.plugin = "zhtw-traditional-chinese";
      tag.dataset.pluginCss = "zhtw-traditional-chinese/brand.css";
      tag.textContent = BRAND_CSS;
      document.head.appendChild(tag);
      disposers.push(function () { tag.remove(); });

      // 2) document.title: replace "DeepSeek Harness" with BRAND_NAME (follows session-title changes).
      var originalTitle = document.title;
      var rewriteTitle = function () {
        if (document.title.indexOf("DeepSeek Harness") !== -1) {
          document.title = document.title.split("DeepSeek Harness").join(BRAND_NAME);
        } else if (!document.title) {
          document.title = BRAND_NAME;
        }
      };
      rewriteTitle();
      var titleEl = document.querySelector("title");
      if (!titleEl) {
        titleEl = document.createElement("title");
        document.head.appendChild(titleEl);
      }
      var titleObserver = new MutationObserver(rewriteTitle);
      titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
      disposers.push(function () { titleObserver.disconnect(); document.title = originalTitle; });

      // 3) favicon
      var faviconHref = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(BRAND_FAVICON_SVG);
      var faviconLink = document.querySelector('link[rel="icon"]');
      if (!faviconLink) {
        faviconLink = document.createElement("link");
        faviconLink.rel = "icon";
        faviconLink.type = "image/svg+xml";
        document.head.appendChild(faviconLink);
      }
      var previousFavicon = faviconLink.href;
      faviconLink.href = faviconHref;
      disposers.push(function () { faviconLink.href = previousFavicon; });

      // 4) PWA manifest name
      var manifestLink = document.querySelector('link[rel="manifest"]');
      if (manifestLink) {
        try {
          var manifestUrl = URL.createObjectURL(new Blob([
            JSON.stringify({ name: BRAND_NAME, short_name: BRAND_NAME, start_url: "/", display: "standalone" })
          ], { type: "application/manifest+json" }));
          var previousManifest = manifestLink.href;
          manifestLink.href = manifestUrl;
          disposers.push(function () { manifestLink.href = previousManifest; URL.revokeObjectURL(manifestUrl); });
        } catch (e) {}
      }

      return function restoreBranding() {
        for (var i = disposers.length - 1; i >= 0; i--) {
          try { disposers[i](); } catch (e) {}
        }
      };
    }

    return {
      inject: ["locale"],
      apply: function (ctx) {
        var locale = ctx.locale;
        ctx.effect(function () {
          var disposers = [];

          function safeRegister(ns, dicts) {
            try {
              disposers.push(locale.register(ns, dicts));
            } catch (e) {
              var msg = e && e.message ? e.message : String(e);
              if (!/already has locale/.test(msg)) throw e;
            }
          }

          var originalPublish = locale.publish.bind(locale);
          locale.publish = function patchedPublish(active, localeChanged) {
            var baseLocales = this.snapshot.locales;
            var hasZhTW = baseLocales.some(function (l) { return l.id === "zh-TW"; });
            var newLocales = hasZhTW
              ? baseLocales
              : Object.freeze([].concat(baseLocales, [{ id: "zh-TW", label: "繁體中文" }]));
            this.snapshot = Object.freeze({
              active: active,
              locales: newLocales,
              revision: this.snapshot.revision + 1
            });
            if (localeChanged) this.ctx.emit("locale/change", this.snapshot);
            for (var i = 0; i < this.listeners.length; i++) {
              try { this.listeners[i](); } catch (error) { console.error("locale subscriber crashed:", error); }
            }
          };

          var originalSetLocale = locale.setLocale.bind(locale);
          locale.setLocale = function patchedSetLocale(id) {
            if (id === "zh-TW") {
              writeStoredChoice("zh-TW");
              // Clear any stale zh/en preference so adopt() cannot flip back
              // to Simplified on the next restart.
              try { this.host && this.host.unset && this.host.unset("preference"); } catch (e) {}
              this.publish("zh-TW", this.snapshot.active !== "zh-TW");
              return;
            }
            writeStoredChoice(id);
            return originalSetLocale(id);
          };

          var originalLookup = locale.lookup.bind(locale);
          locale.lookup = function patchedLookup(ns, key) {
            // Brand copy override (hero.headline etc.) wins over the dictionary chain.
            var custom = BRAND_STRINGS[ns] && BRAND_STRINGS[ns][key];
            if (custom) {
              var active = this.snapshot.active;
              if (custom[active] !== undefined) return custom[active];
              if (active === "zh-TW" && custom["zh"] !== undefined) return convertS2T(custom["zh"]);
              if (custom["en"] !== undefined) return custom["en"];
            }
            var locales = this.dicts.get(ns);
            if (!locales) return undefined;
            var active = this.snapshot.active;
            var activeVal = locales.get(active) && locales.get(active)[key];
            if (activeVal !== undefined) return activeVal;
            if (active === "zh-TW") {
              var zhMap = locales.get("zh");
              if (zhMap) {
                var zhVal = zhMap[key];
                if (zhVal !== undefined) return convertS2T(zhVal);
              }
            }
            var enMap = locales.get("en");
            if (enMap) {
              var enVal = enMap[key];
              if (enVal !== undefined) return enVal;
            }
            return undefined;
          };

          // Patch adopt: the settings mirror arrives asynchronously and adopt()
          // re-applies the persisted preference (or browser language) on top of
          // the zh-TW forced at boot. Re-assert zh-TW afterwards, unless the
          // user explicitly chose zh/en (the framework persists those itself).
          var originalAdopt = locale.adopt.bind(locale);
          locale.adopt = function patchedAdopt(host) {
            originalAdopt(host);
            var value = host.getSnapshot().value;
            var preference = value && value.preference;
            var stored = readStoredChoice();
            var wantsZhTW = stored === "zh-TW" ||
              (stored === null && preference !== "zh" && preference !== "en");
            if (wantsZhTW && this.snapshot.active !== "zh-TW") {
              this.publish("zh-TW", true);
            }
          };

          safeRegister("common", {
            "zh-TW": {
              "ok": "確定", "cancel": "取消", "close": "關閉", "copy": "複製",
              "copied": "已複製", "retry": "重試", "loading": "載入中…",
              "load.failed": "載入失敗", "submit": "提交", "submitting": "正在提交…",
              "next": "下一步", "previous": "上一步", "skip": "跳過",
              "delete": "刪除", "edit": "編輯", "save": "儲存", "search": "搜尋",
              "more": "更多", "collapse": "收合", "expand": "展開", "back": "返回",
              "unknown": "未知", "none": "無", "truncated": "已截斷"
            }
          });
          safeRegister("settings.locale", {
            "zh-TW": { "language.title": "語言" }
          });

          // feg.cn brand replacement (CSS / title / favicon / manifest).
          disposers.push(applyBranding());

          // Startup default: enter Traditional Chinese when no choice was
          // recorded yet (or zh-TW was chosen); leave zh/en users alone so the
          // async adopt() applies their persisted preference without a zh-TW flash.
          var stored = readStoredChoice();
          if (stored !== "zh" && stored !== "en") {
            locale.publish("zh-TW", locale.snapshot.active !== "zh-TW");
          }

          return function restore() {
            locale.setLocale = originalSetLocale;
            locale.publish = originalPublish;
            locale.lookup = originalLookup;
            locale.adopt = originalAdopt;
            for (var k = 0; k < disposers.length; k++) {
              try { disposers[k](); } catch (e) {}
            }
          };
        });
      }
    };
  }
});
