# kaneo-web

在 DSH Web 側邊欄多一個 **管線看板** 面板，用 iframe 載入工作區。

## 它做什麼

1. 側邊欄出現一顆圖示，名稱為「管線看板」（`sidebar.panellist`，id `kaneo-web`）。
2. 點它切到面板（`main`，key `kaneo-web`）。
3. **進入面板先倒數 3 秒**（`PRELOAD_SECONDS`，做成動畫）：這段時間**不建立 iframe、
   也不打任何請求**，畫面是一圈每秒縮一圈的**進度環**加中央秒數。
   **倒數結束前按一下（或按 Enter／空白）就打斷登入**、直接進設定表 ——
   不想現在登入、或臨時想換金鑰時，不必等它載完再看。
   倒數只在**這次瀏覽階段第一次**開啟時出現；iframe 載入過之後，切來切去都直接顯示它。

   動畫做法：進度環是兩個 `<circle>`（底環 + 進度環），進度用 `transform: scale()` 表達、
   由 `transition: transform 50ms linear` 補間，所以即使瀏覽器把 50ms 的計時器節流，
   環的收縮仍然是連續的（不是一格一格跳）。**不逐格改 `stroke-dashoffset`／
   `stroke-dasharray`** —— 那會讓每次更新都觸發一次樣式重算。
   前進的數字由純函式 `preloadProgress()` 算（可單獨測），顏色全部走主題 token。
4. **API Key 未設定時**，面板顯示一張設定表：
   * **API Key**（password 欄）
   * **登入後開啟的路徑**（預設 `/dashboard`）
   * **⇩ 從遠端取回設定** —— 參考 ntfy-teams 的「恢復設定」：向宿主要一份
     遮蔽金鑰，再由宿主打 `POST …/storage/kaneo`（body `{ apiKey }`，值是遮蔽後的），
     把遠端記著的金鑰換回來並帶進欄位。只填欄位、**不自動儲存**。
   * **⟲ 重置管線設定** —— 兩段式確認後，把 API Key 與路徑**一起**收回初始狀態
     （宿主端是一次 `mutate` 帶兩個 `unset`，所以不會留下半套設定）。

   這時候**不會建立 iframe** —— 面板只送一次 GET 問宿主「設定好了沒」。
5. 按下「儲存並載入」後，金鑰存在**宿主端**，面板才建立 iframe 載入工作區。

已設定之後，底部工具列的「設定」可以再改金鑰或路徑，也可以「從遠端取回設定」、
「清除已儲存的金鑰」（只清金鑰、保留路徑）或「重置管線設定」（兩者都清）。

## 使用者看不到什麼（這是設計，不是藏起來）

| 東西 | 在哪裡 |
|---|---|
| 服務網域（`https://pl.feg.cn`） | 只在 `lib/index.js` 的 `DEFAULT_SERVER_URL` |
| 登入路徑（`/api/auth/api-key/sign-in`） | 只在 `lib/index.js` 的 `SIGN_IN_PATH` |
| 產品名 | 介面上**一個字都沒有**：選單、標題、按鈕、錯誤訊息都不含「Kaneo」 |
| API Key 的值 | 只在宿主端（外掛 Config）；瀏覽器只在自己 POST 的那一刻持有輸入框內容 |

瀏覽器 bundle（`lib/client.js`）裡**一個字都沒有**這些字串 —— `test/smoke.js`
用字串斷言把這件事釘住（`pl.feg.cn`、`api/auth`、`api-key`、`sign-in`、
`https://`、`abc.feg.com.tw`、`storage/kaneo`），另外兩項斷言「UI 字典與
iframe 標題不含產品名」、「`zh` 字典是繁體不是簡體」。
「Kaneo」只出現在註解、套件名與 loader row id 裡（那些不進畫面）。

## 介面語言

介面是**繁體中文**。字典同時註冊在 `zh` 與 `zh-TW` 兩個語系鍵上
（`zh` 是這個 harness 一定有的鍵 —— `locale.preference` 只認 `zh`/`en`；
`zh-TW` 是 `zhtw-traditional-chinese` 語言包發布的 id），所以不管使用者
選哪一個都拿到繁體，**不依賴**簡→繁轉換。英文介面另有一份完整字典。

## 資料怎麼走

```
使用者輸入金鑰 ──POST /plugins/kaneo-web/config──▶ 宿主
                                                   │ ctx.settings.update('kaneo-web', { apiKey })
                                                   │   → 寫進 profile 的 cordis.patch.yml（0600）
                                                   │   → 就地重載，不必重啟
                                                   ▼
面板 ◀── { url: "<完整登入網址>" } ──────────────── 宿主組好才回傳
   │
   └─▶ iframe.src = url ；該應用自己再導向 /dashboard
```

