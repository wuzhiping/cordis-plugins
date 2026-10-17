'use strict'
/**
 * 真機驗證一把跑：對真 MinIO 打外掛的路由與 skill 的 CLI。
 *
 *   npm run verify:live            # 全部
 *   npm run verify:live range      # 只跑名字含 range 的
 *
 * 憑證來源：外掛自己的 `ConnectionProvider`（BDD storage 記錄），**只寫進
 * `%TEMP%` 的暫存檔**、跑完立刻刪除；任何腳本都不印出金鑰。
 *
 * 每個腳本是獨立的行程：一個失敗不影響其他，最後彙總。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PLUGIN = path.join(__dirname, '..', '..')
const FILTER = process.argv[2] || ''

/** 依序執行；`config` 表示需要 $MINIO_CONFIG。 */
const SUITE = [
  { file: 'sigv4-vectors.cjs', label: 'SigV4 對 AWS 向量（離線）' },
  { file: 'cleanup.cjs', label: '先清掉殘留的暫存物件' },
  { file: 'routes-live.cjs', label: '基本路由' },
  { file: 'range-live.cjs', label: 'Range／斷點續傳（Phase 1）', config: true },
  { file: 'folder-marker-live.cjs', label: '空資料夾標記', config: true },
  { file: 'panel-flow-live.cjs', label: '面板 multipart 流程（Phase 3）', config: true },
  { file: 'multipart-probe.cjs', label: 'S3 multipart 事實探針', config: true },
  { file: 'export-live.cjs', label: '匯出設定的保護', config: true },
  { file: 's3-live-exercise.cjs', label: 'S3 操作總覽', config: true },
  { file: 'delete-fallback-live.cjs', label: '刪除失敗的退回路徑', config: true },
  { file: 'region-fix-live.cjs', label: 'region 自動修正', config: true },
  { file: 'skill-smoke.cjs', label: 'skill CLI 快速檢查', config: true },
  { file: 'upload-live.cjs', label: 'skill multipart 上傳＋續傳（Phase 2）', config: true },
  { file: 'cleanup.cjs', label: '收尾清理' },
  { file: 'web-shell-check.cjs', label: '面板是否載入（bundle／boot 條目）' },
]

async function buildConfig() {
  const { ConnectionProvider } = require(path.join(PLUGIN, 'src', 'storage.js'))
  const got = await new ConnectionProvider({ ttlMs: 1000 }).get()
  if (!got.ok) throw new Error(`取不到連線設定（stage=${got.stage}）：${got.error || ''}`)
  const file = path.join(os.tmpdir(), `dsh-minio-s3-verify-${process.pid}.json`)
  fs.writeFileSync(file, JSON.stringify({
    endpoint: got.connection.endpoint,
    accessKey: got.connection.accessKey,
    secretKey: got.connection.secretKey,
    region: got.client.region,
    bucket: got.connection.defaultBucket,
  }, null, 2), { mode: 0o600 })
  return file
}

;(async () => {
  const wanted = SUITE.filter((entry) => !FILTER || entry.file.includes(FILTER) || entry.label.includes(FILTER))
  const needsConfig = wanted.some((entry) => entry.config)
  let configFile = null
  if (needsConfig) {
    try { configFile = await buildConfig() } catch (error) {
      console.error(`無法準備連線設定：${error.message}`)
      process.exitCode = 1
      return
    }
  }

  const results = []
  try {
    for (const entry of wanted) {
      const script = path.join(__dirname, entry.file)
      if (!fs.existsSync(script)) { results.push({ ...entry, status: 'missing' }); continue }
      process.stdout.write(`\n=== ${entry.label}（${entry.file}）===\n`)
      const env = { ...process.env }
      if (entry.config && configFile) env.MINIO_CONFIG = configFile
      const run = spawnSync(process.execPath, [script], { encoding: 'utf8', env, cwd: os.tmpdir() })
      const output = `${run.stdout || ''}${run.stderr || ''}`.trim()
      // 只印最後幾行（腳本本身已經印 PASS/FAIL）
      const lines = output.split('\n').filter(Boolean)
      console.log(lines.slice(-3).join('\n'))
      results.push({ ...entry, status: run.status === 0 ? 'pass' : 'fail', tail: lines.slice(-2).join(' | ') })
    }
  } finally {
    if (configFile) { try { fs.unlinkSync(configFile) } catch {} }
  }

  const pass = results.filter((entry) => entry.status === 'pass').length
  const fail = results.filter((entry) => entry.status !== 'pass')
  console.log('\n──────────────── 彙總 ────────────────')
  for (const entry of results) {
    console.log(`${entry.status === 'pass' ? 'PASS' : entry.status === 'missing' ? 'MISS' : 'FAIL'}  ${entry.label}`)
    if (entry.status !== 'pass') console.log(`      ${entry.tail || entry.file}`)
  }
  console.log(`\n${pass}/${results.length} 通過${fail.length ? `，${fail.length} 個失敗` : ''}`)
  process.exitCode = fail.length === 0 ? 0 : 1
})()
