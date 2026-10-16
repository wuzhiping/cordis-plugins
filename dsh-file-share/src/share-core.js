'use strict'

/**
 * dsh-file-share — zip core
 *
 * ③ 之后本包只保留「宿主独有」的那一件事：在进程内把一个工作区目录 / 多选路径
 * 打包成 zip。列表、预览、单文件下载、路径边界与分页上限都已改走宿主
 * `ctx.workspaceFiles` Remote（sessionId → 工作区根解析、工作区限制、条目/字节
 * 上限全部归宿主），这里只剩下 zip 需要的两件事：
 *
 *  1. 路径边界：词法边界 + 符号链接真实路径边界（resolveExisting）；
 *  2. 零依赖 ZIP 构建：目录条目 STORE、文件条目 deflateRaw、UTF-8 名、CRC32，
 *     条目数 / 解压总量双上限，递归中符号链接逃逸 root 的条目跳过。
 *
 * 已删除（③ 的清理目标）：token 门禁、每 IP 限流、只读模式、CORS、独立端口
 * 服务器与单页 HTML、上传、新建文件夹、改名、删除、列目录、单文件下载、
 * 敏感名过滤（宿主 workspaceFiles 是可见性的唯一权威，客户端不再自建策略）。
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const VERSION = '0.2.0'
const MAX_ZIP_ENTRIES = 4000
const MAX_ZIP_UNCOMPRESSED = 128 * 1024 * 1024

/** 业务错误：带 HTTP status，路由层原样转 JSON。 */
class ShareError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function statOrThrow(abs, missingStatus = 404) {
  try {
    return fs.statSync(abs)
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new ShareError(missingStatus, `不存在: ${path.basename(abs)}`)
    if (e && (e.code === 'EACCES' || e.code === 'EPERM')) throw new ShareError(403, `无权限: ${path.basename(abs)}`)
    throw e
  }
}

/** root 规范化：必须是已存在的绝对目录。 */
function ensureRoot(root) {
  if (typeof root !== 'string' || root.trim() === '') throw new ShareError(500, '工作区根目录未配置')
  const r = path.resolve(root)
  const st = statOrThrow(r, 500)
  if (!st.isDirectory()) throw new ShareError(500, '工作区根不是目录')
  return r
}

/** 词法边界：rel 解析后必须仍在 rootAbs 内。 */
function lexicalAbs(rootAbs, rel) {
  const relStr = typeof rel === 'string' && rel !== '' ? rel : '.'
  if (relStr.includes('\0')) throw new ShareError(400, '非法路径')
  if (path.isAbsolute(relStr)) throw new ShareError(400, '不允许绝对路径')
  const abs = path.resolve(rootAbs, relStr)
  const relChk = path.relative(rootAbs, abs)
  if (relChk === '..' || relChk.startsWith('..' + path.sep)) throw new ShareError(400, '路径越界')
  return abs
}

function insideReal(realRoot, realTarget) {
  const r = path.relative(realRoot, realTarget)
  return !(r === '..' || r.startsWith('..' + path.sep))
}

/** 解析已存在的条目；符号链接逃逸出 root 一律拒绝。 */
function resolveExisting(root, rel) {
  const rootAbs = ensureRoot(root)
  const abs = lexicalAbs(rootAbs, rel)
  statOrThrow(abs)
  const realRoot = fs.realpathSync(rootAbs)
  const real = fs.realpathSync(abs)
  if (!insideReal(realRoot, real)) throw new ShareError(400, '符号链接越界')
  return abs
}

// ── zip 打包（零依赖：ZIP 结构手写，目录条目 STORE，文件条目 deflateRaw）──────

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function dosDateTime(ms) {
  const d = new Date(ms)
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  const date = ((Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate())
  return { time: time & 0xFFFF, date: date & 0xFFFF }
}

/** entries: [{ name, data?, isDir?, mtime? }] → Buffer（本地头 + 中央目录 + EOCD，UTF-8 名）。 */
function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const ent of entries) {
    const nameBuf = Buffer.from(ent.name, 'utf8')
    const data = ent.isDir || !ent.data ? Buffer.alloc(0) : ent.data
    const method = ent.isDir ? 0 : 8
    const compressed = ent.isDir ? data : zlib.deflateRawSync(data)
    const { time, date } = dosDateTime(ent.mtime || Date.now())
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(ent.isDir ? 0x10 : 0, 38) // MS-DOS 目录位
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += 30 + nameBuf.length + compressed.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

/**
 * 收集并响应 zip 下载。rels 为相对工作区的路径（可多个，文件/目录混选）；
 * 目录递归展开，zip 内保留相对路径结构；递归中符号链接逃逸出 root 的条目跳过；
 * entries/字节双上限防失控。
 */
function sendZip(res, root, rels, opts) {
  const options = opts || {}
  const maxEntries = options.zipMaxEntries > 0 ? options.zipMaxEntries : MAX_ZIP_ENTRIES
  const maxBytes = options.zipMaxBytes > 0 ? options.zipMaxBytes : MAX_ZIP_UNCOMPRESSED
  const uniq = [...new Set((Array.isArray(rels) ? rels : []).map((r) => String(r || '').replace(/^\/+|\/+$/g, '')).filter(Boolean))]
  if (uniq.length === 0) throw new ShareError(400, '未选择要下载的路径')

  const realRoot = fs.realpathSync(ensureRoot(root))
  const entries = []
  let total = 0
  const addFile = (abs, zipName, st) => {
    if (entries.length >= maxEntries) throw new ShareError(413, `条目数超过上限 ${maxEntries}，请分批下载`)
    const data = fs.readFileSync(abs)
    total += data.length
    if (total > maxBytes) throw new ShareError(413, `总大小超过上限 ${Math.round(maxBytes / 1048576)}MB，请分批下载`)
    entries.push({ name: zipName, data, mtime: st.mtimeMs })
  }
  const addDir = (zipName, mtime) => {
    if (entries.length >= maxEntries) throw new ShareError(413, `条目数超过上限 ${maxEntries}，请分批下载`)
    entries.push({ name: zipName, isDir: true, mtime })
  }
  const walk = (abs, zipName, depth) => {
    if (depth > 32) return
    addDir(zipName + '/', fs.statSync(abs).mtimeMs)
    let names = []
    try { names = fs.readdirSync(abs) } catch { return }
    for (const name of names) {
      const child = path.join(abs, name)
      try {
        if (!insideReal(realRoot, fs.realpathSync(child))) continue // 符号链接逃逸，跳过
      } catch { continue }
      let st
      try { st = fs.statSync(child) } catch { continue }
      if (st.isDirectory()) walk(child, zipName + '/' + name, depth + 1)
      else if (st.isFile()) addFile(child, zipName + '/' + name, st)
    }
  }

  for (const rel of uniq) {
    const abs = resolveExisting(root, rel)
    const st = fs.statSync(abs)
    if (st.isDirectory()) walk(abs, rel, 0)
    else if (st.isFile()) addFile(abs, rel, st)
  }
  if (entries.length === 0) throw new ShareError(404, '所选路径没有可下载的内容')

  const zip = buildZip(entries)
  let name = String(options.name || '').replace(/[\\/]/g, '').trim()
  if (name.length > 100) name = name.slice(0, 100)
  if (!name) name = uniq.length === 1 ? `${path.basename(uniq[0]) || 'download'}.zip` : 'download.zip'
  if (!/\.zip$/i.test(name)) name += '.zip'
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': zip.length,
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store',
  })
  res.end(zip)
}

module.exports = {
  VERSION, MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED, ShareError,
  ensureRoot, resolveExisting,
  buildZip, sendZip,
}
