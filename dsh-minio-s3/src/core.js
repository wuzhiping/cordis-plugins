'use strict'

/**
 * dsh-minio-s3 — 純函式核心（無執行期依賴，只用 node:crypto）
 *
 * 這一層只做三件事，全部可離線測試：
 *   1. AWS SigV4 簽章（header 認證 + presign 查詢認證）；
 *   2. S3/MinIO 回應的 XML 最小解析（ListBuckets / ListObjectsV2 / Error）；
 *   3. object key 的路徑工具（編碼、資料夾標記、父子關係）。
 *
 * 為什麼自己寫 SigV4 而不裝 @aws-sdk/client-s3：
 * 外掛是 `link:` 進 profile 的，`install_bundle` 會跑 pnpm；一個 200 行的
 * HMAC 鏈換掉一棵上百個套件的依賴樹，離線與可審計都划算。演算法本身是
 * 公開規格，測試用 AWS 官方文件裡的向量釘住（test/s3-core.test.js）。
 *
 * 本檔不知道「連線從哪來」——那是 connection.js 的事。
 */

const crypto = require('node:crypto')

/** 空 body 的 SHA-256（GET/DELETE 用）。 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** presign 用的萬用 payload 標記，只有查詢認證才合法。 */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'

/** @param {*} value @returns {string} */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/** @returns {Buffer} */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest()
}

/**
 * AWS 的時戳格式：`20261016T201522Z`（簽章用）與 `20261016`（credential scope 用）。
 * @param {Date} [now]
 * @returns {{stamp: string, date: string}}
 */
function amzStamp(now) {
  const at = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now)
  const iso = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { stamp: iso, date: iso.slice(0, 8) }
}

/**
 * RFC 3986 嚴格編碼：`encodeURIComponent` 之後再補編碼 `!'()*`。
 * （`encodeURIComponent` 會漏掉這五個，SigV4 的 canonical 形式要求編碼它們。）
 * @param {*} value
 * @returns {string}
 */
function uriEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/**
 * 路徑編碼：與 `uriEncode` 相同，但保留 `/` 當分隔符（object key 裡的斜線
 * 是層級，不是資料；編成 %2F 會讓 MinIO 找不到物件）。
 * @param {*} value
 * @returns {string}
 */
function uriEncodePath(value) {
  return uriEncode(value).replace(/%2F/gi, '/')
}

/**
 * canonical query string：先各自編碼，再依 key（同 key 時依 value）排序。
 * @param {Array<[string, *]>} pairs
 * @returns {string}
 */
function canonicalQuery(pairs) {
  const encoded = []
  for (const pair of pairs || []) {
    if (!pair) continue
    const key = pair[0]
    const value = pair[1]
    if (key === undefined || key === null || key === '') continue
    if (value === undefined || value === null) {
      encoded.push([uriEncode(key), ''])
      continue
    }
    encoded.push([uriEncode(key), uriEncode(value)])
  }
  encoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return encoded.map(([k, v]) => k + '=' + v).join('&')
}

/**
 * canonical header 值：去頭尾空白、把內部連續空白收成單一空格。
 * @param {*} value
 * @returns {string}
 */
function normalizeHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, ' ')
}

/**
 * 由一條完整 URL 組出 S3 請求。
 *
 * @param {object} options
 * @param {string} options.method  HTTP 方法
 * @param {string} options.url     完整 URL（含 endpoint、bucket、key、query）
 * @param {object} [options.headers] 額外要送的標頭（值可為 undefined）
 * @param {Buffer|Uint8Array|string|null} [options.body] 要送的 bytes（用來算 payload hash）
 * @param {string} options.accessKey
 * @param {string} options.secretKey
 * @param {string} options.region
 * @param {string} [options.service]
 * @param {Date} [options.now]
 * @returns {{headers: Record<string,string>, canonicalRequest: string, stringToSign: string, signature: string}}
 */
