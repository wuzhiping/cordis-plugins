'use strict'

// ③ 之后 zip 只由宿主这一条路由提供（src/index.js → share-core.sendZip）。
// 这里直接把 sendZip 挂在最小 http 服务器上，专门验证打包语义：递归、空目录、
// 符号链接逃逸跳过、UTF-8 名、条目/字节双上限、自定义 name。
// 路由层（栅栏/会话解析/错误码）在 host.test.js。

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const zlib = require('node:zlib')

const core = require('../src/share-core')

let rootDir
let outsideDir
let server
let port
let cappedServer
let cappedPort

before(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-share-zip-'))
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-file-share-zip-out-'))
  fs.writeFileSync(path.join(rootDir, 'hello.txt'), 'hello zip')
  fs.mkdirSync(path.join(rootDir, 'docs', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(rootDir, 'docs', 'guide.md'), '# guide\n\nzip me folder\n')
  fs.writeFileSync(path.join(rootDir, 'docs', 'nested', 'deep.txt'), 'deep content 🎉')
  fs.mkdirSync(path.join(rootDir, 'docs', 'empty-dir'))
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'outside secret')
  try { fs.symlinkSync(outsideDir, path.join(rootDir, 'docs', 'esc')) } catch {}
  try { fs.symlinkSync(path.join(outsideDir, 'secret.txt'), path.join(rootDir, 'docs', 'esc-file.txt')) } catch {}

  const serve = (opts) => http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://share.local')
      core.sendZip(res, rootDir, url.searchParams.getAll('path'), {
        name: url.searchParams.get('name') || '',
        ...opts,
      })
    } catch (e) {
      const status = e instanceof core.ShareError ? e.status : 500
      const body = JSON.stringify({ error: String((e && e.message) || e) })
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
  })

  server = serve({})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  cappedServer = serve({ zipMaxBytes: 8 })
  await new Promise((resolve) => cappedServer.listen(0, '127.0.0.1', resolve))
  cappedPort = cappedServer.address().port
})

after(() => {
  try { server && server.close() } catch {}
  try { cappedServer && cappedServer.close() } catch {}
  try { fs.rmSync(rootDir, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(outsideDir, { recursive: true, force: true }) } catch {}
})

const base = () => `http://127.0.0.1:${port}`

/** 迷你 ZIP 解析：EOCD → 中央目录 → 本地条目（含 deflate 还原）。 */
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
    const lh = localOffset
    assert.equal(buf.readUInt32LE(lh), 0x04034b50, `本地头 #${i} 签名`)
    const lhNameLen = buf.readUInt16LE(lh + 26)
    const lhExtraLen = buf.readUInt16LE(lh + 28)
    const dataStart = lh + 30 + lhNameLen + lhExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
    assert.equal(data.length, uncompSize, `${name} 解压后大小`)
    assert.equal(zlib.crc32(data), crc, `${name} CRC32`)
    entries.push({ name, method, crc, data })
    pos += 46 + nameLen
  }
  return entries
}

const entryByName = (entries, name) => entries.find((e) => e.name === name)

async function getZip(query, useCapped) {
  const origin = useCapped ? `http://127.0.0.1:${cappedPort}` : base()
  const res = await fetch(`${origin}/api/download-zip?${query}`)
  if (res.status !== 200) throw new Error(`期望 200, got ${res.status}: ${await res.text().catch(() => '')}`)
  assert.equal(res.headers.get('content-type'), 'application/zip')
  assert.match(res.headers.get('content-disposition') || '', /^attachment;/)
  return parseZip(Buffer.from(await res.arrayBuffer()))
}

test('文件夹下载：整目录递归 + 目录条目 + 空目录 + 内容还原', async () => {
  const res = await fetch(`${base()}/api/download-zip?path=${encodeURIComponent('docs')}`)
  assert.match(res.headers.get('content-disposition'), /docs\.zip/)
  const entries = parseZip(Buffer.from(await res.arrayBuffer()))
  const names = entries.map((e) => e.name)
  assert.ok(names.includes('docs/'), '顶层目录条目')
  assert.ok(names.includes('docs/guide.md'))
  assert.ok(names.includes('docs/nested/'))
  assert.ok(names.includes('docs/nested/deep.txt'))
  assert.ok(names.includes('docs/empty-dir/'), '空目录也保留')
  assert.equal(entryByName(entries, 'docs/guide.md').data.toString(), '# guide\n\nzip me folder\n')
  assert.equal(entryByName(entries, 'docs/nested/deep.txt').data.toString(), 'deep content 🎉', 'UTF-8 内容还原')
})

test('符号链接逃逸 root 的条目被跳过（目录链接与文件链接都跳过）', async () => {
  const entries = await getZip(`path=${encodeURIComponent('docs')}`)
  const names = entries.map((e) => e.name)
  assert.ok(!names.some((n) => n.includes('esc')), `逃逸链接不应出现在 zip 里: ${names.join(', ')}`)
})

test('多选下载：文件与目录混选，保留相对路径结构', async () => {
  const entries = await getZip(`path=${encodeURIComponent('hello.txt')}&path=${encodeURIComponent('docs/nested')}`)
  const names = entries.map((e) => e.name)
  assert.ok(names.includes('hello.txt'))
  assert.ok(names.includes('docs/nested/deep.txt'))
  assert.equal(entryByName(entries, 'hello.txt').data.toString(), 'hello zip')
})

test('单文件也允许走 zip（文件名取自路径）', async () => {
  const res = await fetch(`${base()}/api/download-zip?path=${encodeURIComponent('hello.txt')}`)
  assert.match(res.headers.get('content-disposition'), /hello\.txt\.zip/)
  const entries = parseZip(Buffer.from(await res.arrayBuffer()))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'hello.txt')
})

test('自定义 name 参数（非法字符剔除、自动补 .zip）', async () => {
  const res = await fetch(`${base()}/api/download-zip?path=hello.txt&name=${encodeURIComponent('我的包/')}`)
  assert.match(res.headers.get('content-disposition'), /%E6%88%91%E7%9A%84%E5%8C%85\.zip/)
})

test('不存在 404；空选择 400；越界 400；绝对路径 400', async () => {
  const cases = [
    [`path=${encodeURIComponent('no-such-dir')}`, 404],
    ['', 400],
    [`path=${encodeURIComponent('../escape')}`, 400],
    [`path=${encodeURIComponent(path.join(rootDir, 'hello.txt'))}`, 400],
  ]
  for (const [query, status] of cases) {
    const res = await fetch(`${base()}/api/download-zip?${query}`)
    assert.equal(res.status, status, `${query} → ${status}`)
    assert.equal((await res.json()).error !== undefined, true)
  }
})

test('总大小上限触发 413', async () => {
  await assert.rejects(() => getZip(`path=hello.txt`, true), /期望 200, got 413/)
})

test('重复 path 去重；中文文件名可打包', async () => {
  fs.writeFileSync(path.join(rootDir, '中文 文档.txt'), '中文内容')
  const entries = await getZip(`path=${encodeURIComponent('中文 文档.txt')}&path=${encodeURIComponent('中文 文档.txt')}`)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, '中文 文档.txt')
  assert.equal(entries[0].data.toString(), '中文内容')
})
