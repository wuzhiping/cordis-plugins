'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configStore = require('./config-store.js');

// =============================================================================
// 团队协同 · ntfy-teams —— 宿主半边（Host half）
//
// 为什么需要这个文件（而不像以前一样是空壳）：
//
//   ntfy 服务器在公开路径上开了 CORS，所以「读讯息、发讯息」全部在浏览器半边完成，
//   宿主不需要代理。但有一件事浏览器**做不到**：建立一个「已经把讨论内容带进上下文」
//   的新工作阶段。
//
//   浏览器的 `uiWorkspace.startSession()` 回传 void（它只是「开一个新的工作阶段」，
//   不是「建立一个我拿得到 id 的 session」），而且面板会随切换被宿主从 DOM 移除 ——
//   所以客户端既拿不到新 session 的识别，也拿不到它的撰写区。实测：按下去新 session
//   确实开了，但整理好的材料没有任何地方可以落脚。
//
//   能做到「带上下文建 session」的只有宿主端 `agentLoop.createAgent({ seed })`。
//   所以这里开一条 exact 路由让浏览器调用，并由宿主把 seed 写进新 session。
//
// 安全与失败边界：
//   * 只注册一条 exact 路由 `/ntfy-teams/session`（GET 探测、POST 建立），
//     不抢 fallback，因此不会影响 Web 页面本身；
//   * `inject` 里的服务全部是「可选依赖」（用 ctx.get 取），缺任何一个都只让这条
//     功能失效，不会拖垮整个插件的挂载；
//   * 任何失败都回一份带原因的 JSON，客户端会把原因显示给使用者，而不是静默失败。
// =============================================================================

/** 路由前缀；exact 路径，避免和其他插件抢座位。 */
const ROUTE_PATH = '/ntfy-teams/session';

/** 設定與憑證的讀寫路由。 */
const SETTINGS_PATH = '/ntfy-teams/settings';

/** 遮蔽金鑰路由：回一份用 MASK.md 公式算出的 mask key（原文不出宿主）。 */
const MASK_KEY_PATH = '/ntfy-teams/mask-key';

/** 一次最多接受几则讯息进入 seed（防止有人贴一整个频道的历史进来）。 */
const MAX_MESSAGES = 400;

/** 单则内文的长度上限，超出会被截断（附上省略标记）。 */
const MAX_MESSAGE_CHARS = 4000;

/**
 * 把一条注册期的说明送进宿主 log（拿不到 logger 就安静略过）。
 *
 * @param ctx - Cordis 上下文。
 * @param message - 讯息。
 */
function logNote(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.debug === 'function') {
      ctx.logger.debug('ntfy-teams: ' + message);
    }
  } catch (err) { /* log 失败不该影响挂载 */ }
}

/** 默认 ntfy 服务器地址；与 lib/client.js 里的 DEFAULT_SERVER 保持一致。 */
const DEFAULT_SERVER = 'https://msn.feg.cn';

// =============================================================================
// 「恢復設定」用的遮蔽金鑰（mask key）
//
// 需求：認證方式選「帳號密碼」時，多一顆按鈕，用遮蔽過的金鑰去打
//       POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/ntfy
//       body `{ "apiKey": "<mask key>" }`，把伺服器記著的 uid／pwd／name 取回來。
//
// 演算法與 `MASK.md` 一致（那是**遮蔽，不是加密** —— 知道演算法與時間戳的人
// 可以還原）：
//
//     ts     = "@" + ISO 時間戳          // "@2026-10-10T07:39:06.000Z"
//     masked = "sk-" + base64(key + ts)
//
// ⚠️ 原文**永遠不離開宿主**：這條路由只回遮蔽後的値，客戶端拿不到 `FEG_API_KEY`。
//    遮蔽放在宿主還有第二個好處 —— 時間戳在伺服器端算，客戶端不必信任自己的鐘。
//
// 實測（2026-10-10，對 abc.feg.com.tw）：
//     {"apiKey":"sk-"+base64(任意字串)}  → 200 `{}`   ← 格式對
//     {"apiKey":""} / 缺欄位 / 非字串     → 500          ← 格式不對
//     格式對但金鑰不認得                  → **200 `{}`**（不是錯誤碼）
//   所以「200 空物件」必須當成**明確失敗**呈現，否則使用者只會看到「點了沒反應」。
// =============================================================================

