'use strict';

// =============================================================================
// kaneo-web —— 宿主半边（Host half）
//
// 这个外挂让使用者在 DSH 侧边栏多一个「Kaneo」面板，面板里用 iframe 载入
// Kaneo 工作区。整个功能拆成两半，界线只有一条：
//
//   宿主半边（本档）知道**服务位址与签入路径**，也负责把 API Key 收下并存起来。
//   浏览器半边（lib/client.js）只拿得到「一个已经带好金钥的完整网址」与
//   「要不要先请使用者设定」这两个事实。
//
// 为什么这样拆：
//
//   1. 使用者要求「不要把网域与路径暴露在界面上」。位址与路径只写在宿主的
//      常数里，浏览器 bundle 里一个字都没有 —— 不是用 CSS 藏起来，而是
//      根本没送过去。
//   2. API Key 未设定时，浏览器半边要能用**使用者输入**的金钥换到一个可载入的
//      网址；这件事只有宿主做得到，因为登入端点会自己再导向一次，最终位址是
//      由伺服器决定的（实测：金钥无效时回 401 `INVALID_API_KEY`）。
//   3. 金钥本身不进浏览器任何持久储存 —— 浏览器只把它 POST 上来，宿主存进
//      这个外挂自己的 Config（`apiKey` 是 `.role('secret')` 的 volatile 栏位，
//      只有宿主读得到；settings 的远端读取一律 redact）。
//
// 储存与写入路径（刻意沿用宿主既有机制，不自己发明一套）：
//
//   `ctx.settings.update(NS, { apiKey })` —— Config 里的 volatile 栏位，
//   dsh-config-editor 会把它写进 profile 的 cordis.patch.yml（权限 0600）
//   并就地重载这个外挂，所以不需要重启。
//
// 本档零执行期依赖：只用 cordis 注入进来的服务与一个 schema 工厂。
// =============================================================================

/** Loader 行 id、套件名、settings namespace —— 三者必须一致。 */
const NS = 'kaneo-web';

/** 遮蔽金钥与凭证档解析（与 ntfy-teams 同一份公式）。 */
const secrets = require('./secrets.js');

/** 面板网址前缀。**只有这个档案知道**，浏览器半边看不到。 */
const SIGN_IN_PATH = '/api/auth/api-key/sign-in';

/** 允许的 `redirect` 值：Kaneo 内部路径，预设 /dashboard。 */
const DEFAULT_REDIRECT = '/dashboard';

/**
 * 预设的 Kaneo 服务位址。
 *
 * 使用者要求不要把网域写进任何会送到浏览器的地方 —— 这里可以存放，因为
 * 本档只跑在宿主行程里。要换环境（自架 Kaneo、测试站）只改这一行。
 */
const DEFAULT_SERVER_URL = 'https://pl.feg.cn';

/** 一次最多接受多大的请求体（金钥与路径都很短）。 */
const BODY_MAX = 32 * 1024;

/** 金钥长度上限：够长到容纳任何合理金钥，又挡住有人拿这个栏位塞大档案。 */
const API_KEY_MAX = 512;

/** 查询路由（GET 探测／POST 设定／DELETE 清除）。 */
const CONFIG_PATH = '/plugins/kaneo-web/config';

/**
 * 遮蔽金钥路由：回一份用 MASK.md 公式算出的 mask key，原文不出宿主。
 *
 * 存在的原因是远端储存端点要求拿遮蔽过的金钥去换资料，而原文住在宿主的
 * 凭证档里。算法与凭证档解析都在 lib/secrets.js，与 ntfy-teams 同一份公式。
 */
const MASK_PATH = '/plugins/kaneo-web/mask-key';

/**
 * 「从远端取回设定」路由。
 *
 * 为什么这一步也放在宿主：远端端点是内网主机名 + 固定路径，属于使用者要求
 * 「不要暴露给使用者」的那一类。放在宿主，浏览器只知道 `/plugins/kaneo-web/restore`，
 * 而且遮蔽金钥根本不必送到浏览器（少一处暴露）。
 */
const RESTORE_PATH = '/plugins/kaneo-web/restore';

/** 远端 BDD 储存端点：POST `{ apiKey }`（apiKey 是遮蔽后的值）。 */
const DEFAULT_STORAGE_URL = 'https://abc.feg.com.tw/BDD/API/AI/dsh/storage/kaneo';

/**
 * 重置路由：把這個外掛的設定收回初始狀態（金鑰與路徑都移除，回到 schema 預設）。
 *
 * 為什麼不讓面板自己「清除金鑰 + 寫回預設路徑」兩步完成：那是兩個寫入，
 * 中間失敗就會留下半套狀態。一條路由、一次 `mutate` 帶兩個 unset 才是原子語意。
 */
const RESET_PATH = '/plugins/kaneo-web/reset';

/** 打远端端点的时间预算（毫秒）。 */
const RESTORE_TIMEOUT_MS = 10000;

