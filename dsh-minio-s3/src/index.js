'use strict'

/**
 * dsh-minio-s3 — 宿主半邊
 *
 * 兩件事：
 *   (a) 一族同源路由 `/plugins/dsh-minio-s3/*`，瀏覽器半邊的「MinIO」tab 靠它
 *       列桶／列物件／上傳／下載／預覽／刪除／改名／建資料夾；
 *   (b) 五個 agent 工具（minio_list / minio_read / minio_write / minio_delete /
 *       minio_bucket），讓對話裡可以直接管理桶裡的檔案，並在「工作區檔案 ↔
 *       物件」之間搬移。
 *
 * 為什麼 S3 帳密預設留在宿主：
 * 端點、UID、PWD 是 BDD storage 用本機 mask 過的金鑰換回來的，等同憑證。
 * 瀏覽器半邊只知道 `/plugins/dsh-minio-s3/...` 這個相對路徑；`/status` 只回
 * 「已連線 / 預設桶 / 桶清單」。
 *
 * 唯一的例外是 `POST /export`：使用者在面板上按下「複製設定」時，宿主會把
 * 端點、accessKey、secretKey、region、預設桶一起回給瀏覽器，好讓他複製成
 * JSON 貼到別的工具。那一條受自訂標頭、POST-only 與 `DSH_MINIO_S3_NO_EXPORT`
 * 三道限制；其餘任何路徑都不會有金鑰（`/status?debug=1` 只有端點與 region，
 * 沒有金鑰）。
 *
 * 為什麼路由都掛 `connection.requestRejection`：
 * 這是宿主對瀏覽器開的門。別的宿主路由（dsh-file-share、kaneo-web）都先過同一
 * 道 Host/Origin 檢查 + 瀏覽器認證；少了它，任何本機程序都能用這個外掛的
 * 憑證去讀寫 MinIO。
 *
 * region 由 connection.js 在建連線時探測（見 s3-client.probeRegion）：MinIO
 * 對一般簽章請求寬容（us-east-1 也收），但 presign 與 `POST ?delete` 嚴格驗
 * region —— 不在第一個操作之前定下來，症狀就是「列表正常、簽章連結與批次
 * 刪除忽然失敗」。
 */

const fs = require('node:fs')
const path = require('node:path')

const core = require('./core')
const { ConnectionProvider } = require('./storage')
const { isS3Error } = require('./s3')

const name = 'dsh-minio-s3'
const BASE = '/plugins/dsh-minio-s3'
/** 對外可見的版本（`/status` 會回，方便確認線上跑的是哪一版）。 */
const VERSION = '1.0.0'

/** 瀏覽器一次上傳的上限（宿主會整包放進記憶體算簽章 hash）。 */
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024
/** 工作區檔案 ↔ 物件搬移的上限。 */
const MAX_TRANSFER_BYTES = 512 * 1024 * 1024
/** 工具一次讀進模型上下文的預設／上限。 */
const TOOL_READ_DEFAULT = 256 * 1024
const TOOL_READ_MAX = 4 * 1024 * 1024
/** JSON body 的上限（delete / copy / folder 這些小請求）。 */
const JSON_BODY_MAX = 1024 * 1024

/**
 * 允許以 `inline=1` 直接回給瀏覽器的型別：**只有點陣圖**。
 *
 * 這個代理回應與 DSH 同源，而外殼沒有 CSP，所以 `text/html` 或
 * `image/svg+xml` 一旦 inline 出去，就等於在應用來源上執行任意腳本 ——
 * 那個腳本可以打 `/delete`、`/upload-path`，還有 `/export`。其餘型別一律
 * 降成 `application/octet-stream` + `attachment`，並補 `nosniff`。
 */
const INLINE_SAFE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
])

/** 等 `drain`，但客戶端斷線時也要立刻放行（destroyed response 不會發 drain）。 */
function waitForDrain(res) {
  return new Promise((resolve) => {
    const finish = () => {
      res.off('drain', finish)
      res.off('close', finish)
      resolve()
    }
    res.once('drain', finish)
    res.once('close', finish)
  })
}

const ROUTE = {
  status: BASE + '/status',
  refresh: BASE + '/refresh',
  buckets: BASE + '/buckets',
  objects: BASE + '/objects',
  object: BASE + '/object',
  del: BASE + '/delete',
  folder: BASE + '/folder',
  copy: BASE + '/copy',
  presign: BASE + '/presign',
  uploadPath: BASE + '/upload-path',
  downloadPath: BASE + '/download-path',
  exportConfig: BASE + '/export',
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    // 超限時**不要** destroy：destroy 會在回應送出前就把連線切掉，呼叫端只看到
    // 「Failed to fetch」，永遠收不到那個 413。改成停止緩衝、把剩下的位元組讀掉
    // （resume），讓 413 的 JSON 真的送得出去。
    const fail = (error) => {
      if (settled) return
      settled = true
      try { req.resume() } catch {}
      reject(error)
    }
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        fail(Object.assign(new Error(`請求內容超過上限 ${limit} bytes`), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', fail)
  })
}

async function readJson(req) {
  const raw = await readBody(req, JSON_BODY_MAX)
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw Object.assign(new Error('請求 body 不是合法 JSON'), { status: 400 })
  }
}

/** 客戶端斷線時中止上游（回傳的 signal 直接交給 S3 客戶端）。 */
function abortOnClose(req) {
  const controller = new AbortController()
  req.on('close', () => {
    try { controller.abort() } catch {}
  })
  return controller
}

