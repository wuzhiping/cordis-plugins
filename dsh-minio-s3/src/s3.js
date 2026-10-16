'use strict'

/**
 * dsh-minio-s3 — S3/MinIO REST 客戶端（零依賴，只用 fetch + s3-core 的簽章）
 *
 * 只實作這個外掛真正需要的一組操作：桶的清單/建立/刪除，物件的一層列表、
 * 讀、寫、複製、批次刪除、presign。沒有 multipart、沒有 lifecycle、沒有
 * ACL —— 那些不是「管理桶裡面的檔案」的最低需求。
 *
 * 路徑一律 **path-style**（`http://host:7000/bucket/key`）：MinIO 的預設部署
 * 就是 path-style，而 virtual-host 風格需要 DNS 泛解析，在內網 IP 上做不到。
 */

const core = require('./core')
const crypto = require('node:crypto')

/** 預設 region。MinIO 有自己的 region 設定；錯的時候回應會帶 `<Region>`，會被自動學會。 */
const DEFAULT_REGION = 'us-east-1'

/** 一次請求的時間預算。 */
const DEFAULT_TIMEOUT_MS = 30000

/** 物件讀取（進記憶體）的預設上限：避免一次 GET 把宿主吃掉。 */
const DEFAULT_MAX_READ = 8 * 1024 * 1024

/**
 * 超過這個大小的 PUT 不再套用「等標頭」的時間預算。
 *
 * 下載可以把「等標頭」與「傳 body」分開（標頭一到就 clearTimeout），但上傳
 * 不行：body 是在 `fetch()` 解析出回應標頭**之前**送完的。所以要嘛給大檔案
 * 一個獨立的長預算，要嘛不計時 —— 這裡選後者，改由呼叫端的 signal 界定
 * （工具呼叫有 timeoutMs、瀏覽器斷線會 abort）。
 */
const LARGE_BODY_BYTES = 8 * 1024 * 1024

/** 把 S3 錯誤文件包成一個帶欄位的 Error，讓上層可以直接對 code 反應。 */
class S3Error extends Error {
  constructor(info, context) {
    // 訊息裡帶上 S3 的 Code：工具的回傳與日誌都只有 message，少了它，
    // 「NoSuchKey」與「AccessDenied」會退化成同一句模糊的說明。
    const prefix = context && context.operation ? '[' + context.operation + '] ' : ''
    const code = info.code ? info.code + (info.message ? ': ' : '') : ''
    super(prefix + code + (info.message || ''))
    this.name = 'S3Error'
    this.code = info.code || 'S3Error'
    this.status = info.status || 0
    this.region = info.region || ''
    this.resource = info.resource || ''
    this.requestId = info.requestId || ''
    this.operation = (context && context.operation) || ''
    this.body = (context && context.body) || ''
  }
}

/** S3 回應轉成標準 Error（給測試與上層判斷用）。 */
function isS3Error(error) {
  return error instanceof S3Error || (error && error.name === 'S3Error')
}

