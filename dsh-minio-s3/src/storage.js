'use strict'

/**
 * dsh-minio-s3 — 連線從哪來（憑證遮蔽 → BDD storage 查詢 → S3 端點）
 *
 * 與 ov-memory / ntfy-teams / kaneo-web 同一條路：本機 `refs.AIFE_API_KEY`
 * 依 MASK.md 遮蔽後 POST 到 `abc.feg.com.tw/BDD/API/AI/dsh/storage/<name>`，
 * 換回該服務的連線資料。差別只在這裡拿的是 S3：
 *
 *   POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/s3
 *   body { "apiKey": "<masked>" }
 *   → 200 { "S3_URL": "http://10.17.26.8:7000", "S3_UID": "admin",
 *           "S3_PWD": "…", "S3_BUCK": "" }
 *
 * 實測（2026-10-16）：71 字元的 mask 形式回真資料；`S3_BUCK` 可能是空字串，
 * 代表「伺服器沒有指定預設桶」，而不是失敗 —— 所以要靠 ListBuckets 決定。
 *
 * 安全邊界（MASK.md）：masked 形式本身就是一把金鑰，只能送去
 * `abc.feg.com.tw`，其餘任何主機一律拒絕。**S3 的帳密只在宿主記憶體裡**，
 * 不寫檔、不進瀏覽器（`/status` 只回旗標與桶名）。
 */

const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

const { S3Client } = require('./s3')

/** 唯一可以收到 masked apiKey 的主機。 */
const STORAGE_HOST = 'abc.feg.com.tw'

/** 本外掛的 storage 端點。 */
const DEFAULT_STORAGE_URL = `https://${STORAGE_HOST}/BDD/API/AI/dsh/storage/s3`

/** 依序嘗試的憑證 ref（AIFE 是這台機器實際有的那把）。 */
const CREDENTIAL_REFS = ['AIFE_API_KEY', 'FEG_API_KEY', 'DEEPSEEK_API_KEY']

/** storage 回應的欄位名（第一個候選）。 */
const URL_FIELD = 'S3_URL'
const UID_FIELD = 'S3_UID'
const PWD_FIELD = 'S3_PWD'
const BUCKET_FIELD = 'S3_BUCK'

/**
 * 欄位候選名（大小寫不敏感）。
 *
 * 這不是「以防萬一」：同一個 storage 記錄在 2026-10-16 兩次查詢之間，欄位從
 * `S3_UID / S3_PWD / S3_BUCK`（空）變成 `UID / PWD / BUCKET`（"dsh"）—— 那個
 * 記錄是人工維護的，命名沒有穩定契約。硬綁一組名字會在某天變成
 * 「請求合法、回應沒有資料」的靜默失效；改成認得兩種寫法。
 */
const FIELD_CANDIDATES = {
  endpoint: ['S3_URL', 'S3_ENDPOINT', 'S3_HOST', 'ENDPOINT', 'URL'],
  accessKey: ['S3_UID', 'S3_ACCESS_KEY', 'S3_ACCESS_KEY_ID', 'UID', 'ACCESS_KEY', 'ACCESS_KEY_ID'],
  secretKey: ['S3_PWD', 'S3_PASSWORD', 'S3_SECRET_KEY', 'S3_SECRET_ACCESS_KEY', 'PWD', 'PASSWORD', 'SECRET_KEY', 'SECRET_ACCESS_KEY'],
  defaultBucket: ['S3_BUCK', 'S3_BUCKET', 'BUCKET', 'BUCKET_NAME'],
}

const DEFAULT_TIMEOUT_MS = 8000

/** 連線快取時間：查一次用十分鐘，失敗不進快取。 */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * 憑證檔位置：`DSH_CREDENTIALS_PATH`（測試與搬檔）→ `$DSH_HOME/.credentials.yaml`
 * → `$HOME/.dsh/.credentials.yaml`。
 */
function credentialsFilePath(env) {
  const source = env || process.env
  const override = source.DSH_CREDENTIALS_PATH
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  const home = source.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

/**
 * 讀 `refs.<name>`。手寫解析而不用 YAML 套件：DSH 寫這個檔，形狀固定
 * （`refs:` 底下兩格縮排的 `name: value`），這個外掛沒有執行期依賴。
 */
function readCredentialRef(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || name === '') return null
  let inRefs = false
  let refsIndent = -1
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    const trimmed = line.trim()

    if (/^refs:\s*$/.test(trimmed)) {
      inRefs = true
      refsIndent = indent
      continue
    }
    if (!inRefs) continue
    if (indent <= refsIndent) {
      inRefs = false
      continue
    }

    const match = trimmed.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/)
    if (!match || match[1] !== name) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value === '' ? null : value
  }
  return null
}