/** 远端回应的读取上限（它是几个栏位，不该是大档案）。 */
const RESTORE_BODY_MAX = 256 * 1024;

/**
 * 把 Config 里的值取成普通值。
 *
 * `.volatile()` 栏位在宿主端是 **Cordis 的 ref**（有 `get()`），不是字串。
 * 实测踩过：直接把它丢进字串串接会变成 `[object Object]`，也就是那个
 * 「金钥看起来有设定、其实送出去是一坨垃圾」的静默失效。dsh-settings 自己
 * 也是用 `isVolatile(value) → value.get()` 处理同一件事。
 *
 * @param value - Config 里的任意值。
 * @returns 普通值（字串／数字…）。
 */
function unwrapConfig(value) {
  let current = value;
  for (let i = 0; i < 8; i += 1) {
    if (current === null || current === undefined) return current;
    if (typeof current.get === 'function') {
      const next = current.get();
      if (next === current) return next;
      current = next;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * 把任何输入收成去掉前后空白的字串。
 *
 * @param value - 任意值（含 volatile ref）。
 * @returns 字串。
 */
function trimmed(value) {
  const plain = unwrapConfig(value);
  if (plain === null || plain === undefined) return '';
  return typeof plain === 'string' ? plain.trim() : String(plain).trim();
}

/**
 * 把 `redirect` 收成「Kaneo 站内的一个绝对路径」。
 *
 * 这一层是必要的，不是保险：`redirect` 会被放进查询字串交给远端，若允许
 * `https://evil.example` 这类值，这个端点就变成一个开放转址。
 * 规则：必须以单个 `/` 开头、不得含 `//`、`:`、`\`、任何空白，长度 ≤ 512。
 *
 * @param value - 使用者输入或 Config 里的值。
 * @returns 合法路径；不合法回 null。
 */
function sanitizeRedirect(value) {
  const text = trimmed(value);
  if (text === '') return null;
  if (text.length > 512) return null;
  if (text.charAt(0) !== '/') return null;
  if (text.charAt(1) === '/') return null;
  if (/[:\\\s]/.test(text)) return null;
  return text;
}

/**
 * 把值放进查询字串。
 *
 * 刻意**连 `/` 一起保持原样**：远端把这两个参数都当路径处理，编码成
 * `%2Fdashboard` 也许可以、也许不行（手边没有有效金钥可以验证成功路径），
 * 不编码则是浏览器与伺服器都熟的标准形状（实测无效金钥时 401 回应正常）。
 * 其余所有保留字元（`&`、`#`、`=`、空白…）照常编码 —— 金钥里出现 `&`
 * 会把查询字串截断，那是会静默传到错的金钥。
 *
 * @param value - 已收干的值。
 * @returns 可安全放进查询字串的字串。
 */
function encodeQueryValue(value) {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

/**
 * 依目前设定组出「可以载入 iframe」的完整网址。
 *
 * API Key 会出现在这个回传值里 —— 那是这个功能本身的形状（签入端点是
 * GET + query），无法回避；重点是它不出现在外挂接口的任何文字、任何持久
 * 储存、以及使用者的画面上。
 *
 * @param config - 现值 `{ apiKey, redirect, serverUrl? }`。
 * @returns `{ ok, apiKeySet, redirect, url }` 或 `{ ok:false, ... }`。
 */
/**
 * 從設定值取出「用哪種方式開工作區」。
 *
 * 這是兩個合法值之一：`'newtab'`（在新分頁開啟，繞開 iframe 嵌入限制）
 * 與 `'iframe'`（原本的 iframe 嵌入路徑）。預設 `newtab` —— 對站台
 * 不允許 iframe 嵌入時，新分頁永遠是安全選擇。
 *
 * 任何其他值（舊設定、拼錯、未來擴充）都安全地當 `'newtab'`。
 *
 * 這個函式**必須能在 apply 內**被呼叫 —— 所以把它寫在 apply 的開頭附近。
 * 為避免閉包變數被 hoist，先把 `getConfig` 抽出來。
 *
 * @returns `'newtab' | 'iframe'`。
 */
function readMode(config) {
  const value = config !== null && typeof config === 'object' ? config.mode : undefined;
  return value === 'iframe' ? 'iframe' : 'newtab';
}

function resolveSignIn(config) {
  const input = config !== null && typeof config === 'object' ? config : {};
  const apiKey = trimmed(input.apiKey);
  const redirect = sanitizeRedirect(input.redirect) || DEFAULT_REDIRECT;
  const server = trimmed(input.serverUrl) || DEFAULT_SERVER_URL;

  if (apiKey === '') {
    return { ok: false, reason: 'unconfigured', apiKeySet: false, redirect: redirect };
  }
  return {
    ok: true,
    apiKeySet: true,
    redirect: redirect,
    url: server + SIGN_IN_PATH
      + '?key=' + encodeQueryValue(apiKey)
      + '&redirect=' + encodeQueryValue(redirect)
  };
}

/**
 * 读完整个请求体，超过上限就断掉。
 *
 * @param req - IncomingMessage。
 * @returns Promise<字串>。
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let overflow = false;
    req.on('data', (chunk) => {
      if (overflow) return;
      data += chunk;
      if (data.length > BODY_MAX) {
        overflow = true;
        reject(new Error('请求内容过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!overflow) resolve(data);
    });
    req.on('error', reject);
  });
}

/**
 * 把请求体解析成物件。
 *
 * @param raw - 原始字串。
 * @returns 物件；不是合法 JSON 物件就回 null。
 */
function parseBody(raw) {
  const text = trimmed(raw);
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (err) {
    return null;
  }
}

/**
 * 回一份 JSON 回应。
 *
 * @param res - ServerResponse。
 * @param status - HTTP 状态码。
 * @param payload - 要序列化的内容。
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * 试算「这把金钥能不能用来登入」—— 对签入端点发一次 GET，**不跟随转址**。
 *
 * 为什么要这一步：远端储存端点给出的金钥不一定属于这个 Kaneo 实例（实测
 * 2026-10-15：端点回的 64 字元金钥被 `pl.feg.cn` 以 401 `INVALID_API_KEY`
 * 拒绝）。没有预检的话，使用者只会看到一个空白 iframe，无从知道是金钥不对
 * 还是嵌入被挡。
 *
 * 状态码含义（对照 Kaneo 的 api-key-sign-in 插件）：
 *   302/303 → 金钥有效、已建立会话（这正是载入 iframe 时会发生的事）
 *   401     → `INVALID_API_KEY`：金钥不属于这个实例／已停用／已过期
 *   403     → `SCOPED_API_KEY_NOT_ALLOWED` 或 `INSTANCE_ADMIN_REQUIRED`
 *   404     → 该部署没开 `API_KEY_SIGN_IN`（端点不存在）
 *   429     → 命中限流
 *
 * @param url - 已经组好的签入网址。
 * @returns Promise<{ status, verdict, error? }>；verdict 是给使用者看的一句话。
 */
async function probeSignIn(url) {
  const init = {
    method: 'GET',
    // 不要跟随转址：我们要的是 302 本身，不是被转址之后的看板首页。
    redirect: 'manual',
    headers: { accept: 'application/json' }
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(RESTORE_TIMEOUT_MS);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    return { status: 0, verdict: 'unknown', error: errorText(err) };
  }
  const status = response.status;
  if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
    return { status: status, verdict: 'ok' };
  }
  if (status === 401) return { status: status, verdict: 'invalid' };
  if (status === 403) return { status: status, verdict: 'forbidden' };
  if (status === 404) return { status: status, verdict: 'not-enabled' };
  if (status === 429) return { status: status, verdict: 'rate-limited' };
  return { status: status, verdict: 'unknown' };
}

/**
 * 把错误收成一句可读的文字（永不回传金钥）。
 *
 * @param err - 任意错误值。
 * @returns 字串。
 */
function errorText(err) {
  if (err === null || err === undefined) return '未知错误';
  const message = typeof err.message === 'string' ? err.message : String(err);
  return message;
}

/**
 * 带超时打一个 JSON API（POST 用）。
 *
 * 用全域 fetch（Node 18+ 内建）。超时用 AbortSignal.timeout；拿不到就退化成
 * 没有超时 —— 宁可不中断，也不要因为少一个 API 而整条路不能用。
 *
 * @param url - 端点。
 * @param body - 要序列化的请求体。
 * @returns Promise<{ status, ok, payload, text }>；网路失败会 reject。
 */
async function postJson(url, body) {
  const init = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(RESTORE_TIMEOUT_MS);
  }
  const response = await fetch(url, init);
  const text = await response.text();
  let payload = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch (err) {
    payload = null;
  }
  return {
    status: response.status,
    ok: response.ok === true,
    payload: payload,
    text: text.length > RESTORE_BODY_MAX ? text.slice(0, RESTORE_BODY_MAX) : text
  };
}

/**
 * 取得宿主设定服务（拿不到就回 null，不抛）。
 *
 * @param scope - 子上下文。
 * @returns settings 服务或 null。
 */
function getSettings(scope) {
  try {
    if (scope !== null && scope !== undefined && typeof scope.get === 'function') {
      return scope.get('settings') || null;
    }
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * 从请求的查询字串里读 `?redirect=`（「这次要落在哪一页」的覆写）。
 *
 * 只接受站内绝对路径（`/` 开头、第二个字元不是 `/`、不含 `://`、不含空白与
 * 反斜线）；不合法就当没给 —— **不报错**，因为这只影响「落在哪一页」，
 * 回落到设定值即可，没必要让整个请求失败。
 *
 * @param req - HTTP 请求。
 * @returns 合法路径，或 null。
 */
function requestedRedirect(req) {
  try {
    const raw = req !== null && req !== undefined && typeof req.url === 'string' ? req.url : '';
    const at = raw.indexOf('?');
    if (at === -1) return null;
    const query = raw.slice(at + 1);
    const match = /(?:^|&)redirect=([^&]*)/.exec(query);
    if (match === null) return null;
    let value = match[1];
    try {
      value = decodeURIComponent(value.replace(/\+/g, ' '));
    } catch (err) {
      return null;
    }
    return sanitizeRedirect(value);
  } catch (err) {
    return null;
  }
}

/**
 * 载入 schema 工厂（schemastery 的具名导出：`object`、`string`…）。
 *
 * 为什么需要这段解析而不是一行 `require('@deepseek-ai/schemastery')`：
 * 本外挂是**被连结**进 profile 的（像同目录的其他外挂一样），它的
 * `node_modules` 里没有这个套件 —— 它是 dsh 自己的相依，只存在于 dsh
 * 安装目录底下。实测：从外挂目录 require 一定 MODULE_NOT_FOUND。
 *
 * 所以依序试几个「这台机器上真的会有」的位置：
 *   1. 正常的 require 链（使用者自己把套件装在 workspace 时就会中）；
 *   2. profile 的 node_modules（pnpm 会把 dsh 的相依连到那里）；
 *   3. dsh 外挂安装目录的 node_modules；
 *   4. `$DSH_HOME/profile/node_modules` 与 `$DSH_HOME/node_modules`。
 *
 * 任何一个中了就用它。全都拿不到时回 null —— 这时外挂**仍然可用**，只是没有
 * Config schema，settings 服务会因为「没有 volatile 栏位」而拒绝写入，面板会
 * 明确报出这件事，而不是静默地存不起来。
 *
 * @returns `{ S, from }`：schema 工厂与它的来源；找不到回 `{ S:null, from:null }`。
 */
function loadSchemastery() {
  const candidates = [];
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && candidates.indexOf(value) === -1) candidates.push(value);
  };

  // profile 自己的 node_modules 是首选：套件在 dsh 安装目录里时也能从中解析。
  push(process.env.DSH_PROFILE_DIR ? process.env.DSH_PROFILE_DIR + '/node_modules' : '');
  push(process.env.DSH_HOME ? process.env.DSH_HOME + '/profiles/' + (process.env.DSH_PROFILE || '') + '/node_modules' : '');
  // 本档的祖先链（cordis-plugins/node_modules、workspace/node_modules…）。
  for (const entry of module.paths || []) push(entry);
  // 与 dsh 并列的常见安装位置（使用者把套件装在别处时的最后手段）。
  push(process.env.DSH_HOME ? process.env.DSH_HOME + '/node_modules' : '');

  for (const base of candidates) {
    try {
      const resolved = require.resolve('@deepseek-ai/schemastery', { paths: [base] });
      const mod = require(resolved);
      if (mod && typeof mod.object === 'function' && typeof mod.string === 'function') {
        return { S: mod, from: resolved };
      }
    } catch (err) {
      // 换下一个候选。
    }
  }
  return { S: null, from: null };
}

const SCHEMA = loadSchemastery();

/**
 * 这个行程实际要用的 schema 工厂（可能为 null）。
 *
 * @returns `{ S, from }`。
 */
function schemaSource() {
  return SCHEMA;
}

/**
 * 外挂本体的 Config：两个 volatile 栏位，都可以即时改、不必重启。
 *
 * `apiKey` 标成 `role('secret')`：宿主自己的 reads 拿得到值（本外挂要用），
 * 但任何走 `ctx.remote.settings.describe()` 的远端读取都会被 redact 成
 * 一个「已设定 / 未设定」的标记。换句话说浏览器永远拿不到金钥本身，
 * 除非它自己刚 POST 上来（那是使用者自己打的字）。
 *
 * @param S - schema 工厂；拿不到时回 undefined（Config 验证略过，功能照常）。
 * @returns schema 或 undefined。
 */
function buildConfig(S) {
  if (S === null || S === undefined || typeof S.object !== 'function') return undefined;
  try {
    return S.object({
      apiKey: S.string()
        .role('secret')
        .volatile()
        .description('Kaneo API Key（必填；未设定时面板会请你输入，只存在宿主端）'),
      redirect: S.string()
        .default(DEFAULT_REDIRECT)
        .volatile()
        .description('签入后要在 Kaneo 里打开的路径（预设 /dashboard）'),
      storageUrl: S.string()
        .default(DEFAULT_STORAGE_URL)
        .volatile()
        .description('远端储存端点（「从远端取回设定」用；apiKey 是遮蔽后的值）'),
      enableRestore: S.boolean()
        .default(true)
        .volatile()
        .description('是否允许面板按「从远端取回设定」去换 API Key'),
      mode: S.union([
        S.const('newtab').description('「在新分页开启」—— 绕开 iframe 嵌入限制'),
        S.const('iframe').description('原本的 iframe 路径（可被 X-Frame / SameSite 挡）')
      ]).default('newtab')
        .volatile()
        .description('面板开启工作区的方式：iframe 或新分页')
    });
  } catch (err) {
    return undefined;
  }
}

/** Loader 在建立这个外挂的 fiber 时读的静态 Config（可能为 undefined）。 */
const CONFIG_SCHEMA = buildConfig(SCHEMA.S);

/**
 * 宿主侧挂载点。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 这一行的 Config（`{ apiKey, redirect }`）。
 */
function apply(ctx, config) {
  const live = config !== null && typeof config === 'object' ? config : {};

  /**
   * 目前的设定值。
   *
   * `config` 是 Loader 每次以新 config 重建这个外挂时给的物件；`ctx.fiber.config`
   * 是同一份的另一个把手（dsh 自己读 `entry.fiber.config` 就是走这个）。两者都
   * 拿不到时回空物件，让上层走「未设定」那条路，而不是抛错。
   *
   * @returns Config 物件（永不为 null）。
   */
  function currentConfig() {
    // `ctx.fiber.config` 优先：它永远指向**这个外挂实例目前**的 Config。金钥
    // 存进去之后 Loader 会把新 config 解析进来，而 `apply` 当时拿到的那一份
    // （闭包里的 `live`）是旧的 —— 优先读旧的就会「存进去了却读回空的」。
    //
    // 不过 fiber 上的那一份可能少几个键（例如某个栏位是在挂载之后才被写进去的），
    // 所以闭包当作**后备**逐键补齐，而不是整份丢掉。
    const fiber = ctx.fiber;
    const fromFiber = fiber !== null && fiber !== undefined ? fiber.config : undefined;
    const hasFiber = fromFiber !== null && fromFiber !== undefined && typeof fromFiber === 'object';
    const hasLive = live !== null && typeof live === 'object';
    if (!hasFiber && !hasLive) return {};
    if (!hasFiber) return live;
    if (!hasLive) return fromFiber;

    const merged = {};
    // 順序：先 `fromFiber`（drives 一切），再 `live`（補 fiber 沒有的鍵）。
    // 對 `fromFiber` 的每個鍵都要 `unwrapConfig`（volatile ref 用 `.get()` 解）
    // —— 直接放 ref 進 merged，後面讀 `merged.mode` 拿到的會是 function 而不是
    // 字串，判斷 `mode === 'iframe'` 永遠是 false。
    for (const key of Object.keys(fromFiber)) merged[key] = unwrapConfig(fromFiber[key]);
    for (const key of Object.keys(live)) {
      if (merged[key] === undefined) merged[key] = live[key];
    }
    return merged;
  }

  if (CONFIG_SCHEMA === undefined) {
    // 说出来，不要静默：没有 schema 时 settings 会拒绝写入，面板会看到 500。
    try {
      if (ctx.logger && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('kaneo-web: 找不到 @deepseek-ai/schemastery，Config schema 未建立；'
          + '面板仍可显示，但 API Key 无法透过 settings 服务储存。');
      }
    } catch (err) { /* log 失败不影响挂载 */ }
  }

  /**
   * 把使用者输入的金钥与路径存进这个外挂的 Config。
   *
   * @param apiKey - 使用者输入的金钥。
   * @param redirect - 使用者输入的路径（空字串代表沿用现值）。
   * @returns Promise<{ ok, error? }>。
   */
  async function persist(apiKey, redirect) {
    const patch = { apiKey: apiKey };
    if (redirect !== null) patch.redirect = redirect;

    const settings = getSettings(ctx);
    if (settings === null || settings === undefined || typeof settings.update !== 'function') {
      return {
        ok: false,
        error: '设定服务不可用（这个组合没有挂载 @deepseek-ai/dsh-settings），无法储存 API Key'
      };
    }
    try {
      await settings.update(NS, patch, undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '储存失败：' + errorText(err) };
    }
  }

  /**
   * 把這個外掛的設定收回初始狀態。
   *
   * 語意：**移除**這個 profile patch row 裡的欄位，讓它們回到 schema 預設
   * （`apiKey` 沒有預設 → 未設定；`redirect` 預設 `/dashboard`）。所以重置後
   * 面板會回到設定表，而且不必自己再填一次路徑。
   *
   * 為什麼用 `mutate` + `unset` 而不是寫空字串：settings 的 `set` 會拒絕空值，
   * 而 `unset` 正是它提供的「移除這個欄位」語義。
   *
   * @param paths - 要收回初始狀態的欄位路徑；省略時是 `[['apiKey']]`。
   * @returns Promise<{ ok, error? }>。
   */
  async function unsetFields(paths) {
    const fields = Array.isArray(paths) && paths.length > 0 ? paths : [['apiKey']];
    const settings = getSettings(ctx);
    if (settings === null || settings === undefined || typeof settings.mutate !== 'function') {
      return {
        ok: false,
        error: '設定服務不可用（這個組合沒有掛載 @deepseek-ai/dsh-settings），無法清除設定'
      };
    }
    try {
      const ops = fields.map(function (path) { return { op: 'unset', path: path }; });
      await settings.mutate(NS, ops, undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '清除失敗：' + errorText(err) };
    }
  }

  /**
   * 把部份欄位合併進現有 Config（用 volatile schema update，不動金鑰）。
   *
   * 用 `settings.update` 而不是 `mutate`：panel 的 PATCH 走的是「把整個物件
   * 完整重寫」這條路，**會**還沒寫進去（mutate 不會）但**不會**刪掉已儲存的欄位。
   *
   * @param patch - 例如 `{ mode: 'iframe' }`。
   * @returns Promise<{ ok, error? }>。
   */
  async function persistPatch(patch) {
    const settings = getSettings(ctx);
    if (settings === null || settings === undefined || typeof settings.update !== 'function') {
      return {
        ok: false,
        error: '設定服務不可用（這個組合沒有掛載 @deepseek-ai/dsh-settings），無法更新模式'
      };
    }
    try {
      await settings.update(NS, patch, undefined);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '更新失敗：' + errorText(err) };
    }
  }

  /**
   * 清掉已儲存的金鑰（回到「未設定」）—— 只動金鑰，保留路徑。
   *
   * @returns Promise<{ ok, error? }>。
   */
  async function clear() {
    return unsetFields([['apiKey']]);
  }

  /**
   * 重置整個管線設定：金鑰與登入路徑都收回初始狀態。
   *
   * @returns Promise<{ ok, error? }>。
   */
  async function resetAll() {
    return unsetFields([['apiKey'], ['redirect']]);
  }

  // webServer 是可选依赖：缺了它这个外挂仍然能挂载，只是没有查询路由可用，
  // 不会把整个 profile 拖下水。
  ctx.inject(['webServer'], (scope) => {
    /**
     * GET    —— 现在该显示什么？（未设定 / 可以载入的完整网址）
     * POST   —— 使用者按下「储存并载入」：存起来，然后回一份新网址。
     * DELETE —— 使用者按下「清除金钥」：移除已储存的值。
     *
     * @param req - HTTP 请求。
     * @param res - HTTP 回应。
     */
    async function handle(req, res) {
      try {
        if (req.method === 'GET') {
          // `?redirect=` 是「這一次要落在哪一頁」的覆寫（面板用它把使用者帶回
          // 上次看的那一頁）。它**不寫進設定** —— 只在這次回應組網址時生效；
          // 所以要先驗過（不合法就忽略，回落到設定值）。
          const wanted = requestedRedirect(req);
          const overridden = wanted === null
            ? currentConfig()
            : Object.assign({}, currentConfig(), { redirect: wanted });
          const resolved = resolveSignIn(overridden);
          sendJson(res, 200, {
            ok: true,
            configured: resolved.ok === true,
            apiKeySet: resolved.apiKeySet === true,
            redirect: resolved.redirect,
            url: resolved.ok === true ? resolved.url : null,
            // **一定要回 `mode`**：面板用這個值決定「在新分頁開啟」還是「iframe 內嵌」。
            // 這裡漏掉的話，面板永遠停在初始值（自動偵測的結果），使用者切換過
            // 的模式會被無聲蓋掉 —— 症狀就是「怎麼存都回到新分頁」。
            mode: readMode(currentConfig())
          });
          return;
        }

        if (req.method === 'DELETE') {
          const cleared = await clear();
          if (!cleared.ok) {
            sendJson(res, 500, { ok: false, error: cleared.error });
            return;
          }
          const resolved = resolveSignIn(currentConfig());
          sendJson(res, 200, {
            ok: true,
            configured: resolved.ok === true,
            apiKeySet: resolved.apiKeySet === true,
            redirect: resolved.redirect,
            url: resolved.ok === true ? resolved.url : null,
            mode: readMode(currentConfig())
          });
          return;
        }

        if (req.method === 'PATCH') {
          // 只更新「模式」之類的次要欄位（不動 apiKey 與 redirect）。
          let raw;
          try { raw = await readBody(req); } catch (err) {
            sendJson(res, 413, { ok: false, error: errorText(err) }); return;
          }
          const body = parseBody(raw);
          if (body === null) {
            sendJson(res, 400, { ok: false, error: '请求内容不是合法 JSON 物件' }); return;
          }
          const wanted = {};
          if (body.mode === 'iframe' || body.mode === 'newtab') {
            wanted.mode = body.mode;
          } else if (body.mode !== undefined) {
            sendJson(res, 400, { ok: false, error: 'mode 必須是 iframe 或 newtab' }); return;
          }
          if (Object.keys(wanted).length === 0) {
            sendJson(res, 400, { ok: false, error: 'PATCH 必須帶要改的欄位' }); return;
          }
          const updated = await persistPatch(wanted);
          if (!updated.ok) {
            sendJson(res, 500, { ok: false, error: updated.error }); return;
          }
          const resolved = resolveSignIn(currentConfig());
          sendJson(res, 200, {
            ok: true,
            mode: readMode(currentConfig()),
            configured: resolved.ok === true,
            apiKeySet: resolved.apiKeySet === true,
            redirect: resolved.redirect,
            url: resolved.ok === true ? resolved.url : null
          });
          return;
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 GET／POST／DELETE／PATCH' });
          return;
        }

        let raw;
        try {
          raw = await readBody(req);
        } catch (err) {
          sendJson(res, 413, { ok: false, error: errorText(err) });
          return;
        }
        const body = parseBody(raw);
        if (body === null) {
          sendJson(res, 400, { ok: false, error: '请求内容不是合法 JSON 物件' });
          return;
        }

        const apiKey = trimmed(body.apiKey);
        if (apiKey === '') {
          sendJson(res, 400, { ok: false, error: '请输入 API Key' });
          return;
        }
        if (apiKey.length > API_KEY_MAX) {
          sendJson(res, 400, { ok: false, error: 'API Key 过长' });
          return;
        }

        // `redirect` 省略 = 沿用现值；给了但格式不对 = 明确拒绝，不静默改成预设值。
        let redirect = null;
        if (body.redirect !== undefined && body.redirect !== null && trimmed(body.redirect) !== '') {
          redirect = sanitizeRedirect(body.redirect);
          if (redirect === null) {
            sendJson(res, 400, {
              ok: false,
              error: '签入路径必须是站内绝对路径，例如 /dashboard（不得含网域）'
            });
            return;
          }
        }

        const saved = await persist(apiKey, redirect);
        if (!saved.ok) {
          sendJson(res, 500, { ok: false, error: saved.error });
          return;
        }

        const resolved = resolveSignIn(currentConfig());
        if (resolved.ok !== true) {
          // 存成功了却组不出网址，代表 Config 没被接受 —— 说出来，不要静默失败。
          sendJson(res, 500, {
            ok: false,
            error: '设定已写入，但读回时仍是空的 —— 请检查 profile 的 cordis.patch.yml',
            redirect: resolved.redirect
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          configured: true,
          apiKeySet: true,
          redirect: resolved.redirect,
          url: resolved.url
        });
      } catch (err) {
        // 路由里任何未预期的例外都要变成回应，不能让请求悬着。
        sendJson(res, 500, { ok: false, error: 'kaneo-web: ' + errorText(err) });
      }
    }

    ctx.effect(
      () => scope.webServer.register({ kind: 'exact', path: CONFIG_PATH, handler: handle }),
      'kaneo-web: config route'
    );

    /**
     * 重置整个管线设定：金钥与登入路径都收回初始状态。
     *
     * 一次 `mutate` 带两个 `unset` —— 不拆成两次写入，免得中间失败留下半套状态。
     *
     * @param req - HTTP 请求。
     * @param res - HTTP 回应。
     */
    async function handleReset(req, res) {
      try {
        if (req.method !== 'POST' && req.method !== 'DELETE') {
          sendJson(res, 405, { ok: false, error: '只接受 POST／DELETE' });
          return;
        }
        const reset = await resetAll();
        if (!reset.ok) {
          sendJson(res, 500, { ok: false, error: reset.error });
          return;
        }
        const resolved = resolveSignIn(currentConfig());
        sendJson(res, 200, {
          ok: true,
          reset: true,
          configured: resolved.ok === true,
          apiKeySet: resolved.apiKeySet === true,
          redirect: resolved.redirect,
          url: resolved.ok === true ? resolved.url : null,
          mode: readMode(currentConfig())
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'kaneo-web: ' + errorText(err) });
      }
    }

    /**
     * 遮蔽金钥：GET 回 `{ ok, maskKey, ref, source }`。
     *
     * ⚠️ 回传值里只有遮蔽后的字串，**原文一个字都不回**。
     *
     * @param req - HTTP 请求。
     * @param res - HTTP 回应。
     */
    async function handleMaskKey(req, res) {
      try {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: '只接受 GET' });
          return;
        }
        const result = await secrets.maskedCredential(scope, {});
        if (result.ok !== true) {
          // 失败要说清楚**在哪里找不到**，否则使用者只知道「按了没反应」。
          sendJson(res, 503, { ok: false, error: result.error, tried: result.tried });
          return;
        }
        sendJson(res, 200, { ok: true, maskKey: result.maskKey, ref: result.ref, source: result.source });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'kaneo-web: ' + errorText(err) });
      }
    }

    /**
     * 从远端储存端点把资料换回来。
     *
     * 两步都在宿主完成：先取得 mask key，再打远端。这样浏览器只看得到
     * `/plugins/kaneo-web/restore`，远端位址与遮蔽金钥都不必送出去。
     *
     * 回应刻意把「服务器真的回了什么」一起带上：那个端点的形状没有文件，
     * 实测无效金钥回 `200 {}`；把原始回应摊开，使用者第一次按就能看出是
     * 「这把遮蔽金钥在服务器上没有资料」而不是「程式坏了」。
     *
     * @param req - HTTP 请求。
     * @param res - HTTP 回应。
     */
    async function handleRestore(req, res) {
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: '只接受 POST' });
          return;
        }

        const config = currentConfig();
        const enabled = unwrapConfig(config.enableRestore);
        if (enabled === false) {
          sendJson(res, 403, { ok: false, error: '这个外挂的 enableRestore 已关闭' });
          return;
        }
        const storageUrl = trimmed(config.storageUrl) || DEFAULT_STORAGE_URL;

        const source = await secrets.maskedCredential(scope, {});
        if (source.ok !== true) {
          sendJson(res, 503, {
            ok: false,
            step: 'mask-key',
            error: source.error,
            tried: source.tried
          });
          return;
        }

        let upstream;
        try {
          upstream = await postJson(storageUrl, { apiKey: source.maskKey });
        } catch (err) {
          sendJson(res, 502, {
            ok: false,
            step: 'upstream',
            error: '打不到远端储存端点：' + errorText(err)
          });
          return;
        }

        if (upstream.status === 500) {
          sendJson(res, 502, {
            ok: false,
            step: 'upstream',
            status: upstream.status,
            error: '远端回 500：请求格式不对（这个端点预期 body {"apiKey":"<mask key>"}）'
          });
          return;
        }
        if (upstream.ok !== true) {
          sendJson(res, 502, {
            ok: false,
            step: 'upstream',
            status: upstream.status,
            error: '远端回 HTTP ' + upstream.status,
            body: upstream.text.slice(0, 400)
          });
          return;
        }

        const normalized = secrets.normalizeRestorePayload(upstream.payload);

        // 只拿到一个候选时顺手预检「这把金钥能不能登入」。远端金钥可能不属于
        // 这个 Kaneo 实例（实测就是如此），先说清楚，比让使用者对着空白
        // iframe 猜要诚实得多。
        let check = null;
        if (normalized.candidates.length === 1) {
          const probeTarget = resolveSignIn({
            apiKey: normalized.candidates[0].value,
            redirect: normalized.fields.redirect || trimmed(config.redirect) || DEFAULT_REDIRECT,
            serverUrl: trimmed(config.serverUrl) || DEFAULT_SERVER_URL
          });
          if (probeTarget.ok === true) {
            const probed = await probeSignIn(probeTarget.url);
            check = {
              status: probed.status,
              verdict: probed.verdict,
              error: probed.error
            };
          }
        }

        sendJson(res, 200, {
          ok: true,
          candidates: normalized.candidates,
          fields: normalized.fields,
          check: check,
          // 原始回应一起给：形状对不上时这是唯一能让使用者（与我）看懂的东西。
          raw: upstream.payload,
          ref: source.ref
        });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'kaneo-web: ' + errorText(err) });
      }
    }

    ctx.effect(
      () => scope.webServer.register({ kind: 'exact', path: MASK_PATH, handler: handleMaskKey }),
      'kaneo-web: mask-key route'
    );
    ctx.effect(
      () => scope.webServer.register({ kind: 'exact', path: RESTORE_PATH, handler: handleRestore }),
      'kaneo-web: restore route'
    );
    ctx.effect(
      () => scope.webServer.register({ kind: 'exact', path: RESET_PATH, handler: handleReset }),
      'kaneo-web: reset route'
    );
  });
}

module.exports = {
  /** 稳定的 Cordis 外挂名：同时是套件名与 patch 行 id。 */
  name: NS,
  /** 不需要任何宿主 Service 先就绪；webServer 用 ctx.inject 等。 */
  inject: [],
  apply,
  /** Config schema；找不到 schema 工厂时是 undefined（功能仍可用，只是存不了金钥）。 */
  Config: CONFIG_SCHEMA,
  /** 供离线测试直接调用（不经过 HTTP）。 */
  __test: {
    NS,
    CONFIG_PATH,
    MASK_PATH,
    RESTORE_PATH,
    RESET_PATH,
    SIGN_IN_PATH,
    DEFAULT_REDIRECT,
    DEFAULT_SERVER_URL,
    DEFAULT_STORAGE_URL,
    RESTORE_TIMEOUT_MS,
    BODY_MAX,
    API_KEY_MAX,
    resolveSignIn,
    sanitizeRedirect,
    encodeQueryValue,
    parseBody,
    trimmed,
    unwrapConfig,
    requestedRedirect,
    buildConfig,
    postJson,
    schemaSource,
    secrets
  }
};
