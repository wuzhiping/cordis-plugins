'use strict'

// ③/⑤：src/index.js 的唯一路由（只读 zip）与 workspaceOf。
// 用假 cordis ctx 驱动 apply()，不启动真实 Loader —— 这是本包唯一覆盖宿主半侧的测试。

const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const plugin = require('../src/host')

const ZIP_ROUTE = '/dsh-file-share/api/download-zip'

let rootA
let rootB
let missingDir

before(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fs-host-a-'))
  rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fs-host-b-'))
  fs.writeFileSync(path.join(rootA, 'only-a.txt'), 'A')
  fs.writeFileSync(path.join(rootA, 'plain.txt'), 'hello zip')
  fs.mkdirSync(path.join(rootA, 'docs', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(rootA, 'docs', 'guide.md'), '# guide\n')
  fs.writeFileSync(path.join(rootB, 'only-b.txt'), 'B')
  missingDir = path.join(rootA, 'gone')
})

after(() => {
  try { fs.rmSync(rootA, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(rootB, { recursive: true, force: true }) } catch {}
})

const sessionsWith = (map) => ({ get: (id) => map[id] })

/** 假 cordis ctx：捕获注册的路由、effect 标签，并可注入信任栅栏结果。 */
function mountCtx(sessions, rejection) {
  const registered = []
  const effects = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(route) { registered.push(route); return () => { registered.splice(registered.indexOf(route), 1) } } },
    sessions,
    connection: { requestRejection: () => rejection },
    effect(fn, label) { effects.push({ label, dispose: fn() }) },
  }
  const returned = plugin.apply(ctx)
  return { ctx, registered, effects, returned }
}

function fakeReq(url, method = 'GET') {
  return { method, url, headers: { host: '127.0.0.1:3080' } }
}

function fakeRes() {
  const state = { status: 0, headers: null, chunks: [] }
  return {
    writeHead(status, headers) { state.status = status; state.headers = headers || null },
    end(body) {
      if (body !== undefined && body !== null) state.chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)))
    },
    get status() { return state.status },
    get headers() { return state.headers },
    get body() { return Buffer.concat(state.chunks) },
    get json() { return JSON.parse(Buffer.concat(state.chunks).toString('utf8')) },
  }
}

async function callRoute(sessions, query, { method = 'GET', rejection } = {}) {
  const { registered, effects } = mountCtx(sessions, rejection)
  assert.equal(registered.length, 1, '只注册一条路由')
  const res = fakeRes()
  await registered[0].handler(fakeReq(`${ZIP_ROUTE}${query}`, method), res)
  return { route: registered[0], effects, res }
}

/** 迷你 ZIP 解析（只取条目名，够验证内容是否落对）。 */
function zipNames(buf) {
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP 本地头签名')
  const count = buf.readUInt16LE(buf.length - 22 + 10)
  let pos = buf.readUInt32LE(buf.length - 22 + 16)
  const names = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50)
    const nameLen = buf.readUInt16LE(pos + 28)
    names.push(buf.toString('utf8', pos + 46, pos + 46 + nameLen))
    pos += 46 + nameLen
  }
  return names
}

/** 取出一个条目的解压内容。 */
function zipData(buf, wanted) {
  const count = buf.readUInt16LE(buf.length - 22 + 10)
  let pos = buf.readUInt32LE(buf.length - 22 + 16)
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(pos + 10)
    const compSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen)
    if (name === wanted) {
      const lhNameLen = buf.readUInt16LE(localOffset + 26)
      const lhExtraLen = buf.readUInt16LE(localOffset + 28)
      const raw = buf.subarray(localOffset + 30 + lhNameLen + lhExtraLen, localOffset + 30 + lhNameLen + lhExtraLen + compSize)
      return method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
    }
    pos += 46 + nameLen
  }
  return undefined
}

// ── 注册形态 ────────────────────────────────────────────────────────────────

test('apply 注册一条 exact 只读路由，并挂上 effect disposer', () => {
  const { registered, effects, returned } = mountCtx(sessionsWith({ a: { header: { cwd: rootA } } }))
  assert.equal(returned, undefined, 'apply 不返回值（loader 把返回值当 disposable）')
  assert.equal(registered[0].kind, 'exact')
  assert.equal(registered[0].path, ZIP_ROUTE)
  assert.equal(typeof registered[0].handler, 'function')
  assert.equal(effects.length, 1)
  assert.match(effects[0].label, /zip route/)
  assert.equal(typeof effects[0].dispose, 'function')
})

test('webServer 不可用时只 warn，不抛', () => {
  const ctx = { logger: { warn() {}, info() {}, error() {} }, sessions: sessionsWith({}), connection: {} }
  assert.doesNotThrow(() => plugin.apply(ctx))
})

// ── workspaceOf ────────────────────────────────────────────────────────────

