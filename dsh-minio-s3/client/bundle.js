/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: "dsh-minio-s3",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
    var React = require("react")
    'use strict'

    /**
     * dsh-minio-s3 — 瀏覽器半邊
     *
     * 在對話區的 tab 列（slot `conversation.view`）加一個「MinIO」頁籤：遠端桶裡
     * 的檔案總管。列桶、逐層瀏覽、預覽、下載、上傳、新建資料夾、改名、刪除都走
     * 宿主的同源路由 `/plugins/dsh-minio-s3/*`。
     *
     * 這一半**不知道** MinIO 端點、UID、PWD —— 那些只在宿主記憶體裡（BDD storage
     * 用本機遮蔽過的金鑰換回來的）。瀏覽器知道的只有：相對路徑、bucket 名稱、
     * object key。S3 簽章、XML、憑證全在宿主。
     *
     * 為什麼不用原生 `prompt()`/`confirm()`：那是同步阻塞的瀏覽器對話框，在
     * iframe/webview 內常被擋掉，被擋掉的樣子是「按了沒反應」。這裡改用面板內
     * 的輸入列（ask 狀態機），行為在任何宿主裡都一樣。
     */

    const API = '/plugins/dsh-minio-s3'

    /** 預覽上限：文字 512KB、圖片 20MB，超過就只給下載。 */
    const TEXT_PREVIEW_LIMIT = 512 * 1024
    const IMAGE_PREVIEW_LIMIT = 20 * 1024 * 1024
    /** 一次上傳的檔案大小上限（與宿主 MAX_UPLOAD_BYTES 對齊）。 */
    const UPLOAD_LIMIT = 256 * 1024 * 1024
    /** 記住上次選的桶。 */
    const STORAGE_KEY = 'dsh-minio-s3:bucket'

    const styles = {
      _head: null,
      insert(css) {
        if (typeof document === 'undefined') return
        if (!this._head) {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-minio-s3')
          document.head.appendChild(style)
          this._head = style
        }
        this._head.textContent = css
      },
    }

    styles.insert(`
    .ms-root{display:flex;flex-direction:column;gap:12px;padding:16px 20px;overflow:hidden;height:100%;min-height:240px;color:var(--dsw-alias-label-primary);box-sizing:border-box}
    .ms-head{display:flex;flex-direction:column;gap:4px}
    .ms-title{font-size:14px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px}
    .ms-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
    .ms-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
    .ms-cur{font-size:12px;color:var(--dsw-alias-label-secondary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--ds-font-family-code,ui-monospace,monospace)}
    .ms-cur a{cursor:pointer;color:var(--dsw-alias-brand-primary);text-decoration:none}
    .ms-cur a:hover{text-decoration:underline}
    .ms-btn{font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;transition:background .16s,border-color .16s;flex:none}
    .ms-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 24%,var(--dsw-alias-border-l2))}
    .ms-btn:disabled{opacity:.5;cursor:default}
    .ms-btn.primary{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l2));color:var(--dsw-alias-brand-primary)}
    .ms-select{font:inherit;font-size:12px;padding:4px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);max-width:220px}
    .ms-search{width:150px;padding:4px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;flex:none}
    .ms-body{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:6px}
    .ms-row{display:flex;align-items:center;gap:6px;border-radius:7px;padding:3px 6px;font-size:13px;line-height:1.9}
    .ms-row:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
    .ms-ic{flex:none;width:18px;text-align:center}
    .ms-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
    .ms-nm.dir{font-weight:500}
    .ms-sz{flex:none;width:74px;text-align:right;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-variant-numeric:tabular-nums}
    .ms-dt{flex:none;width:132px;text-align:right;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;font-variant-numeric:tabular-nums}
    .ms-ops{display:none;gap:5px;flex:none}
    .ms-row:hover .ms-ops{display:flex}
    .ms-ops button{font-size:11px;padding:1px 7px;border-radius:6px;color:var(--dsw-alias-label-secondary);border:1px solid transparent;background:transparent;cursor:pointer}
    .ms-ops button:hover{color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
    .ms-ops button.danger:hover{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))}
    .ms-empty{padding:30px 0;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}
    .ms-err{padding:10px;margin:6px;border-radius:8px;font-size:12px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c0392b) 36%,transparent)}
    .ms-check{flex:none;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:0 2px}
    .ms-selbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,var(--dsw-alias-border-l2));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);font-size:12px;flex:none}
    .ms-selbar .spacer,.ms-ask .spacer{flex:1}
    .ms-note{padding:5px 8px;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));border-top:1px solid var(--dsw-alias-border-l2)}
    .ms-trunc{padding:4px 8px;font-size:11px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
    .ms-warn{margin:0 0 8px;padding:6px 9px;border-radius:8px;font-size:11px;color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d08700) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d08700) 38%,transparent)}
    .ms-ask{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;width:min(420px,86%);display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.3))}
    .ms-ask h4{margin:0;font-size:13px;font-weight:600}
    .ms-export{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:30;width:min(560px,92%);display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.3))}
    .ms-export h4{margin:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
    .ms-export textarea{width:100%;height:230px;box-sizing:border-box;resize:vertical;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:11px/1.6 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);white-space:pre;overflow:auto}
    .ms-export .warn{font-size:11px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}
    .ms-export .spacer{flex:1}
    .ms-ask-row{display:flex;gap:8px;align-items:center}
    .ms-ask input{flex:1;min-width:0;padding:5px 9px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
    .ms-ask-msg{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-word}
    .ms-backdrop{position:absolute;inset:0;z-index:29;background:rgba(0,0,0,.34)}
    .ms-pv-backdrop{position:fixed;inset:0;z-index:2147483200;background:rgba(0,0,0,.42)}
    .ms-pv{position:fixed;z-index:2147483201;left:50%;top:50%;transform:translate(-50%,-50%);width:min(880px,92vw);height:min(72vh,600px);display:flex;flex-direction:column;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 10px 30px rgba(0,0,0,.3));overflow:hidden}
    .ms-pv-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
    .ms-pv-title{font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .ms-pv-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));flex:none;font-variant-numeric:tabular-nums}
    .ms-pv-body{flex:1;min-height:0;overflow:auto;padding:12px 14px;background:var(--dsw-alias-bg-layer-1)}
    .ms-pv-body pre{margin:0;font:12px/1.7 var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;tab-size:2}
    .ms-pv-body img{max-width:100%;max-height:100%;object-fit:contain;display:block;margin:0 auto}
    .ms-pv-empty{padding:36px 0;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px}
    .ms-pv-foot{display:flex;gap:8px;align-items:center;padding:8px 14px;border-top:1px solid var(--dsw-alias-border-l2);flex:none}
    .ms-root{position:relative}
    `)

    const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico'])
    const IMAGE_MIME = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
      avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    }
    const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'csv', 'tsv', 'env', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'vue', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'sh', 'bash', 'sql', 'ps1', 'bat', 'properties'])

    function extOf(name) {
      const index = String(name || '').lastIndexOf('.')
      return index >= 0 ? String(name).slice(index + 1).toLowerCase() : ''
    }

    function fmtSize(n) {
      if (n === null || n === undefined) return ''
      if (n < 1024) return n + ' B'
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
      if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
      return (n / 1073741824).toFixed(2) + ' GB'
    }

    function fmtTime(value) {
      if (!value) return ''
      const at = new Date(value)
      if (Number.isNaN(at.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
    }

    /** 物件深連結（下載或 inline 預覽）。 */
    function objectUrl(bucket, key, extra) {
      const params = new URLSearchParams()
      params.set('bucket', bucket)
      params.set('key', key)
      if (extra) for (const [name, value] of Object.entries(extra)) params.set(name, value)
      return `${API}/object?${params.toString()}`
    }

    /** 呼叫宿主路由；非 2xx 或 `ok:false` 一律轉成 Error（帶 code）。 */
    async function api(path, options) {
      const opts = options || {}
      const init = { method: opts.method || 'GET' }
      if (opts.json !== undefined) {
        init.method = opts.method || 'POST'
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(opts.json)
      }
      if (opts.body !== undefined) init.body = opts.body
      if (opts.headers) init.headers = { ...(init.headers || {}), ...opts.headers }

      const response = await fetch(path, init)
      const text = await response.text()
      let payload = null
      try { payload = text ? JSON.parse(text) : null } catch { payload = null }
      if (!response.ok || (payload && payload.ok === false)) {
        const error = new Error((payload && payload.error) || `HTTP ${response.status}`)
        if (payload && payload.code) error.code = payload.code
        if (payload && payload.stage) error.stage = payload.stage
        error.status = response.status
        throw error
      }
      return payload || {}
    }

    function failureText(error) {
      if (!error) return '未知錯誤'
      const code = error.code ? `[${error.code}] ` : ''
      return code + (error.message || String(error))
    }

    /**
     * 連線層失敗 → 面板上的說法。
     *
     * 刻意**不透傳**宿主的原始訊息：那裡面會帶憑證檔路徑、BDD storage 端點或
     * 內網主機位址，而這個面板是會被截圖與分享的。要看細節請用
     * `GET /plugins/dsh-minio-s3/status?debug=1`（回傳 `detail`）或宿主日誌。
     */
    const CONNECTION_STAGE_TEXT = {
      credential: '本機憑證不可用',
      request: '連線服務查詢失敗',
      response: '連線服務沒有可用的資料',
      config: '連線設定不可用',
    }

    function connectionFailureText(error) {
      const text = CONNECTION_STAGE_TEXT[(error && error.stage) || '']
      return text || '請稍後重試'
    }

    /** 預覽浮層：圖片走宿主代理 inline；文字抓回字串；其餘只提供下載。 */
    function PreviewOverlay(props) {
      const h = React.createElement
      const { bucket, item, onClose, onDownload } = props
      const ext = extOf(item.name)
      const kind = IMAGE_EXT.has(ext) ? 'img' : (TEXT_EXT.has(ext) || ext === '' ? 'text' : 'unknown')
      const [state, setState] = React.useState({ status: 'loading' })

      React.useEffect(() => {
        let alive = true
        setState({ status: 'loading' })
        const run = async () => {
          try {
            if (kind === 'img') {
              if (item.size > IMAGE_PREVIEW_LIMIT) { setState({ status: 'too-big' }); return }
              setState({ status: 'img', url: objectUrl(bucket, item.key, { inline: '1' }) })
              return
            }
            if (kind !== 'text') { setState({ status: 'unknown' }); return }
            if (item.size > TEXT_PREVIEW_LIMIT) { setState({ status: 'too-big' }); return }
            const response = await fetch(objectUrl(bucket, item.key))
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const text = await response.text()
            if (alive) setState({ status: 'text', text })
          } catch (error) {
            if (alive) setState({ status: 'error', message: failureText(error) })
          }
        }
        void run()
        return () => { alive = false }
      }, [bucket, item.key])

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape' && event.isComposing !== true) onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      const body = () => {
        if (state.status === 'loading') return h('div', { className: 'ms-pv-empty' }, '載入預覽…')
        if (state.status === 'text') return h('pre', null, state.text)
        if (state.status === 'img') return h('img', { src: state.url, alt: item.name })
        if (state.status === 'too-big') return h('div', { className: 'ms-pv-empty' }, `物件過大（${fmtSize(item.size)}），請下載後查看。`)
        if (state.status === 'unknown') return h('div', { className: 'ms-pv-empty' }, `不支援預覽 .${ext} 類型，請下載。`)
        return h('div', { className: 'ms-pv-empty' }, `預覽失敗：${state.message || ''}`)
      }

      return h('div', { className: 'ms-pv-backdrop', onClick: onClose },
        h('div', { className: 'ms-pv', onClick: (event) => event.stopPropagation() },
          h('div', { className: 'ms-pv-head' },
            h('span', { className: 'ms-pv-title', title: item.key }, item.name),
            h('span', { className: 'ms-pv-sub' }, fmtSize(item.size)),
            h('button', { className: 'ms-btn', onClick: onClose }, '✕'),
          ),
          h('div', { className: 'ms-pv-body' }, body()),
          h('div', { className: 'ms-pv-foot' },
            h('span', { className: 'ms-pv-sub', style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: item.key }, item.key),
            h('button', { className: 'ms-btn primary', onClick: () => onDownload(item) }, '下載'),
          ),
        ),
      )
    }

    /**
     * 「複製設定」浮層：顯示宿主匯出的 JSON（端點／金鑰／region／預設桶），
     * 並嘗試寫進剪貼簿。
     *
     * 為什麼要先顯示再複製、而不是靜默寫入剪貼簿：這串含真實金鑰，使用者按下
     * 按鈕的當下要能看見自己複製了什麼；剪貼簿 API 被宿主擋掉時，這裡的
     * textarea 就是手動複製的退路（掛載時已全選）。
     */
    function ExportPanel(props) {
      const h = React.createElement
      const { text, copied, onCopy, onClose } = props
      const area = React.useRef(null)

      React.useEffect(() => {
        if (area.current) {
          try { area.current.focus(); area.current.select() } catch {}
        }
      }, [])

      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape' && event.isComposing !== true) onClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      return h('div', null,
        h('div', { className: 'ms-backdrop', onClick: onClose }),
        h('div', { className: 'ms-export', onClick: (event) => event.stopPropagation() },
          h('h4', null, '❗️ 連線設定（含金鑰）',
            h('span', { className: 'ms-sub', style: { fontWeight: 400 } }, copied ? '已複製到剪貼簿' : '請手動全選複製')),
          h('textarea', {
            ref: area,
            readOnly: true,
            spellCheck: false,
            value: text,
            onFocus: (event) => { try { event.target.select() } catch {} },
          }),
          h('div', { className: 'warn' }, '含有 MinIO 的存取金鑰：貼進別的工具或文件前，先確認那個地方是可信的。'),
          h('div', { className: 'ms-ask-row' },
            h('span', { className: 'spacer' }),
            h('button', { className: 'ms-btn', onClick: onClose }, '關閉'),
            h('button', { className: 'ms-btn primary', onClick: onCopy }, copied ? '再複製一次' : '複製'),
          ),
        ),
      )
    }

    /** 面板內的小對話框（新資料夾／改名／刪除確認）。 */
    function AskPanel(props) {
      const h = React.createElement
      const { ask, onCancel, onConfirm } = props
      const [value, setValue] = React.useState(ask.value || '')
      React.useEffect(() => { setValue(ask.value || '') }, [ask])

      const submit = () => {
        if (ask.kind === 'confirm') { onConfirm(''); return }
        const text = value.trim()
        if (text === '') return
        onConfirm(text)
      }

      return h('div', null,
        h('div', { className: 'ms-backdrop', onClick: onCancel }),
        h('div', { className: 'ms-ask' },
          h('h4', null, ask.title),
          ask.message ? h('div', { className: 'ms-ask-msg' }, ask.message) : null,
          ask.kind === 'confirm'
            ? null
            : h('div', { className: 'ms-ask-row' },
              h('input', {
                autoFocus: true,
                value,
                placeholder: ask.placeholder || '',
                onChange: (event) => setValue(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && event.isComposing !== true) submit()
                  if (event.key === 'Escape') onCancel()
                },
              })),
          h('div', { className: 'ms-ask-row' },
            h('span', { className: 'spacer' }),
            h('button', { className: 'ms-btn', onClick: onCancel }, '取消'),
            h('button', {
              className: 'ms-btn primary',
              onClick: submit,
              disabled: ask.kind !== 'confirm' && value.trim() === '',
            }, ask.confirmLabel || '確定'),
          ),
        ),
      )
    }

    /** conversation.view「MinIO」tab。 */
    function MinioTab(props) {
      const h = React.createElement

      const [status, setStatus] = React.useState(null)
      const [statusError, setStatusError] = React.useState(null)
      const [bucket, setBucket] = React.useState(() => {
        try { return window.localStorage.getItem(STORAGE_KEY) || '' } catch { return '' }
      })
      const [prefix, setPrefix] = React.useState('')
      const [listing, setListing] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [hint, setHint] = React.useState(null)
      const [query, setQuery] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [sel, setSel] = React.useState(() => new Set())
      const [preview, setPreview] = React.useState(null)
      const [ask, setAsk] = React.useState(null)
      const [exported, setExported] = React.useState(null) // { text, copied }：按「複製設定」才有
      const [tick, setTick] = React.useState(0)
      const fileInput = React.useRef(null)

      const say = (text) => {
        setHint(text)
        setTimeout(() => setHint((current) => (current === text ? null : current)), 4000)
      }

      const applyStatus = (payload) => {
        setStatus(payload)
        if (!payload || payload.ok === false) { setStatusError((payload && payload.error) || '無法連線'); return }
        setStatusError(null)
        // `api()` 對空 body 會回 {}：清單一律收成陣列，否則下面的 .some() 會在
        // setState 更新函式裡丟 TypeError，把整個頁籤弄垮。
        const list = Array.isArray(payload.buckets) ? payload.buckets : []
        setBucket((current) => {
          if (current && list.some((entry) => entry.name === current)) return current
          const next = payload.bucket && list.some((entry) => entry.name === payload.bucket)
            ? payload.bucket
            : (list[0] ? list[0].name : '')
          return next
        })
      }

      const loadStatus = async (force) => {
        setStatus(null)
        setStatusError(null)
        try {
          const payload = await api(force ? `${API}/refresh` : `${API}/status`, force ? { method: 'POST' } : undefined)
          applyStatus(payload)
        } catch (error) {
          setStatus({ ok: false })
          setStatusError(connectionFailureText(error))
        }
      }

      // 目錄切換很快時，先發的請求可能後到；用序號丟掉過期的回應，
      // 否則畫面會停在「上一個資料夾」的內容而看不出原因。
      const loadSeq = React.useRef(0)
      const loadListing = async (targetBucket, targetPrefix) => {
        const seq = loadSeq.current + 1
        loadSeq.current = seq
        if (!targetBucket) { setListing(null); return }
        setLoading(true)
        setError(null)
        try {
          const params = new URLSearchParams({ bucket: targetBucket, prefix: targetPrefix || '' })
          const payload = await api(`${API}/objects?${params.toString()}`)
          if (seq !== loadSeq.current) return
          setListing(payload)
          setSel(new Set())
        } catch (error) {
          if (seq !== loadSeq.current) return
          setListing(null)
          setError(failureText(error))
        } finally {
          if (seq === loadSeq.current) setLoading(false)
        }
      }

      React.useEffect(() => { void loadStatus(false) }, [])
      React.useEffect(() => {
        if (!bucket) return
        try { window.localStorage.setItem(STORAGE_KEY, bucket) } catch {}
        void loadListing(bucket, prefix)
      }, [bucket, prefix, tick])

      const reload = () => setTick((value) => value + 1)

      const currentPrefix = prefix || ''

      const crumbs = () => {
        const nodes = [h('a', { key: 'root', onClick: () => setPrefix('') }, bucket || '(未選桶)')]
        const parts = currentPrefix.split('/').filter(Boolean)
        let acc = ''
        parts.forEach((part, index) => {
          acc = acc + part + '/'
          const target = acc
          nodes.push(h('span', { key: 'sep' + index }, ' / '))
          nodes.push(h('a', { key: 'p' + index, onClick: () => setPrefix(target) }, part))
        })
        return nodes
      }

      const enter = (folderPrefix) => setPrefix(folderPrefix)
      const up = () => {
        const parts = currentPrefix.replace(/\/+$/, '').split('/').filter(Boolean)
        parts.pop()
        setPrefix(parts.length === 0 ? '' : parts.join('/') + '/')
      }

      /**
       * 下載：交給瀏覽器直接抓那個同源網址。
       *
       * 刻意不用 `fetch` + Blob：那會把整個物件放進分頁記憶體（一份 blob、再一份
       * object URL），多 GB 的物件直接把分頁弄死。這裡宿主已經送了
       * `content-disposition: attachment`，`<a download>` 會串流寫進磁碟。
       */
      const download = (item) => {
        const anchor = document.createElement('a')
        anchor.href = objectUrl(bucket, item.key)
        anchor.download = item.name
        anchor.rel = 'noopener'
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        say(`開始下載 ${item.name}`)
      }

      const removeKeys = async (keys, label) => {
        setBusy(true)
        setError(null)
        try {
          const result = await removeObjects(keys)
          if (result.failures.length > 0) {
            setError(`刪除失敗（${result.deletedKeys.length}/${keys.length} 成功）：${result.failures.map((entry) => entry.key + ' — ' + entry.error).join('；')}`)
          } else {
            say(`已刪除 ${label}${result.usedFallback > 0 ? `（${result.usedFallback} 個改用逐一刪除）` : ''}`)
          }
          reload()
        } catch (error) {
          setError(`刪除失敗：${failureText(error)}`)
        } finally {
          setBusy(false)
          setAsk(null)
        }
      }

      const createFolder = async (name) => {
        setAsk(null)
        setBusy(true)
        try {
          await api(`${API}/folder`, { json: { bucket, key: currentPrefix + name.replace(/\/+$/, '') + '/' } })
          say(`已建立資料夾 ${name}`)
          reload()
        } catch (error) {
          setError(`建立資料夾失敗：${failureText(error)}`)
        } finally {
          setBusy(false)
        }
      }

      /**
       * 刪除一批 key，並且**一定回報真的刪掉了什麼**。
       *
       * 批次刪除（`POST /delete`）在 S3 是「HTTP 200 也可能逐 key 失敗」的操作 ——
       * 回應裡的 `errors` 不是例外，`api()` 不會替我們檢查。這裡先走批次，遇到
       * 逐 key 失敗就**逐一退回 `DELETE /object`**：那個是單純的單物件刪除，簽章
       * 路徑不同（MinIO 對它寬容），所以伺服器只要有一個能通，刪除就會成功。
       *
       * 這也是「改名之後出現兩個檔案」的根因：改名＝複製＋刪除，而刪除那一步
       * 的逐 key 錯誤被當成成功了。
       *
       * @returns {{deletedKeys: string[], failures: Array<{key: string, error: string}>, usedFallback: number}}
       */
      const removeObjects = async (keys) => {
        const list = [...keys]
        if (list.length === 0) return { deletedKeys: [], failures: [], usedFallback: 0 }

        let batch = { deleted: [], errors: [] }
        try {
          batch = await api(`${API}/delete`, { json: { bucket, keys: list } })
        } catch (error) {
          // 整個批次請求失敗：全部走逐一刪除
          batch = { deleted: [], errors: list.map((key) => ({ key, code: '', message: failureText(error) })) }
        }

        const deletedKeys = [...(batch.deleted || [])]
        const failures = []
        let usedFallback = 0
        for (const entry of batch.errors || []) {
          const key = entry && entry.key ? entry.key : ''
          if (key === '') { failures.push({ key: '(未知)', error: entry.code || entry.message || '批次刪除失敗' }); continue }
          try {
            const params = new URLSearchParams({ bucket, key })
            await api(`${API}/object?${params.toString()}`, { method: 'DELETE' })
            deletedKeys.push(key)
            usedFallback += 1
          } catch (error) {
            failures.push({ key, error: failureText(error) })
          }
        }
        return { deletedKeys, failures, usedFallback }
      }

      const rename = async (item, name) => {
        setAsk(null)
        setBusy(true)
        try {
          const toKey = currentPrefix + name
          await api(`${API}/copy`, { json: { bucket, fromKey: item.key, toKey } })
          const removed = await removeObjects([item.key])
          if (removed.failures.length > 0) {
            // 複製成功、刪除失敗：不能說「已改名」，那正是使用者看到兩個檔案的原因。
            setError(`已複製為「${name}」，但原檔刪不掉（${removed.failures.map((entry) => entry.error).join('；')}）—— 現在會有兩個檔案，請再刪一次原檔。`)
            reload()
            return
          }
          say(`已改名為 ${name}`)
          reload()
        } catch (error) {
          setError(`改名失敗：${failureText(error)}`)
          reload()
        } finally {
          setBusy(false)
        }
      }

      const upload = async (files) => {
        const list = Array.from(files || [])
        if (list.length === 0) return
        setBusy(true)
        setError(null)
        let done = 0
        try {
          for (const file of list) {
            if (file.size > UPLOAD_LIMIT) throw new Error(`${file.name} 超過上傳上限 ${fmtSize(UPLOAD_LIMIT)}`)
            const params = new URLSearchParams({ bucket, key: currentPrefix + file.name })
            const response = await fetch(`${API}/object?${params.toString()}`, {
              method: 'PUT',
              headers: { 'content-type': file.type || 'application/octet-stream' },
              body: file,
            })
            const text = await response.text()
            let payload = null
            try { payload = text ? JSON.parse(text) : null } catch {}
            if (!response.ok || (payload && payload.ok === false)) {
              throw new Error((payload && payload.error) || `HTTP ${response.status}`)
            }
            done += 1
          }
          say(`已上傳 ${done} 個檔案`)
          reload()
        } catch (error) {
          setError(`上傳失敗${done > 0 ? `（已完成 ${done} 個）` : ''}：${failureText(error)}`)
          if (done > 0) reload()
        } finally {
          setBusy(false)
          if (fileInput.current) fileInput.current.value = ''
        }
      }

      /**
       * 「複製設定」：向宿主要一次端點／金鑰／region／預設桶，複製成 JSON。
       *
       * 金鑰平常不出現在畫面也不出現在任何回應裡；只有按下這個按鈕，宿主才會
       * 把它交給瀏覽器（POST /export）。拿到之後立刻嘗試寫剪貼簿，同時把內容
       * 攤在浮層上讓使用者確認。
       */
      const exportConfig = async () => {
        setBusy(true)
        setError(null)
        try {
          const payload = await api(`${API}/export`, { method: 'POST', headers: { 'x-dsh-minio-s3': 'export' } })
          const config = { ...payload }
          delete config.ok
          const text = JSON.stringify(config, null, 2)
          let copied = false
          try { await navigator.clipboard.writeText(text); copied = true } catch {}
          setExported({ text, copied })
        } catch (error) {
          // 405 = 這條路由在宿主行程裡還不存在：宿主半邊的程式碼要重啟 DSH 才會
          // 被重新載入（實測：改檔名、移除再安裝、停用再啟用都只會沿用舊模組）。
          // 直接講清楚，否則使用者只看到「HTTP 405」而不知道要重啟。
          setError(error && error.status === 405
            ? '匯出設定失敗：宿主外掛還沒重新載入，請重啟 DSH 後再試（此按鈕需要新的宿主路由）'
            : `匯出設定失敗：${failureText(error)}`)
        } finally {
          setBusy(false)
        }
      }

      const copyExport = async () => {
        if (!exported) return
        try {
          await navigator.clipboard.writeText(exported.text)
          setExported({ text: exported.text, copied: true })
          say('已複製連線設定')
        } catch {
          setExported({ text: exported.text, copied: false })
          say('剪貼簿不可用，請在框內全選複製')
        }
      }

      const copyLink = async (item) => {
        try {
          const params = new URLSearchParams({ bucket, key: item.key, expires: '3600' })
          const payload = await api(`${API}/presign?${params.toString()}`)
          await navigator.clipboard.writeText(payload.url)
          say('已複製 1 小時有效的簽章連結')
        } catch (error) {
          setError(`取得連結失敗：${failureText(error)}`)
        }
      }

      const toggle = (key) => {
        setSel((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      }

      if (statusError) {
        return h('div', { className: 'ms-root' },
          h('p', { className: 'ms-title' }, '🪣 MinIO'),
          h('div', { className: 'ms-err' }, `無法連線：${statusError}`),
          h('div', { className: 'ms-bar' }, h('button', { className: 'ms-btn primary', onClick: () => void loadStatus(true) }, '重新連線')),
        )
      }
      if (!status) return h('div', { className: 'ms-root' }, h('div', { className: 'ms-empty' }, '連線至 MinIO…'))

      const q = query.trim().toLowerCase()
      const match = (name) => !q || name.toLowerCase().includes(q)
      const folders = (listing ? listing.folders : []).filter((entry) => match(entry.name))
      const objects = (listing ? listing.objects : []).filter((entry) => match(entry.name))

      const noteText = hint
        || ((status.buckets || []).length === 0
          ? '目前沒有可用的桶（bucket）。'
          : '點檔名預覽；懸停有 預覽／下載／簽章連結／改名／刪除；勾選可批次刪除；上傳會以目前前綴為目錄。')

      const rows = []
      for (const folder of folders) {
        rows.push(h('div', { key: 'd:' + folder.prefix, className: 'ms-row' },
          h('input', {
            type: 'checkbox', className: 'ms-check', checked: sel.has(folder.prefix),
            onChange: () => toggle(folder.prefix), onClick: (event) => event.stopPropagation(),
            title: '選取以便批次刪除',
          }),
          h('span', { className: 'ms-ic' }, '📁'),
          h('span', { className: 'ms-nm dir', title: folder.prefix, onClick: () => enter(folder.prefix) }, folder.name + '/'),
          h('span', { className: 'ms-sz' }, ''),
          h('span', { className: 'ms-dt' }, ''),
          h('span', { className: 'ms-ops' },
            h('button', { onClick: () => enter(folder.prefix) }, '進入'),
            h('button', { className: 'danger', onClick: () => setAsk({ kind: 'confirm', title: '刪除資料夾', message: `刪除 ${folder.prefix}？（只會刪掉這個空目錄標記，裡面的物件請先自行刪除）`, keys: [folder.prefix], confirmLabel: '刪除' }) }, '刪除'),
          ),
        ))
      }
      for (const item of objects) {
        rows.push(h('div', { key: 'f:' + item.key, className: 'ms-row' },
          h('input', {
            type: 'checkbox', className: 'ms-check', checked: sel.has(item.key),
            onChange: () => toggle(item.key), title: '選取以便批次刪除',
          }),
          h('span', { className: 'ms-ic' }, '📄'),
          h('span', { className: 'ms-nm', title: `${item.key}（點擊預覽）`, onClick: () => setPreview(item) }, item.name),
          h('span', { className: 'ms-sz' }, fmtSize(item.size)),
          h('span', { className: 'ms-dt' }, fmtTime(item.lastModified)),
          h('span', { className: 'ms-ops' },
            h('button', { onClick: () => setPreview(item) }, '預覽'),
            h('button', { disabled: busy, onClick: () => void download(item) }, '下載'),
            h('button', { onClick: () => void copyLink(item) }, '連結'),
            h('button', { onClick: () => setAsk({ kind: 'rename', title: '改名', value: item.name, item, placeholder: '新名稱' }) }, '改名'),
            h('button', { className: 'danger', onClick: () => setAsk({ kind: 'confirm', title: '刪除物件', message: `刪除 ${item.key}？此操作無法復原。`, keys: [item.key], confirmLabel: '刪除' }) }, '刪除'),
          ),
        ))
      }

      return h('div', { className: 'ms-root' },
        // 標題只留「MinIO」：連線來源（BDD storage 端點）、region、憑證 ref
        // 一律不顯示，也不放進 DOM —— 截圖與畫面分享時不帶出內部位址。
        h('div', { className: 'ms-head' },
          h('p', { className: 'ms-title' }, '🪣 MinIO'),
        ),
        h('div', { className: 'ms-bar' },
          h('select', {
            className: 'ms-select',
            value: bucket,
            disabled: busy || loading,
            onChange: (event) => { setPrefix(''); setBucket(event.target.value) },
          }, (status.buckets || []).map((entry) => h('option', { key: entry.name, value: entry.name }, entry.name))),
          h('button', { className: 'ms-btn', disabled: busy || loading, onClick: up, title: '上一層' }, '↑ 上層'),
          h('div', { className: 'ms-cur' }, crumbs()),
          h('input', { className: 'ms-search', placeholder: '過濾名稱…', value: query, onChange: (event) => setQuery(event.target.value) }),
          h('button', { className: 'ms-btn', disabled: busy || loading, onClick: reload }, '重新整理'),
          h('button', { className: 'ms-btn', disabled: busy || loading, onClick: () => setAsk({ kind: 'folder', title: '新資料夾', placeholder: '資料夾名稱', value: '' }) }, '新資料夾'),
          h('button', { className: 'ms-btn primary', disabled: busy || loading, onClick: () => { if (fileInput.current) fileInput.current.click() } }, busy ? '處理中…' : '上傳'),
          h('input', {
            ref: fileInput, type: 'file', multiple: true, style: { display: 'none' },
            onChange: (event) => void upload(event.target.files),
          }),
          h('button', { className: 'ms-btn', disabled: busy, onClick: () => void loadStatus(true), title: '重新取得連線' }, '重連'),
          h('button', {
            className: 'ms-btn',
            disabled: busy,
            title: '把端點／金鑰／region／預設桶複製成 JSON（含金鑰，平常不顯示）',
            onClick: () => void exportConfig(),
          }, '❗️ 複製設定'),
        ),
        sel.size > 0 && h('div', { className: 'ms-selbar' },
          h('span', null, `已選 ${sel.size} 項`),
          h('button', {
            className: 'ms-btn', disabled: busy,
            style: { color: 'var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary))' },
            onClick: () => setAsk({ kind: 'confirm', title: '批次刪除', message: `刪除 ${sel.size} 個項目？此操作無法復原。`, keys: [...sel], confirmLabel: '刪除' }),
          }, '刪除選取'),
          h('button', { className: 'ms-btn', disabled: busy, onClick: () => setSel(new Set()) }, '取消選取'),
          h('span', { className: 'spacer' }),
        ),
        h('div', { className: 'ms-body' },
          error && h('div', { className: 'ms-err' }, error),
          // 宿主半邊的程式碼在行程內只載入一次，改完要重啟 DSH 才會生效。舊模組的
          // 徵兆是 /status 沒有 version：那時批次刪除會被伺服器逐 key 拒絕、簽章
          // 連結也會失敗，所以直接告訴使用者「現在是降級模式、重啟才會恢復」。
          status.ok === true && !status.version && h('div', { className: 'ms-warn' },
            '⚠️ 宿主外掛還是舊版（改完程式碼後未重啟 DSH）：刪除會改用逐一刪除、簽章連結與「複製設定」會失敗；重啟 DSH 後恢復正常。'),
          !error && (status.buckets || []).length === 0 && h('div', { className: 'ms-empty' }, '這個 MinIO 上沒有可用的桶。'),
          !error && !bucket && (status.buckets || []).length > 0 && h('div', { className: 'ms-empty' }, '請先選一個桶。'),
          !error && loading && !listing && h('div', { className: 'ms-empty' }, '載入物件…'),
          !error && listing && rows.length === 0 && h('div', { className: 'ms-empty' }, q ? '無符合的項目' : '（空目錄）'),
          listing && listing.truncated && h('div', { className: 'ms-trunc' }, `已截斷顯示（超過一頁），請用前綴或過濾縮小範圍。nextToken：${listing.nextToken ? '有' : '無'}`),
          rows,
        ),
        h('div', { className: 'ms-note' }, noteText),
        exported && h(ExportPanel, {
          text: exported.text,
          copied: exported.copied,
          onCopy: () => void copyExport(),
          onClose: () => setExported(null),
        }),
        ask && h(AskPanel, {
          ask,
          onCancel: () => setAsk(null),
          onConfirm: (value) => {
            if (ask.kind === 'folder') void createFolder(value)
            else if (ask.kind === 'rename') void rename(ask.item, value)
            else if (ask.kind === 'confirm') void removeKeys(ask.keys, `${ask.keys.length} 個項目`)
          },
        }),
        preview && h(PreviewOverlay, {
          bucket,
          item: preview,
          onClose: () => setPreview(null),
          onDownload: (item) => void download(item),
        }),
      )
    }

    module.exports = {
      name: 'dsh-minio-s3',
      inject: ['slots'],

      apply(ctx) {
        const slots = ctx.get('slots')
        if (slots === undefined) return
        if (typeof slots.inject !== 'function') return

        slots.inject('conversation.view', () => slots.register(
          { name: 'conversation.view', id: 'dsh-minio-s3', order: 28, label: () => 'MinIO' },
          (props) => React.createElement(MinioTab, props),
        ))
      },
    }

    return module.exports
  }
})
