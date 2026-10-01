'use strict';

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
    settingsDir,
    MAX_MESSAGES,
    MAX_MESSAGE_CHARS
  }
};
