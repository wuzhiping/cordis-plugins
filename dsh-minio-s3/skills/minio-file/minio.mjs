#!/usr/bin/env node
/**
 * minio.mjs — 零依賴的 MinIO / S3 檔案操作（給 `minio-file` skill 用）
 *
 * 它自己實作 AWS SigV4（約 120 行 HMAC 鏈），所以不需要 `@aws-sdk/client-s3`、
 * 不需要 `mc`，只要有 Node 18+。連線設定直接吃 dsh-minio-s3 面板
 * 「❗️ 複製設定」匯出的 JSON。
 *
 *   node minio.mjs ls --config minio.json
 *   node minio.mjs put --config minio.json --key docs/a.md --from a.md
 *   node minio.mjs get --config minio.json --key docs/a.md --out a.md
 *
 * 設定解析順序：--config <file> → $MINIO_CONFIG → ./minio.json → 環境變數
 * （MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_REGION / MINIO_BUCKET）。
 * 欄位名同時接受匯出格式（endpoint/accessKey/secretKey/region/bucket）與
 * BDD storage 記錄的原始格式（S3_URL/S3_UID/S3_PWD/S3_BUCK、UID/PWD/BUCKET）。
 *
 * 結束碼：0 成功；1 失敗（stderr 一行 `error: <Code> <Message>`）。
 */

import { createHash, createHmac } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { basename } from 'node:path'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD'
const DEFAULT_REGION = 'us-east-1'

// ---------------------------------------------------------------------------
// 參數
// ---------------------------------------------------------------------------

function parseArgv(argv) {
  const out = { _: [], key: [], flags: {} }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--json' || token === '--recursive' || token === '--help' || token === '-h'
      || token === '--no-progress' || token === '--progress' || token === '--continue' || token === '--resume') {
      out.flags[token.replace(/^--?/, '')] = true
      continue
    }
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        out.flags[name] = true
        continue
      }
      i += 1
      if (name === 'key') out.key.push(value)
      else out.flags[name] = value
      continue
    }
    out._.push(token)
  }
  return out
}

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

function pick(object, names) {
  const lowered = new Map(Object.entries(object || {}).map(([k, v]) => [k.toLowerCase(), v]))
  for (const name of names) {
    const value = lowered.get(name.toLowerCase())
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
    if (typeof value === 'number') return String(value)
  }
  return ''
}

function loadConfig(args) {
  const candidates = []
  if (typeof args.flags.config === 'string') candidates.push(args.flags.config)
  if (process.env.MINIO_CONFIG) candidates.push(process.env.MINIO_CONFIG)
  candidates.push('minio.json', '.dsh/minio.json')

  let raw = {}
  let source = 'environment'
  for (const candidate of candidates) {
    try {
      raw = JSON.parse(readFileSync(candidate, 'utf8'))
      source = candidate
      break
    } catch (error) {
      if (typeof args.flags.config === 'string' && candidate === args.flags.config) {
        fail('ConfigUnreadable', `讀不到設定檔 ${candidate}：${error.message}`)
      }
    }
  }

  const endpointRaw = pick(raw, ['endpoint', 'S3_URL', 'url', 'host']) || process.env.MINIO_ENDPOINT || ''
  const accessKey = pick(raw, ['accessKey', 'accessKeyId', 'S3_UID', 'UID']) || process.env.MINIO_ACCESS_KEY || ''
  const secretKey = pick(raw, ['secretKey', 'secretAccessKey', 'S3_PWD', 'PWD']) || process.env.MINIO_SECRET_KEY || ''
  const region = pick(raw, ['region', 'S3_REGION']) || process.env.MINIO_REGION || ''
  const bucket = typeof args.flags.bucket === 'string'
    ? args.flags.bucket
    : (pick(raw, ['bucket', 'S3_BUCK', 'BUCKET']) || process.env.MINIO_BUCKET || '')

  if (endpointRaw === '' || accessKey === '' || secretKey === '') {
    fail('ConfigMissing', `設定缺少 endpoint/accessKey/secretKey（試過：${candidates.join('、')}）。`
      + '第一次使用請把 dsh-minio-s3 面板「❗️ 複製設定」匯出的 JSON 交給 `minio.mjs init`（或用 --config 指定檔案），'
      + '也可以用 MINIO_ENDPOINT/MINIO_ACCESS_KEY/MINIO_SECRET_KEY 環境變數。')
  }
  const endpoint = (/^https?:\/\//i.test(endpointRaw) ? endpointRaw : `http://${endpointRaw}`).replace(/\/+$/, '')
  return { endpoint, accessKey, secretKey, region, bucket, source }
}

// ---------------------------------------------------------------------------
// SigV4
// ---------------------------------------------------------------------------

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

function amzStamp(now = new Date()) {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { stamp: iso, date: iso.slice(0, 8) }
}

const uriEncode = (value) => encodeURIComponent(String(value))
  .replace(/[!'()*]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
const uriEncodePath = (value) => uriEncode(value).replace(/%2F/gi, '/')

function canonicalQuery(pairs) {
  const encoded = (pairs || [])
    .filter((pair) => pair && pair[0])
    .map(([k, v]) => [uriEncode(k), v === undefined || v === null ? '' : uriEncode(v)])
  encoded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
  return encoded.map(([k, v]) => `${k}=${v}`).join('&')
}

function payloadHashOf(body) {
  if (body === undefined || body === null) return EMPTY_SHA256
  if (typeof body === 'string') return body === '' ? EMPTY_SHA256 : sha256Hex(body)
  if (body.length === 0) return EMPTY_SHA256
  return sha256Hex(body)
}

function signingKey(secretKey, date, region, service = 's3') {
  return hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), 'aws4_request')
}

function sign({ method, url, headers = {}, body, accessKey, secretKey, region, now }) {
  const parsed = url instanceof URL ? url : new URL(url)
  const { stamp, date } = amzStamp(now)
  const payloadHash = payloadHashOf(body)

  const all = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    all[name.toLowerCase()] = String(value).trim().replace(/\s+/g, ' ')
  }
  all.host = parsed.host
  all['x-amz-date'] = stamp
  all['x-amz-content-sha256'] = payloadHash

  const signedHeaders = Object.keys(all).sort()
  const query = canonicalQuery([...parsed.searchParams.entries()])
  // canonical headers 每一行（含最後一行）都以 \n 結尾 —— 少了那個空行，
  // 本地看起來一切正常，伺服器卻永遠回 SignatureDoesNotMatch。
  const canonicalHeaders = signedHeaders.map((name) => `${name}:${all[name]}`).join('\n') + '\n'
  const canonicalRequest = [
    method.toUpperCase(),
    parsed.pathname === '' ? '/' : parsed.pathname,
    query,
    canonicalHeaders,
    signedHeaders.join(';'),
    payloadHash,
  ].join('\n')

  const scope = `${date}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n')
  const signature = hmac(signingKey(secretKey, date, region), stringToSign).toString('hex')

  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue
    out[name] = value
  }
  out['x-amz-date'] = stamp
  out['x-amz-content-sha256'] = payloadHash
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}`
    + `, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`
  return out
}

