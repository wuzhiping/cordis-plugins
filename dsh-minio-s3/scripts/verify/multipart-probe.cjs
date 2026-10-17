'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')

/**
 * S3 multipart 實測：為「斷點續傳上傳」的設計文件取得一手事實。
 *
 * 憑證不寫在腳本裡：走外掛的 ConnectionProvider（憑證檔 + BDD storage 記錄），
 * 簽章用外掛自己的 s3-core。全部在 `_mp_probe/` 前綴下，跑完清理。
 */
const { ConnectionProvider } = require(require('node:path').join(PLUGIN, 'src/storage.js'))
const { S3Client } = require(require('node:path').join(PLUGIN, 'src/s3.js'))
const core = require(require('node:path').join(PLUGIN, 'src/core.js'))

const BUCKET = 'dsh'
const PREFIX = '_mp_probe/'
const MIB = 1024 * 1024

function xml(text, tag) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(String(text || ''))
  return match ? match[1].trim() : ''
}

async function raw(s3, { method, key, query, headers, body, operation }) {
  const url = s3.withQuery(s3.objectUrl(BUCKET, key), query || [])
  const response = await s3.send({ method, url, headers, body, operation })
  const text = await response.text().catch(() => '')
  return { status: response.status, headers: response.headers, text }
}

