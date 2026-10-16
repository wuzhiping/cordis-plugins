# dsh-minio-s3

DSH 外掛：**遠端 MinIO / S3 桶的檔案讀寫管理**。對話區多一個「MinIO」頁籤（列桶、
逐層瀏覽、預覽、下載、上傳、新建資料夾、改名、批次刪除、複製簽章連結），對話裡
則多五個 `minio_*` 工具，讓 agent 直接管理桶裡的物件，並在「工作區檔案 ↔ 物件」
之間搬移。

連線不是設定檔，而是查出來的：用本機 `refs.AIFE_API_KEY` 依 `MASK.md` 遮蔽後
`POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/s3`，換回端點、帳密與預設桶
（與 `ntfy-teams`、`ov-memory`、`kaneo-web` 同一條路）。**端點與帳密只存在宿主
行程的記憶體裡**，瀏覽器半邊拿到的只有相對路徑、桶名與 object key。

面板上**只顯示「MinIO」這個標題**：連線來源（BDD storage 端點）、region、憑證 ref
與原始錯誤訊息都不進 DOM（面板是會被截圖與分享的）。連線失敗時面板只說
「本機憑證不可用／連線服務查詢失敗／連線服務沒有可用的資料／連線設定不可用」；
要看細節請用 `GET /plugins/dsh-minio-s3/status?debug=1`（回 `region`、`ref`、
`source`、`detail`）或宿主日誌。回給瀏覽器的錯誤訊息也會把內網端點洗成「遠端儲存」。

```
cordis-plugins/dsh-minio-s3/
├── src/
│   ├── index.js       # Loader 入口：12 條同源路由 + 5 個 agent 工具（原 host.js）
│   ├── storage.js     # 遮蔽金鑰 → BDD storage 查詢 → ConnectionProvider（快取 + region + 端點邊界；原 connection.js）
│   ├── s3.js          # S3/MinIO REST 客戶端（path-style、SigV4、XML；原 s3-client.js）
│   └── core.js        # 純函式：SigV4 簽章、XML 解析、key 路徑工具（原 s3-core.js）
├── client/
│   ├── index.js       # 瀏覽器半邊原始碼（conversation.view「MinIO」tab）
│   └── bundle.js      # 由 scripts/build-client.mjs 產生，勿手改
├── scripts/build-client.mjs
├── scripts/live-check.mjs
├── test/              # 55 個離線測試（含一個記憶體假 MinIO）
├── cordis.patch.yml
└── package.json
```

## 資料通道

宿主開 12 條同源路由（全部先過 `ctx.connection.requestRejection` 那道信任柵欄，
與 `dsh-file-share` 的 zip 路由同一道）：

| 方法 | 路徑 | 作用 |
| --- | --- | --- |
| GET | `/plugins/dsh-minio-s3/status` | 連線狀態、預設桶、桶清單（**不回端點、帳密、region 或連線來源**；`?debug=1` 才回 `region`/`ref`/`source`/`detail`） |
| POST | `/plugins/dsh-minio-s3/refresh` | 丟掉連線快取並重查 BDD storage |
| GET | `/plugins/dsh-minio-s3/buckets` | 列桶 |
| PUT | `/plugins/dsh-minio-s3/buckets?bucket=` | 建立桶 |
| DELETE | `/plugins/dsh-minio-s3/buckets?bucket=` | 刪除桶（僅空桶） |
| GET | `/plugins/dsh-minio-s3/objects?bucket=&prefix=&token=&delimiter=/` | 一層列表（folders + objects） |
| GET / HEAD | `/plugins/dsh-minio-s3/object?bucket=&key=` | 下載（`inline=1` 供預覽）／**支援 `Range` 斷點續傳**（206/416 + `Accept-Ranges`）／刪除單一物件 |
| PUT | `/plugins/dsh-minio-s3/object?bucket=&key=` | 單次 PUT 上傳（≤ 256 MB；大檔走下面的 multipart） |
| POST | `/plugins/dsh-minio-s3/delete` | 批次刪除 `{bucket, keys[]}`（逐 key 失敗會自動退回單物件刪除） |
| POST | `/plugins/dsh-minio-s3/upload/init` | 開始或**接手** multipart 上傳 `{bucket, key, size, contentType?}` → `{uploadId, partSize, partCount, resumed, parts}` |
| PUT | `/plugins/dsh-minio-s3/upload/part?bucket=&key=&uploadId=&partNumber=` | 上傳一片（body ＝ 該片位元組，≤ 64MiB）→ `{partNumber, size, etag}` |
| POST | `/plugins/dsh-minio-s3/upload/complete` | 收尾 `{bucket, key, uploadId, parts:[{partNumber, etag}]}` → `{etag, location, size}` |
| POST | `/plugins/dsh-minio-s3/upload/abort` | 放棄上傳（清掉伺服器上的片） |
| GET | `/plugins/dsh-minio-s3/upload/status?bucket=&key=` | 未完成的上傳與已收到的片（續傳對帳用） |
| POST | `/plugins/dsh-minio-s3/folder` | 建立資料夾標記 `{bucket, key: "a/b/"}` |
| POST | `/plugins/dsh-minio-s3/copy` | 伺服器端複製 `{bucket, fromKey, toKey}`（改名 = copy + delete） |
| GET | `/plugins/dsh-minio-s3/presign?bucket=&key=&expires=` | 產生簽章連結（1 小時預設，最長 7 天） |
| POST | `/plugins/dsh-minio-s3/upload-path` | 工作區檔案 → 物件 `{sessionId, bucket, key\|prefix, path}` |
| POST | `/plugins/dsh-minio-s3/download-path` | 物件 → 工作區檔案 `{sessionId, bucket, key, path}` |
| POST | `/plugins/dsh-minio-s3/export` | **唯一**會把端點與金鑰送進瀏覽器的路徑：回一份可直接使用的 JSON（見下） |