function signRequest(options) {
  const method = String(options.method || 'GET').toUpperCase()
  const url = new URL(options.url)
  const region = options.region || 'us-east-1'
  const service = options.service || 's3'
  const { stamp, date } = amzStamp(options.now)

  const payloadHash = payloadHashOf(options.body)

  const headers = {}
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value === undefined || value === null) continue
    headers[String(name).toLowerCase()] = normalizeHeaderValue(value)
  }
  headers.host = url.host
  headers['x-amz-date'] = stamp
  headers['x-amz-content-sha256'] = payloadHash

  const signedHeaders = Object.keys(headers).sort()
  // canonical query 必須由 URL 的 searchParams 重建：直接拿 url.search 會保留
  // 使用者寫的順序與編碼，那就不是 canonical 形式。
  const queryPairs = []
  for (const [key, value] of url.searchParams.entries()) queryPairs.push([key, value])
  const query = canonicalQuery(queryPairs)

  // CanonicalHeaders 的每一行（含最後一行）都以 '\n' 結尾；接著才接
  // SignedHeaders 那一行，所以 canonical request 在標頭區塊之後會有一個空行。
  // 這一點很容易寫錯（少了那個空行時的簽章在本地看起來完全合理，卻會被
  // 伺服器以 SignatureDoesNotMatch 拒絕）——test/s3-core.test.js 用 AWS 官方
  // 文件的三個向量把整個 canonical request 的形狀釘住。
  const canonicalHeaders = signedHeaders
    .map((name) => name + ':' + headers[name])
    .join('\n') + '\n'

  const canonicalRequest = [
    method,
    url.pathname === '' ? '/' : url.pathname,
    query,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')

  const scope = date + '/' + region + '/' + service + '/aws4_request'
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacSha256(signingKey(options.secretKey, date, region, service), stringToSign).toString('hex')

  const out = {}
  for (const [name, value] of Object.entries(options.headers || {})) {
    if (value === undefined || value === null) continue
    out[name] = value
  }
  out['x-amz-date'] = stamp
  out['x-amz-content-sha256'] = payloadHash
  out.Authorization = 'AWS4-HMAC-SHA256 Credential=' + options.accessKey + '/' + scope
    + ', SignedHeaders=' + signedHeaders.join(';')
    + ', Signature=' + signature

  return { headers: out, canonicalRequest, stringToSign, signature, payloadHash, signedHeaders }
}

/**
 * payload hash：body 為空 → 空字串的 hash；Buffer/字串 → 實際 bytes 的 hash。
 * @param {Buffer|Uint8Array|string|null|undefined} body
 * @returns {string}
 */
function payloadHashOf(body) {
  if (body === undefined || body === null) return EMPTY_SHA256
  if (typeof body === 'string') return body === '' ? EMPTY_SHA256 : sha256Hex(body)
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return body.length === 0 ? EMPTY_SHA256 : sha256Hex(body)
  }
  return EMPTY_SHA256
}

/**
 * SigV4 簽章金鑰：HMAC 鏈 `AWS4+secret → date → region → service → aws4_request`。
 * @returns {Buffer}
 */
function signingKey(secretKey, date, region, service) {
  const kDate = hmacSha256('AWS4' + secretKey, date)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, service)
  return hmacSha256(kService, 'aws4_request')
}

/**
 * 產生 presign URL（查詢認證，GET 常見）。
 *
 * 用途：把「帶簽章的一次性連結」交給瀏覽器或第三方下載，不必經過宿主代理。
 * 標頭只簽 `host`，payload 用 `UNSIGNED-PAYLOAD`（查詢認證的標準做法）。
 *
 * @param {object} options
 * @param {string} options.url 不含簽章參數的完整 URL
 * @param {string} [options.method]
 * @param {string} options.accessKey
 * @param {string} options.secretKey
 * @param {string} options.region
 * @param {number} [options.expires] 秒（1..604800）
 * @param {Date} [options.now]
 * @returns {string} 完整可用的 URL
 */
function presignUrl(options) {
  const method = String(options.method || 'GET').toUpperCase()
  const url = new URL(options.url)
  const region = options.region || 'us-east-1'
  const service = options.service || 's3'
  const { stamp, date } = amzStamp(options.now)
  const scope = date + '/' + region + '/' + service + '/aws4_request'

  const expires = Math.max(1, Math.min(604800, Math.floor(options.expires === undefined ? 3600 : options.expires)))

  const existing = []
  for (const [key, value] of url.searchParams.entries()) existing.push([key, value])

  const authPairs = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', options.accessKey + '/' + scope],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  const query = canonicalQuery(existing.concat(authPairs))

  const canonicalRequest = [
    method,
    url.pathname === '' ? '/' : url.pathname,
    query,
    'host:' + url.host + '\n',
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n')

  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmacSha256(signingKey(options.secretKey, date, region, service), stringToSign).toString('hex')

  return url.origin + url.pathname + '?' + query + '&X-Amz-Signature=' + signature
}

// ---------------------------------------------------------------------------
// XML：S3 的回應是小而固定的文件。這裡只解出我們要的欄位，不做通用 XML。
// ---------------------------------------------------------------------------

/**
 * 解 XML 實體（`&amp;` 等五個標準實體 + 數字實體）。
 * @param {string} text
 * @returns {string}
 */
function decodeXmlEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
    switch (entity) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      default: break
    }
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10)
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code) } catch { return match }
      }
    }
    return match
  })
}

/**
 * 取第一個 `<tag>…</tag>` 的內文（去頭尾空白、解實體）；找不到回 null。
 * @param {string} xml
 * @param {string} tag
 * @returns {string|null}
 */
