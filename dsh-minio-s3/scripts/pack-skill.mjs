/**
 * 把 `skills/minio-file/` 打包成 `minio-file-skill.zip`（repo 內的分享用產物）。
 *
 * 為什麼要有這支：skill 原始碼在 repo 裡（`skills/minio-file/`），而對外分享的是
 * 一個 zip。手動壓縮容易忘記重打、內容與原始碼不同步；這支讓 zip **可重現**：
 * 固定檔案順序、固定時間戳（2020-01-01），同樣的原始碼一定得到同樣的位元組。
 *
 * 執行：npm run pack:skill
 */
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sourceDir = join(root, 'skills', 'minio-file')
const outPath = join(root, 'minio-file-skill.zip')
const ZIP_NAME = 'minio-file' // zip 內的頂層資料夾名

// ---- 最小 ZIP 寫入器（store/deflate，無外部依賴） ---------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

const crc32 = (buffer) => {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

const DOS_TIME = 0 // 00:00:00
const DOS_DATE = (2020 - 1980) << 9 | (1 << 5) | 1 // 2020-01-01

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, 'utf8')
    const raw = file.data
    const crc = crc32(raw)
    const deflated = deflateRawSync(raw, { level: 9 })
    // 已經壓不動（例如 .png）就存原樣，比較小也比較快
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)      // local file header signature
    local.writeUInt16LE(20, 4)              // version needed
    local.writeUInt16LE(0x0800, 6)          // flags: UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, nameBytes, body)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)      // central directory signature
    entry.writeUInt16LE(0x031e, 4)          // made by: unix, v3
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10)
    entry.writeUInt16LE(DOS_TIME, 12)
    entry.writeUInt16LE(DOS_DATE, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(body.length, 20)
    entry.writeUInt32LE(raw.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt16LE(0, 30)              // extra
    entry.writeUInt16LE(0, 32)              // comment
    entry.writeUInt16LE(0, 34)              // disk
    entry.writeUInt16LE(0, 36)              // internal attrs
    entry.writeUInt32LE(0o100644 << 16 >>> 0, 38) // external attrs: -rw-r--r--
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...chunks, centralBuffer, end])
}

// ---- 收集檔案（固定順序） ---------------------------------------------------

const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

if (!existsSync(sourceDir)) {
  console.error(`pack:skill failed: 找不到 ${sourceDir}`)
  process.exit(1)
}

const files = walk(sourceDir).map((full) => ({
  name: `${ZIP_NAME}/${relative(sourceDir, full).replace(/\\/g, '/')}`,
  data: readFileSync(full),
}))

if (files.length === 0) {
  console.error('pack:skill failed: skills/minio-file 是空的')
  process.exit(1)
}

const zip = buildZip(files)
writeFileSync(outPath, zip)
console.log(`packed ${outPath} (${zip.length} bytes)`)
for (const file of files) console.log(`  ${file.name}  ${file.data.length} bytes`)
