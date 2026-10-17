'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// End-to-end live exercise against MinIO, confined to a scratch prefix in one bucket.
const { ConnectionProvider } = require(require('node:path').join(PLUGIN, 'src/storage.js'))

const PREFIX = '_dsh_minio_s3_probe/'
const BUCKET = process.argv[2] || 'dsh'

const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) process.exitCode = 1
}

;(async () => {
  const provider = new ConnectionProvider({ ttlMs: 1000 })
  const got = await provider.get()
  if (!got.ok) { console.log('CONN FAIL', got); process.exit(1) }
  const c = got.client
  console.log('bucket', BUCKET, 'endpoint', got.connection.endpoint)

  // clean any leftovers first
  const before = await c.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  if (before.contents.length > 0) {
    await c.deleteObjects(BUCKET, before.contents.map((o) => o.key))
    console.log('cleaned', before.contents.length, 'leftover objects')
  }

  // 1. put text (non-ASCII + space in the key: exercises path encoding)
  const name = PREFIX + 'hello world 中文.txt'
  const put = await c.putObject({ bucket: BUCKET, key: name, body: Buffer.from('hello minio\n第二行\n', 'utf8'), contentType: 'text/plain; charset=utf-8' })
  ok('putObject', put.size === Buffer.byteLength('hello minio\n第二行\n', 'utf8'), put)

  // 2. head
  const head = await c.headObject(BUCKET, name)
  ok('headObject size', head.size === put.size, head)

  // 3. get bytes round-trip
  const read = await c.getObject({ bucket: BUCKET, key: name })
  ok('getObject content', read.body.toString('utf8') === 'hello minio\n第二行\n', { size: read.size, contentType: read.contentType })

  // 4. folder marker
  const folder = PREFIX + 'folder-a/'
  await c.putObject({ bucket: BUCKET, key: folder, body: Buffer.alloc(0) })
  await c.putObject({ bucket: BUCKET, key: folder + 'inner.bin', body: Buffer.from([1, 2, 3, 4]) })

  // 4b. a key containing a literal '+' and a space: the two characters MinIO's
  // url encoding confuses with each other.
  const plusKey = PREFIX + 'a+b c.txt'
  await c.putObject({ bucket: BUCKET, key: plusKey, body: Buffer.from('plus') })
  const plusList = await c.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  ok('listing decodes literal + and space', plusList.contents.some((o) => o.key === plusKey), plusList.contents.map((o) => o.key))

  // 5. one-level listing with delimiter
  const listed = await c.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '/' })
  const prefixes = listed.commonPrefixes
  const keys = listed.contents.map((o) => o.key)
  ok('listing shows folder', prefixes.includes(folder), { prefixes, keys, truncated: listed.isTruncated })

  // 6. flat listing sees the nested object (encoding-type=url round-trip)
  const flat = await c.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  ok('flat listing sees nested', flat.contents.some((o) => o.key === folder + 'inner.bin'), flat.contents.map((o) => o.key))

  // 7. copy / rename
  const copied = PREFIX + 'copied.txt'
  await c.copyObject({ bucket: BUCKET, fromKey: name, toKey: copied })
  const copiedHead = await c.headObject(BUCKET, copied)
  ok('copyObject size', copiedHead.size === put.size, copiedHead)

  // 8. presign then fetch it without credentials
  const url = c.presignObject({ bucket: BUCKET, key: copied, expires: 300 })
  const res = await fetch(url)
  ok('presigned GET works', res.status === 200 && (await res.text()) === 'hello minio\n第二行\n', { status: res.status, host: new URL(url).host })

  // 9. batch delete everything we made, then confirm empty
  const all = await c.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  const del = await c.deleteObjects(BUCKET, all.contents.map((o) => o.key))
  ok('deleteObjects', del.errors.length === 0, del)
  const after = await c.listObjectsV2({ bucket: BUCKET, prefix: PREFIX, delimiter: '' })
  ok('prefix empty after cleanup', after.contents.length === 0, after.contents.map((o) => o.key))

  // 10. error shape: reading a missing key should be a 404 NoSuchKey S3Error
  try {
    await c.getObject({ bucket: BUCKET, key: PREFIX + 'nope.txt' })
    ok('missing key throws', false)
  } catch (e) {
    ok('missing key throws NoSuchKey', e.code === 'NoSuchKey' && e.status === 404, { code: e.code, status: e.status })
  }
})().catch((e) => { console.log('FATAL', e && e.stack); process.exit(1) })
