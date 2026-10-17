'use strict'
/**
 * 刪除路徑的真機驗證。
 *
 * 這裡測的是「對活動宿主打真實 HTTP」：批次刪除要回報真的刪掉了、單物件刪除要能當
 * 退路、錯誤不能被吞成假成功。
 *
 * 關於「HTTP 200 但逐 key 回 <Error>」那個坑（region 沒對上時真的發生過，使用者看到
 * 的症狀是「改名後多一個檔案」）：**Live 環境現在重現不出來** —— region 會自動學到，
 * 批次刪除會成功。那條路徑由離線測試 `test/host.test.js` 的 `makeBatchFail` 假伺服器
 * 釘住（回 HTTP 200 + 逐 key AuthorizationHeaderMalformed），不要在這裡假裝重現。
 */
const BASE = 'http://127.0.0.1:3080/plugins/dsh-minio-s3'
const BUCKET = 'dsh'
const PREFIX = '_dsh_minio_s3_delete/'

let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

const call = async (path, init) => {
  const response = await fetch(BASE + path, init)
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch {}
  return { status: response.status, payload }
}
const query = (extra) => new URLSearchParams({ bucket: BUCKET, ...extra }).toString()

;(async () => {
  const key = PREFIX + 'delete-me.txt'
  const other = PREFIX + 'delete-me-too.txt'

  await call('/object?' + query({ key }), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('delete check'),
  })
  await call('/object?' + query({ key: other }), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from('delete check 2'),
  })
  const before = await call('/objects?' + query({ prefix: PREFIX }))
  ok('前置：兩個物件已建立', before.payload.objects.length === 2, before.payload.objects.map((entry) => entry.key))

  // 1) 批次刪除：真的刪掉，而且 errors 是空的（不是「HTTP 200 的假成功」）
  const batch = await call('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: BUCKET, keys: [key, other] }),
  })
  ok('批次刪除回報刪掉的 key', batch.status === 200 && batch.payload.ok === true
    && (batch.payload.deleted || []).length === 2, batch.payload)
  ok('批次刪除沒有逐 key 錯誤', (batch.payload.errors || []).length === 0,
    { errors: (batch.payload.errors || []).map((entry) => entry.code) })
  const after = await call('/objects?' + query({ prefix: PREFIX }))
  ok('物件真的消失了', after.payload.objects.length === 0, after.payload.objects.map((entry) => entry.key))

  // 2) 單物件 DELETE 是退路：對不存在的 key 也應該成功（S3 語意：刪除是幂等的）
  const missingDelete = await call('/object?' + query({ key: PREFIX + 'never-existed.txt' }), { method: 'DELETE' })
  ok('DELETE 不存在的 key 仍回成功（幂等）', missingDelete.status === 200 && missingDelete.payload.ok === true, missingDelete.payload)

  // 3) 錯誤不可以被吞：把「不存在的桶」當成一個必然失敗的對象
  //    批次刪除的回應是 **HTTP 200 + 逐 key errors**（這是 S3 的語意：請求本身成功），
  //    所以正確的契約是 errors 非空、而且訊息要帶上「逐一刪除也失敗」的退路結果 ——
  //    不是靜默回 ok:true 當成刪掉了。
  const badBucketName = 'no-such-bucket-' + Date.now()
  const badBatch = await call('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: badBucketName, keys: [key] }),
  })
  const badErrors = (badBatch.payload && badBatch.payload.errors) || []
  ok('批次刪除對不存在的桶回報逐 key 錯誤（不是假成功）',
    badBatch.status === 200 && badBatch.payload.ok === true && badErrors.length === 1 && badErrors[0].code === 'AccessDenied',
    { status: badBatch.status, errors: badErrors.map((entry) => entry.code) })
  ok('錯誤訊息帶上「逐一刪除也失敗」的退路結果', /逐一刪除也失敗/.test(badErrors[0] && badErrors[0].message || ''),
    String((badErrors[0] && badErrors[0].message || '').slice(0, 80)))

  // 單物件 DELETE 則是頂層錯誤（403 AccessDenied）
  const badSingle = await call('/object?' + new URLSearchParams({ bucket: badBucketName, key }).toString(), { method: 'DELETE' })
  ok('單物件 DELETE 不存在的桶 → 403 且 ok:false',
    badSingle.status === 403 && badSingle.payload && badSingle.payload.ok === false,
    { status: badSingle.status, code: badSingle.payload && badSingle.payload.code })

  // 4) 清理殘留
  await call('/delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bucket: BUCKET, keys: [key, other] }),
  })
  const final = await call('/objects?' + query({ prefix: PREFIX }))
  ok('收尾：前綴清空', final.payload.objects.length === 0 && final.payload.folders.length === 0,
    { objects: final.payload.objects.map((entry) => entry.key), folders: final.payload.folders.map((entry) => entry.prefix) })

  console.log(failed === 0 ? 'ALL PASS' : failed + ' FAILED')
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', error && error.stack); process.exitCode = 1 })
