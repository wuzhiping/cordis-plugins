'use strict'

/**
 * dsh-file-share — Client half (v3: 读走宿主 workspaceFiles Remote)
 *
 * 在对话区顶部 tab（conversation.view）注册「文件」，把当前会话工作区做成
 * 目录树：浏览 / 预览 / 单文件下载 / 整目录与多选打包下载 / 搜索过滤 /
 * 「@」把 @绝对路径 注入输入框交给 agent。
 *
 * ③ 之后的数据通道：
 *  - 读（list / readBytes）：宿主 `ctx.remote.workspaceFiles` Remote。
 *    sessionId 决定工作区根，路径限制、条目上限(2000)、单文件上限(32MB)、
 *    字节窗口上限(2MB)全部由宿主负责——客户端不再自建路径沙箱与文件接口。
 *  - 打包 zip：唯一保留的宿主同源路由 /dsh-file-share/api/download-zip
 *    （Remote 没有 zip；逐文件 RPC 打包会把 N 次往返与全部字节压到浏览器）。
 *  - 写（上传 / 新建文件夹 / 改名 / 删除）：已下线。宿主没有任何客户端可调用
 *    的写 Remote，改写请交给 agent 的 read/write 工具。
 *
 * 工作区根 `cwd` 来自 slot 的标准 prop `useSessions`（与 conversation view
 * 自身同源：`useSessions((s) => s.byId[sessionId]?.cwd)`）。
 *
 * ④：「@」注入走 slot 的标准 prop `inputActions`（captureInsertion + insertText，
 * span-CAS），不再有 document.execCommand / DOM 查询 / textarea 兼容分支。
 */

const API = '/dsh-file-share/api'

/** 宿主 workspaceFiles 的默认上限（Host Config: maxFileBytes / maxBytes）。 */
const REMOTE_COMPLETE_LIMIT = 32 * 1024 * 1024
const READ_CHUNK = 1024 * 1024 // 自己再收一档，留在宿主 2MB 窗口上限之内
const TEXT_PREVIEW_LIMIT = 512 * 1024
const IMAGE_PREVIEW_LIMIT = 32 * 1024 * 1024

const styles = {
  _head: null,
  insert(css) {
    if (typeof document === 'undefined') return
    if (!this._head) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', 'dsh-file-share')
      document.head.appendChild(style)
      this._head = style
    }
    this._head.textContent = css
  },
}

styles.insert(`
.fs-root{display:flex;flex-direction:column;gap:14px;padding:16px 20px;overflow:hidden;height:100%;min-height:240px;color:var(--dsw-alias-label-primary);box-sizing:border-box}
.fs-head{display:flex;flex-direction:column;gap:6px}
.fs-title{font-size:14px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px}
.fs-path{font-size:12px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));word-break:break-all;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.fs-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.fs-cur{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-btn{font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .16s,border-color .16s;flex:none}
.fs-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,var(--dsw-alias-border-l2))}
.fs-btn:disabled{opacity:.5;cursor:default}
.fs-search{width:160px;padding:4px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;flex:none}
.fs-body{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:6px}
.fs-row{display:flex;align-items:center;gap:6px;border-radius:7px;padding:3px 6px;font-size:13px;line-height:1.9}
.fs-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.fs-row[data-cur="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.fs-caret{flex:none;width:14px;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer;user-select:none;font-size:11px}
.fs-ic{flex:none;width:18px;text-align:center}
.fs-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:default}
.fs-nm.dir{cursor:pointer;font-weight:500}
.fs-sz{flex:none;width:72px;text-align:right;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-variant-numeric:tabular-nums}
.fs-ops{display:none;gap:5px;flex:none}
.fs-row:hover .fs-ops{display:flex}
.fs-ops a,.fs-ops button{font-size:11px;padding:1px 7px;border-radius:6px;text-decoration:none;color:var(--dsw-alias-label-secondary);border:1px solid transparent;background:transparent;cursor:pointer}
.fs-ops a:hover,.fs-ops button:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.fs-ops .at{color:var(--dsw-alias-brand-primary)}
.fs-empty{padding:30px 0;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}
.fs-check{flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0 2px}
.fs-selbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);font-size:12px;flex:none}
.fs-selbar .spacer{flex:1}
.fs-selbar .muted{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.fs-note{padding:5px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-top:1px solid var(--dsw-alias-border-l2)}
.fs-spin{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;padding:8px}
.fs-trunc{padding:4px 8px;font-size:11px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
/* 预览浮层 */
.fs-pv-backdrop{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.42)}
.fs-pv{position:fixed;z-index:2147483201;left:50%;top:50%;transform:translate(-50%,-50%);width:min(860px,92vw);height:min(70vh,560px);display:flex;flex-direction:column;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-inverted,var(--dsw-alias-border-l2));border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.3));overflow:hidden}
.fs-pv-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.fs-pv-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.fs-pv-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:none;font-variant-numeric:tabular-nums}
.fs-pv-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
.fs-pv-body pre{margin:0;font:12px/1.7 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;tab-size:2}
.fs-pv-body img{max-width:100%;max-height:100%;object-fit:contain;display:block;margin:0 auto}
.fs-pv-empty{padding:36px 0;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px}
.fs-pv-foot{display:flex;gap:8px;align-items:center;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l2);flex:none}
.fs-pv-foot .spacer{flex:1}
`)