`upload-path` / `download-path` 用 `resolveInWorkspace` 做四層邊界檢查：詞法（不得
絕對路徑、不得 `..`）→ `path.resolve` → **逐段 `lstat`，任何既有的符號連結一律
拒絕** → `realpath` 檢查最近存在的祖先。

第三層是補上來的：`fs.existsSync` 對**斷掉的**符號連結回 `false`，所以「往上找最近
存在祖先」會直接走過那個連結、檢查通過，接著 `writeFileSync` 就順著連結把檔案寫到
工作區外。既有的連結與既有的目標會被第四層擋下，只有「目標還不存在的連結」會漏
—— 而那正好是寫入路徑的形狀（`test/host.test.js` 有兩個回歸案例）。

### 端點邊界（SSRF）

`S3_URL` 來自人工維護的 storage 記錄，而宿主會對它發出**帶簽章的**請求，並在每個
新連線上發一次未簽章探測。所以 `normalizeEndpoint` 會：

- 只接受 `http`/`https`（`ftp://…` 這類明確 scheme 直接拒絕，不去猜）；
- 拒絕 link-local `169.254.0.0/16` 與 `metadata.google.internal` 這類雲端 metadata 位址；
- 設定 `DSH_MINIO_S3_ALLOWED_HOSTS=minio.internal,10.17.26.8` 時，只放行名單內的主機。

（這台部署用的是 `http://10.17.26.8:7000`，內網 http 是刻意的；憑證本身永遠不會
被送到別處，但「對任意主機發出已簽章請求」本身就是能力，所以不讓它任意指定。）

### 「複製設定」（`POST /export`）

面板右上角的「❗️ 複製設定」把連線事實一次複製成 JSON，可以直接貼進另一個工具
（`mc`、AWS SDK、另一個 profile 的設定檔）：

```json
{
  "provider": "minio",
  "endpoint": "http://10.17.26.8:7000",
  "accessKey": "admin",
  "secretKey": "…",
  "region": "us-west-rack-2",
  "bucket": "dsh",
  "usePathStyle": true,
  "forcePathStyle": true,
  "buckets": ["abc", "agi", "…"],
  "exportedAt": "2026-10-16T12:58:00.000Z"
}
```

`region` 是**探測後**的值（不是預設 `us-east-1`），`bucket` 是 storage 記錄裡的預設桶，
兩個 `…PathStyle` 欄位同時給出 `mc`/SDK 兩種常見命名。實測：用這份 JSON 另開一個
`S3Client` 可以直接列桶與列物件。

安全立場：這是全外掛**唯一**把端點與金鑰送進瀏覽器的地方，而且

- 只在面板上明示按下時發生（`POST` + `X-DSH-MinIO-S3: export` 專用標頭 —— 「簡單
  請求」帶不出自訂標頭，跨站就得先過預檢，而信任柵欄本來就會拒絕外來 Origin）；
