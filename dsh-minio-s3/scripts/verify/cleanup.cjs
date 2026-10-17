'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// Remove every scratch object this session created (all under `_dsh_minio_s3*`).
const { ConnectionProvider } = require(require('node:path').join(PLUGIN, 'src/storage.js'))

;(async () => {
  const provider = new ConnectionProvider({ ttlMs: 1000 })
  const got = await provider.get()
  if (!got.ok) { console.log('CONN FAIL', got); process.exitCode = 1; return }
  const s3 = got.client
  const buckets = await s3.listBuckets()
  let removed = 0
  for (const bucket of buckets) {
    const listing = await s3.listObjectsV2({ bucket: bucket.name, prefix: '_dsh_minio_s3', delimiter: '' })
    if (listing.contents.length === 0) continue
    const keys = listing.contents.map((entry) => entry.key)
    const result = await s3.deleteObjects(bucket.name, keys)
    removed += result.deleted.length
    console.log(bucket.name, '→ deleted', result.deleted.length, 'errors', result.errors.length)
  }
  console.log('total removed:', removed)

  // confirm nothing is left
  let left = 0
  for (const bucket of buckets) {
    const listing = await s3.listObjectsV2({ bucket: bucket.name, prefix: '_dsh_minio_s3', delimiter: '' })
    left += listing.contents.length
  }
  console.log(left === 0 ? 'CLEAN' : 'LEFTOVER ' + left)
})().catch((error) => { console.log('FATAL', error && error.stack); process.exitCode = 1 })