/**
 * 遮蔽金鑰：`sk-` + base64(key + "@" + ISO)，71 字元。
 *
 * 這是 storage 端點家族實測會回真資料的那個形狀（`/storage/ov`、`/storage/ntfy`
 * 都量過）。MASK.md 記載的 67 字元變體在這一族回 `200 {}`，所以維持 71。
 */
function maskKey(key, now) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('maskKey: key 必須是非空字串')
  }
  const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now)
  return `sk-${Buffer.from(key + '@' + at.toISOString(), 'utf8').toString('base64')}`
}

/** 讀第一個存在的 ref 並遮蔽。 */
function readMaskedCredential(options) {
  const opts = options || {}
  const env = opts.env || process.env
  const refs = opts.refs || CREDENTIAL_REFS
  const readFile = opts.readFile || readFileSync
  const file = credentialsFilePath(env)

  let text
  try {
    text = readFile(file, 'utf8')
  } catch (error) {
    return { ok: false, stage: 'credential', error: `讀不到憑證檔（${file}）：${(error && error.message) || error}` }
  }

  for (const ref of refs) {
    const key = readCredentialRef(text, ref)
    if (!key) continue
    try {
      return { ok: true, masked: maskKey(key, opts.now), ref, source: file }
    } catch (error) {
      return { ok: false, stage: 'credential', error: `無法遮蔽 refs.${ref}：${(error && error.message) || error}` }
    }
  }

  return { ok: false, stage: 'credential', error: `${file} 裡沒有可用的金鑰（試過 ${refs.join('、')}）` }
}

/** 拒絕任何不是 `abc.feg.com.tw` 的 storage URL。 */
function requireStorageUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`storage URL 不是 URL：${url}`)
  }
  if (parsed.protocol !== 'https:') throw new Error(`storage URL 必須是 https：${url}`)
  if (parsed.hostname !== STORAGE_HOST) {
    throw new Error(`拒絕把 masked 金鑰送到 ${parsed.hostname}：只有 ${STORAGE_HOST} 可以收`)
  }
  return url
}

/**
 * 把回應裡的端點收成 `http(s)://host:port`（沒有 scheme 時補 http://）。
 *
 * 這裡同時是 **SSRF 的邊界**：端點來自人工維護的 storage 記錄，而宿主會對它
 * 發出帶 SigV4 簽章的請求，並在每個新連線上發一次未簽章探測。所以：
 *   - 只接受 http/https（S3Client 也會再檢查一次）；
 *   - 拒絕 link-local（169.254.0.0/16，雲端 metadata 服務所在）與已知的
 *     metadata 主機名；
 *   - 設定 `DSH_MINIO_S3_ALLOWED_HOSTS`（逗號分隔）時，只允許那些主機。
 * 憑證本身永遠不會被送到別處；但「對任意主機發出已簽章請求」本身就是能力，
 * 所以不讓它變成可任意指定。
 */
const BLOCKED_HOSTS = new Set(['metadata.google.internal', 'metadata.goog', '169.254.169.254'])

function hostAllowed(hostname, allowed) {
  if (allowed && allowed.length > 0) return allowed.includes(hostname)
  return !BLOCKED_HOSTS.has(hostname) && !/^169\.254\./.test(hostname)
}

function normalizeEndpoint(value, options) {
  const text = String(value || '').trim()
  if (text === '') return ''
  // 明確給了非 http(s) 的 scheme 就拒絕（不要去猜 `ftp://…` 想表達什麼）。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^https?:\/\//i.test(text)) return ''
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return ''
  }
  const allowed = (options && options.allowedHosts) || []
  if (!hostAllowed(parsed.hostname.toLowerCase(), allowed)) return ''
  return withScheme.replace(/\/+$/, '')
}

/**
 * 從 storage 回應取出連線。缺欄位時回一份可讀的失敗 —— 這一族端點最常見的
 * 失敗模式是 `200` + 空 body（「請求合法、但沒有這個憑證的資料」），那看起來
 * 跟成功一模一樣，所以錯誤訊息要列出實際收到的欄位。
 */