/**
 * 拿來遮蔽的金鑰候選參照名（依優先序）。
 *
 * ⚠️ 這份清單是被**實測**逼出來的，不是猜的：
 *
 *   在 `$DSH_HOME/.credentials.yaml`（這台機器真正在用的那份）裡，
 *   參照名是 **`AIFE_API_KEY`** —— 沒有 `FEG_API_KEY`。第一版寫死
 *   `FEG_API_KEY`，於是：
 *     * 宿主回 503「找不到 refs.FEG_API_KEY」；或
 *     * 若剛好讀到別處那份有 `FEG_API_KEY` 的檔案，端點會回 `200 {}`
 *       （格式對、但那把金鑰在伺服器上沒有資料）——
 *       使用者看到的就只是「按了沒反應」。
 *
 *   實測兩邊的差異（遮蔽後打端點）：
 *     `AIFE_API_KEY`     → 200 `{"name":"Jinbe","uid":"…","pwd":"…"}`  ✅
 *     `FEG_API_KEY`      → 200 `{}`                                     ✗
 *
 *   所以按序試，取第一個**存在**的參照。這樣換環境（或以後改名）不必改程式。
 */
const MASK_KEY_REFS = ['AIFE_API_KEY', 'FEG_API_KEY', 'DEEPSEEK_API_KEY'];

/** 遮蔽值的前綴（與 MASK.md 一致）。 */
const MASK_PREFIX = 'sk-';

/**
 * 解析 `$DSH_HOME/.credentials.yaml` 裡的 `refs.<name>`。
 *
 * 為什麼自己寫一個最小 parser 而不引入 YAML 套件：這個檔案由 DSH 自己寫，
 * 形狀固定（`refs:` 底下兩空格縮排的 `名稱: 値`），而本外掛目前零執行期依賴。
 * 只認這一種形狀，認不出來就回 null（上層會回一份帶原因的錯誤）。
 *
 * @param text - 檔案內容。
 * @param name - 參照名，例如 `FEG_API_KEY`。
 * @returns 値；找不到回 null。
 */
function readCredentialRef(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || name === '') return null;
  const lines = text.split(/\r?\n/);
  let inRefs = false;
  let refsIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();

    if (/^refs:\s*$/.test(trimmed)) {
      inRefs = true;
      refsIndent = indent;
      continue;
    }
    if (!inRefs) continue;
    if (indent <= refsIndent) { inRefs = false; continue; }   // refs 區塊結束

    const m = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m || m[1] !== name) continue;
    let value = m[2].trim();
    if (value === '') return null;
    // 去引號（單／雙皆可）。
    if ((value.charAt(0) === '"' && value.charAt(value.length - 1) === '"')
      || (value.charAt(0) === "'" && value.charAt(value.length - 1) === "'")) {
      value = value.slice(1, -1);
    }
    return value === '' ? null : value;
  }
  return null;
}

/**
 * 找出 DSH 憑證檔的路徑。
 *
 * 順序：`DSH_CREDENTIALS_PATH`（測試用覆寫）→ `$DSH_HOME/.credentials.yaml`
 * → `$HOME/.dsh/.credentials.yaml`。找不到任何存在的檔案時回**第一個候選**，
 * 讓呼叫端的錯誤訊息能指出它預期在哪裡。
 *
 * @returns 絕對路徑。
 */
function credentialsFilePath() {
  const override = process.env.DSH_CREDENTIALS_PATH;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const home = process.env.DSH_HOME
    || path.join(os.homedir(), '.dsh');
  return path.join(home, '.credentials.yaml');
}

/**
 * 依 MASK.md 的公式遮蔽一個金鑰。
 *
 * @param key - 原始金鑰（非空字串）。
 * @param now - 產生遮蔽值的時刻（測試可釘住）。
 * @returns `sk-` + base64(key + "@" + ISO)。
 */
