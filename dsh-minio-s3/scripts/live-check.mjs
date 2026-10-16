/**
 * 對「正在運行的 DSH 宿主外掛」做一次端到端實機檢查（不經 cordis、不碰憑證）。
 *
 * 用途：改完宿主半邊的程式碼、重啟 DSH 之後，確認線上那顆外掛真的會
 * 列桶／上傳／下載／預覽／簽章連結／批次刪除（region 修正是否生效）。
 *
 * 跑法：
 *   node scripts/live-check.mjs                     # 預設 http://127.0.0.1:3080
 *   DSH_MINIO_S3_BASE=http://127.0.0.1:3080 node scripts/live-check.mjs
 *   node scripts/live-check.mjs --bucket dsh        # 指定桶（預設用 /status 回的預設桶）
 *
 * 它只在桶裡建立 `_dsh_minio_s3_livecheck/` 底下的臨時物件，結束前全部刪掉。
 */
import { Buffer } from 'node:buffer'

const BASE = (process.env.DSH_MINIO_S3_BASE || 'http://127.0.0.1:3080').replace(/\/+$/, '')
const API = BASE + '/plugins/dsh-minio-s3'
const PREFIX = '_dsh_minio_s3_livecheck/'

const bucketArg = process.argv.indexOf('--bucket')
const BUCKET_OVERRIDE = bucketArg >= 0 ? process.argv[bucketArg + 1] : ''

let failed = 0
function ok(label, condition, extra) {
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!condition) failed += 1
}

async function call(path, init) {
  const response = await fetch(API + path, init)
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { /* 非 JSON：保留原文 */ }
  return { status: response.status, payload, headers: response.headers, text }
}

function query(pairs) {
  return new URLSearchParams(pairs).toString()
}

async function main() {
  // `?debug=1` 是唯一會回 region／來源／ref 的出口（面板預設看不到這些）。
  const status = await call('/status?debug=1')
  if (!status.payload || status.payload.ok !== true) {
    console.log('SKIP：連線不可用 —', JSON.stringify(status.payload))
    process.exitCode = 1
    return
  }
  const bucket = BUCKET_OVERRIDE || status.payload.bucket || (status.payload.buckets[0] || {}).name
  console.log(`宿主 ${BASE} | 版本 ${status.payload.version} | region ${status.payload.region} | 桶 ${bucket}`)
  ok('連線可用且桶清單非空', Array.isArray(status.payload.buckets) && status.payload.buckets.length > 0)
  ok('region 已由端點探測得到（不是預設 us-east-1）', status.payload.region !== 'us-east-1',
    { region: status.payload.region })

  const key = PREFIX + 'live check 中文+plus.txt'
  const body = 'live check body\n第二行\n'

  const put = await call('/object?' + query({ bucket, key }), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from(body, 'utf8'),
  })
  ok('PUT /object 上傳', put.status === 200 && put.payload.ok === true, put.payload)

  const list = await call('/objects?' + query({ bucket, prefix: PREFIX }))
  ok('GET /objects 列出一層且 key 解碼正確',
    list.status === 200 && list.payload.objects.some((entry) => entry.key === key),
    list.payload && list.payload.objects.map((entry) => entry.key))

  const download = await fetch(API + '/object?' + query({ bucket, key }))
  ok('GET /object 下載內容一致', download.status === 200 && (await download.text()) === body,
    { status: download.status })

  const presign = await call('/presign?' + query({ bucket, key, expires: '300' }))
  if (presign.payload && presign.payload.url) {
    const signed = await fetch(presign.payload.url)
    ok('presign 連結可用（region 修正的關鍵指標）', signed.status === 200, { status: signed.status })
  } else {
    ok('presign 連結可用（region 修正的關鍵指標）', false, presign.payload)
  }

  const removed = await call('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket, keys: [key] }),
  })
  ok('POST /delete 批次刪除（region 修正的關鍵指標）',
    removed.status === 200 && removed.payload.errors.length === 0, removed.payload)

  const after = await call('/objects?' + query({ bucket, prefix: PREFIX }))
  ok('清理後前綴為空', after.payload.objects.length === 0)

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.log('FATAL', (error && error.stack) || error)
  process.exitCode = 1
})