test('workspaceOf：缺 sessionId → 400；未知/无 cwd/目录不存在 → 404；越界异常 → 404', () => {
  const sessions = sessionsWith({
    ok: { header: { cwd: rootA } },
    nocwd: { header: {} },
    gone: { header: { cwd: missingDir } },
  })
  assert.deepEqual(plugin.workspaceOf(sessions, ''), { ok: false, status: 400, error: '缺少 sessionId' })
  assert.equal(plugin.workspaceOf(sessions, 'nope').status, 404)
  assert.equal(plugin.workspaceOf(sessions, 'nocwd').status, 404)
  assert.equal(plugin.workspaceOf(sessions, 'gone').status, 404)

  const ok = plugin.workspaceOf(sessions, 'ok')
  assert.equal(ok.ok, true)
  assert.equal(ok.workspace, rootA)
  assert.equal(ok.root, fs.realpathSync(rootA))

  const throwing = { get() { throw new Error('store exploded') } }
  const r = plugin.workspaceOf(throwing, 'x')
  assert.equal(r.status, 404)
  assert.match(r.error, /会话读取失败.*store exploded/)
})

// ── 信任栅栏与错误 ──────────────────────────────────────────────────────────

test('信任栅栏：requestRejection 返回 401 时直接短路，不落文件系统', async () => {
  const { res } = await callRoute(sessionsWith({ a: { header: { cwd: rootA } } }), '?sessionId=a&path=plain.txt', { rejection: 401 })
  assert.equal(res.status, 401)
  assert.equal(res.body.length, 0)
})

test('非 GET → 405；缺 sessionId → 400；未知会话 → 404', async () => {
  const sessions = sessionsWith({ a: { header: { cwd: rootA } } })
  assert.equal((await callRoute(sessions, '?sessionId=a&path=plain.txt', { method: 'POST' })).res.status, 405)
  const noSid = await callRoute(sessions, '?path=plain.txt')
  assert.equal(noSid.res.status, 400)
  assert.equal(noSid.res.json.error, '缺少 sessionId')
  const unknown = await callRoute(sessions, '?sessionId=zzz&path=plain.txt')
  assert.equal(unknown.res.status, 404)
})

test('路径越界与绝对路径被拒（zip 路由不接受绝对路径）', async () => {
  const sessions = sessionsWith({ a: { header: { cwd: rootA } } })
  const up = await callRoute(sessions, '?sessionId=a&path=..%2F..%2Fetc%2Fpasswd')
  assert.equal(up.res.status, 400)
  assert.equal(up.res.json.error, '路径越界')
  const abs = await callRoute(sessions, `?sessionId=a&path=${encodeURIComponent(path.join(rootA, 'plain.txt'))}`)
  assert.equal(abs.res.status, 400)
  assert.equal(abs.res.json.error, '不允许绝对路径')
})

test('未选路径 → 400；不存在的路径 → 404', async () => {
  const sessions = sessionsWith({ a: { header: { cwd: rootA } } })
  assert.equal((await callRoute(sessions, '?sessionId=a')).res.status, 400)
  assert.equal((await callRoute(sessions, '?sessionId=a&path=nope.txt')).res.status, 404)
})

// ── 会话工作区隔离 + zip 内容 ───────────────────────────────────────────────

test('每个会话只打包自己的工作区：A 里没有 B 的文件，反之亦然', async () => {
  const sessions = sessionsWith({ a: { header: { cwd: rootA } }, b: { header: { cwd: rootB } } })

  const a = await callRoute(sessions, '?sessionId=a&path=only-a.txt')
  assert.equal(a.res.status, 200)
  assert.equal(a.res.headers['content-type'], 'application/zip')
  assert.deepEqual(zipNames(a.res.body), ['only-a.txt'])
  assert.equal(zipData(a.res.body, 'only-a.txt').toString(), 'A')

  const b = await callRoute(sessions, '?sessionId=b&path=only-b.txt')
  assert.equal(zipData(b.res.body, 'only-b.txt').toString(), 'B')

  // 用 A 的会话去取 B 的文件名 → 404（各自根下不存在），越界写法 → 400
  assert.equal((await callRoute(sessions, '?sessionId=a&path=only-b.txt')).res.status, 404)
  assert.equal((await callRoute(sessions, `?sessionId=a&path=${encodeURIComponent('../' + path.basename(rootB) + '/only-b.txt')}`)).res.status, 400)
})

test('整目录递归 + 多选 + 自定义 name', async () => {
  const sessions = sessionsWith({ a: { header: { cwd: rootA } } })
  const dir = await callRoute(sessions, '?sessionId=a&path=docs')
  assert.equal(dir.res.status, 200)
  assert.deepEqual(zipNames(dir.res.body).sort(), ['docs/', 'docs/guide.md', 'docs/nested/'])
  assert.match(dir.res.headers['content-disposition'], /docs\.zip/)

  const multi = await callRoute(sessions, '?sessionId=a&path=plain.txt&path=docs&name=%E6%88%91%E7%9A%84%E5%8C%85')
  assert.equal(multi.res.status, 200)
  assert.deepEqual(zipNames(multi.res.body).sort(), ['docs/', 'docs/guide.md', 'docs/nested/', 'plain.txt'])
  assert.match(multi.res.headers['content-disposition'], /%E6%88%91%E7%9A%84%E5%8C%85\.zip/)

  const single = await callRoute(sessions, '?sessionId=a&path=plain.txt')
  assert.match(single.res.headers['content-disposition'], /plain\.txt\.zip/)
  assert.equal(zipData(single.res.body, 'plain.txt').toString(), 'hello zip')
})

test('同名重复 path 去重', async () => {
  const sessions = sessionsWith({ a: { header: { cwd: rootA } } })
  const r = await callRoute(sessions, '?sessionId=a&path=plain.txt&path=plain.txt')
  assert.deepEqual(zipNames(r.res.body), ['plain.txt'])
})