function presign({ url, method = 'GET', accessKey, secretKey, region, expires = 3600, now }) {
  const parsed = url instanceof URL ? url : new URL(url)
  const { stamp, date } = amzStamp(now)
  const scope = `${date}/${region}/s3/aws4_request`
  const pairs = [...parsed.searchParams.entries()].concat([
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${accessKey}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(Math.max(1, Math.min(604800, Math.floor(expires))))],
    ['X-Amz-SignedHeaders', 'host'],
  ])
  const query = canonicalQuery(pairs)
  const canonicalRequest = [
    method.toUpperCase(),
    parsed.pathname === '' ? '/' : parsed.pathname,
    query,
    `host:${parsed.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n')
  const signature = hmac(
    signingKey(secretKey, date, region),
    ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonicalRequest)].join('\n'),
  ).toString('hex')
  return `${parsed.origin}${parsed.pathname}?${query}&X-Amz-Signature=${signature}`
}

// ---------------------------------------------------------------------------
// XML（只解我們要的欄位）
// ---------------------------------------------------------------------------

const decodeEntities = (text) => String(text).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (match, entity) => {
  if (entity === 'amp') return '&'
  if (entity === 'lt') return '<'
  if (entity === 'gt') return '>'
  if (entity === 'quot') return '"'
  if (entity === 'apos') return "'"
  if (entity[0] === '#') {
    const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10)
    if (Number.isFinite(code)) { try { return String.fromCodePoint(code) } catch { return match } }
  }
  return match
})

function xmlText(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(String(xml || ''))
  return match ? decodeEntities(match[1]).trim() : null
}

function xmlBlocks(xml, tag) {
  const out = []
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  let match
  while ((match = pattern.exec(String(xml || ''))) !== null) out.push(match[1])
  return out
}

// MinIO 的 ListObjectsV2 用 url.QueryEscape（空間 → +、+ → %2B）；
// decodeURIComponent 不認 +，少了這一步 key 會對不上。
const decodeKey = (value) => {
  if (!value) return ''
  try { return decodeURIComponent(String(value).replace(/\+/g, ' ')) } catch { return String(value) }
}

function parseError(text, status) {
  return {
    code: xmlText(text, 'Code') || `HTTP${status}`,
    message: xmlText(text, 'Message') || String(text || '').slice(0, 300),
    region: xmlText(text, 'Region') || '',
    status,
  }
}

/**
 * 失敗：拋出帶訊息的 CLI 錯誤，由最外層統一印出並設 exit code。
 *
 * 刻意**不用 `process.exit()`**：Node 24 on Windows 在 fetch 的 socket 正在收尾時
 * 呼叫 process.exit() 會踩到 libuv 的 `UV_HANDLE_CLOSING` 斷言，行程以
 * 0xC0000409 結束（不是 1），呼叫端看到的是「crash」而不是可讀的錯誤。
 */
class CliError extends Error {}

function fail(code, message, status = 0) {
  throw new CliError(`${code}${message ? ' ' + message : ''}${status ? ` (HTTP ${status})` : ''}`)
}

// ---------------------------------------------------------------------------
// 進度條
//
// 一律寫到 **stderr**：stdout 保持乾淨（可以 `| tar -x`、可以 `--json` 給程式解析）。
// 只在互動（stderr 是 TTY）時畫；被管線接走、CI、或 --no-progress 就不畫。
// `DSH_MINIO_S3_FORCE_PROGRESS=1` 可以強制畫（測試與 `2>&1 | tee` 用）。
// ---------------------------------------------------------------------------

const fmtBytes = (bytes) => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = Math.max(0, Number(bytes) || 0)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

const fmtDuration = (seconds) => {
  const total = Math.max(0, Math.round(seconds))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 建立一個進度條。全部回傳 no-op 的版本時（非 TTY），呼叫端的程式碼不用分支。
 *
 * @param {{label: string, total: number, resumedFrom?: number, enabled?: boolean}} options
 */
function createProgress(options) {
  const { label, total, resumedFrom = 0 } = options
  const enabled = options.enabled !== undefined
    ? options.enabled
    : (process.stderr.isTTY === true || process.env.DSH_MINIO_S3_FORCE_PROGRESS === '1')
  if (!enabled) return { update() {}, note() {}, done() {} }

  const startedAt = Date.now()
  const base = Math.max(0, resumedFrom)
  let current = base
  let lastRender = 0
  let extraText = ''

  const render = (final) => {
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000)
    const ratio = total > 0 ? Math.min(1, current / total) : 1
    const moved = Math.max(0, current - base)
    const speed = moved / elapsed
    const width = 24
    const filled = Math.round(ratio * width)
    const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
    const eta = !final && speed > 0 && current < total ? ` ETA ${fmtDuration((total - current) / speed)}` : ''
    const resumed = base > 0 ? ` (續傳自 ${total > 0 ? Math.round((base / total) * 100) : 0}%)` : ''
    const line = `${label} [${bar}] ${String(Math.round(ratio * 100)).padStart(3)}%`
      + `  ${fmtBytes(current)}/${fmtBytes(total)}  ${fmtBytes(speed)}/s${eta}${resumed}`
      + (extraText ? `  ${extraText}` : '')
    process.stderr.write('\r\x1b[2K' + line)
    lastRender = Date.now()
  }

  // 開頭先講清楚「從哪裡接上」——斷點續傳最需要看到的就是這一行。
  if (base > 0) process.stderr.write(`${label}：從 ${fmtBytes(base)}（${total > 0 ? Math.round((base / total) * 100) : 0}%）接續\n`)
  render()

  return {
    update(bytes, extra) {
      current = bytes
      if (extra !== undefined) extraText = extra
      if (Date.now() - lastRender >= 80) render(false)
    },
    note(text) {
      extraText = text
      render(false)
    },
    done(extra) {
      if (extra !== undefined) extraText = extra
      render(true)
      process.stderr.write('\n')
    },
  }
}


// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function makeClient(config) {
  const state = { region: config.region || DEFAULT_REGION }

  async function probeRegion() {
    if (config.region) return
    try {
      const response = await fetch(`${config.endpoint}/`)
      if (response.ok) return
      const region = parseError(await response.text(), response.status).region
      if (region) state.region = region
    } catch { /* 探測失敗就用預設 */ }
  }

  function objectUrl(bucket, key) {
    let path = ''
    if (bucket) path += `/${uriEncode(bucket)}`
    if (key) path += `/${uriEncodePath(key)}`
    return config.endpoint + (path === '' ? '/' : path)
  }

  function withQuery(url, pairs) {
    const parsed = new URL(url)
    for (const [k, v] of pairs || []) {
      if (v === undefined || v === null) continue
      parsed.searchParams.set(k, String(v))
    }
    return parsed.toString()
  }

  async function send({ method = 'GET', url, headers = {}, body, allowStatus = [] }) {
    const requestHeaders = sign({
      method,
      url,
      headers,
      body,
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: state.region,
    })
    const init = { method, headers: requestHeaders }
    if (body !== undefined && body !== null) init.body = body
    let response
    try {
      response = await fetch(url, init)
    } catch (error) {
      fail('NetworkError', `${method} ${config.endpoint} 失敗：${error.message}`)
    }
    // allowStatus：把某些狀態碼當正常結果交回呼叫端（例如 Range 越界的 416）
    if (!response.ok && !allowStatus.includes(response.status)) {
      const text = await response.text()
      const info = parseError(text, response.status)
      // **HEAD 沒有 body**：S3 的錯誤 XML 是空的，parseError 只能得到 `HTTP404`。
      // 對呼叫端來說「找不到 key」比「HTTP404」有用得多，所以用狀態碼補一個標準
      // 語意（有 body 的回應仍以伺服器回的 Code 為準）。
      if (/^HTTP\d+$/.test(info.code)) {
        const fallback = { 404: 'NoSuchKey', 403: 'AccessDenied', 400: 'BadRequest', 405: 'MethodNotAllowed' }[response.status]
        if (fallback) info.code = fallback
      }
      // region 猜錯時有機會自動修正一次（伺服器會回它期待的 region）
      if (info.region && info.region !== state.region && method !== 'POST') {
        state.region = info.region
        return send({ method, url, headers, body, allowStatus })
      }
      fail(info.code, info.message, info.status)
    }
    return response
  }

  async function text(options) {
    return (await send(options)).text()
  }

  return { state, probeRegion, objectUrl, withQuery, send, text }
}

// ---------------------------------------------------------------------------
// 操作
// ---------------------------------------------------------------------------

async function listBuckets(client) {
  const xml = await client.text({ url: client.objectUrl('', '') })
  return xmlBlocks(xml, 'Bucket').map((block) => ({
    name: xmlText(block, 'Name') || '',
    createdAt: xmlText(block, 'CreationDate') || '',
  }))
}

async function listObjects(client, bucket, prefix, recursive, max) {
  const xml = await client.text({
    url: client.withQuery(client.objectUrl(bucket, ''), [
      ['list-type', '2'],
      ['prefix', prefix || ''],
      ['delimiter', recursive ? '' : '/'],
      ['max-keys', String(Math.max(1, Math.min(1000, max)))],
      ['encoding-type', 'url'],
    ]),
  })
  const rawContents = xmlBlocks(xml, 'Contents').map((block) => ({
    key: decodeKey(xmlText(block, 'Key') || ''),
    size: Number(xmlText(block, 'Size') || 0),
    lastModified: xmlText(block, 'LastModified') || '',
    etag: (xmlText(block, 'ETag') || '').replace(/^"|"$/g, ''),
  }))
  const folders = xmlBlocks(xml, 'CommonPrefixes').map((block) => decodeKey(xmlText(block, 'Prefix') || ''))
  // 兩個都要濾：①key 等於「當前前綴」的標記（`ls docs/` 時回來的 `docs/` 自己，
  // 不濾就會看到一個 0 byte 的假檔案）；②已經由 folders 呈現的子資料夾標記。
  const objects = rawContents.filter((entry) => entry.key !== (prefix || ''))
    .filter((entry) => !(entry.key.endsWith('/') && entry.size === 0 && folders.includes(entry.key)))
  return {
    folders,
    objects,
    truncated: (xmlText(xml, 'IsTruncated') || '').toLowerCase() === 'true',
    nextToken: decodeKey(xmlText(xml, 'NextContinuationToken') || ''),
  }
}

/** 物件的中繼資料（HEAD，很便宜，續傳前用它確認 ETag／大小）。 */
// ---------------------------------------------------------------------------
// Multipart（大檔上傳／斷點續傳）——形狀照真機 MinIO 實測
// ---------------------------------------------------------------------------

const MIN_PART_BYTES = 5 * 1024 * 1024       // S3 對非最後一片的下限（MinIO 會擋 EntityTooSmall）
const DEFAULT_PART_BYTES = 8 * 1024 * 1024   // 我們自己的預設，留餘量
const MAX_PART_BYTES = 5 * 1024 * 1024 * 1024
const MAX_PARTS = 10000

/** 分片規劃：片 ≥ 8MiB、片數 ≤ 10000。partSize 一旦定下就不能改（續傳靠它算位移）。 */
function planParts(size, overridePartSize) {
  if (overridePartSize) {
    const partSize = Math.max(MIN_PART_BYTES, Math.min(MAX_PART_BYTES, Math.floor(overridePartSize)))
    return { partSize, partCount: size === 0 ? 1 : Math.ceil(size / partSize) }
  }
  const partSize = Math.max(DEFAULT_PART_BYTES, Math.min(MAX_PART_BYTES, Math.ceil(size / MAX_PARTS) || DEFAULT_PART_BYTES))
  return { partSize, partCount: size === 0 ? 1 : Math.ceil(size / partSize) }
}

/** 解析 `16MiB` / `1048576` 這種大小寫法。 */
function parseSize(value, fallback) {
  if (value === undefined || value === true || value === '') return fallback
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|KB|MB|GB)?$/i.exec(String(value).trim())
  if (!match) fail('BadSize', `看不懂的大小：${value}`)
  const units = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3 }
  return Math.floor(Number(match[1]) * (units[(match[2] || 'B').toLowerCase()] || 1))
}

async function headMeta(client, bucket, key) {
  const response = await client.send({ method: 'HEAD', url: client.objectUrl(bucket, key) })
  return {
    key,
    size: Number(response.headers.get('content-length') || 0),
    etag: (response.headers.get('etag') || '').replace(/^"|"$/g, ''),
    contentType: response.headers.get('content-type') || '',
    lastModified: response.headers.get('last-modified') || '',
  }
}

/** 小物件的緩衝讀取（`cat` 用；有上限，避免把記憶體吃爆）。 */
async function getObject(client, bucket, key, maxBytes = 64 * 1024 * 1024) {
  const response = await client.send({ url: client.objectUrl(bucket, key) })
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length > maxBytes) {
    fail('ObjectTooLarge', `物件 ${buffer.length} bytes 超過緩衝讀取上限 ${maxBytes}；請用 get --out 串流下載`)
  }
  return { bytes: buffer.length, contentType: response.headers.get('content-type') || '', body: buffer }
}

/** 側車檔：記住「這個檔是從哪個物件的哪個版本抓的」，續傳時用來比對。 */
const metaPathOf = (out) => `${out}.dshmeta.json`
function readMeta(out) {
  try { return JSON.parse(readFileSync(metaPathOf(out), 'utf8')) } catch { return null }
}

function writeMeta(out, meta) {
  try { writeFileSync(metaPathOf(out), JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 }) } catch {}
}

/**
 * 下載（可續傳、串流寫檔）。
 *
 * 續傳的三個關鍵：
 *   1. 以本地檔的大小當 `offset`，帶 `Range: bytes=<offset>-`；
 *   2. 帶 `If-Range: <側車檔記的 ETag>` —— **但不能只靠它**：實測 MinIO 會忽略
 *      If-Range，所以這裡自己 HEAD 比對 ETag，不符就從 0 重寫（寧可重抓，也不要
 *      把新內容接在舊資料後面）；
 *   3. 回應是 200（不是 206）代表伺服器給了完整內容 → 從 0 覆寫。
 */
async function downloadToFile(client, bucket, key, out, options = {}) {
  const cont = options.continue === true
  const meta = cont ? readMeta(out) : null
  const head = await headMeta(client, bucket, key)

  let offset = cont && existsSync(out) ? statSync(out).size : 0
  let restart = false
  if (offset > 0) {
    if (meta && meta.etag && head.etag && meta.etag !== head.etag) restart = true        // 物件換過
    else if (meta && typeof meta.size === 'number' && meta.size !== head.size) restart = true
    if (offset > head.size) restart = true                                               // 本地檔比物件還大
    if (offset === head.size) {
      // 看起來已完成：如果 ETag 對得上就直接結束（不發多餘請求）
      if (!meta || !meta.etag || meta.etag === head.etag) {
        return { bytes: offset, size: head.size, etag: head.etag, resumed: true, alreadyComplete: true }
      }
      restart = true
    }
    if (restart) offset = 0
  }

  const progress = createProgress({
    label: `${cont ? '續傳下載' : '下載'} ${basename(out)}`,
    total: head.size,
    resumedFrom: offset,
    enabled: options.progress,
  })

  const headers = {}
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`
    if (meta && meta.etag) headers['If-Range'] = meta.etag
  }
  const response = await client.send({
    method: 'GET',
    url: client.objectUrl(bucket, key),
    headers,
    allowStatus: [416],
  })

  // 逐塊回報位元組，讓進度條是連續的（不是只在最後跳一下）
  const countingStream = (startAt) => {
    let written = startAt
    return new Transform({
      transform(chunk, _encoding, callback) {
        written += chunk.length
        progress.update(written)
        callback(null, chunk)
      },
    })
  }

  if (response.status === 416) {
    // 越界（本地檔已是完整大小卻被判定要續傳）→ 從 0 重來
    try { await response.body?.cancel() } catch {}
    process.stderr.write('（本地檔比物件大或對不上；改為從 0 重新下載）\n')
    offset = 0
    const retry = await client.send({ method: 'GET', url: client.objectUrl(bucket, key) })
    await pipeline(Readable.fromWeb(retry.body), countingStream(0), createWriteStream(out, { flags: 'w' }))
  } else if (response.status === 206) {
    await pipeline(Readable.fromWeb(response.body), countingStream(offset), createWriteStream(out, { flags: 'a' }))
  } else {
    // 200：伺服器給了完整內容（可能是我們沒續傳，也可能是它忽略了 Range）→ 覆寫
    process.stderr.write('（伺服器回完整內容而非 206；從 0 覆寫）\n')
    await pipeline(Readable.fromWeb(response.body), countingStream(0), createWriteStream(out, { flags: 'w' }))
    offset = 0
  }

  const finalSize = statSync(out).size
  const written = { bytes: finalSize, size: head.size, etag: head.etag, resumed: offset > 0, alreadyComplete: false }

  // 單片上傳的物件 ETag 就是 MD5 → 可以真的驗內容；multipart 的 ETag 帶 `-N`，只驗大小
  if (/^[0-9a-f]{32}$/i.test(head.etag)) {
    const digest = createHash('md5').update(readFileSync(out)).digest('hex')
    if (digest !== head.etag.toLowerCase()) {
      progress.done('校驗失敗')
      fail('ChecksumMismatch', `${out} 的 MD5 ${digest} 與物件 ETag ${head.etag} 不符（檔案可能不完整，重跑一次 --continue 會修）`)
    }
    written.verified = 'md5'
  } else if (finalSize !== head.size) {
    progress.done('大小不符')
    fail('SizeMismatch', `${out} 有 ${finalSize} bytes，物件是 ${head.size} bytes`)
  } else {
    written.verified = 'size'
  }
  progress.done(`驗證 ${written.verified}`)
  writeMeta(out, { key, bucket, etag: head.etag, size: head.size, endpoint: client.state.region, updatedAt: new Date().toISOString() })
  return written
}

