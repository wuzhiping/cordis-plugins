'use strict'

/**
 * dsh-file-share — Host half (v3: 只留一条只读 zip 路由)
 *
 * ③ 之后宿主半侧只剩一件事：把工作区里的若干路径在进程内打包成 zip 并回传。
 *
 * 为什么 zip 还留在宿主（而不是也改走 Remote）：
 *  - `ctx.workspaceFiles` 是「一次调用读一个文件」的粒度，没有 zip；
 *  - 客户端打包一个 4000 条目的目录 = 4000 次跨 Gateway RPC，且全部字节
 *    落在浏览器内存；宿主一次请求内用 node fs + zlib 完成，还带 4000 条目 /
 *    128MB 双上限与符号链接逃逸跳过。
 * 列表 / 预览 / 单文件下载 / 路径与分页上限已全部改走宿主 Remote，见
 * client/index.js。
 *
 * 路由：GET /dsh-file-share/api/download-zip?sessionId=…&path=…&path=…&name=…
 *   - sessionId → ctx.sessions.get(id).header.cwd（含持久化会话的兜底不做：
 *     宿主 Remote 支持持久化会话，但 zip 需要一个真实可读目录，故仍要求
 *     本实例的活跃会话，语义与旧版一致）；
 *   - path 为相对工作区路径，由 share-core 做词法 + 符号链接双重边界校验。
 */

const fs = require('node:fs')
const path = require('node:path')

const core = require('./share-core')

const name = 'dsh-file-share'
const inject = ['webServer', 'sessions', 'connection']
const ZIP_ROUTE = '/dsh-file-share/api/download-zip'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function realDir(p) {
  try {
    const r = fs.realpathSync(p)
    return fs.statSync(r).isDirectory() ? r : null
  } catch {
    return null
  }
}

/**
 * sessionId → 该会话工作区的真实目录。
 * 导出给测试直接驱动（见 test/host.test.js）。
 * @returns {{ok: true, workspace: string, root: string} | {ok: false, status: number, error: string}}
 */
function workspaceOf(sessions, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') {
    return { ok: false, status: 400, error: '缺少 sessionId' }
  }
  let session = null
  let lookupError = null
  try {
    session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
  } catch (e) {
    lookupError = String((e && e.message) || e)
  }
  if (lookupError) {
    return { ok: false, status: 404, error: `会话读取失败: ${lookupError}` }
  }
  if (!session) {
    return { ok: false, status: 404, error: '该会话不在本实例的活跃会话中（请先在本实例打开该会话）' }
  }
  const cwd = session.header && session.header.cwd
  if (typeof cwd !== 'string' || !cwd) {
    return { ok: false, status: 404, error: '该会话没有可用的工作区(cwd)' }
  }
  const root = realDir(cwd)
  if (!root) {
    return { ok: false, status: 404, error: `工作区目录不存在或不可访问: ${cwd}` }
  }
  return { ok: true, workspace: cwd, root }
}

module.exports = {
  name,
  inject,
  version: core.VERSION,
  workspaceOf,

  apply(ctx) {
    const logger = ctx.logger || { info() {}, warn() {}, error() {} }
    const webServer = ctx.webServer
    const sessions = ctx.sessions

    if (!(webServer && typeof webServer.register === 'function')) {
      logger.warn('dsh-file-share: webServer 不可用，zip 路由未注册')
      return
    }

    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: ZIP_ROUTE,
      handler: async (req, res) => {
        // 与其它 host 路由一致的信任栅栏：connection 的 Host/Origin 检查加浏览器认证。
        const rejection = ctx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection)
          res.end()
          return
        }
        try {
          if (req.method !== 'GET') {
            sendJson(res, 405, { error: 'method not allowed' })
            return
          }
          const url = new URL(req.url || '/', 'http://dsh.local')
          const w = workspaceOf(sessions, url.searchParams.get('sessionId'))
          if (!w.ok) {
            sendJson(res, w.status, { error: w.error })
            return
          }
          core.sendZip(res, w.root, url.searchParams.getAll('path'), {
            name: url.searchParams.get('name') || '',
          })
        } catch (e) {
          if (e instanceof core.ShareError) {
            sendJson(res, e.status, { error: e.message })
            return
          }
          try { sendJson(res, 500, { error: String((e && e.message) || e) }) } catch {}
        }
      },
    }), 'dsh-file-share: workspace zip route')
  },
}