function fmtSize(n) {
  if (n == null) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}

function stripTrailingSep(p) {
  return String(p || '').replace(/[/\\]+$/, '')
}

/** 子路径：宿主接受混合分隔符，这里固定用 `/`（与 sidebar-files 的 childPath 同款）。 */
function joinAbs(parent, name) {
  return `${stripTrailingSep(parent)}/${name}`
}

/** 绝对路径 → 相对工作区路径（zip 路由要求相对路径）。 */
function relOf(cwd, abs) {
  const rest = String(abs || '').slice(stripTrailingSep(cwd).length)
  return rest.replace(/^[/\\]+/, '')
}

function failureText(error) {
  if (!error) return '未知错误'
  const code = error.code ? `[${error.code}] ` : ''
  return code + (error.message || String(error))
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])
const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
}
const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cc', 'sh', 'bash', 'zsh', 'fish', 'sql', 'ps1', 'bat', 'cmake', 'dockerfile', 'makefile', 'properties', 'gitignore', 'editorconfig'])

function extOf(name) {
  const i = String(name || '').lastIndexOf('.')
  return i >= 0 ? String(name).slice(i + 1).toLowerCase() : ''
}

/**
 * 读一个文件的完整字节。≤32MB（宿主 maxFileBytes 默认）一次调用；
 * 更大则按 1MB 窗口续读（宿主 maxBytes 默认 2MB，是 range.length 的上限）。
 * @returns Uint8Array 数组，交给 Blob 直接消费。
 */
async function readAllBytes(wf, sessionId, abs, size, signal) {
  if (size == null || size <= REMOTE_COMPLETE_LIMIT) {
    const r = await wf.readBytes(sessionId, abs, {}, signal)
    if (!r.ok) throw new Error(failureText(r.error))
    return [r.value.data]
  }
  const parts = []
  let offset = 0
  for (;;) {
    const r = await wf.readBytes(sessionId, abs, { range: { offset, length: READ_CHUNK } }, signal)
    if (!r.ok) throw new Error(failureText(r.error))
    parts.push(r.value.data)
    offset += r.value.data.length
    if (r.value.eof || r.value.data.length === 0) break
  }
  return parts
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => { try { URL.revokeObjectURL(url) } catch {} }, 5000)
}

let sessionsSvc = null // 会话服务（@ 成功后切回对话 tab；动态 inject）

/**
 * 把 `@绝对路径` 插入输入框。
 *
 * ④ 之后走 conversation.view 的标准 prop `inputActions`（宿主输入域的公开动作面），
 * 不再用 `document.execCommand`：
 *   captureInsertion() 取一次「选区 + draft 修订号」，insertText() 以 span-CAS 插入；
 *   草稿被并发改动或编辑器已锁定提交时返回 false —— 既不会覆盖用户后续的编辑，
 *   也不会像 execCommand 那样把 reference chip 打散。
 * 仅当 inputActions 不可用或编辑器锁定（提交中）时退化为剪贴板。
 *
 * @returns 'ok' 已插入输入框 | 'copied' 已退化为剪贴板
 */