function maskKey(key, now) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('maskKey: key 必須是非空字串');
  }
  const stamp = '@' + (now instanceof Date ? now : new Date()).toISOString();
  return MASK_PREFIX + Buffer.from(key + stamp, 'utf8').toString('base64');
}

/**
 * 讀出候選參照中第一個存在的金鑰，並回傳它的遮蔽値。
 *
 * @param options - `{ now }`，測試用。
 * @returns `{ ok, masked, source, ref, error }`；`error` 只在失敗時有値。
 */
function maskedCredential(options) {
  const opts = options || {};
  const file = credentialsFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      ok: false,
      error: '讀不到憑證檔（' + file + '）：' + toText(err && err.message)
    };
  }
  for (let i = 0; i < MASK_KEY_REFS.length; i += 1) {
    const ref = MASK_KEY_REFS[i];
    const key = readCredentialRef(text, ref);
    if (!key) continue;
    try {
      return { ok: true, masked: maskKey(key, opts.now), source: file, ref: ref };
    } catch (err) {
      return { ok: false, error: '遮蔽失敗（' + ref + '）：' + toText(err && err.message) };
    }
  }
  return {
    ok: false,
    error: '憑證檔裡找不到可用的金鑰（試過 ' + MASK_KEY_REFS.join('、') + '）——檔案：' + file
  };
}

/**
 * 设定与凭证的存放目录。
 *
 * 依使用者选择放在**外挂自己的目录旁**（不是工作区），理由是「跟外挂一起走」。
 * 代价是这个目录属于一个 git 仓库，所以：
 *   * 目录里附一份 .gitignore，把 config.yml / secrets.yml 挡在版本控制外；
 *   * config-store 写入时把 secrets.yml 权限收紧到 0600。
 * 用 __dirname 而不是 process.cwd()，这样位置不随「从哪个目录启动」而变。
 *
 * `NTFY_TEAMS_SETTINGS_DIR` 可覆盖 —— 测试靠它把档案写到临时目录（不污染仓库），
 * 也让使用者有办法把设定搬到别处。
 *
 * @returns 实际要用的目录。
 */
function settingsDir() {
  const override = process.env.NTFY_TEAMS_SETTINGS_DIR;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return path.join(__dirname, '..');
}


/**
 * 把任意输入收成字串。
 *
 * @param value - 任意值。
 * @returns 字串；null／undefined 变空字串。
 */