- 回應 `cache-control: no-store`，宿主日誌只記「有人匯出過」，**不記內容**；
- `DSH_MINIO_S3_NO_EXPORT=1` 可以整個關掉這條路徑（維運斷路器，回 403）；
- 平常這些欄位不出現在畫面、DOM、或任何其他回應裡（`/status` 要 `?debug=1` 才有，
  而且只有端點與 region，**沒有金鑰**）；
- 浮層會把 JSON 攤開顯示並標明含金鑰，剪貼簿被擋時仍可手動全選複製；
- 擋不掉同源腳本（面板上另一個外掛的 bundle、瀏覽器擴充功能）；那需要 CSP，不在
  外掛手上 —— 所以按鈕的 tooltip 與浮層都明說這是含金鑰的複製。

### 回應的硬化

- **`inline=1` 只放行點陣圖**（png/jpeg/gif/webp/avif/bmp/ico）：這個代理回應與
  DSH 同源，而外殼沒有 CSP，讓 `text/html` 或 `image/svg+xml` inline 出去等於在應用
  來源上跑任意腳本。其餘型別一律降成 `application/octet-stream` + `attachment`，
  並補 `x-content-type-options: nosniff`。
- **下載在瀏覽器端串流**：`<a download>` 直接抓同源網址，不再 `fetch` + Blob（那會
  把整個物件放進分頁記憶體，多 GB 的物件直接弄死分頁）。
- **客戶端斷線就中止上游**：`req.on('close')` → `AbortController`，串流途中等
  `drain` 也會 race `close`（destroyed response 永遠不會發 `drain`）。
- **時間預算只管到「收到標頭」**：`AbortSignal.timeout()` 會在整個 body 傳輸期間繼續
  計時，所以改成自控的 `AbortController`，`fetch()` 一解析出標頭就 `clearTimeout`
  —— 否則任何超過 30 秒的下載都會在串流中途被切斷。上傳沒法和連線階段分開，所以
  超過 8MB 的 PUT 直接不計時，改由呼叫端的 signal 界定。
- **工具會轉送 `exec.signal`**：取消一個工具呼叫會真的中止 S3 請求；`toPath`
  寫檔前會再檢查一次 `aborted`，不留半套檔案。

### agent 工具（宿主平面註冊，整個 profile 的會話都看得到）

| 工具 | 參數 | 說明 |
| --- | --- | --- |
| `minio_list` | `bucket?`, `prefix?`, `recursive?`, `max?` | 省略 bucket 就列桶；`recursive` 列出前綴下所有物件 |
| `minio_read` | `bucket`, `key`, `toPath?`, `maxBytes?`, `encoding?` | 預設回文字（上限 256KB，可調到 4MB）；`toPath` 存進工作區 |
| `minio_write` | `bucket`, `key`, `content?`, `fromPath?`, `encoding?`, `contentType?` | 行內內容或工作區檔案；key 以 `/` 結尾＝建資料夾 |
| `minio_delete` | `bucket`, `key?`, `keys?` | 一次最多 1000 個 key |
| `minio_bucket` | `action`, `bucket?` | `list` / `create` / `delete` |

## 三個非顯而易見的地方

### 1. MinIO 的 region 必須「主動」問出來

MinIO 以自己設定的 region 驗簽，這台是 `us-west-rack-2`。它對**一般簽章請求寬容**
（region 填 `us-east-1` 的 GET/PUT/HEAD 照收），所以列物件、上傳、下載都會成功 ——
但 **presign 與 `POST ?delete` 嚴格驗 region**：

- presign：直接 `400 AuthorizationHeaderMalformed`；
- 批次刪除：**HTTP 200**，但在 DeleteResult 裡逐 key 回
  `AuthorizationHeaderMalformed ... expecting 'us-west-rack-2'`。

症狀因此是「列表正常、預覽正常，簽章連結與批次刪除忽然失敗」。修法有兩層：

1. `S3Client.probeRegion()`：對端點發一次**未簽章** `GET /`，MinIO 的
   `403 AccessDenied` 文件裡帶 `<Region>`，一次便宜請求就把 region 定下來
   （AWS S3 的同一個回應不含 Region，會退回預設值）。`ConnectionProvider` 在
   每次解析出連線後呼叫它，並把結果留在 provider 上 —— 因為每個 `/api` 請求都
   會新建一個 `S3Client`，region 只留在 client 上的話下一個請求就忘了。
2. 保底：`send()` 對頂層 region 錯誤學起來重試一次；`deleteObjects()` 另外檢查
   「200 但逐 key 是 region 錯誤」並重試一次。

