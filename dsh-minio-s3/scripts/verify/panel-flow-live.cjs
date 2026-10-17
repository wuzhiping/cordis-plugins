'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// Phase 3 驗證：完全照**面板**會打的那串 HTTP 走一遍（掛真外掛程式碼 + 真 MinIO）。
//   1. init → 3 片 → complete（含中途「重整頁面」後 init 接手 → 只補缺片）
//   2. /upload/status 看得到未完成的片
//   3. abort 清乾淨
const { Readable } = require('node:stream')
const crypto = require('node:crypto')
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
const json = (result) => JSON.parse(result.body.toString('utf8'))

const BUCKET = 'dsh'
const KEY = '_panel_flow/big.bin'
const TOTAL = 21 * 1024 * 1024
const payload = crypto.randomBytes(TOTAL)
const md5 = crypto.createHash('md5').update(payload).digest('hex')

const initUpload = (size) => call(host.ROUTE.uploadInit, {
  method: 'POST', url: host.ROUTE.uploadInit, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ bucket: BUCKET, key: KEY, size, contentType: 'application/octet-stream' }),
})
const putPart = (uploadId, partNumber, partSize) => call(host.ROUTE.uploadPart + '?' + new URLSearchParams({
  bucket: BUCKET, key: KEY, uploadId, partNumber: String(partNumber),
}).toString(), {
  method: 'PUT', headers: { 'content-type': 'application/octet-stream' },
  body: payload.subarray((partNumber - 1) * partSize, Math.min(partNumber * partSize, TOTAL)),
})
const complete = (uploadId, parts) => call(host.ROUTE.uploadComplete, {
  method: 'POST', url: host.ROUTE.uploadComplete, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ bucket: BUCKET, key: KEY, uploadId, parts }),
})
const status = () => call(host.ROUTE.uploadStatus + '?' + new URLSearchParams({ bucket: BUCKET, key: KEY }).toString())
const abort = (uploadId) => call(host.ROUTE.uploadAbort, {
  method: 'POST', url: host.ROUTE.uploadAbort, headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ bucket: BUCKET, key: KEY, uploadId }),
})

;(async () => {
  // 先清掉殘留
  for (const entry of (json(await status()).uploads || [])) await abort(entry.uploadId)
  await call(host.ROUTE.object + '?' + new URLSearchParams({ bucket: BUCKET, key: KEY }).toString(), { method: 'DELETE' })

  // ---- 1) 第一次：init → 只上傳 1、2 片（模擬中途關掉頁面）-------------------
  const first = json(await initUpload(TOTAL))
  ok('init 回規劃', first.partSize === 8 * 1024 * 1024 && first.partCount === 3 && first.resumed === false, first)
  const p1 = json(await putPart(first.uploadId, 1, first.partSize))
  const p2 = json(await putPart(first.uploadId, 2, first.partSize))
  ok('兩片都回 ETag（該片 MD5）', /^[0-9a-f]{32}$/.test(p1.etag) && /^[0-9a-f]{32}$/.test(p2.etag))

  const midway = json(await status())
  ok('/upload/status 看得到未完成（2 片）', midway.uploads.length === 1 && midway.uploads[0].parts.length === 2,
    midway.uploads.map((entry) => entry.parts.length))

  // ---- 2) 模擬「重新整理頁面後重選同一個檔案」：再 init → 接手 ----------------
  const second = json(await initUpload(TOTAL))
  ok('init 接手同一個 uploadId', second.uploadId === first.uploadId, { before: first.uploadId.slice(0, 12), after: second.uploadId.slice(0, 12) })
  ok('init 回報已收到的片（面板只補缺的）', second.resumed === true && second.parts.map((part) => part.partNumber).sort().join(',') === '1,2',
    second.parts.map((part) => part.partNumber))

  const p3 = json(await putPart(second.uploadId, 3, second.partSize))
  const done = json(await complete(second.uploadId, [p1, p2, p3].map((part) => ({ partNumber: part.partNumber, etag: part.etag }))))
  ok('complete 回大小', done.size === TOTAL, { size: done.size, etag: done.etag })

  const fetched = await call(host.ROUTE.object + '?' + new URLSearchParams({ bucket: BUCKET, key: KEY }).toString())
  const remoteMd5 = crypto.createHash('md5').update(fetched.body).digest('hex')
  ok('物件內容與本地一致（MD5）', remoteMd5 === md5, { local: md5, remote: remoteMd5, bytes: fetched.body.length })

  // ---- 3) 收尾：完成後 status 應該空了；abort 也應該清乾淨 -------------------
  ok('完成後 status 清空', json(await status()).uploads.length === 0)

  const third = json(await initUpload(TOTAL))
  ok('再造一個未完成的上傳', typeof third.uploadId === 'string' && third.uploadId.length > 0)
  await putPart(third.uploadId, 1, third.partSize)
  const aborted = await abort(third.uploadId)
  ok('abort 成功', aborted.status === 200, json(aborted))
  ok('abort 後 status 清空', json(await status()).uploads.length === 0)

  await call(host.ROUTE.object + '?' + new URLSearchParams({ bucket: BUCKET, key: KEY }).toString(), { method: 'DELETE' })
  const after = json(await call(host.ROUTE.objects + '?' + new URLSearchParams({ bucket: BUCKET, prefix: '_panel_flow/' }).toString()))
  ok('清理完成', after.objects.length === 0 && after.folders.length === 0)

  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', (error && error.stack) || error); process.exitCode = 1 })
