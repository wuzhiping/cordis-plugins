'use strict'
// Phase 2 驗證：用 skill 的 minio.mjs 對真 MinIO 做 multipart 上傳，並模擬中斷後續傳。
// 憑證走 $MINIO_CONFIG（暫存設定檔；`npm run verify:live` 會自動準備並刪除），
// 這個腳本本身不含任何金鑰。
//
// 前置：$MINIO_CONFIG 指向一份 {endpoint, accessKey, secretKey, region, bucket} 的 JSON。
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const PLUGIN = path.join(__dirname, '..', '..')
const SCRIPT = path.join(PLUGIN, 'skills', 'minio-file', 'minio.mjs')
const STORAGE_MODULE = path.join(PLUGIN, 'src', 'storage.js')
const KEY = '_upload_live/big.bin'
const BUCKET = 'dsh'
let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: process.env })
  return { status: result.status, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() }
}

// 21MiB → 8MiB × 3 片（含一片不滿）
const size = 21 * 1024 * 1024
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-upload-'))
const local = path.join(dir, 'big.bin')
const payload = crypto.randomBytes(size)
fs.writeFileSync(local, payload)
const md5 = crypto.createHash('md5').update(payload).digest('hex')

;(async () => {
  // 清掉上次殘留
  run(['abort', '--key', KEY])
  run(['rm', '--key', KEY])

  // --- 1) 完整 multipart 上傳 ---
  const first = run(['upload', '--key', KEY, '--from', local, '--part-size', '8MiB', '--concurrency', '3'])
  ok('multipart 上傳成功', first.status === 0, first.stdout || first.stderr)
  const uploaded = first.stdout
  ok('回報 3 片', /3 片/.test(uploaded), uploaded)
  ok('驗證走複合 ETag（不是僅大小）', /composite-etag/.test(uploaded), uploaded)

  // 物件大小與內容（用 get 下載回本地比對 MD5）
  const head = run(['head', '--key', KEY, '--json'])
  ok('物件大小正確', JSON.parse(head.stdout).size === size, head.stdout)

  // --- 2) 中斷模擬：先只傳第 1、2 片，然後「放棄客戶端狀態」，再用 --resume 補完 ---
  const KEY2 = '_upload_live/resume.bin'
  run(['abort', '--key', KEY2])
  run(['rm', '--key', KEY2])

  // 先完整上傳一次以確保流程可用，然後刪掉物件、留著上傳狀態不可能 ——
  // 這裡改用「人為中斷」：上傳第 1、2 片後直接停手（用 upload 的前兩片模擬）。
  // 做法：先用一個「假的上傳」把 1、2 片送上去（透過 uploads/upload 的機制），
  // 最貼近真實的做法是：上傳時把檔案改小 → 讓它只送部分片，然後 abort 前停下。
  // 因為 CLI 沒有「只傳幾片」的選項，這裡用一個小腳本直接驅動 skill 的函式。
  const probe = `
    const { ConnectionProvider } = require(${JSON.stringify(STORAGE_MODULE)})
    ;(async () => {
      const got = await new ConnectionProvider({ ttlMs: 1000 }).get()
      const s3 = got.client
      const bucket = '${BUCKET}', key = '${KEY2}'
      const created = await s3.createMultipartUpload({ bucket, key, contentType: 'application/octet-stream' })
      const fs = require('node:fs')
      const size = ${size}
      const partSize = 8 * 1024 * 1024
      for (const n of [1, 2]) {
        const start = (n - 1) * partSize
        const end = Math.min(start + partSize, size)
        const body = await new Promise((resolve, reject) => {
          const chunks = []
          fs.createReadStream('${local.replace(/\\/g, '/')}', { start, end: end - 1 })
            .on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject)
        })
        await s3.uploadPart({ bucket, key, uploadId: created.uploadId, partNumber: n, body })
      }
      // 模擬「客戶端把 uploadId 忘了」：只留下伺服器上的狀態
      console.log(created.uploadId)
    })().catch((e) => { console.error('PROBE FAIL', e.message); process.exitCode = 1 })
  `
  const probeResult = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' })
  ok('人為中斷：伺服器上留下 2 片', probeResult.status === 0, (probeResult.stdout || probeResult.stderr).trim().slice(0, 80))

  const inProgress = run(['uploads', '--key', KEY2, '--json'])
  const uploads = JSON.parse(inProgress.stdout).uploads
  ok('uploads 列出未完成的上傳與 2 片', uploads.length === 1 && uploads[0].parts.length === 2,
    uploads.map((entry) => entry.parts.length))

  // 續傳：同一行再跑一次（--resume）。這裡刻意**沒有側車檔**（上面是用 probe 直接
  // 建 upload 的），所以走「接手伺服器上未完成的上傳」那條路，靠片大小確認一致。
  const resumed = run(['upload', '--key', KEY2, '--from', local, '--part-size', '8MiB', '--resume'])
  ok('續傳完成（無側車檔 → 接手伺服器上的上傳）', resumed.status === 0, resumed.stdout || resumed.stderr)
  ok('續傳只補缺的片（1 片）', /續傳（本次補 1 片）/.test(resumed.stdout), resumed.stdout)
  ok('有印出「接手」的說明', /接手伺服器上未完成的上傳/.test(resumed.stderr), resumed.stderr.trim())

  const head2 = run(['head', '--key', KEY2, '--json'])
  ok('續傳後物件大小正確', JSON.parse(head2.stdout).size === size, head2.stdout)

  // --- 3) 下載回來比對內容（證明續傳拼出來的檔案是完好的） ---
  const back = path.join(dir, 'back.bin')
  const got = run(['get', '--key', KEY2, '--out', back])
  ok('下載續傳後的物件', got.status === 0, got.stdout || got.stderr)
  const backMd5 = crypto.createHash('md5').update(fs.readFileSync(back)).digest('hex')
  const isMultipartEtag = /-/.test(JSON.parse(head2.stdout).etag)
  ok('內容與本地檔一致（MD5）', backMd5 === md5, { local: md5, remote: backMd5, multipartEtag: isMultipartEtag })

  // --- 4) 放棄上傳 ---
  const probe2 = spawnSync(process.execPath, ['-e', probe.replace(`'${KEY2}'`, `'${KEY2}'`)], { encoding: 'utf8' })
  ok('再造一個未完成的上傳', probe2.status === 0)
  const aborted = run(['abort', '--key', KEY2])
  ok('abort 清掉未完成的上傳', aborted.status === 0 && /resume\.bin/.test(aborted.stdout), aborted.stdout)
  const after = JSON.parse(run(['uploads', '--key', KEY2, '--json']).stdout)
  ok('清單已空', after.uploads.length === 0, after.uploads.length)

  // 清理
  run(['rm', '--key', KEY])
  run(['rm', '--key', KEY2])
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
  process.exitCode = failed === 0 ? 0 : 1
})()