### 2. 自己寫 SigV4，但用官方向量釘住

外掛沒有執行期依賴：`@aws-sdk/client-s3` 的整棵依賴樹換成 `s3-core.js` 裡約 200 行
HMAC 鏈（離線、可審計）。代價是**最容易寫錯的地方沒有型別保護**，所以
`test/s3-core.test.js` 用 AWS 官方文件的三個向量（GET object、PUT object、presign）
把 canonical request 的形狀釘死。實際踩到的坑：canonical headers 區塊**每一行**
（含最後一行）都以 `\n` 結尾，因此它與 SignedHeaders 之間有一個空行；少了那個空行
時本地一切正常、簽章卻永遠對不上。

### 3. 只有 `+` 與 `%20` 的差別會讓 key 對不上

`ListObjectsV2` 一律帶 `encoding-type=url`，而 MinIO 用 `url.QueryEscape` 編碼：
空白 → `+`、`+` → `%2B`。`decodeURIComponent` 不認 `+`，少了這一步，key
`hello world.txt` 會列成 `hello+world.txt` —— 一個「看起來對、點下去 404」的 key。
`s3-core.parseListObjectsV2` 先 `+ → 空白` 再 `decodeURIComponent`；測試同時釘住
「key 裡真的有 `+`」的情形。

其他一起踩到、也已進測試的細節：`POST ?delete` 需要 `Content-MD5`（MinIO 沒收到會
拒絕）；`DeleteObjects` 的 `<Key>` 是**原字串 XML 轉義**而不是 URL 編碼（編碼過會
刪到不存在的 key 且回 200）；`x-amz-copy-source` 要**以 `/` 開頭**且 key 依 URL 規則
編碼。

## 安裝、卸載與熱重載

```
plugin_manager action=install_bundle target=C:\Users\shawoo\Desktop\feg.cn\cordis-plugins\dsh-minio-s3
plugin_manager action=remove_bundle  target=dsh-minio-s3
```

`install_bundle` 會把它加進 profile 的 `dependencies`（`link:` 到本目錄）與
`dsh.profile.bundles`；`cordis.patch.yml` 的 `insert` 負責把 Loader 行掛上。

> **改宿主半邊的程式碼之後，必須重啟 DSH 才會生效。**
> 實測（2026-10-16）三種做法都無效：`set_plugin enabled=false/true`、
> `remove_bundle` + `install_bundle`，以及**把四個模組改成全新檔名**
> （`src/index.js` / `storage.js` / `s3.js` / `core.js` —— Node 的快取以解析後路徑
> 為 key，但 Loader 在行程內保留已 import 的模組物件，所以連新路徑也不會重新讀）。
> 三者的回報都是 `application: applied`，但活動行程仍執行第一次掛載時的模組。
> 要讓它生效只有兩條路：**重啟 DSH**（`harness.ps1` → `dsh web …`），或改動
> **套件名稱**（specifier 換了才會重新 import，但那等於換一個外掛）。
> **瀏覽器半邊沒有這個限制**（`client-hmr`）——改 `client/index.js` 後跑
> `npm run build:client`，頁面重新整理即可。
>
> 判斷線上跑的是哪一版：`GET /plugins/dsh-minio-s3/status` 的 `version` 欄位。
> 舊模組沒有這個欄位（`version: undefined`），且 `region` 會停在 `us-east-1`；
> 那一刻按「❗️ 複製設定」會得到 **HTTP 405**（路由還不存在），面板會直接說
> 「宿主外掛還沒重新載入，請重啟 DSH 後再試」。

## 測試與實機驗證

```powershell
cd cordis-plugins/dsh-minio-s3
npm run check        # node --check 五個檔案
npm test             # 55 個離線測試
npm run build:client # 由 client/index.js 產生 client/bundle.js
npm run live         # 對「正在運行的宿主外掛」做一次實機檢查（見下）
```

`npm run live`（`scripts/live-check.mjs`）不碰憑證、不經 cordis，只打活動宿主上的
`/plugins/dsh-minio-s3/*`：列桶 → 上傳 → 列表 → 下載 → presign → 批次刪除 →
清理。它在桶裡只建立 `_dsh_minio_s3_livecheck/` 底下的臨時物件。**重啟 DSH 之後
跑它，就能確認 region 修正真的生效**（舊模組會停在 `region us-east-1`，presign
與批次刪除會 FAIL）。

