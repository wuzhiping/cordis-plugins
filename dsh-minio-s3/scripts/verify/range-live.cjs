'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// Phase 1 驗證：把外掛的「新」宿主程式碼掛在假 ctx 上，對真 MinIO 打 /object 的 Range 行為。
// （活動中的宿主行程還是舊模組，所以只能在這裡驗。）
const { Readable } = require('node:stream')
const host = require(require('node:path').join(PLUGIN, 'src/index.js'))

let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

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
    const payload = opts.body === undefined
      ? []
      : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf8')]
    const req = Readable.from(payload)
    req.method = opts.method || 'GET'
    req.url = path
    req.headers = opts.headers || {}
    const res = {
      headersSent: false,
      writeHead(status, headers) { this.statusCode = status; this.headers = headers || {}; this.headersSent = true },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true },
      once() {},
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) }) },
    }
    Promise.resolve(routes.get(path.split('?')[0]).handler(req, res)).catch(reject)
  })
}

;(async () => {
  const BUCKET = 'dsh'
  const KEY = '_range_live/probe.bin'
  const PAYLOAD = Buffer.from('0123456789abcdefghij', 'utf8')
  const objectRoute = host.ROUTE.object
  const q = (extra) => new URLSearchParams({ bucket: BUCKET, key: KEY, ...extra }).toString()

  await call(objectRoute + '?' + q({}), {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: PAYLOAD,
  })

  const plain = await call(objectRoute + '?' + q({}))
  ok('無 Range → 200 且帶 Accept-Ranges', plain.status === 200 && plain.headers['accept-ranges'] === 'bytes',
    { status: plain.status, acceptRanges: plain.headers['accept-ranges'], len: plain.body.length })

  const ranged = await call(objectRoute + '?' + q({}), { headers: { range: 'bytes=5-9' } })
  ok('Range → 206 + Content-Range + 正確切片',
    ranged.status === 206 && ranged.headers['content-range'] === 'bytes 5-9/20' && ranged.body.toString('utf8') === '56789',
    { status: ranged.status, contentRange: ranged.headers['content-range'], body: ranged.body.toString('utf8') })

  const tail = await call(objectRoute + '?' + q({}), { headers: { range: 'bytes=15-' } })
  ok('開放式尾段 → 206（續傳的形狀）',
    tail.status === 206 && tail.headers['content-range'] === 'bytes 15-19/20' && tail.body.toString('utf8') === 'fghij',
    { status: tail.status, contentRange: tail.headers['content-range'] })

  const beyond = await call(objectRoute + '?' + q({}), { headers: { range: 'bytes=999-' } })
  ok('越界 → 416 且我們補上 Content-Range: bytes */size（MinIO 自己不給）',
    beyond.status === 416 && beyond.headers['content-range'] === 'bytes */20',
    { status: beyond.status, contentRange: beyond.headers['content-range'] })

  const etag = plain.headers.etag
  const match = await call(objectRoute + '?' + q({}), { headers: { range: 'bytes=10-19', 'if-range': etag } })
  ok('If-Range 相符 → 206', match.status === 206 && match.body.toString('utf8') === 'abcdefghij',
    { status: match.status, etag })

  const stale = await call(objectRoute + '?' + q({}), { headers: { range: 'bytes=10-19', 'if-range': '"deadbeefdeadbeefdeadbeefdeadbeef"' } })
  ok('If-Range 不符 → 200 全量（MinIO 自己會回 206，這層保護由宿主提供）',
    stale.status === 200 && stale.body.length === 20 && stale.headers['content-range'] === undefined,
    { status: stale.status, len: stale.body.length })

  const head = await call(objectRoute + '?' + q({}), { method: 'HEAD' })
  ok('HEAD 帶 Accept-Ranges 與長度', head.status === 200 && head.headers['accept-ranges'] === 'bytes' && head.headers['content-length'] === '20')

  // 清理
  await call(objectRoute + '?' + q({}), { method: 'DELETE' })
  const after = await call(host.ROUTE.objects + '?' + new URLSearchParams({ bucket: BUCKET, prefix: '_range_live/' }).toString())
  ok('清理完成', JSON.parse(after.body.toString('utf8')).objects.length === 0)

  console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', (error && error.stack) || error); process.exitCode = 1 })