async function putObject(client, bucket, key, body, contentType) {
  const headers = {}
  if (contentType) headers['Content-Type'] = contentType
  const response = await client.send({ method: 'PUT', url: client.objectUrl(bucket, key), headers, body })
  return { key, bytes: Buffer.byteLength(body), etag: (response.headers.get('etag') || '').replace(/^"|"$/g, '') }
}

async function deleteObjects(client, bucket, keys) {
  if (keys.length > 1000) fail('TooManyKeys', `一次最多 1000 個 key（收到 ${keys.length}）`)
  const body = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>false</Quiet>'
    + keys.map((key) => `<Object><Key>${String(key)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')}</Key></Object>`).join('')
    + '</Delete>')
  const xml = await client.text({
    method: 'POST',
    url: client.withQuery(client.objectUrl(bucket, ''), [['delete', '']]),
    headers: {
      'Content-Type': 'application/xml',
      // MinIO 對 POST ?delete 要求 Content-MD5（少了它回 Missing required header）
      'Content-MD5': createHash('md5').update(body).digest('base64'),
    },
    body,
  })
  const errors = xmlBlocks(xml, 'Error').map((block) => ({
    key: xmlText(block, 'Key') || '',
    code: xmlText(block, 'Code') || '',
    message: xmlText(block, 'Message') || '',
  }))
  const deleted = xmlBlocks(xml, 'Deleted').map((block) => xmlText(block, 'Key') || '')
  // 逐 key 失敗（尤其是 region 錯誤）時退回單物件刪除：POST ?delete 的驗簽比
  // DELETE /object 嚴，只走批次會得到「HTTP 200 但什麼都沒刪」的假成功。
  const retried = []
  for (const entry of errors) {
    if (!entry.key) continue
    try {
      await client.send({ method: 'DELETE', url: client.objectUrl(bucket, entry.key) })
      deleted.push(entry.key)
      retried.push(entry.key)
    } catch { /* 保留在 errors 裡 */ }
  }
  return { deleted, errors: errors.filter((entry) => !retried.includes(entry.key)), retried }
}

