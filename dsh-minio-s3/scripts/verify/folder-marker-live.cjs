'use strict'
const PLUGIN = require('node:path').join(__dirname, '..', '..')
// 資料夾標記修正的真機驗證：空資料夾裡面不該出現 0 位元組的同名檔案。
const { Readable } = require('node:stream')
const host = require(require('node:path').join(PLUGIN, 'src/index.js'))

let failed = 0
const ok = (label, cond, extra) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : ' — ' + JSON.stringify(extra)))
  if (!cond) failed += 1
}

const routes = new Map()
host.apply({
  logger: { info() {}, warn() {}, error() {} },
  effect(callback) { return callback() },
  webServer: { register(route) { routes.set(route.path, route); return () => {} } },
  connection: { requestRejection: () => undefined },
  sessions: { get: () => null },
  tools: { register: () => () => {} },
})

function call(path) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = Readable.from([])
    req.method = 'GET'
    req.url = path
    req.headers = {}
    const res = {
      writeHead(status, headers) { this.statusCode = status; this.headers = headers || {} },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true },
      once() {},
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); resolve({ status: this.statusCode, body: Buffer.concat(chunks) }) },
    }
    Promise.resolve(routes.get(path.split('?')[0]).handler(req, res)).catch(reject)
  })
}
const json = async (path) => JSON.parse((await call(path)).body.toString('utf8'))

;(async () => {
  const objectsRoute = host.ROUTE.objects
  const root = await json(objectsRoute + '?' + new URLSearchParams({ bucket: 'dsh' }).toString())
  ok('根目錄看得到 docs 資料夾', root.folders.some((entry) => entry.prefix === 'docs/'), root.folders.map((entry) => entry.prefix))
  ok('根目錄沒有把 docs/ 當成檔案', !root.objects.some((entry) => entry.key === 'docs/'), root.objects.map((entry) => entry.key))

  const inside = await json(objectsRoute + '?' + new URLSearchParams({ bucket: 'dsh', prefix: 'docs/' }).toString())
  ok('docs/ 裡面是空的（不再有 0 位元組的 docs 檔案）', inside.objects.length === 0 && inside.folders.length === 0,
    { objects: inside.objects.map((entry) => entry.key), folders: inside.folders.map((entry) => entry.prefix) })

  // 真檔仍要列得出來（不要修過頭）
  const withFile = await json(objectsRoute + '?' + new URLSearchParams({ bucket: 'dsh' }).toString())
  ok('真正的檔案還在', withFile.objects.some((entry) => entry.name === 'CLIENT.md'),
    withFile.objects.map((entry) => entry.key))

  console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
  process.exitCode = failed === 0 ? 0 : 1
})().catch((error) => { console.log('FATAL', (error && error.stack) || error); process.exitCode = 1 })
