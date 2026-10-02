// =============================================================================
// 團隊協同 · ntfy-teams —— 浏览器半边（lib/client.js）
//
// 三个座位（与 cute-clock / today-material-panel 同一套规矩）：
//   1. sidebar.panellist  —— 左栏图示 🔔，点一下切换到本面板
//   2. main (keyed)       —— panelId = 'ntfy-teams' 的中央面板
//   3. （样式）           —— 一支 <style data-plugin="ntfy-teams">，卸载时移除
//
// 載入模型：本档是一支 classic script，整个档只注册「一个」factory，id 必须等于
// 套件名 'ntfy-teams'；factory 本体在 materialize 时才执行，所以副作用都要放进
// factory 里（或 ctx.effect 里），不可在 script 执行期发生。
//
// ★ 为什么协议层是「内嵌」的，而不是隔壁一个 core.js：
//
//   dsh-client-modules 只把一个 client 档案送上浏览器 —— 它解析
//   package.json 的 exports["./client"]，就这一个路径；`dsh.client` 没有
//   「额外档案」这种欄位，第三方档案也不会被组合进 combo script。
//   于是隔壁的 lib/core.js 从来不会被执行（实测：直接 GET
//   /plugins/ntfy-teams/core.js → 404，served bundle 里找不到 core 的程式码）。
//
//   所以 build.js 把 lib/core.js 的全部内容内嵌到下面的 @@CORE_BEGIN@@ 标记之后，
//   lib/client.js 因此是**自足**的。原始码请改 lib/core.js + 本档的标记区块，
//   再跑一次 `node build.js` 重新产出；直接手改 lib/client.js 会被下次建置覆盖。
//
//   历史教训（都实测过）：档案顺序不可依赖，因为 combo script 会把每个档案包成
//   lazy body；只有「同一个档案」才能保证「先注册、后 materialize」。
//
// 样式规则：只用 --dsw-alias-* / --dsw-specific-* 主題令牌，不写死颜色
// （SVG 图稿例外）；类名一律 ntfy-teams- 前缀。
// =============================================================================

window.__ModuleLoader__.load({
  id: 'ntfy-teams',
  factory: function (require) {
    'use strict';

    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');
    var e = React.createElement;

    // =====================================================================
    // 协议层（lib/core.js）就地内嵌 —— 理由见档案开头。
    // build.js 会把 lib/core.js 的全部内容插到 @@CORE_BEGIN@@ 与 @@CORE_END@@ 之间。
    // 协议层（lib/core.js）就地内嵌 —— 理由见档案开头。
    // build.js 会把 lib/core.js 的全部内容插到 @@CORE_BEGIN@@ 与 @@CORE_END@@ 之间，
    // 并在区块内定义好 `root`（globalThis）与 `core`（协议层 API）两个变数。
    // @@CORE_BEGIN@@
// ===== inlined from lib/core.js（由 build.js 产生，请勿手改；原始码在 lib/core.js）===== */
    // 先把 root 定好：下面是内嵌区块，它会用到 root。
    var root = typeof globalThis !== 'undefined' ? globalThis : this;
    /* =============================================================================
     * 团队协同 · ntfy-teams —— 协议层（core）
     *
     * 这个文件是「浏览器 classic script」与「Node CommonJS 模块」的双形态实现：
     *
     *   (function (root) { ... })(globalThis)
     *
     *   - 作为 <script> 被注入 DSH 页面时：把 API 挂到 globalThis.__ntfyTeamsCore；
     *   - 被 Node require() 时：走 module.exports。
     *
     * 为什么不是 DSH 客户端模块（不调用 __ModuleLoader__.load、不声明 dsh.client.files）：
     *   DSH 的客户端加载器对「它服务的每一个文件」都要求恰好注册一个 factory，且把
     *   “loaded without registering <id>” 视为错误。core.js 是纯逻辑库、不注册任何 UI 座位，
     *   所以它必须是普通脚本，由 lib/client.js 用 require('ntfy-teams:core') 引入
     *   （执行顺序：先 core.js，再 client.js）。
     *
     * 约束（契约）：
     *   - 无构建步骤、无 import/require、零依赖；
     *   - 只用 fetch / TextDecoder / AbortController / BigInt（DSH 页面与 Node 24 都有）；
     *   - 导出的 async 函数永不抛异常，失败一律返回 {ok:false,...} / {messages:[],error} 形状；
     *   - localStorage 一律特性探测 + try/catch（Node 测试里不存在）；
     *   - 加载期只定义 API 与默认值，不读 document、不写 localStorage。
     * ========================================================================== */
    (function (root) {
      'use strict';

      /* ------------------------------------------------------------------ 常量 */

      /** 默认 ntfy 服务器；与 lib/index.js 的 DEFAULT_SERVER 保持一致。 */
      var DEFAULT_SERVER = 'https://msn.feg.cn';

      /** 默认配置（readConfig() 会在此之上叠加 localStorage 里的覆盖值）。 */
      var CONFIG = {
        server: DEFAULT_SERVER,
        topics: [],
        historyLimit: 300,
        identity: '', // 发送者显示名称（群聊约定：ntfy title 形如 '@shawoo'）
        // 右側面板（看板佔位）的寬度。
        // 最小值 = 使用者要求「不少於 300px」；上限 = 1300 是為了不讓訊息串
        // 擠到看不見（面板本身寬度有限，實際還會再依可用寬度夾一次）。
        //
        // 預設值必須 >= 最小值，否則「全新的使用者」一開就違反自己的下限
        // （實測：預設 260 + 最小值 280 就是這種自相矛盾，測試會直接抓到）。
        dashboardWidth: 360,
        dashboardMinWidth: 300,
        dashboardMaxWidth: 1300,
        // 每個主題的「自動回應」設定（見 normalizeAutoApprove 的說明）。
        autoApprove: {},
        // 每個主題的「永遠滾到最新」開關（見 normalizeStayAtBottom 的說明）。
        stayAtBottom: {}
      };

      /** 支持的鉴权模式。 */
      var AUTH_MODES = ['none', 'basic', 'token'];

      /** 消息来源标记，供 store.addMessages 的 unread 判定与 UI 展示使用。 */
      var SOURCE = {
        HISTORY: 'history', // 从 /json 历史接口拉到的
        SSE: 'sse',         // SSE 实时推送到的
        LOCAL: 'local',     // 本机自己发出的
        SERVER: 'server'    // 来源未知（parseServerMessage 的默认值）
      };

      // ---- 自動回應（/approve session → /approve）----

      /** 觸發自動回應的字串（訊息內**包含**它就算）。 */
      var AUTO_APPROVE_TRIGGER = '/approve session';

      /**
       * 自動回應還要求訊息帶有這個 tag。
       *
       * 為什麼要有這個限制：`/approve session` 是可以被任何人打出來的普通字串，
       * 只看內文的話，任何人在這個主題裡打出那句話都會觸發自動回覆。
       * 加上 tag 等於要求「這是 Hermes agent 產生的請求」，把觸發面縮到
       * 我們真的想自動處理的來源。
       *
       * 比對方式：tag 逐個 trim + 轉小寫後比對（ntfy 的 tag 不分大小寫慣例，
       * 而且從 HTTP 標頭讀進來的可能帶空白）。
       */
      var AUTO_APPROVE_TAG = 'hermes-agent';

      /** 自動回應要送出的內容。 */
      var AUTO_APPROVE_REPLY = '/approve';

      /** `ids` 最多保留幾筆（見 normalizeAutoApprove）。 */
      var AUTOAPPROVE_MAX_IDS = 50;

      /**
       * 訊息是否帶有某個 tag（不分大小寫、忽略前後空白）。
       *
       * @param msg - 正規化訊息。
       * @param want - 要找的 tag。
       * @returns 是否帶有。
       */
      function hasTag(msg, want) {
        if (!msg || !Array.isArray(msg.tags) || msg.tags.length === 0) return false;
        var target = String(want).trim().toLowerCase();
        if (target === '') return false;
        for (var i = 0; i < msg.tags.length; i += 1) {
          var t = msg.tags[i];
          if (t === null || t === undefined) continue;
          if (String(t).trim().toLowerCase() === target) return true;
        }
        return false;
      }

      /**
       * 判斷一則訊息是否應該觸發自動回應，以及該回什麼。
       *
       * 這裡刻意做成**純函式**（不碰網路、不改狀態），所以可以離線測試 ——
       * 這個功能一旦誤觸發或重複觸發，代價是「往群組裡灌訊息」。
       *
       * 一律**不回應自己發的訊息**：否則自己送出的內容只要含觸發字串就會無限循環
       * （我回了一則 → 又被判定為觸發 → 再回一則…）。
       *
       * @param opts - { msg, source, topic, selfName, autoApprove }。
       * @returns { reply: string } 或 null。
       */
      function autoApproveDecision(opts) {
        var o = opts || {};
        var topic = normalizeTopic(o.topic);
        if (!topic) return null;
        var settings = o.autoApprove && typeof o.autoApprove === 'object' ? o.autoApprove : {};
        var entry = settings[topic];
        if (!entry || entry.on !== true) return null;
        // 只有「即時推送」才觸發。歷史載入不算 —— 否則面板一開就把舊訊息
        // 全部回一遍（那些訊息可能好幾天前就在那裡了）。
        if (o.source !== SOURCE.SSE) return null;
        var msg = o.msg;
        if (!msg || typeof msg !== 'object') return null;
        var body = typeof msg.message === 'string' ? msg.message : '';
        if (body.indexOf(AUTO_APPROVE_TRIGGER) === -1) return null;
        // 必須帶有指定的 tag（見 AUTO_APPROVE_TAG 的說明）。
        if (!hasTag(msg, AUTO_APPROVE_TAG)) return null;
        // 自己發的不回應（防無限循環）。
        var self = normalizeIdentity(o.selfName);
        if (self === '') return null;
        var parsed = parseIdentity(msg.title);
        if (parsed.isMention && parsed.handle !== ''
          && parsed.handle.toLowerCase() === self.toLowerCase()) {
          return null;
        }
        // 同一則只回一次（`ids` 跨重新整理存活）。
        var id = msg.id === null || msg.id === undefined ? '' : String(msg.id);
        if (id !== '' && Array.isArray(entry.ids) && entry.ids.indexOf(id) !== -1) return null;
        return { reply: AUTO_APPROVE_REPLY, id: id };
      }

      var CONFIG_KEY = 'ntfy-teams:config:v1';

      var CRED_PREFIX = 'ntfy-teams:cred:';

      /** decodeId 的合理时间窗（2000-01-01 ~ 2100-01-01），窗口外视为“不是时间 ID”。 */
      var MIN_PLAUSIBLE_TIME = 946684800;
      var MAX_PLAUSIBLE_TIME = 4102444800;

      /** 标准 base64 字母表（Basic 认证必须用它，不能用 URL-safe 变体）。 */
      var B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      /** URL-safe base64 字母表（ntfy 的 ID、SSE id 字段用它）。 */
      var B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

      function noop() {}

      /* -------------------------------------------------------------- 基础工具 */

      /** 把任意值转成有限数字；转不出来返回 null（区别于 0）。 */
      function toFiniteNumber(value) {
        if (typeof value === 'number') return isFinite(value) ? value : null;
        if (typeof value === 'string') {
          var trimmed = value.trim();
          if (!trimmed) return null;
          var parsed = Number(trimmed);
          return isFinite(parsed) ? parsed : null;
        }
        return null;
      }

      /** 截断长文本，避免把整个响应体塞进错误信息里。 */
      function truncate(text, max) {
        var s = String(text === null || text === undefined ? '' : text);
        return s.length > max ? s.slice(0, max) + '…' : s;
      }

      /** 统一的异常→文本转换（fetch 抛出的通常是 TypeError / DOMException）。 */
      function errorMessage(error) {
        if (!error) return '未知錯誤';
        if (typeof error === 'string') return error;
        if (error.name && error.message) return error.name + ': ' + error.message;
        if (error.message) return String(error.message);
        return String(error);
      }

      function httpErrorText(status, body) {
        var text = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : '';
        return 'HTTP ' + status + (text ? ' · ' + truncate(text, 240) : '');
      }

      /** 安全版 encodeURIComponent：畸形代理对会让 encodeURIComponent 抛错。 */
      function safeEncodeURIComponent(value) {
        var s = value === null || value === undefined ? '' : String(value);
        try {
          return encodeURIComponent(s);
        } catch (e) {
          return s.replace(/[^A-Za-z0-9_.~-]/g, function (ch) {
            return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
          });
        }
      }

      /* ------------------------------------------------- 記憶體內的設定儲存 */

      /**
       * 設定與憑證的**記憶體**儲存。
       *
       * 為什麼不再是 localStorage：這個外掛刻意**不使用 localStorage**。
       * 持久層只有一個 —— 宿主那一側的 `config.yml` / `secrets.yml`。
       * 瀏覽器這一側只需要記住「這次開啟期間」的值：
       *
       *   * 開機時 `syncSettingsFromHost()` 從 YAML 讀進來；
       *   * 使用者的變更透過 `pushSettingsToHost()` 寫回 YAML；
       *   * 記憶體這一份只是「現在的狀態」，重新整理就重建。
       *
       * 這樣就沒有「兩個真相」的問題 —— 之前好幾個 bug（刪掉的主題又出現、
       * 重新整理後設定被舊值蓋掉）都源自瀏覽器與 YAML 各記一份。
       */
      var memoryStore = {};

      function storageGet(key) {
        return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null;
      }

      function storageSet(key, value) {
        memoryStore[key] = String(value);
        return true;
      }

      function storageRemove(key) {
        delete memoryStore[key];
        return true;
      }

      function readJson(key, fallback) {
        var raw = storageGet(key);
        if (!raw) return fallback;
        try {
          var parsed = JSON.parse(raw);
          return parsed === null || parsed === undefined ? fallback : parsed;
        } catch (e) {
          return fallback;
        }
      }

      function writeJson(key, value) {
        try {
          return storageSet(key, JSON.stringify(value));
        } catch (e) {
          return false;
        }
      }

      /**
       * 凭据的记忆体快取（key = credentialKey()）。
       *
       * 为什么需要它：凭据的来源现在有两个 —— localStorage（旧路径）与宿主 YAML
       * （持久层）。多一层快取让「从 YAML 载入」不必先把密码写回 localStorage
       * （那会多一处会不一致的地方，也让 YAML 不再是唯一真相）。
       */
      var credentialCache = {};

      /* -------------------------------------------------------------- base64 */

      var B64_URL_LOOKUP = (function () {
        var map = {};
        for (var i = 0; i < B64_URL.length; i++) map[B64_URL.charAt(i)] = i;
        return map;
      })();

      /**
       * URL-safe base64 解码为字节数组。
       * 不依赖 atob / Buffer，保证浏览器与 Node 行为一致；非法输入返回 null。
       */
      function base64UrlDecodeBytes(input) {
        if (typeof input !== 'string') return null;
        var s = input.replace(/\s+/g, '').replace(/=+$/, '');
        if (!s || s.length % 4 === 1) return null;
        var out = [];
        var buffer = 0;
        var bits = 0;
        for (var i = 0; i < s.length; i++) {
          var ch = s.charAt(i);
          if (ch === '+') ch = '-'; // 容忍标准 base64 的等价字符
          if (ch === '/') ch = '_';
          var value = Object.prototype.hasOwnProperty.call(B64_URL_LOOKUP, ch) ? B64_URL_LOOKUP[ch] : -1;
          if (value < 0) return null;
          buffer = (buffer << 6) | value;
          bits += 6;
          if (bits >= 8) {
            bits -= 8;
            out.push((buffer >> bits) & 0xff);
          }
        }
        return out;
      }

      /**
       * UTF-8 编码为字节数组（TextEncoder 缺失时的兜底实现）。
       */
      function utf8Bytes(text) {
        var str = String(text);
        if (typeof TextEncoder !== 'undefined') {
          try {
            return new TextEncoder().encode(str);
          } catch (e) {
            /* 落到手写实现 */
          }
        }
        var out = [];
        for (var i = 0; i < str.length; i++) {
          var code = str.charCodeAt(i);
          if (code < 0x80) {
            out.push(code);
          } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
          } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            var next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
              var point = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
              out.push(
                0xf0 | (point >> 18),
                0x80 | ((point >> 12) & 63),
                0x80 | ((point >> 6) & 63),
                0x80 | (point & 63)
              );
              i++;
            } else {
              out.push(0xef, 0xbf, 0xbd); // 孤立高位代理 → U+FFFD
            }
          } else if (code >= 0xdc00 && code <= 0xdfff) {
            out.push(0xef, 0xbf, 0xbd); // 孤立低位代理 → U+FFFD
          } else {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
          }
        }
        return out;
      }

      /** 字节数组 → base64 字符串（默认标准字母表，Basic 认证需要）。 */
      function base64EncodeBytes(bytes, alphabet) {
        var table = alphabet || B64_STD;
        var out = '';
        for (var i = 0; i < bytes.length; i += 3) {
          var b0 = bytes[i];
          var b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
          var b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
          var n = (b0 << 16) | (b1 << 8) | b2;
          out += table.charAt((n >> 18) & 63);
          out += table.charAt((n >> 12) & 63);
          out += i + 1 < bytes.length ? table.charAt((n >> 6) & 63) : '=';
          out += i + 2 < bytes.length ? table.charAt(n & 63) : '=';
        }
        return out;
      }

      /** UTF-8 文本 → 标准 base64（Basic 认证用；Node 走 Buffer，浏览器走手写实现）。 */
      function base64EncodeUtf8(text) {
        var str = String(text);
        if (typeof Buffer !== 'undefined' && Buffer && typeof Buffer.from === 'function') {
          try {
            return Buffer.from(str, 'utf8').toString('base64');
          } catch (e) {
            /* 落到手写实现 */
          }
        }
        return base64EncodeBytes(utf8Bytes(str), B64_STD);
      }

      /* ---------------------------------------------------------- 配置 / 凭据 */

      /** 主题名：去掉首尾空白；非法输入归一为空串。 */
      function normalizeTopic(topic) {
        if (topic === null || topic === undefined) return '';
        return String(topic).trim();
      }

      /** 主题列表：归一化、去空、去重（保持原顺序）。 */
      function normalizeTopicList(list) {
        var out = [];
        if (!Array.isArray(list)) return out;
        for (var i = 0; i < list.length; i++) {
          var topic = normalizeTopic(list[i]);
          if (topic && out.indexOf(topic) === -1) out.push(topic);
        }
        return out;
      }

      /**
       * 别名：去空白；非字串或空白 → 空串（代表「用主题名」）。
       * @param value - 任何输入。
       * @returns 别名字串，或 ''。
       */
      function normalizeAlias(value) {
        if (typeof value !== 'string') return '';
        return value.trim();
      }

      /**
       * 主题别名表：{ 主题名: 别名 }。
       *
       * 规则：主题名去空白；别名去空白，**空别名一律丢掉**（也就是「空 = 用主题名」，
       * 不需要另外存一个空字串代表「没别名」）。非字串别名会被忽略。
       * @param value - 任何输入。
       * @returns 干净的别名表（新对象）。
       */
      function normalizeTopicAliases(value) {
        var out = {};
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return out;
        var keys = Object.keys(value);
        for (var i = 0; i < keys.length; i += 1) {
          var topic = normalizeTopic(keys[i]);
          if (!topic) continue;
          var alias = normalizeAlias(value[keys[i]]);
          if (alias) out[topic] = alias;
        }
        return out;
      }

      /** 服务器地址：去空白、无 scheme 补 https://、去掉结尾斜杠。 */
      function normalizeServer(value) {
        var v = typeof value === 'string' ? value.trim() : '';
        if (!v) return '';
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v)) {
          /* 已有 scheme，保留 */
        } else if (v.indexOf('//') === 0) {
          v = 'https:' + v;
        } else {
          v = 'https://' + v;
        }
        v = v.replace(/\/+$/, '');
        // 'https://' 这种只剩 scheme 的输入归一为空串，避免拼出 'https:///topic'
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:$/.test(v)) return '';
        return v;
      }

      /**
       * 读取配置：默认值 + localStorage 覆盖值。
       * 每次返回新对象，调用方随意改；要持久化请用 saveConfig()。
       */
      function readConfig() {
        var out = {
          server: DEFAULT_SERVER,
          topics: [],
          historyLimit: CONFIG.historyLimit,
          identity: '',
          aliases: {},
          // 右側看板（目前是佔位）的寬度。使用者拖過就記住，下次開還是他拉的那個寬度。
          dashboardWidth: CONFIG.dashboardWidth,
          // 「預設主題已經加過一次」的記號。
          //
          // 為什麼需要它：預設主題（pub_dsh）是「加一次」的東西，不是「永遠存在」的東西。
          // 沒有這個記號時只能用「清單裡有沒有它」判斷，於是使用者把它刪掉之後，
          // 下一次載入又會被當成「還沒加過」而補回來 —— 就是「刪掉又重新整理又出現」。
          // 有了記號才能分辨：**從未加過** vs **使用者刪掉了**。
          defaultTopicAdded: false
        };
        var persisted = readJson(CONFIG_KEY, null);
        if (persisted && typeof persisted === 'object') {
          if (typeof persisted.server === 'string') {
            out.server = normalizeServer(persisted.server) || DEFAULT_SERVER;
          }
          if (Array.isArray(persisted.topics)) {
            out.topics = normalizeTopicList(persisted.topics);
          }
          var limit = toFiniteNumber(persisted.historyLimit);
          if (limit !== null && limit > 0) out.historyLimit = Math.floor(limit);
          if (typeof persisted.identity === 'string') out.identity = normalizeIdentity(persisted.identity);
          if (persisted.aliases !== undefined) out.aliases = normalizeTopicAliases(persisted.aliases);
          out.dashboardWidth = clampDashboardWidth(persisted.dashboardWidth, out.dashboardWidth);
          if (persisted.autoApprove !== undefined) out.autoApprove = normalizeAutoApprove(persisted.autoApprove);
          if (persisted.stayAtBottom !== undefined) out.stayAtBottom = normalizeStayAtBottom(persisted.stayAtBottom);
          if (persisted.defaultTopicAdded === true) out.defaultTopicAdded = true;
        }
        return out;
      }

      /**
       * 把「每個主題一份、內容是 { on, ids }」的設定正規化。
       *
       * 抽成共用的是刻意的：自動回應與「永遠滾到最新」是同一個形狀
       * （`{ 主題: { on, ids } }`）。這種「同一份邏輯有兩份實作」的地方
       * 正是本專案最容易出錯的來源（見 HANDOFF §3.B／§3.L），所以只留一份。
       *
       * @param value - 任何輸入。
       * @param maxIds - ids 最多保留幾筆（0 = 不保留 ids）。
       * @returns 正規化後的設定物件。
       */
      function normalizeTopicToggleMap(value, maxIds) {
        var out = {};
        if (!value || typeof value !== 'object') return out;
        Object.keys(value).forEach(function (topic) {
          var name = normalizeTopic(topic);
          if (!name) return;
          var entry = value[topic];
          if (!entry || typeof entry !== 'object') return;
          var ids = Array.isArray(entry.ids) ? entry.ids : [];
          var cleaned = [];
          for (var i = 0; i < ids.length; i += 1) {
            var id = ids[i];
            if (id === null || id === undefined || id === '') continue;
            var s = String(id);
            if (cleaned.indexOf(s) === -1) cleaned.push(s);
          }
          if (maxIds > 0 && cleaned.length > maxIds) {
            cleaned = cleaned.slice(cleaned.length - maxIds);
          }
          if (maxIds <= 0) cleaned = [];
          out[name] = { on: entry.on === true, ids: cleaned };
        });
        return out;
      }

      /**
       * 自動回應設定（每個主題一份）：`{ [topic]: { on: boolean, ids: string[] } }`。
       *
       * 這個設定住在 `config.yml` 而不是瀏覽器 —— 它是**行為設定**，
       * 而且 `ids`（已經回過哪些訊息）必須跨重新整理存活，否則每次重載都可能重複回覆。
       *
       * `ids` 只留最近 N 筆：目的是「不要對同一則回兩次」，不是完整歷史。
       * 留太多會讓 config.yml 膨脹，而且舊訊息本來也不會再被判定為新訊息
       * （只有 `sse` 來源才觸發）。
       *
       * @param value - 任何輸入。
       * @returns 正規化後的設定物件。
       */
      function normalizeAutoApprove(value) {
        return normalizeTopicToggleMap(value, AUTOAPPROVE_MAX_IDS);
      }

      /**
       * 「永遠滾到最新」設定：`{ [topic]: { on: boolean, ids: [] } }`。
       *
       * 形狀跟自動回應一樣只是為了共用正規化；`ids` 對它沒有意義（它不需要去重），
       * 所以一律收成空陣列。
       *
       * @param value - 任何輸入。
       * @returns 正規化後的設定物件。
       */
      function normalizeStayAtBottom(value) {
        return normalizeTopicToggleMap(value, 0);
      }

      /**
       * 看板寬度：夾在 [最小值, 最大值] 之間；不是有限數字就回退。
       * 上限存在的理由是「不能把訊息串擠到看不見」——視窗變小的時候尤其明顯。
       * @param value - 任何輸入。
       * @param fallback - 回退值。
       * @returns 合法的寬度（整數 px）。
       */  function clampDashboardWidth(value, fallback) {
        var n = toFiniteNumber(value);
        var base = toFiniteNumber(fallback);
        if (base === null) base = CONFIG.dashboardWidth;
        if (n === null) return Math.round(base);
        if (n < CONFIG.dashboardMinWidth) return CONFIG.dashboardMinWidth;
        if (n > CONFIG.dashboardMaxWidth) return CONFIG.dashboardMaxWidth;
        return Math.round(n);
      }

      /**
       * 開啟／關閉某個主題的自動回應。
       *
       * 關掉時**保留** `ids`：使用者可能只是暫時關掉，回來時不該把已經回過的
       * 訊息再回一遍。要清掉就整張表覆蓋（`saveConfig({ autoApprove: {} })`）。
       *
       * @param topic - 主題名。
       * @param on - 是否開啟。
       * @returns 更新後的該主題設定。
       */
      function setAutoApprove(topic, on) {
        var name = normalizeTopic(topic);
        if (!name) return null;
        var current = normalizeAutoApprove(readConfig().autoApprove);
        var entry = current[name] || { on: false, ids: [] };
        entry.on = on === true;
        current[name] = entry;
        saveConfig({ autoApprove: current });
        return entry;
      }

      /**
       * 記下「這一則觸發訊息已經回過了」。
       *
       * 一定要在**送出成功之後**才呼叫：先記再送的話，送出失敗就永遠不會重試。
       *
       * @param topic - 主題名。
       * @param id - 觸發訊息的 id。
       * @returns 是否真的記下了。
       */
      function markAutoApproveReplied(topic, id) {
        var name = normalizeTopic(topic);
        var key = id === null || id === undefined ? '' : String(id);
        if (!name || key === '') return false;
        var current = normalizeAutoApprove(readConfig().autoApprove);
        var entry = current[name] || { on: false, ids: [] };
        if (entry.ids.indexOf(key) !== -1) return false;
        entry.ids.push(key);
        current[name] = entry;
        saveConfig({ autoApprove: current });
        return true;
      }

      /**
       * 開啟／關閉某個主題的「永遠滾到最新」。
       *
       * @param topic - 主題名。
       * @param on - 是否開啟。
       * @returns 更新後的該主題設定。
       */
      function setStayAtBottom(topic, on) {
        var name = normalizeTopic(topic);
        if (!name) return null;
        var current = normalizeStayAtBottom(readConfig().stayAtBottom);
        current[name] = { on: on === true, ids: [] };
        saveConfig({ stayAtBottom: current });
        return current[name];
      }

      /** 合并写入配置（部分字段即可），返回写入后的完整配置。 */
      function saveConfig(partial) {    var current = readConfig();
        if (partial && typeof partial === 'object') {
          if (typeof partial.server === 'string') {
            current.server = normalizeServer(partial.server) || DEFAULT_SERVER;
          }
          if (Array.isArray(partial.topics)) {
            current.topics = normalizeTopicList(partial.topics);
          }
          if (partial.historyLimit !== undefined) {
            var limit = toFiniteNumber(partial.historyLimit);
            if (limit !== null && limit > 0) current.historyLimit = Math.floor(limit);
          }
          // 部分更新：identity 只有在明确带进来时才动，不会波及其它字段。
          if (partial.identity !== undefined) {
            current.identity = normalizeIdentity(partial.identity);
          }
          // 别名表同样只在明确带进来时才动（整张表替换，语义单纯）。
          if (partial.aliases !== undefined) {
            current.aliases = normalizeTopicAliases(partial.aliases);
          }
          if (partial.dashboardWidth !== undefined) {
            current.dashboardWidth = clampDashboardWidth(partial.dashboardWidth, current.dashboardWidth);
          }
          // 自動回應設定：整張表替換（語意單純，跟 aliases 一樣）。
          if (partial.autoApprove !== undefined) {
            current.autoApprove = normalizeAutoApprove(partial.autoApprove);
          }
          if (partial.stayAtBottom !== undefined) {
            current.stayAtBottom = normalizeStayAtBottom(partial.stayAtBottom);
          }
          // 預設主題的「已加過」記號：只寫 true，不寫回 false（加過就是加過）。
          if (partial.defaultTopicAdded === true) current.defaultTopicAdded = true;
        }
        writeJson(CONFIG_KEY, current);
        return current;
      }

      /**
       * 读一个主题的显示名：有别名就用别名，**空别名 = 用主题名**。
       * @param topic - 主题名（也是识别键）。
       * @returns 显示用字串。
       */
      function topicLabel(topic) {
        var name = normalizeTopic(topic);
        if (!name) return '';
        var aliases = readConfig().aliases || {};
        var alias = normalizeAlias(aliases[name]);
        return alias || name;
      }

      /**
       * 设定一个主题的别名。传空字串（或非字串）等于清除别名，之后显示回主题名。
       * @param topic - 主题名。
       * @param alias - 新别名；空 → 清除。
       * @returns 实际存下来的别名（'' 代表已清除）。
       */
      function setTopicAlias(topic, alias) {
        var name = normalizeTopic(topic);
        if (!name) return '';
        var next = normalizeTopicAliases(readConfig().aliases);
        var clean = normalizeAlias(alias);
        if (clean) next[name] = clean;
        else delete next[name];
        saveConfig({ aliases: next });
        return clean;
      }

      /**
       * 整批设定别名（用于清除已移除主题的别名）。
       * @param aliases - 完整的别名表。
       * @returns 干净的别名表。
       */
      function setTopicAliases(aliases) {
        return saveConfig({ aliases: normalizeTopicAliases(aliases) }).aliases;
      }

      /** 凭据按「归一化后的服务器地址」分桶存储。 */
      function credentialKey(server) {
        var base = normalizeServer(server) || readConfig().server || DEFAULT_SERVER;
        return CRED_PREFIX + base;
      }

      /** 读取凭据；永远返回四个字段齐全的对象（缺失即空值/模式 none）。 */
      function loadCredentials(server) {
        var key = credentialKey(server);
        // 快取優先（來自宿主 YAML 的載入會放在這裡）
        if (Object.prototype.hasOwnProperty.call(credentialCache, key)) {
          return normalizeCredential(credentialCache[key]);
        }
        var out = { mode: 'none', user: '', password: '', token: '' };
        var raw = readJson(key, null);
        if (raw && typeof raw === 'object') {
          out = normalizeCredential(raw);
        }
        return out;
      }

      /**
       * 归一化一份凭据（非法 mode 归一为 none，缺的字段补空）。
       *
       * @param cred - 任何输入。
       * @returns 四个字段齐全的凭据物件。
       */
      function normalizeCredential(cred) {
        var normalized = { mode: 'none', user: '', password: '', token: '' };
        if (cred && typeof cred === 'object') {
          if (typeof cred.mode === 'string' && AUTH_MODES.indexOf(cred.mode) !== -1) normalized.mode = cred.mode;
          if (typeof cred.user === 'string') normalized.user = cred.user;
          if (typeof cred.password === 'string') normalized.password = cred.password;
          if (typeof cred.token === 'string') normalized.token = cred.token;
        }
        return normalized;
      }

      /**
       * 保存凭据（非法 mode 归一为 none）；返回实际生效的凭据对象。
       *
       * ⚠️ 兩份儲存**都要寫**：
       *   * `credentialCache` —— `credentialServers()` 只認這一份，而它是
       *     `collectSecrets()`（「要寫進 YAML 的憑證有哪些」）的來源；
       *   * 記憶體儲存 —— `loadCredentials()` 的退路。
       *
       * 這裡只寫其中一份就會出現「憑證存了、測試也過，但寫不進 YAML」：
       * 記憶體裡明明有、`collectSecrets()` 卻回空物件，於是 PUT 送出的
       * `secrets` 是 `{}`（實測就是這樣：使用者回報「保存不了」）。
       *
       * @param server - 伺服器位址。
       * @param cred - 憑證。
       * @returns 正規化後的憑證。
       */
      function saveCredentials(server, cred) {
        var normalized = normalizeCredential(cred);
        credentialCache[credentialKey(server)] = normalized;
        writeJson(credentialKey(server), normalized);
        return normalized;
      }

      /**
       * 把一份凭据写进本机的快取，但**不**镜像到 localStorage。
       *
       * 这是给「从宿主 YAML 载入」用的：那份档案已经是持久层，再往 localStorage
       * 抄一份只会多一处会不一致的地方。
       *
       * @param server - 伺服器位址。
       * @param cred - 凭据。
       * @returns 归一化后的凭据。
       */
      function setCredentials(server, cred) {
        var normalized = normalizeCredential(cred);
        credentialCache[credentialKey(server)] = normalized;
        return normalized;
      }

      /** 清除某个服务器的凭据（快取与 localStorage 一起清）。 */
      function clearCredentials(server) {
        delete credentialCache[credentialKey(server)];
        return storageRemove(credentialKey(server));
      }

      /**
       * 列出快取里有凭据的伺服器位址（给「要把哪些写进 YAML」用）。
       *
       * @returns 已归一化的伺服器位址阵列。
       */
      function credentialServers() {
        var out = [];
        for (var key in credentialCache) {
          if (!Object.prototype.hasOwnProperty.call(credentialCache, key)) continue;
          var server = key.indexOf(CRED_PREFIX) === 0 ? key.slice(CRED_PREFIX.length) : '';
          if (server !== '' && out.indexOf(server) === -1) out.push(server);
        }
        return out;
      }

      /* ------------------------------------------------------------ 协议解析 */

      /**
       * ntfy 主题 URL。ntfy 主题字符集是 [A-Za-z0-9_-]，
       * encodeURIComponent 对合法主题是恒等映射，对非法输入也能安全工作。
       */
      function topicUrl(server, topic) {
        var base = normalizeServer(server);
        return base + '/' + safeEncodeURIComponent(normalizeTopic(topic));
      }

      /**
       * 从 ntfy 消息 ID 解出 unix 秒；解不出返回 null。
       *
       * ⚠️ 实测记录（重要，见 test/core-node.js 顶部说明）：
       *   契约期望 decodeId('1jLfaNcFIDCe') === 1790756810，但**这在真实服务器上不成立**。
       *   msn.feg.cn 的 ID 形如 '1jLfaNcFIDCe'（12 个 [A-Za-z0-9] 字符），
       *   它并不携带时间戳：对 5 个真实样本（跨两次会话）枚举全部位偏移/位长/10 的幂
       *   缩放，没有任何一个位段能还原出 JSON 里的 time。
       *   这与上游 ntfy 的实现一致：消息 ID 由 util.RandomString(12) 生成（62 字符随机表），
       *   时间在 JSON 的 time 字段里单独下发。
       *
       * 因此本函数按契约描述实现「文档中的 ID 形态」（8 字节大端 unix 纳秒），
       * 并且：
       *   - 只有恰好解出 8 字节时才算候选；
       *   - 解出的秒数落在 2000..2100 之外（例如对随机 ID 解出的 2459 年）一律返回 null，
       *     这样 parseServerMessage 的 time 兜底宁可为 0（UI 显示“时间未知”），
       *     也不会把随机 ID 变成荒诞的年份。
       */
      function decodeId(id) {
        var bytes = base64UrlDecodeBytes(id);
        if (!bytes || bytes.length !== 8) return null;
        var hi = bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3];
        var lo = bytes[4] * 16777216 + bytes[5] * 65536 + bytes[6] * 256 + bytes[7];
        var seconds;
        if (typeof BigInt === 'function') {
          try {
            seconds = Number((BigInt(hi) * 4294967296n + BigInt(lo)) / 1000000000n);
          } catch (e) {
            seconds = Math.floor((hi * 4294967296 + lo) / 1e9);
          }
        } else {
          seconds = Math.floor((hi * 4294967296 + lo) / 1e9);
        }
        if (!isFinite(seconds)) return null;
        if (seconds >= MIN_PLAUSIBLE_TIME && seconds <= MAX_PLAUSIBLE_TIME) return seconds;

        // 兜底：另一个常见布局是「8 字节大端 unix 毫秒」——此时这 8 字节本身就是毫秒，
        // 必须除以 1e3 才得到秒。最初写成 /1e6（把「纳秒→毫秒」的换算错放在这里），
        // 触发区间与上面的纳秒分支完全重合，等于死代码，真实毫秒 ID 仍会返回 null。
        // 已修正为 /1e3；并用同一个「合理时间窗」继续挡住随机 ID（随机 8 字节值落进
        // 该窗口的概率约 1.7e-7，而本服务器的 12 字符随机 ID 是 9 字节，根本走不到这里）。
        var value = hi * 4294967296 + lo;
        var fromMillis = Math.floor(value / 1000);
        if (isFinite(fromMillis) && fromMillis >= MIN_PLAUSIBLE_TIME && fromMillis <= MAX_PLAUSIBLE_TIME) {
          return fromMillis;
        }
        return null;
      }

      /** 取消息时间（数字且有限），否则 0。 */
      function messageTime(msg) {
        if (!msg || typeof msg !== 'object') return 0;
        var time = toFiniteNumber(msg.time);
        return time !== null && time > 0 ? time : 0;
      }

      /** 升序排序（不修改入参）；时间相同则按 id 稳定排序。 */
      function sortMessages(list) {
        var arr = Array.isArray(list) ? list.slice() : [];
        arr.sort(function (a, b) {
          var ta = messageTime(a);
          var tb = messageTime(b);
          if (ta !== tb) return ta - tb;
          var ia = a && a.id ? String(a.id) : '';
          var ib = b && b.id ? String(b.id) : '';
          if (ia === ib) return 0;
          return ia < ib ? -1 : 1;
        });
        return arr;
      }

      /** 标签归一化为字符串数组。 */
      function normalizeTags(tags) {
        var out = [];
        if (Array.isArray(tags)) {
          for (var i = 0; i < tags.length; i++) {
            if (tags[i] === null || tags[i] === undefined) continue;
            out.push(String(tags[i]));
          }
        } else if (typeof tags === 'string' && tags.trim()) {
          var parts = tags.split(',');
          for (var j = 0; j < parts.length; j++) {
            var part = parts[j].trim();
            if (part) out.push(part);
          }
        }
        return out;
      }

      /**
       * 合并两组消息：按 id 去重（后到的覆盖先到的）、按时间升序、只保留最新的 limit 条。
       * 不修改入参数组。
       */
      function mergeMessages(existing, incoming, limit) {
        var cap = toFiniteNumber(limit);
        if (cap === null || cap <= 0) cap = readConfig().historyLimit;
        cap = Math.floor(cap);

        var byId = {};
        var order = [];
        var noId = [];

        function absorb(list) {
          if (!Array.isArray(list)) return;
          for (var i = 0; i < list.length; i++) {
            var msg = list[i];
            if (!msg || typeof msg !== 'object') continue;
            var id = msg.id === null || msg.id === undefined ? '' : String(msg.id);
            if (!id) {
              noId.push(msg); // 没有 id 无法去重，原样保留
              continue;
            }
            if (!Object.prototype.hasOwnProperty.call(byId, id)) order.push(id);
            byId[id] = msg; // 后到的覆盖先到的
          }
        }

        absorb(existing);
        absorb(incoming);

        var merged = [];
        for (var k = 0; k < order.length; k++) merged.push(byId[order[k]]);
        merged = merged.concat(noId);
        merged = sortMessages(merged);
        if (cap > 0 && merged.length > cap) merged = merged.slice(merged.length - cap);
        return merged;
      }

      /** 组装鉴权请求头；mode 为 none / 必填字段为空时返回空对象（匿名请求）。 */
      function authHeaders(cred) {
        if (!cred || typeof cred !== 'object') return {};
        var mode = typeof cred.mode === 'string' ? cred.mode : 'none';
        if (mode === 'basic') {
          var user = typeof cred.user === 'string' ? cred.user : '';
          var password = typeof cred.password === 'string' ? cred.password : '';
          if (!user || !password) return {}; // 字段为空 → 不发送任何凭据
          return { Authorization: 'Basic ' + base64EncodeUtf8(user + ':' + password) };
        }
        if (mode === 'token') {
          var token = typeof cred.token === 'string' ? cred.token : '';
          if (!token) return {};
          return { Authorization: 'Bearer ' + token };
        }
        return {};
      }

      /** ntfy 的 open / keepalive 事件不是聊天消息。 */
      function isMetaEvent(event) {
        var name = String(event === null || event === undefined ? '' : event).toLowerCase();
        return name === 'open' || name === 'keepalive';
      }

      /**
       * 把一条 ntfy JSON（对象或 JSON 字符串）归一为内部消息结构。
       * 完全无法解析时返回 null（调用方负责跳过，绝不抛异常）。
       */
      function parseServerMessage(raw, server, source) {
        var obj = raw;
        if (typeof obj === 'string') {
          try {
            obj = JSON.parse(obj);
          } catch (e) {
            return null;
          }
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

        var id = obj.id === null || obj.id === undefined ? '' : String(obj.id);
        var time = toFiniteNumber(obj.time);
        if (time === null) time = decodeId(id); // 契约：缺失 time 时回落到 ID 解码
        if (time === null) time = 0;

        var expires = toFiniteNumber(obj.expires);
        var priority = toFiniteNumber(obj.priority);

        return {
          id: id,
          time: time,
          expires: expires === null ? 0 : expires,
          event: typeof obj.event === 'string' ? obj.event : 'message',
          topic: obj.topic === null || obj.topic === undefined ? '' : String(obj.topic),
          title: typeof obj.title === 'string' ? obj.title : '',
          message: obj.message === null || obj.message === undefined ? '' : String(obj.message),
          tags: normalizeTags(obj.tags),
          priority: priority === null ? 0 : priority,
          click: typeof obj.click === 'string' ? obj.click : '',
          actions: Array.isArray(obj.actions) ? obj.actions.slice() : [],
          raw: obj,
          server: normalizeServer(server),
          source: typeof source === 'string' && source ? source : SOURCE.SERVER
        };
      }

      /**
       * 解析「一行一个 JSON」的历史输出（GET /<topic>/json?poll=1&since=all）。
       * 忽略空行、SSE 注释/keepalive、`event:` 行；容忍可选的 `data: ` 前缀；
       * 单行坏了就跳过，绝不抛异常。
       * source 缺省为 'history'（这就是历史接口的语义）。
       */
      function parseTimeline(text, server, source) {
        var out = [];
        if (typeof text !== 'string' || !text) return out;
        var src = typeof source === 'string' && source ? source : SOURCE.HISTORY;
        var lines = text.split(/\r\n|\n|\r/);
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line) continue;
          var trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.charAt(0) === ':') continue; // SSE 注释 / keepalive
          if (/^event\s*:/i.test(trimmed)) continue; // 'event: open' 之类
          var payload = trimmed;
          var dataMatch = /^data\s*:/i.exec(payload);
          if (dataMatch) {
            payload = payload.slice(dataMatch[0].length);
            if (payload.charAt(0) === ' ') payload = payload.slice(1);
            payload = payload.trim();
          }
          if (!payload || payload === '[DONE]') continue;
          var parsed;
          try {
            parsed = JSON.parse(payload);
          } catch (e) {
            continue; // 坏行直接跳过
          }
          appendParsed(out, parsed, server, src);
        }
        return out;
      }

      /** parseTimeline / parseSseEvent 共用的收集逻辑（兼容数组形式的响应）。 */
      function appendParsed(out, parsed, server, source) {
        if (Array.isArray(parsed)) {
          for (var i = 0; i < parsed.length; i++) appendParsed(out, parsed[i], server, source);
          return;
        }
        var msg = parseServerMessage(parsed, server, source);
        if (!msg) return;
        if (isMetaEvent(msg.event)) return; // event:open / keepalive 不是消息
        out.push(msg);
      }

      /**
       * 解析一个 SSE 数据块（形如 "event: message\ndata: {...}"）。
       * 多行 data: 用 \n 连接；open / keepalive / 坏 JSON 一律返回 null。
       */
      function parseSseEvent(block, server) {
        if (typeof block !== 'string') return null;
        var text = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = text.split('\n');
        var eventName = '';
        var dataLines = [];
        var hasData = false;

        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (!line) continue;
          if (line.charAt(0) === ':') continue;
          var match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/.exec(line);
          if (!match) continue;
          var field = match[1].toLowerCase();
          var value = match[2];
          if (value.charAt(0) === ' ') value = value.slice(1);
          if (field === 'event') {
            eventName = value.trim().toLowerCase();
          } else if (field === 'data') {
            hasData = true;
            dataLines.push(value);
          }
        }

        if (!hasData) return null;
        var payload = dataLines.join('\n').trim();
        if (!payload || payload === '[DONE]') return null;

        var parsed;
        try {
          parsed = JSON.parse(payload);
        } catch (e) {
          return null;
        }
        var collected = [];
        appendParsed(collected, parsed, server, SOURCE.SSE);
        if (!collected.length) return null;
        var msg = collected[0];
        var effective = (eventName || msg.event || '').toLowerCase();
        if (isMetaEvent(effective)) return null;
        return msg;
      }

      /* ---------------------------------------------------------------- 网络 */

      /** 历史消息：GET <topic>/json?poll=1&since=all。永不抛异常。 */
      async function fetchTopicMessages(server, topic, options) {
        var opts = options || {};
        var result = { messages: [], status: 0, error: null, authRequired: false };
        var base = normalizeServer(server);
        if (!base) {
          result.error = '伺服器位址為空';
          return result;
        }
        var url = topicUrl(base, topic) + '/json?poll=1&since=all';
        try {
          var response = await fetch(url, {
            method: 'GET',
            headers: authHeaders(opts.cred),
            cache: 'no-store',
            signal: opts.signal || undefined
          });
          result.status = response.status;
          result.authRequired = response.status === 401 || response.status === 403;
          if (!response.ok) {
            var body = '';
            try {
              body = await response.text();
            } catch (e) {
              body = '';
            }
            result.error = httpErrorText(response.status, body);
            return result;
          }
          var text = await response.text();
          var messages = sortMessages(parseTimeline(text, base, SOURCE.HISTORY));
          var limit = toFiniteNumber(opts.limit);
          if (limit !== null && limit > 0 && messages.length > limit) {
            messages = messages.slice(messages.length - limit);
          }
          result.messages = messages;
          return result;
        } catch (error) {
          result.status = 0;
          result.error = errorMessage(error);
          return result;
        }
      }

      /**
       * 发布消息：POST <topic>。永不抛异常。
       *
       * ⚠️ 实测结论（msn.feg.cn，2026-09-30，原始证据见 test/core-live.js 的请求记录与断言）：
       *   本服务器**不解析 JSON 发布体**。即使带 `Content-Type: application/json`，
       *   形如 `{"topic":"…","message":"A1"}` 的请求体也会被当作**纯文本消息**原样存下来
       *   （历史里读回的就是这段 JSON 字符串本身），title/priority/tags 全部丢失。
       *   实测可用的形式是：body = 纯文本消息，元数据走 HTTP 头 Title / Priority / Tags / Click
       *   （A5 用例：纯文本体 + 头 → 服务器正确回填 title/priority/tags）。
       *   因此默认走「纯文本 + 头」形式 —— 消息内容才是用户在 UI 上看到的东西。
       *   契约描述的 JSON 形态仍保留，用 opts.json === true 显式开启。
       *   返回形状与契约完全一致：{ok, status, error, message}。
       */
      async function publishMessage(server, topic, options) {
        var opts = options || {};
        var result = { ok: false, status: 0, error: null, message: null };
        var base = normalizeServer(server);
        if (!base) {
          result.error = '伺服器位址為空';
          return result;
        }
        var name = normalizeTopic(topic);
        var url = topicUrl(base, name);

        var messageText = opts.message === null || opts.message === undefined ? '' : String(opts.message);
        var titleText = opts.title === null || opts.title === undefined ? '' : String(opts.title);
        var clickText = opts.click === null || opts.click === undefined ? '' : String(opts.click);
        var tagList = normalizeTags(opts.tags);
        var priority = toFiniteNumber(opts.priority);

        var headers = authHeaders(opts.cred);
        var body;

        if (opts.json === true) {
          // 契约描述的形态：JSON 体；空字段一律不发送
          var payload = { topic: name };
          if (messageText !== '') payload.message = messageText;
          if (titleText !== '') payload.title = titleText; // title 为空时整体省略
          if (tagList.length) payload.tags = tagList;
          if (priority !== null && priority > 0) payload.priority = priority;
          if (clickText !== '') payload.click = clickText;
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(payload);
        } else {
          // 实测可用形态：纯文本体 + 元数据头
          headers['Content-Type'] = 'text/plain; charset=utf-8';
          body = messageText;
          if (titleText !== '') headers.Title = titleText;
          if (tagList.length) headers.Tags = tagList.join(',');
          if (priority !== null && priority > 0) headers.Priority = String(priority);
          if (clickText !== '') headers.Click = clickText;
        }

        try {
          var response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body,
            cache: 'no-store',
            signal: opts.signal || undefined
          });
          result.status = response.status;
          var text = '';
          try {
            text = await response.text();
          } catch (e) {
            text = '';
          }
          if (!response.ok) {
            result.error = httpErrorText(response.status, text);
            return result;
          }
          var msg = null;
          if (text) {
            try {
              msg = parseServerMessage(JSON.parse(text), base, SOURCE.LOCAL);
            } catch (e) {
              msg = null;
            }
          }
          if (msg && !msg.topic) msg.topic = name;
          result.ok = true;
          result.message = msg;
          return result;
        } catch (error) {
          result.status = 0;
          result.error = errorMessage(error);
          return result;
        }
      }

      /** 连通性检查：GET <server>/v1/health。永不抛异常。 */
      async function testConnection(server, cred) {
        var result = { ok: false, status: 0, error: null };
        var base = normalizeServer(server);
        if (!base) {
          result.error = '伺服器位址為空';
          return result;
        }
        try {
          var response = await fetch(base + '/v1/health', {
            method: 'GET',
            headers: authHeaders(cred),
            cache: 'no-store'
          });
          result.status = response.status;
          if (!response.ok) {
            var body = '';
            try {
              body = await response.text();
            } catch (e) {
              body = '';
            }
            result.error = httpErrorText(response.status, body);
            return result;
          }
          var text = '';
          try {
            text = await response.text();
          } catch (e) {
            text = '';
          }
          if (text) {
            try {
              var health = JSON.parse(text);
              if (health && health.healthy === false) {
                result.error = '伺服器回報自身不健康（healthy=false）';
                return result;
              }
            } catch (e) {
              /* 非 JSON 但 HTTP 200：仍视为可连接 */
            }
          }
          result.ok = true;
          return result;
        } catch (error) {
          result.status = 0;
          result.error = errorMessage(error);
          return result;
        }
      }

      /* -------------------------------------------------------------- SSE 订阅 */

      /**
       * 订阅主题实时推送。
       *
       * 为什么不用 EventSource：EventSource 无法携带 Authorization 头，
       * 而 ntfy 的私有主题必须带凭据。这里用 fetch + response.body.getReader()。
       *
       * 返回 {close()}，同步返回；close() 幂等；onStatus({phase:'closed'}) 恰好触发一次。
       */
      function subscribeTopic(server, topic, options) {
        return subscribeTopics(server, [topic], options);
      }

      /**
       * 訂閱**多個主題**的即時推送（一條連線）。
       *
       * 為什麼不是每個主題一條：同一台伺服器上，N 個主題＝N 條常駐連線。ntfy 支援在
       * 路徑放逗號分隔的主題清單（實測本伺服器可用：`/a,b,c/sse`），開頭那個 `open`
       * 事件的 `topic` 會是整串清單，之後每則訊息的 `topic` 是**它自己所屬的單一主題**，
       * 所以可以用來分發。一條連線同時也讓限流額度的消耗從 N 降到 1。
       *
       * 認證是**整條連線**的事：ntfy 在某個主題上缺權限就整個請求回 403，
       * 不會只擋那一個主題 —— 所以 onError 帶的 authRequired 是整條連線的語意，
       * 呼叫端要自己決定要把它記在哪些主題上。
       *
       * @param server - 伺服器位址。
       * @param topics - 主題清單（空陣列＝什麼都不做）。
       * @param options - { cred, onMessage(msg, topic), onStatus(status), onError(info), since, signal }。
       *   `onStatus` 收到的 status 會多一個 `topic` 欄位表示是哪個主題的階段變化。
       * @returns {{close()}}；topics 為空時回傳一個 no-op 句柄。
       */
      function subscribeTopics(server, topics, options) {
        var opts = options || {};
        var base = normalizeServer(server);
        var list = [];
        for (var ti = 0; ti < (topics || []).length; ti++) {
          var name = normalizeTopic(topics[ti]);
          if (name && list.indexOf(name) === -1) list.push(name);
        }
        if (list.length === 0) return { close: noop };

        var onMessage = typeof opts.onMessage === 'function' ? opts.onMessage : noop;
        var onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : noop;
        var onError = typeof opts.onError === 'function' ? opts.onError : noop;
        var onClosed = typeof opts.onClosed === 'function' ? opts.onClosed : noop;

        var settled = false;      // 已经结束（手动关闭 / 出错 / 流结束）
        var closeEmitted = false; // onStatus({phase:'closed'}) 只发一次
        var closedByUs = false;   // close() 主动关闭（而非串流自己结束）
        var errored = false;      // 已经走過 onError（不要重複通知）
        var reader = null;
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var externalSignal = opts.signal || null;
        var externalListener = null;
        /** 哪個主題已經進入過即時階段（每個主題只發一次 'live'）。 */
        var liveByTopic = {};

        // 逐段編碼再接起來：不能整串丟給 encodeURIComponent，那會把分隔用的逗號
        // 編成 %2C，ntfy 就讀不到「多個主題」的意思（實測踩過）。
        var path = list.map(function (t) { return safeEncodeURIComponent(t); }).join(',');
        var url = base + '/' + path + '/sse';
        if (opts.since) {
          url += '?since=' + safeEncodeURIComponent(String(opts.since));
        }

        /**
         * 分發一個狀態；能對應到主題就補上 topic 欄位。
         * @param phase - 階段。
         * @param detail - 說明。
         * @param topic - 主題（可省略）。
         */
        function emitStatus(phase, detail, topic) {
          var status = { phase: phase, detail: detail || '' };
          if (topic) status.topic = topic;
          try {
            onStatus(status);
          } catch (e) {
            /* 订阅方回调异常不影响数据流 */
          }
        }

        function emitError(info) {
          errored = true;
          try {
            onError(info);
          } catch (e) {
            /* 同上 */
          }
        }

        /**
         * 通知「串流結束了，而且不是我們主動關的」。
         *
         * 為什麼一定要有這個回呼：串流**自然結束**（伺服器收尾、網路中斷成 AbortError）
         * 這兩條路徑都不會走 onError。沒有 onClosed 的話，訂閱方只看得到一個
         * `closed` 狀態 —— 沒有重試、沒有原因，就這樣永久停在「未連線」。
         * 那正是「為什麼會有閒置狀態」的成因。
         *
         * @param detail - 結束原因。
         */
        function emitClosedEvent(detail) {
          if (closedByUs || errored) return;   // 主動關閉 or 已經報過錯，不要重複通知
          try {
            onClosed({ status: 0, message: detail || '連線已中斷', authRequired: false, retryable: true });
          } catch (e) {
            /* 同上 */
          }
        }

        function emitClosed(detail) {
          if (closeEmitted) return;
          closeEmitted = true;
          emitStatus('closed', detail);
          emitClosedEvent(detail);
        }

        function detachExternal() {
          if (externalSignal && externalListener) {
            try {
              externalSignal.removeEventListener('abort', externalListener);
            } catch (e) {
              /* ignore */
            }
            externalListener = null;
          }
        }

        /** 收尾：标记结束、释放监听、触发一次 closed。 */
        function finish(detail, phase) {
          if (settled) return;
          settled = true;
          detachExternal();
          if (phase) emitStatus(phase, detail);
          emitClosed(detail);
        }

        /** 幂等关闭。 */
        function close(detail) {
          if (settled) return;
          settled = true;
          // 標記「是我們自己關的」：這樣 emitClosed 就不會去觸發 onClosed，
          // 訂閱方也就不會為了一個刻意的關閉去重連（會被當成無限迴圈）。
          closedByUs = true;
          detachExternal();
          if (reader && typeof reader.cancel === 'function') {
            try {
              var cancelled = reader.cancel();
              if (cancelled && typeof cancelled.catch === 'function') cancelled.catch(noop);
            } catch (e) {
              /* ignore */
            }
          }
          if (controller) {
            try {
              controller.abort();
            } catch (e) {
              /* ignore */
            }
          }
          emitClosed(detail || '已關閉');
        }

        if (externalSignal) {
          if (externalSignal.aborted) {
            // 传入时就已经取消：立刻以 closed 收尾，但仍然同步返回句柄
            settled = true;
            closedByUs = true;   // 外部取消也算主動關閉，不該觸發重連
            emitClosed('已取消');
          } else {
            externalListener = function () {
              close('已取消');
            };
            try {
              externalSignal.addEventListener('abort', externalListener);
            } catch (e) {
              externalListener = null;
            }
          }
        }

        var pump = (async function () {
          if (settled) return;
          emitStatus('connecting', '正在連線 ' + url);
          try {
            var response = await fetch(url, {
              method: 'GET',
              headers: authHeaders(opts.cred),
              cache: 'no-store',
              signal: controller ? controller.signal : undefined
            });
            if (settled) return;

            if (!response.ok) {
              var body = '';
              try {
                body = await response.text();
              } catch (e) {
                body = '';
              }
              var detail = httpErrorText(response.status, body);
              var authRequired = response.status === 401 || response.status === 403;
              emitError({ status: response.status, message: detail, authRequired: authRequired });
              finish(detail, 'error');
              return;
            }

            emitStatus('open', '已連線', list.length === 1 ? list[0] : '');

            var stream = response.body;
            if (!stream || typeof stream.getReader !== 'function') {
              var unsupported = '目前環境不支援串流讀取（response.body 無法使用）';
              emitError({ status: response.status, message: unsupported, authRequired: false });
              finish(unsupported, 'error');
              return;
            }

            reader = stream.getReader();
            var decoder = typeof TextDecoder === 'function' ? new TextDecoder('utf-8') : null;
            var buffer = '';

            function deliver(block) {
              var msg = parseSseEvent(block, base);
              if (!msg) return;
              // 分發：多主題連線上，每則訊息的 `topic` 就是它自己所屬的那一個。
              //
              // 用 trim 後的原字串直接比對，**不要**做 normalizeTopic：主題名可能含大寫，
              // 而訂閱時送出的就是原始名稱，硬正規化會對不上。
              // （也不能用 client 的 `text()` —— core 沒有那個 helper，呼叫它會
              //   ReferenceError 並把整條串流打成 error。實測踩過。）
              var rawTopic = msg.topic;
              var which = (typeof rawTopic === 'string') ? rawTopic.trim() : '';
              if (which && list.indexOf(which) === -1) {
                // 不屬於我們訂閱的主題（例如伺服器送了別的），丟掉而不是猜。
                return;
              }
              var key = which || list[0];
              if (!liveByTopic[key]) {
                liveByTopic[key] = true;
                emitStatus('live', '即時接收中', list.length === 1 ? list[0] : which);
              }
              try {
                onMessage(msg, which || list[0]);
              } catch (e) {
                /* 订阅方回调异常不影响数据流 */
              }
            }

            while (true) {
              var chunk = await reader.read();
              if (chunk.done) break;
              if (settled) return;
              if (decoder) {
                buffer += decoder.decode(chunk.value, { stream: true });
              } else {
                buffer += String.fromCharCode.apply(null, chunk.value);
              }
              var blocks = buffer.split(/\r?\n\r?\n/);
              buffer = blocks.pop();
              for (var i = 0; i < blocks.length; i++) deliver(blocks[i]);
              if (settled) return;
            }

            if (buffer.trim()) deliver(buffer);
            finish('伺服器已結束推送');
          } catch (error) {
            if (settled) return; // close() 触发的 AbortError
            if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
              finish('連線已中斷');
              return;
            }
            var message = errorMessage(error);
            emitError({ status: 0, message: message, authRequired: false });
            finish(message, 'error');
          }
        })();

        // 兜底：pump 内部已全量 try/catch，这里只防止极端的 unhandled rejection 噪音。
        if (pump && typeof pump.catch === 'function') pump.catch(noop);

        return {
          close: close
        };
      }

      /* ---------------------------------------------------------------- store */

      /** 状态对象归一化（允许传字符串或 {phase,detail}）。 */
      function normalizeStatus(status) {
        if (typeof status === 'string') return { phase: status, detail: '' };
        if (status && typeof status === 'object') {
          var out = {};
          for (var key in status) {
            if (Object.prototype.hasOwnProperty.call(status, key)) out[key] = status[key];
          }
          if (typeof out.phase !== 'string') out.phase = '';
          if (out.detail === null || out.detail === undefined) out.detail = '';
          else if (typeof out.detail !== 'string') out.detail = String(out.detail);
          return out;
        }
        return { phase: '', detail: '' };
      }

      function sameStatus(a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        try {
          return JSON.stringify(a) === JSON.stringify(b);
        } catch (e) {
          return false;
        }
      }

      /** 逐条比较消息序列（id + time + message），用于判断是否真的变了。 */
      function sameMessageSequence(a, b) {
        if (!Array.isArray(a) || !Array.isArray(b)) return false;
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
          var x = a[i];
          var y = b[i];
          if (x === y) continue;
          if (!x || !y) return false;
          if (String(x.id || '') !== String(y.id || '')) return false;
          if (messageTime(x) !== messageTime(y)) return false;
          if (String(x.message || '') !== String(y.message || '')) return false;
          if (String(x.title || '') !== String(y.title || '')) return false;
        }
        return true;
      }

      /**
       * 内存消息仓库 + 订阅通知。
       *
       * getSnapshot() 在「没有任何变更」时返回同一个对象引用，
       * 这样客户端可以安全地用 useSyncExternalStore 风格的 === 比较。
       */
      function createStore() {
        var state = {
          topics: [],
          activeTopic: '',
          messagesByTopic: {},
          statusByTopic: {},
          unreadByTopic: {},
          authByTopic: {},
          // 「上次讀到哪一則」＝該主題最後一則「已看過」的訊息 id。
          // 用來在切換主題時捲到那附近，而不是每次都跳到最底。
          lastReadIdByTopic: {}
        };
        var listeners = [];
        var snapshot = buildSnapshot();

        function buildSnapshot() {
          var messagesByTopic = {};
          var statusByTopic = {};
          var unreadByTopic = {};
          var authByTopic = {};
          var lastReadIdByTopic = {};
          for (var i = 0; i < state.topics.length; i++) {
            var topic = state.topics[i];
            messagesByTopic[topic] = state.messagesByTopic[topic] || [];
            statusByTopic[topic] = state.statusByTopic[topic] || null;
            unreadByTopic[topic] = state.unreadByTopic[topic] || 0;
            authByTopic[topic] = state.authByTopic[topic] === true;
            lastReadIdByTopic[topic] = state.lastReadIdByTopic[topic] || '';
          }
          return {
            topics: state.topics.slice(),
            activeTopic: state.activeTopic,
            messagesByTopic: messagesByTopic,
            statusByTopic: statusByTopic,
            unreadByTopic: unreadByTopic,
            authByTopic: authByTopic,
            lastReadIdByTopic: lastReadIdByTopic
          };
        }

        /** 一則訊息可用来当「已讀到這裡」的识别键。 @param msg - 訊息。 @returns id 或 ''。 */
        function messageKey(msg) {
          if (!msg || msg.id === null || msg.id === undefined) return '';
          return String(msg.id);
        }

        /**
         * 記下「這個主題讀到最新一則了」。
         * 只在实际看到訊息、或把某主題設為當前主題时呼叫，不会被别处的重绘误触发。
         *
         * ⚠️ 這裡**也要把未讀清掉**，不只是推進「讀到哪」。
         *
         * 「讀到最新」在語意上就等於「沒有未讀了」（`markRead` 清未讀、這裡推進邊界，
         * 兩者本來是同一件事的兩半）。少了清未讀會有一個很明顯的漏洞：
         * 使用者點「N 則新訊息」提示條跳到未讀處時，訊息數沒有變化 ——
         * 而面板那個「貼底就清未讀」的 effect 只在**訊息數變化**時才跑，
         * 於是未讀永遠留著、提示條一直掛在畫面上（實測：捲到未讀處後仍是 3）。
         *
         * @param topic - 主題名。
         */
        function markReadToLatest(topic) {
          var name = normalizeTopic(topic);
          if (!name) return;
          var list = state.messagesByTopic[name] || [];
          var newest = list.length ? messageKey(list[list.length - 1]) : '';
          if (!newest) return;
          var hadUnread = (state.unreadByTopic[name] || 0) > 0;
          if (hadUnread) state.unreadByTopic[name] = 0;
          if (state.lastReadIdByTopic[name] === newest) {
            if (hadUnread) emit();
            return;
          }
          state.lastReadIdByTopic[name] = newest;
          emit();
        }

        /** 有变更时才重建快照并通知监听者。 */
        function emit() {
          snapshot = buildSnapshot();
          for (var i = 0; i < listeners.length; i++) {
            try {
              listeners[i]();
            } catch (e) {
              /* 单个监听者异常不影响其它监听者 */
            }
          }
        }

        /** 内部：确保主题存在，但**不**触发通知（由调用方决定是否 emit）。 */
        function ensureTopicInternal(topic) {
          if (!topic) return false;
          if (state.topics.indexOf(topic) !== -1) {
            if (!state.messagesByTopic[topic]) state.messagesByTopic[topic] = [];
            if (state.unreadByTopic[topic] === undefined) state.unreadByTopic[topic] = 0;
            if (state.authByTopic[topic] === undefined) state.authByTopic[topic] = false;
            return false;
          }
          state.topics.push(topic);
          if (!state.messagesByTopic[topic]) state.messagesByTopic[topic] = [];
          if (state.unreadByTopic[topic] === undefined) state.unreadByTopic[topic] = 0;
          if (state.authByTopic[topic] === undefined) state.authByTopic[topic] = false;
          if (!state.activeTopic) state.activeTopic = topic; // 第一个主题自动成为当前主题
          return true;
        }

        function getSnapshot() {
          return snapshot;
        }

        /**
         * 把某個主題移到清單**最前面**（其餘保持原相對順序）。
         *
         * 為什麼需要：預設主題（`pub_dsh`）應該是清單裡的固定第一位 —— 它是共用的錨點，
         * 位置不該取決於「它什麼時候被加進來」。`ensureTopic` 是往後加的，所以需要
         * 一個明確的排序操作，而不是靠加入順序碰運氣。
         *
         * 冪等：已經在第一個就什麼都不做（不觸發 emit）。
         *
         * @param topic - 主題名。
         * @returns 是否真的移動了。
         */
        function pinTopicFirst(topic) {
          var name = normalizeTopic(topic);
          if (!name) return false;
          var index = state.topics.indexOf(name);
          if (index <= 0) return false;    // 不在清單裡，或已經在第一個
          state.topics.splice(index, 1);
          state.topics.unshift(name);
          emit();
          return true;
        }

        /** 订阅变更，返回退订函数（幂等）。 */
        function subscribe(listener) {
          if (typeof listener !== 'function') return noop;
          listeners.push(listener);
          var active = true;
          return function unsubscribe() {
            if (!active) return;
            active = false;
            var index = listeners.indexOf(listener);
            if (index !== -1) listeners.splice(index, 1);
          };
        }

        function ensureTopic(topic) {
          var name = normalizeTopic(topic);
          if (ensureTopicInternal(name)) emit();
        }

        function removeTopic(topic) {
          var name = normalizeTopic(topic);
          var index = state.topics.indexOf(name);
          if (index === -1) return;
          state.topics.splice(index, 1);
          delete state.messagesByTopic[name];
          delete state.statusByTopic[name];
          delete state.unreadByTopic[name];
          delete state.authByTopic[name];
          delete state.lastReadIdByTopic[name];
          if (state.activeTopic === name) {
            state.activeTopic = state.topics.length ? state.topics[0] : '';
          }
          emit();
        }

        /**
         * 切换当前主题；同时把该主题的未读清零
         * （UI 上“正在看这个主题”等价于“已读”，避免徽标残留）。
         *
         * 注意：「讀到哪一則」不會在這裡被推進 —— 切過去的時候使用者其實還沒看到，
         * 面板會先捲到「上次讀到的地方」，那時才算看到。這樣才有東西可以捲。
         */
        function setActiveTopic(topic) {
          var name = normalizeTopic(topic);
          var created = ensureTopicInternal(name);
          var changed = state.activeTopic !== name;
          var hadUnread = name ? (state.unreadByTopic[name] || 0) > 0 : false;
          if (changed) state.activeTopic = name;
          if (hadUnread) state.unreadByTopic[name] = 0;
          if (created || changed || hadUnread) emit();
        }

        /**
         * 批量加入消息，返回**新增**条数。
         * unread 只在「SSE 实时到达 + 该主题不是当前主题」时累加：
         * 历史加载不该把旧消息全标成未读，自己发的也不该。
         */
        /**
         * 「這個主題現在正被看著嗎」。
         *
         * 需要 activeTopic 相符，**而且**面板真的顯示著 —— host 會把沒在用的面板從
         * DOM 移除，那之後 activeTopic 仍然留著（它只是「選了哪個主題」），
         * 只看它會讓面板關掉之後來的訊息全被當成已讀、角標永遠不動。
         * 面板掛載時會把自己登記成「可見」（client 端設定 hooks）。
         */
        var viewHooks = {
          // 預設「看不到」：store 本身不知道有沒有 UI 在顯示。client 掛載時會
          // 用 setViewHooks 覆蓋掉。預設成 true 會讓「沒人告知」被誤當成「正在看」，
          // 那就回到原本「面板關著也把訊息標成已讀」的老問題。
          isPanelVisible: function () { return false; },
          // 預設「沒貼著底部」：不確定時**保守**處理 —— 當成沒在看最新，
          // 於是別人的訊息會算未讀。寧可多一個提示，也不要漏掉訊息。
          isFollowing: function () { return false; }
        };

        /** 設定「面板是否可見／是否貼著底部」的查詢（client 端注入）。 @param hooks - { isPanelVisible, isFollowing }。 */
        function setViewHooks(hooks) {
          if (hooks && typeof hooks.isPanelVisible === 'function') {
            viewHooks = hooks;
          }
        }

        /** @param topic - 主題名。 @returns 是否正被看著。 */
        function isViewing(topic) {
          if (!topic || state.activeTopic !== topic) return false;
          try {
            return viewHooks.isPanelVisible() === true;
          } catch (e) {
            return true;
          }
        }

        /**
         * 使用者是不是**貼在底部**（正在看最新訊息）。
         *
         * 這是「要不要自動跟隨」的第二層條件：面板開著而且貼底，才算真的看到最新；
         * 往上翻歷史時別人的訊息應該變成未讀提示，而不是被默默吃掉。
         *
         * 回傳 false 的情況：沒人告知（預設）、面板沒開、或不在底部。
         *
         * @returns 是否貼著底部。
         */
        function isFollowing() {
          try {
            return viewHooks.isFollowing() === true;
          } catch (e) {
            return false;
          }
        }

        /**
         * 這則訊息是不是**自己發的**。
         *
         * 判定與 UI 一致：title 必須是 `#handle` 形式，且 handle 等於目前設定的顯示名稱
         * （大小寫不在意）。沒有 title、或 title 不是 `#` 開頭的一律當成別人的訊息 ——
         * 寧可多提示一次，也不要把別人的訊息誤認成自己發的而標成已讀。
         *
         * @param msg - 正規化訊息。
         * @returns 是否自己發的。
         */
        function isOwnMessage(msg) {
          if (!msg) return false;
          var self = normalizeIdentity(readConfig().identity);
          if (self === '') return false;
          // 用 core 自己的權威解析器（`parseIdentity`），不要在這裡另寫一套 ——
          // UI 的 `senderOf` 也是走它，兩邊不一致就會出現「畫面說是我發的、
          // 未讀判定卻說不是」這種鬼故事。
          var parsed = parseIdentity(msg.title);
          if (!parsed.isMention || parsed.handle === '') return false;
          return parsed.handle.toLowerCase() === self.toLowerCase();
        }

        function addMessages(topic, msgs, source) {
          var name = normalizeTopic(topic);
          if (!name) return 0;
          // 已取消訂閱的主題不再收資料。
          //
          // 少了這個檢查，取消訂閱會被「復活」：移除的當下訂閱連線正在收尾，
          // 伺服器送來的收尾訊息會走進這裡，而下面的 ensureTopicInternal 會把主題
          // 重新加回清單（實測：刪掉之後 100ms 內就自己回來了）。
          if (!isSubscribed(name)) return 0;
          var list = Array.isArray(msgs) ? msgs : msgs ? [msgs] : [];
          if (!list.length) return 0;

          var created = ensureTopicInternal(name);
          var existing = state.messagesByTopic[name] || [];

          var seen = {};
          for (var i = 0; i < existing.length; i++) {
            var existingMsg = existing[i];
            if (existingMsg && existingMsg.id) seen[String(existingMsg.id)] = true;
          }

          var incoming = [];
          var newCount = 0;
          for (var j = 0; j < list.length; j++) {
            var candidate = list[j];
            if (!candidate || typeof candidate !== 'object') continue;
            var id = candidate.id === null || candidate.id === undefined ? '' : String(candidate.id);
            if (!id) {
              newCount++; // 没有 id 无法去重，只能当新消息
            } else if (!seen[id]) {
              seen[id] = true;
              newCount++;
            }
            incoming.push(candidate);
          }
          if (!incoming.length) return 0;

          var merged = mergeMessages(existing, incoming, readConfig().historyLimit);
          var changed = !sameMessageSequence(merged, existing);
          state.messagesByTopic[name] = merged;

          var previousUnread = state.unreadByTopic[name] || 0;

          // ---- 未讀怎麼算（「焦點中要不要自動跟隨」的規則在這裡）----
          //
          // 需求：「當前 topic 處於焦點時，希望可以適時追蹤最新推送 ——
          //       如果是我發的就自動滾屏到那條之後，如果是其他人發的就提示未讀」。
          //
          // 判定分成兩層：
          //
          //   1. `isViewing(name)`：面板開著，而且正在看這個主題。
          //   2. `isFollowing()`：**而且貼在底部**（正在看最新）。
          //
          // 只有「看得到 + 貼著底部」才算真的看到；少了第二層，使用者往上翻歷史時
          // 別人的訊息會被默默吃掉（舊行為就是這樣）。
          //
          //   自己發的        → 一律算已讀（那是你自己剛送出去的）
          //   別人發的 + 貼底  → 算已讀、自動跟隨（你正看著它出現）
          //   別人發的 + 沒貼底 → **算未讀**（提示你，讓你自己決定要不要跳過去）
          //   不在看這個主題   → 算未讀
          var seesLatest = isViewing(name) && isFollowing();
          var mine = isOwnMessage(incoming[incoming.length - 1]);
          if (newCount > 0 && source === SOURCE.SSE && !seesLatest && !mine) {
            state.unreadByTopic[name] = previousUnread + newCount;
          }
          var unreadChanged = (state.unreadByTopic[name] || 0) !== previousUnread;

          // 訊息是送進「目前正在看的主題」，就代表使用者看到了 ——
          // 把「讀到哪」推進到最新一則。
          //
          // ⚠️ 只有在 `seesLatest`（看得到 + 貼底）或「自己發的」時才推進。
          // 舊行為是 `isViewing` 就算 —— 那樣使用者往上翻歷史時，
          // 別人的訊息一進來就被標成已讀，未讀提示永遠不會出現。
          // 沒在看的主題當然也不動：那正是未讀要留下來的地方。
          if ((seesLatest || mine) && isViewing(name) && merged.length) {
            state.lastReadIdByTopic[name] = messageKey(merged[merged.length - 1]);
          }

          if (created || changed || unreadChanged) emit();
          return newCount;
        }

        /** 单条加入；返回是否是「新消息」。 */
        function addMessage(topic, msg) {
          var source = msg && typeof msg.source === 'string' && msg.source ? msg.source : SOURCE.LOCAL;
          return addMessages(topic, [msg], source) > 0;
        }

        function setStatus(topic, status) {
          var name = normalizeTopic(topic);
          if (!name) return;
          // 同 addMessages：訂閱連線收尾時送來的狀態不該讓已取消的主題復活。
          if (!isSubscribed(name)) return;
          var created = ensureTopicInternal(name);
          var next = normalizeStatus(status);
          var previous = state.statusByTopic[name] || null;
          var changed = !sameStatus(previous, next);
          if (changed) state.statusByTopic[name] = next;
          if (created || changed) emit();
        }

        /**
         * 把所有主題的連線狀態重置回 `idle`（尚未連線），並清掉「需要認證」旗標。
         *
         * 為什麼需要：狀態是**上一條連線**留下的，重連之前必須先重置，
         * 否則畫面會一直顯示上一次的錯誤。
         *
         * 實際踩到的情況（兩次回報）：
         *   1. 改了認證方式並儲存之後，連線確實重建了，但舊的「HTTP 403 需要認證」
         *      還掛在主題上；
         *   2. **保存生效了，提示還在顯示上一次的錯誤** —— `authByTopic` 這個旗標
         *      只會被 403 設成 true，沒有任何地方設回 false，所以連線成功之後
         *      「此主題需要認證，請在共用設定裡輸入帳號與密碼」永遠掛著。
         *
         * 為什麼這裡可以放心清掉 `authByTopic`：它是「**上一次嘗試**的結論」，不是
         * 事實。重建連線＝重新嘗試，所以應該從「還不知道」開始；真的還需要認證時，
         * 新的 403 會再把它設回 true（而且那時連線層的錯誤訊息也在）。
         *
         * 為什麼是「設成 idle」而不是 `delete`：snapshot 的 `statusByTopic` 是
         * **同一顆物件**，`delete` 之後 emit 會讓下游再把它填回來
         * （實測：刪掉後變成 `{phase:'',detail:''}`，看起來像清掉了、其實還在）。
         * 明確設成 idle 才是穩定的。
         *
         * `idle` 在 `sidebarHealth()` 裡不計入錯誤／離線／連線中，所以側欄會回到
         * 「尚未連線」而不是顯示故障。
         *
         * @returns 實際被重置的主題數。
         */
        function clearStatuses() {
          var changed = 0;
          for (var i = 0; i < state.topics.length; i += 1) {
            var name = state.topics[i];
            // 「需要認證」也要清 —— 它跟連線狀態一樣是「上一條連線的結論」。
            if (state.authByTopic[name] === true) {
              state.authByTopic[name] = false;
              changed += 1;
            }
            var previous = state.statusByTopic[name];
            // 已經是 idle（或本來就沒有）就不必動。
            var phase = typeof previous === 'string' ? previous
              : (previous && typeof previous === 'object' && typeof previous.phase === 'string') ? previous.phase : '';
            if (previous === undefined || phase === 'idle') continue;
            state.statusByTopic[name] = { phase: 'idle', detail: '' };
            changed += 1;
          }
          if (changed > 0) emit();
          return changed;
        }

        function setAuthRequired(topic, required) {
          var name = normalizeTopic(topic);
          if (!name) return;
          if (!isSubscribed(name)) return;
          var created = ensureTopicInternal(name);
          var next = required === true;
          var changed = (state.authByTopic[name] === true) !== next;
          if (changed) state.authByTopic[name] = next;
          if (created || changed) emit();
        }

        /** 该主题目前是否在訂閱清單里。 @param topic - 主题名。 @returns 是否已訂閱。 */
        function isSubscribed(topic) {
          return state.topics.indexOf(topic) !== -1;
        }

        function clearMessages(topic) {
          var name = normalizeTopic(topic);
          if (!name) return;
          var created = ensureTopicInternal(name);
          var hadMessages = (state.messagesByTopic[name] || []).length > 0;
          var hadUnread = (state.unreadByTopic[name] || 0) > 0;
          state.messagesByTopic[name] = [];
          state.unreadByTopic[name] = 0;
          if (created || hadMessages || hadUnread) emit();
        }

        function markRead(topic) {
          var name = normalizeTopic(topic);
          if (!name) return;
          var created = ensureTopicInternal(name);
          var hadUnread = (state.unreadByTopic[name] || 0) > 0;
          if (hadUnread) state.unreadByTopic[name] = 0;
          if (created || hadUnread) emit();
        }


        return {
          getSnapshot: getSnapshot,
          subscribe: subscribe,
          ensureTopic: ensureTopic,
          pinTopicFirst: pinTopicFirst,
          removeTopic: removeTopic,
          setActiveTopic: setActiveTopic,
          addMessages: addMessages,
          addMessage: addMessage,
          setStatus: setStatus,
          clearStatuses: clearStatuses,
          setAuthRequired: setAuthRequired,
          clearMessages: clearMessages,
          markRead: markRead,
          markReadToLatest: markReadToLatest,
          setViewHooks: setViewHooks,
        };
      }

      var store = createStore();

      /* -------------------------------------------------------- Markdown 解析 */

      // 解析结果是给 UI **逐节点渲染** 的资料结构，永远不产出 HTML 字串：
      // <script> / <img onerror=…> 之类只会变成普通 text 节点，UI 用文字渲染，不会被当成元素。
      //
      // 与契约一致的取舍（如有出入以 contract 为准）：
      //   - '####' 以上一律夹到 level 3（没有 level 4+）；
      //   - 段落由连续非空行组成、行间用 '\n' 连接，遇到空行或下一个块级起始行结束；
      //   - 列表项只吃单行（不做 lazy continuation / 多行项）；
      //   - 只认三个以上反引号的围栏（不支援 '~~~'）；
      //   - 只有 http:// 与 https:// 能变成 link 节点，其余（javascript: / data: /
      //     file: / 相对路径 / 空）整段降级成 text 节点 —— 这是安全要求。

      /** 递归深度上限：避免畸形输入（上万层引用 / 巢状标记）把呼叫栈打穿。 */
      var MD_MAX_BLOCK_DEPTH = 24;
      var MD_MAX_INLINE_DEPTH = 24;

      /* 全部在模组建置期编译一次，循环内不重建 regex（效能契约第 10 条）。 */
      var MD_LINE_BREAK = /\r\n|\n|\r/;
      var MD_LEADING_WS = /^\s+/;
      var MD_FENCE_OPEN = /^\s{0,3}(`{3,})[ \t]*([^\s`]*)(?:[ \t].*)?$/;
      var MD_FENCE_CLOSE = /^\s{0,3}(`{3,})[ \t]*$/;
      var MD_HR = /^\s{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
      var MD_HEADING = /^\s{0,3}(#{1,6})(?:[ \t]+(.*))?[ \t]*$/;
      var MD_HEADING_TAIL = /[ \t]+#+[ \t]*$/;
      var MD_QUOTE = /^\s{0,3}>[ \t]?(.*)$/;
      var MD_LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?[ \t]*$/;
      var MD_ORDERED_ITEM = /^\d/;
      /** 表格分隔列：| --- | :--: | 之类。至少要有一个 '-'。 */
      var MD_TABLE_DELIM = /^\s{0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
      /** 表格资料列：一定要有 '|'，否则会被当成普通段落。 */
      var MD_TABLE_ROW = /\|/;
      var MD_SAFE_HREF = /^https?:\/\//i;
      var MD_HREF_UNSAFE_CHARS = /[\s\u0000-\u001f\u007f]/;
      /** inline 快速通道：整段没有任何标记字元时，直接一个 text 节点。 */
      var MD_INLINE_SPECIALS = /[`\[\]*_~]/;

      /** 字串重复（不用 String.prototype.repeat，保持保守写法）。 */
      function mdRepeat(text, count) {
        var out = '';
        for (var i = 0; i < count; i++) out += text;
        return out;
      }

      /** 从 start 起连续相同的字元数（反引号 run 用）。 */
      function mdRunLength(text, start, ch) {
        var n = 0;
        while (start + n < text.length && text.charAt(start + n) === ch) n++;
        return n;
      }

      /**
       * 带「失败记忆」的 indexOf。
       * 对同一个 needle，一旦从 from 起找不到，之后任何 from' >= from 都必然找不到，
       * 直接短路 —— 这让「除了一堆 [ 或 * 之外什么都没有」的恶意输入保持 O(n)，
       * 而不是每个字元都重扫一次尾巴的 O(n²)。
       */
      function mdFind(scanner, needle, from) {
        var failedAt = scanner.failed[needle];
        if (failedAt !== undefined && from >= failedAt) return -1;
        var at = scanner.text.indexOf(needle, from);
        if (at === -1) {
          scanner.failed[needle] = from;
          return -1;
        }
        return at;
      }

      /** 找「长度恰好等于 run」的反引号 run；找不到回 -1。 */
      function mdFindBacktickClose(scanner, from, run) {
        var needle = mdRepeat('`', run);
        var at = from;
        while (at <= scanner.text.length) {
          var found = mdFind(scanner, needle, at);
          if (found === -1) return -1;
          var before = found > 0 ? scanner.text.charAt(found - 1) : '';
          var afterIndex = found + run;
          var after = afterIndex < scanner.text.length ? scanner.text.charAt(afterIndex) : '';
          if (before !== '`' && after !== '`') return found;
          at = found + run;
        }
        return -1;
      }

      /** 安全连结：只有 http:// 与 https://，且不含空白 / 控制字元才算数。 */
      function mdIsSafeHref(href) {
        if (typeof href !== 'string') return false;
        var value = href.trim();
        if (!value) return false;
        if (!MD_SAFE_HREF.test(value)) return false;
        if (MD_HREF_UNSAFE_CHARS.test(value)) return false;
        return true;
      }

      /** inline 解析的保底包装：任何内部错误都退回「整段字面文字」，形状永远合法。 */
      function parseInlineSafe(text, depth) {
        try {
          return parseInline(text, depth);
        } catch (e) {
          return text ? [{ type: 'text', text: text }] : [];
        }
      }

      /** 解析子 inline（strong / em / del / link 的内容）；超过深度上限就保持字面。 */
      function parseInlineChildren(text, depth) {
        if (depth + 1 >= MD_MAX_INLINE_DEPTH) {
          return text ? [{ type: 'text', text: text }] : [];
        }
        return parseInlineSafe(text, depth + 1);
      }

      /**
       * inline 解析：从左到右单次扫描，每个位置依序尝试
       * 反引号 code → 连结 → **strong** / __strong__ → *em* / _em_ → ~~del~~。
       * 不成对的标记一律当字面文字，绝不吞掉。
       */
      function parseInline(text, depth) {
        var out = [];
        if (typeof text !== 'string' || !text) return out;
        if (!MD_INLINE_SPECIALS.test(text)) return [{ type: 'text', text: text }];
        var scanner = { text: text, failed: {} };
        var n = text.length;
        var i = 0;
        var buffer = '';

        function flush() {
          if (buffer) {
            out.push({ type: 'text', text: buffer });
            buffer = '';
          }
        }

        while (i < n) {
          var ch = text.charAt(i);

          // 1. code span 最先：里面的 ** / [ ] 一律字面
          if (ch === '`') {
            var run = mdRunLength(text, i, '`');
            var closeAt = mdFindBacktickClose(scanner, i + run, run);
            if (closeAt !== -1) {
              flush();
              out.push({ type: 'code', text: text.slice(i + run, closeAt) });
              i = closeAt + run;
            } else {
              buffer += text.slice(i, i + run);
              i += run;
            }
            continue;
          }

          // 2. 连结 [text](href)：href 不在白名单就整段降级成字面
          if (ch === '[') {
            var labelEnd = mdFind(scanner, '](', i + 1);
            if (labelEnd === -1) {
              buffer += '[';
              i++;
              continue;
            }
            var hrefEnd = mdFind(scanner, ')', labelEnd + 2);
            if (hrefEnd === -1) {
              // 后面再也不可能出现 ')': 剩下全部当字面，一次收尾（同时避免 O(n²)）
              buffer += text.slice(i);
              i = n;
              continue;
            }
            var href = text.slice(labelEnd + 2, hrefEnd).trim();
            if (!mdIsSafeHref(href)) {
              buffer += text.slice(i, hrefEnd + 1);
              i = hrefEnd + 1;
              continue;
            }
            flush();
            out.push({
              type: 'link',
              href: href,
              children: parseInlineChildren(text.slice(i + 1, labelEnd), depth)
            });
            i = hrefEnd + 1;
            continue;
          }

          // 3. strong / em
          if (ch === '*' || ch === '_') {
            var doubled = text.charAt(i + 1) === ch;
            var marker = doubled ? ch + ch : ch;
            var innerEnd = -1;
            if (depth < MD_MAX_INLINE_DEPTH) {
              innerEnd = mdFind(scanner, marker, i + marker.length);
            }
            if (innerEnd > i + marker.length) {
              flush();
              out.push({
                type: doubled ? 'strong' : 'em',
                children: parseInlineChildren(text.slice(i + marker.length, innerEnd), depth)
              });
              i = innerEnd + marker.length;
            } else {
              buffer += marker;
              i += marker.length;
            }
            continue;
          }

          // 4. del
          if (ch === '~' && text.charAt(i + 1) === '~') {
            var delEnd = -1;
            if (depth < MD_MAX_INLINE_DEPTH) delEnd = mdFind(scanner, '~~', i + 2);
            if (delEnd > i + 2) {
              flush();
              out.push({ type: 'del', children: parseInlineChildren(text.slice(i + 2, delEnd), depth) });
              i = delEnd + 2;
            } else {
              buffer += '~~';
              i += 2;
            }
            continue;
          }

          buffer += ch;
          i++;
        }

        flush();
        return out;
      }

      /** 摊平 inline 节点为纯文字（预览 / 通知文案用）；畸形输入回传 ''。 */
      function inlineToText(inline) {
        if (!Array.isArray(inline)) return '';
        var out = '';
        for (var i = 0; i < inline.length; i++) {
          var node = inline[i];
          if (!node || typeof node !== 'object') continue;
          if (node.type === 'text' || node.type === 'code') {
            out += typeof node.text === 'string' ? node.text : '';
          } else if (node.type === 'strong' || node.type === 'em' || node.type === 'del' || node.type === 'link') {
            out += inlineToText(node.children);
          }
        }
        return out;
      }

      /**
       * 这行第一个非空白字元；' \t' 之外的前导空白超过 3 个就代表缩排太深，回 ''。
       * 用它当块级判定的快速闸门，避免每一行都跑 5 个 regex。
       */
      function mdFirstChar(line) {
        var limit = line.length < 4 ? line.length : 4;
        for (var k = 0; k < limit; k++) {
          var ch = line.charAt(k);
          if (ch !== ' ' && ch !== '\t') return ch;
        }
        return '';
      }

      /** 这一行会不会开启一个新的块级元素（段落续行判断用）。 */
      function mdStartsBlock(line) {
        var first = mdFirstChar(line);
        if (first === '`') return MD_FENCE_OPEN.test(line);
        if (first === '#') return MD_HEADING.test(line);
        if (first === '>') return MD_QUOTE.test(line);
        if (first === '|') return true;
        if (first === '-') return MD_HR.test(line) || MD_LIST.test(line);
        if (first === '*') return MD_HR.test(line) || MD_LIST.test(line);
        if (first === '+') return MD_LIST.test(line);
        if (first === '_') return MD_HR.test(line);
        if (first >= '0' && first <= '9') return MD_LIST.test(line);
        return false;
      }

      /**
       * 把一行拆成表格格子。
       *
       * 前后的空白与最外层那一对 '|' 会被去掉（GFM 允许省略最外侧的竖线）。
       * 刻意**不**处理 '\|' 转义：内文很少需要，而且要多一层扫描；
       * 代价是内容里真的有 '|' 时会被当成格子分隔 —— 用全形 ｜ 或程式码区块。
       *
       * @param line - 一行文字。
       * @returns 格子字串阵列。
       */
      function mdSplitTableRow(line) {
        var s = line.trim();
        if (s.charAt(0) === '|') s = s.slice(1);
        if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
        var parts = s.split('|');
        var out = [];
        for (var i = 0; i < parts.length; i++) out.push(parts[i].trim());
        return out;
      }

      /** 一格分隔符 → 对齐方式。 @param cell - 例如 ':---:'。 @returns 'left'|'center'|'right'|''。 */
      function mdTableAlign(cell) {
        var c = cell.trim();
        var left = c.charAt(0) === ':';
        var right = c.charAt(c.length - 1) === ':';
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return '';
      }

      /**
       * 试着从 lines[start] 开始解析一个 GFM 表格。
       *
       * 判定刻意严格 —— 抬头与分隔列的**格数必须一致**，而且每个分隔格都必须是
       * `:?-+:?`。少了这层检查，「普通段落 / ---|--- / 另一段」也会被误判成表格。
       *
       * @param lines - 全部行。
       * @param start - 起始索引。
       * @returns {node, next}，不是表格时回 null。
       */
      function mdTryTable(lines, start) {
        var headLine = lines[start];
        if (!headLine || headLine.indexOf('|') === -1) return null;
        var delimLine = lines[start + 1];
        if (!delimLine || delimLine.indexOf('|') === -1) return null;
        if (!MD_TABLE_DELIM.test(delimLine)) return null;

        var headCells = mdSplitTableRow(headLine);
        var delimCells = mdSplitTableRow(delimLine);
        if (headCells.length === 0 || delimCells.length !== headCells.length) return null;

        var aligns = [];
        for (var d = 0; d < delimCells.length; d++) {
          if (!/^:?-+:?$/.test(delimCells[d])) return null;
          aligns.push(mdTableAlign(delimCells[d]));
        }

        var head = [];
        for (var h = 0; h < headCells.length; h++) head.push(parseInlineSafe(headCells[h], 0));

        var rows = [];
        var r = start + 2;
        while (r < lines.length) {
          var rowLine = lines[r];
          if (!rowLine || !rowLine.trim() || rowLine.indexOf('|') === -1) break;
          var cells = mdSplitTableRow(rowLine);
          // 多出来的格子丢掉、少掉的补空，让每一列与抬头同宽 ——
          // 否则 <table> 会自己长出参差不齐的格子。
          var rowInline = [];
          for (var c = 0; c < headCells.length; c++) {
            rowInline.push(parseInlineSafe(c < cells.length ? cells[c] : '', 0));
          }
          rows.push(rowInline);
          r++;
        }

        return { node: { type: 'table', align: aligns, head: head, rows: rows }, next: r };
      }

      /** 把 lines 解析成 blocks 追加到 out；depth 为巢状引用深度。 */
      function parseBlocksInto(lines, out, depth) {
        var i = 0;
        var total = lines.length;

        while (i < total) {
          var line = lines[i];

          // 空行：块分隔符
          if (!line || !line.trim()) {
            i++;
            continue;
          }

          // 快速闸门：用首字元决定要试哪几个块级 regex（普通段落一行 regex 都不跑）
          var firstChar = mdFirstChar(line);

          // 1. 围栏程式码：内容逐字保留（含空行与缩排）；收尾围栏可以缺席
          if (firstChar === '`') {
            var fence = MD_FENCE_OPEN.exec(line);
            if (fence) {
              var fenceMarker = fence[1];
              var lang = fence[2] || '';
              var content = [];
              var j = i + 1;
              var closed = false;
              while (j < total) {
                var closing = MD_FENCE_CLOSE.exec(lines[j]);
                if (closing && closing[1].length >= fenceMarker.length) {
                  closed = true;
                  break;
                }
                content.push(lines[j]);
                j++;
              }
              out.push({ type: 'code', lang: lang, text: content.join('\n') });
              i = closed ? j + 1 : j;
              continue;
            }
          }

          // 1.5 表格（GFM）
          var table = mdTryTable(lines, i);
          if (table) {
            out.push(table.node);
            i = table.next;
            continue;
          }

          // 2. 分隔线
          if (firstChar === '-' || firstChar === '*' || firstChar === '_') {
            if (MD_HR.test(line)) {
              out.push({ type: 'hr' });
              i++;
              continue;
            }
          }

          // 3. 标题（#### 以上夹到 level 3）
          if (firstChar === '#') {
            var heading = MD_HEADING.exec(line);
            if (heading) {
              var level = heading[1].length;
              if (level > 3) level = 3;
              var title = heading[2] === undefined ? '' : heading[2].replace(MD_HEADING_TAIL, '');
              out.push({ type: 'heading', level: level, inline: parseInlineSafe(title, 0) });
              i++;
              continue;
            }
          }

          // 4. 引用：内容递归解析，所以引用里的列表 / 程式码 / 分隔线都成立
          if (firstChar === '>') {
            var quoted = [];
            while (i < total) {
              var quoteMatch = MD_QUOTE.exec(lines[i]);
              if (!quoteMatch) break;
              quoted.push(quoteMatch[1]);
              i++;
            }
            var inner = [];
            if (depth >= MD_MAX_BLOCK_DEPTH) {
              inner.push({ type: 'para', inline: parseInlineSafe(quoted.join('\n'), 0) });
            } else {
              parseBlocksInto(quoted, inner, depth + 1);
            }
            out.push({ type: 'blockquote', blocks: inner });
            continue;
          }

          // 5. 列表：同一种有序性才算同一个 list；空行或非项行结束
          if (firstChar === '-' || firstChar === '*' || firstChar === '+' ||
            (firstChar >= '0' && firstChar <= '9')) {
            var listMatch = MD_LIST.exec(line);
            if (listMatch) {
              var ordered = MD_ORDERED_ITEM.test(listMatch[1]);
              var items = [];
              while (i < total) {
                var itemMatch = MD_LIST.exec(lines[i]);
                if (!itemMatch) break;
                if (MD_ORDERED_ITEM.test(itemMatch[1]) !== ordered) break;
                var itemText = itemMatch[2] === undefined ? '' : itemMatch[2];
                items.push(parseInlineSafe(itemText, 0));
                i++;
              }
              out.push({ type: 'list', ordered: ordered, items: items });
              continue;
            }
          }

          // 6. 段落：连续非空行，行间用 '\n'；空行或块级起始行结束这一段
          var paraLines = [line];
          i++;
          while (i < total) {
            var nextLine = lines[i];
            if (!nextLine || !nextLine.trim()) break;
            if (mdStartsBlock(nextLine)) break;
            paraLines.push(nextLine);
            i++;
          }
          out.push({ type: 'para', inline: parseInlineSafe(paraLines.join('\n'), 0) });
        }
      }

      /**
       * 解析 Markdown 子集 → 块阵列。永不抛异常：
       * null / undefined / 空字串 → []；其余输入一律回传形状合法的节点。
       */
      function parseMarkdown(src) {
        if (src === null || src === undefined) return [];
        var text;
        try {
          text = typeof src === 'string' ? src : String(src);
        } catch (e) {
          return [];
        }
        if (!text) return [];
        var blocks = [];
        try {
          parseBlocksInto(text.split(MD_LINE_BREAK), blocks, 0);
        } catch (e) {
          /* 已经解析出来的部分照常回传（形状仍然合法） */
        }
        return blocks;
      }

      /* -------------------------------------------------------- 发送者身份 */

      // 群聊约定（与 UI 谈定）：ntfy 的 title 带发送者，**现行格式为 '#shawoo'**。
      // 显示名称存在 config.identity（字串，默认空）。只有 setIdentity 会写储存。
      //
      // 历史上这个外挂用过 '@shawoo'。已经把 '@' 换成 '#'，但**解析仍然接受 '@'**，
      // 这样旧主题里既有的訊息不会突然变成「未具名成員」；新送出的訊息一律用 '#'。

      /** 现行发送者前缀。 */
      var SENDER_SIGIL = '#';

      /** 兼容用的旧前缀（只影响解析，不会再用它送出）。 */
      var LEGACY_SIGILS = ['#', '@'];

      /**
       * 归一化显示名称：去空白、去掉开头的发送者前缀（'#'，兼容旧的 '@'）。
       * @param value - 任何值。
       * @returns 纯名称（不含前缀）。
       */
      function normalizeIdentity(value) {
        if (value === null || value === undefined) return '';
        var text;
        try {
          text = typeof value === 'string' ? value : String(value);
        } catch (e) {
          return '';
        }
        text = text.trim();
        // 只吃最前面那一个前缀字元，多余的前缀（例如 '##x'）交给下一圈处理。
        while (text.length > 0 && LEGACY_SIGILS.indexOf(text.charAt(0)) !== -1) {
          text = text.slice(1).trim();
        }
        return text;
      }

      /**
       * 解析 ntfy 的 title：
       *   '#shawoo'  → { raw:'#shawoo', handle:'shawoo', isMention:true }
       *   '@shawoo'  → { raw:'@shawoo', handle:'shawoo', isMention:true }   // 旧格式仍可读
       *   '標題測試'  → { raw:'標題測試', handle:'', isMention:false }
       * raw 保留原始 title；isMention 只看「去掉前置空白后是否以前缀开头」。
       * @param title - ntfy 的 title 栏位。
       * @returns {{raw:string, handle:string, isMention:boolean}}
       */
      function parseIdentity(title) {
        var raw;
        try {
          raw = title === null || title === undefined ? '' : String(title);
        } catch (e) {
          raw = ''; // Symbol 之类 String() 会抛的输入
        }
        var trimmed = raw.replace(MD_LEADING_WS, '');
        var isMention = trimmed.length > 0 && LEGACY_SIGILS.indexOf(trimmed.charAt(0)) !== -1;
        var handle = isMention ? trimmed.slice(1).trim() : '';
        return { raw: raw, handle: handle, isMention: isMention };
      }

      /**
       * 显示名称 → ntfy title：'' → ''；'shawoo' / '#shawoo' / '@shawoo' → '#shawoo'
       * （幂等，永不 '##x'；旧的 '@' 输入会被正規化成 '#'）。
       * @param identity - 显示名称。
       * @returns 要放进 title 的字串。
       */
      function senderTitle(identity) {
        var name = normalizeIdentity(identity);
        return name ? SENDER_SIGIL + name : '';
      }

      /** 设定并持久化显示名称；回传实际存进去的值。 */
      function setIdentity(name) {
        var normalized = normalizeIdentity(name);
        saveConfig({ identity: normalized });
        return normalized;
      }

      /** 读取显示名称（可能为 ''）。 */
      function getIdentity() {
        return normalizeIdentity(readConfig().identity);
      }

      /* ------------------------------------------------------------ 错误描述 */

      /** 把网络层结果翻译成给用户看的中文提示（繁体，zh-TW）。 */
      function describeError(result) {
        if (!result) return '發生未知錯誤。';
        if (result instanceof Error) {
          return '發生錯誤：' + errorMessage(result);
        }
        var status = typeof result.status === 'number' && isFinite(result.status) ? result.status : 0;
        var detail = typeof result.error === 'string' ? result.error.trim() : '';

        // 实测（msn.feg.cn）：401 = 带了凭据但凭据错误；403 = 根本没带凭据 / 无权限。
        // 两种都算 authRequired，但提示文案区分开，用户才知道该“改密码”还是“填密码”。
        if (status === 401) {
          return '認證失敗（HTTP 401）：憑證無效，請檢查使用者名稱/密碼或存取權杖是否正確。';
        }
        if (status === 403) {
          return '需要認證（HTTP 403）：此主題需要憑證，請在設定中填寫使用者名稱/密碼或存取權杖後重試。';
        }
        if (result.authRequired === true) {
          return '認證失敗（HTTP ' + (status || 401) + '）：此主題需要憑證，請在設定中填寫使用者名稱/密碼或存取權杖後重試。';
        }
        if (status === 404) {
          return '伺服器回應 404：主題或位址不存在，請檢查伺服器位址與主題名稱。';
        }
        if (status === 429) {
          return '請求過於頻繁（HTTP 429）：請稍後再試。';
        }
        if (status >= 500) {
          return '伺服器內部錯誤（HTTP ' + status + '）：請稍後再試。';
        }
        if (status > 0) {
          return '請求失敗（HTTP ' + status + '）' + (detail ? '：' + detail : '。');
        }
        return '無法連線到 ntfy 伺服器' + (detail ? '（' + detail + '）' : '') + '，請檢查網路與伺服器位址。';
      }

      /* ---------------------------------------------------------------- 导出 */

      // 本档是「被 client.js 需要的那一半」，不是独立注册的 client module：
      // dsh.client 只允许一个 client 档案（exports["./client"]），而 combo script 会把
      // 每个 plugin 档案包成 lazy body —— 档案在「注册阶段」不会执行，所以「排在前面」
      // 并不代表已经执行完（实测过：面板会显示「核心模块未加载」）。
      //
      // 因此核心实作放在 moduleRoot() 里，由 client.js 的 factory 在 materialize 时
      // 主动呼叫，执行顺序与档案顺序完全无关。Node require() 仍然直接拿到 api。
      root.moduleRoot = function moduleRoot() {
        var api = buildApi();
        root.__ntfyTeamsCore = api;
        return api;
      };
    /* build: Node 专属出口已移除（浏览器不会走到，且会与 factory 的 local `module` 冲突）。*/

      /* =================================================================== 实作 */

      /**
       * 把某一天的訊息整理成一段可以拿去復盤的材料。
       *
       * 這是「日復盤」的核心：使用者按某一天抬頭上的按鈕時，把那天在這個主題裡發生
       * 的事收斂成一段文字，交給另一個 session 分析。
       *
       * 純函式、不碰 UI，所以可以單獨測試。發送者名稱由呼叫方先解析好再傳進來
       * （`senderOf` 是 UI 層的概念，核心不該依賴它）。
       *
       * @param options - { topic, label, entries, notes }。
       *   entries: [{ name, clock, text }]；notes 是附加在最後的指示。
       * @returns { title, body, count }。
       */
      function buildDayReview(options) {
        var opts = options && typeof options === 'object' ? options : {};
        var topic = normalizeTopic(opts.topic);
        var label = typeof opts.label === 'string' && opts.label ? opts.label : '這一天';
        var entries = Array.isArray(opts.entries) ? opts.entries : [];
        var notes = Array.isArray(opts.notes) ? opts.notes : [];

        var lines = [];
        lines.push('幫我復盤 **' + label + '** 這一天在主題 `' + topic + '` 的討論。');
        lines.push('');
        lines.push('訊息數：' + entries.length);
        lines.push('');

        if (entries.length === 0) {
          lines.push('（這一天沒有訊息。）');
        } else {
          lines.push('## 當天訊息');
          lines.push('');
          for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (!entry || typeof entry !== 'object') continue;
            var name = typeof entry.name === 'string' && entry.name ? entry.name : '--';
            var clock = typeof entry.clock === 'string' ? entry.clock : '';
            var text = typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim() : '';
            if (text === '') text = '（無內文）';
            lines.push('- **' + name + '**' + (clock ? '（' + clock + '）' : '') + '：' + text);
          }
        }

        if (notes.length) {
          lines.push('');
          for (var n = 0; n < notes.length; n++) {
            if (typeof notes[n] === 'string' && notes[n]) lines.push(notes[n]);
          }
        }

        return { title: label + ' 復盤', body: lines.join('\n'), count: entries.length };
      }

      /**
       * 群組語意的標籤。用 ntfy 原生的 `Tags` 欄位承載，因此：
       *   * 別的客戶端／手機 App 也收得到（不會變成只有我看得見的狀態）；
       *   * 純文字客戶端最差也只是多看到幾個字，不會壞掉。
       */
      var MARKER_DECISION = 'decision';
      var MARKER_ACTION = 'action';
      var MARKER_DONE = 'done';
      /** 認得的標記（其餘 tag 一律當普通標籤，不做任何事）。 */
      var MARKER_TAGS = [MARKER_DECISION, MARKER_ACTION, MARKER_DONE];

      /** @param msg - 訊息。 @returns 這則訊息帶的群組標記（可能多個）。 */
      function markerTagsOf(msg) {
        var out = [];
        if (!msg || !Array.isArray(msg.tags)) return out;
        for (var i = 0; i < msg.tags.length; i++) {
          var t = String(msg.tags[i]).toLowerCase();
          if (MARKER_TAGS.indexOf(t) !== -1 && out.indexOf(t) === -1) out.push(t);
        }
        return out;
      }

      /**
       * 標記訊息的內文約定：`#<目標訊息 id>` 或 `#<目標訊息 id> 說明`。
       * 用 `#` 開頭是因為它跟發送者前綴同一個符號、在畫面上會被當成普通文字，
       * 而且不會跟 ntfy 的任何保留欄位衝突。
       *
       * @param msg - 標記訊息。
       * @returns { target, text }。
       */
      function parseMarkerBody(msg) {
        var raw = msg && msg.message !== null && msg.message !== undefined ? String(msg.message) : '';
        var body = raw.trim();
        if (body.charAt(0) === '#') body = body.slice(1).trim();
        var space = body.search(/\s/);
        if (space === -1) return { target: body, text: '' };
        return { target: body.slice(0, space), text: body.slice(space).trim() };
      }

      /**
       * 從一串訊息推導出「這個群組的決定與待辦」。
       *
       * 為什麼要推導而不是另存狀態：ntfy 沒有「改一則舊訊息」的能力，所以群組記憶
       * 只能是**新的訊息**。決定／待辦／完成都是額外的訊息，這裡把它們疊回原始訊息上，
       * 得到每個群組成員都算得出一樣的結果 —— 不需要任何資料庫。
       *
       * @param messages - 該主題的訊息（任何順序，內部會依 time 排）。
       * @returns { decisions: [{id, text}], actions: [{id, text, done, by}], openCount }。
       */
      function deriveMarkers(messages) {
        var list = Array.isArray(messages) ? messages.slice() : [];
        list = sortMessages(list.filter(function (m) { return m && typeof m === 'object'; }));

        var decisions = [];
        var actions = [];
        var byId = {};
        var seenDecision = {};
        var seenAction = {};

        for (var i = 0; i < list.length; i++) {
          var msg = list[i];
          var tags = markerTagsOf(msg);
          if (!tags.length) continue;
          var parsed = parseMarkerBody(msg);
          var target = parsed.target;
          if (!target) continue;

          if (tags.indexOf(MARKER_DECISION) !== -1 && !seenDecision[target]) {
            seenDecision[target] = true;
            decisions.push({ id: target, text: parsed.text, by: msg });
            byId[target] = true;
          }
          // 待辦以「標記訊息自己的 id」去重，不是以原始訊息 —— 同一則原始訊息
          // 可以有多筆待辦（例如「補文件」和「改註解」都掛在同一則上）。
          if (tags.indexOf(MARKER_ACTION) !== -1) {
            var actionKey = msg.id === null || msg.id === undefined ? target : String(msg.id);
            if (!seenAction[actionKey]) {
              seenAction[actionKey] = true;
              actions.push({
                id: target,
                markerId: actionKey,
                text: parsed.text,
                done: false,
                doneBy: null,
                by: msg
              });
              byId[target] = true;
            }
          }
          // 完成：把對應的待辦結案（後來的 done 覆蓋先前的）。
          // 指涉的是待辦那則標記訊息（`#<action 訊息的 id>`），不是原始訊息 ——
          // 同一則原始訊息可以有多個待辦，只認原始 id 會一次結掉全部。
          if (tags.indexOf(MARKER_DONE) !== -1) {
            for (var a = 0; a < actions.length; a++) {
              if (actions[a].markerId === target && actions[a].markerId !== '') {
                actions[a].done = true;
                actions[a].doneBy = msg;
              }
            }
          }
        }

        var open = 0;
        for (var k = 0; k < actions.length; k++) if (!actions[k].done) open += 1;

        return { decisions: decisions, actions: actions, openCount: open };
      }

      /**
       * 組一則標記訊息的身體：`#<目標 id>[ 說明]`。
       * @param targetId - 目標訊息 id。
       * @param note - 可選說明。
       * @returns 內文字串。
       */
      function markerBody(targetId, note) {
        var id = targetId === null || targetId === undefined ? '' : String(targetId).trim();
        if (!id) return '';
        var extra = note === null || note === undefined ? '' : String(note).trim();
        return extra === '' ? '#' + id : '#' + id + ' ' + extra;
      }

      /**
       * 把訂閱狀態收斂成一個「這個外掛現在怎麼樣」的結論，給側欄指示燈用。
       *
       * 為什麼要做成一個結論而不是把原始狀態丟給 UI：
       * 側欄只有一個小圖示的空間，但底下可能有好幾個主題、各自的連線階段不同。
       * 「三個主題裡有一個斷了」對使用者等於「有問題」，所以這裡先把多個主題收成
       * 單一結論，並依「使用者現在該不該在意」排序：
       *   等待重試 > 錯誤 > 未連線 > 連線中 > 未讀 > 已連線 > 尚未訂閱。
       *
       * 純函式，不碰 UI，所以連線狀態的判讀可以單獨測試。
       *
       * @param snapshot - store 的快照（{ topics, statusByTopic, authByTopic, unreadByTopic }）。
       * @returns { state, label, detail, unread, errorTopics, offlineTopics, connectingTopics }。
       *   state 為 'retrying' | 'error' | 'offline' | 'connecting' | 'unread' | 'live' | 'idle'。
       *   `live` 是**健康**的即時連線；`idle` **只**代表「一個主題都沒訂閱」
       *   （兩者曾經共用 `idle`，於是「SSE 正常」跟「什麼都沒有」看起來一樣）。
       */
      function sidebarHealth(snapshot) {
        var snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
        var topics = Array.isArray(snap.topics) ? snap.topics : [];
        var statusByTopic = snap.statusByTopic && typeof snap.statusByTopic === 'object' ? snap.statusByTopic : {};
        var authByTopic = snap.authByTopic && typeof snap.authByTopic === 'object' ? snap.authByTopic : {};

        var unread = 0;
        if (snap.unreadByTopic && typeof snap.unreadByTopic === 'object') {
          for (var uk in snap.unreadByTopic) {
            if (!Object.prototype.hasOwnProperty.call(snap.unreadByTopic, uk)) continue;
            var n = toFiniteNumber(snap.unreadByTopic[uk]);
            if (n !== null && n > 0) unread += n;
          }
        }

        var errorTopics = 0;
        var offlineTopics = 0;
        var connectingTopics = 0;
        var authedTopics = 0;
        // 正在等待重試的主題數，以及最近一次重試的時間點（毫秒）。
        // 為什麼要單獨算：重試中的主題 phase 也是 'error'，但它跟「放棄了」完全不同 ——
        // 前者是自己會好，後者要使用者動手。側欄圖示必須分得出來。
        var retryingTopics = 0;
        var nextRetryAt = 0;

        for (var i = 0; i < topics.length; i += 1) {
          var topic = topics[i];
          var raw = statusByTopic[topic];
          var phase = '';
          var retryAt = 0;
          if (typeof raw === 'string') phase = raw;
          else if (raw && typeof raw === 'object') {
            if (typeof raw.phase === 'string') phase = raw.phase;
            if (typeof raw.retryAt === 'number' && raw.retryAt > 0) retryAt = raw.retryAt;
          }

          if (authByTopic[topic] === true) authedTopics += 1;
          if (phase === 'error') {
            errorTopics += 1;
            if (retryAt > 0) {
              retryingTopics += 1;
              if (nextRetryAt === 0 || retryAt < nextRetryAt) nextRetryAt = retryAt;
            }
          } else if (phase === 'closed') offlineTopics += 1;
          else if (phase === 'connecting') connectingTopics += 1;
        }

        var total = topics.length;
        var state;
        var label;
        var detail;

        if (total === 0) {
          state = 'idle';
          label = '尚未訂閱主題';
          detail = '還沒有訂閱任何 ntfy 主題。';
        } else if (retryingTopics > 0) {
          // 重試中優先於「錯誤」：這些主題會自己好，不是要使用者動手的故障。
          // 圖示與文案都要讓人看得出來「它在努力」，而不是「它壞了」。
          state = 'retrying';
          var waitSec = nextRetryAt > 0 ? Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)) : 0;
          label = '等待重試' + (retryingTopics < total ? '（' + retryingTopics + '／' + total + '）' : '');
          detail = retryingTopics + ' 個主題連線失敗，' + (waitSec > 0 ? waitSec + ' 秒後重試' : '即將重試');
        } else if (errorTopics > 0) {
          state = 'error';
          label = errorTopics === total ? '全部主題連線失敗' : errorTopics + ' 個主題連線失敗';
          detail = errorTopics + '／' + total + ' 個主題連線失敗，請檢查伺服器位址或認證。';
        } else if (offlineTopics > 0) {
          state = 'offline';
          label = offlineTopics === total ? '未連線' : offlineTopics + ' 個主題未連線';
          detail = offlineTopics + '／' + total + ' 個主題未連線，正在等待重連。';
        } else if (connectingTopics > 0) {
          state = 'connecting';
          label = '連線中' + (connectingTopics < total ? '（' + connectingTopics + '／' + total + '）' : '');
          detail = '正在與 ntfy 建立連線…';
        } else if (unread > 0) {
          // 有未讀代表連線正常、而且真的收到了東西 —— 這是最健康的一種狀態。
          state = 'unread';
          label = unread + ' 則新訊息';
          detail = '已連線，有 ' + unread + ' 則未讀訊息。';
        } else {
          // 連線正常、沒有未讀 —— 這是**健康的即時連線**，不是「閒置」。
          //
          // 命名很重要：這裡原本叫 'idle'，而「尚未訂閱主題」也用 'idle'，
          // 於是「SSE 正常掛著」跟「什麼都沒有」在畫面上長得一模一樣。
          // 使用者看到「閒置」就會合理懷疑「是不是沒有在用 SSE／是不是在輪詢」。
          // 所以健康狀態獨立叫 'live'，'idle' 只留給「真的什麼都沒有」。
          state = 'live';
          label = '已連線';
          detail = 'SSE 已連線，' + total + ' 個主題'
            + (authedTopics > 0 ? '（' + authedTopics + ' 個需要認證）' : '') + '，沒有未讀。';
        }

        return {
          state: state,
          label: label,
          detail: detail,
          unread: unread,
          total: total,
          errorTopics: errorTopics,
          offlineTopics: offlineTopics,
          connectingTopics: connectingTopics,
          retryingTopics: retryingTopics,
          nextRetryAt: nextRetryAt,
          authRequired: authedTopics > 0
        };
      }

      /**
       * 訂閱主題數量的上限。
       *
       * 每個主題都是一條常駐 SSE 連線；而且側欄的未讀匯總只有在數量少的時候才讀得懂。
       * 這是產品決定，不是技術限制，所以集中在這裡當單一來源。
       */
      var MAX_TOPICS = 8;

      /**
       * 預設訂閱的主題與它的顯示名稱。
       *
       * 新使用者第一次開啟時就有東西可看，不必先自己找一個主題名。
       * 只在「從未設定過」時播種一次（見 client 的 ensureDefaultTopic），
       * 使用者之後把它刪掉就不會再被塞回來。
       */
      var DEFAULT_TOPIC = 'pub_dsh';
      var DEFAULT_TOPIC_ALIAS = 'AIFE';


      /**
       * 現在能不能再加一個主題？
       *
       * 已經訂閱的主題不算「新增」—— 重複輸入同一個名字不該被擋（那是 no-op）。
       *
       * @param topics - 目前的訂閱清單。
       * @param candidate - 想加入的主題名。
       * @returns { ok, reason?, count, limit }。
       */
      function canSubscribe(topics, candidate) {
        var list = Array.isArray(topics) ? topics : [];
        var name = normalizeTopic(candidate);
        if (!name) {
          return { ok: false, reason: '主題名稱不能為空。', count: list.length, limit: MAX_TOPICS };
        }
        if (list.indexOf(name) !== -1) {
          return { ok: true, count: list.length, limit: MAX_TOPICS };
        }
        if (list.length >= MAX_TOPICS) {
          return {
            ok: false,
            reason: '最多只能訂閱 ' + MAX_TOPICS + ' 個主題（目前已有 ' + list.length + ' 個），請先取消一個再新增。',
            count: list.length,
            limit: MAX_TOPICS
          };
        }
        return { ok: true, count: list.length, limit: MAX_TOPICS };
      }

      /**
       * 把字串裡的**預設伺服器位址**換掉，避免它出現在使用者看得到的地方。
       *
       * 為什麼要做這一層：預設伺服器（`https://msn.feg.cn`）在這個部署裡是「管理者
       * 提供的後端」，不該讓一般使用者知道主機名。但位址會從很多地方漏出去 ——
       * tooltip、輸入框的值、錯誤訊息、主機名欄位 —— 逐一去擋很容易漏。
       * 所以提供一個統一的字串清洗函式，UI 在顯示前都過一次。
       *
       * 只換預設伺服器：使用者自己填的伺服器不該被藏（那是他的設定）。
       *
       * @param value - 任何要顯示的字串。
       * @param replacement - 取代後要顯示什麼（預設「伺服器」）。
       * @returns 清洗後的字串。
       */
      function redactDefaultServer(value, replacement) {
        var s = String(value === null || value === undefined ? '' : value);
        if (s === '') return s;
        var fallback = normalizeServer(DEFAULT_SERVER) || DEFAULT_SERVER;
        var host = '';
        var m = /^https?:\/\/([^/?#]+)/i.exec(fallback);
        if (m) host = m[1];
        var out = s;
        // 由長到短替換：先換完整 URL，再換主機名（避免先換主機名後留下 `https://伺服器`）
        if (fallback) out = out.split(fallback).join(replacement || '伺服器');
        if (host) {
          out = out.split('https://' + host).join(replacement || '伺服器');
          out = out.split('http://' + host).join(replacement || '伺服器');
          out = out.split(host).join(replacement || '伺服器');
        }
        return out;
      }

      /** 组装对外 API 物件；浏览器与 Node 走同一份。 */
      function buildApi() {
        return {
          // 常量
          CONFIG: CONFIG,
          AUTH_MODES: AUTH_MODES,
          DEFAULT_SERVER: DEFAULT_SERVER,
          SOURCE: SOURCE,

          // 配置与凭据
          readConfig: readConfig,
          saveConfig: saveConfig,
          loadCredentials: loadCredentials,
          saveCredentials: saveCredentials,
          setCredentials: setCredentials,
          clearCredentials: clearCredentials,
          credentialServers: credentialServers,
          normalizeCredential: normalizeCredential,

          // 基础工具
          normalizeServer: normalizeServer,
          topicUrl: topicUrl,
          decodeId: decodeId,
          sortMessages: sortMessages,
          mergeMessages: mergeMessages,
          authHeaders: authHeaders,

          // 协议解析
          parseServerMessage: parseServerMessage,
          parseTimeline: parseTimeline,
          parseSseEvent: parseSseEvent,

          // 网络
          fetchTopicMessages: fetchTopicMessages,
          publishMessage: publishMessage,
          testConnection: testConnection,
          subscribeTopic: subscribeTopic,
          subscribeTopics: subscribeTopics,

          // 仓库
          store: store,

          // Markdown（纯逻辑，永不抛异常）
          parseMarkdown: parseMarkdown,
          inlineToText: inlineToText,

          // 日復盤材料（纯逻辑）
          buildDayReview: buildDayReview,

          // 側欄健康狀態（纯逻辑）
          sidebarHealth: sidebarHealth,

          // 訂閱上限（纯逻辑）
          MAX_TOPICS: MAX_TOPICS,
          canSubscribe: canSubscribe,

          // 預設訂閱的主題（纯逻辑）
          DEFAULT_TOPIC: DEFAULT_TOPIC,
          DEFAULT_TOPIC_ALIAS: DEFAULT_TOPIC_ALIAS,

          // 群組語意：決定／待辦（走原生 Tags，全群可見）
          MARKER_TAGS: MARKER_TAGS,
          markerTagsOf: markerTagsOf,
          markerBody: markerBody,
          deriveMarkers: deriveMarkers,

          // 发送者身份
          parseIdentity: parseIdentity,
          senderTitle: senderTitle,
          setIdentity: setIdentity,
          getIdentity: getIdentity,

          // 主题别名（空别名 = 用主题名）
          topicLabel: topicLabel,
          setTopicAlias: setTopicAlias,
          setTopicAliases: setTopicAliases,

          // 看板寬度（夾在合法範圍內）
          clampDashboardWidth: clampDashboardWidth,

          // 自動回應（/approve session → /approve）
          autoApproveDecision: autoApproveDecision,
          setAutoApprove: setAutoApprove,
          markAutoApproveReplied: markAutoApproveReplied,
          AUTO_APPROVE_TRIGGER: AUTO_APPROVE_TRIGGER,
          AUTO_APPROVE_TAG: AUTO_APPROVE_TAG,
          AUTO_APPROVE_REPLY: AUTO_APPROVE_REPLY,

          // 永遠滾到最新（每個主題一份開關）
          setStayAtBottom: setStayAtBottom,
          normalizeStayAtBottom: normalizeStayAtBottom,

          // 错误描述
          describeError: describeError,

          // 隱藏預設伺服器位址（給 UI 顯示前清洗字串用）
          redactDefaultServer: redactDefaultServer
        };
      }
    })(typeof globalThis !== 'undefined' ? globalThis : this);

    // 启动内嵌的协议层：拿回 API（同时让 window.__ntfyTeamsCore 可观察）。
    var core = root.moduleRoot();
// ===== end of inlined lib/core.js =====
    // @@CORE_END@@

    var inject = ['slots', 'layout', 'uiWorkspace'];

    /** 座位 id：sidebar.panellist 的 id 与 main 的 key 必须是同一个字串。 */
    var PANEL_ID = 'ntfy-teams';
    var PANEL_LABEL = '團隊協同';

    // =========================================================================
    // 0. 纯工具
    // =========================================================================

    /** 两位数补零。 @param n - 数字。 @returns '00'..'99'。 */
    function pad2(n) {
      return n < 10 ? '0' + n : String(n);
    }

    /**
     * unix 秒 → 本地时间字串。今天的訊息只显示时分秒，其余补上日期。
     * @param seconds - unix 秒；非有限数时回空字串。
     * @returns 显示用时间字串。
     */
    function formatTime(seconds) {
      if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return '';
      var d = new Date(seconds * 1000);
      var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
      var now = new Date();
      var sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
      if (sameDay) return hm;
      return pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) + ' ' + hm;
    }

    /**
     * 由 ntfy id 推出时间（id 是 8 位大端 unix 奈秒的 base64url）。
     * @param id - ntfy message id。
     * @returns unix 秒，取不到时回 null。
     */
    function decodeTime(id) {
      if (!core || typeof core.decodeId !== 'function') return null;
      try {
        return core.decodeId(id);
      } catch (err) {
        return null;
      }
    }

    /**
     * 訊息时间：优先后端给的 time，退回由 id 推算。
     * @param msg - 正规化后的訊息。
     * @returns unix 秒或 null。
     */
    function messageTime(msg) {
      if (msg && typeof msg.time === 'number' && msg.time > 0) return msg.time;
      return msg ? decodeTime(msg.id) : null;
    }

    /** @param value - 任何值。 @returns 字串（永不为 undefined）。 */
    function text(value) {
      if (typeof value === 'string') return value;
      if (value === null || value === undefined) return '';
      return String(value);
    }

    /**
     * 只留下 http/https 的连结，避免把 javascript: 之类的东西变成可点的 <a>。
     * @param raw - 原始 URL。
     * @returns 安全的 URL，或空字串。
     */
    function safeHref(raw) {
      var s = text(raw).trim();
      if (!/^https?:\/\//i.test(s)) return '';
      return s;    }

    /** 取出伺服器主机名。 @param server - 伺服器 URL。 @returns host。 */
    function serverHost(server) {
      var s = text(server);
      var m = /^https?:\/\/([^/?#]+)/i.exec(s);
      return m ? m[1] : s;
    }

    // =========================================================================
    // 0b. 工作群組：身分（#username）
    //
    // 約定：訊息的 title 欄位放「傳送者」，**現行格式為 #username**。送出的訊息標題
    // 就是本人的 #username；收到的訊息若標題是 #xxx，就顯示成該成員發的。
    // 沒有 `#` 開頭的 title 就不算發送者（連別的內容的標題也算），顯示時留白，
    // 不會標示「未具名」。
    //
    // 歷史上用過 @username。解析仍然接受 '@'（舊訊息不會變成未具名），但**顯示與
    // 送出都用 '#'**，所以同一個主題裡的舊訊息也會被正規化成 #xxx 呈現。
    // =========================================================================

    /** 成员名称的上限长度，避免有人塞一整个段落进 title。 */
    var HANDLE_MAX = 32;

    /** 现行的发送者前缀。 */
    var SIGIL = '#';

    /** 解析时接受的前缀（含历史格式）。 */
    var SIGILS = ['#', '@'];

    /**
     * 沒有發送者時顯示的名稱。
     * 用 `--` 而不是留白或「未具名成員」：版面格式與其他訊息一致，一眼就知道是空的。
     */
    var ANON_NAME = '--';

    /**
     * 宿主那條「建立帶著討論內容的工作階段」路由。
     * 與 lib/index.js 的 ROUTE_PATH 必須一致（宿主沒掛上時會回 404 → 走降級路徑）。
     */
    var SEED_SESSION_PATH = '/ntfy-teams/session';

    /**
     * 寫回宿主 YAML 的 debounce 計時器（見 saveSubscriptions）。
     * 訂閱清單一改就會走好幾次 store 更新，合成一次寫入即可。
     */
    var hostSaveTimer = null;

    /**
     * 首次從宿主載入設定是否已完成。
     *
     * 在它變成 true 之前，**不準把設定寫回宿主** —— 那時 store 可能還是空的，
     * 送出去的 topics 會把宿主的完整清單覆蓋掉（詳見 pushSettingsToHost）。
     */
    var initialSyncDone = false;

    /**
     * 首次同步期間有沒有被擋下的寫入。同步完成後若有，就補送一次，
     * 這樣使用者「開機第一個動作」不會白做（被擋下 ≠ 被丟掉）。
     */
    var initialSyncPending = false;

    /**
     * 首次同步期間的寫入請求：還沒同步完就先記下來，等同步完成補送。
     *
     * 為什麼不直接丟掉：使用者在面板剛開、宿主還沒回來的幾百毫秒內真的可能操作
     * （新增／取消訂閱），丟掉就等於他的動作沒生效。
     *
     * @returns 是否真的送出（false = 已排隊）。
     */
    function requestHostWrite() {
      if (!initialSyncDone) {
        initialSyncPending = true;
        return false;
      }
      saveTopicsToHost();
      return true;
    }

    /**
     * 立刻把設定寫回宿主（**不 debounce**）。
     *
     * 給「破壞性／不連續」的操作用：取消訂閱、加入預設主題這種。
     *
     * 為什麼不能等 debounce：debounce 是 400ms，而使用者「取消訂閱之後馬上重新整理」
     * 時那個排程還沒響就被卸載掉了 —— 宿主永遠沒收到這次刪除，重新打開又從 YAML
     * 讀回舊清單。**這正是「刪除 topic，再打開又出現了」。**
     * 收斂連續輸入（例如拖看板寬度）才需要 debounce；刪除是一次性動作，直接寫。
     *
     * @returns Promise<{ ok, error? }>。
     */
    function writeSettingsNow() {
      if (hostSaveTimer !== null) {
        clearTimeout(hostSaveTimer);
        hostSaveTimer = null;
      }
      return pushSettingsToHost(null);
    }

    /**
     * 把一個錯誤結果轉成「給人看的」文字。
     *
     * 為什麼需要集中一處：core 已經有 `describeError()`，會把 429／401／404 之類
     * 翻成繁體中文；但 UI 有些路徑直接用了 `result.error`，而那個字串是
     * `HTTP 429 · {"code":42901,...,"link":"https://ntfy.sh/..."}` 這種
     * **伺服器原始回應** —— 直接顯示出來就是使用者看到的「又長又生硬」的那串。
     * 所以一律經過這裡：拿得到描述就用描述，拿不到才退回原始文字。
     *
     * @param result - { status, error, authRequired } 或字串或 Error。
     * @param fallback - 連 result 都沒有時的文字。
     * @returns 顯示用文字。
     */
    function humanError(result, fallback) {
      if (result === null || result === undefined || result === '') {
        return fallback || '發生未知錯誤。';
      }
      if (typeof result === 'string') return result;
      if (core && typeof core.describeError === 'function') {
        try {
          var described = core.describeError(result);
          if (typeof described === 'string' && described !== '') return described;
        } catch (err) { /* 描述失敗就退回原始文字 */ }
      }
      var raw = text(result.error);
      return raw !== '' ? raw : (fallback || '發生未知錯誤。');
    }

    /**
     * 宿主那條設定／憑證讀寫路由（YAML 落档）。
     * 與 lib/index.js 的 SETTINGS_PATH 必須一致。
     */
    var SETTINGS_PATH = '/ntfy-teams/settings';

    /**
     * 從宿主讀設定與憑證，套進 core。
     *
     * 為什麼要這一層：伺服器位址、帳密、主題清單原本只躺在 localStorage，
     * 換 profile／清快取就沒了。宿主那邊的 YAML 才是持久層，所以開機時以它為準；
     * 宿主拿不到（外掛在舊版宿主上、或還没想到要掛載）就沿用 localStorage，
     * 不會因為「宿主沒有」而整個不能用。
     *
     * 憑證只在記憶體快取（core.setCredentials），**不**回寫 localStorage ——
     * 持久層已經是那份 YAML，多抄一份只會多一處不一致。
     *
     * @returns Promise<{ ok, source, error? }>。
     */
    function syncSettingsFromHost() {
      if (typeof fetch !== 'function' || !core || typeof core.readConfig !== 'function') {
        return Promise.resolve({ ok: false, source: 'none', error: '沒有 fetch 或 core' });
      }
      return fetch(SETTINGS_PATH, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      }).then(function (res) {
        if (!res.ok) {
          return { ok: false, source: 'none', error: '宿主回應 HTTP ' + res.status };
        }
        return res.json().then(function (payload) {
          if (!payload || payload.ok !== true) {
            return { ok: false, source: 'none', error: ((payload && payload.error) || '宿主回應無效') };
          }
          var cfg = payload.config && typeof payload.config === 'object' ? payload.config : {};
          var hasHostConfig = Object.keys(cfg).length > 0;
          if (hasHostConfig) {
            // 以宿主 YAML 為準（它才是持久層）。只帶有值的欄位，避免用空值蓋掉既有設定。
            var partial = {};
            if (typeof cfg.server === 'string' && cfg.server !== '') partial.server = cfg.server;
            if (Array.isArray(cfg.topics)) partial.topics = cfg.topics;
            if (typeof cfg.identity === 'string') partial.identity = cfg.identity;
            if (cfg.aliases && typeof cfg.aliases === 'object') partial.aliases = cfg.aliases;
            if (cfg.dashboardWidth !== undefined) partial.dashboardWidth = cfg.dashboardWidth;
            if (cfg.autoApprove !== undefined) partial.autoApprove = cfg.autoApprove;
            if (cfg.stayAtBottom !== undefined) partial.stayAtBottom = cfg.stayAtBottom;
            try { core.saveConfig(partial); } catch (err) { /* 單一欄位壞掉不該讓整次同步失敗 */ }
          }
          // 憑證進記憶體快取（不寫 localStorage —— YAML 才是持久層）。
          var secretCount = applySecrets(payload.secrets);
          return {
            ok: true,
            source: hasHostConfig ? 'host' : 'empty',
            secretCount: secretCount,
            // 宿主根本沒有 config.yml → 「從未設定過」。
            // 這跟「設定檔存在但 topics 是空的」是**兩件不同的事**：
            // 前者該播種預設主題，後者是使用者自己把主題刪光了、不該被塞回去。
            // （用 source 判斷做不到 —— 只要設定檔有 identity/server 這類欄位，
            //   source 就是 'host'，看不出 topics 是不是空的。實測踩過。）
            configMissing: payload.configMissing === true,
            payload: payload
          };
        });
      }, function (err) {
        return { ok: false, source: 'none', error: '連線宿主失敗：' + text(err && err.message) };
      });
    }

    /**
     * 把目前所有伺服器的憑證收成一份對應表（要寫進 secrets.yml 的內容）。
     *
     * 為什麼要「所有」而不是只有當前那個：secrets.yml 是一份完整的對應表，
     * 送部分內容會讓其他伺服器的帳密被覆蓋掉。
     *
     * @returns { [server]: { mode, user, password, token } }。
     */
    function collectSecrets() {
      var out = {};
      if (!core || typeof core.credentialServers !== 'function' || typeof core.loadCredentials !== 'function') {
        return out;
      }
      var servers = core.credentialServers();
      for (var i = 0; i < servers.length; i += 1) {
        var server = servers[i];
        var cred = core.loadCredentials(server);
        // 沒有實際憑證內容的就不要寫進檔案，免得留一堆空殼。
        if (cred.mode === 'none' && cred.user === '' && cred.password === '' && cred.token === '') continue;
        out[server] = cred;
      }
      return out;
    }

    /**
     * 從宿主的 secrets.yml 內容載入憑證到記憶體快取。
     *
     * @param secrets - { [server]: cred }。
     * @returns 載入了幾筆。
     */
    function applySecrets(secrets) {
      if (!core || typeof core.setCredentials !== 'function') return 0;
      if (!secrets || typeof secrets !== 'object') return 0;
      var count = 0;
      for (var server in secrets) {
        if (!Object.prototype.hasOwnProperty.call(secrets, server)) continue;
        var cred = secrets[server];
        if (!cred || typeof cred !== 'object') continue;
        core.setCredentials(server, cred);
        count += 1;
      }
      return count;
    }

    /**
     * 把目前的設定與憑證寫回宿主的 YAML。
     *
     * 刻意的 fire-and-forget：設定介面是同步的，不該為了寫檔而卡住；
     * 失敗只留下訊息，因為下一次變更還會再試一次。
     *
     * 寫入的內容一律是「呼叫當下」的 core 狀態（server／topics／identity／aliases／
     * dashboardWidth），所以呼叫端不需要自己組設定 —— 只要觸發一次就好。
     *
     * @param options - { secrets } 額外要一起寫的憑證；沒有就傳 null。
     * @returns Promise<{ ok, error? }>。
     */
    function pushSettingsToHost(options) {
      if (typeof fetch !== 'function' || !core) {
        return Promise.resolve({ ok: false, error: '沒有 fetch 或 core' });
      }
      // ⚠️ 首次同步完成前**不準寫**。
      //
      // 為什麼：payload 的 topics 取自 **store**（見下方說明），而剛開機時 store
      // 還是空的 —— 在宿主設定套用進來之前送出 PUT，就會用「本機當下的清單」
      // 覆蓋宿主的完整清單。
      //
      // 實測代價（差點造成真的資料遺失）：全新 profile 開面板時，開機那幾百毫秒內
      // 只要有任何東西觸發寫入，宿主的 5 個主題就會被換成當時 store 裡的那 1 個。
      // 使用者「換瀏覽器／無痕／清快取」就會中獎。
      //
      // 做法：還沒同步完就先**排隊**（不是丟掉 —— 丟掉會讓使用者的第一個動作失效），
      // 同步完成後由呼叫端再送一次。
      if (!initialSyncDone) {
        initialSyncPending = true;
        return Promise.resolve({ ok: false, deferred: true });
      }
      var built = buildSettingsPayload(options);
      if (!built.ok) return Promise.resolve({ ok: false, error: built.error });
      return fetch(SETTINGS_PATH, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.payload)
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (out) {
          if (out && out.ok === true) return { ok: true };
          return { ok: false, error: (out && out.error) || ('HTTP ' + res.status) };
        });
      }, function (err) {
        return { ok: false, error: '連線宿主失敗：' + text(err && err.message) };
      });
    }

    /**
     * 組出要寫回宿主的設定 payload（不含網路）。
     *
     * 為什麼獨立成一個函式：正常路徑用 PUT 送出，而**頁面被卸載時**要用
     * `navigator.sendBeacon` 再送一次（見 flushHostWriteNow）——
     * 兩者必須組出**完全相同**的內容，否則緊急補送會寫進不同的東西。
     *
     * @param options - { secrets }。
     * @returns { ok, payload } 或 { ok:false, error }。
     */
    function buildSettingsPayload(options) {
      if (!core) return { ok: false, error: '沒有 core' };
      var payload = {};
      try {
        var cfg = core.readConfig();
        // 訂閱清單住在 **store**，不在 config。
        //
        // 實測教訓：`readConfig().topics` 永遠是空陣列（config 的那個欄位沒有被
        // 任何地方寫入），所以照著 config 送出的 PUT 每次都把宿主的 topics 蓋成
        // `[]` —— 也就是「明明訂閱了主題，config.yml 裡卻是空的」的真正原因。
        // 一律以 store 的即時清單為準。
        var topics = (core.store && typeof core.store.getSnapshot === 'function')
          ? (core.store.getSnapshot().topics || []).slice()
          : (cfg.topics || []);
        payload.config = {
          server: cfg.server,
          topics: topics,
          identity: cfg.identity || '',
          aliases: cfg.aliases || {},
          dashboardWidth: cfg.dashboardWidth,
          // 自動回應（每個主題的開關 + 已回過的訊息 id）。
          // 一定要帶上：`saveConfig` 只寫記憶體，漏了這個欄位
          // 勾選就不會進 config.yml，重新整理就沒了。
          autoApprove: cfg.autoApprove || {},
          // 「永遠滾到最新」的每個主題開關（同理：漏了就存不進 config.yml）。
          stayAtBottom: cfg.stayAtBottom || {}
        };
      } catch (err) {
        return { ok: false, error: '讀不到設定：' + text(err && err.message) };
      }
      var secrets = options && options.secrets ? options.secrets : null;
      if (secrets) payload.secrets = secrets;
      return { ok: true, payload: payload };
    }

    /**
     * 頁面即將被卸載時，把還沒送出的設定**立刻**送出去。
     *
     * 為什麼一定要有這個：寫回宿主是 **400ms debounce** 的（一個動作會觸發好幾次
     * store 更新，逐次寫檔太浪費）。但使用者「取消訂閱之後馬上重新整理」時，
     * 那個排程還沒響就被卸載掉了 —— 宿主永遠沒收到這次刪除，重新打開時
     * 又從 YAML 讀回舊清單。**這正是「刪除 topic，再打開又出現了」。**
     *
     * 用 `sendBeacon` 而不是 `fetch`：beacon 是瀏覽器保證在卸載後仍會送出的通道
     * （fetch 會被取消）。代價是它只能送 POST，所以宿主那條路由必須同時接受
     * POST（見 lib/index.js）。
     *
     * @returns 是否送出了。
     */
    function flushHostWriteNow() {
      if (!core || !initialSyncDone) return false;
      var built = buildSettingsPayload(null);
      if (!built.ok) return false;
      try {
        if (typeof navigator !== 'undefined' && navigator
          && typeof navigator.sendBeacon === 'function') {
          var blob = new Blob([JSON.stringify(built.payload)], { type: 'application/json' });
          return navigator.sendBeacon(SETTINGS_PATH, blob);
        }
      } catch (err) { /* 退回下面的 fetch */ }
      // 退路：keepalive 的 fetch（Safari 早期版本沒有 sendBeacon）。
      try {
        if (typeof fetch === 'function') {
          fetch(SETTINGS_PATH, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(built.payload),
            keepalive: true
          }).catch(function () { /* 卸載中，來不及處理 */ });
          return true;
        }
      } catch (err) { /* 放棄 */ }
      return false;
    }

    /**
     * 把 handle 組成顯示字串。空 handle 回空字串。
     * @param handle - 不含前缀的名称。
     * @returns '#name'。
     */
    function mention(handle) {
      var name = text(handle).trim();
      return name === '' ? '' : SIGIL + name;
    }

    /**
     * 去掉开头的发送者前缀（'#'，兼容旧的 '@'）。
     * @param value - 任何值。
     * @returns 不含前缀的纯名称。
     */
    function stripSigil(value) {
      var s = text(value).trim();
      while (s.length > 0 && SIGILS.indexOf(s.charAt(0)) !== -1) s = s.slice(1).trim();
      return s;
    }

    /**
     * 从 title 解析傳送者。core.parseIdentity 是权威实作，这里只做安全包装。
     * @param title - 訊息 title。
     * @returns {{handle:string, isMention:boolean}} handle 不含前缀。
     */
    function identityOf(title) {
      var raw = text(title).trim();
      if (raw === '') return { handle: '', isMention: false };
      if (core && typeof core.parseIdentity === 'function') {
        try {
          var parsed = core.parseIdentity(raw) || {};
          return {
            handle: text(parsed.handle).slice(0, HANDLE_MAX),
            isMention: !!parsed.isMention
          };
        } catch (err) {
          // 退化到自己解析，不让標題欄位的异常拖垮整则訊息。
        }
      }
      if (SIGILS.indexOf(raw.charAt(0)) !== -1) {
        return { handle: stripSigil(raw).slice(0, HANDLE_MAX), isMention: true };
      }
      return { handle: '', isMention: false };
    }

    /**
     * 组装要送出的 title。core.senderTitle 是权威实作。
     * @param name - 自己的顯示名稱（可含或不含前缀）。
     * @returns '#name'，名称为空时回空字串。
     */
    function titleFor(name) {
      var raw = text(name).trim();
      if (raw === '') return '';
      if (core && typeof core.senderTitle === 'function') {
        try {
          return text(core.senderTitle(raw));
        } catch (err) {
          // 退化到本地组合
        }
      }
      return mention(stripSigil(raw));
    }

    /** @returns 目前設定的傳送者名称（可能为空）。 */
    function currentIdentity() {
      if (core && typeof core.getIdentity === 'function') {
        try {
          return text(core.getIdentity());
        } catch (err) {
          return '';
        }
      }
      if (core && typeof core.readConfig === 'function') {
        try {
          return text(core.readConfig().identity);
        } catch (err) {
          return '';
        }
      }
      return '';
    }

    /**
     * 头像文字：取名称前 1~2 个字符。中文取 1 个字，英文取首字母。
     * @param handle - 成员名称。
     * @returns 显示在头像里的短字串。
     */
    function avatarText(handle) {
      var s = text(handle).trim();
      if (s === '') return '·';
      return s.slice(0, 1).toUpperCase();
    }

    /**
     * 由名称决定一个稳定的色相，让同一个成员每次都是同一种头像底色。
     * 只用色相，不用固定颜色，明暗主題都能看。
     * @param handle - 成员名称。
     * @returns 0..359 的色相。
     */
    function avatarHue(handle) {
      var s = text(handle);
      var h = 0;
      for (var i = 0; i < s.length; i += 1) {
        h = (h * 31 + s.charCodeAt(i)) % 360;
      }
      return h;
    }

    /**
     * 訊息的傳送者。
     *
     * 只有 **`#` 開頭**的 title 才算發送者。沒有 title、或 title 是別的內容
     * （例如有人亂填標題），一律當成沒有發送者 —— 標題本身會改當內文顯示，
     * 不會被吃掉，但不會被誤認成某個人。
     *
     * @param msg - 正规化訊息。
     * @param selfName - 自己的名称。
     * @returns {{name:string, isSelf:boolean, hasName:boolean}} hasName=false 时 name 为空。
     */
    function senderOf(msg, selfName) {
      var id = identityOf(msg && msg.title);
      var self = text(selfName).trim();
      if (id.handle === '') {
        // 沒有發送者：名稱固定用 `--`，**格式與其他訊息完全一樣**，
        // 只是名字是 `--`（不是留白，也不用「未具名成員」這種說法）。
        return { name: ANON_NAME, isSelf: false, hasName: true, isAnon: true };
      }
      return {
        name: id.handle,
        isSelf: self !== '' && id.handle.toLowerCase() === self.toLowerCase(),
        hasName: true,
        isAnon: false
      };
    }

    /**
     * 訊息的顯示用 title。只有**不是**發送者前綴的 title 才算「真正的標題」，
     * 這種標題要當內文顯示，否則會被靜靜吃掉。
     * @param msg - 正规化訊息。
     * @returns 要當內文顯示的標題，或空字串。
     */
    function plainTitleOf(msg) {
      var raw = text(msg && msg.title).trim();
      if (raw === '') return '';
      if (SIGILS.indexOf(raw.charAt(0)) !== -1) return ''; // 是發送者，不是標題
      return raw;
    }

    /**
     * 时间显示：今天只给时分，更早的给日期 + 时分。
     * @param seconds - unix 秒。
     * @returns 字串。
     */
    function formatClock(seconds) {
      if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return '';
      var d = new Date(seconds * 1000);
      return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /**
     * 日期分隔线文字：今天/昨天/月日。
     * @param seconds - unix 秒。
     * @returns 字串。
     */
    function formatDay(seconds) {
      if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return '';
      var d = new Date(seconds * 1000);
      var now = new Date();
      var sameDay = d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
      if (sameDay) return '今天';
      var y = new Date(now.getTime() - 86400000);
      if (d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate()) {
        return '昨天';
      }
      return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '年' : '')
        + (d.getMonth() + 1) + '月' + d.getDate() + '日';
    }

    /** 沒有可辨識時間的訊息歸到這一組。 */
    var NO_DAY_KEY = '__nodate__';

    /**
     * 一則訊息屬於哪一天（收合用的 key）。
     *
     * 用「日」當單位而不是顯示字串：`今天`／`昨天` 這種標籤會隨時間改變，
     * 拿它當 key 會讓「昨天收起來的」隔天變成別的一組。
     *
     * @param msg - 正规化訊息。
     * @returns 'YYYY-MM-DD' 或 NO_DAY_KEY。
     */
    function dayKeyOf(msg) {
      var when = messageTime(msg);
      if (typeof when !== 'number' || !isFinite(when) || when <= 0) return NO_DAY_KEY;
      var d = new Date(when * 1000);
      var m = d.getMonth() + 1;
      var day = d.getDate();
      return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    }

    /** 这一组是不是「今天」。 @param key - dayKeyOf 的结果。 @returns 是否今天。 */
    function isTodayKey(key) {
      if (key === NO_DAY_KEY) return false;
      var now = new Date();
      var m = now.getMonth() + 1;
      var day = now.getDate();
      return key === now.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
    }

    /**
     * 依日期把訊息分组，保持原顺序。
     * @param messages - 訊息阵列。
     * @returns [{ key, label, items }]。
     */
    function groupByDay(messages) {
      var groups = [];
      var index = {};
      for (var i = 0; i < messages.length; i += 1) {
        var msg = messages[i];
        var key = dayKeyOf(msg);
        var group = index[key];
        if (!group) {
          var when = messageTime(msg);
          group = {
            key: key,
            label: key === NO_DAY_KEY ? '沒有時間' : formatDay(when),
            items: []
          };
          index[key] = group;
          groups.push(group);
        }
        group.items.push(msg);
      }
      return groups;
    }

    /**
     * 把訊息内文切成文字与连结交错的行内片段。
     * 逐行处理，因此 <br> 保留换行；只接受 http/https。
     * @param body - 訊息内文。
     * @returns React 子节点阵列。
     */
    function renderInline(body) {
      var raw = text(body);
      if (raw === '') return null;
      var lines = raw.split(/\r?\n/);
      var out = [];
      for (var i = 0; i < lines.length; i += 1) {
        if (i > 0) out.push(e('br', { key: 'br' + i }));
        var line = lines[i];
        var re = /(https?:\/\/[^\s<>"']+)/gi;
        var last = 0;
        var m;
        var piece = 0;
        while ((m = re.exec(line)) !== null) {
          if (m.index > last) out.push(line.slice(last, m.index));
          var href = safeHref(m[1]);
          if (href !== '') {
            out.push(e('a', {
              key: 'a' + i + '_' + piece,
              className: 'ntfy-teams-link',
              href: href,
              target: '_blank',
              rel: 'noopener noreferrer'
            }, m[1]));
          } else {
            out.push(m[1]);
          }
          last = m.index + m[1].length;
          piece += 1;
        }
        if (last < line.length) out.push(line.slice(last));
      }
      return out;
    }

    // =========================================================================
    // 0c. Markdown
    //
    // 解析在 core.parseMarkdown（纯函数、可单测）；这里只负责把 AST 变成 React 节点。
    // 重点：**不使用 dangerouslySetInnerHTML** —— 所有文字都走 React 的文字节点，
    // 所以 <script>/<img onerror> 之类的内容只会以纯文字显示，不会变成元素。
    // 连结除了解析器只放行 http/https，这里再用 safeHref 把一次关。
    // =========================================================================

    var MD_UNSAFE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

    /**
     * 清掉控制字元，保留 \n 与 \t（<pre> 需要）。
     * @param value - 任何值。
     * @returns 安全字串。
     */
    function mdText(value) {
      return text(value).replace(MD_UNSAFE, '');
    }

    /**
     * 把 inline 节点阵列变成 React 子节点。
     * @param nodes - core.parseMarkdown 产生的 inline 阵列。
     * @param keyPrefix - React key 前缀。
     * @returns React 子节点阵列。
     */
    function renderInlineNodes(nodes, keyPrefix) {
      if (!Array.isArray(nodes) || nodes.length === 0) return null;
      var out = [];
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (node === null || node === undefined || typeof node !== 'object') continue;
        var key = keyPrefix + '_' + i;
        var type = node.type;
        if (type === 'text') {
          out.push(mdText(node.text));
        } else if (type === 'code') {
          out.push(e('code', { key: key, className: 'ntfy-teams-md-code' }, mdText(node.text)));
        } else if (type === 'strong') {
          out.push(e('strong', { key: key }, renderInlineNodes(node.children, key + 's')));
        } else if (type === 'em') {
          out.push(e('em', { key: key }, renderInlineNodes(node.children, key + 'e')));
        } else if (type === 'del') {
          out.push(e('del', { key: key }, renderInlineNodes(node.children, key + 'd')));
        } else if (type === 'link') {
          var href = safeHref(node.href);
          var kids = renderInlineNodes(node.children, key + 'l');
          if (href === '') {
            // 不安全或非 http(s)：退回纯文字，绝不产生可点的 <a>。
            //
            // 实务上这里几乎不会触发：core.parseMarkdown 在**产生节点之前**就把
            // 危险连结退化成纯文字了（浏览器验证实测 .ntfy-teams-md-rawlink
            // 出现 0 次）。这一支是纵深防御 —— 万一日后 core 的规则放宽，或有人
            // 从别处喂进 link 节点，这里仍然不会放出 javascript: 连结。
            out.push(e('span', { key: key, className: 'ntfy-teams-md-rawlink' }, kids));
          } else {
            out.push(e('a', {
              key: key,
              className: 'ntfy-teams-link',
              href: href,
              target: '_blank',
              rel: 'noopener noreferrer'
            }, kids));
          }
        } else if (typeof node.text === 'string') {
          out.push(mdText(node.text));
        }
      }
      return out.length > 0 ? out : null;
    }

    /**
     * 把訊息内文渲染成 markdown 区块。
     *
     * 解析器不在时（例如 core 版本较旧）退回纯文字 + 自动连结，功能不会消失。
     *
     * @param body - 原始内文。
     * @returns React 节点阵列。
     */
    function renderMarkdown(body) {
      var src = text(body);
      if (src === '') return null;

      var blocks = null;
      if (core && typeof core.parseMarkdown === 'function') {
        try {
          blocks = core.parseMarkdown(src);
        } catch (err) {
          blocks = null;
        }
      }
      if (!Array.isArray(blocks) || blocks.length === 0) {
        return e('div', { className: 'ntfy-teams-md' }, renderInline(src));
      }

      var out = [];
      for (var i = 0; i < blocks.length; i += 1) {
        var b = blocks[i];
        if (b === null || b === undefined || typeof b !== 'object') continue;
        var key = 'b' + i;
        if (b.type === 'code') {
          var langClass = b.lang
            ? 'ntfy-teams-md-pre ntfy-teams-md-pre--' + String(b.lang).replace(/[^A-Za-z0-9_-]/g, '')
            : 'ntfy-teams-md-pre';
          out.push(e('div', { key: key, className: 'ntfy-teams-md-codewrap' },
            b.lang ? e('span', { className: 'ntfy-teams-md-lang' }, mdText(b.lang)) : null,
            e('pre', { className: langClass },
              e('code', null, mdText(b.text)))
          ));
        } else if (b.type === 'heading') {
          var level = b.level === 1 ? 1 : b.level === 2 ? 2 : 3;
          out.push(e('h' + level, { key: key, className: 'ntfy-teams-md-h ntfy-teams-md-h' + level },
            renderInlineNodes(b.inline, key)));
        } else if (b.type === 'list') {
          var items = Array.isArray(b.items) ? b.items : [];
          var lis = [];
          for (var j = 0; j < items.length; j += 1) {
            lis.push(e('li', { key: key + 'i' + j }, renderInlineNodes(items[j], key + 'i' + j)));
          }
          out.push(e(b.ordered ? 'ol' : 'ul', { key: key, className: 'ntfy-teams-md-list' }, lis));
        } else if (b.type === 'table') {
          out.push(renderTable(b, key));
        } else if (b.type === 'blockquote') {
          out.push(e('blockquote', { key: key, className: 'ntfy-teams-md-quote' },
            renderMdBlocks(b.blocks, key)));
        } else if (b.type === 'hr') {
          out.push(e('hr', { key: key, className: 'ntfy-teams-md-hr' }));
        } else {
          out.push(e('p', { key: key, className: 'ntfy-teams-md-p' },
            renderInlineNodes(b.inline, key)));
        }
      }
      return e('div', { className: 'ntfy-teams-md' }, out);
    }

    /**
     * 渲染 markdown 表格。
     *
     * 外层套一层可横向滚动的容器：面板宽度有限，栏位多的表格硬塞会把版面撑破。
     * 对齐用 inline style（值只可能是解析器给的 left/center/right，不是使用者输入）。
     *
     * @param block - { align, head, rows }。
     * @param key - React key。
     * @returns 表格元素。
     */
    function renderTable(block, key) {
      var aligns = Array.isArray(block.align) ? block.align : [];
      var head = Array.isArray(block.head) ? block.head : [];
      var rows = Array.isArray(block.rows) ? block.rows : [];

      /** 一格：对齐方式 → 行内样式。 @param idx - 第几栏。 @returns 样式物件或 null。 */
      function cellStyle(idx) {
        var a = aligns[idx];
        if (a !== 'left' && a !== 'center' && a !== 'right') return null;
        return { textAlign: a };
      }

      var headCells = [];
      for (var h = 0; h < head.length; h += 1) {
        headCells.push(e('th', {
          key: key + 'h' + h,
          className: 'ntfy-teams-md-th',
          style: cellStyle(h)
        }, renderInlineNodes(head[h], key + 'h' + h)));
      }

      var bodyRows = [];
      for (var r = 0; r < rows.length; r += 1) {
        var cells = Array.isArray(rows[r]) ? rows[r] : [];
        var tds = [];
        for (var c = 0; c < head.length; c += 1) {
          tds.push(e('td', {
            key: key + 'r' + r + 'c' + c,
            className: 'ntfy-teams-md-td',
            style: cellStyle(c)
          }, renderInlineNodes(cells[c] || [], key + 'r' + r + 'c' + c)));
        }
        bodyRows.push(e('tr', { key: key + 'r' + r }, tds));
      }

      return e('div', { key: key, className: 'ntfy-teams-md-tablewrap' },
        e('table', { className: 'ntfy-teams-md-table' },
          e('thead', null, e('tr', null, headCells)),
          e('tbody', null, bodyRows)
        )
      );
    }

    /**
     * 渲染区块阵列（blockquote 会巢状呼叫）。
     * @param blocks - 区块阵列。
     * @param prefix - key 前缀。
     * @returns React 节点阵列。
     */
    function renderMdBlocks(blocks, prefix) {
      if (!Array.isArray(blocks)) return null;
      var out = [];
      for (var i = 0; i < blocks.length; i += 1) {
        var b = blocks[i];
        if (b === null || b === undefined || typeof b !== 'object') continue;
        var key = prefix + 'q' + i;
        if (b.type === 'code') {
          out.push(e('div', { key: key, className: 'ntfy-teams-md-codewrap' },
            e('pre', { className: 'ntfy-teams-md-pre' }, e('code', null, mdText(b.text)))));
        } else if (b.type === 'list') {
          var items = Array.isArray(b.items) ? b.items : [];
          out.push(e(b.ordered ? 'ol' : 'ul', { key: key, className: 'ntfy-teams-md-list' },
            items.map(function (inline, j) {
              return e('li', { key: key + 'j' + j }, renderInlineNodes(inline, key + 'j' + j));
            })));
        } else if (b.type === 'heading') {
          var lv = b.level === 1 ? 1 : b.level === 2 ? 2 : 3;
          out.push(e('h' + lv, { key: key, className: 'ntfy-teams-md-h ntfy-teams-md-h' + lv },
            renderInlineNodes(b.inline, key)));
        } else if (b.type === 'table') {
          out.push(renderTable(b, key));
        } else if (b.type === 'hr') {
          out.push(e('hr', { key: key, className: 'ntfy-teams-md-hr' }));
        } else {
          out.push(e('p', { key: key, className: 'ntfy-teams-md-p' },
            renderInlineNodes(b.inline, key)));
        }
      }
      return out;
    }

    /** @param n - 数量。 @returns 99+ 封顶的显示字串。 */
    function badgeText(n) {
      if (!n || n <= 0) return '';
      return n > 99 ? '99+' : String(n);
    }

    /**
     * 所有主题的未读总数。
     * @param snapshot - 仓库快照。
     * @returns 未读数量（非负整数）。
     */
    function totalUnread(snapshot) {
      var map = (snapshot && snapshot.unreadByTopic) || {};
      var keys = Object.keys(map);
      var sum = 0;
      for (var i = 0; i < keys.length; i += 1) {
        var n = map[keys[i]];
        if (typeof n === 'number' && isFinite(n) && n > 0) sum += n;
      }
      return sum;
    }

    /**
     * 狀態 → 中文說明。core 的 status 物件形狀為 {phase, detail}。
     *
     * 這裡是**單一主題**的階段（面板抬頭那顆 chip），跟側欄的彙總狀態是兩件事。
     * 用詞刻意跟側欄對齊：`closed` 在側欄叫「未連線」，這裡也一樣叫「未連線」——
     * 同一個狀態不該在兩個地方有兩個名字（實測：這裡原本叫「已中斷」）。
     */
    var PHASE_LABEL = {
      // 還沒有任何狀態（`statusOf` 的預設值）＝還沒開始，不是「閒置」。
      // 「閒置」這個詞會讓人以為「沒有在用即時連線」，所以不用它。
      idle: '尚未連線',
      connecting: '連線中',
      open: '已連線',
      live: '即時',
      error: '錯誤',
      closed: '未連線'
    };

    /**
     * 状态色票的修饰类。
     * @param phase - 状态阶段。
     * @returns 修饰类名后缀。
     */
    function phaseModifier(phase) {
      if (phase === 'live' || phase === 'open') return 'ok';
      if (phase === 'connecting') return 'warn';
      // `closed` 是「斷了、正在等重連」，屬於要注意的失敗狀態，
      // 不是「閒置」——原本它掉進預設的 'idle'，顏色跟「什麼都沒有」一樣。
      if (phase === 'error' || phase === 'closed') return 'err';
      return 'idle';
    }

    /**
     * 安全读取仓库快照：core 缺失或抛错时给一个空的稳定快照。
     * @returns 快照物件。
     */
    var EMPTY_SNAPSHOT = {
      topics: [],
      activeTopic: null,
      messagesByTopic: {},
      statusByTopic: {},
      unreadByTopic: {},
      authByTopic: {}
    };

    /** @returns 仓库快照；core 不可用时回 EMPTY_SNAPSHOT。 */
    function readSnapshot() {
      if (!core || !core.store || typeof core.store.getSnapshot !== 'function') return EMPTY_SNAPSHOT;
      try {
        return core.store.getSnapshot() || EMPTY_SNAPSHOT;
      } catch (err) {
        return EMPTY_SNAPSHOT;
      }
    }

    /**
     * 這個錯誤值不值得重試，以及要等多久。
     *
     * 為什麼需要：ntfy 的限流是**短窗口、小額度**（實測：連續 6 次請求後開始 429，
     * 約 5 秒內恢復），而且 429 回應**不帶 `Retry-After`**（實測過），所以只能
     * 自己退避。更關鍵的是：連線層遇到錯誤就結束，不會自己重連 ——
     * 沒有這段的話，一次 429 會讓訂閱**整個死掉直到使用者手動重新整理**。
     *
     * 放在模組層是因為「即時連線」（startLiveSync）與「歷史拉取」（面板 effect）
     * 兩邊都要用；放在其中一邊會讓另一邊拿不到。
     *
     * @param status - HTTP 狀態碼（0 = 連線層失敗）。
     * @param attempt - 第幾次重試（從 1 開始）。
     * @returns { retry, delayMs }。
     */
    function backoffFor(status, attempt) {
      var n = attempt || 1;
      // 固定的重試節奏：1s → 2s → 4s → 8s → 16s → 30s → 30s → …
      //
      // 為什麼是「查表」而不是現算 2^n：需求指定的就是這串數字，而 16→30
      // 不是 2 的次方（32 被截成 30）。查表讓實作與規格一字不差，
      // 也一眼看得出「第幾次等多久」。
      var DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];
      var step = DELAYS[Math.min(n, DELAYS.length) - 1];

      // 429 一直重試，**永不放棄**。
      //
      // 為什麼不放棄：429 是暫時的（實測輕度超額約 5 秒恢復，被打滿則要安靜約 2 分鐘）。
      // 放棄等於「這個主題從此不再更新，直到使用者手動重新整理」—— 那比慢一點連上糟得多。
      // 到 30 秒之後就固定 30 秒一直試。
      if (status === 429) return { retry: true, delayMs: step };

      // 認證問題重試沒有意義 —— 使用者得先去改設定。
      if (status === 401 || status === 403) return { retry: false, delayMs: 0 };

      // 連線層失敗（status 0）與 5xx 走同一個節奏、也一樣不放棄。
      if (status === 0 || status >= 500) return { retry: true, delayMs: step };

      // 其他 4xx（404 之類）重試不會變好。
      return { retry: false, delayMs: 0 };
    }

    /**
     * 訂閱倉庫，回傳目前快照（React 外部 store 的标准写法）。
     * @returns 快照。
     */
    function useStore() {
      var pair = React.useState(readSnapshot);
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      React.useEffect(function () {
        if (!core || !core.store || typeof core.store.subscribe !== 'function') return undefined;
        return core.store.subscribe(function () {
          setSnapshot(readSnapshot());
        });
      }, []);
      return snapshot;
    }

    /** @param snap - 快照。 @param topic - topic 名。 @returns 该 topic 的状态物件。 */
    function statusOf(snap, topic) {
      var s = snap.statusByTopic ? snap.statusByTopic[topic] : null;
      if (s === null || s === undefined) return { phase: 'idle', detail: '' };
      if (typeof s === 'string') return { phase: s, detail: '' };
      return s;
    }

    // =========================================================================
    // 1. 样式（全部走主題令牌；唯 NTFY_TEAMS_CSS 内不出现写死颜色）
    // =========================================================================

    // 头像色相只用「色相」，彩度与明度交给主題令牌的透明度，明暗主題都能看。
    var AVATAR_CSS = [];
    for (var hueI = 0; hueI < 12; hueI += 1) {
      var hueDeg = hueI * 30;
      AVATAR_CSS.push(
        '.ntfy-teams-avatar--h' + hueI + '{background:hsl(' + hueDeg + ',62%,52%);}',
      );
    }

    var NTFY_TEAMS_CSS = [
      // ---- 底：整个面板 ----
      '.ntfy-teams-root{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;',
      'box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:13px;line-height:1.5;overflow:hidden;}',
      // 抬頭底下那一列：左欄（設定／主題／訊息）與看板並排。
      // 看板只佔這一列的高度 → 它從抬頭下緣開始，不會蓋到連線狀態。
      '.ntfy-teams-row{flex:1 1 auto;min-height:0;display:flex;flex-direction:row;align-items:stretch;}',
      // 左欄：共用設定／主題列／訊息列（由上往下堆）。看板在它的右邊。
      '.ntfy-teams-leftcol{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;}',
      '.ntfy-teams-root *,.ntfy-teams-root *::before,.ntfy-teams-root *::after{box-sizing:border-box;}',
      '.ntfy-teams-root button{font-family:inherit;}',

      // ---- 顶栏：工作组标识 + 状态 + 动作 ----
      '.ntfy-teams-header{display:flex;align-items:center;gap:10px;flex:0 0 auto;padding:12px 18px;',
      // 使用者指定：抬頭底線 1px solid #ddd（不是主題令牌）。
      // 這是刻意的例外（見「已知例外」測試）—— 他要的是一個固定的淺灰。
      'border-bottom:1px solid #ddd;background:var(--dsw-alias-bg-layer-1);}',
      '.ntfy-teams-grouplogo{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;',
      'width:34px;height:34px;border-radius:10px;background:var(--dsw-alias-brand-primary);',
      'color:var(--dsw-alias-bg-base);}',
      '.ntfy-teams-headmain{display:flex;flex-direction:column;gap:1px;min-width:0;}',
      '.ntfy-teams-title{font-size:14px;font-weight:650;margin:0;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;}',
      '.ntfy-teams-subtitle{display:flex;align-items:center;gap:7px;font-size:11.5px;',
      'color:var(--dsw-alias-label-secondary);min-width:0;}',
      '.ntfy-teams-subitem{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ntfy-teams-sepdot{flex:0 0 auto;opacity:.5;}',
      '.ntfy-teams-spacer{flex:1 1 auto;min-width:6px;}',
      '.ntfy-teams-headeracts{display:flex;align-items:center;gap:4px;flex:0 0 auto;}',
      '.ntfy-teams-glyph{display:inline-flex;align-items:center;justify-content:center;position:relative;',
      'flex:0 0 auto;color:currentColor;}',

      // ---- 顶栏按钮 / 通用按钮 ----
      '.ntfy-teams-iconbtn{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;',
      'width:30px;height:30px;padding:0;border:1px solid transparent;border-radius:8px;cursor:pointer;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;',
      'transition:background .12s ease,color .12s ease;}',
      '.ntfy-teams-iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-iconbtn[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-border-l2);}',
      '.ntfy-teams-iconbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      // 齒輪按鈕：**帶顏色**（需求）。
      //
      // ⚠️ 為什麼不用 `--dsw-alias-brand-primary`：這個主題把它定義成**跟 label-primary
      // 一樣的墨色**（實測兩者都是 #0f1115）——連「儲存」主按鈕都是黑白。用它畫齒輪
      // 永遠是灰黑的，達不到「帶顏色」。
      //
      // 改用 `--dsw-static-blue-500`（#3b82f6）：它是「設計平台」層的**固定色票**，
      // 定義在 `body` 上、不隨主題變（淺色／深色都是同一個值），所以不會有
      // 「深色主題下某個 alias 解析不到」的風險。
      //
      // 藍色是設定類入口的通用語意（不像綠／紅／琥珀帶有成功／錯誤／警告的含意）。
      // 底色用 color-mix 混得很淡：淺色主題是一層淡藍，深色主題也不會刺眼
      // （直接給不透明色會在深色主題上變成一塊突兀的色塊）。
      '.ntfy-teams-iconbtn--gear{color:var(--dsw-static-blue-500);',
      'background:color-mix(in srgb, var(--dsw-static-blue-500) 12%, transparent);',
      'border-color:color-mix(in srgb, var(--dsw-static-blue-500) 26%, transparent);}',
      '.ntfy-teams-iconbtn--gear:hover{color:var(--dsw-static-blue-600);',
      'background:color-mix(in srgb, var(--dsw-static-blue-500) 22%, transparent);',
      'border-color:color-mix(in srgb, var(--dsw-static-blue-500) 40%, transparent);}',
      // 展開時（aria-pressed=true）：底色再深一階，表示「表單正開著」。
      '.ntfy-teams-iconbtn--gear[aria-pressed="true"]{color:var(--dsw-static-blue-600);',
      'background:color-mix(in srgb, var(--dsw-static-blue-500) 26%, transparent);',
      'border-color:var(--dsw-static-blue-500);}',
      // 展開時焦點框也用藍色，跟齒輪一致（別回到品牌墨色）。
      '.ntfy-teams-iconbtn--gear:focus-visible{outline-color:var(--dsw-static-blue-500);}',
      '.ntfy-teams-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:0 0 auto;',
      'height:30px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);',
      'font:inherit;font-size:12.5px;white-space:nowrap;transition:background .12s ease,opacity .12s ease;}',
      '.ntfy-teams-btn:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.ntfy-teams-btn:disabled{opacity:.45;cursor:default;}',
      '.ntfy-teams-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.ntfy-teams-btn--primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);',
      'border-color:transparent;font-weight:600;}',
      '.ntfy-teams-btn--primary:hover{opacity:.9;background:var(--dsw-alias-brand-primary);}',
      '.ntfy-teams-btn--ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-btn--ghost:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);}',

      // ---- 状态徽章 ----
      '.ntfy-teams-chip{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;height:20px;',
      'padding:0 9px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;',
      'white-space:nowrap;}',
      '.ntfy-teams-chip--ok{color:var(--dsw-alias-state-success-primary);}',
      '.ntfy-teams-chip--warn{color:var(--dsw-alias-state-warn-primary);}',
      '.ntfy-teams-chip--err{color:var(--dsw-alias-state-error-primary);}',
      '.ntfy-teams-chip--idle{color:var(--dsw-alias-state-idle-primary);}',
      '.ntfy-teams-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:currentColor;}',
      '.ntfy-teams-chip--ok .ntfy-teams-dot{animation:ntfy-teams-pulse 2.4s ease-in-out infinite;}',
      '@keyframes ntfy-teams-pulse{0%,100%{opacity:1;}50%{opacity:.35;}}',
      '.ntfy-teams-badge{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;',
      'padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-alias-bg-base);font-size:10px;font-weight:700;}',
      '.ntfy-teams-icondot{position:absolute;top:-1px;right:-1px;width:7px;height:7px;border-radius:50%;',
      'background:var(--dsw-alias-state-error-primary);}',
      // 未讀數量：接在**圖示後面**（不再疊在圖示右上角）。
      //
      // 為什麼改位置：疊在右上角時那個 18px 寬的角標會同時壓到兩個東西
      // （實測座標，CSS px）：
      //   row 14..266   圖示 22..38   標題文字 46..102   狀態燈 30..40
      //   badge（疊在右上角）23..41  →  蓋住圖示右半 15px、也蓋住狀態燈
      // 也就是「擋住狀態指示」的成因。
      //
      // 圖示右緣（38）到標題左緣（46）中間只有 8px，容不下 18px 的角標，
      // 所以不能只是把 left 調大。改成用 flex `order` 把角標排在圖示後面：
      // 圖示、狀態燈、數字三者互不重疊，而且閱讀順序是「圖示 → 數字」。
      //
      // 取捨：包裝因此變寬（約 16 + 5 + 18 = 39px），標題會往右移。那一列還有
      // 大量空白（標題只到 102，row 到 266），所以實務上不會擠壓；但仍以實測
      // 確認標題沒有換行。
      // 未讀數字：定位到**標題文字的右邊**。
      //
      // 為什麼是「量出來的」而不是靠 flex 排出來：徽章住在宿主的「圖示」座位裡，
      // 標題是宿主自己的元素、而且在 DOM 順序上位於插槽**之後**，所以純 CSS
      // 沒辦法把它排到標題後面。改成絕對定位 + 由 positionUnreadAfterTitle()
      // 量出標題右緣，把位移寫進 --ntfy-teams-badge-left（預設 86px 是實測值，
      // 只在 JS 還沒跑到時當後備）。
      //
      // 位置的理由：疊在右上角會同時蓋住圖示與狀態燈（實測 badge 23..41 與
      // 圖示 22..38、狀態燈 30..40 都重疊），那正是「擋住狀態指示」的成因；
      // 接在標題右邊則是那一行的空白處，什麼都不會蓋到。
      '.ntfy-teams-glyphwrap{position:relative;display:inline-flex;align-items:center;justify-content:center;',
      'gap:5px;cursor:pointer;color:currentColor;}',
      // 圖示自己再包一層當**狀態燈的定位基準**（不能掛在最外層，否則會跟著徽章跑）。
      '.ntfy-teams-iconwrap{position:relative;display:inline-flex;align-items:center;',
      'justify-content:center;flex:0 0 auto;}',
      '.ntfy-teams-unreadbadge{position:absolute;z-index:2;top:0;',
      'left:var(--ntfy-teams-badge-left,86px);display:inline-flex;',
      'align-items:center;justify-content:center;min-width:14px;height:14px;padding:0 4px;',
      'border-radius:7px;background:var(--dsw-alias-state-error-primary);',
      'color:var(--dsw-alias-bg-base);font-size:9.5px;font-weight:700;line-height:1;',
      'font-variant-numeric:tabular-nums;letter-spacing:-.3px;pointer-events:none;}',

      // ---- 側欄連線狀態指示燈（右下角）----
      //
      // 放在右下角，跟左上角的未讀數字分開：兩者回答不同問題
      // （「有幾則在等我」vs「連線還好嗎」），疊在一起會互相蓋住。
      //
      // 尺寸刻意小（9px）：圖示本身只有 16px，燈太大會把圖示吃掉
      // （實測：13px 的燈落在 16px 圖示上時，圖示幾乎完全看不見）。
      '.ntfy-teams-health{position:absolute;right:-1px;bottom:-1px;z-index:1;display:inline-flex;',
      'align-items:center;justify-content:center;width:9px;height:9px;border-radius:50%;',
      'background:var(--dsw-specific-sidebar-fill);pointer-events:none;}',
      // 每個狀態一組顏色。形狀（StatusGlyph）已經區分了狀態，顏色是加強而不是唯一資訊。
      '.ntfy-teams-glyphwrap--idle .ntfy-teams-health{color:var(--dsw-alias-state-idle-primary);}',
      // 即時連線正常：用「成功」色，跟「什麼都沒有」的 idle 明確分開。
      '.ntfy-teams-glyphwrap--live .ntfy-teams-health{color:var(--dsw-alias-state-success-primary);}',
      '.ntfy-teams-glyphwrap--connecting .ntfy-teams-health{color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-glyphwrap--offline .ntfy-teams-health{color:var(--dsw-alias-state-warn-primary);}',
      '.ntfy-teams-glyphwrap--unread .ntfy-teams-health{color:var(--dsw-alias-brand-primary);}',
      '.ntfy-teams-glyphwrap--error .ntfy-teams-health{color:var(--dsw-alias-state-error-primary);}',
      // 等待重試：用「警告色」而不是「錯誤色」—— 它會自己好，不是故障。
      // 形狀（轉動的圓弧）已經區分開，顏色只是加強。
      '.ntfy-teams-glyphwrap--retrying .ntfy-teams-health{color:var(--dsw-alias-state-warn-primary);}',
      // 連線中讓指示燈呼吸，一看就知道「還在做事」而不是卡住
      '.ntfy-teams-glyphwrap--connecting .ntfy-teams-health{animation:ntfy-teams-pulse 1.4s ease-in-out infinite;}',
      '@keyframes ntfy-teams-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
      // 尊重使用者的減少動態偏好
      '@media (prefers-reduced-motion: reduce){.ntfy-teams-glyphwrap--connecting .ntfy-teams-health{animation:none;}}',

      // ---- 共用設定（伺服器／帳號／顯示名稱：全域只有一份） ----
      '.ntfy-teams-settings{flex:0 0 auto;border-bottom:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);}',
      '.ntfy-teams-settingsbar{display:flex;align-items:center;gap:7px;padding:7px 18px;font-size:11.5px;',
      'color:var(--dsw-alias-label-secondary);}',
      // 摘要那一行現在住在**抬頭**裡（需求：各種提示都要在第一個容器內），
      // 所以它在抬頭內不該再有自己的 padding —— 否則會把抬頭撐高、也對不齊。
      '.ntfy-teams-header .ntfy-teams-settingsbar{padding:0;min-width:0;flex:0 1 auto;font-size:11.5px;}',
      // 摘要裡的項目在抬頭內要能縮（窄面板時才不會把齒輪擠掉）。
      '.ntfy-teams-header .ntfy-teams-settingitem{max-width:22ch;}',
      '.ntfy-teams-header .ntfy-teams-settingsbar .ntfy-teams-btn{height:24px;padding:0 9px;font-size:11.5px;}',
      '.ntfy-teams-settingitem{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:30%;}',
      '.ntfy-teams-settingnote{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85;}',
      // 展開的編輯表單：需求「加一點背景色、素雅一點、padding 也多一些」。
      //
      // 做法：不是把整個區塊染色（那會跟下方的 topic 列擠成一片），而是把表單
      // **收成一張淡色卡片** —— 四周留邊、內部給足內距、圓角、一層很淡的邊框。
      // 底色用「墨色混 3%」而不是 bg-layer-*：淺色主題的 layer-1／layer-2 都是純白，
      // 疊上去等於沒變化（這個坑在本檔的隔行底色已經踩過一次）。
      //
      // 內距分兩層：卡片本身 padding 給上下留白，左右的 18px 對齊其他區塊。
      '.ntfy-teams-settings--open{margin:10px 18px 14px;padding:12px 14px 13px;',
      'display:flex;flex-direction:column;gap:10px;border-radius:10px;',
      'border:1px solid var(--dsw-alias-border-l1);',
      'background:color-mix(in srgb, var(--dsw-alias-label-primary) 3.5%, transparent);}',
      // 表單內部**不再**各自撐 18px —— 內距已經由卡片負責，否則會多縮一層。
      '.ntfy-teams-settings--open .ntfy-teams-connrow{padding:0;}',
      '.ntfy-teams-settings--open .ntfy-teams-hint{padding:0;}',
      // 標籤固定一個寬度，讓「顯示名稱」「認證方式」兩列的輸入框左緣對齊。
      '.ntfy-teams-settings--open .ntfy-teams-field{flex:0 0 auto;min-width:4.5em;}',

      // ---- 連線設定 ----
      '.ntfy-teams-conn{flex:0 0 auto;padding:12px 18px;border-bottom:1px solid var(--dsw-alias-border-l1);',
      'background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:9px;}',
      '.ntfy-teams-connrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
      '.ntfy-teams-hint{font-size:12px;color:var(--dsw-alias-state-warn-primary);}',
      '.ntfy-teams-hint--err{color:var(--dsw-alias-state-error-primary);}',
      '.ntfy-teams-hint--ok{color:var(--dsw-alias-state-success-primary);}',
      '.ntfy-teams-field{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}',

      // ---- 输入元件 ----
      '.ntfy-teams-input,.ntfy-teams-select{height:30px;padding:0 9px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;min-width:0;}',
      '.ntfy-teams-input--grow{flex:1 1 200px;}',
      '.ntfy-teams-input--handle{width:130px;flex:0 0 auto;}',
      '.ntfy-teams-input:focus,.ntfy-teams-select:focus{outline:2px solid var(--dsw-alias-brand-primary);',
      'outline-offset:-1px;}',
      '.ntfy-teams-input::placeholder{color:var(--dsw-alias-label-secondary);}',

      // 連線那一列（認證／帳號／密碼／測試連線／儲存／清除憑證）盡量排成一行。
      //
      // 為什麼需要這條：`--grow` 的 flex-basis 是 200px，兩個輸入框就先要 400px，
      // 加上選單與三顆按鈕會超出可用寬度（實測 825px 的列裡需要約 875px），
      // 於是 flex-wrap 把「清除憑證」擠到第二行。
      // 把 basis 縮小並允許低於輸入框的預設 min-width，輸入框就會自己讓出空間；
      // 面板真的很窄時仍然會換行（wrap 留著，不會擠壞）。
      '.ntfy-teams-connrow .ntfy-teams-input{flex:1 1 90px;min-width:0;}',

      // ---- 工作组卡：群名 + 话题 ----
      '.ntfy-teams-groupbar{display:flex;align-items:center;gap:8px;flex:0 0 auto;padding:9px 18px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);',
      'overflow-x:auto;}',
      '.ntfy-teams-grouplabel{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;',
      'color:var(--dsw-alias-label-secondary);flex:0 0 auto;white-space:nowrap;}',
      '.ntfy-teams-topic{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;height:28px;',
      'padding:0 7px 0 11px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;cursor:pointer;',
      'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;',
      'transition:background .12s ease,border-color .12s ease,color .12s ease;}',
      '.ntfy-teams-topic:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}',
      // 聚焦中的主題用**反色**（前景↔背景對調）。
      //
      // 為什麼不是原本的「淡底 + 品牌色邊框」：那個跟 hover 幾乎一樣（只差字重），
      // 一眼看不出「我現在在哪個主題」。反色是最高對比的做法，而且形狀上就成立，
      // 不依賴顏色本身 —— 顏色互換，所以淺色／深色主題都會自動成立。
      //
      // 用的就是「文字色當底、底色當字」：label-primary ↔ bg-base，
      // 這正是這個主題裡的一組反色對，不需要另外發明色票。
      '.ntfy-teams-topic--active{background:var(--dsw-alias-label-primary);',
      'border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-weight:600;}',
      // hover 要維持反色（不能掉回淺底），否則滑過聚焦主題時它會「消失」。
      // 選取器要比 `.ntfy-teams-topic:hover` 更明確才蓋得住。
      '.ntfy-teams-topic--active:hover{background:var(--dsw-alias-label-primary);',
      'border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);}',
      // 反色底上的次要元素：× 的 hover 底色要用「字色」才看得出來（原本是深底，會隱形）。
      '.ntfy-teams-topic--active .ntfy-teams-topic-x:hover{background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-primary);}',
      // 反色底上的鎖：稍微提高不透明度才看得清楚（原本 .5 在黑底上偏淡）。
      '.ntfy-teams-topic--active .ntfy-teams-topiclock{opacity:.7;}',
      '.ntfy-teams-topicname{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.ntfy-teams-topic-x{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;',
      'border:0;border-radius:50%;background:transparent;color:inherit;cursor:pointer;font:inherit;',
      'font-size:13px;line-height:1;padding:0;opacity:.55;}',
      '.ntfy-teams-topic-x:hover{opacity:1;background:var(--dsw-alias-bg-base);}',
      // 受保護的主題（預設群組）：把「取消訂閱」的位置換成一把鎖。
      // 尺寸與 × 相同，所以 chip 寬度不會跳動。
      '.ntfy-teams-topiclock{display:inline-flex;align-items:center;justify-content:center;',
      'width:17px;height:17px;font-size:9.5px;line-height:1;opacity:.5;cursor:default;}',
      '.ntfy-teams-topic--locked{cursor:pointer;}',
      // 等待重試的圖示：轉動的圓弧，一眼看得出「還在動」而不是「壞了」。
      '@keyframes ntfy-teams-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
      '.ntfy-teams-spin{animation:ntfy-teams-spin 1.1s linear infinite;transform-origin:center;}',
      // 尊重「減少動態效果」的系統設定：改成不轉，但仍然用形狀區分（不是只有顏色）。
      '@media (prefers-reduced-motion: reduce){.ntfy-teams-spin{animation:none;}}',
      '.ntfy-teams-topic--add{border-style:dashed;padding:0 13px;}',
      // 訂閱數量（n／上限）：放在「+ 訂閱主題」按鈕裡，讓使用者隨時知道還剩幾格。
      '.ntfy-teams-topiccount{margin-left:6px;font-size:10.5px;font-weight:500;opacity:.7;',
      'font-variant-numeric:tabular-nums;}',
      // 被上限擋下時的提示。獨占一整行，不擠壓 chip 列。
      '.ntfy-teams-limitnote{flex:1 1 100%;font-size:11.5px;line-height:1.5;',
      'color:var(--dsw-alias-state-warn-primary);}',
      // 取消訂閱的確認條：取代群組列，等明確決定才動手。
      //
      // 美化（跟展開的設定表單用同一套語言）：收成一張**淡紅色的卡片** ——
      // 四周留邊、圓角、淡邊框、足夠內距，並且用 error 色調的底色暗示「這是破壞性動作」。
      // 底色用 color-mix 混得很淡（8%），淺色／深色主題都不刺眼；
      // groupbar 的 18px 左右內距在這裡歸零，改由卡片自己給。
      //
      // 用 `border`（不是 `border-bottom`）覆蓋掉 groupbar 那條底線 —— 卡片不吃底線。
      '.ntfy-teams-groupbar--confirm{gap:9px;margin:10px 18px 12px;padding:11px 14px;',
      'border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent);',
      'border-radius:10px;',
      'background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);',
      'animation:ntfy-teams-in .18s ease-out;}',
      // 確認條裡的按鈕略高一點，跟卡片的內距配起來比較穩。
      '.ntfy-teams-groupbar--confirm .ntfy-teams-btn{height:32px;}',
      // 警示符號：跟文字同色系。
      '.ntfy-teams-confirmglyph{display:inline-flex;align-items:center;flex:0 0 auto;',
      'color:var(--dsw-alias-state-error-primary);}',
      '.ntfy-teams-confirmtext{font-size:12.5px;color:var(--dsw-alias-label-primary);}',
      // 破壞性動作只靠「狀態色 + 淡底」表達，不去猜對比色令牌存不存在
      // （寫死 #fff 會被「只用主題令牌」那條測試擋下來，而且深色主題下本來就該跟著變）。
      // 破壞性動作只靠「狀態色 + 淡底」表達，不去猜對比色令牌存不存在
      // （寫死 #fff 會被「只用主題令牌」那條測試擋下來，而且深色主題下本來就該跟著變）。
      //
      // 用 alias 的 state-error（實測 #ec1313）而不是 static-red-500（#ef4444）：
      // 前者是**語意**令牌、會跟著主題走，後者是固定色票。兩者色相一致，
      // 所以選語意那個 —— 深色主題下有機會被調成更適合的紅。
      '.ntfy-teams-btn--danger{color:var(--dsw-alias-state-error-primary);',
      'border-color:var(--dsw-alias-state-error-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);}',
      '.ntfy-teams-btn--danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent);}',
      // 別名：設過別名的 chip 多一個小圓點，滑過去才知道原始主題名。
      '.ntfy-teams-aliasdot{flex:0 0 auto;font-size:14px;line-height:1;',
      'color:var(--dsw-alias-brand-primary);}',
      // 雙擊就地改名：chip 換成輸入框，維持同樣高度避免整列跳動。
      '.ntfy-teams-topic--editing{padding:0 6px;border-color:var(--dsw-alias-brand-primary);',
      'background:var(--dsw-alias-bg-layer-2);}',
      // ⚠️ 編輯中的 chip 一定要**蓋掉反色**。
      //
      // 病灶：`.ntfy-teams-topic--editing` 與 `.ntfy-teams-topic--active` 特異度相同，
      // 而反色那條寫在後面 → 正在編輯的**聚焦主題**拿到 `background: label-primary`
      // ＋ `color: bg-base`（淺色主題下就是「深底＋白字」），偏偏輸入框自己又是
      // `background: transparent`，於是文字變成白配深底卻又繼承到不該有的顏色，
      // 使用者看到的就是「黑黑的反色背景，文字看不清楚」。
      //
      // 編輯狀態優先於「聚焦」狀態：正在打字時，可讀性比「我在哪個主題」重要。
      '.ntfy-teams-topic--editing,.ntfy-teams-topic--editing:hover{',
      'background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);',
      'color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-topic--editing .ntfy-teams-topic-x{color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-topic--editing .ntfy-teams-topic-x:hover{background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-aliasinput{height:22px;min-width:90px;max-width:220px;border:0;background:transparent;',
      'padding:0 2px;font-size:12.5px;}',
      // 輸入框的文字色**明確指定**，不要靠繼承 —— 父層一旦是反色就會變成白字。
      '.ntfy-teams-aliasinput,.ntfy-teams-topic--editing .ntfy-teams-input{',
      'color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-aliasinput::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-aliasinput:focus{outline:0;}',

      // ---- 訊息串 ----
      // 左右各留一點白，讓訊息不要貼著邊框。
      // 右邊刻意比左邊多（26 / 44）：自己的訊息靠右，看起來會更貼邊，
      // 多留一點右邊白整個區塊比較不外擴、也比較好讀。
      // ---- 右側面板（看板佔位，可拖寬）----
      //
      // **版面是「主列 = 主欄 ｜ 看板」**，看板是這一列的直接子元素，
      // 所以它會撐滿整列高度、直通到面板底部。
      //
      // 為什麼要這樣分：原本看板跟訊息串一起放在訊息列裡，於是它只跟訊息串一樣高
      // —— 下面那條撰寫區（Composer）把它「截斷」了（實測：看板 266..797，
      // 撰寫區 797..900，右邊那塊就是缺一角）。把撰寫區收進主欄、看板拉到列上
      // 之後，兩者都是整列高（實測 dashBottomGapToRoot = 0）。
      '.ntfy-teams-mainrow{flex:1 1 auto;min-height:0;display:flex;flex-direction:row;align-items:stretch;}',
      '.ntfy-teams-main{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;}',
      '.ntfy-teams-dash{flex:0 0 auto;display:flex;align-items:stretch;min-width:0;',
      // 使用者指定：虛線 1px #ddd（不是主題令牌）。
      // 這是刻意的例外 —— 需求要的是一個固定的極淺灰，而主題的 border 令牌
      // 在深色模式下會變成淺色，跟這裡要的效果不同。見「已知例外」測試。
      'border-left:1px dotted #ddd;background:var(--dsw-alias-bg-layer-2);}',
      // 把手：細細一條，滑過或聚焦才亮起來 —— 平時不搶戲。
      '.ntfy-teams-dashgrip{flex:0 0 auto;width:6px;cursor:col-resize;background:transparent;',
      'transition:background .12s ease;}',
      '.ntfy-teams-dashgrip:hover,.ntfy-teams-dashgrip:focus-visible{',
      'background:color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent);outline:0;}',
      '.ntfy-teams-dashgrip:focus-visible{background:var(--dsw-alias-brand-primary);}',
      '.ntfy-teams-dashbody{flex:1 1 auto;min-width:0;overflow:auto;padding:14px 14px 18px;}',

      // ---- 看板：示範圖表 ----
      //
      // ⚠️ 這一整塊是**示範（demo）**：資料是本地用種子隨機產生的，不是真的統計，
      //    畫面上明確標示「示範」，不讓它冒充真實數據。
      //    也**沒有任何網路請求**（只是本機換一組種子），所以不吃 ntfy 的限流額度。
      '.ntfy-teams-charts{display:flex;flex-direction:column;gap:12px;}',
      // 看板底部保留區：使用者指定 **130px** 高、上方一條 `1px solid #eee`。
      //
      // 用 min-height 而不是 height，並且靠 `margin-top:auto` 讓它在內容不足時
      // 也貼到最底下；min-height 是**內容高度**（不計 border），所以整個區塊
      // 佔 130px + 1px 的線。
      //
      // #eee 是使用者指定的色碼（跟抬頭的 #ddd、看板的 #ddd 一樣刻意不用令牌）——
      // 這幾處是「使用者欽定的視覺規格」，不是可以隨主題漂移的語意色。
      '.ntfy-teams-dashfoot{flex:0 0 auto;margin-top:auto;min-height:130px;',
      'border-top:1px solid #eee;}',
      // 有了自己的底部保留區之後，dashbody 的底部內距要收掉，
      // 否則會變成「130px 空白 + 18px 內距」兩段留白疊在一起。
      '.ntfy-teams-dash .ntfy-teams-dashbody{padding-bottom:0;display:flex;flex-direction:column;}',
      // 卡片外觀沿用展開設定表單／確認條那一套（淡墨底 + 圓角 + 細邊），
      // 整個面板的卡片才會是同一種視覺語言。
      '.ntfy-teams-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;',
      'background:color-mix(in srgb, var(--dsw-alias-label-primary) 3.5%, transparent);',
      'padding:10px 12px 11px;min-width:0;}',
      '.ntfy-teams-cardhead{display:flex;align-items:center;gap:6px;margin-bottom:8px;min-width:0;}',
      '.ntfy-teams-cardtitle{font-size:11.5px;font-weight:600;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      // 「示範」標籤：淡琥珀底，一眼看出不是真數據。
      '.ntfy-teams-demotag{flex:0 0 auto;font-size:10px;font-weight:600;padding:1px 6px;border-radius:999px;',
      'color:var(--dsw-static-amber-600);',
      'background:color-mix(in srgb, var(--dsw-static-amber-500) 16%, transparent);',
      'border:1px solid color-mix(in srgb, var(--dsw-static-amber-500) 30%, transparent);}',
      '.ntfy-teams-chartwrap{display:block;width:100%;height:auto;overflow:visible;}',
      // 格線／軸標：極淡，只當閱讀輔助，不搶走折線。
      '.ntfy-teams-gridline{stroke:color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);}',
      '.ntfy-teams-axislabel{font-size:8.5px;fill:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-chartline{fill:none;stroke:var(--dsw-static-blue-500);stroke-width:2;',
      'stroke-linejoin:round;stroke-linecap:round;}',
      '.ntfy-teams-bar{fill:color-mix(in srgb, var(--dsw-static-blue-500) 70%, transparent);}',
      '.ntfy-teams-bar--hi{fill:var(--dsw-static-blue-500);}',
      '.ntfy-teams-doughnuttrack{fill:none;stroke:color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent);}',
      '.ntfy-teams-dseg{stroke-width:14;stroke-linecap:butt;}',
      // 四段用四個色相。這個主題的固定色票只有 6 個家族
      // （amber/blue/deepseek/green/neutral/red，實測沒有 violet/purple），
      // 所以第 4 段用 neutral（灰）—— 它在圖表裡讀作「其他」，而且不像
      // 紅／琥珀會帶有錯誤／警告的語意。
      '.ntfy-teams-dseg--0{stroke:var(--dsw-static-blue-500);}',
      '.ntfy-teams-dseg--1{stroke:var(--dsw-static-amber-500);}',
      '.ntfy-teams-dseg--2{stroke:var(--dsw-static-green-500);}',
      '.ntfy-teams-dseg--3{stroke:var(--dsw-static-neutral-400);}',
      '.ntfy-teams-doughnutmid{text-align:center;}',
      // KPI 三格
      '.ntfy-teams-kpi{display:flex;gap:10px;align-items:flex-start;}',
      '.ntfy-teams-kpibox{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:1px;}',
      '.ntfy-teams-kpival{font-size:18px;font-weight:650;letter-spacing:-.01em;',
      'color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;line-height:1.15;}',
      '.ntfy-teams-kpilabel{font-size:10px;color:var(--dsw-alias-label-secondary);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ntfy-teams-kpidelta{font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums;}',
      '.ntfy-teams-kpidelta--up{color:var(--dsw-alias-state-success-primary);}',
      '.ntfy-teams-kpidelta--down{color:var(--dsw-alias-state-error-primary);}',
      // 各主題的迷你條
      '.ntfy-teams-topicbars{display:flex;flex-direction:column;gap:7px;}',
      '.ntfy-teams-tbrow{display:flex;align-items:center;gap:8px;min-width:0;}',
      '.ntfy-teams-tbname{flex:0 1 auto;max-width:40%;font-size:11px;color:var(--dsw-alias-label-secondary);',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ntfy-teams-tbtrack{flex:1 1 auto;min-width:0;height:7px;border-radius:999px;',
      'background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);overflow:hidden;}',
      '.ntfy-teams-tbfill{display:block;height:100%;border-radius:999px;',
      'background:var(--dsw-static-blue-500);transition:width .35s ease;}',
      '.ntfy-teams-tbval{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;min-width:2.4em;text-align:right;}',
      // 圖例
      '.ntfy-teams-legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:9px;}',
      '.ntfy-teams-lgleaf{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;',
      'color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-lgdot{width:8px;height:8px;border-radius:999px;flex:0 0 auto;}',

      // ---- 「N 則新訊息」提示條 ----
      //
      // 需求：「當前 topic 處於焦點時…如果是其他人發的就提示未讀」。
      // 這條就是那個提示：焦點中的主題收到別人的訊息、而使用者沒貼在底部時，
      // 底部浮出這顆藥丸；點一下跳到第一則未讀。
      //
      // 定位跟日期跳轉列同一招：`sticky` + `bottom:0` + `margin:auto 0 auto auto`
      // （水平靠 auto margin 推到右邊），所以它一定在可視範圍的底部，
      // 不會因為內容長短跑到看不到的地方。
      '.ntfy-teams-unreadpill{position:sticky;bottom:0;z-index:4;float:right;',
      'width:0;height:100%;margin:auto 0 auto auto;pointer-events:none;}',
      '.ntfy-teams-unreadpillbtn{position:absolute;bottom:10px;right:-36px;pointer-events:auto;',
      'display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 13px;white-space:nowrap;',
      'border:1px solid var(--dsw-static-blue-500);border-radius:999px;cursor:pointer;font:inherit;',
      'font-size:12px;font-weight:600;color:var(--dsw-alias-bg-base);',
      'background:var(--dsw-static-blue-500);',
      'box-shadow:0 3px 10px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);',
      'transition:background .12s ease;}',
      '.ntfy-teams-unreadpillbtn:hover{background:var(--dsw-static-blue-600);',
      'border-color:var(--dsw-static-blue-600);}',
      '.ntfy-teams-unreadpillbtn:focus-visible{outline:2px solid var(--dsw-static-blue-500);outline-offset:2px;}',
      '.ntfy-teams-unreadpillarrow{flex:0 0 auto;line-height:1;}',

      // 訊息串（在並排版面裡自己撐開；本身仍可垂直捲動）
      '.ntfy-teams-stream{flex:1 1 auto;min-height:0;overflow-y:auto;padding:16px 44px 20px 26px;',
      'scroll-behavior:smooth;',
      // 關掉瀏覽器的**滾動錨定**。
      //
      // 為什麼：展開一天會在某個錨點元素之前插入大量內容，Chrome 會自動調整
      // `scrollTop` 去「保持畫面不動」。但我們正要**主動跳到某一天**，
      // 那個自動補償會把剛捲好的位置推走。
      // 實測：目標 153 被補償成 42（差 111px，剛好是展開一天的抬頭高度）。
      'overflow-anchor:none;}',
      // 右側的日期跳轉列：用掉 stream 右邊那 44px 內距（原本是空的）。
      //
      // 為什麼是 `position:sticky` 而不是 absolute：stream 本身就是滾動容器，
      // sticky + `margin:auto 0`（配合 top/bottom:0）會讓它**永遠停在可視範圍
      // 的垂直中央**，而且跟著捲動內容一起被裁切 —— 不需要另開一層 wrapper
      // 去當定位祖先，也不必處理「哪個祖先才是 offsetParent」。
      //
      // `right:-36px`：sticky 元素在**內容盒**裡（26px 左內距、44px 右內距），
      // 往右推 36px 剛好落在右側那個空隙中（34px 寬的按鈕 → 距面板右緣約 10px）。
      '.ntfy-teams-daynav{position:sticky;top:0;bottom:0;z-index:3;float:right;',
      'width:0;height:100%;margin:auto 0;}',
      '.ntfy-teams-daynavcol{position:absolute;right:-36px;top:50%;transform:translateY(-50%);',
      'display:flex;flex-direction:column;gap:6px;}',
      '.ntfy-teams-daynavbtn{display:inline-flex;align-items:center;justify-content:center;',
      'width:34px;height:34px;padding:0;border:1px solid var(--dsw-alias-border-l2);',
      'border-radius:9px;cursor:pointer;background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-secondary);line-height:1;',
      'box-shadow:0 1px 3px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);',
      'transition:background .12s ease,color .12s ease,border-color .12s ease;}',
      '.ntfy-teams-daynavbtn:hover{background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);}',
      '.ntfy-teams-daynavbtn:focus-visible{outline:2px solid var(--dsw-static-blue-500);outline-offset:1px;}',
      // 沒有上一天／下一天時：留著按鈕（位置不跳動）但變淡、不可按。
      '.ntfy-teams-daynavbtn:disabled{opacity:.32;cursor:default;}',
      '.ntfy-teams-daynavbtn:disabled:hover{background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);}',
      '.ntfy-teams-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;',
      'height:100%;color:var(--dsw-alias-label-secondary);font-size:12.5px;text-align:center;}',
      '.ntfy-teams-emptytitle{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      // 日期抬頭同時是「收合這一天」的按鈕：預設外觀仍是一條分隔線。
      '.ntfy-teams-day{display:flex;align-items:center;gap:8px;margin:6px 0 12px;width:100%;',
      'padding:2px 4px;cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:11px;',
      'font-family:inherit;background:transparent;border:0;text-align:left;}',
      '.ntfy-teams-day::before,.ntfy-teams-day::after{content:"";flex:1 1 auto;height:1px;',
      'background:var(--dsw-alias-border-l1);}',
      '.ntfy-teams-day:hover{color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-day:hover::before,.ntfy-teams-day:hover::after{background:var(--dsw-alias-border-l1);opacity:.7;}',
      '.ntfy-teams-day:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;',
      'border-radius:6px;}',
      // 收起來時整條變成一顆藥丸，明顯「這裡有東西被折起來了」。
      '.ntfy-teams-day--collapsed{margin-bottom:6px;color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-day--collapsed::before{background:transparent;}',
      '.ntfy-teams-day--collapsed .ntfy-teams-daylabel{font-weight:600;}',
      '.ntfy-teams-daycaret{flex:0 0 auto;font-size:12px;line-height:1;width:11px;text-align:center;}',
      // 日期抬頭那條：主體是「收合／展開」，右端一顆問號是「用這一天開新 session」。
      '.ntfy-teams-daywrap{display:flex;align-items:center;gap:2px;}',
      '.ntfy-teams-daywrap .ntfy-teams-day{flex:1 1 auto;width:auto;}',
      '.ntfy-teams-dayquestion{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;',
      'width:22px;height:22px;padding:0;border:0;border-radius:6px;cursor:pointer;',
      'background:transparent;color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-dayquestion:hover{color:var(--dsw-alias-brand-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);}',
      '.ntfy-teams-dayquestion:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}',
      '.ntfy-teams-daylabel{flex:0 0 auto;}',
      '.ntfy-teams-daycount{flex:0 0 auto;font-size:10px;padding:1px 6px;border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-day--today .ntfy-teams-daylabel{color:var(--dsw-alias-brand-primary);font-weight:600;}',

      // position:relative 是群組動作（絕對定位浮在最右側）的定位基準。
      '.ntfy-teams-msg{position:relative;display:flex;gap:11px;padding:5px 8px;border-radius:10px;}',
      // 每一則外面包一層，帶 data-mid —— 未讀線要靠它認出「線後面是哪一則」，
      // 才能把本輪讀到哪往前推。包裝層不參與排版（display:contents 會讓 flex 語意
      // 變複雜，這裡保持一個普通區塊）。
      '.ntfy-teams-msgslot{display:block;}',
      // 未讀線：左右各一條線，中間寫還有幾則沒看。
      // 這是「未讀不為 0」的第二層提示 —— 側欄與主題 chip 的角標是第一層，
      // 但切進該主題後角標就歸零了，需要這裡告訴使用者「新訊息從這裡開始」。
      '.ntfy-teams-newline{display:flex;align-items:center;gap:10px;margin:8px 0 4px;',
      'color:var(--dsw-alias-brand-primary);font-size:11px;font-weight:600;}',
      '.ntfy-teams-newline::before,.ntfy-teams-newline::after{content:"";flex:1 1 auto;height:1px;',
      'background:var(--dsw-alias-brand-primary);opacity:.45;}',
      '.ntfy-teams-newlinetext{flex:0 0 auto;padding:1px 8px;border-radius:8px;',
      'background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);}',
      // 主題 chip 有未讀時也把邊框點亮，跟角標互相呼應。
      '.ntfy-teams-topic--unread{border-color:var(--dsw-alias-brand-primary);}',
      // 隔行底色：刻意壓到很淡，只做為「讀到哪一行」的輔助，不搶走內容的注意力。
      //
      // 用「墨色」而不是 bg-layer-1 來混：淺色主題下 layer-1 與底色一樣是純白
      // （#fff 45% 蓋在白底上 = 全白，對比 1.000，等於完全看不出來）。改成把
      // label-primary 這種前景色混 3%，深淺兩個主題才會得到接近的淡度
      // （實測對比：淺色 1.063、深色 1.070）。
      '.ntfy-teams-msg--alt{background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);}',
      '.ntfy-teams-msg--alt:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);}',
      '.ntfy-teams-msg:hover{background:var(--dsw-alias-bg-layer-1);}',
      // 自己的訊息本來就有底色，這裡維持「自己」的識別優先
      // （順序要在 --alt 之後，否則會被隔行底色蓋掉）。
      '.ntfy-teams-msg--self{background:var(--dsw-alias-bg-layer-1);}',
      // 淺色主題的 layer-1 / layer-2 都是純白，用 layer-2 當 hover 等於沒變化，
      // 所以 hover 也用墨色混。
      '.ntfy-teams-msg--self:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);}',
      // 自己的訊息靠右：整行改成由右往左排（頭像在右），文字靠右對齊。
      '.ntfy-teams-msg--self{flex-direction:row-reverse;}',
      // 內文預設是 flex:1 撐滿整行 —— 那樣頭像會被擠在最左邊，看不出「靠右」。
      // 改成不撐滿：內容多寬就多寬，頭像自然落在文字右邊。
      '.ntfy-teams-msg--self .ntfy-teams-msgbody{flex:0 1 auto;text-align:right;}',
      // 表頭（發送者／時間／標籤）與「你」徽章一起鏡射到右邊。
      '.ntfy-teams-msg--self .ntfy-teams-msghead{flex-direction:row-reverse;}',
      // 程式碼區塊、引用、清單在靠右模式下仍要維持左讀
      // （這幾個是 markdown 真的會產生的類名，不要憑印象寫）。
      '.ntfy-teams-msg--self .ntfy-teams-md-pre,.ntfy-teams-msg--self .ntfy-teams-md-quote,',
      '.ntfy-teams-msg--self .ntfy-teams-md-list{text-align:left;}',
      // 沒有發送者：名稱顯示 `--`，格式與其他訊息相同，只把名字調淡一點。
      '.ntfy-teams-sender--anon{color:var(--dsw-alias-label-secondary);font-weight:500;}',
      // 沿用同一個 flex 間距，不再另外加 padding（格式要跟別人一致）。
      '.ntfy-teams-msg--anon{padding-left:8px;}',
      '.ntfy-teams-msg--new{animation:ntfy-teams-in .4s ease-out;}',
      '@keyframes ntfy-teams-in{from{opacity:.2;transform:translateY(4px);}to{opacity:1;transform:none;}}',
      '.ntfy-teams-avatar{display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;',
      'width:34px;height:34px;border-radius:9px;color:var(--dsw-alias-bg-base);',
      'font-size:14px;font-weight:700;user-select:none;}',
      // 頭像 + 時間：直向堆疊，時間置中對齊頭像。
      // 固定寬度（比頭像寬）讓時間不會撐開這一塊 —— 每一列的時間才會落在同一條線上。
      '.ntfy-teams-msgav{display:flex;flex-direction:column;align-items:center;gap:2px;',
      'flex:0 0 auto;width:38px;}',
      '.ntfy-teams-msgav .ntfy-teams-clock{font-size:10px;line-height:1.15;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary);letter-spacing:-.2px;}',
      '.ntfy-teams-msgbody{flex:1 1 auto;min-width:0;}',
      '.ntfy-teams-msghead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:1px;}',
      // 群組動作（決定／待辦／結案）：平時隱藏，滑到那一列才出現，不打擾閱讀。
      //
      // 這裡用**絕對定位浮在角落**，而不是在訊息下方多插一列。
      // 理由：多插一列會讓容器高度在滑鼠進出時改變，整串訊息跟著上下跳；
      // 浮出來則完全不佔版面（實測踩過：height 0→auto 的寫法會抖動）。
      //
      // 貼**抬頭那一側**的角落（而不是右側垂直居中）：這些動作屬於「這則訊息的
      // 抬頭」（誰說的、什麼時候），跟署名同一行最直覺，也不會壓在訊息內文上。
      //
      // 左對齊的訊息（別人的）→ 右上角；因為署名在左上，右上是空的。
      // 右對齊的訊息（自己的）→ **左上角**；這種訊息 flex-direction 是 row-reverse，
      //   頭像與署名都在右邊，放右上會直接壓在署名上（實測就是使用者回報的重合）。
      //   鏡射過去才是那則訊息真正空著的一角。
      '.ntfy-teams-acts{position:absolute;right:8px;top:2px;',
      'display:flex;gap:6px;align-items:center;opacity:0;pointer-events:none;',
      'transition:opacity .12s ease;z-index:1;}',
      '.ntfy-teams-msg--self .ntfy-teams-acts{right:auto;left:8px;flex-direction:row-reverse;}',
      '.ntfy-teams-msg:hover .ntfy-teams-acts,.ntfy-teams-msg:focus-within .ntfy-teams-acts{',
      'opacity:1;pointer-events:auto;}',
      '.ntfy-teams-act{font-size:10.5px;line-height:1;padding:3px 8px;border-radius:6px;cursor:pointer;',
      'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);',
      'color:var(--dsw-alias-label-secondary);font-family:inherit;}',
      '.ntfy-teams-act:hover{color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary);}',
      '.ntfy-teams-act--on{color:var(--dsw-alias-brand-primary);',
      'border-color:var(--dsw-alias-brand-primary);',
      'background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);}',
      '.ntfy-teams-act--done{color:var(--dsw-alias-state-success-primary);',
      'border-color:var(--dsw-alias-state-success-primary);}',
      // 動作列是絕對定位在右緣，兩種訊息都靠右對齊，不需要再翻方向。
      // （自己的訊息本身是靠右排版，動作貼右邊剛好對齊它。）
      // 抬頭上的群組狀態：有待辦時用警示色，讓「還沒結」這件事看得出來
      '.ntfy-teams-subitem--todo{color:var(--dsw-alias-state-warn-primary);font-weight:600;}',
      '.ntfy-teams-sender{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary);}',
      '.ntfy-teams-sender--self{color:var(--dsw-alias-brand-primary);}',
      '.ntfy-teams-you{font-size:10px;font-weight:600;padding:1px 6px;border-radius:6px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-clock{font-size:11px;color:var(--dsw-alias-label-secondary);',
      'font-variant-numeric:tabular-nums;}',
      '.ntfy-teams-tags{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;}',
      '.ntfy-teams-tag{font-size:10px;padding:0 6px;height:16px;display:inline-flex;align-items:center;',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);}',

      // ---- markdown ----
      '.ntfy-teams-md{font-size:13px;line-height:1.62;word-break:break-word;}',
      '.ntfy-teams-md>*:first-child{margin-top:0;}',
      '.ntfy-teams-md>*:last-child{margin-bottom:0;}',
      '.ntfy-teams-md-p{margin:0 0 7px;white-space:pre-wrap;}',
      '.ntfy-teams-md-h{margin:10px 0 6px;line-height:1.35;font-weight:650;}',
      '.ntfy-teams-md-h1{font-size:16px;}',
      '.ntfy-teams-md-h2{font-size:14.5px;}',
      '.ntfy-teams-md-h3{font-size:13.5px;}',
      '.ntfy-teams-md-list{margin:0 0 7px;padding-left:20px;}',
      '.ntfy-teams-md-list li{margin:2px 0;}',
      '.ntfy-teams-md-quote{margin:0 0 7px;padding:2px 0 2px 11px;',
      'border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-md-quote>*:last-child{margin-bottom:0;}',
      '.ntfy-teams-md-code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
      'padding:1px 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);',
      'border:1px solid var(--dsw-alias-border-l1);}',
      '.ntfy-teams-md-codewrap{position:relative;margin:0 0 8px;}',
      '.ntfy-teams-md-pre{margin:0;padding:10px 12px;border-radius:9px;overflow-x:auto;',
      'background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);}',
      '.ntfy-teams-md-pre code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;',
      'font-size:12px;line-height:1.55;white-space:pre;background:none;border:0;padding:0;}',
      '.ntfy-teams-md-lang{position:absolute;top:6px;right:8px;font-size:10px;',
      'color:var(--dsw-alias-label-secondary);text-transform:lowercase;}',
      '.ntfy-teams-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:9px 0;}',
      // 表格：外層可橫向捲動（欄位多時不會把版面撐破），內層才是真正的 table。
      '.ntfy-teams-md-tablewrap{margin:0 0 9px;overflow-x:auto;',
      'border:1px solid var(--dsw-alias-border-l1);border-radius:9px;}',
      '.ntfy-teams-md-table{border-collapse:collapse;font-size:12.5px;min-width:100%;}',
      '.ntfy-teams-md-th,.ntfy-teams-md-td{padding:5px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);',
      'border-right:1px solid var(--dsw-alias-border-l1);vertical-align:top;text-align:left;}',
      // 最後一欄／最後一列不要多一條線，免得跟外框疊成兩條
      '.ntfy-teams-md-th:last-child,.ntfy-teams-md-td:last-child{border-right:0;}',
      '.ntfy-teams-md-table tbody tr:last-child .ntfy-teams-md-td{border-bottom:0;}',
      '.ntfy-teams-md-th{background:var(--dsw-alias-bg-layer-2);font-weight:650;',
      'color:var(--dsw-alias-label-primary);white-space:nowrap;}',
      '.ntfy-teams-md-table tbody tr:hover .ntfy-teams-md-td{background:var(--dsw-alias-bg-layer-1);}',
      // 自己的訊息是靠右排版（text-align:right），但表格內容仍然要左讀
      '.ntfy-teams-msg--self .ntfy-teams-md-tablewrap{text-align:left;}',
      '.ntfy-teams-md-rawlink{color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;}',
      '.ntfy-teams-link{color:var(--dsw-alias-brand-primary);text-decoration:none;}',
      '.ntfy-teams-link:hover{text-decoration:underline;}',

      // ---- 撰写区 ----
      '.ntfy-teams-compose{flex:0 0 auto;display:flex;flex-direction:column;gap:7px;padding:11px 18px 14px;',
      'border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);}',
      // 身分／自動批準／永遠滾到最新／優先級 —— **一列**。
      //
      // ⚠️ `flex-wrap:nowrap` 是刻意的：一換行就又變回兩列，這個需求的意義就沒了。
      // 擠不下時由下面的 media query **依序省略最不重要的文字**（先收「優先級」
      // 三個字，再收開關的文字只留方框），而不是折行。
      // 這一列的內容**不換行、也不外溢**：擠不下時靠彈性壓縮 + 省略號吸收
      // （身分名稱可以縮、優先級文字在更窄時會收起來）。
      // `overflow:hidden` 是最後防線 —— 萬一還是不夠，寧可夾掉也不要橫向滾動。
      '.ntfy-teams-composemeta{display:flex;align-items:center;gap:9px;flex-wrap:nowrap;',
      'font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;}',
      '.ntfy-teams-sendas{display:inline-flex;align-items:center;gap:5px;flex:0 1 auto;',
      'min-width:0;font-weight:600;color:var(--dsw-alias-brand-primary);}',
      // 名稱可能很長 → 讓它可以被壓縮並省略，不要推擠後面的控制項
      '.ntfy-teams-sendastext{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      // 兩個開關可以縮（文字會先被省略號吃掉），但不隱藏 ——
      // 它們是「開關」，方框一定要留著。
      '.ntfy-teams-autoapprove,.ntfy-teams-staybottom{min-width:0;}',
      '.ntfy-teams-autoapprovetext,.ntfy-teams-staybottomtext{min-width:0;overflow:hidden;',
      'text-overflow:ellipsis;}',
      // 優先級控制是最重要的（要看得出選了什麼），最後才動它。
      '.ntfy-teams-composerow{display:flex;align-items:flex-end;gap:9px;}',
      '.ntfy-teams-textarea{flex:1 1 auto;min-height:40px;max-height:180px;resize:vertical;padding:9px 11px;',
      'border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);',
      'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;}',
      '.ntfy-teams-textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}',
      '.ntfy-teams-textarea::placeholder{color:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-sendbtn{height:38px;padding:0 18px;}',

      // ---- 自動批準／永遠滾到最新：行內小膠囊 ----
      //
      // 需求：身分、這兩個開關、優先級要在**同一行**，而且文本簡約。
      // 所以它們不再是佔滿整列的卡片（會有左右外距、整列可點），
      // 改成貼在那一行裡的小膠囊。
      //
      // 它們是**會改變行為**的開關，所以「開著」要看得出來：
      // 勾選時整顆上色（自動批準藍、永遠滾到最新綠）。
      '.ntfy-teams-autoapprove,.ntfy-teams-staybottom{display:inline-flex;align-items:center;',
      'gap:5px;flex:0 0 auto;padding:3px 8px;border:1px solid var(--dsw-alias-border-l1);',
      'border-radius:7px;cursor:pointer;font-size:11px;line-height:1;white-space:nowrap;',
      'color:var(--dsw-alias-label-secondary);',
      'background:color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent);}',
      '.ntfy-teams-autoapprove:hover,.ntfy-teams-staybottom:hover{',
      'background:color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);}',
      '.ntfy-teams-autoapprovebox,.ntfy-teams-staybottombox{flex:0 0 auto;width:13px;height:13px;',
      'margin:0;cursor:pointer;}',
      '.ntfy-teams-autoapprovebox{accent-color:var(--dsw-static-blue-500);}',
      '.ntfy-teams-staybottombox{accent-color:var(--dsw-static-green-500);}',
      '.ntfy-teams-autoapprovebox:disabled{cursor:default;opacity:.45;}',
      // 勾選時整顆上色：:has 不支援時只是顏色不變，功能不受影響
      '.ntfy-teams-autoapprove:has(.ntfy-teams-autoapprovebox:checked){',
      'color:var(--dsw-static-blue-600);',
      'border-color:color-mix(in srgb, var(--dsw-static-blue-500) 45%, transparent);',
      'background:color-mix(in srgb, var(--dsw-static-blue-500) 10%, transparent);}',
      '.ntfy-teams-staybottom:has(.ntfy-teams-staybottombox:checked){',
      'color:var(--dsw-static-green-600);',
      'border-color:color-mix(in srgb, var(--dsw-static-green-500) 45%, transparent);',
      'background:color-mix(in srgb, var(--dsw-static-green-500) 10%, transparent);}',
      '.ntfy-teams-autoapprovetext,.ntfy-teams-staybottomtext{white-space:nowrap;}',

      // ---- 自動批準：倒數狀態 ----
      //
      // 倒數時把整顆膠囊變成「注意色」（琥珀），並長出一顆取消鈕。
      // 用琥珀而不是紅色：紅色在這份 UI 裡代表「錯誤／危險」，
      // 而倒數只是一個**進行中、可取消**的狀態。
      '.ntfy-teams-approvewrap{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;}',
      '.ntfy-teams-approvewrap--pending .ntfy-teams-autoapprove{',
      'color:var(--dsw-alias-state-warn-primary) !important;',
      'border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 50%, transparent) !important;',
      'background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent) !important;}',
      // 連 checkbox 也一起轉琥珀 —— 不然「藍色的勾 + 琥珀色的字」看起來像兩件事。
      '.ntfy-teams-approvewrap--pending .ntfy-teams-autoapprovebox{',
      'accent-color:var(--dsw-alias-state-warn-primary);}',
      // 秒數：等寬數字，倒數時寬度不會跳動
      '.ntfy-teams-approvecount{font-weight:700;font-variant-numeric:tabular-nums;',
      'font-size:11px;line-height:1;}',
      '.ntfy-teams-approvecancel{display:inline-flex;align-items:center;height:20px;',
      'padding:0 8px;margin:0;border-radius:6px;cursor:pointer;font:inherit;font-size:11px;',
      'line-height:1;white-space:nowrap;',
      'color:var(--dsw-alias-label-primary);',
      'border:1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);',
      'background:var(--dsw-alias-bg-layer-1);}',
      '.ntfy-teams-approvecancel:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);}',
      '.ntfy-teams-approvecancel:focus-visible{outline:2px solid var(--dsw-static-blue-500);outline-offset:1px;}',
      // 倒數時多出「Ns」與「取消」約 50px；窄畫面就先犧牲「永遠滾到最新」的文字
      // （那顆在這一行裡最不重要），避免整列被擠爆。
      // ⚠️ staybottom 是 approvewrap 的**兄弟**，不是子節點 —— 所以要用 :has 選父層。
      '@media (max-width:1050px){',
      '.ntfy-teams-composemeta:has(.ntfy-teams-approvewrap--pending) .ntfy-teams-staybottomtext{',
      'display:none;}}',

      // ---- 優先級：分段控制 ----
      //
      // 視覺語言：強度用「格數」表達（1..4 格實心），顏色用紅色系深淺
      // （只有 state-error 那個紅是主題令牌；深浅用 color-mix 疊出來，
      // ---- 送出鈕＝優先級（同一顆按鈕）----
      //
      // 需求：「這個新優先級 UI 也不好點擊。覺得可以和發送的 button 結合起來用，
      //       不同優先級，不同的顏色」。
      //
      // 上一版是四個 7×16px 的小按鈕（實測），幾乎按不到。合併之後：
      //   * **送出鈕的顏色＝目前的優先級** —— 按下去之前就知道這則訊息多大聲；
      //   * 左半是切換級別、右半是送出，兩個動作各自有文字，
      //     整顆約 130×38px，好按。
      //
      // 顏色基調（tone）：低→冷灰、預設→琥珀、高→紅。
      // 琥珀給「預設」而不是灰的，是刻意的：預設值會觸發手機推播，
      // 讓它帶一點顏色等於提醒「這則會通知別人」。
      '.ntfy-teams-sendbtn{display:inline-flex;align-items:stretch;flex:0 0 auto;',
      'height:38px;border-radius:10px;overflow:hidden;',
      'border:1px solid color-mix(in srgb, var(--ntfy-tone) 45%, transparent);',
      'background:color-mix(in srgb, var(--ntfy-tone) 13%, var(--dsw-alias-bg-layer-1));',
      '--ntfy-tone:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-sendbtn[data-tone="muted"]{--ntfy-tone:var(--dsw-alias-label-secondary);}',
      '.ntfy-teams-sendbtn[data-tone="cool"]{--ntfy-tone:var(--dsw-static-blue-500);}',
      '.ntfy-teams-sendbtn[data-tone="amber"]{--ntfy-tone:var(--dsw-alias-state-warn-primary);}',
      '.ntfy-teams-sendbtn[data-tone="hot"]{--ntfy-tone:var(--dsw-alias-state-error-primary);}',
      // 左半：切換級別。刻意比右半窄，視覺上「送出」才是主要動作。
      '.ntfy-teams-sendlvl{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;',
      'padding:0 10px;margin:0;border:0;cursor:pointer;font:inherit;font-size:11px;',
      'line-height:1;white-space:nowrap;',
      'color:color-mix(in srgb, var(--ntfy-tone) 78%, var(--dsw-alias-label-primary));',
      'background:transparent;}',
      '.ntfy-teams-sendlvl:hover:not(:disabled){',
      'background:color-mix(in srgb, var(--ntfy-tone) 16%, transparent);}',
      '.ntfy-teams-sendlvl:disabled{cursor:default;opacity:.45;}',
      '.ntfy-teams-sendlvl:focus-visible{outline:2px solid var(--dsw-static-blue-500);outline-offset:-2px;}',
      // 分隔線：用 tone 的淡色，讓兩半看起來是「同一顆按鈕的兩個區」
      '.ntfy-teams-senddiv{width:1px;flex:0 0 auto;',
      'background:color-mix(in srgb, var(--ntfy-tone) 30%, transparent);}',
      '.ntfy-teams-sendgo{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;',
      'padding:0 14px;margin:0;border:0;cursor:pointer;font:inherit;font-size:13px;',
      'font-weight:600;line-height:1;white-space:nowrap;',
      'color:color-mix(in srgb, var(--ntfy-tone) 82%, var(--dsw-alias-label-primary));',
      'background:transparent;}',
      '.ntfy-teams-sendgo:hover:not(:disabled){',
      'background:color-mix(in srgb, var(--ntfy-tone) 18%, transparent);}',
      '.ntfy-teams-sendgo:disabled{cursor:default;opacity:.45;}',
      '.ntfy-teams-sendgo:focus-visible{outline:2px solid var(--dsw-static-blue-500);outline-offset:-2px;}',
      // 強度格：4 格，高度由矮到高（階梯）
      '.ntfy-teams-pribars{display:inline-flex;align-items:flex-end;gap:1.5px;height:12px;}',
      '.ntfy-teams-pribar{display:block;width:2.5px;border-radius:1px;',
      'background:color-mix(in srgb, var(--ntfy-tone) 26%, transparent);}',
      '.ntfy-teams-pribar[data-lv="1"]{height:4px;}',
      '.ntfy-teams-pribar[data-lv="2"]{height:6px;}',
      '.ntfy-teams-pribar[data-lv="3"]{height:8px;}',
      '.ntfy-teams-pribar[data-lv="4"]{height:11px;}',
      '.ntfy-teams-pribar--on{background:var(--ntfy-tone) !important;}',
      // 窄畫面時**由外而內依序省略最不重要的文字**，而不是折行。
      //
      // 斷點怎麼定的（實測，不是猜的）：這一列全部文字都顯示需要 ~490px
      // （身分 55 + 自動批準 80 + 永遠滾到最新 102 + 間距），
      // 而訊息串那一欄會隨視窗縮小（看板固定 300px）。
      // 優先級已經移出這一列，所以只剩兩個開關的文字需要讓位。
      '@media (max-width:800px){.ntfy-teams-autoapprovetext,.ntfy-teams-staybottomtext{',
      'display:none;}.ntfy-teams-autoapprove,.ntfy-teams-staybottom{padding:3px 6px;}}'
    ].concat(AVATAR_CSS).join('');

    // =========================================================================
    // 2. 图示（行内 SVG，只有图稿用自订颜色）
    // =========================================================================

    /**
     * 铃铛图示。线稿跟着 currentColor，尺寸由侧栏给的 size 决定。
     * @param props - { size, active }。
     * @returns SVG 元素。
     */
    function BellGlyph(props) {
      var size = (props && props.size) || 18;
      return e('svg', {
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
        e('path', { d: 'M4 6.6a4 4 0 0 1 8 0c0 2.7.9 3.7 1.4 4.2H2.6C3.1 10.3 4 9.3 4 6.6Z' }),
        e('path', { d: 'M6.6 13.1a1.6 1.6 0 0 0 2.8 0' })
      );
    }

    /**
     * 警示三角圖示（取消訂閱的確認條用）。
     *
     * 破壞性動作在前面放一個警示符號，比只靠文字更快讓人停下來看一眼。
     * 線稿跟著 `currentColor`，顏色由 `.ntfy-teams-confirmglyph` 決定（用 state-error）。
     *
     * @returns 圖示元素。
     */
    function WarnGlyph() {
      return e('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        // 三角形外框
        e('path', { d: 'M8 2.2 14.3 13H1.7z' }),
        // 中間的驚嘆號
        e('line', { x1: 8, y1: 6.4, x2: 8, y2: 9.4 }),
        e('line', { x1: 8, y1: 11.2, x2: 8, y2: 11.25 })
      );
    }

    /**
     * 齒輪圖示（「編輯共用設定」的入口），**帶顏色**。
     *
     * 語意：齒輪 = 「開啟／調整設定」，這正是這個入口做的事（帳號、顯示名稱）。
     *
     * ⚠️ 畫法刻意避開「太陽」：之前那顆被退回，是因為它畫成
     * 「**小圓 + 八條放射線**」—— 線從中心往外散開，視覺上就是太陽。
     *
     * 這裡改成真正的齒輪構造：
     *   1. 齒輪**本體是一個環**（外圓 r=7.2、內圓 r=3.2 的實心輪廓），
     *      環讓它看起來是「有厚度的機械件」而不是一條線；
     *   2. 齒是**從外圓再往外**的 8 段粗短線（r=7.2 → 8.9），
     *      方向朝外但**不從中心出發**，所以不會形成放射狀；
     *   3. 中心是一個**軸孔**（r=2.2，填底色），孔被環包住。
     *
     * 顏色用 `currentColor`，由按鈕 CSS 指定（.ntfy-teams-iconbtn--gear）——
     * hover／展開狀態可以獨立換色，不必改這裡。
     *
     * @returns 圖示元素。
     */
    function EditGlyph() {
      // 8 顆齒的角度與座標（每 45° 一顆）。用實際三角函式算，不寫死近似值。
      var teeth = [];
      for (var ti = 0; ti < 8; ti += 1) {
        var ang = (Math.PI / 4) * ti;
        var cos = Math.cos(ang);
        var sin = Math.sin(ang);
        teeth.push(e('line', {
          key: 'tooth' + ti,
          x1: 12 + cos * 7.1, y1: 12 + sin * 7.1,
          x2: 12 + cos * 8.9, y2: 12 + sin * 8.9
        }));
      }
      return e('svg', {
        width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        // 齒輪本體：一個有厚度的環（不是一條細線）
        e('circle', { cx: 12, cy: 12, r: 5.2, strokeWidth: 4 }),
        // 8 顆齒：從外圓往外，但不從中心出發
        teeth,
        // 軸孔：填成「透明」讓按鈕自己的底色透出來，看起來就是一個洞。
        // 不用 bg-base —— 那假設了底色一定是不透明的表面色，而這裡的按鈕底色是
        // 一層帶色調的半透明（color-mix），用 surface 色反而會在深色主題下變白點。
        e('circle', { cx: 12, cy: 12, r: 2, fill: 'transparent', stroke: 'none' })
      );
    }

    /** @returns 刷新图示。 */
    function RefreshGlyph() {
      return e('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        e('path', { d: 'M13.2 8a5.2 5.2 0 1 1-1.6-3.7' }),
        e('path', { d: 'M13.4 2.4v3.1h-3.1' })
      );
    }

    /**
     * 工作组图示：三个人 + 一个对话气泡。用于侧栏与面板抬头。
     * @param props - { size }。
     * @returns 图示元素。
     */
    function GroupGlyph(props) {
      var size = (props && props.size) || 18;
      return e('svg', {
        width: size, height: size, viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        e('circle', { cx: 7.2, cy: 7, r: 2.6 }),
        e('path', { d: 'M2.6 15.6c0-2.5 2.1-4.2 4.6-4.2s4.6 1.7 4.6 4.2' }),
        e('circle', { cx: 14.4, cy: 6.2, r: 2 }),
        e('path', { d: 'M12.6 11.2c2.6-.5 4.9 1 4.9 3.5' })
      );
    }

    /** @returns 傳送图示。 */
    function SendGlyph() {
      return e('svg', {
        width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        e('path', { d: 'M14.2 1.8 7.3 8.7' }),
        e('path', { d: 'M14.2 1.8 9.9 14.2 7.3 8.7 1.8 6.1Z' })
      );
    }

    /** @returns 成员图示（未具名时用）。 */
    function PersonGlyph() {
      return e('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        e('circle', { cx: 8, cy: 5.6, r: 2.6 }),
        e('path', { d: 'M3.2 13.6c0-2.6 2.2-4.4 4.8-4.4s4.8 1.8 4.8 4.4' })
      );
    }

    /** @returns 問號图示（「用這一天開新 session 復盤」）。 */
    function QuestionGlyph() {
      return e('svg', {
        width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      },
        e('circle', { cx: 8, cy: 8, r: 6.2 }),
        e('path', { d: 'M6.2 6.3a1.9 1.9 0 1 1 2.4 2.3v1.1' }),
        e('path', { d: 'M8.6 12.1h.01' })
      );
    }

    // =========================================================================
    // 3. 状态徽章 / 侧栏入口
    // =========================================================================

    /**
     * 待接手的草稿（「用這一天開新 session 復盤」用）。
     *
     * 為什麼要這樣傳：`uiWorkspace.startSession()` 是**開新工作階段**，不是
     * 「建立一個我拿得到 id 的 session」（回传 void），所以沒辦法直接往新 session
     * 的撰寫區塞字。改成把材料放在這裡，讓**下一個掛載的撰寫區**（就是新 session
     * 那一個）自己接過去，然後等使用者按送出。
     *
     * 只交給同一個主題的撰寫區；主題不同就留在原地，免得貼錯地方。
     */
    var pendingDraft = null;

    /** `ctx.uiWorkspace` 存在這裡，讓面板元件也能開新工作階段（元件拿不到 ctx）。 */
    var uiWorkspaceRef = null;

    /**
     * 取得 uiWorkspace 服務（可能不存在，例如舊版宿主）。
     * @returns 服務物件或 null。
     */
    function workspaceService() {
      return uiWorkspaceRef;
    }

    /**
     * 交出一份待接手的草稿（取用後即清除，只會被拿走一次）。
     * @param topic - 目前撰寫區的主題。
     * @returns 草稿文字，沒有就回空字串。
     */
    function givePendingDraft(topic) {
      if (!pendingDraft) return '';
      if (pendingDraft.topic !== text(topic)) return '';
      var body = pendingDraft.body;
      pendingDraft = null;
      return body;
    }

    /**
     * 把一則訊息標成決定／待辦，或把待辦結案。
     *
     * 做法是**再發一則帶原生 tag 的訊息**，內文是 `#<目標 id>`。理由：
     *   * ntfy 沒有「修改既有訊息」的能力，所以狀態只能是新訊息；
     *   * 用原生 `Tags` 欄位，別的客戶端／手機 App 也收得到 —— 群組記憶屬於群組，
     *     不是只存在我這台機器的 localStorage 裡。
     *
     * @param topic - 主題名。
     * @param msg - 被標記的訊息。
     * @param kind - 'decision' | 'action' | 'done'。
     * @param selfName - 自己的顯示名稱。
     * @param cred - 憑證。
     * @param done - 完成回呼（參數是錯誤字串，沒有錯誤就傳 null）。
     */
    function markMessage(topic, msg, kind, selfName, cred, done) {
      var callback = typeof done === 'function' ? done : function () {};
      if (!core || typeof core.publishMessage !== 'function') {
        callback('核心模組未載入');
        return;
      }
      // 結案要指「待辦那則標記訊息」，其餘指被標記的訊息本身。
      var targetId = (kind === 'done' && msg && msg.markerId) ? msg.markerId : (msg && msg.id);
      var body = typeof core.markerBody === 'function' ? core.markerBody(targetId, '') : '';
      if (body === '') {
        callback('這則訊息沒有 id，無法標記');
        return;
      }
      var payload = {
        message: body,
        title: titleFor(selfName),
        tags: [kind],
        cred: cred
      };
      core.publishMessage(core.readConfig().server, topic, payload).then(function (result) {
        if (result && result.ok) {
          // 立刻放進 store，不必等 SSE 推回來（自己的訊息本來就不算未讀）。
          if (result.message && core.store && typeof core.store.addMessage === 'function') {
            core.store.addMessage(topic, result.message);
          }
          callback(null);
          return;
        }
        callback(core.describeError ? core.describeError(result) : '標記失敗');
      }, function (err) {
        callback('標記失敗：' + text(err && err.message));
      });
    }

    /**
     * 把某一天的訊息整理成復盤材料，並建立一個**已經帶著這些討論**的新工作階段。
     *
     * 這一步必須走宿主：瀏覽器的 `uiWorkspace.startSession()` 回傳 void（拿不到新
     * session 的 id），而且面板會隨切換被宿主從 DOM 移除（拿不到它的撰寫區），
     * 所以「把內容放進去」在瀏覽器端做不到。
     *
     * 路徑：POST 到宿主的 `/ntfy-teams/session` → 宿主用 `agentLoop.createAgent({seed})`
     * 建立 session 並把討論寫成 seed → 這裡再 `uiWorkspace.openSession(id)` 切過去。
     *
     * 宿主不可用時（舊版、或路由沒掛上）**降級**成「開新工作階段 + 材料放剪貼簿」，
     * 並把降級原因回報給使用者 —— 不假裝成功。
     *
     * @param topic - 主題名。
     * @param day - { label, messages }。
     * @param selfName - 自己的顯示名稱（決定署名）。
     * @returns Promise<{ ok, error, count, mode }>。
     */
    function reviewDay(topic, day, selfName) {
      var label = day && day.label ? String(day.label) : '';
      var list = day && Array.isArray(day.messages) ? day.messages : [];
      var entries = [];
      for (var i = 0; i < list.length; i += 1) {
        var msg = list[i];
        if (!msg || typeof msg !== 'object') continue;
        var who = senderOf(msg, selfName);
        entries.push({
          name: who.hasName ? (who.isAnon ? ANON_NAME : who.name) : ANON_NAME,
          clock: formatClock(messageTime(msg)),
          text: text(msg.message)
        });
      }
      var built = (core && typeof core.buildDayReview === 'function')
        ? core.buildDayReview({
          topic: topic,
          label: label,
          entries: entries,
          notes: [
            '請幫我整理：',
            '1. 這一天討論了哪些重點？',
            '2. 有哪些決定或結論？',
            '3. 還有什麼沒解決的、需要誰跟進？'
          ]
        })
        : { title: label + ' 復盤', body: '', count: entries.length };

      var workspace = workspaceService();
      var server = '';
      try { server = core && typeof core.readConfig === 'function' ? core.readConfig().server : ''; } catch (err) { server = ''; }

      return createSeededSession({
        label: label,
        topic: text(topic),
        server: server,
        messages: entries
      }).then(function (result) {
        if (result && result.ok && result.sessionId) {
          if (workspace && typeof workspace.openSession === 'function') {
            try {
              workspace.openSession(result.sessionId);
              return { ok: true, error: '', count: entries.length, mode: 'seeded' };
            } catch (err) {
              return {
                ok: false,
                error: '工作階段已建立，但切換失敗：' + text(err && err.message),
                count: entries.length,
                mode: 'seeded'
              };
            }
          }
          return {
            ok: false,
            error: '工作階段已建立（' + result.sessionId + '），但 uiWorkspace 無法切換',
            count: entries.length,
            mode: 'seeded'
          };
        }
        // 降級：宿主不可用 → 開一個新的工作階段，材料放剪貼簿，讓使用者貼上。
        var copied = copyToClipboard(built.body);
        if (workspace && typeof workspace.startSession === 'function') {
          try {
            workspace.startSession();
            return {
              ok: false,
              error: (result && result.error ? result.error + '；' : '') + '已改為：開新工作階段'
                + (copied ? '並把材料複製到剪貼簿，貼上即可' : '，但剪貼簿複製失敗'),
              count: entries.length,
              mode: 'fallback'
            };
          } catch (err) {
            return { ok: false, error: text(err && err.message) || '開啟新工作階段失敗', count: entries.length, mode: 'fallback' };
          }
        }
        return {
          ok: false,
          error: (result && result.error) || '宿主不支援，且 uiWorkspace 服務不可用',
          count: entries.length,
          mode: 'fallback'
        };
      });
    }

    /**
     * 請宿主建立一個帶著討論內容的新工作階段。
     *
     * @param input - { label, topic, server, messages }。
     * @returns Promise<{ ok, sessionId?, error? }>；任何失敗都回 ok:false，不抛。
     */
    function createSeededSession(input) {
      if (typeof fetch !== 'function') {
        return Promise.resolve({ ok: false, error: '這個環境沒有 fetch' });
      }
      var url = SEED_SESSION_PATH;
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input)
      }).then(function (res) {
        return res.json().catch(function () { return null; }).then(function (payload) {
          if (!payload || typeof payload !== 'object') {
            return { ok: false, error: '宿主回應無法解析（HTTP ' + res.status + '）' };
          }
          if (payload.ok === true && typeof payload.sessionId === 'string' && payload.sessionId !== '') {
            return { ok: true, sessionId: payload.sessionId };
          }
          return { ok: false, error: text(payload.error) || ('宿主回應失敗（HTTP ' + res.status + '）') };
        });
      }, function (err) {
        return { ok: false, error: '連線宿主失敗：' + text(err && err.message) };
      });
    }

    /**
     * 把一段文字放進剪貼簿。非同步介面優先，同步的當備援。
     * @param value - 文字。
     * @returns 是否已送出複製（非同步複製無法即時得知成敗，回傳 true 代表已嘗試）。
     */
    function copyToClipboard(value) {
      var s = text(value);
      if (s === '') return false;
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard
          && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(s).catch(function () { /* 沒授權就算了 */ });
          return true;
        }
      } catch (err) { /* 換同步方式 */ }
      try {
        if (typeof document === 'undefined' || !document.createElement || !document.body) return false;
        var area = document.createElement('textarea');
        area.value = s;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(area);
        return !!ok;
      } catch (err) {
        return false;
      }
    }

    /**
     * 单一个 topic 的連線状态徽章。
     * @param props - { topic, status }。
     * @returns 徽章元素。
     */
    function StatusChip(props) {
      var status = props.status || { phase: 'idle', detail: '' };
      var phase = status.phase || 'idle';
      var label = PHASE_LABEL[phase] || phase;
      var title = props.topic + '：' + label + (status.detail ? '（' + status.detail + '）' : '');
      return e('span', {
        className: 'ntfy-teams-chip ntfy-teams-chip--' + phaseModifier(phase),
        title: title
      }, e('span', { className: 'ntfy-teams-dot' }), label);
    }

    /**
     * 側欄狀態圖示。
     *
     * 為什麼同時給「形狀」與「顏色」，不只給顏色：
     * 顏色單獨一項對色覺障礙者不成立（紅綠色盲看不出成功與失敗的差別），
     * 而側欄這個位置的資訊密度很高、圖示又小，只靠顏色更容易誤讀。
     * 所以每個狀態都有自己的形狀：✓ 正常、✕ 失敗、! 錯誤、… 連線中、• 未訂閱。
     *
     * @param props - { state, size }。
     * @returns SVG 元素。
     */
    function StatusGlyph(props) {
      var state = props && props.state ? props.state : 'idle';
      var size = (props && props.size) || 11;
      var common = {
        width: size, height: size, viewBox: '0 0 12 12',
        stroke: 'currentColor', strokeWidth: 1.7,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        fill: 'none', 'aria-hidden': 'true', focusable: 'false'
      };
      if (state === 'idle') {
        // 尚未訂閱任何主題：一個空心小圈（不是「連線正常」，那現在是 live）。
        return e('svg', common, e('circle', { cx: 6, cy: 6, r: 3.1, fill: 'currentColor', stroke: 'none' }));
      }
      if (state === 'live') {
        // 即時連線正常：實心圓加一圈外環，表示「掛著、活著」。
        // 跟 idle 的單點、unread 的雙圈都長得不一樣。
        return e('svg', common,
          e('circle', { cx: 6, cy: 6, r: 1.9, fill: 'currentColor', stroke: 'none' }),
          e('circle', { cx: 6, cy: 6, r: 4.1 })
        );
      }
      if (state === 'connecting') {
        // 連線中：三個點，跟「未訂閱」的單點區分開
        return e('svg', common,
          e('circle', { cx: 2.4, cy: 6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
          e('circle', { cx: 6, cy: 6, r: 1.15, fill: 'currentColor', stroke: 'none' }),
          e('circle', { cx: 9.6, cy: 6, r: 1.15, fill: 'currentColor', stroke: 'none' })
        );
      }
      if (state === 'offline') {
        // 未連線：中間一橫（像插頭拔掉／暫停）
        return e('svg', common, e('path', { d: 'M2.6 6h6.8' }));
      }
      if (state === 'retrying') {
        // 等待重試：一個旋轉的圓弧（像「重新整理」）。
        // 用圓弧而不是三角形：這不是「壞了」，是「正在自己救回來」——
        // 而且它有動畫，一眼就看得出「還在動」。
        return e('svg', Object.assign({}, common, { className: 'ntfy-teams-spin' }),
          e('path', { d: 'M9.4 3.6A4.6 4.6 0 1 0 10.6 6' }),
          e('path', { d: 'M10.5 1.7v2.6H7.9' })
        );
      }
      if (state === 'error') {
        // 錯誤：三角形加驚嘆號
        return e('svg', common,
          e('path', { d: 'M6 1.9 11 10.4H1z' }),
          e('path', { d: 'M6 5v2.2' }),
          e('path', { d: 'M6 8.9h.01' })
        );
      }
      if (state === 'unread') {
        // 新訊息：實心圓加一個小亮點，跟「正常」的純圓區分
        return e('svg', common,
          e('circle', { cx: 6, cy: 6, r: 4.2 }),
          e('circle', { cx: 6, cy: 6, r: 1.5, fill: 'currentColor', stroke: 'none' })
        );
      }
      // success：勾勾
      return e('svg', common, e('path', { d: 'M2.4 6.4 4.9 8.9 9.6 3.4' }));
    }

    /**
     * 把側欄的未讀數字定位到「標題文字的右邊」。
     *
     * 為什麼需要這一段程式：徽章住在宿主的「圖示」座位裡，標題是**宿主自己的元素**，
     * 而且在 DOM 順序上位於插槽之後 —— 所以純 CSS 沒辦法把徽章排到標題後面。
     * 唯一可行的是絕對定位 + 量出標題右緣（實測：插槽 22..38、標題 46..102，
     * 需要 86px 的位移，而這個值隨標題長度改變，不能寫死）。
     *
     * 這個值是動態的（側欄寬度、標題文字、縮放都會影響），所以掛 ResizeObserver
     * 重新量；不能只量一次。
     *
     * @param wrap - `.ntfy-teams-glyphwrap` 元素。
     * @returns 解除觀察的函式（沒有可觀察對象時回 undefined）。
     */
    function positionUnreadAfterTitle(wrap) {
      if (!wrap || typeof wrap.closest !== 'function') return undefined;
      // 沒有徽章就不用定位（未讀為 0 時）
      if (!wrap.querySelector('.ntfy-teams-unreadbadge')) return undefined;
      var row = wrap.closest('[class*="panelRow"]');
      if (!row) return undefined;
      var title = row.querySelector('[class*="panelTitle"]');
      if (!title) return undefined;

      /** 量一次並把結果寫進 CSS 變數。 */
      function measure() {
        if (!wrap.isConnected || !title.isConnected) return;
        var wr = wrap.getBoundingClientRect();
        var tr = title.getBoundingClientRect();
        if (wr.width === 0 || tr.width === 0) return;
        // 標題右緣 + 6px 間隙，換算成相對插槽左緣的位移
        var offset = tr.right + 6 - wr.left;
        wrap.style.setProperty('--ntfy-teams-badge-left', Math.max(0, Math.round(offset)) + 'px');
      }

      measure();
      if (typeof ResizeObserver !== 'function') return undefined;
      var ro = new ResizeObserver(measure);
      // 觀察插槽與標題：側欄寬度變了、標題文字變了都會觸發
      ro.observe(wrap);
      ro.observe(title);
      return function stop() {
        ro.disconnect();
      };
    }

    /**
     * 側欄圖示：點一下切換面板。
     *
     * 右上角是**未讀數量** badge，右下角是**連線狀態**指示燈（形狀 + 顏色）。
     * 兩個分開放，因為它們回答不同問題：「有幾則在等我」與「連線還好嗎」。
     *
     * 為什麼貼在圖示的角落，而不是整列的右上角：
     * 側欄那一列（`.hHd-Xa_panelRow`）是宿主自己的 `<button>`，我們只能把內容放進
     * 「圖示」這個座位（`sidebar.panellist`），拿不到那一列本身；宿主也沒有提供
     * 「數字徽章」或「狀態燈」這種座位。宿主的圖示容器（`.hHd-Xa_panelGlyph`）只是
     * `display:inline-flex`，沒有定位上下文，所以這裡自己造一個 `position:relative`
     * 的包裝當錨點，兩個標記都以絕對定位貼在它的角落。
     *
     * @param props - 側欄給的 { size, active, onClick }。
     * @returns 圖示元素。
     */
    function SidebarIcon(props) {
      var size = (props && props.size) || 18;
      var snapshot = useStore();
      var unread = totalUnread(snapshot);
      var badge = badgeText(unread);
      // 重試倒數要**會動**：side bar 的狀態是即時資訊，寫死一個秒數會誤導。
      // 只在真的有主題在等重試時才開這個 tick（其他狀態不需要每秒重繪）。
      var tickState = React.useState(0);
      var tick = tickState[0];
      var setTick = tickState[1];
      var health = (core && typeof core.sidebarHealth === 'function')
        ? core.sidebarHealth(snapshot)
        : { state: 'idle', label: '', detail: '', unread: unread };
      var retrying = health.state === 'retrying';
      React.useEffect(function () {
        if (!retrying) return undefined;
        var id = setInterval(function () { setTick(function (n) { return n + 1; }); }, 500);
        return function () { clearInterval(id); };
      }, [retrying]);
      // tick 只是用來觸發重繪；實際秒數由 sidebarHealth 依 nextRetryAt 現算。
      // 所以 health 要在 tick 之後**重新算一次**，否則畫面會停在第一次的秒數。
      if (tick > 0 && core && typeof core.sidebarHealth === 'function') {
        health = core.sidebarHealth(snapshot);
      }
      var wrapRef = React.useRef(null);

      // 徽章要落在「標題文字右邊」，而標題是宿主的元素、量出來的位移才準，
      // 所以掛一個 effect 去量並觀察變化（詳見 positionUnreadAfterTitle）。
      React.useEffect(function () {
        var stop = positionUnreadAfterTitle(wrapRef.current);
        return function cleanup() { if (typeof stop === 'function') stop(); };
      }, [badge]);

      // 提示文字：把「哪個主題壞了、幾則未讀」講清楚 —— 顏色本身不該是唯一的資訊來源。
      var title = PANEL_LABEL + '：' + health.label;
      if (health.detail && health.detail !== health.label) title += '（' + health.detail + '）';

      return e('span', {
        className: 'ntfy-teams-glyphwrap ntfy-teams-glyphwrap--' + health.state,
        ref: wrapRef,
        onClick: props && props.onClick,
        title: title
      },
        e('span', { className: 'ntfy-teams-iconwrap' },
          e(GroupGlyph, { size: size }),
          e('span', {
            className: 'ntfy-teams-health',
            role: 'img',
            'aria-label': '連線狀態：' + health.label,
            title: title
          }, e(StatusGlyph, { state: health.state }))
        ),
        badge !== ''
          ? e('span', {
            className: 'ntfy-teams-unreadbadge',
            role: 'status',
            'aria-label': unread + ' 則未讀訊息'
          }, badge)
          : null
      );
    }

    // =========================================================================
    // 4. 面板：共用設定（伺服器／帳號／顯示名稱）
    //
    // 這三樣**只有一份**，跟訂閱幾個主題無關：
    //   * 伺服器位址 —— 所有主題都連同一個 ntfy
    //   * 帳號憑證   —— 一份憑證對整個伺服器（core 以伺服器位址分桶，不是分主題）
    //   * 顯示名稱   —— 送出訊息的 #username 是全域的
    // 所以它們不再出現在主題那一層，只收在這個設定區塊裡，而且預設**收合**，
    // 只顯示一行摘要（伺服器 · 認證狀態），要用才展開。
    // =========================================================================

    /** 認證模式 → 中文標籤。 @param mode - 'none' | 'basic' | 'token'。 @returns 標籤。 */
    function authLabel(mode) {
      if (mode === 'basic') return '帳號密碼';
      if (mode === 'token') return '存取權杖';
      return '無認證';
    }

    /**
     * 共用設定的**一行摘要**（收合狀態）。
     *
     * 為什麼獨立成一個元件：這一行「帳號密碼 · 以 #Jinbe 傳送 · 全部主題共用 · 編輯」
     * 屬於**抬頭**，要跟標題、連線狀態排在同一個容器裡（需求：「以上各種提示，
     * 都應該放到 UI 的第一個容器內」）。原本它被包在 SettingsPanel 裡面，
     * 於是佔掉了標題底下整整一列的高度。
     *
     * 現在：抬頭放這個（只讀），編輯表單由 MainPanel 放到 body（可寫）。
     * 兩者共用同一份資料來源（core.loadCredentials / currentIdentity）——
     * 不是兩份 state，所以不會出現「摘要跟表單不一致」。
     *
     * @param props - { onEdit }。
     * @returns 摘要列元素。
     */
    function SettingsSummary(props) {
      var cfg = core && typeof core.readConfig === 'function' ? core.readConfig() : { server: '' };
      var cred = (core && typeof core.loadCredentials === 'function')
        ? core.loadCredentials(cfg.server || '')
        : { mode: 'none', user: '', password: '', token: '' };
      var name = currentIdentity();
      var hasCred = (cred.mode === 'basic' && (cred.user || cred.password))
        || (cred.mode === 'token' && cred.token);

      return e('div', { className: 'ntfy-teams-settingsbar' },
        e('span', { className: 'ntfy-teams-settingitem' },
          hasCred ? authLabel(cred.mode) : '無認證'),
        e('span', { className: 'ntfy-teams-sepdot' }, '·'),
        e('span', { className: 'ntfy-teams-settingitem' },
          name ? '以 ' + mention(name) + ' 傳送' : '尚未設定名稱'),
        e('span', { className: 'ntfy-teams-spacer' }),
        // 這裡原本還有一個「全部主題共用」的註記 —— 需求要拿掉這類字眼。
        // 它本來就是冗字：這些設定只有一份，而「共用」這件事在使用者按進編輯
        // 表單時已經由表單的說明交代了，摘要列只需要講「現在的狀態是什麼」。
        //
        // 編輯入口：**帶顏色的齒輪**圖示按鈕（需求）。
        // 保留 aria-label 與 title —— 圖示沒有文字，讀屏與 tooltip 都要靠它們。
        // aria-pressed 反映「表單是不是正開著」，CSS 據此把底色加深一階。
        e('button', {
          type: 'button',
          className: 'ntfy-teams-iconbtn ntfy-teams-iconbtn--gear',
          title: '編輯共用設定（帳號、顯示名稱）',
          'aria-label': '編輯共用設定',
          'aria-pressed': props && props.open ? 'true' : 'false',
          onClick: function () { if (props && typeof props.onEdit === 'function') props.onEdit(); }
        }, e(EditGlyph))
      );
    }

    /**
     * 共用設定區塊：收合時只有一行摘要，展開才編輯。
     * @param props - { onSaved, defaultOpen, onRequestClose }。
     * @returns 設定區塊元素。
     */
    function SettingsPanel(props) {
      var cfg = core && typeof core.readConfig === 'function' ? core.readConfig() : { server: '' };
      var serverState = React.useState(cfg.server || '');
      var server = serverState[0];
      var setServer = serverState[1];

      var credState = React.useState(function () {
        if (!core || typeof core.loadCredentials !== 'function') return { mode: 'none', user: '', password: '', token: '' };
        return core.loadCredentials(cfg.server || '');
      });
      var cred = credState[0];
      var setCred = credState[1];

      var noteState = React.useState(null);
      var note = noteState[0];
      var setNote = noteState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      // 顯示名稱：送出訊息時的 #username（全域一份）。
      var nameState = React.useState(function () { return currentIdentity(); });
      var name = nameState[0];
      var setName = nameState[1];

      // 收合／展開 —— **由外面控制**（受控元件）。
      //
      // 為什麼改成受控：抬頭那顆鉛筆現在是唯一的切換入口，而它同時負責開與關，
      // 所以「開著還是關著」必須是**單一來源**，由 MainPanel 持有；
      // 元件自己再存一份就會出現兩邊不同步（實測：齒輪的 aria-pressed
      // 變 true 但面板沒展開）。
      //
      // defaultOpen 只在外面沒給 open 時當初始值（讓測試仍能單獨驅動它）。
      var openState = React.useState(!!(props && (props.open !== undefined ? props.open : props.defaultOpen)));
      var open = openState[0];
      var setOpen = openState[1];
      var lastPropRef = React.useRef(!!(props && (props.open !== undefined ? props.open : props.defaultOpen)));
      React.useEffect(function () {
        var next = !!(props && (props.open !== undefined ? props.open : props.defaultOpen));
        if (lastPropRef.current === next) return;
        lastPropRef.current = next;
        setOpen(next);
      }, [props && (props.open !== undefined ? props.open : props.defaultOpen)]);

      /** 改一个憑證欄位。 @param key - 欄位名。 @param value - 新值。 */
      function patchCred(key, value) {
        setCred(function (prev) {
          var next = {};
          var k;
          for (k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
          next[key] = value;
          return next;
        });
      }

      /** 儲存憑證與顯示名稱並回報。 */
      function save() {
        if (!core) return;
        // 伺服器位址**不由 UI 決定**（使用者不能改、介面上也沒有那個欄位）。
        // 這裡只讀它來決定憑證分桶，不回寫設定。
        var target = typeof core.normalizeServer === 'function' ? core.normalizeServer(server) : server;
        if (typeof core.saveCredentials === 'function') core.saveCredentials(target, cred);
        // 顯示名稱就是送出訊息時的 #username。
        var stored = text(name).trim();
        if (typeof core.setIdentity === 'function') stored = text(core.setIdentity(stored));
        else if (typeof core.saveConfig === 'function') core.saveConfig({ identity: stored });
        setName(stored);
        setNote({ kind: 'ok', text: '已儲存' });
        if (props && typeof props.onSaved === 'function') props.onSaved(target, stored);
        // 落成 YAML（宿主）。憑證整份送去，因為 secrets 是一份完整的對應表。
        pushSettingsToHost({ secrets: collectSecrets() });
        // 憑證變了 → 立刻請即時連線重比指紋並**重建連線**。
        //
        // 為什麼一定要主動叫：改認證只動憑證快取，不會觸發 store 變更，
        // 所以 startLiveSync 那條「store 一變就重連」的路不會跑 ——
        // 連線還是用舊憑證，畫面一直顯示上一次的 403／401。
        recheckConnection();
        // 存好就收合。
        //
        // 為什麼：編輯這一區的目的就是「把帳密／名稱填好並存起來」，存完就沒有
        // 繼續開著的必要；留著展開會一直佔掉面板上方的高度（看板與訊息串都因此
        // 變矮）。收合後抬頭那一行摘要仍會顯示認證狀態與 #name，資訊沒有不見。
        setOpen(false);
        // 同步通知外面（抬頭的摘要與齒輪的 aria-pressed 由 MainPanel 持有）。
        if (props && typeof props.onRequestClose === 'function') props.onRequestClose();
      }

      /** 清除這個伺服器的憑證。 */
      function clear() {
        if (!core || typeof core.clearCredentials !== 'function') return;
        var target = typeof core.normalizeServer === 'function' ? core.normalizeServer(server) : server;
        core.clearCredentials(target);
        setCred({ mode: 'none', user: '', password: '', token: '' });
        setNote({ kind: 'ok', text: '已清除憑證' });
      }

      /** 連 /v1/health 測一下。 */
      function test() {
        if (!core || typeof core.testConnection !== 'function') return;
        var target = typeof core.normalizeServer === 'function' ? core.normalizeServer(server) : server;
        setBusy(true);
        setNote({ kind: 'ok', text: '測試中…' });
        core.testConnection(target, cred).then(function (result) {
          setBusy(false);
          if (result && result.ok) {
            setNote({ kind: 'ok', text: '連線成功（HTTP ' + result.status + '）' });
          } else {
            setNote({ kind: 'err', text: '連線失敗：' + humanError(result) });
          }
        }, function (err) {
          setBusy(false);
          setNote({ kind: 'err', text: '連線失敗：' + text(err && err.message) });
        });
      }

      var modeOptions = [
        { value: 'none', label: '無認證' },
        { value: 'basic', label: '帳號密碼' },
        { value: 'token', label: '存取權杖' }
      ];

      // 收合時**不渲染任何東西**：那一行摘要已經搬到抬頭（見 SettingsSummary）。
      // 這裡只負責展開的編輯表單，所以收合就回 null，不再佔用 body 一列高度。
      if (!open) return null;

      // 展開：編輯表單。
      //
      // 表單標頭那一列整個拿掉了：
      //   * 說明文字「以下設定對所有主題生效…」→ 需求要去掉這類字眼；
      //   * 「收合」按鈕 → 需求要去掉。
      // 收起改用抬頭那顆**齒輪**（它就是同一顆、同一個位置的切換：
      // 沒開就開、開著就收），所以不需要再一顆專門的「收合」。
      //
      // 這裡只留「顯示名稱 / 認證方式」兩個欄位與它們的操作按鈕。
      return e('div', { className: 'ntfy-teams-settings ntfy-teams-settings--open' },
        e('div', { className: 'ntfy-teams-connrow' },
          e('label', { className: 'ntfy-teams-field', htmlFor: 'ntfy-teams-identity' }, '顯示名稱'),
          e('input', {
            id: 'ntfy-teams-identity',
            className: 'ntfy-teams-input ntfy-teams-input--handle',
            type: 'text',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: '例如 shawoo',
            value: name,
            onChange: function (ev) { setName(ev.target.value); }
          }),
          e('span', { className: 'ntfy-teams-field' },
            '送出訊息時顯示為 ' + (titleFor(name) || '#…'))
        ),
        e('div', { className: 'ntfy-teams-connrow' },
          e('label', { className: 'ntfy-teams-field', htmlFor: 'ntfy-teams-mode' }, '認證方式'),
          e('select', {
            id: 'ntfy-teams-mode',
            className: 'ntfy-teams-select',
            value: cred.mode || 'none',
            onChange: function (ev) { patchCred('mode', ev.target.value); }
          }, modeOptions.map(function (opt) {
            return e('option', { key: opt.value, value: opt.value }, opt.label);
          })),
          cred.mode === 'basic' ? e('input', {
            className: 'ntfy-teams-input ntfy-teams-input--grow',
            type: 'text',
            autoComplete: 'off',
            spellCheck: false,
            placeholder: '使用者名稱',
            value: cred.user || '',
            onChange: function (ev) { patchCred('user', ev.target.value); }
          }) : null,
          cred.mode === 'basic' ? e('input', {
            className: 'ntfy-teams-input ntfy-teams-input--grow',
            type: 'password',
            autoComplete: 'new-password',
            placeholder: '密碼',
            value: cred.password || '',
            onChange: function (ev) { patchCred('password', ev.target.value); }
          }) : null,
          cred.mode === 'token' ? e('input', {
            className: 'ntfy-teams-input ntfy-teams-input--grow',
            type: 'password',
            autoComplete: 'new-password',
            spellCheck: false,
            placeholder: 'tk_ 開頭的存取權杖',
            value: cred.token || '',
            onChange: function (ev) { patchCred('token', ev.target.value); }
          }) : null,
          e('button', { type: 'button', className: 'ntfy-teams-btn', disabled: busy, onClick: test }, '測試連線'),
          e('button', { type: 'button', className: 'ntfy-teams-btn ntfy-teams-btn--primary', onClick: save }, '儲存'),
          e('button', { type: 'button', className: 'ntfy-teams-btn ntfy-teams-btn--ghost', onClick: clear }, '清除憑證')
        ),
        props && props.hint ? e('div', { className: 'ntfy-teams-hint' }, props.hint) : null,
        note ? e('div', {
          className: 'ntfy-teams-hint' + (note.kind === 'err' ? ' ntfy-teams-hint--err' : ' ntfy-teams-hint--ok')
        }, note.text) : null
      );
    }

    // =========================================================================
    // 5. 面板：topic 列
    // =========================================================================

    /**
     * 讓**記憶體設定**（`core.readConfig().topics`）與 **store** 的訂閱清單對齊。
     *
     * 為什麼需要：清單有**兩份**，而它們的用途不同 ——
     *   * `store`       —— 畫面上的即時狀態（權威）；
     *   * 記憶體設定     —— `bootStore()` 在面板重掛時用來起一份 store 的種子。
     *
     * 開機時 `syncSettingsFromHost()` 會把宿主的 topics 寫進記憶體設定，所以
     * 兩份一開始是一致的。但**刪除只動了 store**，記憶體設定裡還留著那一個 ——
     * 於是「刪掉 → 切到別的畫面 → 切回來」時，`bootStore()` 從記憶體設定又把
     * 剛刪掉的主題灌回 store（實測就是這個復現步驟：切走再切回必現）。
     *
     * 為什麼 F5 就不會重現：重新載入後記憶體設定是空的（模組重跑），
     * 只從宿主的 YAML 重建，而 YAML 已經沒有那一個了。
     *
     * 為什麼以前的測試抓不到：探針主題常常只進了 store、**沒進記憶體設定**
     * （因為探針是直接呼叫 `store.ensureTopic`），少了這一步自然不會復活 ——
     * 看起來像「已經修好了」。要復現必須先讓記憶體設定也有那個主題。
     *
     * 兩份清單從此在任何變更後都保持一致。
     */
    function syncTopicListToConfig() {
      if (!core || !core.store || typeof core.saveConfig !== 'function') return;
      if (typeof core.store.getSnapshot !== 'function') return;
      try {
        core.saveConfig({ topics: (core.store.getSnapshot().topics || []).slice() });
      } catch (err) {
        // 對齊失敗不該影響主要動作（刪除／新增本身已經做完了）。
      }
    }

    /**
     * 把訂閱清單立刻寫回**宿主**（不再有 localStorage）。
     *
     * core.store 是純狀態、不自己做 I/O；持久層唯一一份就是宿主的 `config.yml`。
     * 所以這裡只做一件事：立刻（受守門控制）把設定推回宿主。
     *
     * 歷史上這裡曾經同時寫 localStorage 與宿主 —— 兩個真相互相覆蓋，造成了
     * 「刪掉的主題又出現」「重新整理後設定被舊值蓋掉」等一連串 bug。
     * 現在只有宿主這一份。
     *
     * @returns 是否受理（首次同步完成前會排隊延後送出）。
     */
    function saveSubscriptions() {
      if (!core || !core.store) return false;
      requestHostWrite();
      return true;
    }

    /**
     * 把「訂閱清單」這個設定寫進宿主的 YAML。
     *
     * 為什麼一定要寫：訂閱清單是**設定**，不是快取；而且持久層**只有**這一份
     * （這個外掛不使用 localStorage）。所以它不存在「換瀏覽器就沒了」的問題 ——
     * 反倒是瀏覽器快取曾經造成「刪掉的主題又出現」那類兩個真相的 bug。
     *
     * 這裡保留 debounce：改一個主題會走好幾次 store 更新，逐次 PUT 沒必要。
     * 但**破壞性動作**（取消訂閱等）走的是 writeSettingsNow()，不 debounce ——
     * 因為使用者可能改完馬上重新整理，排程會被卸載吃掉。
     */
    function saveTopicsToHost() {
      // debounce：改一個主題會走好幾次 store 更新，逐次 PUT 沒必要。
      if (hostSaveTimer !== null) clearTimeout(hostSaveTimer);
      hostSaveTimer = setTimeout(function () {
        hostSaveTimer = null;
        // 讀「送出當下」的設定，而不是排程當下的 —— 中途還有變更的話，
        // 這樣寫進去的才是最後的狀態。
        pushSettingsToHost(null).then(function (r) {
          if (r && r.ok === false && typeof console !== 'undefined' && console.warn) {
            console.warn('[ntfy-teams] 訂閱清單寫入宿主 YAML 失敗：', r.error);
          }
        });
      }, 400);
    }

    /**
     * topic 列：切换、未读、新增、移除，以及**双击改别名**。
     *
     * 别名：chip 上显示的是别名，没设别名就显示主题名（也就是「空 = 用主题名」）。
     * 双击 chip 会就地变成输入框：Enter／失焦提交，Esc 取消；提交时清空 = 清除别名。
     * 主题名本身不变，别名只是显示用的标签。
     *
     * @param props - { snapshot }。
     * @returns topic 列元素。
     */
    function TopicBar(props) {
      var snapshot = props.snapshot;
      var topics = snapshot.topics || [];
      var addingState = React.useState(false);
      var adding = addingState[0];
      var setAdding = addingState[1];
      var draftState = React.useState('');
      var draft = draftState[0];
      var setDraft = draftState[1];
      // 正在改哪个 chip 的别名（null = 没有）。
      var editState = React.useState(null);
      var editing = editState[0];
      var setEditing = editState[1];
      // 正在等确认移除的 topic（null = 没有）。
      var confirmState = React.useState(null);
      var confirming = confirmState[0];
      var setConfirming = confirmState[1];
      // 别名存在 config，不是 store，所以改完不会自动触发重绘；用这个计数强制重画。
      var revState = React.useState(0);
      var setRev = revState[1];
      // 訂閱被擋下時的提示（例如超過上限）。null = 沒有訊息。
      var limitState = React.useState('');
      var limitNote = limitState[0];
      var setLimitNote = limitState[1];
      var topicLimit = (core && typeof core.MAX_TOPICS === 'number') ? core.MAX_TOPICS : 5;

      /** 读一个主题的显示名（别名优先，空则主题名）。 */
      function labelOf(topic) {
        if (core && typeof core.topicLabel === 'function') {
          try {
            return text(core.topicLabel(topic)) || topic;
          } catch (err) {
            // 退化到主题名
          }
        }
        var aliases = {};
        try {
          aliases = (core && core.readConfig().aliases) || {};
        } catch (err) {
          aliases = {};
        }
        return text(aliases[topic]).trim() || topic;
      }

      /**
       * 這個主題是不是**受保護的預設主題**（不可改名、不可取消訂閱）。
       *
       * 為什麼要保護：`pub_dsh` 是這個部署的預設群組，被使用者刪掉或改名之後，
       * 「預設主題」這個保證就沒有了 —— 新成員進來看不到共用的那個群組。
       * 所以它是一個固定錨點，而不是普通訂閱。
       *
       * 判定放在 core（`core.DEFAULT_TOPIC`）當單一來源，UI 只是查詢。
       *
       * @param topic - 主題名。
       * @returns 是否受保護。
       */
      function protectedTopic(topic) {
        var def = (core && core.DEFAULT_TOPIC) ? text(core.DEFAULT_TOPIC) : '';
        if (def === '') return false;
        return text(topic).trim() === def;
      }

      /**
       * 提交别名。空字串 = 清除别名（显示回主题名）。
       * @param topic - 主题名。
       * @param value - 输入框的值。
       */
      function commitAlias(topic, value) {
        // 受保護的主題不接受改名（第二道防線；第一道是 UI 不給開編輯框）。
        if (protectedTopic(topic)) {
          setEditing(null);
          return;
        }
        if (core && typeof core.setTopicAlias === 'function') {
          try {
            core.setTopicAlias(topic, text(value));
          } catch (err) {
            // 忽略：写不进去也只是别名没生效，不该让整个面板炸掉
          }
        }
        setEditing(null);
        setRev(function (n) { return n + 1; });
      }

      /** 把輸入框裡的名字加進訂閱清單（超過上限就擋下並說明）。 */
      function commit() {
        var name = text(draft).trim();
        if (name === '') { setAdding(false); return; }
        // 上限檢查：規則在 core（單一來源、可測試），這裡只負責顯示。
        if (core && typeof core.canSubscribe === 'function') {
          var verdict = core.canSubscribe(topics, name);
          if (!verdict.ok) {
            setLimitNote(verdict.reason || '無法新增主題。');
            return;   // 保留輸入框內容，讓使用者可以改
          }
        }
        if (core && core.store && typeof core.store.ensureTopic === 'function') {
          core.store.ensureTopic(name);
          if (typeof core.store.setActiveTopic === 'function') core.store.setActiveTopic(name);
          // 新增也要對齊記憶體設定 —— 否則「新增 → 切走 → 切回」時，
          // bootStore() 會從記憶體設定起一份**還沒有這個主題**的 store，它就消失了。
          // （跟刪除是同一類問題，方向相反。）
          syncTopicListToConfig();
          saveSubscriptions();
        }
        setLimitNote('');
        setDraft('');
        setAdding(false);
      }

      /**
       * 选一个 topic。
       *
       * 一定要在 setActiveTopic **之前**把未讀數交出去：store 會在切換的同時把未讀
       * 歸零（角標要立刻消失，這是對的），而那是唯一一次還讀得到 >0 的時機。
       * 面板拿不到這個值就永遠畫不出未讀線（實測：切過去之後永遠是 0）。
       *
       * @param topic - topic 名。
       */
      function select(topic) {
        if (props && typeof props.onWillActivate === 'function') props.onWillActivate(topic);
        if (core && core.store && typeof core.store.setActiveTopic === 'function') {
          core.store.setActiveTopic(topic);
          saveSubscriptions();
        }
      }

      /**
       * 真的移除一个 topic（顺便清掉它的别名，别留孤儿）。
       * **只由确认动作呼叫** —— 见下面 requestRemove。
       * @param topic - topic 名。
       */
      function doRemove(topic) {
        // 受保護的預設主題不可刪（第二道防線；UI 根本不會給出取消訂閱的入口）。
        // 保留這道是因為刪除是破壞性動作 —— 不能只靠「按鈕沒渲染」來保證。
        if (protectedTopic(topic)) {
          setConfirming(null);
          return;
        }
        if (core && core.store && typeof core.store.removeTopic === 'function') {
          core.store.removeTopic(topic);
          // ⚠️ **記憶體設定（core.readConfig().topics）也要一起更新**，見 syncTopicListToConfig()。
          syncTopicListToConfig();
          saveSubscriptions();
          // 取消訂閱是破壞性動作 → **立刻**寫回宿主，不等 400ms debounce。
          // 使用者「刪完馬上重新整理」時 debounce 會被卸載吃掉，刪除就遺失了
          // —— 那正是「刪除又出現」。（實測：0ms 刷新必現。）
          writeSettingsNow();
          // 別名一起清掉（原本在下面做，但那是另一個 store 之外的狀態），
          // 這裡順便再寫一次，確保兩份都落盤。
          if (core && typeof core.setTopicAlias === 'function') {
            try { core.setTopicAlias(topic, ''); } catch (err) { /* 清不掉孤兒別名不是致命問題 */ }
            writeSettingsNow();
          }
        }
        if (core && typeof core.setTopicAlias === 'function') {
          try {
            core.setTopicAlias(topic, '');
          } catch (err) {
            // 清不掉孤儿别名不是致命问题
          }
        }
        if (editing === topic) setEditing(null);
        setConfirming(null);
      }

      /**
       * 请求移除一个 topic —— 先请使用者确认，不直接删。
       *
       * 取消订阅是破坏性操作（历史清单就没了），按错一下不该生效，所以中间一定有
       * 一步确认。这里用面板内嵌的确认条而不是系统的 confirm()：宿主是 Web GUI，
       * 内嵌的确认条能吃到主题令牌、也能被测试与键盘操作。
       *
       * @param ev - 点击事件。
       * @param topic - topic 名。
       */
      function requestRemove(ev, topic) {
        ev.stopPropagation();
        setConfirming(topic);
      }

      var chips = topics.map(function (topic) {
        var unread = (snapshot.unreadByTopic && snapshot.unreadByTopic[topic]) || 0;
        var active = snapshot.activeTopic === topic;
        var label = labelOf(topic);
        var renamed = label !== topic;
        var isEditing = editing === topic;
        // 預設主題（pub_dsh）是固定錨點：不可改名、不可取消訂閱。
        var locked = protectedTopic(topic);

        // 改别名中：chip 就地变成输入框。
        if (isEditing) {
          return e('div', {
            key: topic,
            className: 'ntfy-teams-topic ntfy-teams-topic--editing'
              + (active ? ' ntfy-teams-topic--active' : '')
          },
            e('input', {
              className: 'ntfy-teams-input ntfy-teams-aliasinput',
              type: 'text',
              autoFocus: true,
              spellCheck: false,
              defaultValue: renamed ? label : '',
              placeholder: topic,
              title: '留空 = 使用主題名「' + topic + '」',
              'aria-label': '「' + topic + '」的顯示名稱',
              // chip 本身有 onClick=select，这里要挡掉，否则点输入框会切换主题。
              onClick: function (ev) { ev.stopPropagation(); },
              onKeyDown: function (ev) {
                if (ev.key === 'Enter') {
                  ev.preventDefault();
                  commitAlias(topic, ev.currentTarget.value);
                } else if (ev.key === 'Escape') {
                  ev.preventDefault();
                  setEditing(null);
                }
              },
              onBlur: function (ev) { commitAlias(topic, ev.currentTarget.value); }
            })
          );
        }

        return e('div', {
          key: topic,
          className: 'ntfy-teams-topic'
            + (active ? ' ntfy-teams-topic--active' : '')
            // 有未讀就把 chip 點亮 —— 數字角標之外再多一層提示。
            + (unread > 0 ? ' ntfy-teams-topic--unread' : '')
            + (locked ? ' ntfy-teams-topic--locked' : ''),
          role: 'tab',
          tabIndex: 0,
          'aria-selected': active ? 'true' : 'false',
          title: locked
            // 受保護的主題：tooltip 說明「為什麼不能改」，而不是留一個按了沒反應的提示
            ? label + '（' + topic + '）— 預設群組，不可改名或取消訂閱'
            : ((renamed
              ? label + '（' + topic + '）— 雙擊可改顯示名稱'
              : topic + ' — 雙擊可改顯示名稱')
              + (unread > 0 ? '｜未讀 ' + unread + ' 則' : '')),
          onClick: function () { select(topic); },
          onDoubleClick: function (ev) {
            ev.preventDefault();
            // 受保護的主題不進編輯狀態（連輸入框都不開）
            if (locked) return;
            setEditing(topic);
          },
          onKeyDown: function (ev) {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              select(topic);
            } else if (ev.key === 'F2') {
              ev.preventDefault();
              if (locked) return;   // 受保護的主題不給改名
              setEditing(topic);
            }
          }
        },
          e('span', { className: 'ntfy-teams-topicname' }, label),
          renamed
            ? e('span', { className: 'ntfy-teams-aliasdot', title: '已設定顯示名稱（' + topic + '）' }, '\u2022')
            : null,
          unread > 0 ? e('span', { className: 'ntfy-teams-badge' }, badgeText(unread)) : null,
          // 受保護的主題把「取消訂閱」換成一把鎖：位置一樣、但不可按。
          // 直接不渲染按鈕（而不是 disabled）讓它連點擊路徑都不存在。
          locked
            ? e('span', {
              className: 'ntfy-teams-topiclock',
              title: '預設群組',
              'aria-label': '預設群組，不可取消訂閱'
            }, '\uD83D\uDD12')
            : e('button', {
              type: 'button',
              className: 'ntfy-teams-topic-x',
              title: '取消訂閱 ' + topic,
              'aria-label': '取消訂閱 ' + topic,
              onClick: function (ev) { requestRemove(ev, topic); }
            }, '\u00d7')
        );
      });

      if (adding) {
        chips.push(e('input', {
          key: '__add',
          className: 'ntfy-teams-input',
          autoFocus: true,
          spellCheck: false,
          placeholder: 'topic 名稱，例如 pub_demo',
          value: draft,
          onChange: function (ev) { setDraft(ev.target.value); },
          onKeyDown: function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
            if (ev.key === 'Escape') { ev.preventDefault(); setDraft(''); setAdding(false); }
          },
          onBlur: commit
        }));
      } else {
        var atLimit = topics.length >= topicLimit;
        chips.push(e('button', {
          key: '__add',
          type: 'button',
          // 不要借用 `--active`：那是「聚焦中的主題」的反色外觀，
          // 借用的話鈕會跟聚焦的 chip 長得一模一樣（實測就是這樣，
          // 反色改上去之後那顆按鈕變成整條主題列上最顯眼的東西）。
          // 它的預設外觀由 `.ntfy-teams-topic--add` 負責（虛線框、淡底）。
          className: 'ntfy-teams-topic ntfy-teams-topic--add',
          // 到達上限時把原因寫在 title 裡 —— 不要讓按鈕看起來壞掉，
          // 而是讓使用者知道要先取消一個。
          title: atLimit
            ? '已達上限 ' + topicLimit + ' 個主題，請先取消一個'
            : '訂閱新的主題（最多 ' + topicLimit + ' 個）',
          onClick: function () {
            if (atLimit) {
              setLimitNote('最多只能訂閱 ' + topicLimit + ' 個主題（目前已有 ' + topics.length + ' 個），請先取消一個再新增。');
              return;
            }
            setLimitNote('');
            setAdding(true);
          }
        }, '+ 訂閱主題', e('span', { className: 'ntfy-teams-topiccount' }, topics.length + '／' + topicLimit)));
      }

      // 上限提示：只在真的被擋下時出現，平常不佔版面。
      if (limitNote !== '') {
        chips.push(e('div', {
          key: '__limit',
          className: 'ntfy-teams-limitnote',
          role: 'alert'
        }, limitNote));
      }

      // 確認條：取代群組列，等使用者明確決定才真的移除。
      if (confirming !== null) {
        // 先把要刪的 topic 綁進閉包。
        //
        // 不要寫成 `onClick: function () { doRemove(confirming); }`：doRemove 會
        // setConfirming(null) 觸發重繪，而瀏覽器裡的重繪是**非同步**的，
        // 但這裡測試替身的重繪是同步的 —— 同步時 confirming 已經變成 null，
        // 就會變成「確認條關掉了、但什麼都沒刪」。實測就是這個 bug。
        // 綁進閉包後，兩種時序都拿到同一個值。
        var pending = confirming;
        return e('div', { className: 'ntfy-teams-groupbar ntfy-teams-groupbar--confirm' },
          // 警示符號：破壞性動作前面放一個，比只靠文字更快讓人停一下。
          e('span', { className: 'ntfy-teams-confirmglyph' }, e(WarnGlyph)),
          e('span', { className: 'ntfy-teams-confirmtext' },
            '取消訂閱「' + labelOf(pending) + '」？'),
          labelOf(pending) !== pending
            ? e('span', { className: 'ntfy-teams-settingnote' }, '(' + pending + ')')
            : null,
          e('span', { className: 'ntfy-teams-spacer' }),
          e('button', {
            type: 'button',
            className: 'ntfy-teams-btn',
            onClick: function () { setConfirming(null); }
          }, '保留'),
          e('button', {
            type: 'button',
            className: 'ntfy-teams-btn ntfy-teams-btn--danger',
            autoFocus: true,
            onKeyDown: function (ev) {
              if (ev.key === 'Escape') { ev.preventDefault(); setConfirming(null); }
            },
            onClick: function () { doRemove(pending); }
          }, '取消訂閱')
        );
      }

      return e('div', { className: 'ntfy-teams-groupbar', role: 'tablist' }, chips);
    }

    // =========================================================================
    // 6. 面板：訊息串（群組對話）
    // =========================================================================

    /**
     * 一則訊息：頭像 + 傳送者 + 時間 + markdown 內文。
     *
     * 沒有 `#` 開頭的 title 就不算有發送者：這裡**不標示**「未具名」，
     * 只留白（連頭像也不畫），但那個 title 的內容會當成內文的標題顯示。
     *
     * **自己的訊息靠右**（頭像與文字都鏡射），別人的靠左 —— 左右分邊是最快
     * 分辨「誰說的」的方式。
     *
     * @param props - { msg, selfName }。
     * @returns 訊息元素。
     */
    /**
     * 一顆頭像。
     * @param name - 顯示名稱。
     * @param hue - 色相索引。
     * @returns 頭像元素。
     */
    function avatarNode(name, hue) {
      return e('div', {
        className: 'ntfy-teams-avatar ntfy-teams-avatar--h' + (hue % 12),
        title: mention(name),
        'aria-hidden': 'true'
      }, avatarText(name));
    }

    function MessageRow(props) {
      var msg = props.msg;
      var when = messageTime(msg);
      var tags = Array.isArray(msg.tags) ? msg.tags : [];
      var sender = senderOf(msg, props.selfName);
      var plainTitle = plainTitleOf(msg);
      // 這則訊息自己是不是「標記訊息」（決定／待辦／結案）——是的話不給動作按鈕，
      // 也不會被當成一般討論內容來標記。
      var markerTags = (core && typeof core.markerTagsOf === 'function')
        ? core.markerTagsOf(msg)
        : [];
      var isMarkerMsg = markerTags.length > 0;
      // 這則訊息目前被標成什麼（由 MessageList 從整串推導後傳下來）。
      var markedMap = props.markedBy || null;
      var marked = (markedMap && msg && msg.id !== undefined) ? markedMap[String(msg.id)] : null;
      var hue = avatarHue(sender.name);
      var cls = 'ntfy-teams-msg'
        + (sender.isSelf ? ' ntfy-teams-msg--self' : '')
        + (sender.isAnon ? ' ntfy-teams-msg--anon' : '')
        // 隔行底色：只用一層很淡的令牌，不要濃到變成「有框的卡片」。
        + (props.alt ? ' ntfy-teams-msg--alt' : '')
        + (props.isNew ? ' ntfy-teams-msg--new' : '');

      // 自己送的放右邊：頭像鏡射到右側，文字靠右（氣泡型聊天軟體的慣例，
      // 讓「誰說的」一眼可辨）。其他人的維持在左邊。
      // 沒有發送者的訊息名稱是 `--`，格式與其他人一致（不再特別留白）。
      //
      // 頭像與時間綁成一小塊（頭像在上、時間在下），這樣每一列的時間都在同一個
      // 水平位置上，不會被名字長短推來推去 —— 整串讀起來才整齊。
      //
      // 沒有時間的訊息（formatClock 回空字串）就不要畫那個 span：留一個空的
      // 元素會多出 flex 的 2px 間隙，讓那幾列跟別人不一樣高。
      var clockText = formatClock(when);
      var avatarBox = e('div', { className: 'ntfy-teams-msgav' },
        avatarNode(sender.name, hue),
        clockText !== ''
          ? e('span', {
            className: 'ntfy-teams-clock',
            title: when ? new Date(when * 1000).toString() : ''
          }, clockText)
          : null
      );
      var body = e('div', { className: 'ntfy-teams-msgbody' },
        e('div', { className: 'ntfy-teams-msghead' },
          e('span', {
            className: 'ntfy-teams-sender'
              + (sender.isSelf ? ' ntfy-teams-sender--self' : '')
              + (sender.isAnon ? ' ntfy-teams-sender--anon' : '')
          }, sender.isAnon ? ANON_NAME : mention(sender.name)),
          sender.isSelf ? e('span', { className: 'ntfy-teams-you' }, '你') : null,
          tags.length > 0
            ? e('span', { className: 'ntfy-teams-tags' }, tags.map(function (tag, i) {
              return e('span', { key: String(tag) + i, className: 'ntfy-teams-tag' }, text(tag));
            }))
            : null
        ),
        // 群組動作：標成「決定」或「待辦」。滑過訊息列才出現，平時不打擾。
        // 這兩個動作會發一則帶原生 tag 的訊息，所以是全群可見的，不是本機狀態。
        // 標記訊息本身不給動作按鈕（它們是控制訊息，不是討論內容）。
        typeof props.onMark === 'function' && !isMarkerMsg
          ? e('div', { className: 'ntfy-teams-acts' },
            e('button', {
              type: 'button',
              className: 'ntfy-teams-act' + (marked && marked.state === 'decision' ? ' ntfy-teams-act--on' : ''),
              title: '把這則標成決定（全群可見）',
              'aria-label': '把這則標成決定',
              onClick: function () { props.onMark(msg, 'decision'); }
            }, '✓ 決定'),
            e('button', {
              type: 'button',
              className: 'ntfy-teams-act' + (marked && marked.state === 'action' ? ' ntfy-teams-act--on' : ''),
              title: '把這則標成待辦（全群可見）',
              'aria-label': '把這則標成待辦',
              onClick: function () { props.onMark(msg, 'action'); }
            }, '☐ 待辦'),
            marked && marked.state === 'action'
              ? e('button', {
                type: 'button',
                className: 'ntfy-teams-act ntfy-teams-act--done',
                title: '把這則待辦結案',
                'aria-label': '把這則待辦結案',
                onClick: function () { props.onMark(msg, 'done'); }
              }, '⤺ 結案')
              : null
          )
          : null,
        // 不是發送者前綴的 title，當成內文標題顯示（否則會被靜靜吃掉）。
        plainTitle !== '' ? renderMarkdown('### ' + plainTitle) : null,
        msg.message ? renderMarkdown(msg.message) : null
      );

      // 頭像與內文的**順序永远一致**（頭像在前、內文在後），靠不靠右交给 CSS。
      //
      // ⚠️ 踩過的坑：這裡原本對「自己的訊息」額外把兩者**對調**：
      //     sender.isSelf ? e('div', cls, body, avatarBox)   // 內文在前
      //                   : e('div', cls, avatarBox, body);
      // 而 CSS 又對 `--self` 下了 `flex-direction:row-reverse` —— **兩次翻轉互相抵消**，
      // 結果自己的頭像落在內文**左邊**（實測：avatarLeft 929、bodyLeft 978），
      // 完全沒有「靠右」。
      //
      // 現在只翻一次：DOM 一律「頭像 → 內文」，CSS 的 row-reverse 把整列鏡射，
      // 於是自己的頭像自然跑到右邊。
      return e('div', { className: cls }, avatarBox, body);
    }

    // =========================================================================
    // 訊息串的日期跳轉列（右側中央）
    // =========================================================================

    /**
     * 「訊息串現在貼著底部嗎」的即時旗標（模組層）。
     *
     * 為什麼是模組層而不是元件內的 ref：寫入端是 `MessageList`（捲動事件在它身上），
     * 讀取端是 `MainPanel` 那個「把未讀歸零」的 effect —— 兩個是不同的元件，
     * 元件內的 ref 傳不過去。
     *
     * 為什麼不讓 effect 當場查 DOM（`panelIsFollowing()`）：effect 的執行時機
     * 跟捲動不同步，當場查會拿到過期的值。這裡由捲動事件即時更新，讀到的就是對的。
     *
     * 初始值是 `true`：剛開啟面板時會自動捲到底，等於正在看最新 —— 這樣才不會
     * 一開啟就把既有訊息全部當成「未讀」。
     *
     * @type {{ current: boolean }}
     */
    var streamFollowingRef = { current: true };

    /**
     * 「請訊息串跳到最尾端」的請求（模組層）。
     *
     * 由 `MainPanel`（勾選「永遠滾到最新」的那一瞬間）寫入，`MessageList` 讀取並清掉。
     * 為什麼要這樣傳：捲動容器在 `MessageList` 身上，而開關在 `MainPanel`；
     * 「剛勾選就立刻捲到底」需要跨元件呼叫。
     *
     * @type {{ current: ?function }}
     */
    var streamJumpToEndRef = { current: null };

    /**
     * 一顆跳轉用的箭頭／符號圖示。
     *
     * @param props - { dir }：`'up'` 上箭頭、`'down'` 下箭頭、`'end'` 底部橫線。
     * @returns SVG 元素。
     */
    function JumpGlyph(props) {
      var d = (props && props.dir) || 'down';
      var shape = d === 'up'
        ? e('path', { d: 'M8 12.6V4.2M4.3 7.9 8 4.2l3.7 3.7' })
        : d === 'down'
          ? e('path', { d: 'M8 3.4v8.4M4.3 8.1 8 11.8l3.7-3.7' })
          // START：箭頭頂到上方橫線，「跳到第一則」比單純箭頭清楚（跟 END 對稱）
          : d === 'start'
            ? e('g', null,
              e('path', { d: 'M8 13v-7.4M4.4 9.1 8 5.5l3.6 3.6' }),
              e('path', { d: 'M3.6 3.1h8.8' })
            )
            // END：箭頭壓到底部橫線上
            : e('g', null,
              e('path', { d: 'M8 3v7.4M4.4 6.9 8 10.5l3.6-3.6' }),
              e('path', { d: 'M3.6 12.9h8.8' })
            );
      return e('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false'
      }, shape);
    }

    /**
     * 訊息串右側的日期跳轉列：第一則／上一天／下一天／最後一則。
     *
     * 需求：「message list 右側中間，利用已經空出的空間，加個向上／向下／END 的 icon，
     * 點一下就跳轉到上一天和下一天的第一條以及最後一條」，
     * 之後追加：「最前面加一個 START，跳轉到第一條」。
     *
     * 位置：`position:sticky` + `margin:auto 0` 讓它停在可視範圍的垂直中央，
     * 並落在 stream 右側那 44px 內距的空隙裡（見 `.ntfy-teams-daynav`）。
     *
     * @param props - { hasDays, hasPrev, atStart, onPrev, onNext, onStart, onEnd }。
     * @returns 跳轉列元素。
     */
    function DayNav(props) {
      /** 做一顆按鈕。 @param dir - 圖示方向。 @param label - tooltip／aria。 @param fn - 動作。 @param off - 是否不可按。 @returns 按鈕元素。 */
      function btn(dir, label, fn, off) {
        return e('button', {
          type: 'button',
          className: 'ntfy-teams-daynavbtn',
          title: label,
          'aria-label': label,
          disabled: !!off,
          onClick: function () { if (!off && typeof fn === 'function') fn(); }
        }, e(JumpGlyph, { dir: dir }));
      }
      return e('div', { className: 'ntfy-teams-daynav' },
        e('div', { className: 'ntfy-teams-daynavcol' },
          // START 排在最前面（需求）。已經在最上面時變淡不可按。
          btn('start', '跳到第一則訊息', props && props.onStart, props && props.atStart),
          btn('up', '跳到上一天的第一則訊息', props && props.onPrev, !(props && props.hasPrev)),
          btn('down', '跳到下一天的第一則訊息', props && props.onNext, !(props && props.hasNext)),
          btn('end', '跳到最後一則訊息', props && props.onEnd, false)
        )
      );
    }

    /**
     * 「N 則新訊息」提示條（浮在訊息串底部）。
     *
     * 需求：焦點中的主題收到**別人**的訊息、而使用者沒貼在底部時要提示未讀。
     * 點一下跳到第一則未讀（並把這些訊息標成已讀）。
     *
     * @param props - { count, onClick }。
     * @returns 提示條元素。
     */
    function UnreadPill(props) {
      var count = props && typeof props.count === 'number' ? props.count : 0;
      if (count <= 0) return null;
      return e('div', { className: 'ntfy-teams-unreadpill' },
        e('button', {
          type: 'button',
          className: 'ntfy-teams-unreadpillbtn',
          title: '跳到第一則未讀訊息',
          'aria-label': '跳到 ' + count + ' 則未讀訊息',
          onClick: function () { if (typeof props.onClick === 'function') props.onClick(); }
        },
          e('span', { className: 'ntfy-teams-unreadpillarrow', 'aria-hidden': 'true' }, '↓'),
          e('span', null, badgeText(count) + ' 則新訊息')
        )
      );
    }

    /**
     * 訊息串：切換主題時捲到「上次讀到的地方」，新訊息才貼到底。
     *
     * 未讀的邊界放在**這一輪新進來的第一則**前面（不是第一則陌生的訊息），
     * 這樣「N 則新訊息」的數字才跟側欄角標一致。
     *
     * @param props - { topic, messages, loading, selfName, unread, lastReadId, onSeen }。
     * @returns 訊息串元素。
     */
    function MessageList(props) {
      var boxRef = React.useRef(null);
      var stickRef = React.useRef(true);
      var scrollTopicRef = React.useRef('');
      var scrolledRef = React.useRef(false);
      var seenReportedRef = React.useRef(false);
      var messages = props.messages || [];
      var count = messages.length;

      // 哪些日期被收起來了（key = 日期 key）。
      //
      // 預設**只有今天展開**，其他日子一律折起來 —— 打開一個群組不該先被幾百則
      // 舊訊息淹沒；要回顧哪一天再自己點開。初始值用 lazy initializer 算一次，
      // 之後就完全由使用者的點擊決定（不會因為來了新訊息又把折起來的展開）。
      var collapseState = React.useState(function () {
        var initial = {};
        var groups0 = typeof groupByDay === 'function' ? groupByDay(messages) : [];
        for (var gi = 0; gi < groups0.length; gi += 1) {
          if (groups0[gi].key === NO_DAY_KEY) continue; // 沒有時間的那組保持展開
          if (!isTodayKey(groups0[gi].key)) initial[groups0[gi].key] = true;
        }
        return initial;
      });
      var collapsed = collapseState[0];
      var setCollapsed = collapseState[1];
      // 给 effect 用的最新值：effect 只看得到建立当时的那一份闭包。
      var collapsedRef = React.useRef(collapsed);
      collapsedRef.current = collapsed;

      // ---- 未讀邊界 ----
      //
      // 這一輪（打開這個主題之後）讀到哪裡了。它跟 store 的「上次讀到哪」合起來用：
      // 取兩者中**比較新**的那個當邊界，所以：
      //   * 一打開就有未讀線（store 的值還沒被推進）；
      //   * 往下讀的過程中線會跟著往前移（新訊息進來也會落在線後面，位置才對）；
      //   * 讀到最新那一則時 `seenId` 就等於最新，線自然消失。
      //
      // 上一版把「畫面上的標記」留到切換主題才清，結果讀完了那條線還杵在那裡 ——
      // 那是記號，不是狀態。這裡改成狀態。
      var seenState = React.useState('');
      var seenId = seenState[0];
      var setSeenId = seenState[1];
      var seenRef = React.useRef('');
      seenRef.current = seenId;

      // 「現在能不能往上捲」——用來決定 START 按鈕可不可按。
      // 這是**狀態**不是 ref：按鈕的 disabled 要跟著它重繪。
      var canUpState = React.useState(false);
      var canScrollUp = canUpState[0];
      var setCanScrollUp = canUpState[1];

      // 這一輪的邊界 = max(store 的上次讀到, 本輪已讀)；找不到就退回 store 的值。
      var storeLastReadId = text(props.lastReadId);
      var boundaryId = storeLastReadId;
      var boundaryIndex = -1;
      if (boundaryId !== '') {
        for (var li0 = 0; li0 < count; li0 += 1) {
          if (text(messages[li0].id) === boundaryId) boundaryIndex = li0;
        }
      }
      if (seenId !== '') {
        for (var li1 = 0; li1 < count; li1 += 1) {
          if (text(messages[li1].id) === seenId && li1 > boundaryIndex) {
            boundaryIndex = li1;
            boundaryId = seenId;
          }
        }
      }
      var unreadCount = typeof props.unread === 'number' && props.unread > 0 ? props.unread : 0;
      // 提示條用的即時未讀數（見 listProps.unreadLive 的說明：跟畫線用的那個分開）。
      var unreadLive = typeof props.unreadLive === 'number' && props.unreadLive > 0 ? props.unreadLive : 0;
      // 有未讀、而且邊界還在這串裡、而且後面真的還有東西 —— 三者都成立才畫線。
      // 最後那個條件就是「讀到最新就消失」。
      var hasUnreadMark = unreadCount > 0 && boundaryIndex >= 0 && boundaryIndex < count - 1;
      var firstUnreadIndex = hasUnreadMark ? boundaryIndex + 1 : -1;

      // ---- 群組語意：從整串訊息推導出決定與待辦 ----
      //
      // 推導而不是另存狀態：ntfy 沒有「改舊訊息」的能力，所以決定／待辦只能是新的
      // 訊息；這裡把它們疊回原始訊息上，任何成員算出來的結果都一樣（無需資料庫）。
      var markers = (core && typeof core.deriveMarkers === 'function')
        ? core.deriveMarkers(messages)
        : { decisions: [], actions: [], openCount: 0 };
      var markedBy = {};
      for (var di = 0; di < markers.decisions.length; di += 1) {
        markedBy[String(markers.decisions[di].id)] = { state: 'decision', text: markers.decisions[di].text };
      }
      for (var ai = 0; ai < markers.actions.length; ai += 1) {
        var act = markers.actions[ai];
        var key0 = String(act.id);
        // 同一則可以有多筆待辦；只要有一筆還沒結案就顯示成待辦。
        if (!markedBy[key0] || markedBy[key0].state !== 'decision') {
          markedBy[key0] = { state: act.done ? 'done' : 'action', text: act.text, markerId: act.markerId };
        }
      }

      // 新訊息進來時：**只跟隨「最新的那一則是自己發的」**。
      //
      // 需求：「當前 topic 處於焦點時…如果是我發的就自動滾屏到那條之後，
      //       如果是其他人發的就提示未讀」。
      //
      // 所以這裡的條件比舊版嚴格，三個都要成立：
      //   1. `props.stayAtBottom` 為真 **或** `stickRef.current` ——
      //      「永遠滾到最新」打開時就無條件跟隨；否則要求使用者還貼著底部
      //      （往上翻歷史時不打擾他）；
      //   2. 這一輪真的是「有新訊息」（不是切換主題或摺疊造成的重繪）；
      //   3. 最新那一則是**自己發的**（`senderOf(..., selfName).isSelf`），
      //      或者「永遠滾到最新」打開了（那就不管誰發的都要捲）。
      //
      // 別人的訊息不捲（在開關關閉時）—— 由 store 累加未讀、由 `UnreadPill`
      // 浮出提示條，讓使用者自己決定什麼時候跳過去。
      //
      // 為什麼還要 `syncSeenToViewport()`：自己發的那條捲到底之後，
      // 「讀到哪」要跟著推進到最新，否則未讀線會停在上一輪的位置又冒出來
      // （實測：讀到底後再來一則，divider 由 0 變 1）。
      React.useEffect(function () {
        var box = boxRef.current;
        if (!box) return;
        // ⚠️ 開了「永遠滾到最新」時**不看** stickRef：那個旗標在使用者自己往上捲
        // 之後會變 false，但這個開關的語意就是「不管怎樣都回到最新」。
        if (!props.stayAtBottom && !stickRef.current) return;
        var lastMsg = count > 0 ? messages[count - 1] : null;
        if (!lastMsg) return;
        // 只認「剛剛新增的那一則」：id 沒變就代表只是重繪，不要動捲動位置。
        var lastId = text(lastMsg.id);
        if (lastId === lastAutoScrollIdRef.current) return;
        lastAutoScrollIdRef.current = lastId;
        // 開關打開時，別人的訊息也要捲（那正是這個開關的用途）。
        if (!props.stayAtBottom && !senderOf(lastMsg, props.selfName).isSelf) return;
        box.scrollTop = box.scrollHeight;
        stickRef.current = true;
        streamFollowingRef.current = true;
        syncSeenToViewport();
      }, [count, props.topic, props.stayAtBottom]);

      // 勾選「永遠滾到最新」的那一瞬間要立刻捲到底 ——
      // 否則使用者會覺得「勾了但畫面沒動」。MainPanel 透過模組層的 ref 請求。
      React.useEffect(function () {
        streamJumpToEndRef.current = function () {
          var box = boxRef.current;
          if (!box) return;
          dropStick();
          box.scrollTop = box.scrollHeight;
          stickRef.current = true;
          streamFollowingRef.current = true;
          syncSeenToViewport();
        };
        return function () {
          if (streamJumpToEndRef.current) streamJumpToEndRef.current = null;
        };
      }, []);

      // ---- 切換主題：捲到「上次讀到的那一則」----
      //
      // 這個元件的 key 是「每個主題一個」——切換主題時它是**重掛**的，所以一出生
      // ref 就會等於新主題。用「ref 和目前主題不同」當條件會永遠不成立（實測整個
      // 捲動都沒發生）。改成「ref 還是空的」就代表這是這一輪第一次有機會捲。
      //
      // ⚠️ 依賴裡**不能**放 hasUnreadMark：線因為「讀到最新」而消失時，
      // hasUnreadMark 會 true→false；之後新訊息進來又 false→true，這個 effect
      // 就會再跑一次，把本輪讀到哪重置掉 —— 上次讀完的進度被清空，未讀線於是
      // 又冒出來（實測：讀到底後再來一則，divider 由 0 變 1）。只認主題。
      React.useEffect(function () {
        if (scrollTopicRef.current === props.topic) return;
        scrollTopicRef.current = props.topic;
        scrolledRef.current = true;
        // 新的一輪：本輪讀到哪從頭開始，否則上一輪的進度會蓋掉 store 的邊界。
        setSeenId('');
        seenReportedRef.current = false;
        var box = boxRef.current;
        if (!box) return;
        stickRef.current = !hasUnreadMark;
        var line = hasUnreadMark ? box.querySelector('.ntfy-teams-newline') : null;
        if (line) {
          // 捲到「已讀的最新一則」＝未讀線**上面**那一則訊息。
          //
          // 未讀線畫在「第一則未讀」前面，所以它上面那一則就是上次讀到的地方。
          // 把**線對齊到視窗底部**，上面那一則就會完整落在視窗裡 ——
          // 使用者一打開就看到「我讀到哪」＋「下面還有幾則新的」。
          //
          // 為什麼不用 `line.scrollIntoView({block:'start'})`：那會把線釘在最上面，
          // 於是「已讀的最新一則」被推到視窗上緣之外，看不到（實測就是這樣）。
          // 也不用 block:'end'：那要線剛好是最後一個 child 才成立。
          var anchorMsg = line.previousElementSibling;
          if (anchorMsg && typeof anchorMsg.getBoundingClientRect === 'function') {
            var boxRect = box.getBoundingClientRect();
            var msgRect = anchorMsg.getBoundingClientRect();
            // 把那一則的底端對到視窗底端（留 8px 讓它不貼死）。
            box.scrollTop += (msgRect.bottom - boxRect.bottom) + 8;
          } else {
            // 找不到前一則（理論上不會）：退回把線對齊底部。
            box.scrollTop += (line.getBoundingClientRect().bottom - box.getBoundingClientRect().bottom);
          }
        } else {
          box.scrollTop = box.scrollHeight;
        }
        // 排到下一個 frame 再判斷「線是不是真的在視野裡」，那時畫面已經畫過了。
        var raf = (typeof requestAnimationFrame === 'function')
          ? requestAnimationFrame
          : function (fn) { return setTimeout(fn, 16); };
        raf(function () {
          // 捲到未讀線之後**不**主動標記已讀：剛打開的那一刻要讓使用者看見那條線，
          // 「讀到哪」只在使用者真的動了捲軸時才前進（onScroll → syncSeenToViewport）。
          // 少了這條界線，短清單會在開啟的同一瞬間被判成全部可見，線就不見了
          // （實測：4 則全部落在視窗內 → 開了就看到 dv=0）。
          if (markIsVisible() && !seenReportedRef.current) {
            seenReportedRef.current = true;
            if (typeof props.onSeen === 'function') props.onSeen(props.topic);
          }
        });
        // 讀到的邊界靠 hasUnreadMark 的**當下值**決定，所以它不在依賴裡也安全：
        // 重掛／換主題時這一個閉包就是最新的那一份。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [props.topic]);

      // 新訊息進來時，如果它所在的那一天正好被折起來，就自動展開 ——
      // 否則會出現「有未讀但看不到」的狀況（面板自己的未讀是另一個機制，這裡是視覺上）。
      var lastMsg = count > 0 ? messages[count - 1] : null;
      var lastDayKey = lastMsg ? dayKeyOf(lastMsg) : '';
      React.useEffect(function () {
        if (!lastDayKey) return;
        if (!collapsedRef.current[lastDayKey]) return;
        setCollapsed(function (prev) {
          if (!prev[lastDayKey]) return prev;
          var next = {};
          for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
          delete next[lastDayKey];
          return next;
        });
      }, [lastDayKey, count, props.topic]);

      // ---- 沒有未讀時，把「讀到哪」推進到最新 ----
      //
      // 為什麼需要這個：剛切到某主題時它還沒載入任何訊息，那時無法前進；
      // 等歷史載入後才前進得了。少了它，第一次打開的主題永遠沒有 lastReadId，
      // 之後的未讀線就畫不出來（因為找不到「上次讀到哪」）。
      //
      // 但**不能**只看「清單從空變成有」：那會把「切過去時才載入的既有訊息」
      // 當成新訊息，於是在畫出未讀線之前就把它們標成已讀（實測就是這樣讓
      // 未讀線整個消失）。所以這裡改成認「真的有新訊息接在後面」：
      // 只有當這一輪的最後一則，跟上一輪記錄的最後一則**不同**時才前進。
      // 每個主題各自記「上一輪看到的最後一則」——元件會因為 key 改變而重掛，
      // 但這顆 ref 是新的，所以要按主題分開記，不能只存一個全域值。
      var lastSeenRef = React.useRef({});
      var lastSeenAtRef = React.useRef('');
      React.useEffect(function () {
        if (count === 0) return;
        var newest = text(messages[count - 1].id);
        var key = props.topic + '\u0001' + newest;
        if (lastSeenAtRef.current === key) return;
        var prevId = lastSeenRef.current[props.topic] || '';
        lastSeenAtRef.current = key;
        lastSeenRef.current[props.topic] = newest;
        // 有未讀線時等使用者捲過去（onSeen）。
        if (hasUnreadMark) return;
        // 沒有未讀線代表「打開時沒有東西是新的」，也就是這一輪看到的就是全部
        // —— 那就該把讀到哪立在這裡。
        //
        // 這裡以前是 `if (prevId === '') return;`（第一次看到內容就宣稱已讀），
        // 本意是避免把「切過去才載入的既有訊息」當成新訊息；但那個情況
        // hasUnreadMark 已經擋掉了，於是那條 guard 只剩副作用：
        // **第一次打開的主題永遠沒有 lastReadId**，之後的未讀線因此永遠畫不出來
        // （實測：進出兩輪之後 store 的 lastRead 仍是空字串、divider 永遠 0）。
        if (typeof props.onSeen === 'function') props.onSeen(props.topic);
        void prevId;
      }, [props.topic, count, hasUnreadMark]);

      /**
       * 把「本輪讀到哪」推進到某一則（只往前，不往後）。
       * @param id - 訊息 id。
       */
      function advanceSeen(id) {
        var next = text(id);
        if (next === '') return;
        if (next === seenRef.current) return;
        setSeenId(next);
      }

      /**
       * 把「本輪讀到哪」推進到**目前真的看得到的範圍**。
       *
       * 這裡不用「有沒有貼到底」當判斷 —— 那在長清單上會誤判：打開主題時若
       * 自動捲到底（沒有未讀線的情形），底部那一瞬間等於「已讀」，但使用者其實
       * 還沒往上讀到新訊息，未讀線就永遠看不到（實測：33 則、開啟後 dv=0）。
       *
       * 改成看視窗：最後一則**有露出來**的訊息就算看到了。所以
       *   * 未讀線在視窗內 → 它前面那些都已讀，線會往下移；
       *   * 一路捲到最底 → 最後一則露出來，線自然消失；
       *   * 人停在上面、新訊息在底下 → 線留著，位置也正確。
       */
      function syncSeenToViewport() {
        var box = boxRef.current;
        if (!box || count === 0) return;
        var slots = box.querySelectorAll('.ntfy-teams-msgslot');
        if (!slots.length) return;
        var boxRect = box.getBoundingClientRect();
        var lastVisible = null;
        for (var i = 0; i < slots.length; i += 1) {
          var r = slots[i].getBoundingClientRect();
          // 「有露出來」：頂端在視窗下緣之上、且底端在視窗上緣之下
          if (r.top < boxRect.bottom && r.bottom > boxRect.top) lastVisible = slots[i];
        }
        if (!lastVisible) return;
        var mid = lastVisible.getAttribute('data-mid');
        if (!mid) return;
        advanceSeen(mid);
        if (hasUnreadMark && !seenReportedRef.current) {
          seenReportedRef.current = true;
          if (typeof props.onSeen === 'function') props.onSeen(props.topic);
        }
      }

      /** 未讀線是否真的在可視範圍內。 @returns 是否看得到。 */
      function markIsVisible() {
        var box = boxRef.current;
        if (!box) return false;
        var mark = box.querySelector('.ntfy-teams-newline');
        if (!mark) return false;
        var br = box.getBoundingClientRect();
        var mr = mark.getBoundingClientRect();
        return mr.top >= br.top - 2 && mr.top <= br.bottom;
      }

      // 跳轉期間為 true：擋掉「使用者捲動」的誤判，並讓捲動行為暫時變瞬時。
      var jumpingRef = React.useRef(false);

      // 上一次「自動跟隨」過的訊息 id。用來分辨「真的來了新訊息」與「只是重繪」——
      // 少了它，任何重繪都會把畫面拉到底，使用者的捲動位置會被一直搶走。
      var lastAutoScrollIdRef = React.useRef('');

      // 「現在貼不貼著底部」——用來決定要不要顯示「N 則新訊息」提示條。
      // 這是**狀態**不是 ref：提示條的顯示要跟著它重繪。
      // 初始 true（剛開啟面板時捲到底，等於正在看最新）。
      var nearBottomState = React.useState(true);
      var nearBottom = nearBottomState[0];
      var setNearBottom = nearBottomState[1];

      /** 捲到未讀邊界（「N 則新訊息」提示條點下去用）。 */
      function jumpToUnread() {
        var box = boxRef.current;
        if (!box) return;
        var line = box.querySelector('.ntfy-teams-newline');
        if (!line) {
          // 沒有未讀線（例如這一輪的邊界已經被清掉）→ 退回捲到底。
          jumpTo('');
          markSeenNow();
          return;
        }
        dropStick();
        scrollToSettled(box, function (b) {
          var l = b.querySelector('.ntfy-teams-newline');
          return l ? scrollTopFor(b, l, 12) : b.scrollHeight;
        });
        // 捲過去之後**主動**把未讀清掉。
        //
        // 為什麼不能只靠「貼底就清」的那個 effect（MainPanel 的 readRef）：
        // 它只在**訊息數變化**時才跑（依賴 `[active, activeCount]`），
        // 而點提示條只是捲動、訊息數沒變 —— 於是它永遠不會再跑一次，
        // 未讀就留在那裡（實測：捲到未讀處之後 store 的未讀仍是 3、提示條還掛著）。
        markSeenNow();
      }

      /**
       * 立刻把「這個主題讀到最新」。
       *
       * 通知 store（清未讀 + 推進「讀到哪」），並把本輪的 `seenId` 推上去，
       * 讓未讀線一起消失。
       */
      function markSeenNow() {
        if (count > 0) advanceSeen(text(messages[count - 1].id));
        if (typeof props.onSeen === 'function') props.onSeen(props.topic);
      }

      /**
       * 把某個位置換算成 `scrollTop`（**相對內容頂端**，不含捲動容器的內距）。
       *
       * ⚠️ 這裡是先前一直差幾 px 的根源：
       * stream 有 `padding:16px 44px 20px 26px`，而**內容頂端在內距之內** ——
       * 也就是「scrollTop = 0」時，第一個元素的 `rect.top - box.top` 是 **16**
       * 而不是 0。所以直接寫 `scrollTop + (er.top - br.top) - 6` 時，
       * 實際得到的留白是「16 - 6 = 10」而不是 6，位置永遠差一格。
       * （需求「跳轉後抬頭要貼頂、分割線看得到」看起來是對的，但一要求
       *  「START 要精確回到 0」就露出來了 —— 同一個公式不可能同時滿足兩者。）
       *
       * 修法：先把元素的視窗座標換算成「相對內容頂端」，再減掉想要的留白。
       *
       * @param b - 捲動容器。
       * @param el - 目標元素。
       * @param gap - 目標元素頂端與內容頂端的距離（px，可為負）。
       * @returns 對應的 scrollTop。
       */
      function scrollTopFor(b, el, gap) {
        var br = b.getBoundingClientRect();
        var er = el.getBoundingClientRect();
        var padTop = b.clientTop || 0;   // border 寬；padding 要用 computed style
        try { padTop = parseFloat(getComputedStyle(b).paddingTop) || 0; } catch (err) { padTop = b.clientTop || 0; }
        // 元素目前「相對內容頂端」的位置 = 目前 scrollTop + (它相對 border 盒的偏移 - 內距)
        var contentOffset = b.scrollTop + (er.top - br.top) - padTop;
        return contentOffset - gap;
      }

      /** 記錄使用者是否還貼著底部，並把讀到的範圍往外推。 */
      function onScroll() {
        var box = boxRef.current;
        if (!box) return;
        // 跳轉自己造成的 scroll 事件不算「使用者捲動」：不能把 smooth 還原，
        // 更不能再觸發一次捲動（那會跟跳轉互相打架）。
        if (!jumpingRef.current) {
          if (box.style.scrollBehavior === 'auto') box.style.scrollBehavior = '';
          stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
          // 兩個都要更新：模組層的 `streamFollowingRef` 給「未讀歸零」的 effect 用
          // （同步、不查 DOM），store 的 hook 則給「下一則訊息算未讀還是已讀」用。
          streamFollowingRef.current = stickRef.current;
          if (stickRef.current !== nearBottom) setNearBottom(stickRef.current);
          var up = box.scrollTop > 4;
          if (up !== canScrollUp) setCanScrollUp(up);
        }
        syncSeenToViewport();
      }

      /** 收合／展開一天。 @param key - 日期 key。 */
      function toggleDay(key) {
        setCollapsed(function (prev) {
          var next = {};
          for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      }

      var body;
      if (count === 0) {
        body = e('div', { className: 'ntfy-teams-empty' },
          e(GroupGlyph, { size: 26 }),
          e('div', { className: 'ntfy-teams-emptytitle' },
            props.loading ? '正在載入歷史訊息…' : '這個話題還沒有訊息'),
          e('div', null, props.loading
            ? ''
            : '在下方輸入訊息，團隊成員就會即時收到')
        );
      } else {
        // 依日期分組；每組的抬頭可以按一下折起來。
        // （原本只是插一條分隔線，日期一多就沒辦法把某一天收掉。）
        var groups = groupByDay(messages);
        var rows = [];
        // 隔行底色的序號：跨「天」連續累計，這樣每一段接起來還是交錯的，
        // 不會因為換一天就重新起算而出現兩行同色相鄰。
        var rowIndex = 0;
        // 訊息 → 在整串裡的序號。上面找 lastReadIndex 時已經掃過一次，
        // 這裡用它來判斷「哪一則才是新的第一則」，避免在迴圈裡再掃一遍。
        var indexOfMsgId = {};
        for (var mi = 0; mi < count; mi += 1) {
          var mid = text(messages[mi].id);
          if (mid !== '') indexOfMsgId[mid] = mi;
        }
        for (var g = 0; g < groups.length; g += 1) {
          var group = groups[g];
          var key = group.key;
          // 未讀線落在這一天就一定要展開 —— 不然「新訊息從這裡開始」那條線
          // 會被折在裡面，使用者只看到一個摺起來的日期，完全找不到新東西。
          // 這比「預設折疊」優先：折疊是為了少干擾，不是為了藏住未讀。
          var holdsUnread = firstUnreadIndex >= 0
            && group.items.some(function (m) { return indexOfMsgId[text(m.id)] === firstUnreadIndex; });
          var isCollapsed = !!collapsed[key] && !holdsUnread;
          var isToday = isTodayKey(key);
          var dayCls = 'ntfy-teams-day'
            + (isToday ? ' ntfy-teams-day--today' : '')
            + (isCollapsed ? ' ntfy-teams-day--collapsed' : '');
          // 抬頭是「收合／展開」，右邊另外一顆問號是「用這一天開新 session 復盤」。
          // 兩個動作分開，避免按收合時誤觸復盤。
          // `data-daykey` 是給日期跳轉列用的：跳到某一天時要能把那一天**展開**
          // （只靠 DOM 位置認不出是哪一天；key 是摺疊狀態的唯一識別）。
          rows.push(e('div', { key: 'day_' + key, className: 'ntfy-teams-daywrap', 'data-daykey': key },
            e('button', {
              type: 'button',
              className: dayCls,
              title: isCollapsed ? '展開這一天' : '收合這一天',
              'aria-expanded': isCollapsed ? 'false' : 'true',
              onClick: function (k) { return function () { toggleDay(k); }; }(key)
            },
              e('span', { className: 'ntfy-teams-daycaret', 'aria-hidden': 'true' }, isCollapsed ? '›' : '⌄'),
              e('span', { className: 'ntfy-teams-daylabel' }, group.label),
              e('span', { className: 'ntfy-teams-daycount' }, group.items.length + ' 則')
            ),
            typeof props.onDayReview === 'function'
              ? e('button', {
                type: 'button',
                className: 'ntfy-teams-dayquestion',
                title: '用「' + group.label + '」這一天開新 session 做日復盤',
                'aria-label': '用「' + group.label + '」這一天開新 session 做日復盤',
                onClick: function (k, items, label) {
                  return function (ev) {
                    ev.stopPropagation();
                    props.onDayReview({ dayKey: k, label: label, messages: items });
                  };
                }(key, group.items, group.label)
              }, e(QuestionGlyph))
              : null
          ));
          if (isCollapsed) continue;
          for (var j = 0; j < group.items.length; j += 1) {
            var msg = group.items[j];
            var msgPos = indexOfMsgId[text(msg.id)];
            // 未讀線：畫在這一輪新進來的第一則前面，並讓它成為捲動的錨點。
            if (firstUnreadIndex >= 0 && msgPos === firstUnreadIndex) {
              rows.push(e('div', {
                key: 'newline_' + (msg.id || msgPos),
                className: 'ntfy-teams-newline',
                role: 'separator',
                'aria-label': '未讀訊息 ' + unreadCount + ' 則'
              },
                e('span', { className: 'ntfy-teams-newlinetext' }, badgeText(unreadCount) + ' 則新訊息')
              ));
            }
            rows.push(e('div', {
              key: msg.id || (msg.topic + ':' + messageTime(msg) + ':' + g + ':' + j),
              className: 'ntfy-teams-msgslot',
              'data-mid': text(msg.id)
            },
              e(MessageRow, {
                msg: msg,
                selfName: props.selfName,
                alt: rowIndex % 2 === 1,
                markedBy: markedBy,
                onMark: props.onMark,
                isNew: g === groups.length - 1 && j === group.items.length - 1
              })
            ));
            rowIndex += 1;
          }
        }
        body = rows;
      }

      // ---- 日期跳轉：上一天／下一天／最後一則 ----
      //
      // 日期分段在 DOM 裡是 `.ntfy-teams-daywrap`（一天一個），所以「目前在哪一天」
      // 直接用量到的位置判斷，不用另外維護一份 state（那份 state 會跟捲動不同步）。
      //
      // 捲動定位用 `box.scrollTop` 而不是 `scrollIntoView`：
      //   * `scrollIntoView` 會把**所有**可捲動祖先一起捲（包含外層頁面），
      //     實測會讓整個 GUI 跟著跳；
      //   * `scrollTop` 只動這個 stream，行為可預期。
      // 平滑捲動由 CSS 的 `scroll-behavior:smooth` 負責（本來就有）。
      //
      // 為什麼用 `offsetTop` 而不是 `getBoundingClientRect`：`.ntfy-teams-daywrap` 的
      // offsetParent 就是這個 stream（stream 不是 static），所以 offsetTop 是
      // 「距離內容頂端」的穩定座標，不受目前捲到哪裡影響。

      /**
       * 目前停在「哪一天」（語意判斷，不是算索引）。
       *
       * 為什麼要用語意而不是把捲動位置換算成索引：
       * 捲動位置會被**內容高度變化**影響（展開／收合一天、新訊息進來），
       * 事先算好的索引會跟現場對不上 —— 實測踩過：`afterNext.scrollTop = 964`
       * 而 `maxScroll = 225`，完全錯位。
       *
       * 改用「哪一天的抬頭中心最接近視窗頂端」來回答「我在哪一天」，
       * 這個答案只依賴**當下實際的 DOM 位置**，不怕內容變高變矮。
       *
       * @param box - 捲動容器。
       * @param wraps - 日期分段元素。
       * @returns 目前那一天的索引（找不到回 0）。
       */
      function currentDayIndex(box, wraps) {
        var br = box.getBoundingClientRect();
        var best = 0;
        var bestDist = Infinity;
        for (var i = 0; i < wraps.length; i += 1) {
          var h = wraps[i].querySelector ? wraps[i].querySelector('.ntfy-teams-day') : null;
          if (!h) continue;
          var hr = h.getBoundingClientRect();
          // 距離視窗頂端（也就是捲動起點）多遠；取最近的那一天
          var dist = Math.abs(hr.top - br.top);
          if (dist < bestDist) { bestDist = dist; best = i; }
        }
        return best;
      }

      /**
       * 使用者主動跳轉時，先關掉「貼著底部自動跟到底」。
       *
       * ⚠️ 這一步是必要的，不是保險：**展開一天會讓 DOM 裡的訊息變多**，
       * 於是上面那個 `[count, props.topic]` 的 effect 會被觸發；
       * 只要 `stickRef.current` 還是 true，它就會把 `scrollTop` 設成
       * `scrollHeight`，**直接蓋掉剛捲好的位置**。
       *
       * 實測（2 天各 14 則、昨天預設收合）：
       * ```
       * 按「上一天」→ 先展開 → 捲到 932（正確）
       *            → 訊息數變多觸發 effect → 被覆寫成 121
       * 結果：內容已經長到 1742，停在 121 —— 畫面上什麼都看不到。
       * ```
       * 「跳過去」是明確的使用者意圖，所以不再是「跟著底部」的狀態。
       */
      function dropStick() {
        stickRef.current = false;
      }

      /**
       * 把捲動容器送到某個元素的位置（**瞬時**，而且會等到版面穩定才停）。
       *
       * ⚠️ 為什麼不能只寫一次 `box.scrollTop = wrap.offsetTop - 6`：
       *
       * 有兩個獨立的坑疊在一起：
       *
       * 1. **`scrollTop` 會被當下的 `scrollHeight` 夾住。** 設一個超過上限的值
       *    會被截斷，而且內容之後長高也不會自動補上。
       *
       * 2. **展開一天會改變所有「之後」元素的 `offsetTop`。** 這是真正咬人的那個：
       *    實測（2 天各 14 則、昨天預設收合）——
       *
       *    ```
       *    按「下一天」：scrollTop 153、maxScroll 225、day0.offsetTop = 127
       *    按「上一天」：展開昨天 → 內容從 911 長到 1742
       *                 day0.offsetTop 127 → 127（自己在最前面，不變）
       *                 day1.offsetTop 159 → 970（被推下去了！）
       *    結果：捲到 121，而目標位置的內容已經跑到 964 —— 差 843px，畫面完全不對。
       *    ```
       *
       *    也就是說：**即使在點擊當下讀一次 `offsetTop`，那個值也可能在展開的
       *    那次重繪之後失效。** 所以這裡改成在 rAF 迴圈裡**每輪重新量**、
       *    一路修正到「目標位置不再變動」才停手（最多 20 輪保險）。
       *
       * 這比 `scrollIntoView` 好：後者會把**所有**可捲動祖先一起捲
       * （包含外層頁面），實測整個 GUI 都會跟著跳。
       *
       * 另外這裡**暫時關掉** `scroll-behavior:smooth`，而且**不還原** ——
       * 還原成 `smooth` 的那一瞬間瀏覽器會從「目前值」開始做動畫，
       * 把剛捲好的位置又帶走（實測：目標 153 最後停在 42）。
       * 改由 `onScroll` 在使用者真的自己捲動時才還原成平滑（見那裡）。
       *
       * @param box - 捲動容器。
       * @param read - 每輪重新計算目標位置的函式；回傳 null 表示改用「最尾端」。
       * @param fixed - 直接指定的位置（給「捲到最上面」用）。
       */
      function scrollToSettled(box, read, fixed) {
        box.style.scrollBehavior = 'auto';
        jumpingRef.current = true;
        var last = null;
        var tries = 0;
        /** 一輪：量目標 → 捲 → 若還在變就下一輪。 */
        function step() {
          var b = boxRef.current;
          if (!b) { jumpingRef.current = false; return; }
          tries += 1;
          var target = (fixed === undefined) ? read(b) : fixed;
          if (target === null || target === undefined) target = 0;
          target = Math.max(0, target);
          b.scrollTop = target;
          // 捲完再看一次：目標位置若又變了（展開造成的），就再修一輪。
          var now = (fixed === undefined) ? read(b) : fixed;
          now = Math.max(0, now === null || now === undefined ? 0 : now);
          var settled = (last !== null && Math.abs(now - last) < 1 && Math.abs(b.scrollTop - now) < 1);
          last = now;
          if (settled || tries >= 20) {
            jumpingRef.current = false;
            return;
          }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(step);
          else setTimeout(step, 16);
        }
        step();
      }

      /**
       * 跳轉（捲到某一天的頂端），並**確保那一天是展開的**。
       *
       * 留白刻意只留 6px（也就是抬頭自己的 `margin-top`）：
       * 使用者的要求是「上一天至少要看得到那天的分割線」。
       * 實測座標：第一天 wrap.offsetTop = 127、抬頭在 wrap 內再 +6，
       * 所以留 6px 時抬頭剛好貼在視窗頂端，那條**分割線在視窗內看得到**。
       *
       * ⚠️ 這裡**刻意只傳 `dayKey`，不傳元素參照**：
       * 展開一天會讓 React 重繪整串訊息，**我們先前抓到的 `wrap` 參照會被換掉**
       * —— 之後再讀它的 `offsetTop` 拿到的是「已經脫離文件的那顆舊節點」，
       * 值永遠是展開前的舊位置。實測就是這個造成「上一天」永遠差一大截：
       * ```
       * 按住的那顆舊節點 offsetTop 一直是 127 → 目標算成 121
       * 真正在文件裡的新節點 offsetTop 是 970 → 應該捲到 964
       * ```
       * 所以每一輪都用 `data-daykey` **重新查詢**當下的節點。
       *
       * @param dayKey - 目標那天的 key；空 = 捲到最後。
       */
      function jumpTo(dayKey) {
        var box = boxRef.current;
        if (!box) return;
        dropStick();
        if (!dayKey) {
          scrollToSettled(box, function (b) { return b.scrollHeight; });
          return;
        }
        // 收起來的日子要先展開 —— 不然「跳過去」只看到一條抬頭，
        // 使用者要的內容還是被折在裡面（需求：跳過去要看得到並展開）。
        setCollapsed(function (prev) {
          if (!prev[dayKey]) return prev;
          var next = {};
          for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
          next[dayKey] = false;
          return next;
        });
        // 每一輪都重新查詢節點並重新量位置 —— 見上面說明。
        //
        // 位置用 `getBoundingClientRect()` 換算（**不用 `offsetTop`**）：
        // `offsetTop` 是相對 `offsetParent` 的，而右側那個 `float:right` 的
        // 日期跳轉列會讓 `offsetParent` 不是我們以為的 stream
        // （實測：`offsetTop` 說 127，實際幾何是 16 —— 差 111px）。
        // 走 `scrollTopFor` 則只依賴當下真實的幾何。
        scrollToSettled(box, function (b) {
          var el = b.querySelector('.ntfy-teams-daywrap[data-daykey="' + dayKey + '"]');
          if (!el) return b.scrollHeight;
          // gap = 6：讓日期抬頭貼在內容頂端下方 6px（它自己的 margin-top），
          // 那條分割線就會落在視窗裡看得到。
          return scrollTopFor(b, el, 6);
        });
      }

      /** 這一輪的日期分段。 @returns {Array} 元素清單。 */
      function dayWraps() {
        var box = boxRef.current;
        if (!box || typeof box.querySelectorAll !== 'function') return [];
        return Array.prototype.slice.call(box.querySelectorAll('.ntfy-teams-daywrap'));
      }

      /**
       * 某個日期分段的 dayKey。
       *
       * ⚠️ `jumpTo` 收的是**字串 key**（見它的說明：展開會換掉節點，所以不能存參照）。
       * 從元素轉成 key 一定要經過這裡 —— 直接把元素傳進 `jumpTo` 會變成
       * `querySelector('[data-daykey="[object HTMLDivElement]"]')`，選不到東西，
       * 目標就退化成 scrollHeight（實測踩過：目標 911、實際上限 225）。
       *
       * @param wrap - 日期分段元素。
       * @returns dayKey 字串。
       */
      function keyOfWrap(wrap) {
        if (!wrap || typeof wrap.getAttribute !== 'function') return '';
        return wrap.getAttribute('data-daykey') || '';
      }

      /** 跳到上一天的第一則（在第一天的話就一路退到最上面）。 */
      function jumpPrevDay() {
        var box = boxRef.current;
        if (!box) return;
        var wraps = dayWraps();
        if (!wraps.length) return;
        var i = currentDayIndex(box, wraps);
        jumpTo(keyOfWrap(wraps[Math.max(0, i - 1)]));
      }

      /** 跳到下一天的第一則（在最後一天的話就一路到底部）。 */
      function jumpNextDay() {
        var box = boxRef.current;
        if (!box) return;
        var wraps = dayWraps();
        if (!wraps.length) return;
        var i = currentDayIndex(box, wraps);
        if (i >= wraps.length - 1) jumpTo('');
        else jumpTo(keyOfWrap(wraps[i + 1]));
      }

      /** 跳到第一則。 */
      function jumpFirst() {
        var box = boxRef.current;
        if (!box) return;
        dropStick();
        scrollToSettled(box, null, 0);
      }

      /**
       * 畫面上的日期分段數（用來決定上／下一天可不可按）。
       *
       * 這裡刻意**不**查 DOM：render 期間查 DOM 會多一次 layout，
       * 而且測試替身也沒有真的 DOM。用已經算好的 `groups` 就夠了
       * （它跟 `.ntfy-teams-daywrap` 是一對一的）。
       *
       * @returns 日期段數。
       */
      function dayGroupCount() {
        if (typeof groupByDay !== 'function' || !Array.isArray(messages)) return 0;
        return groupByDay(messages).length;
      }

      var dayCount = dayGroupCount();

      return e('div', { className: 'ntfy-teams-stream', ref: boxRef, onScroll: onScroll },
        // 日期跳轉列：一定要放在 stream **裡面**，sticky 才會跟著這個捲動容器。
        dayCount > 0
          ? e(DayNav, {
            key: 'daynav',
            hasDays: dayCount > 0,
            // 只有一天時沒有「上／下一天」可言（按鈕會變淡不可按）。
            hasPrev: dayCount > 1,
            hasNext: dayCount > 1,
            // 已經在最上面時 START 也變淡（沒有東西可以再往上）。
            atStart: !canScrollUp,
            onStart: jumpFirst,
            onPrev: jumpPrevDay,
            onNext: jumpNextDay,
            onEnd: function () { jumpTo(''); }
          })
          : null,
        // 「N 則新訊息」提示條：只有「沒貼在底部」時才需要提示 ——
        // 貼著底部時訊息就在你眼前，再提示一次反而是噪音。
        // 用**即時的**未讀數（unreadLive），不是畫線用的黏住快照。
        !nearBottom && unreadLive > 0
          ? e(UnreadPill, {
            key: 'unreadpill',
            count: unreadLive,
            onClick: jumpToUnread
          })
          : null,
        body);
    }

    // =========================================================================
    // 看板：示範圖表
    // =========================================================================

    /**
     * mulberry32：小、快、無相依的**種子**偽隨機數產生器。
     *
     * 為什麼不用 `Math.random()`：每次重繪都要拿到同一組數字，否則 React 一重繪
     * 圖表就會自己跳動（那不是「動態」，那是閃爍）。給定種子 → 給定序列，
     * 所以「同一輪」的圖形是穩定的；要換一輪就換種子。
     *
     * @param seed - 32 位元整數種子。
     * @returns 每次呼叫回傳 [0,1) 的函式。
     */
    function mulberry32(seed) {
      var a = seed >>> 0;
      return function next() {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    /**
     * 產生一組示範資料（**不是真實統計**）。
     *
     * 形狀刻意做成「有趨勢的隨機漫步 + 一點雜訊」而不是均勻亂數：
     * 均勻亂數畫成折線看起來像雜訊，不像儀表板；有趨勢才像話。
     *
     * @param seed - 種子（同一輪固定）。
     * @param topicNames - 目前的主題名清單（迷你條要用）。
     * @returns { points, kpis, topics, parts }。
     */
    function buildDemoData(seed, topicNames) {
      var rnd = mulberry32(seed);
      // 24 個時間點（近 24 小時）的活動量
      var points = [];
      var level = 30 + rnd() * 20;
      for (var i = 0; i < 24; i += 1) {
        level += (rnd() - 0.46) * 9;            // 隨機漫步，略微上偏
        level = Math.max(6, Math.min(100, level));
        points.push(Math.round(level));
      }
      var last = points[points.length - 1];
      var prev = points[points.length - 2] || last;
      var total = points.reduce(function (a, b) { return a + b; }, 0);

      // 四個分類的佔比（甜甜圈）
      var raw = [rnd() * 10 + 6, rnd() * 8 + 3, rnd() * 7 + 2, rnd() * 5 + 1];
      var rawSum = raw.reduce(function (a, b) { return a + b; }, 0);
      var parts = raw.map(function (v, idx) {
        return { label: ['已讀', '未讀', '待辦', '其他'][idx], value: Math.round((v / rawSum) * 100) };
      });
      // 讓四段加起來剛好 100（把誤差補到第一段，避免顯示 99% 或 101%）
      var drift = 100 - parts.reduce(function (a, p) { return a + p.value; }, 0);
      parts[0].value += drift;

      // 各主題的活動量（迷你條）—— 用主題名當一部分種子，換主題時比例也會變
      var names = (topicNames && topicNames.length) ? topicNames.slice() : ['pub_dsh'];
      var topics = names.slice(0, 6).map(function (name) {
        return { name: name, value: Math.round(rnd() * 70 + 25) };
      });

      return {
        points: points,
        kpis: [
          { label: '訊息', value: total, delta: Math.round(((last - prev) / Math.max(1, prev)) * 100) },
          { label: '活躍主題', value: names.length, delta: Math.round((rnd() - 0.5) * 40) },
          { label: '待辦', value: Math.round(parts[2].value / 4), delta: Math.round((rnd() - 0.5) * 60) }
        ],
        topics: topics,
        parts: parts
      };
    }

    /**
     * 活動量折線圖（含面積）。
     *
     * 座標系固定 240×64，再用 CSS `width:100%` 撐滿卡片 —— 這樣圖形永遠不會
     * 因為面板拖寬而變形，也不需要量 DOM（量 DOM 會多一次 layout，還要處理
     * 面板一開始 width=0 的情形）。
     *
     * @param props - { points }。
     * @returns SVG 元素。
     */
    function ActivityChart(props) {
      var pts = (props && props.points) || [];
      var W = 240, H = 64, PAD = 3;
      if (pts.length < 2) return null;
      var max = Math.max.apply(null, pts);
      var min = Math.min.apply(null, pts);
      var span = Math.max(1, max - min);
      /** 把索引／值映射成座標。 @param i - 索引。 @param v - 值。 @returns {x,y}。 */
      function xy(i, v) {
        return {
          x: PAD + (i / (pts.length - 1)) * (W - PAD * 2),
          y: H - PAD - ((v - min) / span) * (H - PAD * 2)
        };
      }
      var line = pts.map(function (v, i) {
        var p = xy(i, v);
        return (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1);
      }).join(' ');
      var first = xy(0, pts[0]);
      var lastP = xy(pts.length - 1, pts[pts.length - 1]);
      var area = line + ' L' + lastP.x.toFixed(1) + ' ' + H + ' L' + first.x.toFixed(1) + ' ' + H + ' Z';
      // 漸層 id 要唯一：同一個頁面可能同時有多個面板實例（實測踩過重複 id）。
      var gid = 'ntfy-teams-grad-' + Math.abs(props.gradientSeed || 1);

      return e('svg', {
        className: 'ntfy-teams-chartwrap',
        viewBox: '0 0 ' + W + ' ' + H,
        preserveAspectRatio: 'none',
        role: 'img',
        'aria-label': '示範活動量折線圖'
      },
        e('defs', null,
          e('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 },
            e('stop', { offset: '0%', stopColor: 'var(--dsw-static-blue-500)', stopOpacity: 0.32 }),
            e('stop', { offset: '100%', stopColor: 'var(--dsw-static-blue-500)', stopOpacity: 0 })
          )
        ),
        // 三條水平格線
        [0, 0.5, 1].map(function (f, gi) {
          var y = PAD + f * (H - PAD * 2);
          return e('line', {
            key: 'grid' + gi, className: 'ntfy-teams-gridline',
            x1: 0, y1: y, x2: W, y2: y
          });
        }),
        e('path', { d: area, fill: 'url(#' + gid + ')' }),
        e('path', { className: 'ntfy-teams-chartline', d: line })
      );
    }

    /**
     * 分類佔比的甜甜圈圖。
     *
     * @param props - { parts }。
     * @returns SVG 元素。
     */
    function DoughnutChart(props) {
      var parts = (props && props.parts) || [];
      var S = 76, R = 28, SW = 14;
      var C = 2 * Math.PI * R;
      var sum = parts.reduce(function (a, p) { return a + p.value; }, 0) || 1;
      var offset = 0;
      var segs = parts.map(function (p, i) {
        var frac = p.value / sum;
        var len = C * frac;
        var seg = { i: i, len: len, offset: offset };
        offset += len;
        return seg;
      });
      var lead = parts[0] ? parts[0].value : 0;
      return e('svg', {
        className: 'ntfy-teams-chartwrap',
        viewBox: '0 0 ' + S + ' ' + S,
        width: S, height: S,
        style: { maxWidth: S + 'px', margin: '0 auto' },
        role: 'img',
        'aria-label': '示範分類佔比甜甜圈圖'
      },
        // 底圈（灰）
        e('circle', {
          className: 'ntfy-teams-doughnuttrack',
          cx: S / 2, cy: S / 2, r: R, strokeWidth: SW
        }),
        segs.map(function (s) {
          return e('circle', {
            key: 'seg' + s.i,
            className: 'ntfy-teams-dseg ntfy-teams-dseg--' + s.i,
            cx: S / 2, cy: S / 2, r: R,
            // 從 12 點鐘方向開始：旋轉 -90°，再依累計長度位移
            strokeDasharray: s.len.toFixed(2) + ' ' + (C - s.len).toFixed(2),
            strokeDashoffset: (-s.offset).toFixed(2),
            transform: 'rotate(-90 ' + (S / 2) + ' ' + (S / 2) + ')'
          });
        }),
        // 圓心的兩行字（最大那一類的百分比 + 名稱）。
        //
        // ⚠️ 用 `dominant-baseline:central` 把兩行各自**垂直居中在指定的 y** 上，
        // 而不是靠調 font-size 猜基線 —— 靠猜的話不同字型／字級就會疊在一起
        // （實測前兩版就是把 58% 和「已讀」黏住，而且第一版還在中間開了一個洞）。
        // 環的內緣半徑 = 28 − 14/2 = 21，所以內圈直徑約 42px，
        // 兩行分別放在圓心上下各 8px，合計 26px 高的字塊，留得下。
        e('text', {
          x: S / 2, y: S / 2 - 8, textAnchor: 'middle', dominantBaseline: 'central',
          'font-size': 13, 'font-weight': 700, fill: 'var(--dsw-alias-label-primary)'
        }, lead + '%'),
        e('text', {
          x: S / 2, y: S / 2 + 8, textAnchor: 'middle', dominantBaseline: 'central',
          'font-size': 9, fill: 'var(--dsw-alias-label-secondary)'
        }, parts[0] ? parts[0].label : '')
      );
    }

    /**
     * 看板內容：示範儀表板（KPI + 折線 + 甜甜圈 + 各主題迷你條）。
     *
     * ⚠️ 這裡的資料是**隨機產生的示範**，不是真的統計（畫面上有「示範」標籤）。
     * 目的只是讓看板看起來像個儀表板，並驗證版面撐得住圖表。
     *
     * 「動態」的作法刻意**不用固定間隔的計時器**：
     *   * 使用者回報過「不要輪詢」的顧慮（雖然那是網路請求，但持續跳動一樣擾人）；
     *   * 而且每次換種子都重畫整棵子樹，在縮到很窄的面板裡會一直被 reflow。
     * 改成**跟著真實事件換一輪**：切換主題、開關面板都會給一個新種子，
     * 所以看起來是活的，但不會自己閃。
     *
     * @param props - { seed, topics }。
     * @returns 看板內容元素。
     */
    function DashDemo(props) {
      var seed = (props && props.seed) || 1;
      var names = (props && props.topics) || [];
      var data = buildDemoData(seed, names);
      var maxTopic = data.topics.reduce(function (a, t) { return Math.max(a, t.value); }, 1);

      return e('div', { className: 'ntfy-teams-charts' },
        // ---- KPI 三格 ----
        e('div', { className: 'ntfy-teams-card' },
          e('div', { className: 'ntfy-teams-cardhead' },
            e('span', { className: 'ntfy-teams-cardtitle' }, '總覽'),
            e('span', { className: 'ntfy-teams-demotag' }, '示範')
          ),
          e('div', { className: 'ntfy-teams-kpi' },
            data.kpis.map(function (k, i) {
              var up = k.delta >= 0;
              return e('div', { key: 'kpi' + i, className: 'ntfy-teams-kpibox' },
                e('span', { className: 'ntfy-teams-kpival' }, String(k.value)),
                e('span', { className: 'ntfy-teams-kpilabel' }, k.label),
                e('span', {
                  className: 'ntfy-teams-kpidelta '
                    + (up ? 'ntfy-teams-kpidelta--up' : 'ntfy-teams-kpidelta--down')
                }, (up ? '▲ +' : '▼ ') + k.delta + '%')
              );
            })
          )
        ),

        // ---- 活動量折線 ----
        e('div', { className: 'ntfy-teams-card' },
          e('div', { className: 'ntfy-teams-cardhead' },
            e('span', { className: 'ntfy-teams-cardtitle' }, '近 24 小時活動量'),
            e('span', { className: 'ntfy-teams-spacer' }),
            e('span', { className: 'ntfy-teams-demotag' }, '示範')
          ),
          e(ActivityChart, { points: data.points, gradientSeed: seed })
        ),

        // ---- 分類佔比 ----
        e('div', { className: 'ntfy-teams-card' },
          e('div', { className: 'ntfy-teams-cardhead' },
            e('span', { className: 'ntfy-teams-cardtitle' }, '訊息分類'),
            e('span', { className: 'ntfy-teams-spacer' }),
            e('span', { className: 'ntfy-teams-demotag' }, '示範')
          ),
          e(DoughnutChart, { parts: data.parts }),
          e('div', { className: 'ntfy-teams-legend' },
            data.parts.map(function (p, i) {
              return e('span', { key: 'lg' + i, className: 'ntfy-teams-lgleaf' },
                e('span', {
                  className: 'ntfy-teams-lgdot',
                  style: { background: 'var(--dsw-static-' + ['blue-500', 'amber-500', 'green-500', 'neutral-400'][i] + ')' }
                }),
                p.label + ' ' + p.value + '%'
              );
            })
          )
        ),

        // ---- 各主題活動量 ----
        e('div', { className: 'ntfy-teams-card' },
          e('div', { className: 'ntfy-teams-cardhead' },
            e('span', { className: 'ntfy-teams-cardtitle' }, '各主題活動量'),
            e('span', { className: 'ntfy-teams-spacer' }),
            e('span', { className: 'ntfy-teams-demotag' }, '示範')
          ),
          e('div', { className: 'ntfy-teams-topicbars' },
            data.topics.map(function (t, i) {
              return e('div', { key: 'tb' + i, className: 'ntfy-teams-tbrow' },
                e('span', { className: 'ntfy-teams-tbname', title: t.name }, t.name),
                e('span', { className: 'ntfy-teams-tbtrack' },
                  e('span', {
                    className: 'ntfy-teams-tbfill',
                    style: { width: Math.round((t.value / maxTopic) * 100) + '%' }
                  })
                ),
                e('span', { className: 'ntfy-teams-tbval' }, String(t.value))
              );
            })
          )
        )
      );
    }

    /**
     * 右側面板：**看板**（示範圖表）。
     *
     * 這一格可以拖寬、寬度會記住。最小寬度是需求（見 core.CONFIG.dashboardMinWidth）；
     * 拖動時同時夾住上限，免得把訊息串擠到看不見。
     *
     * @param props - { width, onResize, onResizeEnd, seed, topics }。
     * @returns 面板元素。
     */
    function DashboardPanel(props) {
      var width = typeof props.width === 'number' && props.width > 0 ? props.width : 260;
      var dragging = React.useRef(false);
      // 寬度範圍的**單一來源**是 core.CONFIG（不要在 UI 裡再寫一次數字 ——
      // 這裡原本硬寫 200，改最小值時就漏掉了 aria 與 tooltip）。
      var minW = (core && core.CONFIG && core.CONFIG.dashboardMinWidth) || 240;
      var maxW = (core && core.CONFIG && core.CONFIG.dashboardMaxWidth) || 1300;

      /** @param v - 想要的寬度。 @returns 夾在合法範圍內的寬度。 */
      function clamp(v) {
        return (core && typeof core.clampDashboardWidth === 'function')
          ? core.clampDashboardWidth(v, width)
          : Math.min(maxW, Math.max(minW, Math.round(v)));
      }

      /**
       * 拖動中：用「面板右緣 − 游標位置」反推寬度。
       * 在 window 上監聽 pointermove／up，游標滑出面板也不會斷。
       *
       * @param ev - pointerdown 事件。
       */
      function onPointerDown(ev) {
        if (typeof window === 'undefined') return;
        ev.preventDefault();
        dragging.current = true;
        var host = ev.currentTarget.parentNode;
        var rightEdge = host ? host.getBoundingClientRect().right : 0;

        /** @param e - pointermove 事件。 */
        function move(e) {
          if (!dragging.current) return;
          props.onResize(clamp(rightEdge - e.clientX));
        }
        /** @param e - pointerup／pointercancel 事件。 */
        function up(e) {
          if (!dragging.current) return;
          dragging.current = false;
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          var next = clamp(rightEdge - e.clientX);
          props.onResize(next);
          if (typeof props.onResizeEnd === 'function') props.onResizeEnd(next);
        }
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      }

      return e('div', {
        className: 'ntfy-teams-dash',
        style: { flexBasis: width + 'px', width: width + 'px' }
      },
        e('div', {
          className: 'ntfy-teams-dashgrip',
          role: 'separator',
          'aria-orientation': 'vertical',
          'aria-label': '拖曳調整右側面板寬度',
          'aria-valuenow': width,
          'aria-valuemin': minW,
          'aria-valuemax': maxW,
          tabIndex: 0,
          title: '拖曳調整寬度（至少 ' + minW + 'px）',
          onPointerDown: onPointerDown,
          // 鍵盤也能調：左右鍵 16px、PageUp／PageDown 64px
          onKeyDown: function (ev) {
            var step = ev.key === 'ArrowLeft' ? 16 : ev.key === 'ArrowRight' ? -16
              : ev.key === 'PageUp' ? 64 : ev.key === 'PageDown' ? -64 : 0;
            if (!step) return;
            ev.preventDefault();
            var next = clamp(width + step);
            props.onResize(next);
            if (typeof props.onResizeEnd === 'function') props.onResizeEnd(next);
          }
        }),
        e('div', { className: 'ntfy-teams-dashbody' },
          e(DashDemo, {
            seed: props.seed,
            topics: props.topics
          }),
          // 看板底部：留一段空白 + 一條極淡的分隔線（使用者指定 1px solid #eee）。
          // 這一塊是刻意的留白區（不是壞掉的多餘 div）——內容區與面板底緣之間
          // 需要一段呼吸空間，捲到底時也有一個明確的收尾。
          e('div', { className: 'ntfy-teams-dashfoot' })
        )
      );
    }

    // =========================================================================
    // 7. 面板：傳送区
    // =========================================================================

    /**
     * 送出的訊息預設用哪個優先級。
     *
     * 這個值是跟著 POST 送給 ntfy 的 `priority`（1..4），由 ntfy 決定**它自己**的
     * 推播行為（手機通知的大小聲、是否打穿勿擾）。面板的訊息物件也帶著
     * `priority`（`parseServerMessage` 會讀），所以要把它呈現到時間軸上是做得到的。
     *
     * 預設 3 = ntfy 的 normal。
     *
     * @type {number}
     */
    var DEFAULT_PRIORITY = 3;

    /**
     * 自動批準的延遲秒數（也是倒數顯示的起始秒數）。
     *
     * 需求演進：「自動回覆，延遲 5s，有倒計時效果，中途可以取消」
     * → 「6s too short, 10s」（使用者看到的是倒數從 5 數到 1，
     *   所以這裡的數字就是**他會看到的倒數秒數**）。
     *
     * 這個延遲是**安全機制**，不是為了好看：ntfy 沒有撤回，送出去就收不回來，
     * 而自動批準是「代替使用者發言」。這幾秒讓人來得及在看到不對時取消
     * （例如那句話其實是在討論、不是在請求核准）。
     *
     * @type {number}
     */
    var AUTO_APPROVE_DELAY_SEC = 10;

    /**
     * 優先級的選項（四級）。
     *
     * `level` 同時是「第幾格」與「強度」：四格做出階梯狀，選到第 n 級就亮前 n 格。
     * 用「格數」而不是只用顏色，是因為顏色單獨一種編碼對色弱不友善，
     * 而且四個色階在小尺寸下很難分辨。
     *
     * `tone` 是這一級的顏色基調（CSS 變數名）：送出鈕用它上色，
     * 所以「選了什麼優先級」在按下去之前就看得出來。
     *
     * ⚠️ 這裡沒有「顯示用的文字標籤」欄位 —— 標籤只在 tooltip 與 aria-label 出現
     * （送出的那一顆按鈕會顯示目前級別的名字，見 SendButton）。
     *
     * @type {Array<{value:number, label:string, level:number, tone:string}>}
     */
    var PRIORITY_OPTIONS = [
      { value: 1, label: '最低', level: 1, tone: 'muted' },
      { value: 2, label: '低', level: 2, tone: 'cool' },
      { value: 3, label: '預設', level: 3, tone: 'amber' },
      { value: 4, label: '高', level: 4, tone: 'hot' }
    ];

    /**
     * 找出某一級的設定。
     *
     * @param value - 優先級數值。
     * @returns 選項物件（找不到時回傳預設那一級）。
     */
    function priorityOption(value) {
      for (var i = 0; i < PRIORITY_OPTIONS.length; i += 1) {
        if (PRIORITY_OPTIONS[i].value === value) return PRIORITY_OPTIONS[i];
      }
      return PRIORITY_OPTIONS[PRIORITY_OPTIONS.length - 1];
    }

    /**
     * 下一個優先級（循環）。
     *
     * 抽成純函式是為了**可離線測試**：測試替身的 walker 會用一顆用完就丟的
     * slot 陣列展開子元件，在那裡面 `setState` 的結果不會留下來 ——
     * 所以「按一下會不會前進一級」沒辦法靠模擬點擊來驗（實測踩過）。
     * 把規則抽出來，就能直接驗規則本身。
     *
     * @param value - 目前級別。
     * @returns 下一級。
     */
    function nextPriority(value) {
      for (var i = 0; i < PRIORITY_OPTIONS.length; i += 1) {
        if (PRIORITY_OPTIONS[i].value === value) {
          return PRIORITY_OPTIONS[(i + 1) % PRIORITY_OPTIONS.length].value;
        }
      }
      return DEFAULT_PRIORITY;
    }

    /**
     * 某一級對應的色調（CSS 上的 `data-tone`）。
     *
     * 顏色是「不同優先級，不同的顏色」這個需求的實作，所以也抽出來測。
     *
     * @param value - 級別。
     * @returns 色調名（muted / cool / amber / hot）。
     */
    function priorityTone(value) {
      return priorityOption(value).tone;
    }

    /**
     * 優先級強度指示（幾格實心，由矮到高）。
     *
     * @param props - { level, total }。
     * @returns 指示元素。
     */
    function PriorityBars(props) {
      var total = props.total || PRIORITY_OPTIONS.length;
      var level = Math.max(0, Math.min(total, props.level || 0));
      var cells = [];
      for (var i = 0; i < total; i += 1) {
        cells.push(e('i', {
          key: 'b' + i,
          'data-lv': String(i + 1),
          className: 'ntfy-teams-pribar' + (i < level ? ' ntfy-teams-pribar--on' : '')
        }));
      }
      return e('span', { className: 'ntfy-teams-pribars', 'aria-hidden': 'true' }, cells);
    }

    /**
     * 送出鈕 —— **同時是優先級的顯示器**。
     *
     * 需求：「這個新優先級 UI 也不好點擊。覺得可以和發送的 button 結合起來用，
     *       不同優先級，不同的顏色」。
     *
     * 上一版是四個獨立的小按鈕，每一格只有 7×16px（實測）—— 幾乎按不到，
     * 而且它跟「送出」是兩件事、要分開看。合併之後：
     *
     *   * **送出鈕本身的顏色＝目前的優先級**：按下去之前就知道這則訊息多大聲，
     *     不必再去別的地方確認；
     *   * 按鈕左邊那一段是**切換優先級**（一次前進一級、循環），
     *     右邊那一段是**送出** —— 兩個動作各自有明確的文字，
     *     而且整顆按鈕高 38px、加起來約 130px 寬，好按。
     *
     * 為什麼不做成「換級別時就送出」：那是**無法撤銷**的動作，
     * 把「打字打到一半誤觸」變成「送出一則錯誤訊息」，代價太高。
     * 顏色已經讓它合為一體了，不需要連動作也合併。
     *
     * @param props - { priority, disabled, busy, canPublish, hasName, onCycle, onSend }。
     * @returns 按鈕元素。
     */
    function SendButton(props) {
      var opt = priorityOption(props.priority);
      var level = opt.value;
      var tone = opt.tone;
      var disabled = props.disabled === true;
      // 「送出」的說明：跟舊版一致，分開講「要認證」與「還沒設定名稱」。
      var sendTitle = !props.canPublish
        ? '此主題需要認證才能傳送'
        : (props.hasName === false ? '請先設定顯示名稱' : '傳送訊息');
      var groups = [];
      // 設定 key 避免 React 對同一組兄弟節點發出警告。
      groups.push(e('button', {
        key: 'lvl',
        type: 'button',
        className: 'ntfy-teams-sendlvl',
        disabled: disabled,
        'aria-label': '優先級：' + opt.label + '（按一下切換下一級）',
        title: '優先級：' + opt.label + '。按一下切換下一級（'
          + PRIORITY_OPTIONS.map(function (o) { return o.label; }).join(' → ') + '，循環）',
        onClick: function () { props.onCycle(); }
      },
        e(PriorityBars, { level: level }),
        e('span', { className: 'ntfy-teams-sendlvltext' }, opt.label)
      ));
      groups.push(e('span', { key: 'div', className: 'ntfy-teams-senddiv', 'aria-hidden': 'true' }));
      groups.push(e('button', {
        key: 'send',
        type: 'button',
        className: 'ntfy-teams-sendgo',
        disabled: props.busy || disabled,
        title: sendTitle,
        onClick: function () { props.onSend(); }
      },
        e(SendGlyph),
        e('span', null, props.busy ? '傳送中…' : '傳送')
      ));
      return e('span', {
        className: 'ntfy-teams-sendbtn ntfy-teams-sendbtn--p' + level,
        'data-tone': tone
      }, groups);
    }

    /**
     * 傳送区：白名单只在 topic 名字以 pub_ 开头或已設定認證时开放送出。
     * @param props - { topic, cred, canPublish }。
     * @returns 傳送区元素。
     */
    function Composer(props) {
      // 初始內容：如果剛剛按了「用這一天開新 session」，第一個掛載的撰寫區
      // （也就是新 session 的那一個）會把復盤材料接過去，只等使用者按送出。
      // 帶上主題是為了避免把材料交給不相關主題的撰寫區。
      var bodyState = React.useState(function () { return givePendingDraft(props.topic); });
      var body = bodyState[0];
      var setBody = bodyState[1];
      var prioState = React.useState(DEFAULT_PRIORITY);
      var prio = prioState[0];
      var setPrio = prioState[1];

      /**
       * 切換到下一級優先級（循環）。
       *
       * 為什麼用「循環」而不是展開一個清單：送出鈕上面那個區塊很小，
       * 展開清單會把它變成一個浮層（多一層要處理定位與關閉）。
       * 四級循環最多按 3 下就到想要的，而且每一級的名字都顯示在按鈕上，
       * 按的時候看得到自己在哪一級。
       *
       * @returns 切換後的級別。
       */
      function cyclePriority() {
        var next = nextPriority(prio);
        setPrio(next);
        return next;
      }
      // 切換主題就回到預設 —— 而且**刻意不保存**。
      //
      // 需求：「切換 topic 恢復預設，不用保存它狀態」。
      //
      // 為什麼要明確重置而不是靠元件重掛：`props.topic` 變的時候
      // `listProps.key` 也變，React 確實會重掛、state 自然回到初始值 ——
      // 但那是**實作細節**（依賴 key 的寫法）。這裡再依賴一次 `props.topic`，
      // 把「換主題就回到預設」寫成明確的行為，key 以後怎麼改都不會壞。
      //
      // 不保存也意味著：不進 config.yml、不進 localStorage，重新整理也是預設值。
      var prioTopicRef = React.useRef(props.topic);
      React.useEffect(function () {
        if (prioTopicRef.current === props.topic) return;
        prioTopicRef.current = props.topic;
        setPrio(DEFAULT_PRIORITY);
      }, [props.topic]);
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var errState = React.useState('');
      var err = errState[0];
      var setErr = errState[1];

      // 送出的訊息標題就是本人的 #username（群組對話約定）。
      var selfName = text(props.identity).trim();
      var sendAs = titleFor(selfName);

      /** 送出訊息。 */
      function send() {
        var content = text(body).trim();
        if (content === '') return;
        // 沒有顯示名稱就不送出。
        //
        // 為什麼要擋：訊息的 title 就是 `#username`，那是群組裡「誰說的」的唯一依據。
        // 沒設定名稱時送出的訊息在別人眼裡是**無名訊息**（我們的 UI 也會把它顯示成
        // `--`），對追蹤與回覆都沒有用 —— 所以寧可先擋下來請使用者填名字。
        // UI 上按鈕也已經是 disabled，這裡是第二道（鍵盤 Enter 也走得到）。
        if (sendAs === '') {
          setErr('請先設定顯示名稱：到上方「共用設定」填寫後才能傳送訊息。');
          return;
        }
        if (!core || typeof core.publishMessage !== 'function') {
          setErr('核心模組未載入');
          return;
        }
        setBusy(true);
        setErr('');
        var payload = {
          title: sendAs,
          message: content,
          priority: prio,
          cred: props.cred
        };
        core.publishMessage(core.readConfig().server, props.topic, payload).then(function (result) {
          setBusy(false);
          if (result && result.ok) {
            if (result.message && core.store && typeof core.store.addMessage === 'function') {
              core.store.addMessage(props.topic, result.message);
            }
            setBody('');
          } else {
            setErr(core && typeof core.describeError === 'function'
              ? core.describeError(result)
              : '傳送失敗');
          }
        }, function (e2) {
          setBusy(false);
          setErr('傳送失敗：' + text(e2 && e2.message));
        });
      }

      /** 文字框按鍵：Enter 送出、Shift+Enter 換行。 @param ev - 鍵盤事件。 */
      function onKeyDown(ev) {
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.nativeEvent.isComposing) {
          ev.preventDefault();
          send();
        }
      }

      var canPublish = props.canPublish !== false;
      // 沒有顯示名稱也不能送（見 send() 的說明）。
      // 跟 canPublish 分開判斷：兩者的原因與提示完全不同 ——
      // 一個是「這個主題要認證」，一個是「你還沒說你是誰」。
      var hasName = sendAs !== '';
      var canSend = canPublish && hasName;

      return e('div', { className: 'ntfy-teams-compose' },
        // ---- 一列：身分／自動批準／永遠滾到最新／優先級 ----
        //
        // 需求：「身分說明、自動回覆、自動滾屏、優先級放在同一行，文本簡約」。
        //
        // 之前是兩列（兩個 checkbox 一列、身分＋優先級一列），高度多花一倍，
        // 而且「設定」被拆成兩處。合成一列之後閱讀順序是：
        //     我是誰（左） → 兩個開關 → 優先級（右）
        //
        // ⚠️ 擠不下的處理方式是**由外而內依序省略最不重要的文字**（見 CSS 的
        // media query）：先收「優先級」三個字，再收開關的文字只留方框。
        // 不做換行 —— 一換行就又變回兩列，這個需求的意義就沒了。
        e('div', { className: 'ntfy-teams-composemeta' },
          // 身分：只留「以 #名稱 傳送」，前面的「以」「的身分傳送」省掉。
          // 圖示（人形）已經表達了「這是身分」，所以文字可以再短。
          e('span', {
            className: 'ntfy-teams-sendas',
            title: sendAs !== ''
              ? '以 ' + sendAs + ' 的身分傳送'
              : '尚未設定名稱：到上方「共用設定」填寫後才能傳送訊息'
          },
            e(PersonGlyph),
            e('span', { className: 'ntfy-teams-sendastext' },
              sendAs !== '' ? sendAs : '未設定名稱')),
          // ---- 自動批準（＋倒數期間的取消鈕）----
          //
          // 標籤刻意**簡短**（回饋：「解釋太多了」、「文本簡約」）：
          // 平常只要看得懂「這是什麼開關」，詳細規則（觸發字串、回什麼、
          // 還需要 hermes-agent 標籤…）放在 tooltip 裡 ——
          // 想知道的人滑過去就有，不想知道的人不必每次讀一整句。
          //
          // 延遲期間（倒數中）這顆膠囊會**變成倒數狀態**：顯示剩幾秒 + 一顆取消鈕。
          // 就地變身而不是另外彈一個 toast —— 使用者的視線本來就在這裡，
          // 而且「哪裡開啟、就在哪裡取消」比多一個浮層好理解。
          //
          // ⚠️ 取消鈕**不能**放在 label 裡面：label 會把點擊轉給 checkbox，
          // 按「取消」就會順便關掉整個開關（那不是使用者的意思）。
          // 所以 label 與取消鈕是同一個 wrapper 的兄弟節點。
          e('span', {
            className: 'ntfy-teams-approvewrap'
              + (props.approvePending ? ' ntfy-teams-approvewrap--pending' : '')
          },
            e('label', {
              className: 'ntfy-teams-autoapprove',
              // tooltip 要把「還需要 hermes-agent 標籤」寫出來 —— 少了這句，
              // 使用者會以為只要有人打出那句話就會被自動回覆。
              title: props.approvePending
                ? '倒數中：' + props.approveLeftSec + ' 秒後會自動回覆「' + props.approvePending.text
                  + '」。按「取消」可以不送。'
                : '自動批準：收到帶 hermes-agent 標籤、且含「/approve session」的訊息時，'
                  + '延遲 ' + AUTO_APPROVE_DELAY_SEC + ' 秒後自動回覆「/approve」（期間可取消）'
            },
              e('input', {
                type: 'checkbox',
                className: 'ntfy-teams-autoapprovebox',
                checked: !!props.autoApproveOn,
                disabled: !canPublish,
                onChange: function (ev) {
                  if (typeof props.onToggleAutoApprove === 'function') {
                    props.onToggleAutoApprove(ev.target.checked);
                  }
                }
              }),
              props.approvePending
                ? e('span', { className: 'ntfy-teams-autoapprovetext' },
                  '自動批準 ',
                  e('b', { className: 'ntfy-teams-approvecount' }, props.approveLeftSec + 's')
                )
                : e('span', { className: 'ntfy-teams-autoapprovetext' }, '自動批準')
            ),
            props.approvePending
              ? e('button', {
                type: 'button',
                className: 'ntfy-teams-approvecancel',
                title: '取消這次自動回覆',
                onClick: function () {
                  if (typeof props.onCancelAutoApprove === 'function') props.onCancelAutoApprove();
                }
              }, '取消')
              : null
          ),
          // ---- 永遠滾到最新 ----
          //
          // 「不管誰發的」這個關鍵差別放在 tooltip：它跟未讀提示條的取捨
          // 需要解釋，但不該佔掉每一眼的閱讀成本。
          e('label', {
            className: 'ntfy-teams-staybottom',
            title: '永遠滾到最新：不管訊息是誰發的，都自動捲到最底'
          },
            e('input', {
              type: 'checkbox',
              className: 'ntfy-teams-staybottombox',
              checked: !!props.stayAtBottom,
              onChange: function (ev) {
                if (typeof props.onToggleStayAtBottom === 'function') {
                  props.onToggleStayAtBottom(ev.target.checked);
                }
              }
            }),
            e('span', { className: 'ntfy-teams-staybottomtext' }, '永遠滾到最新')
          ),
          // 優先級不再自己佔一格 —— 它已經**併進送出鈕**（顏色＝目前級別），
          // 見下面 SendButton。同一件資訊只出現在一個地方，不必兩處對照。
        ),
        e('div', { className: 'ntfy-teams-composerow' },
          // 沒有名稱時輸入框**仍可打字**：讓使用者先把想說的話寫好，
          // 填完名稱就能直接送出，不必重打一遍。只有送出動作被擋。
          e('textarea', {
            className: 'ntfy-teams-textarea',
            rows: 1,
            spellCheck: false,
            placeholder: !canPublish
              ? '此主題需要認證才能傳送'
              : (hasName ? '輸入訊息，支援 Markdown；Enter 傳送、Shift+Enter 換行' : '請先設定顯示名稱才能傳送'),
            value: body,
            disabled: !canPublish,
            onChange: function (ev) { setBody(ev.target.value); },
            onKeyDown: onKeyDown
          }),
          // 送出鈕同時是優先級的顯示器（顏色＝目前級別），見 SendButton 的說明。
          e(SendButton, {
            priority: prio,
            disabled: !canSend,
            busy: busy,
            canPublish: canPublish,
            hasName: hasName,
            onCycle: cyclePriority,
            onSend: send
          })
        ),
        err !== '' ? e('div', { className: 'ntfy-teams-hint ntfy-teams-hint--err' }, err) : null
      );
    }

    // =========================================================================
    // 8. 面板主体
    // =========================================================================

    /**
     * 「團隊協同」面板。
     *
     * 生命週期：掛載時先把訂閱過的 topic 從 localStorage 還原，再对每个 topic
     * 拉一次历史（/json?poll=1&since=all）並開一條 SSE 即時流；server 或 topic
     * 清单改变时重来一遍；卸载时关掉所有 SSE。
     *
     * @returns 面板元素。
     */
    function MainPanel() {
      var snapshot = useStore();
      var topics = snapshot.topics || [];
      var active = snapshot.activeTopic || topics[0] || '';

      var serverState = React.useState(function () {
        if (!core || typeof core.readConfig !== 'function') return '';
        return core.readConfig().server;
      });
      var server = serverState[0];
      var setServer = serverState[1];

      var connState = React.useState(false);
      var showConn = connState[0];
      var setShowConn = connState[1];

      // 自己的顯示名稱（送出訊息的 #username）。共用設定儲存後回寫。
      var idState = React.useState(function () { return currentIdentity(); });
      var identity = idState[0];
      var setIdentity = idState[1];

      var bootState = React.useState(false);
      var booted = bootState[0];
      var setBooted = bootState[1];

      var loadState = React.useState(false);
      var loading = loadState[0];
      var setLoading = loadState[1];

      var failState = React.useState({});
      var failures = failState[0];
      var setFailures = failState[1];

      var nonceState = React.useState(0);
      var nonce = nonceState[0];
      var setNonce = nonceState[1];

      // 右側看板寬度：初始值從設定讀（拖過就記住了），拖動期間只改 state，
      // 放開才寫回設定 —— 拖一次寫幾十遍 localStorage 沒有意義。
      var dashState = React.useState(function () {
        var w = core && typeof core.readConfig === 'function' ? core.readConfig().dashboardWidth : 0;
        return (core && typeof core.clampDashboardWidth === 'function')
          ? core.clampDashboardWidth(w, 260)
          : (w || 260);
      });
      var dashWidth = dashState[0];
      var setDashWidth = dashState[1];

      // 看板示範資料的種子。
      //
      // 需求要「動態而隨機」，但**刻意不做定時更新**：
      //   * 使用者明確回報過不要輪詢（雖然那是指網路請求，但持續跳動一樣擾人）；
      //   * 每隔幾秒重畫整棵子樹，在拖到很窄的面板裡會一直被 reflow。
      // 改成「跟著真實事件換一輪」——切換主題、開關面板都讓種子變一次。
      // 這樣它看起來是活的，但不會自己閃；而且同一輪內重繪拿到的是同一組數字
      // （種子式隨機，不是 Math.random），所以不會畫面抖動。
      var dashSeedState = React.useState(function () {
        return (Date.now() % 1000000) + 1;
      });
      var dashSeed = dashSeedState[0];
      var setDashSeed = dashSeedState[1];
      React.useEffect(function () {
        // 當前主題一變就換一輪示範資料。
        setDashSeed(function (s) { return (s + 7919) % 1000000 + 1; });
      }, [active]);

      var topicsKey = topics.join('\u0000');
      var authRequired = !!(active && snapshot.authByTopic && snapshot.authByTopic[active]);

      /** 目前主題的未讀數（切換的動作會先把它歸零，所以要在 render 期間讀）。 */
      var unreadOfActive = (snapshot.unreadByTopic && snapshot.unreadByTopic[active]) || 0;
      var lastReadOfActive = (snapshot.lastReadIdByTopic && snapshot.lastReadIdByTopic[active]) || '';

      // ---- 未讀邊界（每個主題第一次被打開時抓一次，之後就黏住）----
      //
      // 為什麼要黏住：切換主題的動作會先把未讀歸零（store 這麼做是對的，角標要立刻
      // 消失），而面板在同一次 render 就開始畫了。用「當下的未讀數」當條件會有三個
      // 時機抓不到：
      //   1. 點 chip 之後 store 立刻歸零 → 重繪時已經是 0；
      //   2. 剛切過去時該主題的訊息還沒載入，lastReadId 找不到 → 不畫；
      //   3. 歷史載入後又一次重繪，此時未讀早就 0 了。
      // 所以改成：只在**切換主題**、或**該主題又累積了更多未讀**時更新這個快照，
      // 然後一直保留到使用者真的捲到那條線（onSeen）才清掉。
      var pendingUnreadRef = React.useRef({});
      var pendingByTopic = pendingUnreadRef.current;
      var pendingEntry = pendingByTopic[active];
      if (!pendingEntry) {
        pendingEntry = { count: unreadOfActive, lastReadId: lastReadOfActive };
        pendingByTopic[active] = pendingEntry;
      } else if (unreadOfActive > pendingEntry.count) {
        // 又有新的一輪未讀（例如你正在別的主題）
        pendingEntry.count = unreadOfActive;
        pendingEntry.lastReadId = lastReadOfActive;
      } else if (unreadOfActive === 0 && pendingEntry.count === 0) {
        // 沒有未讀時，跟著「讀到哪」走，這樣就不會畫出任何線
        pendingEntry.lastReadId = lastReadOfActive;
      }
      var pendingForActive = pendingEntry;

      /**
       * 读一次憑證。
       * @returns 憑證物件。
       */
      function credOf() {
        if (!core || typeof core.loadCredentials !== 'function') {
          return { mode: 'none', user: '', password: '', token: '' };
        }
        return core.loadCredentials(server);
      }

      // ---- 啟動：還原訂閱過的 topic 與設定 ----
      //
      // host 層的 startLiveSync 已經先跑過一次 bootStore()（面板可能永遠不被打開），
      // 這裡再保險一次：重複呼叫是安全的。
      React.useEffect(function () {
        if (!core || !core.store) {
          setBooted(true);
          return;
        }
        bootStore();
        var cfg = typeof core.readConfig === 'function' ? core.readConfig() : null;
        if (cfg && cfg.server) setServer(cfg.server);
        setBooted(true);
      }, []);

      // ---- 歷史：需要時才拉（**開啟時只拉當前主題**），429 就退避重試 ----
      //
      // 為什麼改成「lazy」：訊息快取已經移除（不再使用 localStorage），所以沒有
      // 現成的內容可以先畫。若開機就對**每個**主題各拉一次歷史，5 個主題就是
      // 5 個請求 —— ntfy 的額度實測只有約 6 次／短窗口，一開機就把額度吃掉，
      // 連帶把 SSE 與重連推進 429。
      //
      // 現在只拉「使用者正在看的那個」，其他主題等他切過去再拉（每個主題一輩子
      // 只需要拉一次；nonce 改變＝使用者按了重新載入，才全部重拉）。
      //
      // 為什麼不並行（原本是 Promise.all + map）：理由同上 —— 短窗口小額度。
      var fetchedRef = React.useRef({});
      // server 或 nonce 變了就當作全部過期。
      var fetchedKey = server + '\u0001' + nonce + '\u0001' + topicsKey;
      if (fetchedRef.current.key !== fetchedKey) {
        fetchedRef.current = { key: fetchedKey, done: {} };
      }
      var fetchedList = fetchedRef.current.done;
      // 要拉的主題：當前主題，且這次 session 還沒拉過。
      var fetchedTopics = [];
      if (active && fetchedList[active] !== true) fetchedTopics.push(active);
      React.useEffect(function () {
        if (!core || typeof core.fetchTopicMessages !== 'function') return undefined;
        // 沒有要拉的東西就不動 loading（否則切到已拉過的主題會閃一下「載入中」）。
        if (fetchedTopics.length === 0) return undefined;
        var alive = true;
        var cred = credOf();
        var limit = core.readConfig ? core.readConfig().historyLimit : 300;
        var failures = {};
        setLoading(true);
        // 讓「載入中」只反映**第一次嘗試**，不包含退避重試的等待。
        //
        // 實測踩到的 bug：429 的重試會把整個 chain 卡住（延遲上限 30 秒），
        // 而 setLoading(false) 掛在 chain 最後 —— 於是一個安靜的主題會一直顯示
        // 「正在載入歷史訊息…」，即使第一次嘗試早就回來了。
        var settledOnce = false;
        /** 第一次嘗試結束就收掉「載入中」。 */
        function firstSettled() {
          if (settledOnce || !alive) return;
          settledOnce = true;
          setFailures(failures);
          setLoading(false);
        }

        /**
         * 拉一個主題，遇到 429／5xx 會退避重試。
         * @param topic - 主題。
         * @returns Promise（永遠 resolve，錯誤放進 failures）。
         */
        function fetchOne(topic) {
          var attempt = 0;
          /**
           * 單次嘗試。
           * @param isFirst - 是否是這個主題的第一次嘗試。
           * @returns Promise。
           */
          function attemptOnce(isFirst) {
            return core.fetchTopicMessages(server, topic, { cred: cred, limit: limit }).then(function (result) {
              // 第一次嘗試回來就先收掉「載入中」，重試在背景慢慢做。
              if (isFirst) firstSettled();
              if (!alive) return false;
              if (result && result.authRequired) {
                if (core.store && typeof core.store.setAuthRequired === 'function') {
                  core.store.setAuthRequired(topic, true);
                }
              } else if (core.store && typeof core.store.setAuthRequired === 'function') {
                // ⚠️ 成功時必須把「需要認證」**清掉**。
                //
                // 這個旗標原本只會被設成 true（403 時），沒有任何人設回 false ——
                // 於是使用者補上帳密、連線也真的成功了，畫面卻還一直掛著
                // 「此主題需要認證，請在共用設定裡輸入帳號與密碼」
                // （就是回報的「保存生效了，它還在顯示上一次的錯誤」）。
                //
                // 只有在**真的拿到回應**時才清 —— 網路錯誤不該被當成「認證沒問題」。
                core.store.setAuthRequired(topic, false);
              }
              if (result && result.messages && result.messages.length && core.store
                && typeof core.store.addMessages === 'function') {
                core.store.addMessages(topic, result.messages, 'history');
              }
              if (result && result.error) {
                // 429 是「等一下就好」，不是設定錯誤 —— 退避後重試，不要把紅字留給使用者。
                var status = typeof result.status === 'number' ? result.status : 0;
                var plan = backoffFor(status, attempt + 1);
                if (plan.retry) {
                  attempt += 1;
                  return new Promise(function (resolve) {
                    setTimeout(function () { resolve(attemptOnce(false)); }, plan.delayMs);
                  });
                }
                failures[topic] = humanError(result);
              } else {
                delete failures[topic];
              }
              return false;
            }, function (err) {
              if (isFirst) firstSettled();
              if (!alive) return false;
              failures[topic] = text(err && err.message);
              return false;
            });
          }
          return attemptOnce(true).then(function () {}, function () {});
        }

        // 依序串起來：一個完成才打下一個，中間再隔 400ms。
        //
        // 為什麼要隔：只是「依序」還不夠 —— 前一個請求可能幾十毫秒就回來了，
        // 4 個主題仍會在不到一秒內打完，對小額度的限流來說還是一次尖峰。
        // 實測 ntfy 的額度約 6 次/短窗口，把 4 個歷史請求攤開就還留得下
        // SSE 重連的餘裕。
        var chain = Promise.resolve();
        fetchedTopics.forEach(function (topic, index) {
          chain = chain.then(function () {
            if (!alive) return undefined;
            return fetchOne(topic).then(function () {
              if (!alive) return undefined;
              return new Promise(function (resolve) { setTimeout(resolve, 400); });
            });
          });
        });

        chain.then(function () {
          if (!alive) return;
          // 記下「這個主題已經拉過」，之後切回來不用再拉一次。
          for (var fi = 0; fi < fetchedTopics.length; fi += 1) {
            fetchedList[fetchedTopics[fi]] = true;
          }
          // 保底：即使第一次嘗試那條路沒走到 firstSettled()，這裡也要收掉
          // 「載入中」—— 它絕不該留在畫面上。
          setFailures(failures);
          setLoading(false);
        });

        return function () { alive = false; };
      }, [booted, server, topicsKey, active, nonce]);

      // ---- 即時（SSE）已經搬到 host 層（startLiveSync）----
      //
      // 不能在這裡再開一條：面板會被 host 卸載，掛在這裡的連線也會跟著斷，
      // 而角標需要的正是「面板沒開時也持續收訊息」。兩邊都開還會變成雙份連線
      // （同一則訊息進 store 兩次，靠 id 去重才沒事，但白白浪費）。
      // 面板只負責「顯示」與「拉歷史」，收訊是 host 的事。

      // ---- 取消訂閱時清掉失敗記錄（topic 的资料由 store.removeTopic 自己清） ----
      React.useEffect(function () {
        setFailures(function (prev) {
          var next = {};
          var changed = false;
          for (var k in prev) {
            if (!Object.prototype.hasOwnProperty.call(prev, k)) continue;
            if (topics.indexOf(k) === -1) changed = true;
            else next[k] = prev[k];
          }
          return changed ? next : prev;
        });
      }, [topicsKey]);

      // 未讀數量與訊息**不再落盤**。
      //
      // 這裡原本有兩個 effect 把「訂閱清單指紋」與「未讀／訊息總數指紋」寫進
      // localStorage（為了讓重新整理後角標與內容還在）。這個外掛現在**不使用
      // localStorage**：持久層只有宿主的 config.yml，而且它只放設定，不放訊息。
      //
      // 取而代之的是「開啟時重抓歷史」（見下方歷史 effect）——
      // 反正訊息本來就來自伺服器，重抓比維護第二份真相單純得多。

      // ---- 面板每次「真的多了新訊息」时，把该 topic 的未读归零 ----
      // 用 ref 记住上次处理的则数：否则 markRead → store 变更 → 重绘 → effect
      // 再跑一次，会变成无穷回圈。
      //
      // ⚠️ 這裡**必須加上「貼在底部」的條件**（需求：「如果是我發的就自動滾屏到
      // 那條之後，如果是其他人發的就提示未讀」）。少了它會有兩個後果：
      //   1. 使用者往上翻歷史時，別人的訊息一進來就被清成已讀 ——
      //      store 明明把未讀 +1，立刻被這裡歸零，「N 則新訊息」提示永遠不會出現
      //      （實測就是這個：unread 1 → 0，而 isFollowing 是 false）；
      //   2. 提示條的顯示條件（`!nearBottom && unreadLive > 0`）永遠不成立。
      //
      // 用 `followRef`（跟著捲動即時更新）而不是當場查 DOM：effect 執行時機
      // 跟捲動不同步，當場查會拿到過期的值。
      var readRef = React.useRef({});
      var activeCount = (active && snapshot.messagesByTopic && snapshot.messagesByTopic[active]
        ? snapshot.messagesByTopic[active].length
        : 0);
      React.useEffect(function () {
        if (!active) return;
        if (readRef.current[active] === activeCount) return;
        readRef.current[active] = activeCount;
        // 沒貼在底部 → 不清未讀。store 會把它累加起來，由提示條呈现。
        if (!streamFollowingRef.current) return;
        if (core && core.store && typeof core.store.markRead === 'function') {
          core.store.markRead(active);
        }
      }, [active, activeCount]);

      /** 重新抓历史 + 重连 SSE。 */
      function refresh() {
        if (core && core.store && typeof core.store.clearMessages === 'function') {
          for (var i = 0; i < topics.length; i += 1) core.store.clearMessages(topics[i]);
        }
        setNonce(function (n) { return n + 1; });
      }

      var activeMessages = (active && snapshot.messagesByTopic && snapshot.messagesByTopic[active]) || [];
      // 給計時器用的「目前主題」：setTimeout 的 callback 只認得建立當下的閉包，
      // 用 ref 才讀得到**當下**的主題（倒數期間使用者可能已經切走了）。
      var activeRef = React.useRef(active);
      activeRef.current = active;
      var activeStatus = statusOf(snapshot, active);
      var activeFailure = active ? failures[active] : null;
      var cred = credOf();
      var canPublish = /^pub_/.test(active) || (cred.mode && cred.mode !== 'none');

      /**
       * 送一則訊息到某個主題（文字輸入與自動回應共用這一條路）。
       *
       * 為什麼要抽出來：自動回應也是「送一則訊息」，如果它自己另寫一份
       * publishMessage → addMessage → 處理錯誤的流程，兩邊遲早會不一致
       * （這裡已經有太多「兩份實作不同步」的前例）。
       *
       * @param topic - 主題名。
       * @param message - 內文。
       * @param options - { priority, asName }。
       * @returns Promise<{ok:boolean, error?:string}>。
       */
      function publishToTopic(topic, message, options) {
        var o = options || {};
        if (!core || typeof core.publishMessage !== 'function') {
          return Promise.resolve({ ok: false, error: '核心模組未載入' });
        }
        var name = text(o.asName !== undefined ? o.asName : identity).trim();
        var as = titleFor(name);
        if (as === '') return Promise.resolve({ ok: false, error: '尚未設定顯示名稱' });
        return core.publishMessage(core.readConfig().server, topic, {
          title: as,
          message: message,
          priority: typeof o.priority === 'number' ? o.priority : 3,
          cred: credOf()
        }).then(function (result) {
          if (result && result.ok) {
            if (result.message && core.store && typeof core.store.addMessage === 'function') {
              core.store.addMessage(topic, result.message);
            }
            return { ok: true };
          }
          return {
            ok: false,
            error: core && typeof core.describeError === 'function'
              ? core.describeError(result)
              : '傳送失敗'
          };
        }, function (e2) {
          return { ok: false, error: '傳送失敗：' + text(e2 && e2.message) };
        });
      }

      // ---- 自動回應：/approve session → /approve ----
      //
      // 需求：input 上方一個 checkbox，勾選後「當前 topic 出現 /approve session
      // 就自動回 /approve」。
      //
      // 判定本身在 core（純函式、可離線測）；這裡只負責**在正確的時機呼叫它、
      // 送出去、並記錄已經回過哪一則**。
      //
      // ⚠️ 三重防護，缺一不可（這功能一旦誤觸發就是往群組灌訊息）：
      //   1. 只認 `sse` 來源 —— 面板一開載入的歷史訊息不會被回一遍；
      //   2. 不回應自己發的 —— 否則「我回了 /approve」又被判定成觸發 → 無限循環；
      //   3. `ids` 記在 config.yml（跨重新整理存活）—— 同一則只回一次。
      // ⚠️ 開關的狀態一定要用 React state，**不能**直接讀 `core.readConfig()`。
      //
      // 踩過的 bug：`saveConfig()` 只寫記憶體與宿主，**不會觸發 store 的通知**，
      // 所以「讀 config 的普通變數」在切換後不會讓元件重繪 ——
      // 畫面會停在舊的勾選狀態，跟真正的設定不一致（實測：取消勾選後
      // `設定.on=false` 但 checkbox 仍顯示打勾；第一次之所以看起來正常，
      // 只是剛好有別的原因讓它重繪了）。
      var apOnState = React.useState(function () {
        return !!(core && core.readConfig && core.readConfig().autoApprove
          && core.readConfig().autoApprove[active]
          && core.readConfig().autoApprove[active].on === true);
      });
      var autoApproveOn = apOnState[0];
      var setAutoApproveOn = apOnState[1];
      // 切換主題時要把開關切到那個主題的設定（同一個元件、不同的主題）。
      React.useEffect(function () {
        var cfgAp = (core && core.readConfig && core.readConfig().autoApprove) || {};
        var want = !!(cfgAp[active] && cfgAp[active].on === true);
        setAutoApproveOn(function (prev) { return prev === want ? prev : want; });
      }, [active]);

      var approveBusyRef = React.useRef(false);
      var approveIdRef = React.useRef('');

      /**
       * 待送出的自動批準（延遲期間的狀態）。
       *
       * 需求：「自動回覆，延遲 5s，有倒計時效果，中途可以取消」
       * → 「6s too short, 10s」。秒數由 `AUTO_APPROVE_DELAY_SEC` 決定。
       *
       * 形狀：`{ topic, id, text, deadline }` 或 `null`。
       *   * `topic`：要回覆到哪個主題（**送出時會再確認它還是當前主題**）；
       *   * `id`：觸發訊息的 id（送成功後記進「已回過」清單）；
       *   * `text`：要送出的內容（先算好，倒數期間不必再判定一次）；
       *   * `deadline`：送到哪個時間點（`Date.now()` 毫秒）。
       *
       * ⚠️ 用**截止時間**而不是「每秒 -1 的計數器」：
       * 計數器版本要等第一個 interval 才顯示，所以畫面慢一秒，
       * 總延遲會比標稱多一秒（實測：標稱 5 秒時量到 6 秒，而且畫面 1.5 秒後
       * 才顯示 4s）。截止時間版本在**排程的當下**就能算出剩幾秒，畫面立刻正確。
       *
       * 為什麼要讓使用者能取消：這是**代替使用者發言**的功能，
       * 而且 ntfy 沒有「撤回」—— 送出去就收不回來。
       * 這幾秒的窗口讓人來得及在看到內容不對時喊停（例如那句話其實是在討論、
       * 不是在請求核准）。「來不及取消」比「多等幾秒」嚴重得多。
       */
      var approvePendingState = React.useState(null);
      var approvePending = approvePendingState[0];
      var setApprovePending = approvePendingState[1];

      /** 取消待送出的自動批準。 */
      function cancelApprove() {
        setApprovePending(null);
      }

      // 判定：有新訊息符合條件就**排程**（不是立刻送出）。
      React.useEffect(function () {
        if (!active || !autoApproveOn) return;
        if (approveBusyRef.current) return;
        if (approvePending) return;      // 已經有一個在倒數，不重複排隊
        if (!core || typeof core.autoApproveDecision !== 'function') return;
        var list = (snapshot.messagesByTopic && snapshot.messagesByTopic[active]) || [];
        if (!list.length) return;
        // 只檢查最新那一則。為什麼不看整串：這個 effect 會在每次 store 變更時
        // 跑，整串掃描等於每則訊息都被判定 N 次；而新訊息一定是加在尾端。
        var last = list[list.length - 1];
        var id = text(last.id);
        if (id === '' || id === approveIdRef.current) return;
        var verdict = core.autoApproveDecision({
          msg: last,
          source: last.source,
          topic: active,
          selfName: identity,
          autoApprove: core.readConfig().autoApprove
        });
        // ⚠️ 這裡**即使沒有觸發也要記下 id**：不然每來一則訊息都會重複判定，
        // 而且下一次的判定會被同一則舊訊息佔住。
        approveIdRef.current = id;
        if (!verdict) return;
        setApprovePending({
          topic: active,
          id: verdict.id,
          text: verdict.reply,
          deadline: Date.now() + AUTO_APPROVE_DELAY_SEC * 1000
        });
      }, [active, activeMessages.length, autoApproveOn, approvePending]);

      // 倒數：依截止時間算出剩幾秒（畫面用），歸零就送出。
      //
      // 每 100ms 檢查一次而不是每 1000ms：這樣起始秒數在排程後立刻出現，
      // 而且不會因為 interval 的相位而多等將近一秒。
      React.useEffect(function () {
        if (!approvePending) return undefined;
        /** 依截止時間重畫（必要時順便送出）。 */
        function tick() {
          var leftMs = approvePending.deadline - Date.now();
          if (leftMs > 0) {
            var sec = Math.ceil(leftMs / 1000);
            setApprovePending(function (cur) {
              if (!cur) return null;
              if (cur.left === sec) return cur;          // 同一秒不重畫
              return {
                topic: cur.topic, id: cur.id, text: cur.text,
                deadline: cur.deadline, left: sec
              };
            });
            return;
          }
          // 歸零 → 送出。**送出前再確認一次這個主題還是當前主題** ——
          // 倒數期間使用者可能已經切走了，那就不該再代替他發言。
          if (approvePending.topic === activeRef.current) {
            approveBusyRef.current = true;
            publishToTopic(approvePending.topic, approvePending.text, {}).then(function (r) {
              approveBusyRef.current = false;
              // 只有**送成功**才記「回過了」：先記再送的話，送失敗就永遠不會重試。
              if (r && r.ok && core && typeof core.markAutoApproveReplied === 'function') {
                core.markAutoApproveReplied(approvePending.topic, approvePending.id);
              }
            });
          }
          setApprovePending(null);
        }
        var timer = setInterval(tick, 100);
        tick();
        return function () { clearInterval(timer); };
      }, [approvePending === null ? '' : approvePending.deadline]);

      // 切換主題 / 關掉開關 → 取消待送出的。這是「保護使用者」的一部分：
      // 他已經不看那個主題了，就不該還替他送出。
      React.useEffect(function () {
        setApprovePending(function (cur) {
          if (!cur) return null;
          if (cur.topic !== active || !autoApproveOn) return null;
          return cur;
        });
      }, [active, autoApproveOn]);

      /** 倒數剩幾秒（畫面用）。 @returns 秒數。 */
      function approveLeftSec() {
        if (!approvePending) return 0;
        if (typeof approvePending.left === 'number') return approvePending.left;
        return Math.max(1, Math.ceil((approvePending.deadline - Date.now()) / 1000));
      }

      /** 切換自動回應。 @param next - 是否開啟。 */
      function toggleAutoApprove(next) {
        if (!core || typeof core.setAutoApprove !== 'function') return;
        var on = next === true;
        // 先更新畫面（state），再寫設定 —— 寫入是同步的，但只改 config
        // 不會讓元件重繪，所以要自己推一下 state。
        setAutoApproveOn(on);
        var entry = core.setAutoApprove(active, on);
        // 讓下一個訊息可以重新被判定（否則剛勾選時會沿用上一輪的 id）。
        approveIdRef.current = '';
        // 這跟其他設定一樣要寫回宿主，否則重新整理就沒了。
        saveSubscriptions();
        return entry;
      }

      // ---- 「永遠滾到最新」開關 ----
      //
      // 需求：勾選後這個主題**永遠**捲到最新（不管訊息是誰發的）。
      // 它會**覆蓋**「只有自己發的才跟隨」那條預設規則。
      //
      // 跟自動回應同一個坑：`saveConfig` 不會觸發 store 通知，
      // 所以開關狀態必須用 React state，讀 config 的普通變數不會重繪。
      var sabState = React.useState(function () {
        return !!(core && core.readConfig && core.readConfig().stayAtBottom
          && core.readConfig().stayAtBottom[active]
          && core.readConfig().stayAtBottom[active].on === true);
      });
      var stayAtBottom = sabState[0];
      var setStayAtBottomState = sabState[1];
      React.useEffect(function () {
        var cfgSab = (core && core.readConfig && core.readConfig().stayAtBottom) || {};
        var want = !!(cfgSab[active] && cfgSab[active].on === true);
        setStayAtBottomState(function (prev) { return prev === want ? prev : want; });
      }, [active]);

      /** 切換「永遠滾到最新」。 @param next - 是否開啟。 */
      function toggleStayAtBottom(next) {
        if (!core || typeof core.setStayAtBottom !== 'function') return;
        var on = next === true;
        setStayAtBottomState(on);
        var entry = core.setStayAtBottom(active, on);
        // 一勾選就立刻捲到底 —— 不然使用者會覺得「勾了但沒反應」。
        if (on && typeof streamJumpToEndRef.current === 'function') streamJumpToEndRef.current();
        // 跟其他設定一樣要寫回宿主，否則重新整理就沒了。
        saveSubscriptions();
        return entry;
      }

      // 抬頭只留「這是什麼群組」：群組名 + 主題數。
      //
      // **不顯示伺服器**（連主機名都不顯示）：伺服器位址由外掛設定決定，
      // 使用者不能改、也不需要知道。而且 title 屬性本身就是一個洩漏點 ——
      // 移除整個區塊才徹底。
      var groupMarkers = (core && typeof core.deriveMarkers === 'function')
        ? core.deriveMarkers(activeMessages)
        : { decisions: [], actions: [], openCount: 0 };
      var header = e('div', { className: 'ntfy-teams-header' },
        e('span', { className: 'ntfy-teams-grouplogo', 'aria-hidden': 'true' }, e(GroupGlyph, { size: 19 })),
        e('div', { className: 'ntfy-teams-headmain' },
          e('h2', { className: 'ntfy-teams-title' }, PANEL_LABEL),
          e('div', { className: 'ntfy-teams-subtitle' },
            e('span', { className: 'ntfy-teams-subitem' },
              topics.length > 0 ? '已訂閱 ' + topics.length + ' 個主題' : '尚未訂閱主題'),
            // 群組狀態：未結的待辦優先顯示（那是要有人動的東西），其次才是決定數。
            groupMarkers.openCount > 0
              ? e('span', { className: 'ntfy-teams-sepdot' }, '·')
              : null,
            groupMarkers.openCount > 0
              ? e('span', {
                className: 'ntfy-teams-subitem ntfy-teams-subitem--todo',
                title: '還有 ' + groupMarkers.openCount + ' 件待辦沒結案'
              }, '待辦 ' + groupMarkers.openCount)
              : null,
            groupMarkers.decisions.length > 0
              ? e('span', { className: 'ntfy-teams-sepdot' }, '·')
              : null,
            groupMarkers.decisions.length > 0
              ? e('span', {
                className: 'ntfy-teams-subitem',
                title: '這個群組已經有 ' + groupMarkers.decisions.length + ' 個決定'
              }, '決定 ' + groupMarkers.decisions.length)
              : null
          )
        ),
        e('span', { className: 'ntfy-teams-spacer' }),
        active ? e(StatusChip, { topic: active, status: activeStatus }) : null,
        // 共用設定的一行摘要（認證狀態 · 以 #name 傳送 · 全部主題共用 · 編輯）
        // 就放在抬頭裡 —— 需求：「以上各種提示都應該放到第一個容器內」。
        // 它只讀不寫；編輯表單仍由 MainPanel 掛在 body（展開時才出現）。
        e(SettingsSummary, {
          key: 'summary',
          // 齒輪是**切換**：沒開就開、開著就收。
          // 表單裡那顆「收合」按鈕已移除（需求），所以收起只能靠這裡 ——
          // 而且它就在同一個位置，切換比「展開用一顆、收起用另一顆」直覺。
          open: showConn || authRequired,
          onEdit: function () { setShowConn(function (v) { return !v; }); }
        }),
        // 抬頭的動作區只留「重新載入」。
        //
        // 為什麼拿掉那顆「共用設定」圖示按鈕：它跟摘要裡的「編輯」**做的是同一件事**
        // （都只是把共用設定展開／收合），而收合又有表單裡的「收合」——
        // 三個入口做兩件事。留文字按鈕就好：語意清楚、也吃得到主題令牌。
        //
        // 另外那個圖示畫的是一個圓加八條放射線（看起來像太陽），本來就不像設定，
        // 拿掉之後也不會再有人誤解它代表「設定」。
        e('div', { className: 'ntfy-teams-headeracts' },
          e('button', {
            type: 'button',
            className: 'ntfy-teams-iconbtn',
            title: '重新載入歷史並重連',
            'aria-label': '重新載入歷史並重連',
            onClick: refresh
          }, e(RefreshGlyph))
        )
      );

      var hint = null;
      if (authRequired) hint = '此主題需要認證，請在共用設定裡輸入帳號與密碼';
      else if (activeFailure) hint = '讀取失敗：' + activeFailure;

      // 這裡只收「左欄的東西」。抬頭**不放在這裡** —— 它要滿寬、獨立排在 root
      // 的第一個子節點（見下面的 return）。
      //
      // ⚠️ 踩過的坑：原本這裡是 `body.push(header)`，於是 header 同時是
      // 「body[0]」與「root 的第一個子節點」。因為 leftChildren = body.slice()
      // 會把它一起複製進左欄，畫面上就出現**兩份抬頭**（實測：左欄第一個子節點
      // 是 [280,64 860x64] 的 header，重複一份）。
      // 抬頭只能存在於一個地方。
      var body = [];

      // 共用設定的**編輯表單**（展開時才出現；收合時它回 null）。
      // 那一行摘要在抬頭裡（SettingsSummary）—— 兩者共用同一份資料來源。
      // 帳號只有一份，所以這裡不會隨主題數量變多而重複。
      //
      // open 由這裡（MainPanel）持有，因為抬頭那顆鉛筆是唯一的切換入口 ——
      // 表單裡原本的「收合」按鈕已經移除，收起也走同一顆鉛筆。
      body.push(e(SettingsPanel, {
        key: 'settings',
        open: showConn || authRequired,
        hint: hint,
        // 存檔後由表單自己收合：通知外面把展開狀態收掉
        // （不然摘要與表單會不同步）。
        onRequestClose: function () { setShowConn(false); },
        onSaved: function (next, storedName) {
          setServer(next);
          setIdentity(storedName || currentIdentity());
          setNonce(function (n) { return n + 1; });
        }
      }));

      if (activeFailure && !authRequired) {
        body.push(e('div', { key: 'fail', className: 'ntfy-teams-hint ntfy-teams-hint--err', style: { padding: '8px 18px 0' } }, hint));
      }
      body.push(e(TopicBar, {
        key: 'topics',
        snapshot: snapshot,
        // 在 store 把未讀歸零之前，先把「這個主題有多少未讀、上次讀到哪」記下來。
        // 這是唯一拿得到未讀數的時機（見 TopicBar.select 的說明）。
        onWillActivate: function (topic) {
          var unread = (snapshot.unreadByTopic && snapshot.unreadByTopic[topic]) || 0;
          var lastRead = (snapshot.lastReadIdByTopic && snapshot.lastReadIdByTopic[topic]) || '';
          pendingUnreadRef.current[topic] = { count: unread, lastReadId: lastRead };
        }
      }));
      // 訊息串與右側看板並排：看板可以拖寬，寬度會記住。
      var listProps = {
        key: 'list:' + active,
        topic: active,
        messages: activeMessages,
        loading: loading,
        selfName: identity,
        // 未讀邊界要用「打開的那一刻」的值（見上面 pendingUnreadRef 的說明）。
        unread: pendingForActive.count,
        // ⚠️ 「N 則新訊息」提示條要用**即時的**未讀數，不能用上面那個黏住的快照。
        //
        // 為什麼不能共用：`pendingForActive.count` 是為了畫未讀線而**黏在開啟那一刻**
        // 的值（見上面那段說明），它刻意不跟著 store 變動。但提示條要反映「現在還有
        // 幾則新訊息」，store 才是真相；共用會出現「store 說有 2 則未讀、提示條卻不顯示」
        // （實測就是這個：storeUnread 2，pill 卻因為 count=0 而不畫）。
        unreadLive: unreadOfActive,
        lastReadId: pendingForActive.lastReadId,
        // 「永遠滾到最新」開關：打開時訊息串無條件跟隨（見 MessageList 的說明）。
        stayAtBottom: stayAtBottom,
        // 某一天抬頭上的問號：把那天整理成復盤材料，交給宿主建立一個帶著它的工作階段。
        onDayReview: function (day) {
          var topic = active;
          var p = reviewDay(topic, day, identity);
          if (p && typeof p.then === 'function') {
            p.then(function (r) {
              if (r && r.ok === false && r.error) {
                setFailures(function (prev) {
                  var next = {};
                  for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
                  next[topic] = r.error;
                  return next;
                });
              }
            }, function (err) {
              setFailures(function (prev) {
                var next = {};
                for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
                next[topic] = '日復盤失敗：' + text(err && err.message);
                return next;
              });
            });
          }
        },
        // 決定／待辦／結案：發一則帶原生 tag 的訊息，全群可見。
        onMark: function (msg, kind) {
          markMessage(active, msg, kind, identity, cred, function (err) {
            if (err) setFailures(function (prev) {
              var next = {};
              for (var k in prev) if (Object.prototype.hasOwnProperty.call(prev, k)) next[k] = prev[k];
              next[active] = err;
              return next;
            });
          });
        },
        onSeen: function (topic) {
          if (core && core.store && typeof core.store.markReadToLatest === 'function') {
            core.store.markReadToLatest(topic);
          }
          saveSubscriptions();
        }
      };
      // 主欄（訊息串 + 撰寫區）與右欄（看板）並排；看板因此直通到底。
      var mainChildren = [e(MessageList, listProps)];
      if (active) {
        mainChildren.push(e(Composer, {
          key: 'compose',
          topic: active,
          cred: cred,
          canPublish: canPublish,
          identity: identity,
          // 自動回應開關（見上面 autoApproveOn 的說明）。
          autoApproveOn: autoApproveOn,
          onToggleAutoApprove: toggleAutoApprove,
          // 倒數中：顯示剩幾秒 + 取消鈕（見 approvePending 的說明）。
          approvePending: approvePending,
          approveLeftSec: approveLeftSec(),
          onCancelAutoApprove: cancelApprove,
          // 「永遠滾到最新」開關。
          stayAtBottom: stayAtBottom,
          onToggleStayAtBottom: toggleStayAtBottom
        }));
      }
      // 版面：抬头（滿寬）在上，底下才是「主欄 ｜ 看板」。
      //
      //    root（column）
      //      ├─ header（滿寬：標題／連線狀態／重新載入／齒輪）
      //      └─ row（橫向）
      //           ├─ leftcol  = 共用設定 + 主題列 + 訊息串 + 撰寫區
      //           └─ 看板     = 與 leftcol 同高（所以「直通到底」）
      //
      // 看板**不**從面板頂端開始是刻意的：抬頭那一列右側放著連線狀態
      // （未連線／已連線／重試中等），看板頂上去會把它蓋住。
      // 看板的上緣就從抬頭的下緣開始，往下直通到面板底部。
      //
      // 為什麼要 leftcol 這一層：共用設定那一列靠右的「全部主題共用／編輯」
      // 原本會頂到看板；把它跟主題列一起收進左欄，它就會自動往左讓開。
      var leftChildren = body.slice();
      leftChildren.push(e('div', { key: 'mainrow', className: 'ntfy-teams-mainrow' },
        e('div', { key: 'maincol', className: 'ntfy-teams-main' }, mainChildren)));

      return e('div', { className: 'ntfy-teams-root' },
        header,
        e('div', { key: 'row', className: 'ntfy-teams-row' },
          e('div', { key: 'leftcol', className: 'ntfy-teams-leftcol' }, leftChildren),
          e(DashboardPanel, {
            key: 'dash',
            width: dashWidth,
            // 看板示範資料的種子：跟著「當前主題 + 面板開關」變 —— 切主題或重開面板
            // 就會換一輪數字（看起來是活的），但不會自己定時跳動。
            seed: dashSeed,
            topics: topics,
            onResize: function (w) { setDashWidth(w); },
            onResizeEnd: function (w) {
              if (core && typeof core.saveConfig === 'function') {
                try { core.saveConfig({ dashboardWidth: w }); } catch (err) { /* 存不進去就算了 */ }
              }
            }
          })
        )
      );
    }

    /**
     * 「團隊協同」面板現在是不是真的顯示在使用者眼前。
     *
     * host 會在用不到的時候把整個面板從 DOM 移除（切到別的頁面時），所以
     * **直接查 DOM 有沒有面板的根節點**就是最可靠的「有沒有在看」訊號：
     * 不用維護一個會被多個實例互相蓋掉的模組層旗標（實測踩過：旗標被別的
     * 實例設成 false，未讀語意就跟著錯）。
     *
     * store 裡的 activeTopic 只記「選了哪個主題」，面板關掉之後它仍然留著 ——
     * 單看它會把「其實沒在看」誤判成「正在看」，於是未讀永遠不累加、角標永遠不動。
     *
     * @returns 面板是否顯示中。
     */
    function panelIsVisible() {
      try {
        if (typeof document === 'undefined' || !document.querySelector) return false;
        return !!document.querySelector('.ntfy-teams-root');
      } catch (err) {
        return false;
      }
    }

    /**
     * 使用者是不是**貼在訊息串底部**（正在看最新訊息）。
     *
     * 這是「要不要自動跟隨」的第二層條件，跟 `panelIsVisible` 一樣用 DOM 查詢 ——
     * 只有**正在顯示的那一個**面板實例的捲動位置才算數，所以不能存在模組層旗標
     * （多個實例會互相蓋掉，這裡以前踩過）。
     *
     * 預設回 false：查不到就當成「沒在看最新」，寧可多一個未讀提示，
     * 也不要漏掉別人的訊息。
     *
     * @returns 是否貼著底部。
     */
    function panelIsFollowing() {
      try {
        if (typeof document === 'undefined' || !document.querySelector) return false;
        var box = document.querySelector('.ntfy-teams-stream');
        if (!box) return false;
        return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      } catch (err) {
        return false;
      }
    }

    /**
     * 面板殼：core 不可用时给出可读的说明，而不是把整个座位炸掉。
     * @returns 面板元素。
     */
    function PanelEntry() {
      if (!core || typeof core.store !== 'object' || core.store === null) {
        return e('div', { className: 'ntfy-teams-root' },
          e('div', { className: 'ntfy-teams-header' },
            e('span', { className: 'ntfy-teams-glyph' }, e(BellGlyph, { size: 17 })),
            e('h2', { className: 'ntfy-teams-title' }, PANEL_LABEL)
          ),
          e('div', { className: 'ntfy-teams-empty' },
            e('span', null, '核心模組未載入'),
            e('span', null, 'lib/core.js 沒有在 lib/client.js 之前執行。')
          )
        );
      }
      return e(MainPanel);
    }

    /**
     * 清掉舊版殘留在瀏覽器裡的 key（**一次性**）。
     *
     * 之前這個外掛把設定、憑證、訊息快取都存在 localStorage，於是使用者的
     * DevTools 裡會看到一堆 `ntfy-teams:*`：
     *
     *   * `ntfy-teams:config:v1`  —— 舊的設定（伺服器／主題／身分／別名）
     *   * `ntfy-teams:store:v1`   —— 舊的訊息快取（未讀與已載入訊息）
     *   * `ntfy-teams:cred:<server>` —— 舊的憑證
     *
     * 現在的程式碼**不讀也不寫**它們，但舊版留下的那些 key 還會躺在瀏覽器裡，
     * 看起來就像「這個外掛還在用 localStorage」，而且一旦哪天有人不小心讀到
     * 就會變成第二份真相（那正是之前一堆「刪掉又出現」的來源）。
     *
     * 所以這裡主動把它們刪乾淨。這是本外掛唯一會碰 localStorage 的地方，
     * 而且只做 `removeItem` —— 不讀內容、不寫任何東西。
     *
     * @returns 清掉了幾個 key。
     */
    function purgeLegacyStorage() {
      var removed = 0;
      try {
        if (typeof localStorage === 'undefined' || !localStorage) return 0;
        if (typeof localStorage.key !== 'function' || typeof localStorage.removeItem !== 'function') return 0;
        var doomed = [];
        // 先收集再刪：邊走訪邊刪會讓索引位移，漏掉後面的 key。
        for (var i = 0; i < localStorage.length; i += 1) {
          var k = localStorage.key(i);
          if (typeof k === 'string' && k.indexOf('ntfy-teams') === 0) doomed.push(k);
        }
        for (var j = 0; j < doomed.length; j += 1) {
          try { localStorage.removeItem(doomed[j]); removed += 1; } catch (err) { /* 個別失敗不影響其他 */ }
        }
      } catch (err) {
        // 隱私模式／被停用／配額問題都不該影響外掛運作。
        return removed;
      }
      return removed;
    }

    /**
     * 把訂閱清單從 config 還原進 store（可重複呼叫，第二次之後沒有效果）。
     *
     * host 與面板都會呼叫：host 那一邊先跑（面板可能永遠不會被打開），
     * 面板掛載時再保險一次。重複呼叫是安全的 —— ensureTopic 對已存在的主題
     * 不會有動作，所以不會把清單弄成兩份。
     *
     * 這裡**只加不減**是刻意的：開機時 store 還是空的，沒有東西可以減。
     * 「減」由 syncSettingsFromHost() 完成後的那段負責（讓 store 等於宿主的清單）。
     */
    function bootStore() {
      if (!core || !core.store) return;
      var cfg = typeof core.readConfig === 'function' ? core.readConfig() : null;
      var seeds = cfg && Array.isArray(cfg.topics) ? cfg.topics : [];
      for (var i = 0; i < seeds.length; i += 1) {
        if (typeof core.store.ensureTopic === 'function') core.store.ensureTopic(seeds[i]);
      }
    }

    /**
     * 第一次使用時播種一個預設主題（`pub_dsh`，顯示名稱 AIFE）。
     *
     * 「只做一次」很重要：用一個獨立的記號記住「已經播種過」，而不是看
     * 「主題清單是不是空的」—— 後者會讓使用者把預設主題刪掉之後又被塞回來
     * （同一類 bug 我們在一次性遷移那裡踩過一次）。
     *
     * @returns 是否真的播種了。
     */
    /**
     * 加入預設主題（`pub_dsh`，顯示名稱 AIFE）—— **一輩子只加一次**。
     *
     * ⚠️ 這是「為什麼刪掉又重新整理又出現」的第三次修正，前兩次都錯在同一個地方：
     * **用「清單裡有沒有它」當判斷**。那個判斷分不出兩件完全不同的事：
     *
     *   a. 從來沒加過（全新使用者）→ 該加
     *   b. 使用者把它刪掉了        → **絕對不該再加回來**
     *
     * 用 a 的判斷去處理 b，就是「刪掉又出現」。所以改成看一個**明確的記號**
     * `defaultTopicAdded`（存在設定裡）：只有從未加過才加，加過就永遠不再介入。
     *
     * 記號是「加過一次」而不是「使用者不想要」—— 所以升級上來、還沒有記號的
     * 既有使用者仍然會拿到一次預設主題（見下方呼叫端的移轉邏輯），
     * 但之後他們若刪掉，就不會再回來。
     *
     * @returns 這次是否真的加上了。
     */
    function ensureDefaultTopic() {
      if (!core || !core.store) return false;
      var name = text(core.DEFAULT_TOPIC);
      if (name === '') return false;
      if (typeof core.readConfig !== 'function' || typeof core.saveConfig !== 'function') return false;

      var cfg;
      try { cfg = core.readConfig(); } catch (err) { return false; }
      // 已經加過一次 → 不再介入。使用者刪掉就是刪掉。
      if (cfg && cfg.defaultTopicAdded === true) return false;

      var existing = core.store.getSnapshot().topics || [];
      var alreadyThere = existing.indexOf(name) !== -1;
      var didAdd = false;
      if (!alreadyThere && typeof core.store.ensureTopic === 'function') {
        core.store.ensureTopic(name);
        didAdd = true;
        // 永遠排第一個：它是共用錨點，位置不該取決於「什麼時候被加進來」。
        if (typeof core.store.pinTopicFirst === 'function') core.store.pinTopicFirst(name);
        // 不要搶走使用者的當前主題：只有在沒有聚焦任何主題時才切過去。
        if (!core.store.getSnapshot().activeTopic && typeof core.store.setActiveTopic === 'function') {
          core.store.setActiveTopic(name);
        }
        var alias = text(core.DEFAULT_TOPIC_ALIAS);
        // 只在真的訂閱了之後才設別名 —— 否則會留下一個指向不存在主題的孤兒別名
        // （實測踩過：config.yml 裡出現一個不存在的 topic 的 alias）。
        if (alias !== '' && typeof core.setTopicAlias === 'function') {
          try { core.setTopicAlias(name, alias); } catch (err) { /* 別名失敗不影響訂閱 */ }
        }
      }
      // **無論這次有沒有真的加，都要立記號** —— 這樣「已經有主題的老使用者」
      // 只會被檢查一次；之後他刪掉任何東西都不會再被塞回來。
      try { core.saveConfig({ defaultTopicAdded: true }); } catch (err) { /* 記不住就下次再說 */ }
      return didAdd;
    }

    /**
     * 即時同步的「重新檢查」入口（由 startLiveSync 註冊）。
     *
     * 為什麼需要它：`startLiveSync` 是**靠 store 變更**去比對訂閱指紋的，
     * 而「改認證方式／帳密」只動了憑證快取，**不會**觸發 store 變更 ——
     * 於是連線不會重建，畫面就一直掛著上一條連線的 403／401。
     * 設定面板存檔後呼叫 `recheckConnection()`，就會強制比一次指紋並重連。
     *
     * 模組層（不是 state）：面板與 host 可能各有元件實例，但即時連線只有一條。
     *
     * @type {?function():boolean}
     */
    var liveSyncRecheck = null;

    /**
     * 請即時連線重比一次指紋（憑證變了就會重建連線）。
     * @returns 是否真的重建了。
     */
    function recheckConnection() {
      if (typeof liveSyncRecheck !== 'function') return false;
      try {
        return liveSyncRecheck() === true;
      } catch (err) {
        return false;
      }
    }

    /**
     * 開始即時同步：每兩個主題一條 SSE，**活在 host 這一層，不隨面板被卸載**。
     *
     * 為什麼一定要搬出來：面板是由 host 的 `main` 座位提供的，切到別的頁面時
     * host 會把整個面板從 DOM 移除（實測：切走之後 `.ntfy-teams-root` 不存在）。
     * 原本 SSE 是掛在面板的 effect 裡，於是：
     *   * 面板沒打開就**完全收不到訊息**；
     *   * 側欄那個未讀角標**永遠不會動** —— 而角標存在的意義正是「沒打開也知道」。
     * 搬到 host 之後，不管面板開不開，訊息都會進 store、角標都會即時更新。
     *
     * @returns 停止同步的 disposer。
     */
    function startLiveSync() {
      if (!core || !core.store) return function () {};
      // 先訂閱 store，再 bootStore()：還原出來的訂閱清單才會經過 onStoreChange
      // 把目前的組合記下來（順序顛倒的話 currentKey 會是空的，少一次重連）。
      var current = [];
      var currentKey = null;
      var stopped = false;
      var unsubStore = null;

      /** 憑證每次都重新讀 —— 使用者可能在設定裡改過。 */
      function credOf() {
        if (typeof core.loadCredentials !== 'function') return { mode: 'none', user: '', password: '', token: '' };
        return core.loadCredentials(typeof core.readConfig === 'function' ? core.readConfig().server : '');
      }

      /** 現在的訂閱組合是否與已建立的一致（不一致才重建，避免每次 emit 都重連）。 */
      function syncKey() {
        var snap = core.store.getSnapshot();
        var server = typeof core.readConfig === 'function' ? core.readConfig().server : '';
        // 憑證也要算進去。
        //
        // 為什麼：`resubscribe()` 用的是「當下」的憑證，但這裡原本只看
        // 伺服器＋主題清單 —— 於是**改了認證方式或帳密之後，指紋沒變，
        // 連線不會重建**，畫面就一直掛著上一次的 403／401。
        // 使用者看到的是「改了認證、存了，但錯誤還在」，於是以為沒生效。
        return server + '\u0001' + (snap.topics || []).join('\u0000') + '\u0001' + credKey();
      }

      /**
       * 憑證的**指紋**（只取足以判斷「有沒有變」的欄位）。
       *
       * 刻意不回傳明碼：這個字串會進 currentKey，錯誤訊息或 log 若不小心帶到
       * 就會漏出密碼。長度就足夠判斷有沒有換過。
       *
       * @returns 指紋字串。
       */
      function credKey() {
        var c = credOf();
        return [c.mode || 'none', c.user || '', (c.password || '').length, (c.token || '').length].join('\u0002');
      }

      /**
       * 重連之前把「上一條連線留下的錯誤」清掉。
       *
       * 不清的話，使用者改完認證、連線也確實重建了，畫面上卻還是舊的
       * 「HTTP 403 需要認證」—— 看起來像認證沒生效（實際上是殘影）。
       *
       * 兩份都要清：
       *   * store.statusByTopic —— 主題列的狀態（側欄／抬頭都讀它）
       *   * 面板自己的 failures  —— 歷史抓取失敗的記錄
       */
      function clearStaleErrors() {
        if (core && core.store && typeof core.store.clearStatuses === 'function') {
          try { core.store.clearStatuses(); } catch (err) { /* 清不掉不影響重連 */ }
        }
        if (typeof setFailures === 'function') setFailures({});
      }

      /** 關掉目前的即時連線（含待重試的 timer）。 */
      function disposeConn() {
        for (var i = 0; i < current.length; i += 1) {
          if (typeof current[i] === 'function') current[i]();   // dispose
          else if (current[i] && typeof current[i].close === 'function') current[i].close();
        }
        current = [];
      }

      /**
       * 重建即時連線 —— **一條 SSE 訂閱所有主題**（不是每個主題一條）。
       *
       * 為什麼要合併：同一台伺服器上 N 個主題就是 N 條常駐連線。ntfy 支援
       * `/a,b,c/sse`（實測本伺服器可用），開頭 `open` 事件的 topic 是整串清單，
       * 之後每則訊息的 `topic` 是它自己所屬的單一主題，所以能按主題分發。
       *
       * 三個好處：
       *   1. 限流消耗從 N 降到 1（額度實測只有約 6 次／短窗口，這很關鍵）；
       *   2. 少 N-1 條長連線與 N-1 份重試狀態；
       *   3. 主題之間的訊息**共用一個到達順序**，不會因為不同連線而交錯亂序。
       *
       * 認證是整條連線的事：ntfy 只要有一個主題沒權限就整個請求回 403，
       * 不會只擋那一個 —— 所以錯誤要記在**所有**訂閱中的主題上。
       */
      function resubscribe() {
        disposeConn();
        // 重建連線＝進入全新的連線狀態，先把上一條留下的錯誤清掉。
        // 否則「改了認證 → 連線重建 → 畫面還是舊的 403」。
        clearStaleErrors();
        if (stopped) return;
        if (typeof core.subscribeTopics !== 'function') return;
        var cfg = typeof core.readConfig === 'function' ? core.readConfig() : null;
        var server = cfg ? cfg.server : '';
        var topics = core.store.getSnapshot().topics || [];
        if (!server || topics.length === 0) return;

        var connect = function () {
          if (stopped) return;
          var attempt = 0;
          var timer = null;
          var cancelled = false;
          /** 目前是否正在等待重試 —— 用來忽略連線層收尾時送出的 `closed`。 */
          var retryPending = false;

          /** 關掉連線與待重試的 timer。 */
          function dispose() {
            cancelled = true;
            if (timer !== null) { clearTimeout(timer); timer = null; }
            if (handle && typeof handle.close === 'function') handle.close();
            handle = null;
          }

          var handle = null;

          /** 建立（或重建）連線。 */
          function open() {
            if (cancelled) return;
            handle = core.subscribeTopics(server, topics, {
              cred: credOf(),
              // 分發：每則訊息都帶自己的 topic，直接照它送到對應的主題。
              onMessage: function (msg, which) {
                if (!core.store || typeof core.store.addMessage !== 'function') return;
                var target = which || (topics.length === 1 ? topics[0] : '');
                if (!target) return;
                core.store.addMessage(target, msg);
              },
              onStatus: function (status) {
                if (!core.store || typeof core.store.setStatus !== 'function') return;
                var phase = status && status.phase ? status.phase : '';
                // 連線層報錯之後會**立刻**再送一次 `closed`（core 的 finish() 是
                // 「先 emitError 再 emitClosed」），那會把剛才的錯誤蓋成單純的斷線
                // —— 使用者只看得到「未連線」，看不出真正原因是 429。
                if (phase === 'closed' && retryPending) return;
                if (phase === 'open') retryPending = false;   // 連上了，重試狀態結束
                // 連線真的開起來了 → 把「需要認證」清掉。
                //
                // 這個旗標只會被 403 設成 true，沒有任何人設回 false，
                // 所以使用者補上帳密、連線也成功了，提示卻還掛著
                // （回報的「保存生效了，它還在顯示上一次的錯誤」）。
                // 連線能開＝認證沒問題，這裡是清掉它最直接的時機。
                if (phase === 'open' && core.store
                  && typeof core.store.setAuthRequired === 'function') {
                  for (var ai = 0; ai < topics.length; ai += 1) {
                    core.store.setAuthRequired(topics[ai], false);
                  }
                }
                // open／close 是整條連線的階段，要記在每個主題上；
                // live 只發生在真的有訊息進來的那個主題。
                if (phase === 'live' && status.topic) {
                  core.store.setStatus(status.topic, status);
                  return;
                }
                for (var i = 0; i < topics.length; i += 1) core.store.setStatus(topics[i], status);
              },
              onError: function (info) {
                var status = info ? info.status : 0;
                var plan = backoffFor(status, attempt + 1);
                var wait = plan.retry ? plan.delayMs + Math.floor(Math.random() * 400) : 0;
                if (core.store) {
                  // info 的形狀是 { status, message, authRequired }，跟 describeError
                  // 吃的 { status, error } 不同名，所以要轉一次 —— 直接用 message
                  // 就會把伺服器原始 JSON 顯示給使用者（實測就是那樣）。
                  var detail = humanError({
                    status: status,
                    error: info ? info.message : '',
                    authRequired: !!(info && info.authRequired)
                  });
                  if (plan.retry) detail += '（' + Math.round(plan.delayMs / 1000) + ' 秒後重試）';
                  for (var i = 0; i < topics.length; i += 1) {
                    if (info && info.authRequired && typeof core.store.setAuthRequired === 'function') {
                      core.store.setAuthRequired(topics[i], true);
                    }
                    if (typeof core.store.setStatus === 'function') {
                      core.store.setStatus(topics[i], {
                        phase: 'error',
                        detail: detail,
                        // retryAt 讓側欄知道「這是在重試，不是壞掉」並顯示倒數。
                        retryAt: plan.retry ? Date.now() + wait : 0
                      });
                    }
                  }
                }
                scheduleRetry(plan, wait);
              },
              /**
               * 串流**自己結束**了（不是我們關的）→ 一樣要重連。
               *
               * 為什麼需要這條：自然結束與 AbortError 都不會走 onError，
               * 沒有它的話會停在 `closed` —— 沒有重試、永遠「未連線」。
               * 那正是「為什麼會有閒置狀態」。
               */
              onClosed: function (info) {
                var plan = backoffFor(info && info.status ? info.status : 0, attempt + 1);
                var wait = plan.retry ? plan.delayMs + Math.floor(Math.random() * 400) : 0;
                if (core.store && typeof core.store.setStatus === 'function') {
                  var why = humanError({
                    status: 0,
                    error: (info && info.message) || '連線已中斷'
                  }) + (plan.retry ? '（' + Math.round(plan.delayMs / 1000) + ' 秒後重試）' : '');
                  for (var i = 0; i < topics.length; i += 1) {
                    core.store.setStatus(topics[i], {
                      phase: 'error',
                      detail: why,
                      retryAt: plan.retry ? Date.now() + wait : 0
                    });
                  }
                }
                scheduleRetry(plan, wait);
              }
            });
          }

          /**
           * 排下一次重試（若這個錯誤值得重試）。
           * @param plan - backoffFor 的結果。
           * @param wait - 實際等待毫秒（已含抖動）。
           */
          function scheduleRetry(plan, wait) {
            if (!plan.retry || cancelled) return;
            attempt += 1;
            retryPending = true;
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(function () {
              timer = null;
              open();
            }, wait);
          }

          open();
          return dispose;
        };

        current.push(connect());
      }

      /** 設定或訂閱清單一變就重建連線。 */
      function onStoreChange() {
        var key = syncKey();
        if (key === currentKey) return;
        currentKey = key;
        resubscribe();
      }

      /**
       * 重比一次指紋；憑證變了就重建連線。
       *
       * 給「設定面板存檔」用：改認證只動憑證快取、不會觸發 store 變更，
       * 所以光靠 onStoreChange 那條路永遠不會重連（實測：改了認證方式、存了，
       * 畫面還是上一條連線的 403）。
       *
       * @returns 是否真的重建了。
       */
      function recheck() {
        var key = syncKey();
        if (key === currentKey) return false;
        currentKey = key;
        resubscribe();
        return true;
      }

      // 註冊給設定面板用（模組層只留一個）。
      liveSyncRecheck = recheck;

      // 訂閱清單改變 → 重連；同時把狀態寫進 localStorage。
      // 面板沒開的時候沒有人幫忙落盤，未讀數量就會只留在記憶體裡。
      var lastPersistKey = '';
      // 上一次同步給宿主的「伺服器＋主題清單」指紋。
      // 用它判斷「訂閱清單有沒有變」——不靠使用者動作路徑（見下方說明）。
      var lastHostTopicsKey = '';
      unsubStore = core.store.subscribe(function () {
        onStoreChange();
        var snap = core.store.getSnapshot();
        var topics = snap.topics || [];

        // ---- 訂閱清單（設定）→ 宿主 YAML ----
        //
        // 這裡刻意**不依賴使用者動作路徑**（例如 saveSubscriptions 被按鈕呼叫）。
        // 實測教訓：只靠動作路徑時，任何不經過那條路的變更（還原、遷移、其他程式
        // 路徑）都不會落盤 —— 探針直接呼叫 store 之後，config.yml 的 topics 仍是
        // 空的 `[]`，而畫面上明明訂閱了主題。
        // 改成看「伺服器＋主題清單」的指紋：只要它變了就寫，來源是什麼都不重要。
        var topicsKey = (typeof core.readConfig === 'function' ? core.readConfig().server : '')
          + '\u0001' + topics.join('\u0000');
        if (lastHostTopicsKey !== '' && topicsKey !== lastHostTopicsKey) {
          lastHostTopicsKey = topicsKey;
          // 只寫宿主那一份 —— 持久層就只有它。
          //
          // 首次同步完成前只排隊、不送出 —— 那時 store 可能還沒有宿主的清單，
          // 送出去會把宿主的完整清單覆蓋掉（見 pushSettingsToHost 的說明）。
          requestHostWrite();
        }
        // 未讀數量**不再落盤**：這個外掛不使用 localStorage。
        // 未讀是「這次開啟期間」的狀態，重新整理就重新開始
        // （角標歸零、歷史重抓）。這樣就不會有第二份真相。
      });

      currentKey = syncKey();
      bootStore();
      currentKey = syncKey();
      resubscribe();
      // 記下起點，避免開機那一輪就被當成「使用者改了訂閱清單」而寫一次。
      lastHostTopicsKey = (typeof core.readConfig === 'function' ? core.readConfig().server : '')
        + '\u0001' + (core.store.getSnapshot().topics || []).join('\u0000');

      // 清掉舊版留在瀏覽器裡的 key（只刪、不讀、不寫）。
      // 放在 bootStore() 之後：現在 store 已經從 YAML 起好了，就算舊 key 還在
      // 也已經沒有任何程式碼會讀它們；這裡只是把痕跡清乾淨。
      purgeLegacyStorage();

      // 再問宿主要設定（YAML 是持久層）。
      //
      // 順序刻意如此：先 bootStore() 讓畫面與訂閱立刻能動（YAML 讀不到時也還有
      // 一份可用狀態），宿主那份回來之後再覆蓋，然後重建連線。
      // 反過來（等宿主才 boot）會讓宿主慢或不可用時整個面板發呆。
      syncSettingsFromHost().then(function (result) {
        if (stopped) return;

        // ① 讓 store 的主題**完全等於**宿主那一份（YAML 是持久層的唯一真相）。
        //
        // 為什麼是「等於」而不是「補上」：這裡原本只呼叫 ensureTopic()（只會加），
        // 所以宿主已經刪掉的主題在 store 裡**不會消失**。
        // 實測到的症狀：取消訂閱 → 宿主確實刪了 → 重新載入時 store 從訊息快取
        // 又把舊主題撈回來 → **畫面上「刪掉的又出現了」**。
        // 只加不減＝store 只會單向增長，這正是那個 bug。
        //
        // 順序：先加缺的，再移除多的。
        var hostCfg = null;
        try { hostCfg = core.readConfig(); } catch (err) { hostCfg = null; }
        if (hostCfg && Array.isArray(hostCfg.topics) && core.store) {
          var want = hostCfg.topics.slice();
          // 先加（缺的）
          if (typeof core.store.ensureTopic === 'function') {
            for (var hi = 0; hi < want.length; hi += 1) core.store.ensureTopic(want[hi]);
          }
          // 再減（store 有、宿主沒有的）
          if (typeof core.store.removeTopic === 'function') {
            var have = core.store.getSnapshot().topics || [];
            for (var ri = 0; ri < have.length; ri += 1) {
              if (want.indexOf(have[ri]) === -1) core.store.removeTopic(have[ri]);
            }
          }
        }

        var nextKey = syncKey();
        if (nextKey !== currentKey) {
          currentKey = nextKey;
          resubscribe();
        }
        // ② 訊息不再從瀏覽器快取還原（這個外掛不使用 localStorage）。
        //    取而代之：面板的歷史 effect 會「開啟時重抓」當前主題的歷史。
        // ③ 重新記下指紋，之後的變更才算「使用者改的」。
        lastHostTopicsKey = (typeof core.readConfig === 'function' ? core.readConfig().server : '')
          + '\u0001' + (core.store.getSnapshot().topics || []).join('\u0000');

        // ④ **現在才可以寫回宿主**：store 已經是「宿主的完整清單」了。
        // （在此之前寫入會用不完整的清單覆蓋宿主 —— 見 pushSettingsToHost。）
        initialSyncDone = true;

        if (result && result.ok === false) {
          // 宿主不可用 —— 這時沒有持久層可用，只能留在記憶體並提示。
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[ntfy-teams] 讀取宿主設定失敗：', result.error);
          }
        } else if (result && result.ok === true) {
          // 宿主沒有可用設定（或從未設定過）→ 該考慮播種。
          //
          // ⚠️ 「清單裡有沒有預設主題」**不能**當成「要不要補上」的判斷 ——
          // 它分不出「從來沒加過」與「使用者把它刪掉了」，於是刪掉之後下次載入
          // 又被補回來（就是「刪除 topic，重新打開 UI 又出現了」）。
          // 現在一律交給 ensureDefaultTopic()，它看的是**明確的記號**
          // （`defaultTopicAdded`）：只有從未加過才加，加過就永遠不再介入。
          if (ensureDefaultTopic()) requestHostWrite();
          // 已經有了但不是第一個（例如 YAML 裡存在後面）→ 移回第一位。
          // 「排第一位」不該只靠加入那一刻，載入既有設定也要糾正。
          var now = core.store.getSnapshot().topics || [];
          if (now.indexOf(text(core.DEFAULT_TOPIC)) !== -1
            && now[0] !== text(core.DEFAULT_TOPIC)
            && typeof core.store.pinTopicFirst === 'function') {
            core.store.pinTopicFirst(text(core.DEFAULT_TOPIC));
            requestHostWrite();
          }
        }
        // 首次同步期間被擋下的寫入，現在補送一次（使用者的第一個動作不該白做）。
        // 放在最後：這時 store 已經是「宿主清單 + 使用者剛剛的變更」的完整狀態。
        if (initialSyncPending) {
          initialSyncPending = false;
          saveTopicsToHost();
        }
      });

      // 頁面被卸載時，把排程中還沒送出的設定立刻補送。
      //
      // 沒有這一段的話，「取消訂閱 → 馬上重新整理」會遺失那次刪除
      // （400ms debounce 還沒響就被卸載），使用者看到的就是「刪掉又出現」。
      // pagehide 與 beforeunload 都掛：不同瀏覽器對哪一個可靠實作不一致，
      // 兩個都掛最保險（重複送出安全 —— 內容相同、寫入是整份覆蓋）。
      var onHide = function () { flushHostWriteNow(); };
      try {
        if (typeof window !== 'undefined' && window && typeof window.addEventListener === 'function') {
          window.addEventListener('pagehide', onHide);
          window.addEventListener('beforeunload', onHide);
        }
      } catch (err) { /* 沒有 window 就算了（測試環境） */ }

      return function stop() {
        // 先把待送的設定補送掉，再拆 —— 面板被卸載不代表這批變更可以丟。
        try {
          if (typeof window !== 'undefined' && window && typeof window.removeEventListener === 'function') {
            window.removeEventListener('pagehide', onHide);
            window.removeEventListener('beforeunload', onHide);
          }
        } catch (err) { /* ignore */ }
        stopped = true;
        // 這個也一定要清：它會在 400ms 後讀「當下的」設定並寫回宿主。
        // 少了這一行，拆掉之後才響的 timer 會把一份空掉的設定寫出去
        // （實測：後續測試群組因此讀到被清空的存檔，兩個不相關的測試一起失敗）。
        if (hostSaveTimer !== null) {
          clearTimeout(hostSaveTimer);
          hostSaveTimer = null;
        }
        if (typeof unsubStore === 'function') unsubStore();
        // 拆掉連線（含待重試的 timer）—— 否則停止之後還會冒出新連線，
        // 在測試裡會看到「拆掉之後還在打伺服器」。
        disposeConn();
      };
    }

    // =========================================================================
    // 9. 注册座位
    // =========================================================================

    /** 注入样式表。 @returns 移除样式表的 disposer。 */
    function installStyles() {
      var style = document.createElement('style');
      style.setAttribute('data-plugin', PANEL_ID);
      style.textContent = NTFY_TEAMS_CSS;
      document.head.appendChild(style);
      return function dispose() {
        if (style && style.parentNode) style.parentNode.removeChild(style);
      };
    }

    /**
     * 挂上三个座位。
     * @param ctx - Cordis 上下文（需要 slots，可选 layout）。
     */
    function apply(ctx) {
      // uiWorkspace 只在 apply 拿得到，存起來給面板元件用（開新工作階段）。
      // 用 ctx.get 是因為它對這個外掛是「可選」依賴：沒有它其餘功能照常運作。
      try {
        uiWorkspaceRef = (ctx && typeof ctx.get === 'function') ? (ctx.get('uiWorkspace') || null) : null;
      } catch (err) {
        uiWorkspaceRef = null;
      }
      if (!uiWorkspaceRef && ctx && ctx.uiWorkspace) uiWorkspaceRef = ctx.uiWorkspace;
      // 告訴 store「面板現在可不可見」：未讀要不要累加、角標要不要亮，
      // 取決於使用者是不是真的在看那個面板，而不是「選了哪個主題」。
      if (core && typeof core.store === 'object' && core.store !== null
        && typeof core.store.setViewHooks === 'function') {
        core.store.setViewHooks({
          isPanelVisible: panelIsVisible,
          // 「貼著底部」只有顯示中的那個實例算數 —— 用 DOM 查詢而不是模組旗標。
          isFollowing: panelIsFollowing
        });
      }
      ctx.effect(installStyles, PANEL_ID + ': styles');
      // 即時同步掛在 host 這一層：面板不打开也要收得到訊息，角標才會動。
      ctx.effect(startLiveSync, PANEL_ID + ': live sync');

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 60,
          label: function () { return PANEL_LABEL; }
        }, function (iconProps) {
          var props = iconProps || {};
          return e(SidebarIcon, {
            size: props.size,
            active: props.active,
            onClick: function () {
              if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
                ctx.layout.selectPanel(props.active ? null : PANEL_ID);
              }
            }
          });
        });
      });

      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: PANEL_ID }, function () {
          return e(PanelEntry);
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = {
      formatTime: formatTime,
      formatClock: formatClock,
      formatDay: formatDay,
      decodeTime: decodeTime,
      messageTime: messageTime,
      safeHref: safeHref,
      serverHost: serverHost,
      phaseModifier: phaseModifier,
      badgeText: badgeText,
      totalUnread: totalUnread,
      identityOf: identityOf,
      titleFor: titleFor,
      senderOf: senderOf,
      avatarText: avatarText,
      avatarHue: avatarHue,
      renderMarkdown: renderMarkdown,
      renderInlineNodes: renderInlineNodes,
      installStyles: installStyles,
      saveSubscriptions: saveSubscriptions,

      StatusGlyph: StatusGlyph,
      CSS_TEXT: NTFY_TEAMS_CSS,
      // 讓測試能模擬「首次同步已完成」（那之後才準寫回宿主）。
      markInitialSyncDone: function () { initialSyncDone = true; },
      // 讓測試能驗「舊版 localStorage 痕跡會被清乾淨」。
      purgeLegacyStorage: purgeLegacyStorage,
      // 讓測試能驗「改了認證之後連線會被重建」（即時連線的重新檢查入口）。
      recheckConnection: recheckConnection,
      ensureDefaultTopic: ensureDefaultTopic,
      backoffFor: backoffFor,
      apply: apply,
      PANEL_ID: PANEL_ID,
      PANEL_LABEL: PANEL_LABEL,
      // 下列是面板内部元件：导出只为了让离线测试能用精确的 props 单独驱动它们
      // （整棵树一起渲染时，测试替身的 hook 槽位很难同时满足「互相隔离」与
      //   「保留元件自己的状态」两个要求，实测踩过）。
      TopicBar: TopicBar,
      SettingsPanel: SettingsPanel,
      SettingsSummary: SettingsSummary,
      Composer: Composer,
      // 優先級的**純規則**（給離線測試用）—— 模擬點擊在測試替身裡不可靠，
      // 見 nextPriority 的說明。
      nextPriority: nextPriority,
      priorityTone: priorityTone,
      PRIORITY_OPTIONS: PRIORITY_OPTIONS,
      MessageList: MessageList,
      MessageRow: MessageRow,
      // 「N 則新訊息」提示條（焦點主題收到別人的訊息時浮出）
      UnreadPill: UnreadPill,
      // 看板：示範圖表（測試要能驗結構與「示範」標示）
      DashDemo: DashDemo,
      buildDemoData: buildDemoData,
      // 日期分組：測試要能直接驗「非今天預設折疊」的規則
      dayKeyOf: dayKeyOf,
      isTodayKey: isTodayKey,
      groupByDay: groupByDay
    };

    module.exports = exports;
    return module.exports;
  }
});