/** S3 錯誤 → HTTP 狀態；其餘錯誤 500。 */
function statusOfError(error) {
  if (!isS3Error(error)) return error && error.status ? error.status : 500
  switch (error.code) {
    case 'NoSuchKey':
    case 'NoSuchBucket':
    case 'NotFound':
      return 404
    case 'AccessDenied':
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
      return 403
    case 'BucketAlreadyOwnedByYou':
    case 'BucketAlreadyExists':
    case 'BucketNotEmpty':
      return 409
    case 'ObjectTooLarge':
      return 413
    case 'NetworkError':
      return 502
    default:
      return error.status && error.status >= 400 && error.status < 600 ? error.status : 502
  }
}

/**
 * 連線階段 → 給瀏覽器看的說法。
 *
 * 面板會被截圖與分享，所以原始訊息（含憑證檔路徑、BDD storage 端點、內網
 * 主機位址）不透傳；要細節用 `GET /status?debug=1` 或宿主日誌。
 */
const CONNECTION_STAGE_TEXT = {
  credential: '本機憑證不可用',
  request: '連線服務查詢失敗',
  response: '連線服務沒有可用的資料',
  config: '連線設定不可用',
}

/** 從要回給瀏覽器的訊息裡拿掉遠端儲存位址（內網 host:port 不進 DOM／截圖）。 */
function scrubEndpoint(text, endpoint) {
  let out = String(text === undefined || text === null ? '' : text)
  if (typeof endpoint === 'string' && endpoint !== '') out = out.split(endpoint).join('遠端儲存')
  return out
}

function errorPayload(error, endpoint) {
  const payload = { ok: false, error: scrubEndpoint((error && error.message) || String(error), endpoint) }
  if (isS3Error(error)) {
    payload.code = error.code
    payload.status = error.status
    payload.operation = error.operation
  }
  return payload
}

// ---------------------------------------------------------------------------
// 工作區邊界（upload-path / download-path）
// ---------------------------------------------------------------------------

/**
 * 把「相對於會話工作區的路徑」收成一個絕對路徑，並確認它真的落在工作區內。
 *
 * 四層：詞法（不得絕對、不得 `..`）→ resolve → **逐段 lstat，任何既有的
 * 符號連結一律拒絕** → realpath 檢查最近存在的祖先。
 *
 * 為什麼需要第三層：`fs.existsSync` 對**斷掉的**符號連結回 false，所以「往上
 * 找最近存在祖先」會直接走過那個連結、檢查通過，接著 `writeFileSync` 就順著
 * 連結把檔案寫到工作區外。既有的連結與既有的目標都會被第四層擋下，只有
 * 「目標還不存在的連結」會漏 —— 而那正好是寫入路徑的形狀。
 *
 * @returns {{ok: true, abs: string} | {ok: false, status: number, error: string}}
 */
function resolveInWorkspace(root, relative) {
  const raw = String(relative === undefined || relative === null ? '' : relative).replace(/\\/g, '/')
  if (raw === '') return { ok: false, status: 400, error: 'path 不可為空' }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, status: 400, error: 'path 必須是相對於工作區的路徑' }
  }
  if (raw.split('/').includes('..')) return { ok: false, status: 400, error: 'path 不可含 ..' }

  let realRoot
  try {
    realRoot = fs.realpathSync(root)
  } catch {
    return { ok: false, status: 404, error: `工作區不存在或不可讀：${root}` }
  }

  const abs = path.resolve(realRoot, raw)

  // 第三層：逐段檢查，任何既有的符號連結都不接受（含斷掉的連結）。
  const segments = path.relative(realRoot, abs).split(path.sep).filter(Boolean)
  let walked = realRoot
  for (const segment of segments) {
    walked = path.join(walked, segment)
    let stat
    try {
      stat = fs.lstatSync(walked)
    } catch {
      break // 這一段還不存在：後面的路徑都由呼叫端建立
    }
    if (stat.isSymbolicLink()) {
      return { ok: false, status: 403, error: `路徑含符號連結：${raw}` }
    }
  }

  let probe = abs
  for (;;) {
    if (fs.existsSync(probe)) break
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  let realProbe
  try {
    realProbe = fs.realpathSync(probe)
  } catch {
    return { ok: false, status: 404, error: `路徑不存在：${raw}` }
  }
  const inside = realProbe === realRoot || realProbe.startsWith(realRoot + path.sep)
  if (!inside) return { ok: false, status: 403, error: `路徑逃出工作區：${raw}` }
  return { ok: true, abs }
}

/** sessionId → 工作區根目錄。 */
function workspaceOf(sessions, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return { ok: false, status: 400, error: '缺少 sessionId' }
  let session = null
  try {
    session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
  } catch (error) {
    return { ok: false, status: 404, error: `會話讀取失敗：${(error && error.message) || error}` }
  }
  if (!session) return { ok: false, status: 404, error: '該會話不在本實例的活動會話中' }
  const cwd = session.header && session.header.cwd
  if (typeof cwd !== 'string' || cwd === '') return { ok: false, status: 404, error: '該會話沒有工作區(cwd)' }
  let real
  try {
    real = fs.realpathSync(cwd)
  } catch {
    return { ok: false, status: 404, error: `工作區目錄不可讀：${cwd}` }
  }
  return { ok: true, cwd: real }
}

// ---------------------------------------------------------------------------
// 列表整形：S3 的一層列表 → UI/工具用的扁平形狀
// ---------------------------------------------------------------------------