function xmlText(xml, tag) {
  const match = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>').exec(String(xml || ''))
  return match ? decodeXmlEntities(match[1]).trim() : null
}

/**
 * 取所有同名的區塊（用於 `<Contents>`、`<Bucket>`、`<CommonPrefixes>`）。
 * @param {string} xml
 * @param {string} tag
 * @returns {string[]}
 */
function xmlBlocks(xml, tag) {
  const out = []
  const pattern = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'g')
  let match
  while ((match = pattern.exec(String(xml || ''))) !== null) out.push(match[1])
  return out
}

/** `<IsTruncated>true</IsTruncated>` → true。 */
function xmlBool(xml, tag) {
  return String(xmlText(xml, tag) || '').toLowerCase() === 'true'
}

/**
 * MinIO/S3 的錯誤文件 → 結構。非 XML 時退化成純文字訊息。
 * @param {string} body
 * @param {number} status
 * @returns {{code: string, message: string, region: string, resource: string, requestId: string, status: number}}
 */
function parseS3Error(body, status) {
  const text = String(body || '')
  return {
    code: xmlText(text, 'Code') || (status ? 'HTTP' + status : 'Error'),
    message: xmlText(text, 'Message') || text.slice(0, 400),
    region: xmlText(text, 'Region') || '',
    resource: xmlText(text, 'Resource') || '',
    requestId: xmlText(text, 'RequestId') || '',
    status: status || 0,
  }
}

/**
 * `ListBuckets` 回應 → `[{name, creationDate}]`。
 * @param {string} xml
 * @returns {Array<{name: string, creationDate: string}>}
 */
function parseListBuckets(xml) {
  return xmlBlocks(xml, 'Bucket').map((block) => ({
    name: xmlText(block, 'Name') || '',
    creationDate: xmlText(block, 'CreationDate') || '',
  })).filter((entry) => entry.name !== '')
}

/**
 * `ListObjectsV2` 回應 → 一層目錄的內容。
 *
 * 請求一律帶 `encoding-type=url`，所以 `Key` / `Prefix` / `Delimiter` 是
 * URL 編碼的（key 裡有非 ASCII 或 `&` 時特別重要）。這裡逐項解碼，失敗就
 * 保留原字串 —— 寧可顯示怪的 key，也不要丟掉一個物件。
 *
 * @param {string} xml
 * @returns {{name: string, prefix: string, delimiter: string, isTruncated: boolean, nextContinuationToken: string, keyCount: number, contents: Array<object>, commonPrefixes: string[]}}
 */
function parseListObjectsV2(xml) {
  const decode = (value) => {
    if (value === null || value === undefined || value === '') return value || ''
    try {
      // MinIO 用 `url.QueryEscape` 編碼（空間 → `+`，`+` 本身 → `%2B`），
      // 而 `decodeURIComponent` 不認 `+`。實測：key `hello world 中文.txt`
      // 回來是 `hello+world+%E4%B8%AD%E6%96%87.txt`；少了這一步，列出的 key
      // 會是 `hello+world+中文.txt` —— 一個「看起來對、點下去 404」的 key。
      return decodeURIComponent(value.replace(/\+/g, ' '))
    } catch {
      return value
    }
  }
  return {
    name: xmlText(xml, 'Name') || '',
    prefix: decode(xmlText(xml, 'Prefix')),
    delimiter: decode(xmlText(xml, 'Delimiter')),
    isTruncated: xmlBool(xml, 'IsTruncated'),
    nextContinuationToken: decode(xmlText(xml, 'NextContinuationToken')),
    keyCount: Number(xmlText(xml, 'KeyCount') || 0),
    contents: xmlBlocks(xml, 'Contents').map((block) => ({
      key: decode(xmlText(block, 'Key') || ''),
      size: Number(xmlText(block, 'Size') || 0),
      etag: (xmlText(block, 'ETag') || '').replace(/^"|"$/g, ''),
      lastModified: xmlText(block, 'LastModified') || '',
      storageClass: xmlText(block, 'StorageClass') || '',
    })).filter((entry) => entry.key !== ''),
    commonPrefixes: xmlBlocks(xml, 'CommonPrefixes')
      .map((block) => decode(xmlText(block, 'Prefix') || ''))
      .filter((entry) => entry !== ''),
  }
}

/** `DeleteObjects` 回應 → 每個 key 的結果。 */
function parseDeleteResult(xml) {
  return {
    deleted: xmlBlocks(xml, 'Deleted').map((block) => xmlText(block, 'Key') || '').filter(Boolean),
    errors: xmlBlocks(xml, 'Error').map((block) => ({
      key: xmlText(block, 'Key') || '',
      code: xmlText(block, 'Code') || '',
      message: xmlText(block, 'Message') || '',
    })),
  }
}