async function copyObject(client, bucket, fromKey, toKey) {
  await client.send({
    method: 'PUT',
    url: client.objectUrl(bucket, toKey),
    // x-amz-copy-source 必須以 / 開頭，且 key 依 URL 規則編碼
    headers: { 'x-amz-copy-source': `/${uriEncode(bucket)}/${uriEncodePath(fromKey)}` },
  })
  return { fromKey, toKey }
}

// ---------------------------------------------------------------------------
// Multipart 操作（續傳的真相來源都是伺服器：ListMultipartUploads + ListParts）
// ---------------------------------------------------------------------------

async function createMultipart(client, bucket, key, contentType) {
  const headers = {}
  if (contentType) headers['Content-Type'] = contentType
  const xml = await client.text({
    method: 'POST',
    url: client.withQuery(client.objectUrl(bucket, key), [['uploads', '']]),
    headers,
  })
  const uploadId = xmlText(xml, 'UploadId')
  if (!uploadId) fail('NoUploadId', 'CreateMultipartUpload 沒有回 UploadId')
  return uploadId
}

async function listMultipartUploads(client, bucket, prefix) {
  const xml = await client.text({
    url: client.withQuery(client.objectUrl(bucket, ''), [
      ['uploads', ''],
      ['prefix', prefix || ''],
      ['encoding-type', 'url'],
    ]),
  })
  return xmlBlocks(xml, 'Upload').map((block) => ({
    key: decodeKey(xmlText(block, 'Key')),
    uploadId: xmlText(block, 'UploadId') || '',
    initiated: xmlText(block, 'Initiated') || '',
  })).filter((entry) => entry.uploadId)
}