function toText(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * 把内文过长的讯息截断，并留下明确的省略标记。
 *
 * @param value - 原始内文。
 * @returns 截断后的内文。
 */
function clampText(value) {
  const s = toText(value);
  if (s.length <= MAX_MESSAGE_CHARS) return s;
  return s.slice(0, MAX_MESSAGE_CHARS) + ' …（已截斷）';
}

/**
 * 把请求体（可能是字串或已解析物件）解析成物件。
 *
 * @param raw - 原始请求体字串。
 * @returns 物件；解析失败回 null。
 */
function parseBody(raw) {
  const s = toText(raw).trim();
  if (s === '') return {};
  try {
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * 读完整个请求体。
 *
 * @param req - IncomingMessage。
 * @returns Promise<字串>。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      // 上限 2MB：讨论内容再长也不该超过这个量级，超过就直接断掉。
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('請求內容過大'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * 回一份 JSON 回应。
 *
 * @param res - ServerResponse。
 * @param status - HTTP 状态码。
 * @param payload - 要序列化的内容。
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

/**
 * 把客户端整理好的讨论内容组成 seed 事件。
 *
 * 每一则讯息都成为一个 user 角色的讯息 —— 也就是「这些话是使用者带进这个 session
 * 的背景」，而不是「模型说过的话」。这样新 session 一打开就带着完整讨论，
 * 但**不会**自己开始跑一轮（使用者确认后再送出）。
 *
 * @param group - { label, topic, server, messages }。
 * @returns seed 事件阵列。
 */
function buildSeed(group) {
  // 入口先收干：这个函式会被路由和工具两条路调用，输入来自网路，不能假设是物件。
  const input = group && typeof group === 'object' ? group : {};
  const label = toText(input.label) || '這一天';
  const topic = toText(input.topic);
  const server = toText(input.server) || DEFAULT_SERVER;
  const messages = Array.isArray(input.messages) ? input.messages.slice(0, MAX_MESSAGES) : [];

  const lines = [];
  lines.push(`【${label}｜${topic} 的討論】`);
  lines.push(`來源：${server}/${topic}　訊息數：${messages.length}`);
  lines.push('');
  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const who = toText(item.name) || '--';
    const clock = toText(item.clock);
    const text = clampText(item.text);
    lines.push(`- ${who}${clock ? `（${clock}）` : ''}：${text === '' ? '（無內文）' : text}`);
  }

  const now = Date.now();
  const content = [{ type: 'text', text: lines.join('\n') }];

  return [{
    type: 'user/message',
    // seq 必須從 0 開始且連續 —— 宿主自己會驗。實測錯誤訊息：
    // `seed event at index 0 has seq 1 (expected 0); seed must be contiguous from 0`。
    // 離線測試當初只斷言「seq 是數字」，所以沒抓到；真實宿主一試就現形。
    seq: 0,
    time: now,
    data: {
      id: 'ntfy-teams-' + now.toString(36) + '-seed',
      role: 'user',
      content,
      source: { kind: 'user' }
    },
    surfaceOp: 'append'
  }];
}

/**
 * 真正做事的那个操作：建立一个带着讨论内容的新 session。
 *
 * 失败一律以 `{ ok:false, error }` 回传，不抛出去 —— 调用方（路由或工具）负责
 * 决定怎么呈现，错误处理只有这一份。
 *
 * @param services - { agentLoop, ctx }。
 * @param input - { label, topic, server, messages, cwd }。
 * @returns Promise<{ ok, sessionId?, error?, injected? }>。
 */
async function createSeededSession(services, input) {
  const agentLoop = services.agentLoop;
  if (!agentLoop || typeof agentLoop.createAgent !== 'function') {
    return { ok: false, error: 'agentLoop 服務不可用，無法建立工作階段' };
  }

  const safe = input && typeof input === 'object' ? input : {};
  const seed = buildSeed(safe);
  const sessionId = 'ntfy-teams-' + Date.now().toString(36) + '-'
    + Math.random().toString(36).slice(2, 8);

  const meta = {};
  const cwd = toText(safe.cwd);
  if (cwd !== '') meta.cwd = cwd;
  meta.isSeeded = true;

  try {
    const handle = await agentLoop.createAgent(services.ctx, {
      sessionId,
      seed,
      // 宿主要求帶 inheritedEventCount（實測錯誤：`seeded session requires an
      // inherited event count`）。0 是正確的語意：這份 seed 是**帶進來的背景**，
      // 不是從任何父 session 繼承來的历史，所以沒有任何事件是「繼承的」。
      inheritedEventCount: 0,
      meta
    });
    const id = handle && handle.agent ? toText(handle.agent.id) : sessionId;
    return { ok: true, sessionId: id, injected: seed.length };
  } catch (err) {
    return { ok: false, error: '建立工作階段失敗：' + toText(err && err.message) };
  }
}

/**
 * 宿主侧挂载点。
 *
 * @param ctx - Cordis 上下文。
 */
function apply(ctx) {
  // 给本进程留一个可读的默认值，客户端在无法取得配置时会回落到自己的默认值。
  if (typeof globalThis.__ntfyTeamsHostDefaults === 'undefined') {
    globalThis.__ntfyTeamsHostDefaults = { server: DEFAULT_SERVER };
  }

  // 註冊用的訊息收集（不再寫檔）。
  //
  // 這裡原本有一個診斷探針，把實際看到的服務寫到工作區 —— 因為當時「模組沒載入」
  // 與「註冊抛錯」都只表現成一個 404，看不出差別。探針證明了兩件事：
  //   1. `ctx.get('webServer')` 在 apply 當下可能拿到還沒就緒的服務；
  //   2. 改用 `ctx.inject` 之後路由確實註冊成功。
  // 結論已由線上驗證確認（GET /ntfy-teams/session 回 200），探針留著只會
  // 每次載入都寫檔，所以移除；訊息保留給 log 用。
  const notes = [];

  // 關鍵：**不能只靠 apply 當下的 ctx.get 取服務**。
  // 實測會拿到尚未就緒的對象，於是整條路由靜默地沒被註冊 —— 沒有錯誤，只有 404。
  // 正確寫法是 ctx.inject：等服務就緒之後才跑 callback（同 repo 的
  // fdep-api-request/lib/index.js 就是這樣注入 systemPrompt）。
  if (typeof ctx.inject !== 'function') {
    logNote(ctx, 'ctx.inject 不可用 → 無法註冊路由');
    return;
  }

  ctx.inject(['webServer'], (scope) => {
    // 走到這裡代表 webServer 已經就緒。
    const webServer = scope.webServer;
    const getOptional = (name) => {
      try {
        return typeof scope.get === 'function' ? (scope.get(name) || null) : null;
      } catch (err) {
        return null;
      }
    };
    const agentLoop = getOptional('agentLoop');

    logNote(ctx, 'inject(webServer) 就緒：register=' + typeof (webServer && webServer.register));
    logNote(ctx, 'agentLoop=' + (agentLoop ? typeof agentLoop.createAgent : 'null'));

    try {
      webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          // GET：让客户端能探测宿主是否具备这个能力（没有就当降级路径用）。
          if (req.method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              capability: 'ntfy-teams/seed-session',
              hasAgentLoop: !!(agentLoop && typeof agentLoop.createAgent === 'function')
            });
            return;
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '只接受 GET／POST' });
            return;
          }

          let raw;
          try {
            raw = await readBody(req);
          } catch (err) {
            sendJson(res, 400, { ok: false, error: toText(err && err.message) || '讀取請求失敗' });
            return;
          }
          const body = parseBody(raw);
          if (body === null) {
            sendJson(res, 400, { ok: false, error: '請求內容不是合法 JSON' });
            return;
          }

          const result = await createSeededSession({ agentLoop, ctx: scope }, body);
          sendJson(res, result.ok ? 200 : 503, result);
        }
      });
      logNote(ctx, '路由註冊成功: ' + ROUTE_PATH);
    } catch (err) {
      logNote(ctx, '註冊例外: ' + (err && err.message));
      logNote(ctx, 'stack: ' + (err && err.stack ? String(err.stack).split('\n').slice(0, 4).join(' | ') : 'n/a'));
    }

    // 設定與憑證的讀寫路由。
    try {
      webServer.register({
        kind: 'exact',
        path: SETTINGS_PATH,
        handler: async (req, res) => {
          const store = configStore.createStore({ dir: settingsDir() });
          try {
            if (req.method === 'GET') {
              const all = store.readAll();
              if (!all.ok) {
                sendJson(res, 500, { ok: false, error: all.error });
                return;
              }
              // 憑證明文會回給客戶端 —— 這是刻意的：訂閱私有主題就需要它。
              // 界線說明（不迴避）：這個路由只綁在 127.0.0.1，能打到它的對象
              // 與能直接讀 secrets.yml 的對象是同一批，所以不擴大實質暴露面。
              // 但若哪天這個 Web 入口被開到外網，這裡就會變成把密碼送出去的地方
              // —— 那時必須改成不回傳憑證（改用一次性的寫入通道）。
              sendJson(res, 200, {
                ok: true,
                config: all.config,
                secrets: all.secrets,
                configMissing: !!all.configMissing,
                secretsMissing: !!all.secretsMissing
              });
              return;
            }
            // PUT 是正常寫入；**POST 也要接受** —— 頁面被卸載時客戶端用
            // `navigator.sendBeacon` 補送（beacon 只能送 POST），
            // 那是「取消訂閱後馬上重新整理」不會遺失變更的關鍵。
            // 兩者做的事完全相同。
            if (req.method !== 'PUT' && req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: '只接受 GET／PUT／POST' });
              return;
            }

            let raw;
            try {
              raw = await readBody(req);
            } catch (err) {
              sendJson(res, 400, { ok: false, error: toText(err && err.message) || '讀取請求失敗' });
              return;
            }
            const body = parseBody(raw);
            if (body === null) {
              sendJson(res, 400, { ok: false, error: '請求內容不是合法 JSON' });
              return;
            }

            const written = [];
            if (body.config !== undefined) {
              const w = store.writeConfig(body.config);
              if (!w.ok) {
                sendJson(res, 500, { ok: false, error: w.error });
                return;
              }
              written.push('config');
            }
            if (body.secrets !== undefined) {
              const w = store.writeSecrets(body.secrets);
              if (!w.ok) {
                sendJson(res, 500, { ok: false, error: w.error });
                return;
              }
              written.push('secrets');
            }
            if (written.length === 0) {
              sendJson(res, 400, { ok: false, error: '沒有可寫入的內容（要帶 config 或 secrets）' });
              return;
            }
            sendJson(res, 200, { ok: true, written: written });
          } catch (err) {
            // 路由裡任何未預期的例外都要變成回應，不能讓請求懸著。
            sendJson(res, 500, { ok: false, error: '設定路由失敗：' + toText(err && err.message) });
          }
        }
      });
      logNote(ctx, '路由註冊成功: ' + SETTINGS_PATH);
    } catch (err) {
      logNote(ctx, '設定路由註冊例外: ' + (err && err.message));
    }

    // 遮蔽金鑰路由：只回遮蔽後的値，原文不出宿主。
    //
    // 為什麼要一條路由而不是讓客戶端自己讀憑證檔：**客戶端讀不到檔案**（它在
    // 瀏覽器裡），而且把 `FEG_API_KEY` 送到瀏覽器會讓它出現在 DevTools、記憶體、
    // 以及任何一張截圖裡。放在宿主算完再回傳，暴露面就只剩「一個已經遮蔽的值」。
    try {
      webServer.register({
        kind: 'exact',
        path: MASK_KEY_PATH,
        handler: async (req, res) => {
          try {
            if (req.method !== 'GET') {
              sendJson(res, 405, { ok: false, error: '只接受 GET' });
              return;
            }
            const result = maskedCredential({});
            if (!result.ok) {
              // 失敗要說出**在哪裡找不到**，否則使用者只知道「按了沒反應」。
              sendJson(res, 503, { ok: false, error: result.error });
              return;
            }
            // ★ source 也回一份：除錯時要知道「這把金鑰是從哪個檔案讀出來的」。
            //   JSON.stringify 會把反斜杠變 \\\\，但網址/console 印出來仍是 \，
            //   且 `file` 已是絕對路徑，不會洩漏到客戶端看不見的位置。
            sendJson(res, 200, { ok: true, maskKey: result.masked, ref: result.ref, source: result.source });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: '遮蔽路由失敗：' + toText(err && err.message) });
          }
        }
      });
      logNote(ctx, '路由註冊成功: ' + MASK_KEY_PATH);
    } catch (err) {
      logNote(ctx, '遮蔽路由註冊例外: ' + (err && err.message));
    }
  });
}

module.exports = {
  /** 稳定的 Cordis 插件名：同时是包名与 patch 行 id。 */
  name: 'ntfy-teams',
  /**
   * 本插件不需要宿主 Service 先就绪：全部用 `ctx.get` 当可选依赖取。
   * 声明成硬依赖会让缺少 webServer／agentLoop 的环境整个挂不上，
   * 而这条功能只是辅助，不该有那种后果。
   */
  inject: [],
  apply,
  /** 供测试直接调用（不经过 HTTP）。 */
  __test: {
    buildSeed,
    createSeededSession,
    parseBody,
    clampText,
    ROUTE_PATH,
    SETTINGS_PATH,
    MASK_KEY_PATH,
    settingsDir,
    // 遮蔽金鑰相關（「恢復設定」那顆按鈕用）。
    readCredentialRef,
    maskKey,
    maskedCredential,
    credentialsFilePath,
    MASK_KEY_REFS,
    MAX_MESSAGES,
    MAX_MESSAGE_CHARS
  }
};