* 金鑰欄位在 Config 裡是 `.role('secret')` + `.volatile()`：
  宿主自己讀得到（本外掛要用），但 `ctx.remote.settings.describe()` 一律
  redact，遠端／瀏覽器永遠拿不到值。
* `redirect` 一定要是站內絕對路徑（`/` 開頭、無 `//`、無 `:`、無空白），
  否則**明確拒絕**（HTTP 400）而不是靜默改成預設值 —— 不然這個端點會變成
  一個開放轉址。
* 金鑰裡的 `&`、`#`、`=`、空白都會編碼；`/` 保持原樣（遠端把參數當路徑處理）。

## 安裝

在 workspace 撰寫，然後用 `plugin_manager` 的 `install_bundle` 指到本目錄：

```
plugin_manager { action: "install_bundle", target: "C:\\Users\\shawoo\\Desktop\\feg.cn\\cordis-plugins\\kaneo-web" }
```

套件會被連結進 profile（`profiles/web/node_modules/kaneo-web`），`cordis.patch.yml`
裡的 `insert:` 行把它掛起來（`apiKey: ''`、`redirect: /dashboard`）。

## 測試

```
npm test        # 六份都跑
node test/smoke.js             # 19 項：導出形狀、Config schema、網址組成、bundle 純淨度、選單名稱、繁體與無產品名
node test/host-route.js        # 31 項：真的掛起來打 GET／POST／DELETE／reset，含 mask-key、restore 與預檢
node test/config-freshness.js  #  3 項：設定解析優先序的迴歸測試
node test/panel-render.js      # 25 項：面板渲染行為（未設定時不得有 iframe、取回流程、倒數動畫與打斷、重置）
node test/frame-persistence.js # 10 項：iframe 常駐行為（切面板不重載、F5 才重載）
node test/secrets.js           # 22 項：遮蔽公式、憑證檔解析、真實回應形狀、「原文不出宿主」
```

其中四份釘住的是實際踩到過、而且都是**靜默**失效的 bug：

* `smoke.js` 斷言瀏覽器 bundle 不含網域與登入路徑、不使用瀏覽器儲存、
  CSS 只用主題 token。
* `config-freshness.js` 斷言讀設定**優先看 `ctx.fiber.config`**。
  `.volatile()` 欄位在宿主端是 Cordis 的 ref（不是字串），而外掛實例閉包裡
  的那份 config 在金鑰寫入後就是舊的 —— 讀錯一份會得到
  「按了儲存沒反應」或 `key=%5Bobject%20Object%5D`。
* `panel-render.js` 用自帶的極簡 React hooks 實作跑**真正的面板元件**，
  斷言「未設定 API Key 時顯示設定表、而且連 iframe 都沒建立」、取回設定時
  只打宿主那一條路由、倒數期間不建立 iframe，以及重置的兩段式確認。
* `secrets.js` 斷言遮蔽公式與 ntfy-teams 一字不差、真實回應的欄位名認得出來，
  而且回給瀏覽器的任何欄位都不含金鑰原文。

## iframe 的狀態保持（切面板不重開）

| 動作 | iframe 會重載嗎 | 為什麼 |
|---|---|---|
| 切到「對話」再切回「管線看板」 | **不會** | iframe 是 module 級單例，切走時 `parkFrame()` 把它停到畫面外的停放區（`visibility:hidden`），切回來 `navigateFrame()` 發現網址沒變就只搬回去 |
| 在面板裡操作、看別的專案 | 不會 | 那是應用自己的 SPA 路由，與 iframe 的 `src` 無關 |
| 面板重新掛載 | 不會 | 重新掛載時跳過狀態查詢，且同一網址不再指派 `src` |
| 按底部「重新整理」 | 會（那是你要的） | `reloadFrame()` 用同一網址再走一次導覽 |
| 換 API Key 或改路徑 | 會（那是你要的） | 網址真的變了 |
| **瀏覽器 F5／重整頁面** | **會** | iframe 活在文件裡；文件沒了它就沒了，只能重新登入 |
| 停用外掛再啟用 | 會 | `destroyFrame()` 真的拆掉單例 |
| 切換側邊欄「收合／展開」 | 不會 | 與面板內容無關 |

所以：**同一次瀏覽階段內，切來切去不會重新打開**；只有整頁重整才會。
如果連重整都想自動回到上次看的那一頁，那是另一個功能（記住最後路徑 + 重整後
自動帶回），目前刻意沒做 —— 它需要在瀏覽器存一個非機密的路徑，並且每次帶入
都會多走一次登入端點（會消耗金鑰的一次請求配額）。

## 「從遠端取回設定」怎麼走

```
面板 ──POST /plugins/kaneo-web/restore──▶ 宿主
                                          │ 1. ctx.credentials / .credentials.yaml
                                          │      取得 AIFE_API_KEY（或 FEG／DEEPSEEK）
                                          │ 2. mask = "sk-" + base64(key + "@" + ISO)
                                          │ 3. POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/kaneo
                                          │      body {"apiKey": "<mask>"}
                                          │ 4. 拿回的金鑰先對登入端點做一次預檢
                                          ▼
面板 ◀── { candidates, fields, check, raw } ── 宿主收束回應
```