function insertFileRef(inputActions, abs) {
  const text = '@' + abs + ' '
  try {
    if (inputActions && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
      if (inputActions.insertText(text, inputActions.captureInsertion())) return 'ok'
      // span 与插入之间草稿被改动：重取一次再试
      if (inputActions.insertText(text, inputActions.captureInsertion())) return 'ok'
    }
  } catch (e) {
    console.error('[dsh-file-share] inputActions.insertText:', e)
  }
  try { navigator.clipboard.writeText(text) } catch {}
  return 'copied'
}

/** 文件预览浮层：文本/代码直显、图片内联、超限或不支持给下载/@。 */
function FilePreviewOverlay(props) {
  const h = React.createElement
  const { sessionId, cwd, abs, name, size, getWorkspaceFiles, onClose, onAt } = props
  const ext = extOf(name)
  const kind = IMAGE_EXT.has(ext) ? 'img' : (TEXT_EXT.has(ext) || ext === '' ? 'text' : 'unknown')
  const [state, setState] = React.useState({ status: 'loading' })

  React.useEffect(() => {
    let alive = true
    let objectUrl = null
    setState({ status: 'loading' })
    const run = async () => {
      try {
        const wf = getWorkspaceFiles()
        if (!wf) throw new Error('宿主 workspaceFiles Remote 不可用')
        const isImg = kind === 'img'
        const limit = isImg ? IMAGE_PREVIEW_LIMIT : TEXT_PREVIEW_LIMIT
        if (typeof size === 'number' && size > limit) { if (alive) setState({ status: 'too-big', kind }); return }
        const parts = await readAllBytes(wf, sessionId, abs, size, undefined)
        if (!alive) return
        if (isImg) {
          objectUrl = URL.createObjectURL(new Blob(parts, { type: IMAGE_MIME[ext] || 'application/octet-stream' }))
          setState({ status: 'img', url: objectUrl })
        } else if (kind === 'text') {
          const text = await new Blob(parts).text()
          if (alive) setState({ status: 'text', text })
        } else {
          setState({ status: 'unknown' })
        }
      } catch (e) {
        if (alive) setState({ status: 'error', message: String((e && e.message) || e) })
      }
    }
    void run()
    return () => { alive = false; if (objectUrl) { try { URL.revokeObjectURL(objectUrl) } catch {} } }
  }, [abs, name])

  React.useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !(e.isComposing === true)) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const body = () => {
    if (state.status === 'loading') return h('div', { className: 'fs-pv-empty' }, '加载预览…')
    if (state.status === 'text') return h('pre', null, state.text)
    if (state.status === 'img') return h('img', { src: state.url, alt: name })
    if (state.status === 'too-big') return h('div', { className: 'fs-pv-empty' }, `文件过大（${fmtSize(size)}），不支持在线预览，请下载或 @ 给 agent 查看。`)
    if (state.status === 'unknown') return h('div', { className: 'fs-pv-empty' }, `暂不支持预览 .${ext} 类型，请下载或 @ 给 agent 处理。`)
    return h('div', { className: 'fs-pv-empty' }, `预览失败：${state.message || ''}`)
  }

  return h('div', { className: 'fs-pv-backdrop', onClick: onClose },
    h('div', { className: 'fs-pv', onClick: (e) => e.stopPropagation() },
      h('div', { className: 'fs-pv-head' },
        h('span', { className: 'fs-pv-title', title: abs }, name),
        h('span', { className: 'fs-pv-sub' }, size != null ? fmtSize(size) : ''),
        h('button', { className: 'fs-btn', onClick: onClose }, '✕'),
      ),
      h('div', { className: 'fs-pv-body' }, body()),
      h('div', { className: 'fs-pv-foot' },
        h('span', { className: 'fs-path', style: { maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' } }, abs),
        h('span', { className: 'spacer' }),
        h('button', { className: 'fs-btn', onClick: () => onAt(abs) }, '@ 给 agent'),
      ),
    ),
  )
}

/** conversation.view「文件」tab。 */
function FileManagerTab(props) {
  const h = React.createElement
  const sessionId = props && props.sessionId
  const getWorkspaceFiles = props && props.getWorkspaceFiles
  const inputActions = props && props.inputActions

  // 工作区根：与 conversation view 同源的标准 prop（reactive）。
  const useSessions = props && props.useSessions
  const cwdRaw = typeof useSessions === 'function'
    ? useSessions((s) => (sessionId === undefined || sessionId === null ? undefined : (s.byId[sessionId] && s.byId[sessionId].cwd)))
    : undefined
  const cwd = typeof cwdRaw === 'string' && cwdRaw !== '' ? stripTrailingSep(cwdRaw) : null

  const [cur, setCur] = React.useState('')             // 当前目录（绝对路径）
  const [children, setChildren] = React.useState({})   // abs → {dirs, files, truncated}
  const [open, setOpen] = React.useState({})           // abs → true 展开
  const [query, setQuery] = React.useState('')
  const [error, setError] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const [hint, setHint] = React.useState(null)
  const [reloadTick, setReloadTick] = React.useState(0)
  const [preview, setPreview] = React.useState(null)   // { abs, name, size }
  const [sel, setSel] = React.useState(() => new Set()) // 勾选待打包的绝对路径（文件/目录混选）

  const loadDir = async (abs, signal, silent) => {
    const wf = getWorkspaceFiles ? getWorkspaceFiles() : undefined
    if (!wf) { if (!silent) setError('宿主 workspaceFiles Remote 不可用'); return null }
    if (!silent) setError(null)
    try {
      const r = await wf.list(sessionId, abs, signal)
      if (!r.ok) throw new Error(failureText(r.error))
      const entries = r.value.entries || []
      setChildren((prev) => ({
        ...prev,
        [abs]: {
          dirs: entries.filter((e) => e.type === 'directory'),
          files: entries.filter((e) => e.type === 'file'),
          truncated: Boolean(r.value.truncated),
        },
      }))
      return r.value
    } catch (e) {
      if (!silent) setError(String((e && e.message) || e))
      return null
    }
  }

  React.useEffect(() => {
    if (!sessionId || !cwd) return
    let alive = true
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null
    setError(null); setCur(cwd); setChildren({}); setOpen({}); setSel(new Set())
    void loadDir(cwd, ctrl && ctrl.signal, true)
    return () => { alive = false; if (ctrl) { try { ctrl.abort() } catch {} } }
  }, [sessionId, cwd, reloadTick])

  const toggleSel = (abs) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(abs)) next.delete(abs)
      else next.add(abs)
      return next
    })
  }

  /** 打包下载（宿主唯一保留的路由）：成功触发浏览器下载，失败在面板内报错。 */
  const zipDownload = async (absList) => {
    if (!cwd) return
    const p = new URLSearchParams()
    p.set('sessionId', sessionId)
    for (const abs of absList) p.append('path', relOf(cwd, abs))
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${API}/download-zip?${p.toString()}`)
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}))
        throw new Error((payload && payload.error) || `HTTP ${res.status}`)
      }
      const blob = await res.blob()
      let filename = 'download.zip'
      const m = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') || '')
      if (m) { try { filename = decodeURIComponent(m[1]) } catch {} }
      saveBlob(blob, filename)
      setHint(`已打包下载 ${filename}（${absList.length} 项）`)
      setTimeout(() => setHint(null), 3500)
    } catch (e) {
      setError(`打包下载失败：${(e && e.message) || e}`)
    } finally {
      setBusy(false)
    }
  }

  const downloadFile = async (abs, name, size) => {
    setBusy(true); setError(null)
    try {
      const wf = getWorkspaceFiles ? getWorkspaceFiles() : undefined
      if (!wf) throw new Error('宿主 workspaceFiles Remote 不可用')
      const parts = await readAllBytes(wf, sessionId, abs, size, undefined)
      saveBlob(new Blob(parts), name)
      setHint(`已下载 ${name}（${fmtSize(size) || '未知大小'}）`)
      setTimeout(() => setHint(null), 3500)
    } catch (e) {
      setError(`下载 ${name} 失败：${(e && e.message) || e}`)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (abs) => {
    setCur(abs)
    if (open[abs]) { setOpen((o) => ({ ...o, [abs]: false })); return }
    setOpen((o) => ({ ...o, [abs]: true }))
    if (!children[abs]) void loadDir(abs, undefined, true)
  }

  const atRef = (abs) => {
    const result = insertFileRef(inputActions, abs)
    if (result === 'ok') {
      // 切回对话 tab（会话深链 open 对当前会话即激活对话视图），草稿已就位
      try { if (sessionsSvc && typeof sessionsSvc.open === 'function') sessionsSvc.open(sessionId) } catch {}
    } else {
      setHint('输入框正在提交或输入域不可用，已复制到剪贴板，请手动粘贴')
      setTimeout(() => setHint(null), 3500)
    }
  }

  if (!sessionId) return h('div', { className: 'fs-root' }, h('p', { className: 'fs-empty' }, '无会话上下文'))
  if (!cwd) return h('div', { className: 'fs-root' }, h('div', { className: 'fs-spin' }, '等待会话工作区…'))

  const q = query.trim().toLowerCase()
  const match = (name) => !q || name.toLowerCase().includes(q)

  /** 渲染 abs 目录的一层（dirs 在前；dirs 有子层则递归到 open 状态）。 */
  const renderLevel = (abs) => {
    const node = children[abs]
    const rows = []
    if (!node) return rows
    const depth = relOf(cwd, abs) === '' ? 0 : relOf(cwd, abs).split('/').filter(Boolean).length
    const shownDirs = node.dirs.filter((d) => match(d.name))
    const shownFiles = node.files.filter((f) => match(f.name))
    for (const d of shownDirs) {
      const sub = joinAbs(abs, d.name)
      const isOpen = Boolean(open[sub])
      const isCur = cur === sub
      rows.push(h('div', { key: 'd:' + sub, className: 'fs-row', 'data-cur': isCur, style: { paddingLeft: 6 + depth * 16 } },
        h('input', { type: 'checkbox', className: 'fs-check', title: '选择以便打包下载', checked: sel.has(sub), onClick: (e) => e.stopPropagation(), onChange: () => toggleSel(sub) }),
        h('span', { className: 'fs-caret', onClick: () => toggle(sub) }, isOpen ? '▾' : '▸'),
        h('span', { className: 'fs-ic' }, '📁'),
        h('span', { className: 'fs-nm dir', title: d.name, onClick: () => toggle(sub) }, d.name),
        h('span', { className: 'fs-ops' },
          h('button', { onClick: (e) => { e.stopPropagation(); toggle(sub) } }, '进入'),
          h('button', { className: 'at', title: '@ 目录给 agent', onClick: (e) => { e.stopPropagation(); atRef(sub) } }, '@'),
          h('button', { disabled: busy, onClick: (e) => { e.stopPropagation(); void zipDownload([sub]) } }, '下载'),
        ),
      ))
      if (isOpen) rows.push(...renderLevel(sub))
    }
    for (const f of shownFiles) {
      const fileAbs = joinAbs(abs, f.name)
      rows.push(h('div', { key: 'f:' + fileAbs, className: 'fs-row', style: { paddingLeft: 6 + (depth + 1) * 16 } },
        h('input', { type: 'checkbox', className: 'fs-check', title: '选择以便打包下载', checked: sel.has(fileAbs), onClick: (e) => e.stopPropagation(), onChange: () => toggleSel(fileAbs) }),
        h('span', { className: 'fs-caret' }),
        h('span', { className: 'fs-ic' }, '📄'),
        h('span', { className: 'fs-nm', title: `${f.name}（点击预览）`, style: { cursor: 'pointer' }, onClick: () => setPreview({ abs: fileAbs, name: f.name, size: f.size }) }, f.name),
        h('span', { className: 'fs-sz' }, fmtSize(f.size)),
        h('span', { className: 'fs-ops' },
          h('button', { onClick: () => setPreview({ abs: fileAbs, name: f.name, size: f.size }) }, '预览'),
          h('button', { disabled: busy, onClick: () => void downloadFile(fileAbs, f.name, f.size) }, '下载'),
          h('button', { className: 'at', onClick: () => atRef(fileAbs) }, '@'),
        ),
      ))
    }
    return rows
  }

  const rel = relOf(cwd, cur)
  const crumbParts = rel ? rel.split('/').filter(Boolean) : []
  const crumb = () => {
    const nodes = [h('a', { key: 'root', style: { cursor: 'pointer', color: 'var(--dsw-alias-brand-primary)' }, onClick: () => setCur(cwd) }, '工作区')]
    let acc = ''
    crumbParts.forEach((p, i) => {
      acc = acc ? acc + '/' + p : p
      const target = joinAbs(cwd, acc)
      nodes.push(h('span', { key: 'sep' + i }, ' / '))
      nodes.push(h('a', { key: i, style: { cursor: 'pointer' }, onClick: () => setCur(target) }, p))
    })
    return nodes
  }

  const rootNode = children[cwd]
  const rows = renderLevel(cwd)

  return h('div', { className: 'fs-root' },
    h('div', { className: 'fs-head' },
      h('p', { className: 'fs-title' }, '📁 文件', h('span', { style: { fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))' } }, '会话工作区 · 只读')),
      h('div', { className: 'fs-path', title: cwd }, cwd),
    ),
    h('div', { className: 'fs-bar' },
      h('div', { className: 'fs-cur' }, crumb()),
      h('input', { className: 'fs-search', placeholder: '过滤名称…', value: query, onChange: (e) => setQuery(e.target.value) }),
      h('button', { className: 'fs-btn', disabled: busy, onClick: () => setReloadTick((t) => t + 1) }, '刷新'),
    ),
    sel.size > 0 && h('div', { className: 'fs-selbar' },
      h('span', null, `已选 ${sel.size} 项`),
      h('button', { className: 'fs-btn', disabled: busy, style: { color: 'var(--dsw-alias-brand-primary)' }, onClick: () => void zipDownload([...sel]) }, '打包下载'),
      h('button', { className: 'fs-btn', disabled: busy, onClick: () => setSel(new Set()) }, '取消'),
      h('span', { className: 'spacer' }),
      h('span', { className: 'muted' }, '文件与文件夹可混选，打包为 zip（保留目录结构）'),
    ),
    h('div', { className: 'fs-body' },
      error && h('div', { className: 'fs-empty', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
      !error && !rootNode && h('div', { className: 'fs-spin' }, '加载目录树…'),
      !error && rootNode && rows.length === 0 && h('div', { className: 'fs-empty' }, query ? '无匹配项' : '（空目录）'),
      rootNode && rootNode.truncated && h('div', { className: 'fs-trunc' }, '目录条目超过宿主上限（2000），仅显示前 2000 项'),
      rows,
    ),
    h('div', { className: 'fs-note' },
      hint || '点击文件名或行内「预览」查看内容；悬停文件行可 下载 / @，悬停目录行可 整目录打包下载；勾选多项后可批量打包下载。写操作请交给 agent（本 tab 只读）。',
    ),
    preview && h(FilePreviewOverlay, {
      sessionId,
      cwd,
      abs: preview.abs,
      name: preview.name,
      size: preview.size,
      getWorkspaceFiles,
      onClose: () => setPreview(null),
      onAt: atRef,
    }),
  )
}

/** 解析宿主 Client Remote 的 workspaceFiles 命名空间（静态取不到就等动态 inject）。 */
function resolveWorkspaceFiles(scope) {
  if (!scope) return undefined
  try {
    if (typeof scope.get === 'function') {
      const direct = scope.get('remote.workspaceFiles')
      if (direct) return direct
      const remote = scope.get('remote')
      if (remote && remote.workspaceFiles) return remote.workspaceFiles
    }
    if (scope.remote) {
      if (scope.remote.workspaceFiles) return scope.remote.workspaceFiles
      if (scope.remote.$mount && scope.remote.workspaceFiles) return scope.remote.workspaceFiles
    }
  } catch {}
  return undefined
}

module.exports = {
  name: 'dsh-file-share',
  inject: ['slots'],

  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    // 不 return 任何值（cordis-plugin-loader 把 apply 返回值当 disposable/effect）。

    // 宿主 Client Remote：workspaceFiles 命名空间（读的唯一通道）。
    let workspaceFiles = resolveWorkspaceFiles(ctx)
    if (workspaceFiles === undefined && typeof ctx.inject === 'function') {
      try {
        ctx.inject(['remote'], (scope) => { workspaceFiles = resolveWorkspaceFiles(scope) })
      } catch (e) { console.error('[dsh-file-share] remote inject:', e) }
    }
    const getWorkspaceFiles = () => workspaceFiles

    // 会话服务：@ 之后 sessions.open(sessionId) 切回对话 tab（动态 inject）
    try {
      if (typeof ctx.inject === 'function') ctx.inject(['sessions'], (scope) => { sessionsSvc = scope && scope.sessions })
    } catch (e) { console.error('[dsh-file-share] sessions inject:', e) }

    if (typeof slots.inject === 'function') {
      slots.inject('conversation.view', () => slots.register(
        { name: 'conversation.view', id: 'dsh-file-share', order: 27, label: () => '文件' },
        (props) => React.createElement(FileManagerTab, Object.assign({}, props, { getWorkspaceFiles })),
      ))
    }
  },
}