`test/host.test.js` 把整個外掛掛在假的 cordis ctx 上，並用**記憶體裡的假 MinIO**
驅動物件生命週期、桶管理、路徑邊界（含斷掉的 symlink）、信任柵欄、`inline` 白名單、
`/export` 的三道限制與五個工具 —— 不打任何網路。

實機（真 MinIO `10.17.26.8:7000`，桶 `dsh`）驗證過的項目：

| 驗證 | 方式 | 結果 |
| --- | --- | --- |
| 連線解析 | BDD storage `/dsh/storage/s3` + `refs.AIFE_API_KEY` 遮蔽 | 回 `http://10.17.26.8:7000`、`admin`、預設桶 `dsh` |
| 列桶 / 物件 / 上傳 / 下載 / 預覽 / 複製 / 批次刪除 / presign | 直接驅動 `S3Client`（`dsh` 桶 `_dsh_minio_s3_probe/`） | 全數通過，測試物件已清除 |
| region 修正 | 新行程：探測→`us-west-rack-2`→presign 200、批次刪除無逐 key 錯誤、新 client 沿用 | 全數通過 |
| 「MinIO」頁籤註冊 | Client `Slots.listSubTree(root=conversation.view)` | `dsh-minio-s3` 為 active 佔位（與 chat/trajectory/jeeflow 並列） |
| 客戶端 bundle 供應 | 讀 `http://127.0.0.1:3080/` 的模組清單，再抓 `plugins/??dsh-minio-s3/client.js&rev=…` | 200，內容含 `__ModuleLoader__` 與頁籤註冊 |
| 五個工具 | 直接呼叫 `minio_bucket` / `minio_read` / `minio_write` / `minio_list` / `minio_delete` | 已回真實資料，且 `Tool.listTools` 中各只出現一次 |
| 路由 | 對活動中的 host 打 `/status`、`/objects`、`/object`、`/delete` 等 | 掛載成功；`/status` 不回端點與帳密 |
| 路由（新模組） | `npm run live` | **等 DSH 重啟後**才會全綠：目前活動行程載入的是第一次掛載的舊模組（`version: undefined`、`region: us-east-1`），因此 `/presign`、`POST /delete` 與 `POST /export` 仍會失敗 —— 修正已在磁碟上並由新行程驗證通過 |
| 「複製設定」匯出 | 新行程直接驅動 `POST /export`（真 MinIO）；再用匯出的 JSON 另開 `S3Client` | 全過：`endpoint`/`accessKey`/`secretKey`/`region=us-west-rack-2`/`bucket=dsh`/桶清單，且複製出去的值真的能列桶與列物件 |
| 傳輸時間預算 | 假 fetch：標頭 30ms 到、body 分 5 段滴完（總時長超過預算）；9MB PUT vs 小 PUT | 慢速 body 完整收完；大 body 不套預算而成功、小 body 仍照預算逾時 |
| 硬化（見「回應的硬化」） | 離線測試：`inline` 白名單（png 放行、svg 降級）、`x-content-type-options`、斷掉的 symlink、metadata 端點、`/export` 的三道限制、`exec.signal` | 全過（`npm test`，55 個） |

## 已知限制

### 面板顯示「dsh-minio-s3: import failed」或整個頁籤消失

2026-10-17 實際發生過一次，原因與處置：

1. **產物壞掉**：外掛的 CSS 寫在 `client/index.js` 的 template literal 裡，註解中只要出現
   一個反引號，字串就提前結束 → `client/bundle.js` 語法錯誤 → 瀏覽器只說
   「import failed」，整個面板開不起來。
   **現在有兩道防呆**：`npm run build:client` 會先解析產物，壞的就**不寫檔**（保留上一份
   可用的）並以非 0 結束；`test/client-bundle.test.js` 也會盯產物（`npm test`）。
2. **外掛被外殼從 profile 移除**：client 半邊載入失敗後，profile 的
   `package.json`（`link:` 依賴 + `dsh.profile.bundles`）會少掉這個 bundle，於是 loader
   清單裡完全沒有它。恢復方式（本機路徑）：

   ```
   plugin_manager install_bundle C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/dsh-minio-s3
   ```

   它會補回依賴、bundle 條目、`node_modules` 連結並立即套用（**不用重啟**，client 半邊
   會拿到新的 rev）。驗證方式：看 `/` 的 `__DSH_BOOT__` 是否含
   `{id:"dsh-minio-s3", url:"plugins/??dsh-minio-s3/client.js&rev=…"}`，且那個 URL 回 200。