* 遠端位址與遮蔽金鑰**都留在宿主**：瀏覽器只看得到 `/plugins/kaneo-web/restore`，
  bundle 裡沒有任何絕對網址。
* 回傳的候選值會帶進 API Key 欄位；多個候選時列成 chip 讓使用者點選
  （金鑰原文不渲染在畫面上，只有長度與欄位名）。
* 遠端回 `200 {}`（格式對但沒有資料）時，面板會明確說「遠端沒有回傳可用的
  API Key」並攤開原始回應 —— 這是實測最常見的失敗，它長得跟成功一樣。

### 實測的形狀與契約

完整契約（我們送什麼、接受哪些欄位名、值要長什麼樣、各種失敗的回應）寫在
[`docs/remote-storage-payload.md`](docs/remote-storage-payload.md)。要點：

```json
// 我們送出：{"apiKey": "sk-<base64(原文 + '@' + ISO)>"}
// 實測回來（2026-10-15）：
{ "REDIRECT_URL": "/dashboard",
  "API_KEY": "gIlrWGIb…64 字元…" }
```

* **API Key 的欄位名**（大小寫不敏感、忽略 `_ - .`）：`apiKey`/`api_key`/`apikey`、
  `key`、`token`/`accessToken`/`access_token`、`secret`、`apiKeyValue`、`value`。
  值要是**非空字串**（number 會轉字串），內容不做格式檢查。
* **路徑欄位**：`redirect`/`redirectUrl`/`redirect_url`/`path`，只接受 `/` 開頭
  且非 `//` 的站內路徑；不合法就整個丟掉。
* **可以包在巢狀裡**：頂層、`data`/`settings`/`value`/`result`、以及 `data.<其一>`。
* 多個金鑰欄位命中時**全部**收成候選，讓使用者點選。
  這一條與大小寫不敏感都是踩出來的 —— 第一版用大小寫敏感的短清單，
  真實回應明明有值卻收不到任何候選。

### 預檢（`check`）

換回金鑰之後，宿主會對登入端點發一次 `GET`（`redirect: 'manual'`，不跟隨轉址），
把結果收成 `check: { status, verdict }`：

| verdict | HTTP | 意思 |
|---|---|---|
| `ok` | 302 | 金鑰可以登入（這正是載入 iframe 時會發生的事） |
| `invalid` | 401 | `INVALID_API_KEY`：不屬於這個實例／已停用／已過期 |
| `forbidden` | 403 | 帶權限範圍的金鑰，或該部署只允許管理員 |
| `not-enabled` | 404 | 該部署沒開 `API_KEY_SIGN_IN` |
| `rate-limited` | 429 | 命中限流 |

**為什麼要預檢**：遠端儲存端點給的金鑰不一定屬於這個實例。實測一開始拿到的那把
就被以 **401 拒絕**（端點本身是通的 —— 缺 `key` 時回 400 `VALIDATION_ERROR`，
那是這個端點獨有的行為；`POST` 它則回 404，因為插件只定義 GET）。
沒有預檢的話，使用者只會看到一個空白 iframe，無從分辨「金鑰不對」與
「嵌入被擋」。現在面板會直接說「遠端金鑰被拒絕（401 INVALID_API_KEY）」。
後來換上的那把金鑰預檢回 **302 `ok`**，我才把整條成功路徑驗完。

## 已知限制

* **宿主半邊改過程式碼之後要重啟 DSH Web 才會生效**。宿主模組是行程啟動時載入
  並快取的；瀏覽器半邊（`lib/client.js`）則是每次頁面載入都從磁碟重讀。
* 金鑰以明文存在 profile 的 `cordis.patch.yml`（權限 0600，和這個 harness
  存其他設定同一處）。要改成憑證庫（`ctx.credentials`，`$DSH_HOME/.credentials.yaml`）
  是後續工作。
* 「連結直接登入」的固有效應：金鑰會短暫出現在 iframe 的初始 URL 與瀏覽器歷史裡
  （302 之後就被 `/dashboard` 取代）。這是這個方案本身無法消除的，`Kaneo-API-Key.md`
  第 5 節也明說；`Referrer-Policy: no-referrer` 用來降低外洩機會。
* 會話級 cookie（無 `Max-Age`，DB 會話 1 天）：所以整頁重整後 iframe 會重新登入一次
  —— 它會自動完成，不必手動輸入。
* `https://pl.feg.cn` 沒有送 `X-Frame-Options` 或 `frame-ancestors`，所以
  目前**可以**被 iframe 嵌入；對方哪天加上就會變空白，面板會提示這一點。
