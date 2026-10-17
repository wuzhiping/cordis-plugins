'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// Verify the region fix end-to-end in a FRESH process (not through the reloaded plugin).
const { ConnectionProvider } = require(require('node:path').join(PLUGIN, 'src/storage.js'))

const PREFIX = '_dsh_minio_s3_region/'
const BUCKET = 'dsh'
let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

;(async () => {
  const provider = new ConnectionProvider({ ttlMs: 1000 })
  const got = await provider.get()
  if (!got.ok) { console.log('CONN FAIL', got); process.exit(1) }
  const s3 = got.client
  ok('region 由探測得到（不是預設 us-east-1）', s3.region === 'us-west-rack-2', { region: s3.region })
  ok('region 記在 provider 上（跨請求保留）', provider.region === 'us-west-rack-2', { region: provider.region })

  const key = PREFIX + 'p.txt'
  await s3.putObject({ bucket: BUCKET, key, body: Buffer.from('region fix', 'utf8') })

  // presign：這是修好之前會 400 的路徑
  const url = s3.presignObject({ bucket: BUCKET, key, expires: 300 })
  const presigned = await fetch(url)
  ok('presign 連結可用', presigned.status === 200 && (await presigned.text()) === 'region fix', { status: presigned.status })

  // 批次刪除：這是修好之前會逐 key 回 AuthorizationHeaderMalformed 的路徑
  const result = await s3.deleteObjects(BUCKET, [key])
  ok('批次刪除成功（無逐 key 錯誤）', result.errors.length === 0 && result.deleted.includes(key), result)

  // 再拿一次連線（新 client）也要沿用學到的 region
  const again = await provider.get()
  ok('新 client 沿用 region', again.client.region === 'us-west-rack-2', { region: again.client.region })
  const againPresign = await fetch(again.client.presignObject({ bucket: BUCKET, key: 'nope.txt', expires: 300 }))
  ok('新 client 的 presign 也通過驗簽（404 而不是 400）', againPresign.status === 404, { status: againPresign.status })

  console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', error && error.stack); process.exitCode = 1 })