;(async () => {
  const provider = new ConnectionProvider({ ttlMs: 1000 })
  const got = await provider.get()
  if (!got.ok) { console.log('CONN FAIL', got); process.exitCode = 1; return }
  const s3 = got.client
  console.log('endpoint', s3.endpoint, '| region', s3.region, '| bucket', BUCKET)

  // --- 0) 清掉上次殘留（物件 + 未完成的 multipart upload） -------------------
  const staleUploads = await raw(s3, { method: 'GET', key: '', query: [['uploads', '']], operation: 'ListMultipartUploads' })
  const staleIds = [...staleUploads.text.matchAll(/<Upload>[\s\S]*?<\/Upload>/g)]
    .map((match) => ({
      key: xml(match[0], 'Key'),
      id: xml(match[0], 'UploadId'),
    }))
    .filter((entry) => entry.key.startsWith(PREFIX))
  for (const entry of staleIds) {
    await raw(s3, { method: 'DELETE', key: entry.key, query: [['uploadId', entry.id]], operation: 'AbortMultipartUpload' }).catch(() => {})
  }
  if (staleIds.length > 0) console.log('清掉殘留的未完成 upload', staleIds.length, '筆')

  const leftovers = await s3.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  if (leftovers.contents.length > 0) {
    await s3.deleteObjects(BUCKET, leftovers.contents.map((entry) => entry.key))
    console.log('清掉殘留物件', leftovers.contents.length)
  }

  const key = PREFIX + 'multipart.bin'
  const part1 = Buffer.alloc(5 * MIB + 123, 0x41) // 5MiB + 123 bytes（> MinIO 的 5MiB 下限）
  const part2 = Buffer.alloc(1 * MIB, 0x42)

  // --- 1) CreateMultipartUpload ------------------------------------------
  const created = await raw(s3, { method: 'POST', key, query: [['uploads', '']], operation: 'CreateMultipartUpload' })
  const uploadId = xml(created.text, 'UploadId')
  console.log('\n[1] CreateMultipartUpload →', created.status, '| uploadId =', uploadId || '(沒有)')
  console.log('    回應欄位:', ['Bucket', 'Key', 'UploadId'].map((tag) => `${tag}=${Boolean(xml(created.text, tag))}`).join(' '))
  if (!uploadId) { console.log('拿不到 uploadId，中止'); process.exitCode = 1; return }

  // --- 2) 上傳 part 1 / part 2 -------------------------------------------
  const sent1 = await raw(s3, {
    method: 'PUT', key, headers: { 'Content-Type': 'application/octet-stream' }, body: part1,
    query: [['partNumber', '1'], ['uploadId', uploadId]], operation: 'UploadPart',
  })
  const sent2 = await raw(s3, {
    method: 'PUT', key, headers: { 'Content-Type': 'application/octet-stream' }, body: part2,
    query: [['partNumber', '2'], ['uploadId', uploadId]], operation: 'UploadPart',
  })
  const etag1 = sent1.headers.get('etag')
  const etag2 = sent2.headers.get('etag')
  console.log('[2] UploadPart#1 →', sent1.status, 'ETag', etag1)
  console.log('    UploadPart#2 →', sent2.status, 'ETag', etag2, '（片的 ETag 是該片的 MD5，帶引號）')
  console.log('    part1 md5 =', require('node:crypto').createHash('md5').update(part1).digest('hex'))

  // --- 3) ListParts：續傳時「伺服器已經收到哪些片」的真相 -------------------
  const listed = await raw(s3, { method: 'GET', key, query: [['uploadId', uploadId]], operation: 'ListParts' })
  console.log('[3] ListParts →', listed.status)
  for (const block of listed.text.match(/<Part>[\s\S]*?<\/Part>/g) || []) {
    console.log('    part', xml(block, 'PartNumber'), 'size', xml(block, 'Size'), 'etag', xml(block, 'ETag'))
  }

  // --- 4) CompleteMultipartUpload ----------------------------------------
  const completeBody = Buffer.from('<CompleteMultipartUpload>'
    + [{ n: 1, e: etag1 }, { n: 2, e: etag2 }]
      .map((part) => `<Part><PartNumber>${part.n}</PartNumber><ETag>${part.e}</ETag></Part>`).join('')
    + '</CompleteMultipartUpload>')
  const completed = await raw(s3, {
    method: 'POST', key, query: [['uploadId', uploadId]],
    headers: { 'Content-Type': 'application/xml' }, body: completeBody, operation: 'CompleteMultipartUpload',
  })
  console.log('[4] CompleteMultipartUpload →', completed.status, '| 最終 ETag =', xml(completed.text, 'ETag'),
    '（注意：不是物件 MD5，是 `…-片數`）')

  const head = await s3.headObject(BUCKET, key)
  console.log('    物件大小', head.size, '（應為', part1.length + part2.length, '） 型別', head.contentType)

  // --- 5) 續傳能力：ListParts 在中斷後仍看得到已完成的片 --------------------
  const aborted = await raw(s3, { method: 'POST', key: PREFIX + 'resume.bin', query: [['uploads', '']], operation: 'CreateMultipartUpload' })
  const resumeId = xml(aborted.text, 'UploadId')
  await raw(s3, {
    method: 'PUT', key: PREFIX + 'resume.bin', body: part1,
    query: [['partNumber', '1'], ['uploadId', resumeId]], operation: 'UploadPart',
  })
  // 模擬「客戶端忘了 uploadId」：靠 ListMultipartUploads 找回
  const inProgress = await raw(s3, { method: 'GET', key: '', query: [['uploads', '']], operation: 'ListMultipartUploads' })
  const found = xml(inProgress.text, 'UploadId')
  console.log('[5] 未完成的 upload 可用 ListMultipartUploads 找回 →', Boolean(found),
    '（uploads 清單裡有', (inProgress.text.match(/<Upload>/g) || []).length, '筆）')
  const parts = await raw(s3, { method: 'GET', key: PREFIX + 'resume.bin', query: [['uploadId', resumeId]], operation: 'ListParts' })
  console.log('    中斷後 ListParts 仍回報已完成', (parts.text.match(/<Part>/g) || []).length, '片 → 這就是續傳的依據')

  // --- 6) 非最後一片小於 5MiB：MinIO 會擋（設計上 partSize 必須夠大） --------
  const small = await raw(s3, { method: 'POST', key: PREFIX + 'small.bin', query: [['uploads', '']], operation: 'CreateMultipartUpload' })
  const smallId = xml(small.text, 'UploadId')
  const tiny = Buffer.alloc(1 * MIB, 0x43)
  const t1 = await raw(s3, { method: 'PUT', key: PREFIX + 'small.bin', body: tiny, query: [['partNumber', '1'], ['uploadId', smallId]], operation: 'UploadPart' })
  const t2 = await raw(s3, { method: 'PUT', key: PREFIX + 'small.bin', body: tiny, query: [['partNumber', '2'], ['uploadId', smallId]], operation: 'UploadPart' })
  const smallBody = Buffer.from('<CompleteMultipartUpload>'
    + [{ n: 1, e: t1.headers.get('etag') }, { n: 2, e: t2.headers.get('etag') }]
      .map((part) => `<Part><PartNumber>${part.n}</PartNumber><ETag>${part.e}</ETag></Part>`).join('')
    + '</CompleteMultipartUpload>')
  const smallDone = await raw(s3, {
    method: 'POST', key: PREFIX + 'small.bin', query: [['uploadId', smallId]],
    headers: { 'Content-Type': 'application/xml' }, body: smallBody, operation: 'CompleteMultipartUpload',
  }).then((value) => value).catch((error) => ({ status: error.status, text: error.message, threw: true }))
  console.log('[6] 兩片各 1MiB（非最後一片 < 5MiB）→ HTTP', smallDone.status, '|', smallDone.text)
  console.log('    → 所以 partSize 必須 >= 5MiB（MinIO 預設下限），設計時要用 8MiB 起跳')

  // --- 7) presigned UploadPart：瀏覽器可直打 MinIO，宿主不必轉發位元組 -------
  const direct = await raw(s3, { method: 'POST', key: PREFIX + 'direct.bin', query: [['uploads', '']], operation: 'CreateMultipartUpload' })
  const directId = xml(direct.text, 'UploadId')
  const signedUrl = core.presignUrl({
    url: s3.withQuery(s3.objectUrl(BUCKET, PREFIX + 'direct.bin'), [['partNumber', '1'], ['uploadId', directId]]),
    method: 'PUT',
    accessKey: s3.accessKey,
    secretKey: s3.secretKey,
    region: s3.region,
    expires: 600,
  })
  const directResponse = await fetch(signedUrl, { method: 'PUT', body: part1 })
  console.log('[7] presigned UploadPart（瀏覽器直傳，不需 Authorization）→', directResponse.status,
    'ETag', directResponse.headers.get('etag') ? '有' : '無')
  const directParts = await raw(s3, { method: 'GET', key: PREFIX + 'direct.bin', query: [['uploadId', directId]], operation: 'ListParts' })
  console.log('    伺服器收到', (directParts.text.match(/<Part>/g) || []).length, '片（位元組沒經過宿主）')

  // --- 清理 ---------------------------------------------------------------
  await raw(s3, { method: 'DELETE', key, query: [['uploadId', uploadId]], operation: 'AbortMultipartUpload' }).catch(() => {})
  for (const [k, id] of [[PREFIX + 'resume.bin', resumeId], [PREFIX + 'small.bin', smallId], [PREFIX + 'direct.bin', directId]]) {
    await raw(s3, { method: 'DELETE', key: k, query: [['uploadId', id]], operation: 'AbortMultipartUpload' }).catch(() => {})
  }
  const after = await s3.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  if (after.contents.length > 0) {
    await s3.deleteObjects(BUCKET, after.contents.map((entry) => entry.key))
    console.log('\n清掉完成品', after.contents.length, '個物件')
  }
  const remaining = await s3.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  const uploadsLeft = await raw(s3, { method: 'GET', key: '', query: [['uploads', '']], operation: 'ListMultipartUploads' })
  console.log('殘留物件', remaining.contents.length, '| 殘留未完成 upload',
    (uploadsLeft.text.match(new RegExp(`<Key>${PREFIX}[^<]*</Key>`, 'g')) || []).length)
})().catch((error) => { console.log('FATAL', (error && error.stack) || error); process.exitCode = 1 })