/** XML 文字節點轉義（五個標準實體）。 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

class S3Client {
  /**
   * @param {object} options
   * @param {string} options.endpoint 例如 `http://10.17.26.8:7000`
   * @param {string} options.accessKey
   * @param {string} options.secretKey
   * @param {string} [options.region]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.fetchImpl]
   */
  constructor(options) {
    const opts = options || {}
    const endpoint = String(opts.endpoint || '').replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(endpoint)) {
      throw new Error(`S3 endpoint 必須是 http(s) URL：${opts.endpoint}`)
    }
    this.endpoint = endpoint
    this.accessKey = String(opts.accessKey || '')
    this.secretKey = String(opts.secretKey || '')
    this.region = String(opts.region || DEFAULT_REGION)
    this.timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS)
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new Error('沒有可用的 fetch')
    /** region 變更的觀察者（讓連線提供者能把學到的 region 留給下一個 client）。 */
    this.onRegion = typeof opts.onRegion === 'function' ? opts.onRegion : null
    /** 最近一次成功請求洩漏出來的 region（給 /status 顯示）。 */
    this.learnedRegion = null
  }

  /**
   * 換 region 並通知觀察者。
   *
   * 為什麼需要通知：宿主每一次 `/api` 呼叫都會用同一份快取連線**新建**一個
   * S3Client，只把學到的 region 留在 client 上，下一個請求就忘了 —— 而
   * MinIO 對「一般簽章請求」寬容（us-east-1 也收），只有 presign 與
   * `POST ?delete` 會嚴格驗 region。於是症狀是：列物件正常、預覽正常，但
   * 簽章連結與批次刪除忽然失敗。
   */
  setRegion(region) {
    const next = String(region || '').trim()
    if (next === '' || next === this.region) return false
    this.region = next
    if (this.onRegion) {
      try { this.onRegion(next) } catch {}
    }
    return true
  }

  /**
   * 問出端點的 region。
   *
   * MinIO 對**未簽章**的請求回 `403 AccessDenied` 並在錯誤文件裡帶
   * `<Region>us-west-rack-2</Region>`；AWS S3 的同一個回應不含 Region。
   * 一次便宜、不需要憑證的請求就能把 region 定下來，不必等到某個操作
   * （presign / 批次刪除）失敗才學。
   *
   * @returns {Promise<string|null>} 學到的 region，問不出來回 null
   */
  async probeRegion(options) {
    const opts = options || {}
    try {
      const response = await this.fetchImpl(this.endpoint + '/', {
        method: 'GET',
        signal: opts.signal || AbortSignal.timeout(this.timeoutMs),
      })
      if (response.ok) return null
      const info = core.parseS3Error(await response.text(), response.status)
      return info.region || null
    } catch {
      return null
    }
  }

  /** bucket + key → 完整 URL（path-style，key 的 `/` 保留為層級）。 */
  objectUrl(bucket, key) {
    let path = ''
    if (bucket) path += '/' + core.uriEncode(bucket)
    if (key) path += '/' + core.uriEncodePath(key)
    return this.endpoint + (path === '' ? '/' : path)
  }

  /** 加上查詢參數（值由 URL API 負責編碼；簽章時再從 searchParams 取回原值）。 */
  withQuery(url, pairs) {
    const parsed = new URL(url)
    for (const pair of pairs || []) {
      if (!pair || pair[1] === undefined || pair[1] === null) continue
      parsed.searchParams.set(pair[0], String(pair[1]))
    }
    return parsed.toString()
  }

  /**
   * 送出一次已簽章的請求。
   *
   * region 自動修正：MinIO 以自己設定的 region 驗簽，第一次用預設值簽會被
   * 回 `AuthorizationHeaderMalformed` + `<Region>`；學會它再重試一次，讓
   * 部署端的 region 設定不必外洩到這個外掛的設定面。
   *
   * @returns {Promise<Response>} 成功（2xx）的回應
   */
  async send(options) {
    const operation = options.operation || 'request'
    const method = String(options.method || 'GET').toUpperCase()
    const body = options.body === undefined ? null : options.body
    const budget = options.timeoutMs === undefined ? this.timeoutMs : Number(options.timeoutMs)
    let lastError = null

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const signed = core.signRequest({
        method,
        url: options.url,
        headers: options.headers || {},
        body,
        accessKey: this.accessKey,
        secretKey: this.secretKey,
        region: this.region,
        service: 's3',
        now: options.now,
      })

      // 時間預算只用來等「標頭」。`AbortSignal.timeout()` 會在整個 body 傳輸
      // 期間繼續計時，於是任何超過 30 秒的下載都會在串流中途被切斷（宿主已經
      // 送了 200 + content-length，只能收得殘缺）。這裡改成自己控制的
      // AbortController：`fetch()` 一解析出標頭就 clearTimeout，body 之後愛
      // 多久就多久；呼叫端要中止請給 `signal`（例如瀏覽器斷線）。
      const controller = new AbortController()
      const timer = budget > 0 ? setTimeout(() => controller.abort(), budget) : null
      const signals = [controller.signal]
      if (options.signal) signals.push(options.signal)

      const init = {
        method,
        headers: signed.headers,
        signal: signals.length === 1 ? controller.signal : AbortSignal.any(signals),
      }
      if (body !== null && body !== undefined) init.body = body

      let response
      try {
        response = await this.fetchImpl(options.url, init)
      } catch (error) {
        const timedOut = controller.signal.aborted && !(options.signal && options.signal.aborted)
        throw new S3Error(
          {
            code: timedOut ? 'RequestTimeout' : 'NetworkError',
            message: timedOut
              ? `${method} 遠端儲存請求逾時（${budget}ms）`
              : `${method} 遠端儲存請求失敗：${(error && error.message) || error}`,
            status: 0,
          },
          { operation },
        )
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (response.ok) {
        this.learnedRegion = this.region
        return response
      }

      const text = await response.text().catch(() => '')
      const info = core.parseS3Error(text, response.status)
      const regionHint = info.region
      if (attempt === 0 && regionHint && regionHint !== this.region) {
        this.setRegion(regionHint)
        lastError = new S3Error(info, { operation, body: text })
        continue
      }
      throw new S3Error(info, { operation, body: text })
    }

    throw lastError || new S3Error({ code: 'S3Error', message: '未知的 S3 失敗' }, { operation })
  }

  /** 讀完整文字（小回應：XML、錯誤）。 */
  async sendText(options) {
    const response = await this.send(options)
    return { status: response.status, text: await response.text() }
  }

  // -------------------------------------------------------------------------
  // 桶
  // -------------------------------------------------------------------------

  /** @returns {Promise<Array<{name: string, creationDate: string}>>} */
  async listBuckets(options) {
    const opts = options || {}
    const { text } = await this.sendText({
      method: 'GET',
      url: this.objectUrl('', ''),
      operation: 'ListBuckets',
      signal: opts.signal,
    })
    return core.parseListBuckets(text)
  }

  /** 桶是否存在（HEAD 桶，403 代表存在但無權，也算存在）。 */
  async headBucket(bucket, options) {
    const opts = options || {}
    try {
      await this.send({
        method: 'HEAD',
        url: this.objectUrl(bucket, ''),
        operation: 'HeadBucket',
        signal: opts.signal,
      })
      return true
    } catch (error) {
      if (isS3Error(error) && (error.status === 403 || error.status === 405)) return true
      throw error
    }
  }

  async createBucket(bucket, options) {
    const opts = options || {}
    // 注意：不帶 LocationConstraint。MinIO 有自己的 region，帶錯的
    // LocationConstraint 反而會被拒；不帶則由伺服器決定。
    await this.send({
      method: 'PUT',
      url: this.objectUrl(bucket, ''),
      operation: 'CreateBucket',
      signal: opts.signal,
    })
    return { bucket, created: true }
  }

  async deleteBucket(bucket, options) {
    const opts = options || {}
    await this.send({
      method: 'DELETE',
      url: this.objectUrl(bucket, ''),
      operation: 'DeleteBucket',
      signal: opts.signal,
    })
    return { bucket, deleted: true }
  }

  // -------------------------------------------------------------------------
  // 物件
  // -------------------------------------------------------------------------

  /**
   * 一層列表（delimiter 預設 `/`，所以「資料夾」由 CommonPrefixes 呈現）。
   * @returns {Promise<object>} parseListObjectsV2 的結果
   */
  async listObjectsV2(params) {
    const input = params || {}
    const url = this.withQuery(this.objectUrl(input.bucket, ''), [
      ['list-type', '2'],
      ['prefix', input.prefix === undefined ? '' : input.prefix],
      ['delimiter', input.delimiter === undefined ? '/' : input.delimiter],
      ['max-keys', String(Math.max(1, Math.min(1000, Number(input.maxKeys || 1000))))],
      ['encoding-type', 'url'],
      ['continuation-token', input.continuationToken || undefined],
      ['start-after', input.startAfter || undefined],
    ])
    const { text } = await this.sendText({ method: 'GET', url, operation: 'ListObjectsV2', signal: input.signal })
    return core.parseListObjectsV2(text)
  }

  /** 物件的中繼資料（HEAD）。 */
  async headObject(bucket, key, options) {
    const opts = options || {}
    const response = await this.send({
      method: 'HEAD',
      url: this.objectUrl(bucket, key),
      operation: 'HeadObject',
      signal: opts.signal,
    })
    return {
      key,
      size: Number(response.headers.get('content-length') || 0),
      contentType: response.headers.get('content-type') || '',
      etag: (response.headers.get('etag') || '').replace(/^"|"$/g, ''),
      lastModified: response.headers.get('last-modified') || '',
    }
  }

  /**
   * 讀物件。預設回一串 bytes（上限 maxBytes）；`stream: true` 時直接回
   * Response，讓宿主把 body 轉接出去（下載不進宿主記憶體）。
   */
  async getObject(params) {
    const input = params || {}
    const headers = {}
    if (input.range) headers.Range = input.range
    const response = await this.send({
      method: 'GET',
      url: this.objectUrl(input.bucket, input.key),
      headers,
      operation: 'GetObject',
      signal: input.signal,
    })
    if (input.stream) return response

    const maxBytes = Number(input.maxBytes || DEFAULT_MAX_READ)
    const chunks = []
    let size = 0
    const reader = response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null
    if (!reader) {
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length > maxBytes) {
        throw new S3Error(
          { code: 'ObjectTooLarge', message: `物件 ${buffer.length} bytes 超過讀取上限 ${maxBytes}` },
          { operation: 'GetObject' },
        )
      }
      return this.readResult(new Uint8Array(buffer), response, buffer.length)
    }
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) {
        try { await reader.cancel() } catch {}
        throw new S3Error(
          { code: 'ObjectTooLarge', message: `物件超過讀取上限 ${maxBytes} bytes` },
          { operation: 'GetObject' },
        )
      }
      chunks.push(Buffer.from(value))
    }
    return this.readResult(Buffer.concat(chunks), response, size)
  }

  readResult(buffer, response, size) {
    return {
      body: buffer,
      size,
      contentType: response.headers.get('content-type') || '',
      etag: (response.headers.get('etag') || '').replace(/^"|"$/g, ''),
      lastModified: response.headers.get('last-modified') || '',
    }
  }

  /** 寫物件（`body` 為 Buffer/字串；空物件是合法的，用於資料夾標記）。 */
  async putObject(params) {
    const input = params || {}
    const body = input.body === undefined || input.body === null ? Buffer.alloc(0) : input.body
    const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body))
    const headers = {}
    if (input.contentType) headers['Content-Type'] = input.contentType
    for (const [name, value] of Object.entries(input.metadata || {})) {
      if (value === undefined || value === null) continue
      headers['x-amz-meta-' + String(name).toLowerCase()] = String(value)
    }
    const response = await this.send({
      method: 'PUT',
      url: this.objectUrl(input.bucket, input.key),
      headers,
      body,
      operation: 'PutObject',
      signal: input.signal,
      // 大 body：不套時間預算（見 LARGE_BODY_BYTES 的說明）。
      timeoutMs: input.timeoutMs !== undefined
        ? input.timeoutMs
        : (length > LARGE_BODY_BYTES ? 0 : undefined),
    })
    return {
      key: input.key,
      size: length,
      etag: (response.headers.get('etag') || '').replace(/^"|"$/g, ''),
    }
  }

  async deleteObject(bucket, key, options) {
    const opts = options || {}
    await this.send({
      method: 'DELETE',
      url: this.objectUrl(bucket, key),
      operation: 'DeleteObject',
      signal: opts.signal,
    })
    return { key, deleted: true }
  }

  /**
   * 批次刪除（POST `?delete`，一次最多 1000 個 key）。
   * S3 的批次刪除對「不存在的 key」也回成功 —— 呼叫端要自己知道這點。
   */
  async deleteObjects(bucket, keys, options) {
    const opts = options || {}
    const list = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string' && key !== '')
    if (list.length === 0) return { deleted: [], errors: [] }
    if (list.length > 1000) {
      // 400 而不是 500：這是呼叫端的輸入問題（S3 一次最多 1000 個 key）。
      throw Object.assign(new Error(`一次最多刪除 1000 個 key（收到 ${list.length} 個）`), { status: 400 })
    }

    // DeleteObjects 的 <Key> 是 **原字串 XML 轉義**，不是 URL 編碼：
    // 編碼過的 key（空白→%20）會刪到一個不存在的物件，而且伺服器回 200，
    // 是那種「看起來成功、其實沒刪」的靜默失效。
    const body = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>'
      + list.map((key) => '<Object><Key>' + xmlEscape(key) + '</Key></Object>').join('')
      + '</Delete>',
      'utf8',
    )
    const url = this.withQuery(this.objectUrl(bucket, ''), [['delete', '']])
    const send = async () => {
      const { text } = await this.sendText({
        method: 'POST',
        url,
        headers: {
          'Content-Type': 'application/xml',
          // MinIO 對 POST ?delete 要求 Content-MD5（少了它回
          // `Missing required header for this request: Content-Md5`）。
          // 純 HTTP 語意上這是完整性檢查，不是認證，但它是這個操作的必填欄位。
          'Content-MD5': crypto.createHash('md5').update(body).digest('base64'),
        },
        body,
        operation: 'DeleteObjects',
        signal: opts.signal,
      })
      return core.parseDeleteResult(text)
    }

    let result = await send()
    // MinIO 驗 region 的方式對這個操作特別：**HTTP 200** 的 DeleteResult 裡
    // 逐 key 回 `AuthorizationHeaderMalformed` + 「expecting '…'」。那不是
    // 頂層 4xx，所以 send() 的重試看不到它；學到 region 後重試一次，
    // 否則使用者的症狀是「批次刪除說失敗、但其實只是 region 沒對上」。
    const hint = (result.errors || []).map((entry) => core.regionHintInText(entry.message)).find(Boolean)
    if (hint && this.setRegion(hint)) result = await send()
    return result
  }

  /** 伺服器端複製（同桶改名／換前綴用）。 */
  async copyObject(params) {
    const input = params || {}
    const source = '/' + core.uriEncode(input.bucket) + '/' + core.uriEncodePath(input.fromKey)
    const url = this.objectUrl(input.bucket, input.toKey)
    const response = await this.send({
      method: 'PUT',
      url,
      headers: {
        'x-amz-copy-source': source,
        ...(input.contentType ? { 'Content-Type': input.contentType } : {}),
      },
      operation: 'CopyObject',
      signal: input.signal,
    })
    return { fromKey: input.fromKey, toKey: input.toKey, status: response.status }
  }

  /** presign（預設 GET，1 小時）。 */
  presignObject(params) {
    const input = params || {}
    return core.presignUrl({
      url: this.objectUrl(input.bucket, input.key),
      method: input.method || 'GET',
      accessKey: this.accessKey,
      secretKey: this.secretKey,
      region: this.region,
      expires: input.expires === undefined ? 3600 : input.expires,
      now: input.now,
    })
  }
}

module.exports = {
  DEFAULT_MAX_READ,
  DEFAULT_REGION,
  DEFAULT_TIMEOUT_MS,
  S3Client,
  S3Error,
  isS3Error,
}