async function listParts(client, bucket, key, uploadId) {
  const xml = await client.text({
    url: client.withQuery(client.objectUrl(bucket, key), [['uploadId', uploadId]]),
  })
  return xmlBlocks(xml, 'Part').map((block) => ({
    partNumber: Number(xmlText(block, 'PartNumber') || 0),
    size: Number(xmlText(block, 'Size') || 0),
    // 回應裡是 XML 轉義的 &#34;…&#34;；xmlText 已解實體，這裡去掉引號
    etag: (xmlText(block, 'ETag') || '').replace(/"/g, ''),
  })).filter((entry) => entry.partNumber > 0)
}

async function abortMultipart(client, bucket, key, uploadId) {
  await client.send({
    method: 'DELETE',
    url: client.withQuery(client.objectUrl(bucket, key), [['uploadId', uploadId]]),
  })
  return { aborted: true, uploadId }
}

async function completeMultipart(client, bucket, key, uploadId, parts) {
  const xml = await client.text({
    method: 'POST',
    url: client.withQuery(client.objectUrl(bucket, key), [['uploadId', uploadId]]),
    headers: { 'Content-Type': 'application/xml' },
    body: Buffer.from('<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload>'
      + [...parts].sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>"${String(part.etag).replace(/"/g, '')}"</ETag></Part>`).join('')
      + '</CompleteMultipartUpload>'),
  })
  return { etag: (xmlText(xml, 'ETag') || '').replace(/"/g, ''), location: xmlText(xml, 'Location') || '' }
}

/** 讀出檔案的某一片（整片進記憶體；記憶體 = 併發數 × partSize）。 */
async function readPart(file, partNumber, partSize, totalSize) {
  const start = (partNumber - 1) * partSize
  const end = Math.min(start + partSize, totalSize)
  const chunks = []
  for await (const chunk of createReadStream(file, { start, end: end - 1 })) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  return { body, md5: createHash('md5').update(body).digest('hex') }
}

/**
 * 上傳一片，含逐片重試。
 *
 * 同一個 partNumber 重傳會覆蓋舊片（S3 語意），所以「送出去了但回應掉了」重試是安全的。
 * 回的 ETag 是該片的 MD5（實測），與本地算的不符就當失敗 —— 能抓到「傳成功但內容壞了」。
 */
async function uploadPart(client, { bucket, key, uploadId, partNumber, file, partSize, totalSize, contentType, attempts = 3 }) {
  let lastError = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { body, md5 } = await readPart(file, partNumber, partSize, totalSize)
      const headers = {}
      if (contentType) headers['Content-Type'] = contentType
      const response = await client.send({
        method: 'PUT',
        url: client.withQuery(client.objectUrl(bucket, key), [
          ['partNumber', String(partNumber)],
          ['uploadId', uploadId],
        ]),
        headers,
        body,
      })
      const etag = (response.headers.get('etag') || '').replace(/"/g, '')
      if (etag && etag !== md5) fail('PartChecksumMismatch', `第 ${partNumber} 片的 MD5 不符（本地 ${md5}／伺服器 ${etag}）`)
      return { partNumber, size: body.length, etag, md5 }
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
    }
  }
  throw lastError
}

/** 固定併發的 worker pool（回傳值照輸入順序）。 */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/** 未完成的上傳（可選 key）。 */
async function inProgressUploads(client, bucket, key) {
  const uploads = await listMultipartUploads(client, bucket, key || '')
  const selected = key ? uploads.filter((entry) => entry.key === key) : uploads
  const out = []
  for (const entry of selected) {
    let parts = []
    try { parts = await listParts(client, bucket, entry.key, entry.uploadId) } catch { /* 可能剛被清掉 */ }
    out.push({ ...entry, parts })
  }
  return out
}

/** 上傳側車檔：記住本地檔的 size/mtime 與規劃，續傳時用來判斷「是不是同一個檔」。 */
const uploadMetaPathOf = (file) => `${file}.dshupload.json`

/**
 * 大檔上傳（multipart、可續傳）。
 *
 * 續傳判斷：
 *   1. 側車檔記著上次的 `{uploadId, partSize, size, mtime}`；
 *   2. 本地檔的 size／mtime 變了 → 舊的 upload 直接 abort，重新開始（不能把不同內容的片拼起來）；
 *   3. 沒變 → 用 `ListParts` 問伺服器「已經有哪幾片」，只補缺的；
 *   4. 側車檔不見了但伺服器有未完成的 upload → 復原它（ListMultipartUploads 找回 uploadId）。
 */
