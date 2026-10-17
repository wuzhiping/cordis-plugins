'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// End-to-end smoke test for the minio-file skill script, against the real MinIO.
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = require('node:path').join(PLUGIN, 'skills/minio-file/minio.mjs')
// 連線設定：優先 $MINIO_CONFIG／./minio.json（面板「❗️ 複製設定」匯出後存檔），
// 沒有檔案時就用環境變數 MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY /
// MINIO_REGION。這個檔案本身不含任何憑證。
const CONFIG = process.env.MINIO_CONFIG || 'minio.json'
const hasConfig = fs.existsSync(CONFIG)
const PREFIX = '_minio_skill_smoke/'
let failed = 0

function run(args) {
  const full = hasConfig ? [...args, '--config', CONFIG] : args
  const result = spawnSync(process.execPath, [SCRIPT, ...full], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}
function ok(label, condition, extra) {
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + extra))
  if (!condition) failed += 1
}

const bucket = 'dsh'
const key = PREFIX + 'a b+中文.txt'
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minio-skill-'))
const uploadPath = path.join(localDir, 'up.txt')
fs.writeFileSync(uploadPath, 'from local file\n第二行\n')

// cleanup leftovers first
const before = run(['ls', PREFIX, '--recursive', '--json'])
if (before.status === 0) {
  const keys = JSON.parse(before.stdout).objects.map((entry) => entry.key)
  if (keys.length > 0) run(['rm', ...keys.flatMap((k) => ['--key', k])])
}

// put --from, then cat
const put = run(['put', '--key', key, '--from', uploadPath, '--contentType', 'text/plain; charset=utf-8'])
ok('put --from', put.status === 0 && put.stdout.includes('bytes'), put.stdout.trim() || put.stderr.trim())

const cat = run(['cat', '--key', key])
ok('cat 內容一致', cat.status === 0 && cat.stdout === 'from local file\n第二行\n', JSON.stringify(cat.stdout.slice(0, 40)))

const head = run(['head', '--key', key, '--json'])
ok('head 回大小與型別', head.status === 0
  && JSON.parse(head.stdout).size === Buffer.byteLength('from local file\n第二行\n')
  && JSON.parse(head.stdout).contentType.startsWith('text/plain'), head.stdout.trim())

// ls 一層 + --json：key 解碼（空白、+、中文）
const ls = run(['ls', PREFIX, '--json'])
const listed = JSON.parse(ls.stdout)
ok('ls 一層且 key 解碼正確', ls.status === 0 && listed.objects.some((entry) => entry.key === key),
  JSON.stringify(listed.objects.map((entry) => entry.key)))

// mkdir 後要在 folders 裡
const mkdir = run(['mkdir', '--key', PREFIX + 'sub/'])
ok('mkdir', mkdir.status === 0 && mkdir.stdout.includes('sub/'), mkdir.stdout.trim())
const lsRoot = JSON.parse(run(['ls', PREFIX, '--json']).stdout)
ok('ls 把資料夾放在 folders', lsRoot.folders.includes(PREFIX + 'sub/'), JSON.stringify(lsRoot.folders))

// put --content（行內）
const inline = run(['put', '--key', PREFIX + 'sub/inline.json', '--content', '{"a":1}', '--contentType', 'application/json'])
ok('put --content', inline.status === 0, inline.stdout.trim())
ok('ls --recursive 看得到子目錄物件',
  JSON.parse(run(['ls', PREFIX, '--recursive', '--json']).stdout).objects.some((entry) => entry.key === PREFIX + 'sub/inline.json'))

// get --out 與 stdout 兩種
const outPath = path.join(localDir, 'down.txt')
const get = run(['get', '--key', key, '--out', outPath])
ok('get --out 寫檔且內容一致', get.status === 0 && fs.readFileSync(outPath, 'utf8') === 'from local file\n第二行\n', get.stdout.trim())
const getStdout = spawnSync(process.execPath, [SCRIPT, 'get', '--key', key, '--config', CONFIG], { encoding: 'buffer' })
ok('get 不帶 --out 時輸出原始位元組', getStdout.status === 0
  && Buffer.from(getStdout.stdout).toString('utf8') === 'from local file\n第二行\n')

// mv（複製 + 刪除）
const moved = run(['mv', '--key', PREFIX + 'sub/inline.json', '--to', PREFIX + 'sub/moved.json'])
ok('mv', moved.status === 0 && moved.stdout.includes('moved.json'), moved.stdout.trim())
const afterMove = JSON.parse(run(['ls', PREFIX, '--recursive', '--json']).stdout).objects.map((entry) => entry.key)
ok('mv 之後舊 key 不在了', afterMove.includes(PREFIX + 'sub/moved.json') && !afterMove.includes(PREFIX + 'sub/inline.json'),
  JSON.stringify(afterMove))

// presign 真的能用
const presigned = run(['presign', '--key', key, '--expires', '120'])
ok('presign 產生連結', presigned.status === 0 && /X-Amz-Signature=[0-9a-f]{64}/.test(presigned.stdout), presigned.stdout.trim())

// rm 多個 key（含資料夾標記）
const rm = run(['rm', '--key', key, '--key', PREFIX + 'sub/moved.json', '--key', PREFIX + 'sub/'])
ok('rm 多個 key', rm.status === 0 && rm.stdout.includes('deleted 3'), rm.stdout.trim())
const after = JSON.parse(run(['ls', PREFIX, '--recursive', '--json']).stdout)
ok('清理後前綴為空', after.objects.length === 0, JSON.stringify(after.objects.map((e) => e.key)))

// 錯誤路徑：不存在的 key → exit 1 + error: NoSuchKey ...
const missing = run(['get', '--key', PREFIX + 'nope.txt', '--out', path.join(localDir, 'x')])
ok('不存在的 key 回非 0 且訊息帶 NoSuchKey', missing.status === 1 && /error: NoSuchKey/.test(missing.stderr),
  JSON.stringify(missing.stderr.trim()))

// 錯誤路徑：沒有設定檔
const noConfig = spawnSync(process.execPath, [SCRIPT, 'buckets', '--config', 'no-such-file.json'], { encoding: 'utf8', cwd: localDir })
ok('讀不到設定檔時明確失敗', noConfig.status === 1 && /ConfigUnreadable/.test(noConfig.stderr), noConfig.stderr.trim())

// 環境變數來源（金鑰只在環境裡，不寫進檔案）
if (process.env.MINIO_SECRET_KEY) {
  const envRun = spawnSync(process.execPath, [SCRIPT, 'ls', '--json', '--bucket', bucket], {
    encoding: 'utf8',
    cwd: localDir,
    env: { ...process.env },
  })
  ok('環境變數也能當設定來源', envRun.status === 0 && Array.isArray(JSON.parse(envRun.stdout).objects), envRun.stderr.trim())
} else {
  console.log('SKIP 環境變數來源（未設 MINIO_SECRET_KEY）')
}

fs.rmSync(localDir, { recursive: true, force: true })
console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exitCode = failed === 0 ? 0 : 1