function extractStoredConnection(payload, options) {
  const data = payload && typeof payload === 'object' ? payload : {}
  const lowered = new Map()
  for (const [key, value] of Object.entries(data)) lowered.set(key.toLowerCase(), value)

  const pick = (candidates) => {
    for (const name of candidates) {
      const value = lowered.get(name.toLowerCase())
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
  }

  const rawEndpoint = pick(FIELD_CANDIDATES.endpoint)
  const endpoint = normalizeEndpoint(rawEndpoint, options)
  const accessKey = pick(FIELD_CANDIDATES.accessKey)
  const secretKey = pick(FIELD_CANDIDATES.secretKey)
  const defaultBucket = pick(FIELD_CANDIDATES.defaultBucket)
  const keys = Object.keys(data)

  const missing = []
  if (!endpoint) missing.push(rawEndpoint ? `${FIELD_CANDIDATES.endpoint.join('/')}（${rawEndpoint} 不是允許的端點）` : FIELD_CANDIDATES.endpoint.join('/'))
  if (!accessKey) missing.push(FIELD_CANDIDATES.accessKey.join('/'))
  if (!secretKey) missing.push(FIELD_CANDIDATES.secretKey.join('/'))
  if (missing.length > 0) {
    return {
      ok: false,
      stage: 'response',
      empty: true,
      error: `storage 回應缺少 ${missing.join('、')}（收到：${keys.length > 0 ? keys.join('、') : '沒有欄位'}）`,
    }
  }
  return { ok: true, endpoint, accessKey, secretKey, defaultBucket }
}

/**
 * 查一次 BDD storage，取得 S3 連線。永不拋：失敗用 `stage` 區分
 * `config` / `credential` / `request` / `response`。
 */
async function fetchStoredConnection(options) {
  const opts = options || {}
  const env = opts.env || process.env
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS)
  const requested = opts.storageUrl || env.DSH_MINIO_S3_STORAGE_URL || DEFAULT_STORAGE_URL

  let url
  try {
    url = requireStorageUrl(requested)
  } catch (error) {
    return { ok: false, stage: 'config', error: error.message }
  }

  const credential = readMaskedCredential({ env, now: opts.now, refs: opts.refs, readFile: opts.readFile })
  if (!credential.ok) return credential

  if (typeof fetchImpl !== 'function') {
    return { ok: false, stage: 'request', error: '沒有可用的 fetch' }
  }

  let response
  let raw
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: credential.masked }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    raw = await response.text()
  } catch (error) {
    return { ok: false, stage: 'request', status: 0, error: `storage 查詢失敗：${(error && error.message) || error}` }
  }

  let payload = null
  try {
    payload = raw ? JSON.parse(raw) : null
  } catch {
    payload = null
  }

  if (response.status === 500) {
    return {
      ok: false,
      stage: 'request',
      status: 500,
      error: `storage 端點拒絕了這次請求（HTTP 500）${payload && payload.error ? '：' + payload.error : ''}`,
    }
  }
  if (!response.ok) {
    return { ok: false, stage: 'request', status: response.status, error: `storage 端點回 HTTP ${response.status}` }
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, stage: 'response', status: response.status, error: 'storage 端點沒有回 JSON' }
  }

  const connection = extractStoredConnection(payload, { allowedHosts: opts.allowedHosts })
  return connection.ok
    ? { ...connection, ref: credential.ref, source: credential.source, storageUrl: url }
    : { ...connection, status: response.status, ref: credential.ref, storageUrl: url }
}

/**
 * 連線提供者：把「查 BDD storage」與「建 S3Client」收成一個帶快取的物件。
 *
 * 快取是必要的：每個 UI 動作都會經過 `/api`，每次都打一次 storage 端點既慢
 * 又吵。失敗**不進快取**，所以下一個動作就會重試。
 */
class ConnectionProvider {
  constructor(options) {
    const opts = options || {}
    this.storageUrl = opts.storageUrl || DEFAULT_STORAGE_URL
    this.refs = opts.refs
    this.timeoutMs = opts.timeoutMs
    this.ttlMs = Number(opts.ttlMs === undefined ? DEFAULT_CACHE_TTL_MS : opts.ttlMs)
    this.fetchImpl = opts.fetchImpl
    this.readFile = opts.readFile
    this.env = opts.env
    this.region = opts.region || ''
    this.defaultBucketOverride = opts.defaultBucket || ''
    this.clientTimeoutMs = opts.clientTimeoutMs
    /** `DSH_MINIO_S3_ALLOWED_HOSTS`：端點主機白名單（空＝只擋 metadata 位址）。 */
    this.allowedHosts = Array.isArray(opts.allowedHosts)
      ? opts.allowedHosts
      : String((opts.env || process.env).DSH_MINIO_S3_ALLOWED_HOSTS || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)
    /** 最近一次成功解析出的端點：只用在「把錯誤訊息裡的內網位址洗掉」。 */
    this._lastEndpoint = ''
    this._cached = null
    this._error = null
    this._inflight = null
  }

  /** 最近一次已知的端點（可能已過快取期），給錯誤訊息清洗用。 */
  lastEndpoint() {
    if (this._lastEndpoint) return this._lastEndpoint
    return (this._cached && this._cached.endpoint) || ''
  }