function shapeListing(bucket, prefix, listing) {
  const folders = listing.commonPrefixes.map((entry) => ({
    prefix: entry,
    name: core.baseName(entry),
  }))
  const objects = listing.contents
    // 空資料夾標記（`a/`）同時出現在 CommonPrefixes 與 Contents，只留一份。
    .filter((entry) => !(core.isFolderKey(entry.key) && entry.size === 0 && folders.some((f) => f.prefix === entry.key)))
    .map((entry) => ({
      key: entry.key,
      name: core.baseName(entry.key),
      size: entry.size,
      lastModified: entry.lastModified,
      etag: entry.etag,
      storageClass: entry.storageClass,
    }))
  return {
    bucket,
    prefix,
    folders,
    objects,
    truncated: Boolean(listing.isTruncated),
    nextToken: listing.nextContinuationToken || '',
    keyCount: listing.keyCount,
  }
}

// ---------------------------------------------------------------------------
// 宿主外掛
// ---------------------------------------------------------------------------

module.exports = {
  name,
  inject: ['tools', 'webServer', 'connection', 'sessions'],
  version: VERSION,

  // 匯出給測試直接驅動（不經過 cordis）。
  resolveInWorkspace,
  shapeListing,
  ROUTE,

  apply(ctx) {
    const logger = ctx.logger || { info() {}, warn() {}, error() {} }
    const provider = new ConnectionProvider({
      storageUrl: process.env.DSH_MINIO_S3_STORAGE_URL || undefined,
      defaultBucket: process.env.DSH_MINIO_S3_BUCKET || '',
      region: process.env.DSH_MINIO_S3_REGION || '',
    })

    /** 取 S3Client；失敗時把 stage 一起帶出去，讓訊息可以指向真正的原因。 */
    async function client(force) {
      const got = await provider.get({ force: Boolean(force) })
      if (!got.ok) {
        const error = new Error(got.error || 'MinIO 連線不可用')
        error.stage = got.stage
        error.empty = got.empty
        error.status = got.status || 502
        throw error
      }
      return got.client
    }

    /** 目前已知的端點（用來把錯誤訊息裡的內網位址洗掉）。 */
    function endpointOf(instance) {
      if (instance && typeof instance.endpoint === 'string' && instance.endpoint !== '') return instance.endpoint
      const cached = provider.peek()
      return (cached && cached.endpoint) || ''
    }

    /** errorPayload，但自動帶上端點以便清洗。 */
    function payloadFor(error, instance) {
      return errorPayload(error, endpointOf(instance))
    }

    async function withClient(req, res, force, run) {
      let s3
      try {
        s3 = await client(force)
      } catch (error) {
        // 連線階段的原始訊息（憑證檔路徑、storage 端點、內網位址）只進宿主日誌。
        logger.warn('dsh-minio-s3: 連線不可用（' + (error.stage || 'config') + '）：' + error.message)
        sendJson(res, error.status || 502, {
          ok: false,
          stage: error.stage || 'config',
          empty: error.empty,
          error: CONNECTION_STAGE_TEXT[error.stage] || '連線不可用',
        })
        return
      }
      try {
        const payload = await run(s3, abortOnClose(req).signal)
        sendJson(res, 200, { ok: true, ...payload })
      } catch (error) {
        if (!isS3Error(error)) logger.warn('dsh-minio-s3: ' + ((error && error.stack) || error))
        sendJson(res, statusOfError(error), payloadFor(error, s3))
      }
    }

    // -----------------------------------------------------------------------
    // 路由
    // -----------------------------------------------------------------------

    async function handleStatus(req, res) {
      // `?debug=1` 是唯一的例外出口：連線來源、region、憑證 ref 與原始錯誤
      // 只在明示除錯時回，預設的回應裡沒有這些內部位址（面板會把它畫出來，
      // 而面板是會被截圖的）。
      const url = new URL(req.url || '/', 'http://dsh.local')
      const debug = url.searchParams.get('debug') === '1'

      const got = await provider.get()
      if (!got.ok) {
        logger.warn('dsh-minio-s3: 連線不可用（' + (got.stage || 'config') + '）：' + (got.error || ''))
        sendJson(res, 200, {
          ok: false,
          configured: false,
          version: VERSION,
          stage: got.stage,
          empty: Boolean(got.empty),
          error: CONNECTION_STAGE_TEXT[got.stage] || '連線不可用',
          ...(debug ? { detail: got.error } : {}),
        })
        return
      }
      const connection = got.connection
      let buckets = []
      let listError = null
      try {
        buckets = await got.client.listBuckets()
      } catch (error) {
        listError = payloadFor(error, got.client)
      }
      sendJson(res, 200, {
        ok: true,
        configured: true,
        version: VERSION,
        bucket: connection.defaultBucket || '',
        buckets,
        listError,
        ...(debug
          ? {
              region: got.client.region,
              ref: connection.ref,
              source: connection.storageUrl,
            }
          : {}),
      })
    }

    async function handleRefresh(req, res) {
      provider.invalidate()
      await handleStatus(req, res)
    }

    async function handleBuckets(req, res) {
      if (req.method === 'GET') {
        await withClient(req, res, false, async (s3) => ({ buckets: await s3.listBuckets() }))
        return
      }
      const url = new URL(req.url || '/', 'http://dsh.local')
      const target = core.checkTarget(url.searchParams.get('bucket'), '', { allowEmptyKey: true })
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      if (req.method === 'PUT') {
        await withClient(req, res, false, async (s3) => s3.createBucket(target.bucket))
        return
      }
      if (req.method === 'DELETE') {
        await withClient(req, res, false, async (s3) => s3.deleteBucket(target.bucket))
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }

    async function handleObjects(req, res) {
      const url = new URL(req.url || '/', 'http://dsh.local')
      const bucket = url.searchParams.get('bucket')
      const target = core.checkTarget(bucket, '', { allowEmptyKey: true })
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      const prefix = core.normalizePrefix(url.searchParams.get('prefix'))
      const delimiterParam = url.searchParams.get('delimiter')
      const delimiter = delimiterParam === null ? '/' : delimiterParam
      const token = url.searchParams.get('token') || undefined
      await withClient(req, res, false, async (s3) => {
        const listing = await s3.listObjectsV2({ bucket: target.bucket, prefix, delimiter, continuationToken: token })
        return shapeListing(target.bucket, prefix, listing)
      })
    }

    async function handleObject(req, res) {
      const url = new URL(req.url || '/', 'http://dsh.local')
      const target = core.checkTarget(url.searchParams.get('bucket'), url.searchParams.get('key'))
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        let s3
        try {
          s3 = await client(false)
        } catch (error) {
          logger.warn('dsh-minio-s3: 連線不可用（' + (error.stage || 'config') + '）：' + error.message)
          sendJson(res, error.status || 502, {
            ok: false,
            stage: error.stage || 'config',
            error: CONNECTION_STAGE_TEXT[error.stage] || '連線不可用',
          })
          return
        }
        const inline = url.searchParams.get('inline') === '1'

        // HEAD 走上游的 HEAD：用 GET 再丟掉 body 會讓整個物件白跑一趟，
        // 而且那個沒人讀的 body 得等連線逾時才歸還 socket。
        if (req.method === 'HEAD') {
          try {
            const meta = await s3.headObject(target.bucket, target.key)
            const headers = {
              'content-type': meta.contentType || 'application/octet-stream',
              'content-length': String(meta.size),
              'cache-control': 'no-store',
            }
            if (meta.etag) headers.etag = '"' + meta.etag + '"'
            res.writeHead(200, headers)
            res.end()
          } catch (error) {
            sendJson(res, statusOfError(error), payloadFor(error, s3))
          }
          return
        }

        // 客戶端斷線就中止上游：沒有這個，處理器會卡在等 `drain`（已 destroy 的
        // ServerResponse 永遠不會發出 drain），上游 socket 也跟著懸在那裡。
        const abort = new AbortController()
        const onClose = () => abort.abort()
        req.on('close', onClose)

        let upstream
        try {
          upstream = await s3.getObject({
            bucket: target.bucket,
            key: target.key,
            stream: true,
            signal: abort.signal,
          })
        } catch (error) {
          req.off('close', onClose)
          sendJson(res, statusOfError(error), payloadFor(error, s3))
          return
        }

        // inline 只放**點陣圖**：這個代理回應與 DSH 同源，而外殼沒有 CSP。
        // 讓 text/html 或 image/svg+xml 以 inline 出去，等於在應用來源上跑
        // 任意腳本（那個腳本可以打 /delete、/upload-path，還有 /export）。
        // 其餘型別一律 octet-stream + attachment，並補 nosniff。
        const upstreamType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        const inlineSafe = inline && INLINE_SAFE_TYPES.has(upstreamType)
        const headers = {
          'content-type': inlineSafe
            ? (upstream.headers.get('content-type') || 'application/octet-stream')
            : (inline ? 'application/octet-stream' : (upstream.headers.get('content-type') || 'application/octet-stream')),
          'content-length': upstream.headers.get('content-length') || '',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          etag: upstream.headers.get('etag') || '',
        }
        if (!inlineSafe) {
          headers['content-disposition'] = 'attachment; filename*=UTF-8\'\'' + encodeURIComponent(core.baseName(target.key))
        }
        for (const key of Object.keys(headers)) if (headers[key] === '') delete headers[key]
        res.writeHead(200, headers)
        const reader = upstream.body && typeof upstream.body.getReader === 'function' ? upstream.body.getReader() : null
        if (!reader) {
          res.end(Buffer.from(await upstream.arrayBuffer()))
          req.off('close', onClose)
          return
        }
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (!res.write(Buffer.from(value))) await waitForDrain(res)
            if (abort.signal.aborted) break
          }
        } catch (error) {
          // 串流中斷：標頭已經送出去了，只能斷線讓瀏覽器知道下載不完整。
          if (!abort.signal.aborted) logger.warn('dsh-minio-s3: 下載串流中斷 ' + ((error && error.message) || error))
        } finally {
          req.off('close', onClose)
          if (abort.signal.aborted) {
            try { await reader.cancel() } catch {}
          }
          res.end()
        }
        return
      }

      if (req.method === 'PUT') {
        let body
        try {
          body = await readBody(req, MAX_UPLOAD_BYTES)
        } catch (error) {
          sendJson(res, error.status || 413, { ok: false, error: error.message })
          return
        }
        const contentType = url.searchParams.get('contentType') || req.headers['content-type'] || 'application/octet-stream'
        await withClient(req, res, false, async (s3, signal) => s3.putObject({
          bucket: target.bucket,
          key: target.key,
          body,
          contentType,
          signal,
        }))
        return
      }

      if (req.method === 'DELETE') {
        await withClient(req, res, false, async (s3, signal) => s3.deleteObject(target.bucket, target.key, { signal }))
        return
      }

      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    }

    async function handleDelete(req, res) {
      const payload = await readJson(req)
      const target = core.checkTarget(payload.bucket, '', { allowEmptyKey: true })
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      const keys = Array.isArray(payload.keys) ? payload.keys : (typeof payload.key === 'string' ? [payload.key] : [])
      if (keys.length === 0) {
        sendJson(res, 400, { ok: false, error: '需要 key 或 keys' })
        return
      }
      for (const key of keys) {
        const checked = core.checkTarget(target.bucket, key)
        if (!checked.ok) {
          sendJson(res, 400, { ok: false, error: checked.error })
          return
        }
      }
      await withClient(req, res, false, async (s3, signal) => {
        const result = await s3.deleteObjects(target.bucket, keys, { signal })
        const failures = result.errors || []
        if (failures.length === 0) return { requested: keys.length, ...result }

        // 逐 key 失敗時退回單物件刪除。
        //
        // `POST ?delete` 是 S3 裡簽章路徑最特別的一個（MinIO 對它的 region 檢查
        // 比 `DELETE /object` 嚴），而它「HTTP 200 + 逐 key errors」的形狀讓呼叫端
        // 很容易把它當成成功 —— 使用者的症狀就是「改名之後出現兩個檔案」與
        // 「刪除無效」。這裡在宿主就把退路做掉，任何呼叫端（含還沒更新的瀏覽器
        // 模組）都不會再拿到「假成功」。
        const deleted = [...(result.deleted || [])]
        const remaining = []
        for (const entry of failures) {
          const key = entry && entry.key
          if (!key) { remaining.push(entry); continue }
          try {
            await s3.deleteObject(target.bucket, key, { signal })
            deleted.push(key)
          } catch (error) {
            remaining.push({ ...entry, message: `${entry.message || ''}（逐一刪除也失敗：${(error && error.message) || error}）` })
          }
        }
        return { requested: keys.length, deleted, errors: remaining, retried: failures.length }
      })
    }

    async function handleFolder(req, res) {
      const payload = await readJson(req)
      const key = core.normalizePrefix(payload.key === undefined ? payload.prefix : payload.key)
      const target = core.checkTarget(payload.bucket, key)
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      await withClient(req, res, false, async (s3) => s3.putObject({
        bucket: target.bucket,
        key: target.key,
        body: Buffer.alloc(0),
        contentType: 'application/x-directory',
      }))
    }

    async function handleCopy(req, res) {
      const payload = await readJson(req)
      const from = core.checkTarget(payload.bucket, payload.fromKey === undefined ? payload.key : payload.fromKey)
      if (!from.ok) {
        sendJson(res, 400, { ok: false, error: '來源：' + from.error })
        return
      }
      const to = core.checkTarget(payload.bucket, payload.toKey === undefined ? payload.newKey : payload.toKey)
      if (!to.ok) {
        sendJson(res, 400, { ok: false, error: '目標：' + to.error })
        return
      }
      await withClient(req, res, false, async (s3) => {
        await s3.copyObject({ bucket: from.bucket, fromKey: from.key, toKey: to.key })
        return { bucket: from.bucket, fromKey: from.key, toKey: to.key, copied: true }
      })
    }

    async function handlePresign(req, res) {
      const url = new URL(req.url || '/', 'http://dsh.local')
      const target = core.checkTarget(url.searchParams.get('bucket'), url.searchParams.get('key'))
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      const expiresRaw = Number(url.searchParams.get('expires'))
      const expires = Number.isFinite(expiresRaw) && expiresRaw > 0
        ? Math.min(604800, Math.floor(expiresRaw))
        : 3600
      await withClient(req, res, false, async (s3) => {
        const signed = s3.presignObject({ bucket: target.bucket, key: target.key, expires })
        return { url: signed, expires, bucket: target.bucket, key: target.key }
      })
    }

    /**
     * 匯出連線設定（含金鑰）給瀏覽器，讓使用者一鍵複製成 JSON。
     *
     * 這是 `/status` 之外**唯一**會把端點與金鑰送進瀏覽器的路徑，而且是使用者
     * 在面板上明示按下的動作（POST、不經 GET，避免被預取或快取）。平常那些
     * 欄位不出現在任何瀏覽器可見的回應裡。
     *
     * 只記「有人匯出過」，不記內容 —— 金鑰不進日誌。
     */
    async function handleExport(req, res) {
      // 這是全外掛唯一會把金鑰交給瀏覽器的地方，所以多兩道：
      //   1. `DSH_MINIO_S3_NO_EXPORT=1` 可以整個關掉（維運面的斷路器）；
      //   2. 要求一個自訂標頭 + JSON content-type —— 跨站表單或 <img> 這種
      //      「簡單請求」帶不出自訂標頭，必須先過 CORS 預檢，而信任柵欄本來
      //      就會拒絕外來 Origin。擋不掉同源腳本（那需要 CSP，不在外掛手上），
      //      但讓它不是「隨手一個 POST 就拿到金鑰」。
      if (process.env.DSH_MINIO_S3_NO_EXPORT === '1') {
        sendJson(res, 403, { ok: false, error: '此部署已停用匯出（DSH_MINIO_S3_NO_EXPORT=1）' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (String(req.headers['x-dsh-minio-s3'] || '') !== 'export') {
        sendJson(res, 400, { ok: false, error: '缺少 X-DSH-MinIO-S3: export 標頭' })
        return
      }
      const got = await provider.get()
      if (!got.ok) {
        logger.warn('dsh-minio-s3: 連線不可用（' + (got.stage || 'config') + '）：' + (got.error || ''))
        sendJson(res, got.status || 502, {
          ok: false,
          stage: got.stage || 'config',
          error: CONNECTION_STAGE_TEXT[got.stage] || '連線不可用',
        })
        return
      }
      const connection = got.connection
      let buckets = []
      try {
        buckets = (await got.client.listBuckets()).map((entry) => entry.name)
      } catch {
        // 桶清單只是附加資訊；拿不到不影響匯出的憑證與設定。
      }
      logger.info('dsh-minio-s3: 使用者匯出了連線設定（含金鑰）')
      sendJson(res, 200, {
        ok: true,
        provider: 'minio',
        endpoint: connection.endpoint,
        accessKey: connection.accessKey,
        secretKey: connection.secretKey,
        region: got.client.region,
        bucket: connection.defaultBucket || '',
        usePathStyle: true,
        forcePathStyle: true,
        buckets,
        exportedAt: new Date().toISOString(),
      })
    }

    async function handleUploadPath(req, res) {
      const payload = await readJson(req)
      const workspace = workspaceOf(ctx.sessions, payload.sessionId)
      if (!workspace.ok) {
        sendJson(res, workspace.status, { ok: false, error: workspace.error })
        return
      }
      const resolved = resolveInWorkspace(workspace.cwd, payload.path)
      if (!resolved.ok) {
        sendJson(res, resolved.status, { ok: false, error: resolved.error })
        return
      }
      let stat
      try {
        stat = fs.statSync(resolved.abs)
      } catch {
        sendJson(res, 404, { ok: false, error: `工作區檔案不存在：${payload.path}` })
        return
      }
      if (!stat.isFile()) {
        sendJson(res, 400, { ok: false, error: '只能上傳檔案（不是目錄）' })
        return
      }
      if (stat.size > MAX_TRANSFER_BYTES) {
        sendJson(res, 413, { ok: false, error: `檔案 ${stat.size} bytes 超過搬移上限` })
        return
      }
      const key = payload.key ? String(payload.key) : core.normalizePrefix(payload.prefix) + path.basename(resolved.abs)
      const target = core.checkTarget(payload.bucket, key)
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      await withClient(req, res, false, async (s3, signal) => {
        const body = fs.readFileSync(resolved.abs)
        const put = await s3.putObject({
          bucket: target.bucket,
          key: target.key,
          body,
          contentType: payload.contentType || 'application/octet-stream',
          signal,
        })
        return { ...put, from: payload.path, source: stat.size }
      })
    }

    async function handleDownloadPath(req, res) {
      const payload = await readJson(req)
      const workspace = workspaceOf(ctx.sessions, payload.sessionId)
      if (!workspace.ok) {
        sendJson(res, workspace.status, { ok: false, error: workspace.error })
        return
      }
      const target = core.checkTarget(payload.bucket, payload.key)
      if (!target.ok) {
        sendJson(res, 400, { ok: false, error: target.error })
        return
      }
      const relative = payload.path ? String(payload.path) : core.baseName(target.key)
      const resolved = resolveInWorkspace(workspace.cwd, relative)
      if (!resolved.ok) {
        sendJson(res, resolved.status, { ok: false, error: resolved.error })
        return
      }
      await withClient(req, res, false, async (s3, signal) => {
        const object = await s3.getObject({ bucket: target.bucket, key: target.key, maxBytes: MAX_TRANSFER_BYTES, signal })
        // 被中止就不要留下半套檔案。
        if (signal && signal.aborted) throw new Error('已取消')
        fs.mkdirSync(path.dirname(resolved.abs), { recursive: true })
        fs.writeFileSync(resolved.abs, object.body)
        return {
          bucket: target.bucket,
          key: target.key,
          path: relative,
          bytes: object.body.length,
          contentType: object.contentType,
        }
      })
    }

    // -----------------------------------------------------------------------
    // 掛路由
    // -----------------------------------------------------------------------

    const webServer = ctx.webServer
    const connection = ctx.connection
    const table = [
      [ROUTE.status, handleStatus],
      [ROUTE.refresh, handleRefresh],
      [ROUTE.buckets, handleBuckets],
      [ROUTE.objects, handleObjects],
      [ROUTE.object, handleObject],
      [ROUTE.del, handleDelete],
      [ROUTE.folder, handleFolder],
      [ROUTE.copy, handleCopy],
      [ROUTE.presign, handlePresign],
      [ROUTE.uploadPath, handleUploadPath],
      [ROUTE.downloadPath, handleDownloadPath],
      [ROUTE.exportConfig, handleExport],
    ]

    for (const [routePath, handler] of table) {
      // 與 dsh-file-share 同一種寫法：`ctx.effect(...)` 立刻呼叫這個回呼，
      // 並把它回傳的 disposer 綁在這條 fiber 上（外掛卸載時路由一起消失）。
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          // 與其它宿主路由同一道信任柵欄。
          const rejection = connection && typeof connection.requestRejection === 'function'
            ? connection.requestRejection(req)
            : undefined
          if (rejection !== undefined) {
            res.writeHead(rejection)
            res.end()
            return
          }
          try {
            await handler(req, res)
          } catch (error) {
            if (!isS3Error(error)) logger.warn('dsh-minio-s3: ' + ((error && error.stack) || error))
            if (!res.headersSent) sendJson(res, statusOfError(error) || 500, payloadFor(error))
            else try { res.end() } catch {}
          }
        },
      }), 'dsh-minio-s3: route ' + routePath)
    }

    // -----------------------------------------------------------------------
    // agent 工具（宿主平面註冊：整個 profile 的會話都看得到，與 fdep_call 同款）
    // -----------------------------------------------------------------------

    const OUTPUT = {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
        return [{ type: 'text', text }]
      },
    }

    /** 工具裡要用 sessionId 找工作區：agent 的 id 就是 sessionId。 */
    function agentWorkspace(exec) {
      const sessionId = exec && exec.agent && exec.agent.id
      return workspaceOf(ctx.sessions, sessionId)
    }

    function requireBucket(args) {
      const bucket = args && typeof args.bucket === 'string' ? args.bucket.trim() : ''
      if (bucket === '') throw new Error('bucket 不可為空')
      return bucket
    }

    ctx.tools.register({
      name: 'minio_list',
      description:
        'List the remote MinIO/S3 storage managed by this profile. Omit `bucket` to list buckets; '
        + 'give a `bucket` to list one level of objects under `prefix` (folders come back as `folders`, '
        + 'objects as `objects`). The connection comes from the BDD storage record `/BDD/API/AI/dsh/storage/s3`; '
        + 'no credentials are needed from the caller.',
      parameters: {
        type: 'object',
        properties: {
          bucket: { type: 'string', description: 'Bucket name. Omit to list buckets instead.' },
          prefix: { type: 'string', description: 'Folder prefix to list, e.g. "logs/2026/". Empty = bucket root.' },
          recursive: { type: 'boolean', description: 'true lists every object under prefix instead of one level.' },
          max: { type: 'integer', description: 'Max entries to return (default 200, cap 1000).' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      timeoutMs: 60000,
      isConcurrencySafe() { return true },
      async execute(args, exec) {
        const params = args || {}
        const signal = exec && exec.signal
        const s3 = await client(false)
        if (!params.bucket) {
          const buckets = await s3.listBuckets({ signal })
          // 不回端點：工具結果會留在對話裡（使用者可見），內網位址不必出現。
          return { buckets }
        }
        const bucket = requireBucket(params)
        const prefix = core.normalizePrefix(params.prefix)
        const delimiter = params.recursive === true ? '' : '/'
        const max = Math.max(1, Math.min(1000, Number(params.max || 200)))
        const listing = await s3.listObjectsV2({ bucket, prefix, delimiter, maxKeys: Math.min(1000, max), signal })
        const shaped = shapeListing(bucket, prefix, listing)
        return {
          bucket,
          prefix,
          folders: shaped.folders.slice(0, max).map((entry) => entry.prefix),
          objects: shaped.objects.slice(0, max),
          truncated: shaped.truncated || shaped.objects.length + shaped.folders.length > max,
          nextToken: shaped.nextToken,
        }
      },
    })

    ctx.tools.register({
      name: 'minio_read',
      description:
        'Read one object from the remote MinIO/S3 storage. Returns text by default (with `encoding: "base64"` '
        + 'for binary) and refuses anything above maxBytes. Give `toPath` to save the object into the current '
        + 'session workspace instead — then read it with the normal file tools.',
      parameters: {
        type: 'object',
        properties: {
          bucket: { type: 'string', description: 'Bucket name.' },
          key: { type: 'string', description: 'Object key, e.g. "logs/app.txt".' },
          toPath: { type: 'string', description: 'Workspace-relative path to save the object to (creates parent folders).' },
          maxBytes: { type: 'integer', description: `Inline read cap (default ${TOOL_READ_DEFAULT}, cap ${TOOL_READ_MAX}).` },
          encoding: { type: 'string', enum: ['text', 'base64'], description: 'How to return the bytes (default text).' },
        },
        required: ['bucket', 'key'],
        additionalProperties: false,
      },
      output: OUTPUT,
      timeoutMs: 120000,
      isConcurrencySafe() { return true },
      async execute(args, exec) {
        const params = args || {}
        const signal = exec && exec.signal
        const bucket = requireBucket(params)
        const target = core.checkTarget(bucket, params.key)
        if (!target.ok) throw new Error(target.error)
        const s3 = await client(false)

        if (params.toPath) {
          const workspace = agentWorkspace(exec)
          if (!workspace.ok) throw new Error(workspace.error)
          const resolved = resolveInWorkspace(workspace.cwd, params.toPath)
          if (!resolved.ok) throw new Error(resolved.error)
          const object = await s3.getObject({ bucket, key: target.key, maxBytes: MAX_TRANSFER_BYTES, signal })
          // 被中止就不要留下半套檔案。
          if (signal && signal.aborted) throw new Error('已取消')
          fs.mkdirSync(path.dirname(resolved.abs), { recursive: true })
          fs.writeFileSync(resolved.abs, object.body)
          return { bucket, key: target.key, path: params.toPath, bytes: object.body.length, contentType: object.contentType }
        }

        const maxBytes = Math.max(1, Math.min(TOOL_READ_MAX, Number(params.maxBytes || TOOL_READ_DEFAULT)))
        const object = await s3.getObject({ bucket, key: target.key, maxBytes, signal })
        const asBase64 = params.encoding === 'base64'
        return {
          bucket,
          key: target.key,
          bytes: object.body.length,
          contentType: object.contentType,
          lastModified: object.lastModified,
          encoding: asBase64 ? 'base64' : 'text',
          content: asBase64 ? object.body.toString('base64') : object.body.toString('utf8'),
        }
      },
    })

    ctx.tools.register({
      name: 'minio_write',
      description:
        'Write one object into the remote MinIO/S3 storage. Pass `content` for inline text, or `fromPath` '
        + '(workspace-relative) to upload a local file. A key ending in "/" creates an empty folder marker.',
      parameters: {
        type: 'object',
        properties: {
          bucket: { type: 'string', description: 'Bucket name.' },
          key: { type: 'string', description: 'Object key. End with "/" to create a folder.' },
          content: { type: 'string', description: 'Inline content (text or base64 when encoding="base64").' },
          fromPath: { type: 'string', description: 'Workspace-relative file to upload; wins over content.' },
          encoding: { type: 'string', enum: ['text', 'base64'], description: 'How to read `content` (default text).' },
          contentType: { type: 'string', description: 'Content-Type to store, e.g. "application/json".' },
        },
        required: ['bucket', 'key'],
        additionalProperties: false,
      },
      output: OUTPUT,
      timeoutMs: 120000,
      isConcurrencySafe() { return true },
      async execute(args, exec) {
        const params = args || {}
        const signal = exec && exec.signal
        const bucket = requireBucket(params)
        const target = core.checkTarget(bucket, params.key)
        if (!target.ok) throw new Error(target.error)
        const s3 = await client(false)

        let body
        let source = 'content'
        if (params.fromPath) {
          const workspace = agentWorkspace(exec)
          if (!workspace.ok) throw new Error(workspace.error)
          const resolved = resolveInWorkspace(workspace.cwd, params.fromPath)
          if (!resolved.ok) throw new Error(resolved.error)
          const stat = fs.statSync(resolved.abs)
          if (!stat.isFile()) throw new Error('fromPath 不是檔案')
          if (stat.size > MAX_TRANSFER_BYTES) throw new Error(`檔案 ${stat.size} bytes 超過上限`)
          body = fs.readFileSync(resolved.abs)
          source = params.fromPath
        } else if (params.content !== undefined && params.content !== null) {
          body = params.encoding === 'base64'
            ? Buffer.from(String(params.content), 'base64')
            : Buffer.from(String(params.content), 'utf8')
        } else if (core.isFolderKey(target.key)) {
          body = Buffer.alloc(0)
          source = 'folder-marker'
        } else {
          throw new Error('需要 content 或 fromPath（或把 key 以 "/" 結尾來建立資料夾）')
        }
        if (signal && signal.aborted) throw new Error('已取消')

        const put = await s3.putObject({
          bucket,
          key: target.key,
          body,
          contentType: params.contentType || (target.key.endsWith('/') ? 'application/x-directory' : undefined),
          signal,
        })
        return { bucket, key: target.key, bytes: put.size, etag: put.etag, source }
      },
    })

    ctx.tools.register({
      name: 'minio_delete',
      description:
        'Delete objects from the remote MinIO/S3 storage. Give `key` for one object or `keys` for up to 1000. '
        + 'Deleting a key that does not exist reports success (S3 semantics); use minio_list to confirm.',
      parameters: {
        type: 'object',
        properties: {
          bucket: { type: 'string', description: 'Bucket name.' },
          key: { type: 'string', description: 'Single object key.' },
          keys: { type: 'array', items: { type: 'string' }, description: 'Up to 1000 object keys.' },
        },
        required: ['bucket'],
        additionalProperties: false,
      },
      output: OUTPUT,
      timeoutMs: 60000,
      isConcurrencySafe() { return true },
      async execute(args, exec) {
        const params = args || {}
        const signal = exec && exec.signal
        const bucket = requireBucket(params)
        const keys = Array.isArray(params.keys) ? params.keys : (typeof params.key === 'string' ? [params.key] : [])
        if (keys.length === 0) throw new Error('需要 key 或 keys')
        for (const key of keys) {
          const checked = core.checkTarget(bucket, key)
          if (!checked.ok) throw new Error(checked.error)
        }
        const s3 = await client(false)
        const result = await s3.deleteObjects(bucket, keys, { signal })
        return { bucket, requested: keys.length, deleted: result.deleted, errors: result.errors }
      },
    })

    ctx.tools.register({
      name: 'minio_bucket',
      description:
        'Manage MinIO/S3 buckets in the remote storage: action "list" (default), "create", or "delete" '
        + '(delete only works on an empty bucket).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'create', 'delete'], description: 'Bucket operation (default list).' },
          bucket: { type: 'string', description: 'Bucket name (required for create/delete).' },
        },
        additionalProperties: false,
      },
      output: OUTPUT,
      timeoutMs: 60000,
      isConcurrencySafe() { return true },
      async execute(args, exec) {
        const params = args || {}
        const action = params.action || 'list'
        const signal = exec && exec.signal
        const s3 = await client(false)
        if (action === 'list') return { buckets: await s3.listBuckets({ signal }) }
        const bucket = requireBucket(params)
        if (action === 'create') return s3.createBucket(bucket, { signal })
        if (action === 'delete') return s3.deleteBucket(bucket, { signal })
        throw new Error('action 必須是 list / create / delete')
      },
    })

    logger.info('dsh-minio-s3: 已掛載 ' + table.length + ' 條路由與 5 個工具')
  },
}
