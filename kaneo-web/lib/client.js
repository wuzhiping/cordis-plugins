// =============================================================================
// kaneo-web —— 瀏覽器半邊（Client half）
//
// 這個檔案是**靜態** client plugin（package.json 的 `dsh.client.platform: "web"`
// 加上 `./client` export），不是動態 Package，所以 window / document / React
// 都是普通全域，沒有動態半邊的限制。
//
// 它做三件事：
//
//   1. `sidebar.panellist` —— 側邊欄一顆圖示（點一下切到本面板）。
//   2. `main`（key = kaneo-web）—— 面板本體：一個 iframe。
//   3. 未設定 API Key 時，在面板裡顯示一張設定表；使用者輸入後 POST 給宿主，
//      宿主存起來並回報「可以載入的完整網址」。
//
// 刻意**不在這裡出現的東西**（使用者明確要求）：
//
//   * 服務網域與登入路徑：一個字都沒有。位址由宿主組好才送過來。
//   * 產品名：介面上不出現「Kaneo」，它就是「管線看板」。
//   * API Key 的持久儲存：瀏覽器只在按下儲存的那一刻 POST 上去，不寫
//     localStorage、不寫 cookie、不放進任何 URL、也不留在 React state 之外。
//
// iframe 是 module 級單例：切到別的側邊欄面板時它被「停放」到畫面外而不是
// 銷毀，切回來時原樣搬回去 —— 那個應用是 SPA，路由狀態在記憶體裡，重掛載會
// 把它清掉。停用外掛時由 ctx.effect 的 disposer 真正移除。
// =============================================================================
window.__ModuleLoader__.load({
  id: 'kaneo-web',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /** 面板座位 id：`sidebar.panellist` 的 id 與 `main` 的 key 必須一致。 */
    const PANEL_ID = 'kaneo-web';
    /** 側邊欄圖示的排序（放在既有入口之後）。 */
    const PANEL_ORDER = 60;
    /** 宿主查詢／設定路由。 */
    const CONFIG_URL = '/plugins/kaneo-web/config';
    /** 宿主「從遠端取回設定」路由（遮蔽金鑰與遠端位址都留在宿主）。 */
    const RESTORE_URL = '/plugins/kaneo-web/restore';
    /** 宿主「重置管線設定」路由（金鑰與路徑一起收回初始狀態）。 */
    const RESET_URL = '/plugins/kaneo-web/reset';
    /** iframe 的無障礙標題（介面上不出現產品名）。 */
    const FRAME_TITLE = '工作區';
    /** 載入超過這麼久還沒好，就提示可能被擋掉。 */
    const SLOW_MS = 10000;
    /**
     * 進入面板時的倒數秒數：這段時間**不建立 iframe、也不打任何請求**，
     * 給使用者一個「點一下就打斷登入、直接進設定」的窗口。
     */
    const PRELOAD_SECONDS = 3;
    /**
     * 是否改用「在新分頁開啟」取代 iframe。
     *
     * 預設：**Tauri / Electron → true（新分頁）**；**Chrome / Edge 桌面版 → false（iframe）**。
     *
     * 判斷：依序檢查（任一命中即視為 embedded webview）
     *   1. `window.__TAURI_INTERNALS__`（Tauri 2）— 最可靠
     *   2. `window.__TAURI_IPC__`（Tauri 1）
     *   3. userAgent 含 `Tauri/` 或 `Electron/`（Tauri 2 dev 模式、Electron 桌面 app）
     *   否則 `false`（iframe 路徑）。
     *
     * 之後可被 host 的 `mode` 設定、面板內的「開啟工作區的方式」toggle 覆蓋。
     */
    const OPEN_IN_NEW_WINDOW = (function () {
      if (typeof window === 'undefined') return false;
      if (window.__TAURI_INTERNALS__ || window.__TAURI_IPC__) return true;
      if (typeof navigator === 'undefined') return false;
      const ua = navigator.userAgent || '';
      return /Tauri\/|Electron\//i.test(ua);
    })();
    /** 倒數動畫的更新間隔（毫秒）。20fps 就足夠平滑，又不會太吵。 */
    const PRELOAD_TICK_MS = 50;
    /** 進度環的半徑與圓周（viewBox 是 48×48，圓心 24,24）。 */
    const RING_RADIUS = 20;
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
    /** 瀏覽器上一次看到的路徑（非機密，只有路徑；金鑰永不進瀏覽器儲存）。 */
    const LAST_PATH_KEY = 'kaneo-web.lastPath';
    /**
     * 使用者選過的「開啟工作區的方式」（`newtab` / `iframe`）。
     *
     * 這是**非機密的 UI 偏好**，不是設定本身 —— 正式來源仍然是宿主的 `mode`。
     * 存在這裡的理由：宿主的舊版本（或未來哪天又漏回 `mode` 欄位）不會回這個值，
     * 那時面板就會掉回自動偵測的預設值，使用者「明明切過、重開又跳回去」。
     * 有了這一層，即使宿主沉默，使用者的選擇也留得住。
     * 讀取順序：宿主有回 → 用宿主的；宿主沉默 → 用這裡；都沒有 → 自動偵測。
     */
    const MODE_KEY = 'kaneo-web.mode';
    /** Locale namespace。 */
    const NS = 'kaneo-web';

    // =====================================================================
    // 文案
    //
    // 兩個刻意的選擇：
    //
    //   1. **繁體中文**（不是簡體）—— 這個外掛的介面照使用者指定走繁體。
    //      同時註冊 `zh` 與 `zh-TW`：`zh` 是這個 harness 一定有的語系鍵
    //      （`locale.preference` 只認 `zh`/`en`），`zh-TW` 則是
    //      `zhtw-traditional-chinese` 這個語言包發布的 id；兩個都給，
    //      不管使用者選哪一個都拿到繁體。
    //   2. **介面上不出現「Kaneo」這個字**。服務網域、路徑、產品名都只留在
    //      宿主半邊。
    // =====================================================================
    const zh = {
      'panel.title': '管線看板',
      'setup.heading': '先設定 API Key',
      'setup.hint': 'API Key 只存在這台機器的宿主端，不會寫進瀏覽器儲存，也不會顯示在介面上。',
      'field.apiKey': 'API Key',
      'field.apiKeyPlaceholder': '貼上你的 API Key',
      'field.redirect': '登入後開啟的路徑',
      'field.redirectHint': '站內路徑，預設 /dashboard',
      'action.save': '儲存並載入',
      'action.saving': '儲存中…',
      'action.cancel': '取消',
      'action.clear': '清除已儲存的金鑰',
      'action.settings': '設定',
      'action.reload': '重新整理',
      'action.retry': '重試',
      'action.restore': '從遠端取回設定',
      'action.restoring': '取回中…',
      'action.reset': '重置管線設定',
      'action.resetConfirm': '確定重置',
      'action.resetting': '重置中…',
      'reset.hint': '把 API Key 與登入路徑一起清掉，回到初始狀態（下一次開啟要重新設定）。',
      'reset.done': '已重置：API Key 與路徑都回到初始狀態。',
      'reset.confirmHint': '重置會清掉已儲存的 API Key 與路徑，確定嗎？',
      'action.interrupt': '打斷登入，先設定',
      'preload.title': '即將載入工作區…',
      'preload.hint': '不想現在登入？在倒數結束前按一下，就會停下來讓你設定 API Key 與路徑。',
      'restore.hint': '用這台機器上已存的遮蔽金鑰，向遠端儲存端點換回 API Key（金鑰原文不出本機）。',
      'restore.none': '遠端沒有回傳可用的 API Key',
      'restore.pick': '遠端回傳了這些候選值，點一個帶進上面的欄位：',
      'restore.raw': '遠端原始回應：',
      'check.ok': '遠端金鑰可以登入（登入端點回 302）。',
      'check.invalid': '遠端金鑰被拒絕（401 INVALID_API_KEY）—— 這把金鑰不屬於這個實例，請改填自己建立的 API Key。',
      'check.forbidden': '遠端金鑰被拒絕（403）—— 帶權限範圍的金鑰不能換工作階段，或該部署只允許管理員使用。',
      'check.not-enabled': '這個部署沒有開啟 API Key 登入（端點回 404）。',
      'check.rate-limited': '登入端點限流（429）—— 等一下再試，或改用自己建立的 API Key。',
      'check.unknown': '無法判斷遠端金鑰是否可用。',
      'state.loading': '正在載入…',
      'state.slow':
        '一直空白？這個頁面可能不允許被 iframe 嵌入（X-Frame-Options / frame-ancestors），' +
        '或者 API Key 尚未生效。可以按「重新整理」再試一次。',
      'frame.probing': '正在量測這個 iframe 的載入狀況…',
      'frame.requests': '已送出 {n} 個請求（最近一個 {last} 毫秒前）',
      'frame.noRequests': '這個 iframe 連一個請求都沒送出去',
      'frame.diag':
        '一直空白？可能的原因（依常見程度）：' +
        '① 登入沒有生效 —— 會話 cookie 是 SameSite=Lax，在跨站 iframe 裡可能不被接受；' +
        '② 這個頁面用 X-Frame-Options / frame-ancestors 擋了嵌入；' +
        '③ 那個位址本身回的內容不是可顯示的頁面。' +
        '上面兩行是實測到的載入狀況，先看它有沒有送出請求。',
      'action.forceShow': '仍然顯示',
      'action.diagnose': '量測載入狀況',
      'action.openNewTab': '在新分頁開啟工作區',
      'action.opened': '已開啟，關閉此分頁',
      'action.copy': '複製網址',
      'newtab.heading': '在新分頁開啟工作區',
      'newtab.explain': '該站台不允許 iframe 嵌入（推測是 SameSite cookie 限制），' +
        '所以用「在新分頁開啟連結」取代。新分頁登入後，你照常用它；金鑰仍在這台機器上，' +
        '下次想換設定就回來按「⚙ 設定」。',
      'newtab.urlLabel': '要開啟的網址',
      'newtab.urlHelp': '這是登入用的單次連結，沒有狀態可以重看，按下「在新分頁開啟」即可。',
      'newtab.context': '登入後要開啟的路徑：',
      'newtab.openedHint': '已送出開啟請求。若新分頁沒出現，請用左邊「複製網址」自己貼到瀏覽器開啟。',
      'mode.heading': '開啟工作區的方式',
      'mode.newtab': '在新分頁開啟（建議）',
      'mode.newtabHint': '登入會在頂層分頁生效（同站 cookie 不受限）。iframe 嵌入被擋時用這個。',
      'mode.iframe': '在 iframe 內嵌（原始方式）',
      'mode.iframeHint': '如果該站台沒擋 iframe，iframe 可以保留 SPA 狀態（切面板不重整）。',
      'mode.switching': '切換中…',
      'error.title': '載入失敗',
      'error.bridge': '無法與宿主連線（查詢路由沒有回應）。這個組合可能沒有掛載 web server。',
      'settings.heading': '更新設定',
      'settings.hint': '留空 API Key 就直接關閉這個視窗，不會清掉已儲存的金鑰。'
    };
    const en = {
      'panel.title': 'Workspace board',
      'setup.heading': 'Set up the API key',
      'setup.hint':
        'The key is stored on the host only. It is never kept in browser storage and never appears in this UI.',
      'field.apiKey': 'API key',
      'field.apiKeyPlaceholder': 'Paste your API key',
      'field.redirect': 'Path to open after logging in',
      'field.redirectHint': 'A site-relative path; default /dashboard',
      'action.save': 'Save and load',
      'action.saving': 'Saving…',
      'action.cancel': 'Cancel',
      'action.clear': 'Forget the stored key',
      'action.settings': 'Settings',
      'action.reload': 'Reload',
      'action.retry': 'Retry',
      'action.restore': 'Fetch from remote store',
      'action.restoring': 'Fetching…',
      'action.reset': 'Reset pipeline settings',
      'action.resetConfirm': 'Confirm reset',
      'action.resetting': 'Resetting…',
      'reset.hint': 'Clears the API key and the login path and returns to the initial state.',
      'reset.done': 'Reset: the API key and the path are back to their initial state.',
      'reset.confirmHint': 'A reset clears the stored API key and path. Continue?',
      'action.interrupt': 'Stop and configure',
      'preload.title': 'Loading the workspace…',
      'preload.hint': 'Do not want to log in now? Click before the countdown ends to stop and set the API key and path.',
      'restore.hint': 'Exchanges the masked key already stored on this machine for an API key (the raw key never leaves the host).',
      'restore.none': 'The remote returned no usable API key',
      'restore.pick': 'The remote returned these candidates — click one to fill the field above:',
      'restore.raw': 'Raw remote response:',
      'check.ok': 'The remote key can log in (the endpoint answered 302).',
      'check.invalid': 'The remote key was rejected (401 INVALID_API_KEY) — it does not belong to this instance; paste a key you created yourself.',
      'check.forbidden': 'The remote key was refused (403) — a scoped key cannot be exchanged for a session, or this deployment allows administrators only.',
      'check.not-enabled': 'This deployment does not enable key-based log in (the endpoint answered 404).',
      'check.rate-limited': 'The log-in endpoint is rate limited (429) — retry shortly, or use a key you created yourself.',
      'check.unknown': 'Could not tell whether the remote key works.',
      'state.loading': 'Loading…',
      'state.slow':
        'Still blank? The page may refuse to be framed (X-Frame-Options / frame-ancestors), ' +
        'or the API key is not in effect yet. Try “Reload”.',
      'frame.probing': 'Measuring what this iframe actually loaded…',
      'frame.requests': '{n} requests went out (the last one {last} ms ago)',
      'frame.noRequests': 'this iframe has not sent a single request',
      'frame.diag':
        'Still blank? Most likely causes, in order: ' +
        '(1) the login did not take effect — the session cookie is SameSite=Lax and may be refused in a cross-site iframe; ' +
        '(2) the page blocks framing via X-Frame-Options / frame-ancestors; ' +
        '(3) the address returned something that is not a displayable page. ' +
        'The two lines above are the measured load state — start there.',
      'action.forceShow': 'Show anyway',
      'action.diagnose': 'Measure the load',
      'action.openNewTab': 'Open the workspace in a new tab',
      'action.opened': 'Opened, you can close this tab',
      'action.copy': 'Copy URL',
      'newtab.heading': 'Open the workspace in a new tab',
      'newtab.explain': 'This site does not allow iframe embedding (most likely a SameSite cookie restriction), so we open the entry link in a new tab instead. The API key stays on this machine, so come back here any time to change it.',
      'newtab.urlLabel': 'URL to open',
      'newtab.urlHelp': 'The entry link is single-use. Press the button to open it in a new tab.',
      'newtab.context': 'Path to open after entry: ',
      'newtab.openedHint': 'Open request sent. If no new tab appeared, use "Copy URL" on the left and paste it into your browser.',
      'mode.heading': 'How to open the workspace',
      'mode.newtab': 'Open in a new tab (recommended)',
      'mode.newtabHint': 'Sign-in happens at top level (SameSite cookies are accepted). Use this when iframe embedding is blocked.',
      'mode.iframe': 'Embed in an iframe (original)',
      'mode.iframeHint': 'If the site does not block iframes, the iframe keeps the SPA state across sidebar switches.',
      'mode.switching': 'Switching…',
      'error.title': 'Could not load',
      'error.bridge': 'No answer from the host (the query route did not respond). This composition may not mount a web server.',
      'settings.heading': 'Update settings',
      'settings.hint': 'Leave the key empty and just close this panel: a stored key is never cleared here.'
    };

    /** 座位沒給 `t` 時的退路（以繁體為準）。 */
    function fallbackT(key) {
      if (zh[key] !== undefined) return zh[key];
      return en[key] !== undefined ? en[key] : key;
    }

    // =====================================================================
    // 樣式：全部走主題 token，深淺色都跟著宿主走
    // =====================================================================
    const STYLE_ID = 'dsh-kaneo-web-style';
    const CSS = [
      // 與同層的工作面板一致：height:100% + min-height:0，讓 iframe 拿到真正的高度。
      '.kw-root{box-sizing:border-box;display:flex;flex-direction:column;' +
        'height:100%;min-height:0;flex:1 1 auto;' +
        'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}',

      // 置中卡片（設定表 / 錯誤 / 載入）
      '.kw-center{flex:1 1 auto;min-height:0;display:flex;align-items:center;' +
        'justify-content:center;padding:24px;overflow:auto}',
      // 設定表容器：寬度 420 → 630（+50%），容納「開啟工作區的方式」兩張並排卡
      // 與長 redirect 輸入框不擠。
      '.kw-card{width:100%;max-width:630px;box-sizing:border-box;display:flex;' +
        'flex-direction:column;gap:12px;padding:20px;border-radius:14px;' +
        'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
      '.kw-h{font-size:15px;line-height:22px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.kw-p{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}',
      '.kw-p-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.kw-p-error{color:var(--dsw-alias-state-error-primary)}',
      '.kw-field{display:flex;flex-direction:column;gap:4px}',
      '.kw-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.kw-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);opacity:.85}',
      '.kw-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;font:inherit;' +
        'font-size:13px;border-radius:8px;color:var(--dsw-alias-label-primary);' +
        'background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l2);' +
        'outline:none}',
      '.kw-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.kw-row{display:flex;align-items:center;gap:8px;justify-content:flex-end}',
      '.kw-row-start{justify-content:flex-start}',

      // 「從遠端取回設定」區塊
      '.kw-restore{display:flex;flex-direction:column;gap:6px;padding-top:4px;' +
        'border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.kw-cands{display:flex;flex-direction:column;gap:4px;align-items:flex-start}',
      '.kw-cand{font-size:12px;height:26px;max-width:100%;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap}',

      // 重置區塊
      '.kw-reset{display:flex;flex-direction:column;gap:6px;padding-top:4px;' +
        'border-top:.5px solid var(--dsw-alias-border-l1)}',
      // 設定浮層的寬度：420 → 630（與 .kw-card 同步）。
      '.kw-stack{display:flex;flex-direction:column;gap:8px;width:100%;max-width:630px}',
      '.kw-p-ok{color:var(--dsw-alias-state-success-primary)}',

      // 進面板時的倒數窗口（整塊可點 = 打斷登入）
      '.kw-overlay-click{cursor:pointer}',
      '.kw-overlay-click:hover{background:var(--dsw-alias-bg-layer-1)}',
      // 進度環 + 秒數：外圈是整圈，內圈每秒縮一圈（transform 動畫，50ms 一次更新）。
      '.kw-count{position:relative;width:96px;height:96px;margin-bottom:2px}',
      '.kw-ring{width:96px;height:96px;transform:rotate(-90deg);display:block}',
      '.kw-ring-track{fill:none;stroke:var(--dsw-alias-border-l2);stroke-width:3}',
      '.kw-ring-fill{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:3;' +
        'stroke-linecap:round;transform-origin:24px 24px;' +
        'transition:transform ' + PRELOAD_TICK_MS + 'ms linear}',
      '.kw-count-num{position:absolute;inset:0;display:flex;align-items:center;' +
        'justify-content:center;font-size:34px;line-height:1;font-weight:600;' +
        'font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary)}',
      // 載不出來時的診斷卡（iframe 跨來源，父頁面只能從資源時序反推）
      '.kw-diag{display:flex;flex-direction:column;gap:10px;align-items:center;' +
        'max-width:460px;text-align:left}',
      '.kw-diag .kw-h{align-self:center;text-align:center}',
      // 「在新分頁開啟」卡：站內不允許 iframe 嵌入時的暫時替代方案。
      '.kw-newtab{max-width:540px;align-items:stretch;display:flex;flex-direction:column;gap:12px}',
      '.kw-newtab .kw-url{font-family:ui-monospace,Menlo,Consolas,monospace;' +
        'font-size:11px;line-height:1.45;resize:vertical;min-height:auto;' +
        'white-space:pre;word-break:break-all;cursor:text}',
      // 模式切換器（兩個並排的卡）
      '.kw-mode{display:flex;flex-direction:column;gap:6px;padding-top:4px;' +
        'border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.kw-mode-row{display:flex;gap:6px;width:100%}',
      '.kw-mode-card{flex:1;display:flex;flex-direction:column;gap:4px;align-items:flex-start;' +
        'padding:8px 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);' +
        'background:var(--dsw-alias-bg-base);cursor:pointer;text-align:left}',
      '.kw-mode-card:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.kw-mode-card[disabled]{opacity:.6;cursor:default}',
      '.kw-mode-card-on{border-color:var(--dsw-alias-brand-primary);' +
        'background:var(--dsw-alias-bg-layer-1)}',
      '.kw-mode-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',

      // 按鈕：主按鈕用品牌色，次按鈕透明
      '.kw-btn{display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 14px;' +
        'font:inherit;font-size:13px;border-radius:24px;border:.5px solid transparent;cursor:pointer}',
      '.kw-btn-primary{background:var(--dsw-alias-brand-primary);' +
        'color:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-brand-primary)}',
      '.kw-btn-primary[disabled]{opacity:.5;cursor:default}',
      '.kw-btn-ghost{background:0 0;color:var(--dsw-alias-label-secondary);' +
        'border-color:var(--dsw-alias-border-l1)}',
      '.kw-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);' +
        'color:var(--dsw-alias-label-primary)}',

      // iframe 區
      '.kw-frameWrap{position:relative;flex:1 1 auto;min-height:0;overflow:hidden;' +
        'background:var(--dsw-alias-bg-base)}',
      '.kw-frameHost{position:absolute;inset:0;display:block;overflow:hidden}',
      '.kw-frame{width:100%;height:100%;border:0;background:var(--dsw-alias-bg-base)}',
      '.kw-overlay{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;' +
        'align-items:center;justify-content:center;padding:24px;text-align:center;' +
        'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);' +
        'font-size:13px;line-height:20px}',

      // 底部工具列
      '.kw-bar{flex:none;display:flex;align-items:center;gap:4px;padding:2px 8px;' +
        'border-top:.5px solid var(--dsw-alias-border-l1);' +
        'background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}',
      '.kw-bar-spacer{flex:1 1 auto}',
      '.kw-chip{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;' +
        'font:inherit;font-size:12px;border-radius:24px;border:none;background:0 0;' +
        'color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.kw-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',

      // 設定浮層
      '.kw-sheet{position:absolute;inset:0;z-index:2;display:flex;align-items:center;' +
        'justify-content:center;padding:24px;background:var(--dsw-alias-bg-overlay)}'
    ].join('');

    /** 裝一次樣式表；disposer 隨外掛卸下時移除。 */
    function installStyles() {
      if (typeof document === 'undefined') return function () {};
      if (document.getElementById(STYLE_ID) !== null) return function () {};
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
      return function () {
        if (style.parentNode !== null && style.parentNode !== undefined) {
          style.parentNode.removeChild(style);
        }
      };
    }

    /** 側邊欄圖示（沿用宿主的 24px 網格）。 */
    function Glyph(props) {
      const size = props !== null && props !== undefined && props.size ? props.size : 16;
      const active = props !== null && props !== undefined && props.active === true;
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          'aria-hidden': true,
          style: { display: 'block' },
          onClick: props !== null && props !== undefined ? props.onClick : undefined
        },
        h('rect', {
          x: 3, y: 3.5, width: 18, height: 17, rx: 3,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.6
        }),
        h('path', {
          d: 'M3.5 9h17',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6
        }),
        h('path', {
          d: 'M8.5 13.5l2 2 4-4',
          fill: 'none',
          stroke: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round'
        })
      );
    }

    // =====================================================================
    // 常駐 iframe：切面板不重新載入
    // =====================================================================
    /** 畫面外的停放區，讓 iframe 的文件在「被切走」時繼續活著。 */
    let keeper = null;
    /** 唯一一個 iframe，第一次需要時才建立。 */
    let frame = null;
    /** 目前掛在這個 iframe 上的網址（換金鑰時才會變）。 */
    let frameUrl = null;
    /** 第一次 load 是否已經發生過（跨重掛載保留）。 */
    let frameLoaded = false;
    /**
     * 這次瀏覽階段還有沒有「進入面板先倒數 3 秒」這件事要做。
     *
     * 一旦 iframe 真的載入過（或被使用者打斷）就關掉：之後切來切去都直接顯示
     * 既有 iframe，不會每次都多等 3 秒。頁面重新整理後會回到 true。
     */
    let preloadArmed = true;
    /** 倒數的起點（毫秒）。module 級 —— 重畫不會讓倒數倒退。 */
    let preloadStartedAt = 0;

    /**
     * 取這次倒數的起點；第一次呼叫時就定住，之後都回同一刻。
     *
     * @returns 起始時間戳（毫秒）。
     */
    function getPreloadStart() {
      if (preloadStartedAt === 0) preloadStartedAt = Date.now();
      return preloadStartedAt;
    }

    /**
     * 倒數動畫的進度：剩餘比例（1 → 0）與顯示用秒數（整數，最少 1）。
     *
     * 抽成純函式只為了可測 —— 動畫的關鍵數字（環縮到多小、顯示幾秒）不該只能
     * 靠「跑三秒然後肉眼看著」來驗。
     *
     * @param startedAt - 倒數起點（毫秒）。
     * @param now - 現在（毫秒）。
     * @param totalMs - 總時長（毫秒）；預設 PRELOAD_SECONDS 秒。
     * @returns `{ fraction, seconds }`。
     */
    function preloadProgress(startedAt, now, totalMs) {
      const total = typeof totalMs === 'number' && totalMs > 0 ? totalMs : PRELOAD_SECONDS * 1000;
      const elapsed = Math.max(0, now - startedAt);
      const left = Math.max(0, total - elapsed);
      return {
        fraction: left / total,
        seconds: Math.max(1, Math.ceil(left / 1000))
      };
    }

    /** 建立單例 iframe 與停放區；重複呼叫沒有副作用。 */
    function ensureFrame() {
      if (frame !== null) return frame;
      if (typeof document === 'undefined') throw new Error('kaneo-web: no document');
      const el = document.createElement('iframe');
      el.className = 'kw-frame';
      el.title = FRAME_TITLE;
      el.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write');
      el.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');

      keeper = document.createElement('div');
      keeper.setAttribute('aria-hidden', 'true');
      keeper.setAttribute('data-dsh-kaneo-web', 'parked');
      // visibility:hidden（不是 display:none）—— 文件要繼續跑。
      keeper.style.cssText =
        'position:fixed;left:-20000px;top:0;width:1280px;height:900px;' +
        'visibility:hidden;pointer-events:none;';
      keeper.appendChild(el);
      document.body.appendChild(keeper);

      frame = el;
      return frame;
    }

    /** 把 iframe 停回畫面外（unmount 路徑）。 */
    function parkFrame() {
      if (frame === null || keeper === null) return;
      if (frame.parentNode === keeper) return;
      try {
        keeper.appendChild(frame);
      } catch (err) {
        // 停放失敗只是下次要重新載入，不是錯誤。
      }
    }

    /** 真正移除 iframe 與停放區（外掛卸下時）。 */
    function destroyFrame() {
      if (frame !== null) {
        try {
          if (frame.parentNode !== null && frame.parentNode !== undefined) {
            frame.parentNode.removeChild(frame);
          }
        } catch (err) { /* 已經被移除就算了 */ }
      }
      if (keeper !== null) {
        try {
          if (keeper.parentNode !== null && keeper.parentNode !== undefined) {
            keeper.parentNode.removeChild(keeper);
          }
        } catch (err) { /* 同上 */ }
      }
      frame = null;
      keeper = null;
      frameUrl = null;
      frameLoaded = false;
    }

    /** 換網址（金鑰或路徑變了才需要）。 */
    function navigateFrame(url) {
      const el = ensureFrame();
      if (url !== frameUrl) {
        el.src = url;
        frameUrl = url;
        frameLoaded = false;
      }
      return el;
    }

    /**
     * 只接受站內絕對路徑（`/` 開頭、第二個字元不是 `/`、不含 `://`）。
     *
     * 這是為了**不讓存在瀏覽器裡的東西變成開放轉址**：就算有人手改 localStorage，
     * 也不可能把登入導到別的站。宿主端還有一道同樣的檢查。
     *
     * @param value - 任意值。
     * @returns 合法路徑，或 null。
     */
    function safeSitePath(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      if (text === '' || text.length > 512) return null;
      if (text.charAt(0) !== '/' || text.charAt(1) === '/') return null;
      if (text.indexOf('://') !== -1) return null;
      if (/[\s\\]/.test(text)) return null;
      return text;
    }

    /** 讀「上次看到哪一頁」；讀不到（沒有 localStorage／被隱私設定擋）就回 null。 */
    function readLastPath() {
      try {
        if (typeof localStorage === 'undefined') return null;
        return safeSitePath(localStorage.getItem(LAST_PATH_KEY));
      } catch (err) {
        return null;
      }
    }

    /**
     * 讀使用者上次選的開啟方式；讀不到或值不合法就回 null（讓上層走自動偵測）。
     *
     * 一定要驗形狀：瀏覽器儲存可能被手改或外掛亂寫，只接受兩個合法值。
     *
     * @returns `'newtab' | 'iframe' | null`。
     */
    function readStoredMode() {
      try {
        if (typeof localStorage === 'undefined') return null;
        const value = localStorage.getItem(MODE_KEY);
        return value === 'iframe' || value === 'newtab' ? value : null;
      } catch (err) {
        return null;
      }
    }

    /**
     * 記住使用者選的開啟方式（非機密 UI 偏好；金鑰永不進瀏覽器儲存）。
     *
     * @param value - `'newtab'` 或 `'iframe'`。
     */
    function persistStoredMode(value) {
      if (value !== 'iframe' && value !== 'newtab') return;
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(MODE_KEY, value);
      } catch (err) {
        // 寫不進去（無痕、被擋）不影響功能：只是下次重開會回到自動偵測。
      }
    }

    /**
     * 記住 iframe 目前停在哪一頁。
     *
     * 為什麼要這一步：iframe 不可能跨頁面存活（它活在文件裡），所以整頁重整後
     * 一定要重新登入一次。但**重新登入可以回到原本那一頁** —— 這就是這一小段
     * 記憶的用途：把「重整 → 回到 /dashboard」變成「重整 → 回到你剛才在看的那頁」。
     *
     * 存進瀏覽器的只有**路徑**（非機密）；金鑰永遠不進瀏覽器儲存。
     *
     * @param el - 目前那個 iframe。
     */
    function persistFramePath(el) {
      try {
        if (typeof localStorage === 'undefined') return;
        const location = el.contentWindow ? el.contentWindow.location : null;
        // 跨來源時讀 location 會拋；那就靜靜放弃（路徑記憶是加分項，不是必要條件）。
        if (!location || typeof location.pathname !== 'string') return;
        const path = safeSitePath(location.pathname + (location.search || ''));
        if (path === null) return;
        // 還沒真的進站（例如停在未登入的首頁）就不記，免得以後一直回到那裡。
        if (path === '/' || path === '/login' || path === '/auth') return;
        localStorage.setItem(LAST_PATH_KEY, path);
      } catch (err) {
        // 讀不到（跨來源、被拒）就當作沒有這回事。
      }
    }

    /** 用同一個網址再走一次導覽（跨來源時 contentWindow.location.reload() 會拋）。 */
    function reloadFrame() {
      if (frame === null || frameUrl === null) return;
      frame.src = frameUrl;
      frameLoaded = false;
    }

    // =====================================================================
    // 宿主通道
    // =====================================================================
    /**
     * 讀宿主目前的設定狀態。
     *
     * @param redirect - 想用的站內路徑（例如「上次那一頁」）；空字串代表用宿主的預設。
     *   宿主只把它用在**這次回應**組出來的網址上，不會寫進設定。
     * @returns Promise<{ ok, configured, redirect, url, error? }>。
     */
    async function fetchStatus(redirect) {
      try {
        const wanted = safeSitePath(redirect);
        const query = wanted === null ? '' : '?redirect=' + encodeURIComponent(wanted);
        const response = await fetch(CONFIG_URL + query, {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload === null || typeof payload !== 'object') {
          return {
            ok: false,
            configured: false,
            error: 'HTTP ' + response.status
          };
        }
        return {
          ok: payload.ok === true,
          configured: payload.configured === true,
          redirect: typeof payload.redirect === 'string' ? payload.redirect : '',
          url: typeof payload.url === 'string' ? payload.url : null,
          // host **沒回** `mode` 時回 `undefined` —— 這時 `refresh()` 不會動 `mode`，
          // 初始值（由 `OPEN_IN_NEW_WINDOW` 決定：現在 `false` → `iframe` 路徑）
          // 保持有效，使用者點開面板就會看到倒數的環。
          // （之前誤把 fallback 寫成 `'newtab'`，結果覆蓋了初始值 —— 已修。）
          mode: payload.mode === 'iframe' || payload.mode === 'newtab' ? payload.mode : undefined,
          error: typeof payload.error === 'string' ? payload.error : undefined
        };
      } catch (err) {
        return {
          ok: false,
          configured: false,
          error: err !== null && err !== undefined && err.message ? err.message : String(err)
        };
      }
    }

    /**
     * 把使用者輸入的金鑰（與路徑）交給宿主儲存，並拿回可載入的網址。
     *
     * @param apiKey - 使用者輸入的金鑰。
     * @param redirect - 使用者輸入的路徑（空字串 = 沿用現值）。
     * @returns Promise<{ ok, configured, url, redirect, error? }>。
     */
    async function saveConfig(apiKey, redirect) {
      try {
        const response = await fetch(CONFIG_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ apiKey: apiKey, redirect: redirect })
        });
        const payload = await response.json().catch(() => null);
        if (payload === null || typeof payload !== 'object') {
          return { ok: false, error: 'HTTP ' + response.status };
        }
        return {
          ok: payload.ok === true && response.ok,
          configured: payload.configured === true,
          redirect: typeof payload.redirect === 'string' ? payload.redirect : '',
          url: typeof payload.url === 'string' ? payload.url : null,
          error: typeof payload.error === 'string'
            ? payload.error
            : (response.ok ? undefined : 'HTTP ' + response.status)
        };
      } catch (err) {
        return {
          ok: false,
          error: err !== null && err !== undefined && err.message ? err.message : String(err)
        };
      }
    }

    /**
     * 清掉已儲存的金鑰（回到「未設定」）。
     *
     * @returns Promise<{ ok, error? }>。
     */
    async function clearConfig() {
      try {
        const response = await fetch(CONFIG_URL, {
          method: 'DELETE',
          headers: { accept: 'application/json' },
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || payload === null || typeof payload !== 'object' || payload.ok !== true) {
          return {
            ok: false,
            error: payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
              ? payload.error
              : 'HTTP ' + response.status
          };
        }
        return {
          ok: true,
          redirect: typeof payload.redirect === 'string' ? payload.redirect : ''
        };
      } catch (err) {
        return {
          ok: false,
          error: err !== null && err !== undefined && err.message ? err.message : String(err)
        };
      }
    }

    /**
     * 切換「用哪種方式開工作區」（`newtab` 或 `iframe`）。
     *
     * 用 PATCH 而不是 POST 是因為這個動作**不動 apiKey、不動 redirect**，
     * 用專用動詞表意更清楚，宿主端也不會誤觸「寫入金鑰」那條路徑。
     *
     * @param mode - `'newtab'` 或 `'iframe'`。
     * @returns Promise<{ ok, mode, error? }>。
     */
    async function switchMode(mode) {
      try {
        const response = await fetch(CONFIG_URL, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ mode: mode })
        });
        const payload = await response.json().catch(() => null);
        if (payload === null || typeof payload !== 'object' || payload.ok !== true || response.ok !== true) {
          return {
            ok: false,
            error: typeof payload === 'object' && typeof payload.error === 'string'
              ? payload.error
              : 'HTTP ' + response.status
          };
        }
        return {
          ok: true,
          mode: typeof payload.mode === 'string' ? payload.mode : mode
        };
      } catch (err) {
        return {
          ok: false,
          error: err !== null && err !== undefined && err.message ? err.message : String(err)
        };
      }
    }

    /**
     * 請宿主去遠端儲存端點換回 API Key 候選值。
     *
     * ⚠️ 瀏覽器只打宿主這一條路由：遮蔽金鑰與遠端位址都留在宿主，使用者介面
     * 也不會出現任何一個。
     *
     * @returns Promise<{ ok, candidates, fields, redirect, check, raw, error? }>。
     */
    async function restoreConfig() {
      try {
        const response = await fetch(RESTORE_URL, {
          method: 'POST',
          headers: { accept: 'application/json' },
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => null);
        if (payload === null || typeof payload !== 'object') {
          return { ok: false, error: 'HTTP ' + response.status };
        }
        if (payload.ok !== true || response.ok !== true) {
          return {
            ok: false,
            error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status,
            raw: payload.raw
          };
        }
        const fields = payload.fields !== null && typeof payload.fields === 'object' ? payload.fields : {};
        return {
          ok: true,
          candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
          fields: fields,
          redirect: typeof fields.redirect === 'string' ? fields.redirect : '',
          check: payload.check !== null && typeof payload.check === 'object' ? payload.check : null,
          raw: payload.raw
        };
      } catch (err) {
        return {
          ok: false,
          error: err !== null && err !== undefined && err.message ? err.message : String(err)
        };
      }
    }

    /**
     * 重置整個管線設定：請宿主把 API Key 與路徑一起收回初始狀態。
     *
     * 一次請求完成兩件事（宿主端是一條 `mutate` 帶兩個 `unset`）—— 不拆成
     * 「清除金鑰 + 寫回預設路徑」兩步，免得中間失敗留下半套設定。
     *
     * @returns Promise<{ ok, redirect, error? }>。
     */
    async function resetConfig() {
      try {
        const response = await fetch(RESET_URL, {
          method: 'POST',
          headers: { accept: 'application/json' },
          credentials: 'same-origin'
        });
        const payload = await response.json().catch(() => null);
        if (payload === null || typeof payload !== 'object') {
          return { ok: false, error: 'HTTP ' + response.status };
        }
        if (payload.ok !== true || response.ok !== true) {
          return {
            ok: false,
            error: typeof payload.error === 'string' ? payload.error : 'HTTP ' + response.status
          };
        }
        return {
          ok: true,
          redirect: typeof payload.redirect === 'string' ? payload.redirect : ''
        };
      } catch (err) {
        return {
          ok: false,
          error: err !== null && err !== undefined && err.message ? err.message : String(err)
        };
      }
    }

    /**
     * 量測這個 iframe 的載入狀況 —— 只看瀏覽器自己記下來的資源時序，不碰 iframe 內部。
     *
     * 為什麼需要：iframe 是跨來源的，父頁面讀不到它的 `contentDocument`／`location`，
     * 所以「一直空白」在程式裡是**看不出來**的。但 `performance.getEntriesByType('resource')`
     * 是父頁面自己的紀錄 —— 它能回答「請求有沒有送出去、回來多大」，
     * 這正好是分辨「嵌入被擋」與「登入沒生效」的關鍵證據。
     *
     * @param thresholdMs - 只看最近這麼久以內的請求（毫秒）。
     * @returns `{ count, last, bytes }`；沒有 performance 或沒有紀錄時 count 為 0。
     */
    function probeFrameTraffic(thresholdMs) {
      const empty = { count: 0, last: null, bytes: 0 };
      try {
        if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') {
          return empty;
        }
        const now = typeof performance.now === 'function' ? performance.now() : Date.now();
        const window = typeof thresholdMs === 'number' && thresholdMs > 0 ? thresholdMs : 30000;
        const entries = performance.getEntriesByType('resource').filter(function (entry) {
          // iframe 的導覽請求會以資源項目的形式出現；計時器自己不算。
          const isIframe = entry.initiatorType === 'iframe' || entry.initiatorType === 'navigation';
          return isIframe && (now - entry.startTime) <= window;
        });
        if (entries.length === 0) return empty;
        let last = Infinity;
        let bytes = 0;
        for (const entry of entries) {
          if (typeof entry.startTime === 'number' && entry.startTime < last) last = entry.startTime;
          if (typeof entry.transferSize === 'number') bytes += entry.transferSize;
        }
        return {
          count: entries.length,
          last: last === Infinity ? null : Math.round(now - last),
          bytes: bytes
        };
      } catch (err) {
        return empty;
      }
    }

    /**
     * 把遠端金鑰的預檢結果翻成一句給使用者看的話。
     *
     * @param check - 宿主回的 `{ status, verdict }`，可能為 null。
     * @param t - 翻譯函式。
     * @returns `{ text, ok }`；沒有預檢結果時 text 是空字串。
     */
    function checkNoteOf(check, t) {
      if (check === null || check === undefined || typeof check !== 'object') return { text: '', ok: true };
      const verdict = typeof check.verdict === 'string' ? check.verdict : 'unknown';
      const key = 'check.' + verdict;
      const text = t(key);
      return {
        // 字典裡沒有這個 verdict 時 t() 會原樣回 key —— 那種情況用 unknown 的說法。
        text: text === key ? t('check.unknown') : text,
        ok: verdict === 'ok'
      };
    }

    // =====================================================================
    // 面板
    // =====================================================================

    /**
     * 設定表（未設定時是主畫面，已設定時是浮層）。
     *
     * @param props - `{ t, redirect, busy, error, onSubmit, onCancel, onClear, onRestore, ... }`。
     */
    function ConfigForm(props) {
      const t = props.t;
      const keyState = React.useState('');
      const apiKey = keyState[0];
      const setApiKey = keyState[1];
      const redirectState = React.useState(props.redirect || '');
      const redirect = redirectState[0];
      const setRedirect = redirectState[1];
      // 重置是破壞性操作 → 兩段式：先問，再確定。
      const confirmingState = React.useState(false);
      const confirming = confirmingState[0];
      const setConfirming = confirmingState[1];

      // 面板重開時把路徑帶成現值（金鑰欄一律留空：宿主不會把金鑰送回來）。
      React.useEffect(function () {
        setRedirect(props.redirect || '');
      }, [props.redirect]);

      // 宿主說「從遠端拿回來了」時，把值帶進欄位；並在只有一個候選時自動填入
      // （使用者仍要按「儲存並載入」才真的寫進去）。
      React.useEffect(function () {
        if (typeof props.pickedValue === 'string' && props.pickedValue !== '') {
          setApiKey(props.pickedValue);
        }
      }, [props.pickedValue, props.pickedNonce]);

      function submit(event) {
        if (event !== null && event !== undefined && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        if (props.busy) return;
        props.onSubmit(apiKey, redirect);
      }

      return h(
        'form',
        { className: 'kw-card', onSubmit: submit },
        h('div', { className: 'kw-h' }, props.heading || t('setup.heading')),
        h('p', { className: 'kw-p' }, props.hint || t('setup.hint')),
        h(
          'label',
          { className: 'kw-field' },
          h('span', { className: 'kw-label' }, t('field.apiKey')),
          h('input', {
            className: 'kw-input',
            type: 'password',
            name: 'apiKey',
            autoComplete: 'off',
            spellCheck: false,
            value: apiKey,
            placeholder: t('field.apiKeyPlaceholder'),
            disabled: props.busy === true,
            onChange: function (event) { setApiKey(event.target.value); }
          })
        ),
        h(
          'label',
          { className: 'kw-field' },
          h('span', { className: 'kw-label' }, t('field.redirect')),
          h('input', {
            className: 'kw-input',
            type: 'text',
            name: 'redirect',
            autoComplete: 'off',
            spellCheck: false,
            value: redirect,
            placeholder: '/dashboard',
            disabled: props.busy === true,
            onChange: function (event) { setRedirect(event.target.value); }
          }),
          h('span', { className: 'kw-hint' }, t('field.redirectHint'))
        ),
        props.onRestore
          ? h(
              'div',
              { className: 'kw-restore' },
              h(
                'div',
                { className: 'kw-row kw-row-start' },
                h('button', {
                  type: 'button',
                  className: 'kw-btn kw-btn-ghost',
                  disabled: props.busy === true || props.restoring === true,
                  onClick: props.onRestore
                }, props.restoring === true ? t('action.restoring') : '⇩ ' + t('action.restore'))
              ),
              h('span', { className: 'kw-hint' }, t('restore.hint')),
              props.candidates && props.candidates.length > 0
                ? h(
                    'div',
                    { className: 'kw-cands' },
                    h('span', { className: 'kw-hint' }, t('restore.pick')),
                    props.candidates.map(function (candidate, at) {
                      return h('button', {
                        key: 'cand-' + at,
                        type: 'button',
                        className: 'kw-btn kw-btn-ghost kw-cand',
                        title: candidate.path,
                        onClick: function () { props.onPick(candidate.value); }
                      }, candidate.path + '（' + candidate.value.length + ' 字）→');
                    })
                  )
                : null,
              props.restoreNote
                ? h('p', {
                    className: 'kw-p' + (props.restoreFailed === true ? ' kw-p-error' : '')
                  }, props.restoreNote)
                : null,
              props.checkNote
                ? h('p', {
                    className: 'kw-p' + (props.checkOk === true ? '' : ' kw-p-error')
                  }, props.checkNote)
                : null
            )
          : null,
        props.error
          ? h('p', { className: 'kw-p kw-p-error' }, props.error)
          : null,
        // 「用哪種方式開工作區」開關：兩個選項，現在的選項高亮。
        // 點下去走 PATCH → 宿主寫進 Config → 下次 refresh() 仍會拿到新值，
        // 但面板狀態（`mode`）會立刻切換以避免看到錯的畫面。
        props.onChangeMode
          ? h(
              'div',
              { className: 'kw-mode' },
              h('div', { className: 'kw-label' }, t('mode.heading')),
              h(
                'div',
                { className: 'kw-mode-row' },
                h('button', {
                  type: 'button',
                  className: 'kw-mode-card' + (props.mode === 'newtab' ? ' kw-mode-card-on' : ''),
                  disabled: props.modeBusy === true,
                  onClick: function () { if (props.mode !== 'newtab') props.onChangeMode('newtab'); }
                },
                  h('div', { className: 'kw-mode-title' }, '↗ ' + t('mode.newtab')),
                  h('div', { className: 'kw-hint' }, t('mode.newtabHint'))
              ),
                h('button', {
                  type: 'button',
                  className: 'kw-mode-card' + (props.mode === 'iframe' ? ' kw-mode-card-on' : ''),
                  disabled: props.modeBusy === true,
                  onClick: function () { if (props.mode !== 'iframe') props.onChangeMode('iframe'); }
                },
                  h('div', { className: 'kw-mode-title' }, '▢ ' + t('mode.iframe')),
                  h('div', { className: 'kw-hint' }, t('mode.iframeHint'))
              )
              ),
              props.modeBusy === true
                ? h('div', { className: 'kw-hint' }, t('mode.switching'))
                : null
            )
          : null,
        // 重置管線設定：兩段式（先問、再確定），一次把金鑰與路徑收回初始狀態。
        props.onReset
          ? h(
              'div',
              { className: 'kw-reset' },
              confirming
                ? h(
                    'div',
                    { className: 'kw-row kw-row-start' },
                    h('span', { className: 'kw-hint' }, t('reset.confirmHint')),
                    h('button', {
                      type: 'button',
                      className: 'kw-btn kw-btn-ghost',
                      disabled: props.busy === true,
                      onClick: function () { setConfirming(false); }
                    }, t('action.cancel')),
                    h('button', {
                      type: 'button',
                      className: 'kw-btn kw-btn-primary',
                      disabled: props.busy === true,
                      onClick: function () { setConfirming(false); props.onReset(); }
                    }, props.resetting === true ? t('action.resetting') : t('action.resetConfirm'))
                  )
                : h(
                    'div',
                    { className: 'kw-row kw-row-start' },
                    h('button', {
                      type: 'button',
                      className: 'kw-btn kw-btn-ghost',
                      disabled: props.busy === true,
                      onClick: function () { setConfirming(true); }
                    }, '⟲ ' + t('action.reset'))
                  ),
              h('span', { className: 'kw-hint' }, t('reset.hint'))
            )
          : null,
        h(
          'div',
          { className: 'kw-row' },
          props.onClear
            ? h('button', {
                type: 'button',
                className: 'kw-btn kw-btn-ghost',
                onClick: props.onClear,
                disabled: props.busy === true
              }, t('action.clear'))
            : null,
          props.onCancel
            ? h('button', {
                type: 'button',
                className: 'kw-btn kw-btn-ghost',
                onClick: props.onCancel,
                disabled: props.busy === true
              }, props.cancelLabel || t('action.cancel'))
            : null,
          h('button', {
            type: 'submit',
            className: 'kw-btn kw-btn-primary',
            disabled: props.busy === true || apiKey.trim() === ''
          }, props.busy === true ? t('action.saving') : t('action.save'))
        )
      );
    }

    /**
     * 面板本體。
     *
     * @param props - 座位給的 props；`t` 來自 `locale: NS`。
     */
    /**
     * 「在新分頁開啟」卡。當 `OPEN_IN_NEW_WINDOW = true` 且 phase 是 frame 時取代 iframe。
     *
     * 為什麼這張卡能取代 iframe：iframe 是同站 cookie 進不去的受害者；用
     * `window.open(url)` 把同一個登入連結拿到頂層分頁去打，瀏覽器認定那個
     * 頂層是「user-initiated top-level navigation」，SameSite=Lax 會被接受。
     * 之後整個工作階段都在新分頁裡；本外掛這張卡只剩兩個動作：
     * 「在新分頁開啟」與「已開啟，關閉此分頁」（後者只是把面板收成完成狀態，
     * 不會動到金鑰）。
     */
    function NewTabView(props) {
      const t = props.t;
      const url = props.url;
      const redirect = props.redirect;
      const openedState = React.useState(false);
      const opened = openedState[0];
      const setOpened = openedState[1];

      // 主路徑是 `<a target="_blank">`：瀏覽器與 Tauri 的 WebView2 都會處理它。
      // onClick 只是**保險**（有些環境把 <a> 的預設行為吃掉時再試一次
      // window.open），並且同步把「已開啟」狀態設起來。
      //
      // **刻意不做 `location.href` 自動導向**：那會在「新分頁其實開了、但主視窗
      // 仍保有焦點」的情況下把整個 DSH Web UI 置換成 Kaneo —— 使用者會直接失去
      // 面板，代價遠大於「這次沒開成」。沒開成的話，下方一直可見的「複製網址」
      // 就是可靠的退路。
      function open() {
        setOpened(true);
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (err) { /* 被擋就算了，複製網址那顆還在 */ }
      }

      function copy() {
        try {
          if (navigator && typeof navigator.clipboard !== 'undefined' && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(url);
          }
        } catch (err) { /* 複製失敗不擋 UI */ }
      }

      return h(
        'div',
        { className: 'kw-center' },
        h(
          'div',
          { className: 'kw-card kw-newtab' },
          h('div', { className: 'kw-h' }, t('newtab.heading')),
          h('p', { className: 'kw-p' }, t('newtab.explain')),
          h(
            'div',
            { className: 'kw-field' },
            h('span', { className: 'kw-label' }, t('newtab.urlLabel')),
            // 顯示整段 URL（這是登入用單次連結，本來就會出現在網址列），
            // 用等寬字型 + 換行，給使用者看也可以直接複製。
            h('textarea', {
              className: 'kw-input kw-url',
              readOnly: true,
              rows: 3,
              value: url,
              onClick: function (event) { event.target.select(); }
            }),
            h('span', { className: 'kw-hint' }, t('newtab.urlHelp'))
          ),
          redirect
            ? h('p', { className: 'kw-p' },
                h('strong', null, t('newtab.context')),
                h('code', null, redirect))
            : null,
          h(
            'div',
            { className: 'kw-row' },
            // 「複製網址」**永遠可見** —— 新分頁在少數環境（Tauri 未設
            // setNewWindowHandler、嚴格彈窗政策）可能開不起來，這時它是可靠退路。
            h('button', {
              type: 'button',
              className: 'kw-btn kw-btn-ghost',
              onClick: copy
            }, t('action.copy')),
            // 主路徑用 `<a target="_blank">`：瀏覽器與 Tauri WebView2 都會處理，
            // 不像 window.open 會被默吞。
            h('a', {
              href: url,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'kw-btn kw-btn-primary',
              onClick: open
            }, '↗ ' + t('action.openNewTab'))
          ),
          // 按過之後的提示：若新分頁沒出現，明確告訴使用者改用複製網址。
          opened
            ? h('p', { className: 'kw-p kw-p-ok' }, '✓ ' + t('newtab.openedHint'))
            : null
        )
      );
    }

    function WorkspacePanel(props) {
      const t = props !== null && props !== undefined && typeof props.t === 'function'
        ? props.t
        : fallbackT;

      // 卸載時拆掉已建好的 iframe —— 這樣下次 mount（從對話切回管線看板）
      // 倒數 effect 才不會被 `frame !== null` 守衛早退、秒數才能重新走。
      // 否則：第一次 mount → 建 iframe → 切到對話（panel unmount）→ 切回
      // 管線看板（panel mount）→ frame 仍在（被 parkFrame 停放）→ 倒數
      // effect 看到 `frame !== null` 早退、秒數永遠是初始的 3。
      React.useEffect(function () {
        return function () {
          if (typeof destroyFrame === 'function') {
            try { destroyFrame(); } catch (err) { /* 已經被拆掉了 */ }
          }
        };
      }, []);

      // phase: 'loading' | 'setup' | 'frame' | 'error'
      const phaseState = React.useState('loading');
      const phase = phaseState[0];
      const setPhase = phaseState[1];
      const statusState = React.useState({ url: null, redirect: '' });
      const status = statusState[0];
      const setStatus = statusState[1];
      const errorState = React.useState('');
      const error = errorState[0];
      const setError = errorState[1];
      const busyState = React.useState(false);
      const busy = busyState[0];
      const setBusy = busyState[1];
      const sheetState = React.useState(false);
      const sheet = sheetState[0];
      const setSheet = sheetState[1];
      const loadedState = React.useState(frameLoaded);
      const loaded = loadedState[0];
      const setLoaded = loadedState[1];
      const slowState = React.useState(false);
      const slow = slowState[0];
      const setSlow = slowState[1];
      // iframe 一直載不出來時的診斷：量到的流量 + 使用者選擇「仍然顯示」。
      const diagState = React.useState({ count: null, last: null });
      const diag = diagState[0];
      const setDiag = diagState[1];
      // 用哪種方式開工作區：`newtab`（在新分頁，預設，繞開 iframe 限制）、
      // `iframe`（原本的 iframe 嵌入，可能被擋）。
      //
      // 初始值的優先序：
      //   1. 瀏覽器記住的使用者選擇（MODE_KEY）—— 使用者切過就以他為準
      //   2. OPEN_IN_NEW_WINDOW 自動偵測（Tauri/Electron → newtab）
      // 宿主若有回 `mode`，`refresh()` 會用宿主的值覆蓋上面兩者（宿主是正式來源），
      // 並順手把值同步回這裡，讓兩份不會分歧。
      const modeState = React.useState(
        readStoredMode() || (OPEN_IN_NEW_WINDOW ? 'newtab' : 'iframe')
      );
      const mode = modeState[0];
      const setMode = modeState[1];
      // 切換時的忙碌狀態（PATCH 來回期間不讓使用者再點）。
      const modeBusyState = React.useState(false);
      const modeBusy = modeBusyState[0];
      const setModeBusy = modeBusyState[1];
      const forceState = React.useState(false);
      const forceShown = forceState[0];
      const setForceShown = forceState[1];
      // 「從遠端取回設定」的狀態：進行中、候選值、提示文字、預檢結果、填入值。
      const restoreState = React.useState({
        busy: false, candidates: [], note: '', failed: false, picked: '', nonce: 0, check: null
      });
      const restore = restoreState[0];
      const setRestore = restoreState[1];
      // 進面板時的倒數窗口（3 秒，做成動畫）。
      // **每次開啟都先倒數** —— 第一次也倒數，切回來也倒數（這也是使用者要求
      // 的「每次都有倒計時」）。`preloadArmed` 那個 module 級標誌不再決定
      // 這裡的初始值 —— 進 iframe 視圖就**一定**先看到倒數。
      // 已建立的 iframe 在 panel 重掛時被 `parkFrame()` 停到畫面外、phase 切回
      // frame 時又被 `navigateFrame()` 搬回來，所以重複的倒數視覺上看起來
      // 就像「每次開都先等 3 秒 → 看到 iframe」這正是使用者想要的。
      const preloadState = React.useState(true);
      const preload = preloadState[0];
      const setPreload = preloadState[1];
      // 剩餘比例（1 → 0）與顯示用秒數：每 50ms 更新一次，驅動進度環。
      const progressState = React.useState({ fraction: 1, seconds: PRELOAD_SECONDS });
      const progress = progressState[0];
      const setProgress = progressState[1];
      // 重置設定：進行中 / 結果提示。
      const resetState = React.useState({ busy: false, note: '' });
      const reset = resetState[0];
      const setReset = resetState[1];

      const hostRef = React.useRef(null);

      // 把已建好的 iframe 搬到主機節點：這個 effect 放在 `showFrame` 宣告
      // 之後才合法（下面），所以定義在下面。

      /**
       * 要帶進登入網址的路徑：**先看上次停在哪一頁**，沒有才用伺服器給的預設。
       *
       * 這是「重整後回到原本那一頁」的關鍵 —— 每次重整都要重新登入一次（iframe
       * 無法跨文件存活），但登入可以落在使用者剛才看的地方。
       *
       * @param fallback - 伺服器回的 redirect（通常是 /dashboard）。
       * @returns 站內路徑。
       */
      function preferredRedirect(fallback) {
        return readLastPath() || fallback || '/dashboard';
      }

      /** 問宿主現在能不能載入；帶上「上次那一頁」，讓宿主直接組好要去的網址。 */
      const refresh = React.useCallback(async function () {
        const next = await fetchStatus(preferredRedirect(''));
        // 宿主有回 `mode` 就以它為準（正式來源），並把值同步回瀏覽器儲存，
        // 讓下次「宿主沉默」時仍有正確的偏好可用。宿主沒回時這裡不動 ——
        // 初始值（儲存的偏好或自動偵測）保持有效。
        if (next.mode === 'iframe' || next.mode === 'newtab') {
          setMode(next.mode);
          persistStoredMode(next.mode);
        }
        if (next.ok === true && next.configured === true && typeof next.url === 'string') {
          setStatus({
            url: next.url,
            redirect: next.redirect || '',
            resume: readLastPath()
          });
          setError('');
          setPhase('frame');
          return;
        }
        if (next.ok === true) {
          setStatus({ url: null, redirect: next.redirect || '', resume: readLastPath() });
          setPhase('setup');
          return;
        }
        setStatus({ url: null, redirect: next.redirect || '', resume: null });
        setError(next.error || '');
        setPhase('error');
      }, []);

      React.useEffect(function () {
        let alive = true;
        // 已經有一個活著的 iframe 時不要重問宿主：切面板回來若先閃一下
        // 載入遮罩、再把同一個網址重新指派一次，會平白重載使用者正在看的頁面。
        if (frame !== null && frameUrl !== null) return undefined;
        refresh().then(function () { /* 狀態已由 refresh 設好 */ }).catch(function (err) {
          if (!alive) return;          setError(err && err.message ? err.message : String(err));
          setPhase('error');
        });
        return function () { alive = false; };
      }, [refresh]);

      // 倒數窗口：只在「已經確認可以載入、但還沒建立 iframe」時跑。
      // 這段期間不建立 iframe、也不打任何請求，所以打斷是完全無副作用的。
      // **每次**面板進入倒數窗口都從 0 開始計時（不只是初次）。
      // `preloadStartedAt` 已經在 cleanup 裡被清回 0，所以這裡只是「若有
      // 測試或工具幫忙前推過，就以那個值起算」 —— 但**不要在 effect 開頭把
      // 它歸零**（否則測試用 fastForwardPreload 推到 t-4s 會被立刻清掉，
      // 達不到「跳過倒數」的效果）。
      React.useEffect(function () {
        if (!preload) return undefined;
        // 不管 frame 是否已建 —— 第二次 mount 時 frame 仍指著上次建好的
        // iframe（被 parkFrame 停放），倒數仍要跑：覆蓋層會擋住 iframe，
        // 3 秒後 `preload` 變 false，iframe 元素已經在主機節點（iframe effect
        // 也跑了 appendChild），就直接露出來 —— **不會**重新走金鑰交換流程。
        // 不檢查 phase：第二次 mount 時 phase 暫時是 'loading'，但 preload
        // 為 true 表示「要倒數」，這個 effect 應該立刻跑。
        const startedAt = getPreloadStart();
        const totalMs = PRELOAD_SECONDS * 1000;
        function tick() {
          const next = preloadProgress(startedAt, Date.now(), totalMs);
          setProgress(next);
          if (next.fraction <= 0) {
            preloadArmed = false;
            setPreload(false);
          }
        }
        tick();
        const timer = setInterval(tick, PRELOAD_TICK_MS);
        return function () {
          clearInterval(timer);
          preloadStartedAt = 0;
        };
      }, [preload, frame]);

      /**
       * 打斷登入：把倒數結束掉並切到設定畫面。
       *
       * 此刻 iframe 還沒建立，所以不需要「取消載入」—— 什麼都還沒發生。
       */
      function interruptPreload() {
        preloadArmed = false;
        setPreload(false);
        setSheet(false);
        setError('');
        setPhase('setup');
      }

      // iframe 的生命週期：phase 是 frame 時搬進 host，否則停放。
      // `preload > 0` 代表還在倒數窗口內 —— 那時**不建立 iframe**，所以打斷
      // 完全沒有副作用（沒有任何請求飛出去、也沒有半個登入被觸發）。
      // `mode === 'newtab'` 時 iframe 路徑整個關閉，這個 effect 也不再跑
      // —— 面板改顯示「在新分頁開啟」卡，url 與金鑰都不會送到 iframe。
      //
      // **重要**：守衛不檢查 `frame !== null` —— 第二次 mount 時 `frame` 仍指
      // 著已建好的 iframe（被 `parkFrame` 停放）。這個 effect 進去時呼叫
      // `navigateFrame(status.url)` 早退（同網址不重設 src），但仍會
      // `appendChild` 把 iframe 從停放區搬到主機節點 —— 所以第二次打開
      // 「管線看板」時**直接**看到 iframe，倒數覆蓋層會擋住它 3 秒。
      // 倒數 effect 同步跑（看 `frame === null`），所以秒數會動。
      React.useEffect(function () {
        if (mode === 'newtab') return undefined;
        if (phase !== 'frame' || typeof status.url !== 'string' || preload > 0) return undefined;
        let el;
        try {
          el = navigateFrame(status.url);
        } catch (err) {
          return undefined;
        }
        const host = hostRef.current;
        if (host !== null && host !== undefined && el.parentNode !== host) host.appendChild(el);
        setLoaded(frameLoaded);

        function onLoad() {
          frameLoaded = true;
          // 這次瀏覽階段已經載入過 → 之後切面板回來不再倒數打擾。
          preloadArmed = false;
          setLoaded(true);
          setSlow(false);
          // 記住停在哪一頁：整頁重整後就回到這裡，而不是回到 /dashboard。
          persistFramePath(el);
        }
        el.addEventListener('load', onLoad);
        // 已經載好過（切面板回來）就立刻記一次，不然會漏掉最後停的那一頁。
        if (frameLoaded) persistFramePath(el);
        // 有些失敗（被擋、被中止）不會觸發 load；error 至少讓我們知道「有嘗試」。
        function onError() {
          setForceShown(false);
          setSlow(true);
          setDiag(probeFrameTraffic(30000));
        }
        el.addEventListener('error', onError);
        const timer = setTimeout(function () {
          if (frameLoaded) return;
          setSlow(true);
          // 慢的時候順便量一下：請求有沒有送出去。
          setDiag(probeFrameTraffic(30000));
        }, SLOW_MS);

        return function () {
          clearTimeout(timer);
          el.removeEventListener('load', onLoad);
          el.removeEventListener('error', onError);
          parkFrame();
        };
      }, [phase, status.url, preload]);

      /** 存金鑰：交給宿主，成功後直接載入。 */
      function submit(apiKey, redirect) {
        setBusy(true);
        setError('');
        saveConfig(apiKey, redirect).then(function (result) {
          setBusy(false);
          if (result.ok === true && typeof result.url === 'string') {
            setStatus({
              url: result.url,
              redirect: result.redirect || redirect,
              resume: readLastPath()
            });
            setSheet(false);
            setPhase('frame');
            return;
          }
          setError(result.error || '儲存失敗');
        }).catch(function (err) {
          setBusy(false);
          setError(err && err.message ? err.message : String(err));
        });
      }

      function openSheet() {
        setError('');
        setSheet(true);
      }

      function closeSheet() {
        setSheet(false);
        setError('');
      }

      /**
       * 按「從遠端取回設定」：請宿主去換，回來的候選值帶進金鑰欄位。
       *
       * 刻意**只填欄位、不自動儲存**：這是把遠端記著的値帶進來，存不存由使用者
       * 決定（跟其他欄位一樣，改完按「儲存並載入」）。
       */
      function runRestore() {
        /** 每次都從「現在這一份」開始改，免得漏掉 check 之類的欄位。 */
        function next(change) {
          const base = {
            busy: false,
            candidates: restore.candidates,
            note: restore.note,
            failed: restore.failed,
            picked: restore.picked,
            nonce: restore.nonce,
            check: restore.check
          };
          return Object.assign(base, change);
        }
        setRestore(next({ busy: true, candidates: [], note: '', failed: false, picked: '', check: null }));
        restoreConfig().then(function (result) {
          if (result.ok !== true) {
            setRestore(next({
              note: (result.error || '取回失敗') + describeRaw(result.raw),
              failed: true,
              check: null
            }));
            return;
          }
          const candidates = result.candidates || [];
          // 遠端可能也記著「登入後開啟的路徑」（實測回 `REDIRECT_URL`）：有就
          // 帶進欄位，使用者按下儲存時才真的寫進去。
          const remoteRedirect = typeof result.redirect === 'string' && result.redirect !== ''
            ? result.redirect
            : status.redirect;
          if (remoteRedirect !== status.redirect) {
            setStatus({ url: status.url, redirect: remoteRedirect });
          }
          if (candidates.length === 0) {
            setRestore(next({
              note: t('restore.none') + describeRaw(result.raw),
              failed: true,
              check: null
            }));
            return;
          }
          // 只有一個候選就直接帶進欄位；多個則讓使用者點選（金鑰原文不渲染在畫面上）。
          const auto = candidates.length === 1 ? candidates[0].value : '';
          setRestore(next({
            candidates: candidates,
            note: auto === '' ? '' : t('restore.pick'),
            failed: false,
            picked: auto,
            nonce: restore.nonce + 1,
            check: result.check || null
          }));
        }).catch(function (err) {
          setRestore(next({
            note: err && err.message ? err.message : String(err),
            failed: true,
            check: null
          }));
        });
      }

      /** 把遠端原始回應收成一句可讀的附註（形狀對不上時這是唯一的線索）。 */
      function describeRaw(raw) {
        if (raw === null || raw === undefined) return '';
        try {
          return '　' + t('restore.raw') + JSON.stringify(raw).slice(0, 300);
        } catch (err) {
          return '';
        }
      }

      /** 清掉已儲存的金鑰，回到設定畫面。 */
      function clearKey() {
        setBusy(true);
        setError('');
        clearConfig().then(function (result) {
          setBusy(false);
          if (result.ok !== true) {
            setError(result.error || '清除失敗');
            return;
          }
          setSheet(false);
          setStatus({ url: null, redirect: result.redirect || '' });
          setPhase('setup');
        }).catch(function (err) {
          setBusy(false);
          setError(err && err.message ? err.message : String(err));
        });
      }

      function reload() {
        frameLoaded = false;
        setLoaded(false);
        setSlow(false);
        // 若目前沒有 iframe（例如剛從錯誤狀態回來），重新問一次宿主。
        if (frame === null) {
          refresh();
          return;
        }
        reloadFrame();
      }

      /**
       * 重置管線設定：金鑰與路徑一起清掉，回到設定表。
       *
       * 重置後換一組空白設定，所以 `navigateFrame` 下次會拿到不同的網址 ——
       * 也就是下次登入是「乾淨的一次」。重置當下我們**不主動拆 iframe**：
       * 使用者按了重置就是要重新設定，面板此時顯示的是設定表。
       */
      function runReset() {
        setReset({ busy: true, note: '' });
        resetConfig().then(function (result) {
          if (result.ok !== true) {
            setReset({ busy: false, note: result.error || '重置失敗' });
            return;
          }
          setBusy(false);
          setSheet(false);
          setStatus({ url: null, redirect: result.redirect || '' });
          setReset({ busy: false, note: t('reset.done') });
          setPhase('setup');
        }).catch(function (err) {
          setReset({ busy: false, note: err && err.message ? err.message : String(err) });
        });
      }

      /**
       * 切換「用哪種方式開工作區」—— 立刻更新面板狀態，背景送 PATCH 給宿主寫進 Config。
       *
       * 為什麼不等伺服器回應才切：使用者點下去就應該看到對的畫面（iframe 卡 / 新分頁卡），
       * 寫入失敗才退回。這樣 PATCH 網路抖動也不會卡 UI。
       */
      function changeMode(next) {
        if (next !== 'newtab' && next !== 'iframe') return;
        if (next === mode || modeBusy) return;
        const previous = mode;
        // 立刻切：UI 立刻看到對的卡，不必等伺服器。
        setMode(next);
        setModeBusy(true);
        // 切到 iframe 時拆掉舊 iframe（連同停放區），讓下次 render 從頭建 —— 這時
        // 倒數窗口也會重新出現。切到 newtab 時也拆掉，確保新分頁卡是「乾淨」的起點。
        if (destroyFrame) {
          try { destroyFrame(); } catch (err) { /* 拆不掉就留著，後面會回收 */ }
        }
        setLoaded(false);
        setSlow(false);
        setDiag({ count: null, last: null });
        setForceShown(false);
        preloadArmed = true; // 讓下次重設：再次走倒數 → 建 iframe。
        setPreload(true);
        // 使用者的選擇先記在瀏覽器（即使宿主沒有 PATCH 路由、或 PATCH 失敗，
        // 下次重開也維持他選的方式，不會被自動偵測蓋掉）。
        persistStoredMode(next);
        // 寫進宿主（背景）。失敗時退回面板狀態。
        switchMode(next).then(function (result) {
          setModeBusy(false);
          if (result.ok !== true) {
            setMode(previous);
            persistStoredMode(previous);
          }
        }).catch(function () {
          setModeBusy(false);
          setMode(previous);
          persistStoredMode(previous);
        });
      }

      const check = checkNoteOf(restore.check, t);

      // 「已建好的 iframe」優先：不管 phase 是什麼，只要 frame 還在就把
      // iframe 拉回主機節點渲染。這是修「第二次打開管線看板一直卡在載入中」
      // —— 第二次 mount 時 `phase` 重置為 `'loading'`，但 `frame`（module 級 closure
      // 變數）仍指著已建好的 iframe DOM，所以這裡直接渲染 iframe 路徑，
      // 同時讓下面的 effect 在 `phase` 切到 'frame' 後決定要不要重建。
      const hasLiveFrame = frame !== null && frameUrl !== null;
      const showFrame = hasLiveFrame || (mode === 'iframe' && phase !== 'setup' && phase !== 'error');

      // 已有 iframe → 立刻搬到主機節點（不必等 phase 切到 frame）。
      // 這修「第二次打開管線看板 → phase 重置為 loading → iframe effect
      // 不重跑 → 卡在載入中」的問題。
      React.useEffect(function () {
        if (!showFrame) return undefined;
        const host = hostRef.current;
        if (host === null || host === undefined) return undefined;
        if (frame === null || frameUrl === null) return undefined;
        try {
          if (frame.parentNode !== host) host.appendChild(frame);
        } catch (err) { /* 已在主機上就什麼都不做 */ }
      }, [showFrame]);

      let body;
      if (phase === 'loading' && !showFrame) {
        body = h(
          'div',
          { className: 'kw-center' },
          h('div', { className: 'kw-card' }, h('p', { className: 'kw-p' }, t('state.loading')))
        );
      } else if (phase === 'setup') {
        body = h(
          'div',
          { className: 'kw-center' },
          h('div', { className: 'kw-stack' },
            h(ConfigForm, {
              t: t,
              redirect: status.redirect,
              busy: busy,
              error: error,
              onSubmit: submit,
            onRestore: runRestore,
            restoring: restore.busy,
            candidates: restore.candidates,
            restoreNote: restore.note,
            restoreFailed: restore.failed,
            pickedValue: restore.picked,
            pickedNonce: restore.nonce,
            checkNote: check.text,
            checkOk: check.ok,
            onReset: runReset,
            resetting: reset.busy,
            resetNote: reset.note,
            mode: mode,
            modeBusy: modeBusy,
            onChangeMode: changeMode,
            onPick: function (value) {
              setRestore({
                busy: false,
                candidates: restore.candidates,
                note: '',
                failed: false,
                picked: value,
                nonce: restore.nonce + 1,
                check: restore.check
              });
            }
          }),
            reset.note
              ? h('p', { className: 'kw-p kw-p-ok' }, reset.note)
              : null
          )
        );
      } else if (phase === 'error') {
        body = h(
          'div',
          { className: 'kw-center' },
          h(
            'div',
            { className: 'kw-card' },
            h('div', { className: 'kw-h kw-p-error' }, t('error.title')),
            h('p', { className: 'kw-p' }, error || t('error.bridge')),
            h(
              'div',
              { className: 'kw-row' },
              h('button', {
                type: 'button',
                className: 'kw-btn kw-btn-ghost',
                onClick: function () { setPhase('setup'); setError(''); }
              }, t('action.settings')),
              h('button', {
                type: 'button',
                className: 'kw-btn kw-btn-primary',
                onClick: function () { setPhase('loading'); refresh(); }
              }, t('action.retry'))
            )
          )
        );
      } else if (mode === 'newtab' && typeof status.url === 'string' && status.url !== '') {
        // 該站台不允許 iframe 嵌入（SameSite cookie 限制）；用「在新分頁開啟」取代。
        // 切換這條路徑的使用者從設定表的「開啟工作區的方式」開關選「在新分頁開啟」。
        // **跟 iframe 路徑一樣先倒數 3 秒**（每次打開都倒數）—— 倒數期間
        // 整塊 NewTabView 卡被半透明覆蓋層擋住，3 秒後露出來。
        // 用戶可主動點覆蓋層「中斷」倒數（直接進設定 / 重整）。
        body = h(
          'div',
          { className: 'kw-center' },
          preload
            ? h(
                'div',
                {
                  className: 'kw-overlay kw-overlay-click',
                  role: 'button',
                  tabIndex: 0,
                  onClick: interruptPreload,
                  onKeyDown: function (event) {
                    if (event && (event.key === 'Enter' || event.key === ' ')) interruptPreload();
                  }
                },
                h(
                  'div',
                  { className: 'kw-count' },
                  h('svg', { className: 'kw-ring', viewBox: '0 0 48 48', 'aria-hidden': true },
                    h('circle', { className: 'kw-ring-track', cx: 24, cy: 24, r: RING_RADIUS }),
                    h('circle', {
                      className: 'kw-ring-fill',
                      cx: 24,
                      cy: 24,
                      r: RING_RADIUS,
                      strokeDasharray: String(RING_CIRCUMFERENCE),
                      style: { transform: 'scale(' + progress.fraction + ')' }
                    })
                  ),
                  h('span', { className: 'kw-count-num' }, String(progress.seconds))
                ),
                h('div', { className: 'kw-h' }, t('preload.title')),
                h('div', { className: 'kw-p' }, t('preload.hint'))
              )
            : h(NewTabView, {
                t: t,
                url: status.url,
                redirect: status.redirect
              })
        );
      } else {
        body = h(
          'div',
          { className: 'kw-frameWrap' },
          // iframe 用命令式搬進來，React 不渲染它的子節點。
          h('div', { className: 'kw-frameHost', ref: hostRef }),
          // 倒數窗口：整塊可點，點一下就停下來進設定（此時 iframe 還沒建立）。
          preload
            ? h(
                'div',
                {
                  className: 'kw-overlay kw-overlay-click',
                  role: 'button',
                  tabIndex: 0,
                  onClick: interruptPreload,
                  onKeyDown: function (event) {
                    if (event && (event.key === 'Enter' || event.key === ' ')) interruptPreload();
                  }
                },
                h(
                  'div',
                  { className: 'kw-count' },
                  // 進度環用 transform 動畫（不逐格改屬性）：CSS transition 補間，
                  // 就算計時器被瀏覽器節流也是平滑的。
                  h('svg', { className: 'kw-ring', viewBox: '0 0 48 48', 'aria-hidden': true },
                    h('circle', { className: 'kw-ring-track', cx: 24, cy: 24, r: RING_RADIUS }),
                    h('circle', {
                      className: 'kw-ring-fill',
                      cx: 24,
                      cy: 24,
                      r: RING_RADIUS,
                      strokeDasharray: String(RING_CIRCUMFERENCE),
                      style: { transform: 'scale(' + progress.fraction + ')' }
                    })
                  ),
                  h('span', { className: 'kw-count-num' }, String(progress.seconds))
                ),
                h('div', { className: 'kw-h' }, t('preload.title')),
                h('div', { className: 'kw-p' }, t('preload.hint')),
                h('div', { className: 'kw-btn kw-btn-ghost' }, t('action.interrupt'))
              )
            : (loaded || forceShown
                ? null
                : h(
                    'div',
                    { className: 'kw-overlay' },
                    slow
                      ? h(
                          'div',
                          { className: 'kw-diag' },
                          h('div', { className: 'kw-h' }, t('state.slow')),
                          h('div', { className: 'kw-p' },
                            diag.count === null || diag.count === 0
                              ? t('frame.noRequests')
                              : t('frame.requests')
                                .replace('{n}', String(diag.count))
                                .replace('{last}', String(diag.last === null ? '?' : diag.last))),
                          h('div', { className: 'kw-p' }, t('frame.diag')),
                          h(
                            'div',
                            { className: 'kw-row' },
                            h('button', {
                              type: 'button',
                              className: 'kw-btn kw-btn-ghost',
                              onClick: function () { setDiag(probeFrameTraffic(30000)); }
                            }, t('action.diagnose')),
                            h('button', {
                              type: 'button',
                              className: 'kw-btn kw-btn-ghost',
                              onClick: function () { setForceShown(true); }
                            }, t('action.forceShow')),
                            h('button', {
                              type: 'button',
                              className: 'kw-btn kw-btn-primary',
                              onClick: reload
                            }, t('action.reload'))
                          )
                        )
                      : h('div', null, t('state.loading'))
                  )),
          sheet
            ? h(
                'div',
                { className: 'kw-sheet' },
                h(ConfigForm, {
                  t: t,
                  redirect: status.redirect,
                  busy: busy,
                  error: error,
                  heading: t('settings.heading'),
                  hint: t('settings.hint'),
                  cancelLabel: t('action.cancel'),
                  onCancel: closeSheet,
                  onClear: clearKey,
                  onRestore: runRestore,
                  restoring: restore.busy,
                  candidates: restore.candidates,
                  restoreNote: restore.note,
                  restoreFailed: restore.failed,
                  pickedValue: restore.picked,
                  pickedNonce: restore.nonce,
                  checkNote: check.text,
                  checkOk: check.ok,
                  onReset: runReset,
                  resetting: reset.busy,
                  mode: mode,
                  modeBusy: modeBusy,
                  onChangeMode: changeMode,
                  onPick: function (value) {
                    setRestore({
                      busy: false,
                      candidates: restore.candidates,
                      note: '',
                      failed: false,
                      picked: value,
                      nonce: restore.nonce + 1,
                      check: restore.check
                    });
                  },
                  onSubmit: submit
                })
              )
            : null
        );
      }

      const showBar = phase === 'frame' || phase === 'setup' || phase === 'error';

      return h(
        'div',
        { className: 'kw-root' },
        body,
        showBar
          ? h(
              'div',
              { className: 'kw-bar' },
              h('span', { className: 'kw-bar-spacer' }),
              h('button', {
                type: 'button',
                className: 'kw-chip',
                title: t('action.reload'),
                onClick: reload
              }, '↻ ' + t('action.reload')),
              h('button', {
                type: 'button',
                className: 'kw-chip',
                title: t('action.settings'),
                onClick: sheet ? closeSheet : openSheet
              }, '⚙ ' + t('action.settings'))
            )
          : null
      );
    }

    // =====================================================================
    // Plugin body
    // =====================================================================
    /** 這個 client half 需要什麼服務：座位表與翻譯。 */
    const inject = ['slots', 'locale'];

    /**
     * 掛載：裝樣式、註冊字典、貢獻兩個座位。
     *
     * @param ctx - client 根上下文。
     */
    function apply(ctx) {
      ctx.effect(installStyles, 'kaneo-web: styles');
      ctx.effect(function () {
        // `zh` 是 harness 一定有的鍵（preference 只認 zh/en）；`zh-TW` 是
        // zhtw-traditional-chinese 語言包發布的 id。兩份一模一樣的繁體字典，
        // 不管使用者選哪一個都拿到繁體，不必依賴簡→繁轉換。
        const disposeZh = ctx.locale.register(NS, 'zh', zh);
        const disposeZhTw = ctx.locale.register(NS, 'zh-TW', zh);
        return function () {
          if (typeof disposeZh === 'function') disposeZh();
          if (typeof disposeZhTw === 'function') disposeZhTw();
        };
      }, 'kaneo-web: dictionaries');
      // iframe 是 module 級單例，外掛卸下時要真的拆掉（不然會留在 DOM 裡）。
      ctx.effect(function () {
        return destroyFrame;
      }, 'kaneo-web: frame');

      const t = ctx.locale.bind(NS);

      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: function () { return t('panel.title'); }
          },
          function (iconProps) {
            return h(Glyph, {
              size: iconProps !== null && iconProps !== undefined ? iconProps.size : undefined,
              active: iconProps !== null && iconProps !== undefined ? iconProps.active : undefined,
              onClick: function () {
                if (ctx.layout && typeof ctx.layout.selectPanel === 'function') {
                  const current = iconProps !== null && iconProps !== undefined && iconProps.active === true;
                  ctx.layout.selectPanel(current ? null : PANEL_ID);
                }
              }
            });
          }
        );
      });

      ctx.slots.inject('main', function () {
        return ctx.slots.register(
          { name: 'main', key: PANEL_ID },
          function (slotProps) { return h(WorkspacePanel, slotProps); }
        );
      });
    }

    const exported = { apply: apply, inject: inject };
    // 測試縫：Loader 會忽略不認識的鍵。
    exported.__internals = {
      PANEL_ID: PANEL_ID,
      PANEL_ORDER: PANEL_ORDER,
      CONFIG_URL: CONFIG_URL,
      RESTORE_URL: RESTORE_URL,
      RESET_URL: RESET_URL,
      CSS: CSS,
      OPEN_IN_NEW_WINDOW: OPEN_IN_NEW_WINDOW,
      PRELOAD_SECONDS: PRELOAD_SECONDS,
      FRAME_TITLE: FRAME_TITLE,
      PRELOAD_SECONDS: PRELOAD_SECONDS,
      NS: NS,
      zh: zh,
      en: en,
      WorkspacePanel: WorkspacePanel,
      ConfigForm: ConfigForm,
      Glyph: Glyph,
      installStyles: installStyles,
      ensureFrame: ensureFrame,
      navigateFrame: navigateFrame,
      reloadFrame: reloadFrame,
      parkFrame: parkFrame,
      destroyFrame: destroyFrame,
      fetchStatus: fetchStatus,
      saveConfig: saveConfig,
      clearConfig: clearConfig,
      switchMode: switchMode,
      resetConfig: resetConfig,
      restoreConfig: restoreConfig,
      checkNoteOf: checkNoteOf,
      isPreloadArmed: function () { return preloadArmed; },
      armPreload: function () { preloadArmed = true; },
      disarmPreload: function () { preloadArmed = false; },
      // 測試用：把倒數起點往回推 4 秒，下一次 tick() 會立刻判定「已到 0」並
      // 把 preload 設成 false —— 跳過「等 3 秒」這段，專注在倒數之後的行為。
      fastForwardPreload: function () {
        preloadStartedAt = Date.now() - 4000;
      },
      preloadProgress: preloadProgress,
      isFrameLoaded: function () { return frameLoaded; },
      frameUrl: function () { return frameUrl; },
      reset: function () { destroyFrame(); }
    };
    return exported;
  }
});