async function uploadFile(client, { bucket, key, file, contentType, partSizeOverride, concurrency = 3, resume = true, progress: progressEnabled }) {
  const stat = statSync(file)
  const size = stat.size
  const mtime = Math.floor(stat.mtimeMs)
  const plan = planParts(size, partSizeOverride)
  if (plan.partCount > MAX_PARTS) {
    fail('TooManyParts', `以每片 ${plan.partSize} bytes 需要 ${plan.partCount} 片，超過 S3 的 ${MAX_PARTS} 片上限；請加大 --part-size`)
  }

  const metaFile = uploadMetaPathOf(file)
  let meta = null
  try { meta = JSON.parse(readFileSync(metaFile, 'utf8')) } catch { meta = null }
  const sameFile = meta && meta.bucket === bucket && meta.key === key && meta.size === size
    && meta.mtime === mtime && meta.partSize === plan.partSize

  let uploadId = ''
  let doneParts = []
  let adopted = false
  if (resume) {
    if (sameFile && meta.uploadId) {
      // 側車檔說「就是這個檔」→ 問伺服器還剩哪些片
      try {
        doneParts = await listParts(client, bucket, key, meta.uploadId)
        uploadId = meta.uploadId
      } catch { uploadId = '' }
    }
    if (!uploadId) {
      // 沒有可用的側車檔（客戶端把狀態弄丟了：瀏覽器清了 localStorage、CLI 被砍掉…）。
      // 既然使用者明示 --resume，就嘗試接手機上那個上傳 —— 但要有依據：**已收到的片
      // 大小必須與我們的規劃完全相符**（片大小由 partSize 與總大小決定，相符才代表
      // 同一個檔案、同一套規劃）。不相符的一律放棄，免得把不同內容的片拼起來。
      for (const candidate of await listMultipartUploads(client, bucket, key)) {
        if (candidate.key !== key) continue
        let parts = []
        try { parts = await listParts(client, bucket, key, candidate.uploadId) } catch { continue }
        const consistent = parts.length > 0 && parts.length < plan.partCount && parts.every((part) => {
          const expected = Math.min(plan.partSize, size - (part.partNumber - 1) * plan.partSize)
          return part.size === expected
        })
        if (consistent) {
          uploadId = candidate.uploadId
          doneParts = parts
          adopted = true
          break
        }
        try { await abortMultipart(client, bucket, key, candidate.uploadId) } catch {}
      }
    }
  }
  if (!uploadId) {
    // 沒有要續傳（或沒有可接手的）：把同 key 的殘留清乾淨再開新的
    if (!resume) {
      for (const stale of await listMultipartUploads(client, bucket, key)) {
        if (stale.key !== key) continue
        try { await abortMultipart(client, bucket, key, stale.uploadId) } catch {}
      }
    }
    uploadId = await createMultipart(client, bucket, key, contentType)
    doneParts = []
  }
  writeUploadMeta(metaFile, { bucket, key, size, mtime, partSize: plan.partSize, uploadId, updatedAt: new Date().toISOString() })
  if (adopted) {
    process.stderr.write(`note: 接手伺服器上未完成的上傳（沒有側車檔可比對，已用片大小確認一致；本次補 ${plan.partCount - doneParts.length} 片）\n`)
  }

  const have = new Map(doneParts.map((part) => [part.partNumber, part]))
  const todo = []
  for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) {
    if (!have.has(partNumber)) todo.push(partNumber)
  }

  // 進度以「位元組」為單位：已完成（含續傳接手）的片先算進去，之後每完成一片跳一次。
  const resumedBytes = [...have.values()].reduce((sum, part) => sum + (part.size || 0), 0)
  const progress = createProgress({
    label: `上傳 ${basename(file)}`,
    total: size,
    resumedFrom: resumedBytes,
    enabled: progressEnabled,
  })
  let completedBytes = resumedBytes
  const inFlight = new Set()

  const uploaded = await runPool(todo, concurrency, async (partNumber) => {
    inFlight.add(partNumber)
    progress.note(`第 ${partNumber}/${plan.partCount} 片（進行中 ${[...inFlight].join(',')}）`)
    const part = await uploadPart(client, {
      bucket, key, uploadId, partNumber, file, partSize: plan.partSize, totalSize: size, contentType,
    })
    inFlight.delete(partNumber)
    completedBytes += part.size
    progress.update(completedBytes, inFlight.size > 0 ? `進行中 ${[...inFlight].join(',')}` : '')
    return part
  })
  for (const part of uploaded) have.set(part.partNumber, part)

  const allParts = [...have.values()].sort((a, b) => a.partNumber - b.partNumber)
  const missing = []
  for (let partNumber = 1; partNumber <= plan.partCount; partNumber += 1) if (!have.has(partNumber)) missing.push(partNumber)
  if (missing.length > 0) {
    progress.done('待續傳')
    fail('MissingParts', `還缺第 ${missing.join('、')} 片，請再跑一次（--resume 會補）`)
  }

  progress.note(`${plan.partCount} 片都到位，收尾中…`)
  const completed = await completeMultipart(client, bucket, key, uploadId, allParts)
  const head = await headMeta(client, bucket, key)
  if (head.size !== size) {
    progress.done('大小不符')
    fail('SizeMismatch', `上傳後物件是 ${head.size} bytes，本地檔是 ${size} bytes`)
  }
  // 複合 ETag 驗證（multipart 的最終 ETag 不是物件 MD5）
  const composite = compositeEtag(allParts.map((part) => part.etag))
  const verified = composite && composite === completed.etag ? 'composite-etag' : 'size'
  progress.done(`驗證 ${verified}${adopted ? '（接手既有上傳）' : ''}`)
  try { require('node:fs').unlinkSync(metaFile) } catch {}
  return {
    bucket, key, size, partSize: plan.partSize, partCount: plan.partCount,
    uploaded: uploaded.length, resumed: doneParts.length > 0, adopted,
    etag: completed.etag, verified,
  }
}

function writeUploadMeta(file, meta) {
  try { writeFileSync(file, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 }) } catch {}
}

