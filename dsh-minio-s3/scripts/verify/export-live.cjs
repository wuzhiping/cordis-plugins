'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// Drive the plugin's NEW /export route against the REAL MinIO from a fresh process
// (bypasses the stale module loaded in the running host).
const { Readable } = require('node:stream')
const host = require(require('node:path').join(PLUGIN, 'src/index.js'))

let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}
const mask = (value) => (typeof value === 'string' && value.length > 2
  ? value.slice(0, 2) + '*'.repeat(Math.max(1, value.length - 2))
  : String(value))

const routes = new Map()
host.apply({
  logger: { info() {}, warn() {}, error() {} },
  effect(callback) { return callback() },
  webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  connection: { requestRejection: () => undefined },
  sessions: { get: () => null },
  tools: { register: () => () => {} },
})

function call(path, options) {
  const opts = options || {}
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = Readable.from([])
    req.method = opts.method || 'GET'
    req.url = path
    req.headers = opts.headers || {}
    const res = {
      headersSent: false,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; this.headersSent = true },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) }) },
    }
    Promise.resolve(routes.get(path.split('?')[0]).handler(req, res)).catch(reject)
  })
}

;(async () => {
  const exported = await call(host.ROUTE.exportConfig, {
    method: 'POST',
    headers: { 'x-dsh-minio-s3': 'export', 'content-type': 'application/json' },
  })
  const payload = JSON.parse(exported.body.toString('utf8'))
  console.log('POST /export →', exported.status, '| 欄位:', Object.keys(payload).join(','))
  ok('HTTP 200 且 ok:true', exported.status === 200 && payload.ok === true)
  ok('provider=minio', payload.provider === 'minio')
  ok('endpoint 為 http(s) 網址', /^https?:\/\//.test(payload.endpoint || ''), { endpoint: payload.endpoint })
  ok('accessKey 非空', typeof payload.accessKey === 'string' && payload.accessKey.length > 0, { accessKey: payload.accessKey })
  ok('secretKey 非空', typeof payload.secretKey === 'string' && payload.secretKey.length > 0, { secretKey: mask(payload.secretKey) })
  ok('region 是端點真正的 region（不是預設 us-east-1）', payload.region === 'us-west-rack-2', { region: payload.region })
  ok('預設 bucket 來自 storage 記錄', payload.bucket === 'dsh', { bucket: payload.bucket })
  ok('usePathStyle=true（MinIO 要 path-style）', payload.usePathStyle === true && payload.forcePathStyle === true)
  ok('附帶桶清單', Array.isArray(payload.buckets) && payload.buckets.length > 0, { count: (payload.buckets || []).length })
  ok('exportedAt 是 ISO 時間', /^\d{4}-\d{2}-\d{2}T/.test(payload.exportedAt || ''))
  ok('回應不可快取', exported.headers['cache-control'] === 'no-store')

  // 匯出的內容真的能拿去連線：用同一組值另開一個 client 列桶
  const { S3Client } = require(require('node:path').join(PLUGIN, 'src/s3.js'))
  const clone = new S3Client({
    endpoint: payload.endpoint,
    accessKey: payload.accessKey,
    secretKey: payload.secretKey,
    region: payload.region,
  })
  const buckets = await clone.listBuckets()
  ok('用匯出的 JSON 另開 client 可以列桶', buckets.length > 0, { count: buckets.length })
  const first = await clone.listObjectsV2({ bucket: payload.bucket, prefix: '', delimiter: '/' })
  ok('預設 bucket 可以列物件', Array.isArray(first.contents), { objects: first.contents.length, folders: first.commonPrefixes.length })

  const viaGet = await call(host.ROUTE.exportConfig, { method: 'GET' })
  ok('GET 不匯出（405）', viaGet.status === 405, { status: viaGet.status })

  console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', (error && error.stack) || error); process.exitCode = 1 })
