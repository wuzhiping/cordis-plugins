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

  // Node / 测试：require() 直接得到 api。浏览器里 `module` 不存在，这个分支不会跑，
  // 改由 client.js 的 factory 呼叫 moduleRoot() 取得 API。
  //
  // ⚠ build.js 内嵌本档到 client.js 时会**移除下面这一个 block**（含注解与整个 if）：
  //   factory 自己有一个 local `module = { exports: {} }`，内嵌后 `typeof module` 是
  //   'object' 且 `module.exports` 为真值，这个 block 会被执行并在
  //   `module.exports.moduleRoot = …` 抛错，把整个 factory 炸掉。
  //   所以格式请保持不变；若改写它，build.js 会直接报错而不是默默产出坏档。
  if (typeof module !== 'undefined' && module !== null && module.exports) {
    module.exports = buildApi();
    module.exports.moduleRoot = root.moduleRoot;
  }

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