// ---------------------------------------------------------------------------
// key 路徑工具
// ---------------------------------------------------------------------------

/** 資料夾標記：S3 沒有目錄，`prefix/` 這種零位元組物件就是「空資料夾」。 */
function isFolderKey(key) {
  return typeof key === 'string' && key.endsWith('/')
}

/** 把 `a/`、`a`、`/a/b/` 收成 `a/b/` 這種前後都乾淨的資料夾前綴。 */
function normalizePrefix(value) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\\/g, '/')
  const trimmed = text.replace(/^\/+/, '')
  if (trimmed === '') return ''
  return trimmed.endsWith('/') ? trimmed : trimmed + '/'
}

/** `a/b` + `c` → `a/b/c`；name 若自帶結尾 `/` 會保留。 */
function joinKey(prefix, name) {
  const base = normalizePrefix(prefix)
  const leaf = String(name === undefined || name === null ? '' : name).replace(/^\/+/, '')
  return base + leaf
}

/** 取出最後一段（顯示用）。 */
function baseName(key) {
  const text = String(key || '').replace(/\/+$/, '')
  const index = text.lastIndexOf('/')
  return index >= 0 ? text.slice(index + 1) : text
}

/** 取出父層前綴（`a/b/c.txt` → `a/b/`，`a/` → ``）。 */
function parentPrefix(key) {
  const text = String(key || '').replace(/\/+$/, '')
  const index = text.lastIndexOf('/')
  return index >= 0 ? text.slice(0, index + 1) : ''
}

/**
 * 詞法邊界檢查：bucket 與 object key 會被放進 URL 路徑，必須擋掉
 * 會改變路徑結構的字元（`..`、`.`、空 key、控制字元、超長）。
 * 這一層是必要的，不是保險。
 *
 * @param {*} bucket
 * @param {*} key
 * @param {{allowEmptyKey?: boolean}} [options]
 * @returns {{ok: true, bucket: string, key: string} | {ok: false, error: string}}
 */
function checkTarget(bucket, key, options) {
  const opts = options || {}
  const name = typeof bucket === 'string' ? bucket.trim() : ''
  if (name === '') return { ok: false, error: 'bucket 不可為空' }
  if (name.length > 255) return { ok: false, error: 'bucket 名稱過長' }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return { ok: false, error: 'bucket 名稱不合法（只允許英數、.、_、-，且需以英數開頭）' }
  }
  const raw = key === undefined || key === null ? '' : String(key)
  if (raw === '') {
    if (opts.allowEmptyKey) return { ok: true, bucket: name, key: '' }
    return { ok: false, error: 'key 不可為空' }
  }
  if (raw.length > 1024) return { ok: false, error: 'key 過長（>1024）' }
  if (raw.startsWith('/') || raw.includes('\\')) {
    return { ok: false, error: 'key 不可是絕對路徑或含反斜線' }
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: 'key 含控制字元' }
  const segments = raw.split('/')
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const last = index === segments.length - 1
    if (segment === '') {
      // 只有結尾的斜線合法（資料夾標記）；中間的空段落會產生 `//`。
      if (!last) return { ok: false, error: 'key 含空的層級（//）' }
      continue
    }
    if (segment === '.' || segment === '..') return { ok: false, error: 'key 不可含 . 或 .. 層級' }
  }
  return { ok: true, bucket: name, key: raw }
}

/**
 * 從錯誤文字裡撈出伺服器期待的 region。
 *
 * MinIO 的訊息是 `… the region is wrong; expecting 'us-west-rack-2'.`。
 * 批次刪除（DeleteObjects）會把它放在 HTTP 200 回應的**逐 key `<Error>`** 裡，
 * 而不是頂層 4xx —— 所以這個字串是那種情況下唯一的線索。
 *
 * @param {string} text
 * @returns {string} region；沒有回 ''
 */
function regionHintInText(text) {
  const match = /expecting '([^']+)'/i.exec(String(text || ''))
  return match ? match[1] : ''
}

module.exports = {
  EMPTY_SHA256,
  UNSIGNED_PAYLOAD,
  amzStamp,
  baseName,
  canonicalQuery,
  checkTarget,
  decodeXmlEntities,
  hmacSha256,
  isFolderKey,
  joinKey,
  normalizePrefix,
  parentPrefix,
  parseDeleteResult,
  parseListBuckets,
  parseListObjectsV2,
  parseS3Error,
  payloadHashOf,
  presignUrl,
  regionHintInText,
  sha256Hex,
  signRequest,
  signingKey,
  uriEncode,
  uriEncodePath,
  xmlBlocks,
  xmlBool,
  xmlText,
}