- **空資料夾的標記**：S3 沒有真正的資料夾，空資料夾是一個 key 以 `/` 結尾的 0 位元組物件
  （`docs/`）。列根目錄時 MinIO 把它放在 `CommonPrefixes`（顯示為資料夾）；但列 `docs/`
  自己時，它的 key 等於前綴，MinIO 會放進 `Contents` —— 面板與工具會**濾掉 key === 前綴
  的那一筆**，否則空資料夾裡會冒出一個 0 位元組的同名檔案。真的 0 位元組檔案不受影響。
- **斷點續傳：下載、上傳、面板全都支援了**（Phase 1–3 完成；Phase 4 的 presigned 直傳未做）。
  實作與真機實測見 [`docs/resumable-transfer.md`](docs/resumable-transfer.md)。
  - **下載（外掛 + skill 都有）**：`/object` 轉發 `Range` → `206` + `Content-Range` +
    `Accept-Ranges`；越界 → `416` + `Content-Range: bytes */size`；**`If-Range` 由宿主自己
    比對**（實測 MinIO 會忽略它，若照它走，物件被覆寫時續傳會拼出壞檔）。`minio.mjs get
    --continue` 以本地檔大小續傳、串流寫檔，完成後單片物件驗 MD5。
  - **上傳（skill 與面板都有）**：S3 multipart，`partSize`
    預設 8MiB（自動放大以滿足「片數 ≤ 10000」），預設 3 片併發、逐片 3 次退避重試、逐片
    比對 MD5；中斷後同一行加 `--resume` 只補缺的片。驗證用**複合 ETag**
    （`md5(各片 md5 串接)-片數`），因為 multipart 的最終 ETag 不是物件 MD5。
  - **面板上傳（已接 multipart）**：> 32 MB 自動走 multipart（每檔 3 片併發、逐檔進度條、
    **暫停／繼續／取消**），> 256 MB 不再是上限；≤ 32 MB 仍走單次 PUT（最快）。中斷或關掉
    頁面後，**重新選同一個檔案上傳就會續傳**（伺服器接手，面板會顯示「已收到 N 片」）；
    工具列下方另有「未完成的上傳」清單，可一鍵放棄。舊宿主（未重載）沒有 multipart 路由時
    會自動退回單次 PUT，> 256 MB 則明說要重啟 DSH。
  - **面板下載**：由瀏覽器自己的下載 UI 顯示進度，且因為已有 `Accept-Ranges` 而能自動續傳；
    面板內自製的下載進度條（可直接寫檔、可暫停）不在目前範圍。
  - 記憶體：宿主上限 256 MB（單次 PUT）／每片 64 MiB（multipart）；`minio.mjs` 的
    `get`／`upload` 都是串流，只有 `cat` 有 64 MiB 緩衝上限。
- **`S3 單次 PUT` 上限 5 GB、multipart 上限 5 TB**；本外掛宿主端單片上限 64 MiB，
  因此單一物件上限約 640 GB（10000 × 64 MiB）—— 超過就回 400 並說明。
- **時間預算只管到標頭**：下載沒有總時長上限；超過 8MB 的上傳不套預算，若連線或端點
  卡住，只能靠呼叫端（工具的 `timeoutMs`、或瀏覽器關掉連線）中止。
- **列表只做一層**：`delimiter=/` 的一頁（最多 1000 個 key）。UI 只提示「已截斷」，
  沒有接 `nextToken` 翻頁；工具可以自己傳 `prefix`／`recursive` 縮小範圍。
- **改名 = 複製 + 刪除**：S3 沒有 rename；兩步之間失敗會留下兩份，UI 會顯示錯誤。
- **刪除是永久的**：沒有垃圾桶、沒有版本控制。
- **桶的建立沒有 `LocationConstraint`**：由伺服器決定 region；若某個 MinIO 部署
  要求 `LocationConstraint`，這裡需要補。
- **面板不顯示連線細節**（刻意的）：端點、region、BDD storage 路徑、憑證 ref 都
  不出現在畫面與 `/status` 的預設回應裡；除錯走 `?debug=1`、匯出走 `/export`（含
  金鑰，需明示按下）、關閉走 `DSH_MINIO_S3_NO_EXPORT=1`。
- **`/object` 的 `inline=1` 不給 HTML/SVG**（刻意的，見上）。
