'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// End-to-end over the LIVE installed plugin's HTTP routes (real MinIO, real host).
const BASE = 'http://127.0.0.1:3080/plugins/dsh-minio-s3'
const BUCKET = 'dsh'
const PREFIX = '_dsh_minio_s3_routes/'

let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

async function json(path, init) {
  const response = await fetch(BASE + path, init)
  const text = await response.text()
  let payload = null
  try { payload = JSON.parse(text) } catch {}
  return { status: response.status, payload, text }
}

;(async () => {
  const key = PREFIX + 'http 上傳+測試.txt'
  const query = (extra) => new URLSearchParams({ bucket: BUCKET, ...extra }).toString()

  const put = await json('/object?' + query({ key }), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from('http route round trip\n中文\n', 'utf8'),
  })
  ok('PUT /object', put.status === 200 && put.payload.ok === true, put.payload)

  const folder = await json('/folder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: BUCKET, key: PREFIX + 'folder/' }),
  })
  ok('POST /folder', folder.status === 200, folder.payload)

  const list = await json('/objects?' + query({ prefix: PREFIX }))
  const folders = list.payload.folders.map((entry) => entry.prefix)
  const objects = list.payload.objects.map((entry) => entry.key)
  ok('GET /objects 一層', list.status === 200 && folders.includes(PREFIX + 'folder/'), { folders, objects })
  ok('GET /objects key 解碼正確', objects.includes(key), objects)

  const download = await fetch(BASE + '/object?' + query({ key }))
  const body = await download.text()
  ok('GET /object 下載', download.status === 200 && body === 'http route round trip\n中文\n', {
    status: download.status,
    disposition: download.headers.get('content-disposition'),
  })

  // inline 只放**點陣圖**：這個代理回應與 DSH 同源、外殼沒有 CSP，讓 text/html 或
  // image/svg+xml 以 inline 出去等於在應用來源上跑任意腳本。文字因此一律
  // octet-stream + attachment。
  const inlineText = await fetch(BASE + '/object?' + query({ key, inline: '1' }))
  ok('GET /object?inline=1（非點陣圖）→ octet-stream + attachment',
    inlineText.status === 200
      && (inlineText.headers.get('content-type') || '').split(';')[0].trim() === 'application/octet-stream'
      && (inlineText.headers.get('content-disposition') || '').startsWith('attachment'),
    { contentType: inlineText.headers.get('content-type'), disposition: inlineText.headers.get('content-disposition') })

  // 真的點陣圖可以 inline（面板預覽用）
  const pngKey = PREFIX + 'pixel.png'
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea735e25b0000000049454e44ae426082', 'hex')
  await json('/object?' + query({ key: pngKey }), {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: PNG,
  })
  const inlinePng = await fetch(BASE + '/object?' + query({ key: pngKey, inline: '1' }))
  ok('GET /object?inline=1（PNG）→ image/png 且沒有 attachment',
    inlinePng.status === 200
      && inlinePng.headers.get('content-type') === 'image/png'
      && inlinePng.headers.get('content-disposition') === null,
    { contentType: inlinePng.headers.get('content-type'), disposition: inlinePng.headers.get('content-disposition') })

  const presign = await json('/presign?' + query({ key, expires: '300' }))
  const presignedGet = await fetch(presign.payload.url)
  ok('GET /presign 的連結可用', presignedGet.status === 200, { status: presignedGet.status, host: new URL(presign.payload.url).host })

  const rename = await json('/copy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: BUCKET, fromKey: key, toKey: PREFIX + 'renamed.txt' }),
  })
  ok('POST /copy', rename.status === 200 && rename.payload.copied === true, rename.payload)

  const batch = await json('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: BUCKET, keys: [key, PREFIX + 'renamed.txt', pngKey, PREFIX + 'folder/'] }),
  })
  ok('POST /delete 批次', batch.status === 200 && batch.payload.errors.length === 0, batch.payload)

  const after = await json('/objects?' + query({ prefix: PREFIX }))
  ok('清理後前綴為空', after.payload.objects.length === 0 && after.payload.folders.length === 0,
    { objects: after.payload.objects.map((entry) => entry.key), folders: after.payload.folders.map((entry) => entry.prefix) })

  const bad = await json('/object?' + query({ key: '../escape.txt' }))
  ok('路徑逃逸被擋', bad.status === 400, { status: bad.status, payload: bad.payload })

  const missing = await json('/object?' + query({ key: PREFIX + 'nope.txt' }))
  ok('不存在的 key 回 404 NoSuchKey', missing.status === 404 && missing.payload.code === 'NoSuchKey', missing.payload)

  console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
  process.exit(failed === 0 ? 0 : 1)
})().catch((error) => { console.log('FATAL', error && error.stack); process.exit(1) })