/** 複合 ETag：md5(各片 md5 的二進位串接) + "-片數"（用來驗 multipart 的內容）。 */
function compositeEtag(etags) {
  const digests = etags.filter((etag) => /^[0-9a-f]{32}$/i.test(etag || '')).map((etag) => Buffer.from(etag, 'hex'))
  if (digests.length === 0) return ''
  return createHash('md5').update(Buffer.concat(digests)).digest('hex') + '-' + digests.length
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `minio.mjs — MinIO/S3 檔案操作（零依賴，自行實作 SigV4）

用法：node minio.mjs <命令> [選項]

  buckets                                    列出所有桶
  ls [prefix]                                列一層（--bucket <桶>）
     --recursive                             列出前綴下所有物件
     --max <n>                               最多幾筆（預設 200）
  head --key <key>                           物件的存在、大小、型別（HEAD）
  get --key <key> [--out <path>] [--continue] 下載（--out 省略時把原始位元組寫到 stdout）
                                              --continue：以本地檔大小續傳（Range + If-Range，
                                              物件換過就自動從 0 重來；單片物件會驗 MD5）
  cat --key <key>                            以 UTF-8 讀出物件內容（有 64MiB 緩衝上限）
  put --key <key> (--from <path>|--content <text>) [--contentType <mime>]
                                             單次 PUT（小檔；沒有續傳）
  upload --key <key> --from <path> [--part-size 16MiB] [--concurrency 3] [--resume]
                                             multipart 上傳：大檔不受記憶體限制，中斷後
                                             再跑同一行（--resume）只補缺的片
  uploads [--key <key>]                      列出未完成（中斷）的上傳與已收到的片
  abort [--key <key>]                        放棄未完成的上傳（清掉伺服器上的片）
  rm --key <key> [--key <key> ...]            刪除（逐 key 失敗會自動逐一重試）
  mv --key <來源> --to <目標>                 複製 + 刪除原檔（S3 沒有 rename）
  mkdir --key <prefix/>                      建立資料夾標記
  mb --bucket <桶> / rb --bucket <桶>         建立 / 刪除桶（僅空桶）
  presign --key <key> [--expires 3600]        產生簽章連結

設定（第一次使用、以及之後要改的時候）：
  init [--from <file>|--content <json>] [--out <file>]
                                              把匯出的設定寫成設定檔（預設 ./minio.json）
                                              沒給 --from/--content 就從 stdin 讀
                                              （PowerShell 直接傳 --content 會被引號規則吃掉，
                                                請用 --from 或把 JSON 用管線進 stdin）
  config                                      顯示目前用的是哪一份設定（金鑰遮蔽）

共同選項：
  --config <file.json>   連線設定（預設 ./minio.json、./.dsh/minio.json、$MINIO_CONFIG）
  --bucket <桶>          預設桶（可省略，改用設定裡的 bucket）
  --json                 輸出 JSON（適合程式解析）
  --no-progress          關掉進度條（預設：stderr 是終端機時顯示；一律寫 stderr，
                         所以 stdout 可以安全地接管線或 --json）
                         環境變數 DSH_MINIO_S3_FORCE_PROGRESS=1 可強制顯示
`

/** 把 `init` 收進來的設定驗一遍，缺欄位就擋下來（避免寫進一份不能用的檔）。 */
function validateIncomingConfig(raw) {
  const endpoint = pick(raw, ['endpoint', 'S3_URL', 'url', 'host'])
  const accessKey = pick(raw, ['accessKey', 'accessKeyId', 'S3_UID', 'UID'])
  const secretKey = pick(raw, ['secretKey', 'secretAccessKey', 'S3_PWD', 'PWD'])
  const missing = []
  if (endpoint === '') missing.push('endpoint')
  if (accessKey === '') missing.push('accessKey')
  if (secretKey === '') missing.push('secretKey')
  if (missing.length > 0) {
    fail('ConfigMissing', `匯出的設定缺少 ${missing.join('、')}。面板的「❗️ 複製設定」應該會給 endpoint/accessKey/secretKey/region/bucket。`)
  }
  return { endpoint, accessKey, secretKey, bucket: pick(raw, ['bucket', 'S3_BUCK', 'BUCKET']), region: pick(raw, ['region', 'S3_REGION']) }
}

async function runInit(args) {
  let text
  if (typeof args.flags.content === 'string') text = args.flags.content
  else if (typeof args.flags.from === 'string') {
    try { text = readFileSync(args.flags.from, 'utf8') } catch (error) { fail('ConfigUnreadable', `讀不到 ${args.flags.from}：${error.message}`) }
  } else if (process.stdin.isTTY) {
    fail('MissingInput', '請把匯出的 JSON 貼進來（stdin），或用 --from <file> / --content \'<json>\'。')
  } else {
    try { text = readFileSync(0, 'utf8') } catch (error) { fail('ConfigUnreadable', `讀不到 stdin：${error.message}`) }
  }

  let raw
  try { raw = JSON.parse(String(text).trim()) } catch (error) { fail('InvalidJson', `不是合法 JSON：${error.message}`) }
  const fields = validateIncomingConfig(raw)

  const out = typeof args.flags.out === 'string' ? args.flags.out : 'minio.json'
  writeFileSync(out, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 })
  const payload = { ok: true, path: out, source: 'init', ...fields, secretKey: `${String(fields.secretKey).slice(0, 2)}***` }
  if (args.flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  else {
    process.stdout.write(`已寫入 ${out}\n`
      + `  endpoint  ${fields.endpoint}\n`
      + `  accessKey ${fields.accessKey}\n`
      + `  secretKey ${String(fields.secretKey).slice(0, 2)}***（已遮蔽）\n`
      + `  region    ${fields.region || '(未指定，使用時自動探測)'}\n`
      + `  bucket    ${fields.bucket || '(未指定，用 --bucket 指定)'}\n`
      + `這份檔案含金鑰：不要 commit、不要貼給別人；要改金鑰/端點/預設桶就再跑一次 init，或直接編輯它。\n`)
  }
}

async function main() {
  const args = parseArgv(process.argv.slice(2))
  const command = args._[0]
  if (!command || args.flags.help) {
    process.stdout.write(USAGE)
    // 沒有命令才是用法錯誤；單純 `--help` 是正常結束。
    if (!command && !args.flags.help) process.exitCode = 1
    return
  }
  // init 必須在 loadConfig 之前：那時還沒有一份可用的設定。
  if (command === 'init') {
    await runInit(args)
    return
  }

  const config = loadConfig(args)
  const client = makeClient(config)
  await client.probeRegion()

  const bucket = args.flags.bucket === undefined ? config.bucket : String(args.flags.bucket)
  const needBucket = () => {
    if (!bucket) fail('BucketMissing', '缺少桶名：設定裡沒有 bucket，請加 --bucket <桶>')
    return bucket
  }
  const keys = args.key.length > 0 ? args.key : (typeof args.flags.key === 'string' ? [args.flags.key] : [])
  /** 進度條開關：預設交給 createProgress（看 TTY），--no-progress 一律關。 */
  const progressOption = args.flags['no-progress'] === true
    ? false
    : (args.flags.progress === true ? true : undefined)
  const print = (payload, human) => {
    if (args.flags.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
    else process.stdout.write(human + '\n')
  }

  switch (command) {
    case 'config': {
      const mask = (value) => (typeof value === 'string' && value.length > 2
        ? `${value.slice(0, 2)}***`
        : '***')
      const info = {
        source: config.source,
        endpoint: config.endpoint,
        accessKey: config.accessKey,
        secretKey: mask(config.secretKey),
        region: client.state.region,
        regionPinned: Boolean(config.region),
        bucket: config.bucket || '(未指定)',
      }
      print(info, `設定來源 ${config.source}\n`
        + `  endpoint  ${info.endpoint}\n`
        + `  accessKey ${info.accessKey}\n`
        + `  secretKey ${info.secretKey}（已遮蔽）\n`
        + `  region    ${info.region}${info.regionPinned ? '' : '（自動探測）'}\n`
        + `  bucket    ${info.bucket}`)
      break
    }
    case 'buckets': {
      const buckets = await listBuckets(client)
      print({ endpoint: config.endpoint, region: client.state.region, buckets },
        buckets.map((entry) => `${entry.name}\t${entry.createdAt}`).join('\n') || '(沒有桶)')
      break
    }
    case 'ls': {
      const listing = await listObjects(client, needBucket(), args._[1] || '', args.flags.recursive === true,
        Number(args.flags.max || 200))
      const lines = []
      for (const folder of listing.folders) lines.push(`dir\t${folder}`)
      for (const entry of listing.objects) lines.push(`${entry.size}\t${entry.lastModified}\t${entry.key}`)
      print({ bucket, region: client.state.region, ...listing }, lines.join('\n') || '(空)')
      break
    }
    case 'head': {
      const info = await headMeta(client, needBucket(), keys[0])
      print(info, `${info.size}\t${info.lastModified}\t${info.contentType}`)
      break
    }
    case 'get': {
      if (args.flags.out) {
        const result = await downloadToFile(client, needBucket(), keys[0], args.flags.out, {
          continue: args.flags.continue === true,
          progress: progressOption,
        })
        const note = result.alreadyComplete
          ? '已是最新（未重新下載）'
          : `${result.resumed ? '續傳完成' : '下載完成'}，驗證方式 ${result.verified}`
        print({ key: keys[0], out: args.flags.out, ...result },
          `wrote ${args.flags.out} (${result.bytes} bytes) — ${note}`)
        break
      }
      // 沒有 --out：原始位元組寫到 stdout（串流，不落地）
      const response = await client.send({ url: client.objectUrl(needBucket(), keys[0]) })
      await pipeline(Readable.fromWeb(response.body), process.stdout)
      break
    }
    case 'cat': {
      const result = await getObject(client, needBucket(), keys[0])
      process.stdout.write(args.flags.json
        ? JSON.stringify({ key: keys[0], bytes: result.bytes, content: result.body.toString('utf8') }, null, 2) + '\n'
        : result.body.toString('utf8'))
      break
    }
    case 'put': {
      let body
      if (typeof args.flags.from === 'string') body = readFileSync(args.flags.from)
      else if (typeof args.flags.content === 'string') body = Buffer.from(args.flags.content, 'utf8')
      else fail('MissingBody', '需要 --from <path> 或 --content <text>')
      const result = await putObject(client, needBucket(), keys[0], body, args.flags.contentType)
      print(result, `put ${result.key} (${result.bytes} bytes)`)
      break
    }
    case 'upload': {
      if (typeof args.flags.from !== 'string') fail('MissingBody', '需要 --from <path>')
      if (keys.length === 0) fail('MissingKey', '需要 --key <key>')
      const result = await uploadFile(client, {
        bucket: needBucket(),
        key: keys[0],
        file: args.flags.from,
        contentType: args.flags.contentType,
        partSizeOverride: parseSize(args.flags['part-size'], 0) || undefined,
        concurrency: Number(args.flags.concurrency || 3),
        resume: args.flags.resume === true,
        progress: progressOption,
      })
      print(result, `uploaded ${result.key} (${result.size} bytes, ${result.partCount} 片 × ${result.partSize}`
        + `${result.resumed ? `，續傳（本次補 ${result.uploaded} 片）` : ''}，驗證 ${result.verified})`)
      break
    }
    case 'uploads': {
      const list = await inProgressUploads(client, needBucket(), args.flags.key ? String(args.flags.key) : '')
      const lines = list.map((entry) => `${entry.key}\t${entry.uploadId}\t${entry.parts.length} 片\t${entry.initiated}`)
      print({ bucket, uploads: list }, lines.join('\n') || '(沒有未完成的上傳)')
      break
    }
    case 'abort': {
      const list = await inProgressUploads(client, needBucket(), args.flags.key ? String(args.flags.key) : '')
      const aborted = []
      for (const entry of list) {
        await abortMultipart(client, needBucket(), entry.key, entry.uploadId)
        aborted.push(entry.key)
      }
      print({ bucket, aborted }, aborted.join('\n') || '(沒有可放棄的上傳)')
      break
    }
    case 'rm': {
      if (keys.length === 0) fail('MissingKey', '需要 --key <key>')
      const result = await deleteObjects(client, needBucket(), keys)
      if (result.errors.length > 0) {
        print(result, `刪除 ${result.deleted.length}/${keys.length}，失敗：${result.errors.map((e) => `${e.key} ${e.code}`).join('、')}`)
        process.exitCode = 1
      } else {
        print(result, `deleted ${result.deleted.length}${result.retried.length ? ` (${result.retried.length} 改用單物件刪除)` : ''}`)
      }
      break
    }
    case 'mv': {
      if (typeof args.flags.to !== 'string') fail('MissingTarget', '需要 --to <目標 key>')
      await copyObject(client, needBucket(), keys[0], args.flags.to)
      const result = await deleteObjects(client, needBucket(), [keys[0]])
      if (result.errors.length > 0) {
        print({ copied: true, deleted: false, ...result }, `已複製到 ${args.flags.to}，但原檔刪不掉：${result.errors.map((e) => e.code).join('、')}`)
        process.exitCode = 1
      } else {
        print({ from: keys[0], to: args.flags.to }, `${keys[0]} → ${args.flags.to}`)
      }
      break
    }
    case 'mkdir': {
      const result = await putObject(client, needBucket(), keys[0], Buffer.alloc(0), 'application/x-directory')
      print(result, `mkdir ${result.key}`)
      break
    }
    case 'mb': {
      await client.send({ method: 'PUT', url: client.objectUrl(needBucket(), '') })
      print({ bucket, created: true }, `bucket ${bucket} created`)
      break
    }
    case 'rb': {
      await client.send({ method: 'DELETE', url: client.objectUrl(needBucket(), '') })
      print({ bucket, deleted: true }, `bucket ${bucket} deleted`)
      break
    }
    case 'presign': {
      const url = presign({
        url: client.objectUrl(needBucket(), keys[0]),
        accessKey: config.accessKey,
        secretKey: config.secretKey,
        region: client.state.region,
        expires: Number(args.flags.expires || 3600),
      })
      print({ key: keys[0], expires: Number(args.flags.expires || 3600), url }, url)
      break
    }
    default:
      fail('UnknownCommand', `不認得的命令：${command}（用 --help 看用法）`)
  }
}

main().catch((error) => {
  process.stderr.write(`error: ${(error && error.message) || String(error)}\n`)
  process.exitCode = 1
})