  /** 目前快取的連線（不觸發查詢）；未過期才有值。 */
  peek() {
    if (!this._cached) return null
    if (this._cached.expiresAt <= Date.now()) return null
    return this._cached
  }

  /** 建立 S3Client；region 由探測／學習得到，並跨請求保留。 */
  _build(connection) {
    const client = new S3Client({
      endpoint: connection.endpoint,
      accessKey: connection.accessKey,
      secretKey: connection.secretKey,
      region: this.region || 'us-east-1',
      timeoutMs: this.clientTimeoutMs,
      // 傳下去才對：測試與外掛都靠同一個 fetch 實作（少了這個，探測會繞過
      // 注入的 fetch 去打真實網路，注入的假伺服器永遠等不到探測）。
      fetchImpl: this.fetchImpl,
      // 學到的 region 要留在 provider 上：每個請求都會新建 client，
      // 留在 client 上的話下一個請求就忘了（見 s3-client.setRegion 的說明）。
      onRegion: (region) => { this.region = region },
    })
    return { client, connection }
  }

  /**
   * 取得連線（必要時查 storage 端點），並確保 region 已知。
   *
   * region 一定要在**第一個操作之前**定下來：MinIO 對一般簽章請求寬容
   * （us-east-1 也收），但 presign 與 `POST ?delete` 會嚴格驗 region，而
   * 這兩者都不會走「失敗 → 學 region → 重試」那條路（前者由瀏覽器直接打，
   * 後者回 200）。所以這裡用一次免憑證的請求把 region 問出來。
   *
   * @param {{force?: boolean}} [options]
   * @returns {Promise<{ok: true, client: S3Client, connection: object} | {ok: false, stage: string, error: string, empty?: boolean, status?: number}>}
   */
  async get(options) {
    const opts = options || {}
    if (!opts.force) {
      const cached = this.peek()
      if (cached) {
        const built = this._build(cached)
        if (!this.region) await this._learnRegion(built.client)
        return { ok: true, ...built }
      }
    } else {
      this._cached = null
    }

    if (this._inflight) return this._inflight

    this._inflight = (async () => {
      const result = await fetchStoredConnection({
        storageUrl: this.storageUrl,
        refs: this.refs,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetchImpl,
        readFile: this.readFile,
        env: this.env,
        allowedHosts: this.allowedHosts,
      })
      this._inflight = null
      if (!result.ok) {
        this._error = result
        this._cached = null
        return result
      }
      this._lastEndpoint = result.endpoint
      const now = Date.now()
      const connection = {
        endpoint: result.endpoint,
        accessKey: result.accessKey,
        secretKey: result.secretKey,
        defaultBucket: this.defaultBucketOverride || result.defaultBucket || '',
        ref: result.ref,
        source: result.source,
        storageUrl: result.storageUrl,
        regionHint: result.region || '',
        fetchedAt: now,
        expiresAt: now + this.ttlMs,
      }
      this._cached = connection
      this._error = null
      const built = this._build(connection)
      if (!this.region) await this._learnRegion(built.client)
      return { ok: true, ...built }
    })()

    try {
      return await this._inflight
    } catch (error) {
      this._inflight = null
      return { ok: false, stage: 'request', error: `連線解析失敗：${(error && error.message) || error}` }
    }
  }

  /**
   * 問出端點 region（失敗不影響連線，退回預設值）。
   *
   * 一定要**無條件**寫回 `this.region`：若端點的 region 剛好等於預設的
   * `us-east-1`，`setRegion` 不會有變化、也就不會觸發 onRegion，於是
   * `this.region` 永遠是空的，下一個請求又會再探測一次 —— 每個請求都多一發。
   */
  async _learnRegion(client) {
    const probed = await client.probeRegion()
    if (probed) client.setRegion(probed)
    this.region = client.region
  }

  /** 丟掉快取（例如 S3 回 SignatureDoesNotMatch / 帳密輪替後）。 */
  invalidate() {
    this._cached = null
  }

  /** 上一次失敗（給 /status 顯示，不觸發查詢）。 */
  lastError() {
    return this._error
  }
}

module.exports = {
  BUCKET_FIELD,
  CREDENTIAL_REFS,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_STORAGE_URL,
  ConnectionProvider,
  FIELD_CANDIDATES,
  PWD_FIELD,
  UID_FIELD,
  URL_FIELD,
  credentialsFilePath,
  extractStoredConnection,
  fetchStoredConnection,
  maskKey,
  normalizeEndpoint,
  readCredentialRef,
  readMaskedCredential,
  requireStorageUrl,
  STORAGE_HOST,
}
