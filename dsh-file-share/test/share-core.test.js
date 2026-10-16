'use strict'

// share-core（③ 之后的瘦身版）：只剩路径边界与 zip 构建两件事。

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const core = require('../src/share-core')

let rootDir
let outsideDir

before(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-share-core-'))
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-share-out-'))
  fs.writeFileSync(path.join(rootDir, 'a.txt'), 'hello world')
  fs.mkdirSync(path.join(rootDir, 'sub'))
  fs.writeFileSync(path.join(rootDir, 'sub', 'b.md'), '# b')
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside secret')
  try { fs.symlinkSync(path.join(rootDir, 'a.txt'), path.join(rootDir, 'inlink.txt')) } catch {}
  try { fs.symlinkSync(outsideDir, path.join(rootDir, 'esc')) } catch {}
})

after(() => {
  try { fs.rmSync(rootDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(outsideDir, { recursive: true, force: true }) } catch {}
})

function expectShareError(fn, status) {
  assert.throws(fn, (e) => e instanceof core.ShareError && e.status === status)
}

/** 迷你 ZIP 解析：EOCD → 中央目录 → 本地条目（含 deflate 还原、CRC 校验）。 */
function parseZip(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, '首个本地头签名')
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'EOCD 签名在末尾 -22')
  const count = buf.readUInt16LE(buf.length - 22 + 10)
  const centralOffset = buf.readUInt32LE(buf.length - 22 + 16)
  const entries = []
  let pos = centralOffset
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, `中央目录 #${i} 签名`)
    const method = buf.readUInt16LE(pos + 10)
    const crc = buf.readUInt32LE(pos + 16)
    const compSize = buf.readUInt32LE(pos + 20)
    const uncompSize = buf.readUInt32LE(pos + 24)
    const nameLen = buf.readUInt16LE(pos + 28)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, `本地头 #${i} 签名`)
    const lhNameLen = buf.readUInt16LE(localOffset + 26)
    const lhExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
    assert.equal(data.length, uncompSize, `${name} 解压后大小`)
    assert.equal(zlib.crc32(data), crc, `${name} CRC32`)
    entries.push({ name, method, data })
    pos += 46 + nameLen
  }
  return entries
}

test('路径边界：../ 与绝对路径一律 400', () => {
  expectShareError(() => core.resolveExisting(rootDir, '../x'), 400)
  expectShareError(() => core.resolveExisting(rootDir, '/etc/passwd'), 400)
  expectShareError(() => core.resolveExisting(rootDir, 'sub/../../x'), 400)
  expectShareError(() => core.resolveExisting(rootDir, 'sub/../../'), 400)
})

test('符号链接逃逸出 root 被拒绝；指向 root 内的符号链接合法', () => {
  expectShareError(() => core.resolveExisting(rootDir, 'esc/secret.txt'), 400)
  const abs = core.resolveExisting(rootDir, 'inlink.txt')
  assert.equal(fs.readFileSync(abs, 'utf8'), 'hello world')
})

test('不存在的路径 404；root 未配置/非目录 500', () => {
  expectShareError(() => core.resolveExisting(rootDir, 'nope.txt'), 404)
  expectShareError(() => core.ensureRoot(''), 500)
  expectShareError(() => core.ensureRoot(path.join(rootDir, 'a.txt')), 500)
  assert.equal(core.ensureRoot(rootDir), path.resolve(rootDir))
})

test('buildZip：目录条目 STORE + 文件 deflateRaw + UTF-8 名 + CRC 往返', () => {
  const entries = [
    { name: 'docs/', isDir: true, mtime: Date.now() },
    { name: 'docs/中文 文档.txt', data: Buffer.from('中文内容', 'utf8'), mtime: Date.now() },
    { name: 'docs/deep.bin', data: Buffer.from([0, 1, 2, 255]), mtime: Date.now() },
  ]
  const zip = core.buildZip(entries)
  const parsed = parseZip(zip)
  assert.deepEqual(parsed.map((e) => e.name), ['docs/', 'docs/中文 文档.txt', 'docs/deep.bin'])
  assert.equal(parsed[0].method, 0, '目录条目走 STORE')
  assert.equal(parsed[1].method, 8, '文件条目走 deflateRaw')
  assert.equal(parsed[0].data.length, 0)
  assert.equal(parsed[1].data.toString('utf8'), '中文内容')
  assert.deepEqual([...parsed[2].data], [0, 1, 2, 255])
})
