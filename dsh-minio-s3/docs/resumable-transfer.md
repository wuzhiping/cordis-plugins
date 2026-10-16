# 大檔案斷點續傳：上傳與下載方案詳解

> 狀態：**Phase 1（下載）與 Phase 2（multipart 上傳：宿主 + skill）已實作並在真機驗證**；
> **Phase 3（面板 UI）與 Phase 4（presigned 直傳）尚未實作**。實作與設計的落差記在
> 每節的「實作狀態」與文末 §9。
>
> 標「實測」的數字與 XML 形狀都是 2026-10-16 對真機 MinIO（`http://10.17.26.8:7000`，
> region `us-west-rack-2`，桶 `dsh`）跑出來的：探針 `.verify/multipart-probe.cjs`、
> 路由驗證 `.verify/range-live.cjs`、上傳續傳驗證 `.verify/upload-live.cjs`。
> 全部走外掛的 `ConnectionProvider`，憑證不落檔。

---

## 0. TL;DR

| 問題 | 現況 | 方案 | 工作量 |
|:--|:--|:--|:--|
| 下載中斷要從 0 重來 | 宿主路由不轉發 `Range`，一律 `200` + 完整內容 | 轉發 `Range` → `206`/`416` + `Accept-Ranges`/`Content-Range`/`If-Range`；`minio.mjs get --continue` 串流續寫 | **Phase 1，約半天** |
| 上傳 >256MB 直接失敗、中斷要整包重傳 | 單次 `PUT`、整包進宿主記憶體 | S3 multipart（`CreateMultipartUpload`/`UploadPart`/`ListParts`/`CompleteMultipartUpload`/`AbortMultipartUpload`）＋ 面板分片上傳與續傳狀態 | **Phase 2+3，約 2.5 天** |
| 位元組兩次經過宿主 | 上傳與下載都經宿主轉發 | 可選 Phase 4：presigned `UploadPart` 讓瀏覽器**直打 MinIO**（**實測可行**，但需要 MinIO CORS，且金鑰立場要重新決定） | Phase 4，約半天 |

---

## 1. 現況與限制（實測）

```
透過外掛路由： Range: bytes=0-9  → HTTP 200, content-length: 105567   ← Range 被忽略
直接對 MinIO： Range: bytes=0-9  → HTTP 206, Accept-Ranges: bytes,
                                   Content-Range: bytes 0-9/105567   ← 上游本來就支援
```

| 路徑 | 記憶體 | Range | multipart | 上限 |
|:--|:--|:--:|:--:|:--|
| 外掛 `GET /object` | 串流（不落地） | ✗ | — | 無 |
| 外掛 `PUT /object` | 整包 | — | ✗ | 256 MB |
| `upload-path` / `download-path` | 整包 | ✗ | ✗ | 512 MB |
| `minio.mjs get` / `put` | 整包（`arrayBuffer` / `readFileSync`） | ✗ | ✗ | 單次 PUT 5 GB |

**目標**：①大檔不再受宿主記憶體限制；②中斷（網路、瀏覽器關掉、面板重整、工具被取消）
之後能從中斷點接上；③不破壞現有呼叫端（沒有 Range／沒有 multipart 的請求行為不變）。

**非目標**：跨 session 的共享續傳狀態、多物件批次續傳、客戶端加密、tus 協議。

---

## 2. 下載斷點續傳

### 2.1 需要的 HTTP 語意（RFC 7233）

| 情境 | 回應 |
|:--|:--|
| 無 `Range` | `200` + 完整內容 + `Accept-Ranges: bytes` + `Content-Length` |
| `Range: bytes=a-b` | `206` + `Content-Range: bytes a-b/size` + `Content-Length: b-a+1` |
| `Range: bytes=a-` | `206` + `Content-Range: bytes a-(size-1)/size` |
| `Range` 越界（`a >= size`） | `416` + `Content-Range: bytes */size` |
| `If-Range: <etag>` 與目前物件不符 | 忽略 Range，回 `200` 全量（**這是續傳安全性的關鍵**） |
| 多段 Range（`bytes=0-9,20-29`） | 不回 `multipart/byteranges`，一律降級成 `200` 全量（簡化，實務上沒人用） |

`If-Range` 是重點：中斷後本機已有前 N 個位元組，若這期間物件被換掉（同名覆寫），
續傳會拼出一個前後不一致的檔案。正確做法是續傳時帶 `If-Range: <當初的 ETag>`，
不符就整份重下。

### 2.2 宿主路由改造（`src/index.js` 的 `handleObject`）

```js
// 取得 upstream 之後
const range = req.headers.range
const ifRange = req.headers['if-range']
const etag = upstream.headers.get('etag')                     // 已存在
const size = Number(upstream.headers.get('content-length'))

if (range && (!ifRange || ifRange === etag)) {
  // 讓 S3 自己算：把 Range 交給上游（我們已實測 MinIO 支援）
  const upstream = await s3.getObject({ bucket, key, range, stream: true })
  headers['content-range'] = upstream.headers.get('content-range')
  res.writeHead(206, headers)
} else if (range) {
  // If-Range 不符 → 全量（不要用 206，否則客戶端會把新內容接到舊檔案後面）
  res.writeHead(200, headers)
}
headers['accept-ranges'] = 'bytes'
if (status === 416) headers['content-range'] = `bytes */${size}`
```

要點：

- `Range` 直接轉給上游（**不要自己在宿主切片**）：S3 的 Range 是免費且精準的。
- 一定送 `Accept-Ranges: bytes`：沒有它，瀏覽器與 curl `-C -` 都不會續傳。
- `Content-Length` 在 `206` 時必須是**該段長度**，不是物件長度（現在我們照抄上游的
  `content-length`，改成 206 時要確認上游回的是段長度 —— 實測 MinIO 回的就是段長度）。
- 受影響的還有 `inline=1` 預覽（圖片瀏覽器也會用 Range）→ 同一條路徑，改一次兩邊受益。

### 2.3 瀏覽器端（面板）

| 做法 | 續傳 | 記憶體 | 適用 |
|:--|:--:|:--|:--|
| `<a download href=objectUrl>`（現況） | 交給瀏覽器（Chrome/Edge 在重試同一 URL 時會帶 `Range`） | 瀏覽器自己管 | 一般下載，零改動 |
| 面板自製分段下載 | 完全可控 | 需避免整包組 Blob | 需要進度／暫停／明確續傳時 |
| File System Access API（`showSaveFilePicker` → `createWritable`） | 可控且**直接寫磁碟** | 每段一顆 buffer | 大檔首選（Chromium） |

自製分段下載的骨架：

```js
let offset = 0, etag = null
while (offset < size) {
  const end = Math.min(offset + CHUNK - 1, size - 1)
  const response = await fetch(objectUrl(bucket, key), {
    headers: { Range: `bytes=${offset}-${end}`, ...(etag ? { 'If-Range': etag } : {}) },
  })
  if (response.status === 200 && offset > 0) { offset = 0; writer.truncate?.(0) }  // 物件換了 → 重來
  if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`)
  etag = etag || response.headers.get('etag')
  await writer.write(...)          // File System Access API：直接落磁碟
  offset += CHUNK
  setProgress(offset / size)
}
```

瀏覽器不支援 File System Access API（Firefox/Safari）時：降到 `<a download>` 讓瀏覽器
自己處理，並在 UI 說明「此瀏覽器不支援面板內續傳」。

### 2.4 `minio.mjs get --continue`

現況是 `arrayBuffer()`（整包進記憶體）。改成：

```bash
node minio.mjs get --key big.bin --out big.bin --continue
```

- 以 `--out` 現有大小為 `offset`，帶 `Range: bytes=<offset>-` + `If-Range: <本地記的 etag>`；
- 側車檔 `big.bin.dshmeta.json`（`{ etag, size }`）記住第一次抓到的 ETag；
- 伺服器回 `200`（不是 206）代表物件換了 → 覆寫整個檔（並提示）；
- 寫檔用 `createWriteStream(..., { flags: 'a' })`，**串流不落地**；
- 完成後比對大小；物件 ETag 是單片上傳的 MD5，可直接驗內容（multipart 上傳的 ETag 不是
  MD5，見 3.8）。

### 2.5 邊界情況

| 情況 | 期望 |
|:--|:--|
| 物件 0 byte | 無 Range → 200 + `Content-Length: 0`；帶 Range → 416 |
| `offset` 剛好等於 size | 不發請求，本地檔已完成（比對 ETag 後結束） |
| 傳輸中物件被覆寫 | `If-Range` 不符 → 200 全量重來（不拼錯檔） |
| 上游客戶端斷線 | 宿主已是串流，會 abort 上游並結束回應（現有行為），客戶端重試即在 |
| 伺服器不支援 Range（換成別的 S3 相容服務） | 沒收到 `Accept-Ranges` 就退回全量下載，不要無窮重試 |

---

## 3. 上傳斷點續傳（S3 multipart）

### 3.1 實測事實（真機，全部驗過）

| # | 操作 | 結果 |
|:--|:--|:--|
| 1 | `POST /<bucket>/<key>?uploads=`（CreateMultipartUpload） | `200`，XML 帶 `<Bucket>/<Key>/<UploadId>`；**UploadId 是不透明字串**（實測含 `.`、base64 字元，放進 query 一定要編碼） |
| 2 | `PUT /<bucket>/<key>?partNumber=N&uploadId=…`（UploadPart） | `200`，`ETag` = **該片的 MD5**（帶引號），與本地算的 MD5 一致（實測 `713b6329…`） |
| 3 | `GET /<bucket>/<key>?uploadId=…`（ListParts） | `200`，每片 `PartNumber`/`Size`/`ETag`；**ETag 被 XML 轉義成 `&#34;…&#34;`**，解析時要解實體 |
| 4 | `POST /<bucket>/<key>?uploadId=…`（CompleteMultipartUpload） | `200`，最終 `ETag` = `"262b96a79842aabc603b8b6e262d3d6f-2"` → **md5-of-part-md5s + `-片數`，不是物件 MD5** |
| 5 | `GET /<bucket>/?uploads=`（ListMultipartUploads） | `200`，可列出未完成的 upload → **客戶端弄丟 uploadId 也能找回**；中斷後 `ListParts` 仍回報已完成 1 片 |
| 6 | 兩片各 1MiB（非最後一片 < 5MiB）後 complete | `400 EntityTooSmall: Your proposed upload is smaller than the minimum allowed object size.` |
| 7 | **presigned `UploadPart`**（無 `Authorization`，直接 PUT） | `200` + ETag，伺服器收到 1 片 → **瀏覽器可直打 MinIO，位元組不經宿主** |

實測輸出（節錄）：

```xml
<!-- [3] ListParts -->
<Part><PartNumber>1</PartNumber><Size>5243003</Size><ETag>&#34;713b6329adcd55a46afe97b8f26ae202&#34;</ETag></Part>
<Part><PartNumber>2</PartNumber><Size>1048576</Size><ETag>&#34;3310df4c5ca4509740f3ada8d0c946c2&#34;</ETag></Part>

<!-- [4] CompleteMultipartUpload 回應 -->
<CompleteMultipartUploadResult><Location>…</Location><Bucket>dsh</Bucket>
<Key>_mp_probe/multipart.bin</Key><ETag>&#34;262b96a79842aabc603b8b6e262d3d6f-2&#34;</ETag></CompleteMultipartUploadResult>
```

### 3.2 分片規劃

```js
const MIN_PART = 8 * 1024 * 1024           // 必須 > 5 MiB（實測下限），留餘量
const MAX_PART = 5 * 1024 * 1024 * 1024    // S3 單片上限 5 GiB
const MAX_PARTS = 10000                    // S3 片數上限

function planParts(size) {
  const ideal = Math.ceil(size / MAX_PARTS)                  // 保證片數不超上限
  const partSize = Math.min(MAX_PART, Math.max(MIN_PART, ideal))
  const count = Math.max(1, Math.ceil(size / partSize))
  return { partSize, count }
}
```

| 物件大小 | partSize | 片數 |
|--:|--:|--:|
| 100 MB | 8 MiB | 13 |
| 1 GB | 8 MiB | 128 |
| 100 GB | 16 MiB | 6400 |
| 1 TB | 128 MiB | 8000 |
| 5 TB | 512 MiB | 10000 |

`partSize` 一旦決定就**必須固定**：續傳要靠「片號 × partSize」推算位移；中途改大小會
對不上已存的片。把它跟 `uploadId` 一起持久化。

### 3.3 位元組走哪條路（三種模式）

```
模式 A：宿主轉發（Phase 2 預設）
  瀏覽器 ──PUT part──▶ 宿主路由 ──sign+PUT──▶ MinIO
  優點：不碰 MinIO CORS；沿用現有信任柵欄與錯誤對映；今天就能做
  缺點：位元組兩次過宿主；宿主記憶體 = partSize（8–64 MiB，可接受）

模式 B：presigned 直傳（Phase 4 可選，實測可行）
  瀏覽器 ──POST /upload/part-url──▶ 宿主（產生 presigned PUT，10 分鐘）
  瀏覽器 ──PUT part（無 Authorization）────────▶ MinIO
  優點：宿主只簽章不搬位元組（大檔省一半流量）
  缺點：需要 MinIO 的 CORS（Origin 允許 + `Access-Control-Expose-Headers: ETag`，
        否則前端讀不到 ETag）；presigned URL 是**限時、限片**的 bearer capability，
        與本外掛「金鑰只留宿主」的立場不同 —— 必須明示決定

模式 C：混合（預設 A，設定開啟 B）
  config: uploadMode: 'proxy' | 'direct' | 'auto'
  'auto'：先探測 CORS（一次 OPTIONS），可用就直傳，否則退回 A
```

**建議**：Phase 2 先做模式 A（不引入新的安全與 CORS 變數），Phase 4 再加 B，並在
`/status` 顯示目前模式。

### 3.4 宿主路由設計（新增 5 條）

全部沿用現有 `connection.requestRejection` 柵欄與 `checkTarget` 邊界檢查。

| 方法 | 路徑 | 請求 | 回應 |
|:--|:--|:--|:--|
| POST | `/plugins/dsh-minio-s3/upload/init` | `{bucket, key, size, contentType?}` | `{ok, uploadId, partSize, partCount, mode, resumed: boolean}` |
| PUT | `/plugins/dsh-minio-s3/upload/part?bucket=&key=&uploadId=&partNumber=` | body = 該片原始位元組（≤ partSize，上限 64 MiB） | `{ok, partNumber, etag, size}` |
| POST | `/plugins/dsh-minio-s3/upload/complete` | `{bucket, key, uploadId, parts:[{partNumber, etag}]}` | `{ok, key, size, etag}` |
| POST | `/plugins/dsh-minio-s3/upload/abort` | `{bucket, key, uploadId}` | `{ok, aborted: true}` |
| GET | `/plugins/dsh-minio-s3/upload/status?bucket=&key=` | — | `{ok, uploads:[{uploadId, initiated, partSize_hint, parts:[{partNumber,size,etag}]}]}` |

`/upload/init` 的行為（續傳的關鍵）：

1. `ListMultipartUploads(prefix=key)` → 找同 key 的未完成 upload；
2. 找到就 `ListParts`：回 `resumed: true` + 已有的片（客戶端只補缺的）；
3. 找不到就 `CreateMultipartUpload`（把 `Content-Type` 帶上）；
4. 片數／大小對不上（本地檔換了）就 `Abort` 舊的、重新 init。

錯誤對映（沿用 `statusOfError`）：

| S3 Code | HTTP | 前端應該怎麼做 |
|:--|--:|:--|
| `NoSuchUpload` | 404 | uploadId 已失效（被清或已 complete）→ 重新 `init` 從頭來 |
| `EntityTooSmall` | 400 | 片太小（非最後一片 < 5 MiB）→ 檢查 `partSize` 規劃 |
| `InvalidPart` / `InvalidPartOrder` | 400 | 某片 ETag 對不上或順序錯 → 用 `ListParts` 重新同步後重傳 |
| `EntityTooLarge` | 413 | 單片超過 5 GiB |
| `AccessDenied` | 403 | 這個帳號沒有該桶的寫入權 |

### 3.5 面板狀態機

```
                 ┌──────────── init ────────────┐
                 ▼                              │
  [idle] ──選檔──▶ [planning] ──init──▶ [uploading] ──全部完成──▶ [completing] ──▶ [done]
                     │                     │  ▲                      │
                     │                     │  └── 重試（指數退避）───┘
                     │                     ├── 暫停 ──▶ [paused] ──繼續──┘
                     │                     └── 取消 ──▶ [aborting] ──▶ [idle]（AbortMultipartUpload）
                     └── 檔案比上次大/小不同 ──▶ 丟掉舊狀態，重新 init
```

持久化（`localStorage`）：`dsh-minio-s3:upload:<sha1(bucket/key/size/mtime)>`

```json
{
  "bucket": "dsh", "key": "big.bin", "size": 10737418240,
  "localMtime": 1788145371269, "uploadId": "…", "partSize": 16777216,
  "parts": { "1": "\"713b…\"", "2": "\"3310…\"" },
  "updatedAt": "2026-10-16T15:00:00.000Z"
}
```

- 面板重整／瀏覽器重開：用這個 key 找回狀態 → `GET /upload/status` 與伺服器對帳
  （**以 `ListParts` 為真相**，本地少了就補、本地多了就丟）→ 從第一個缺的片繼續。
- 找不到本地狀態但有未完成的 upload：UI 顯示「發現未完成的上傳：big.bin（已 3/640 片）」
  → 一鍵續傳或放棄（放棄＝`abort`）。
- 併發：同時 3 片（LAN 上 3–4 片已能打滿；再多只是排隊吃記憶體）。
- 面板需要顯示：已傳位元組／總量、速率、目前片號、暫停／繼續／取消。

### 3.6 `minio.mjs upload`（skill 端）

```bash
node minio.mjs upload --key big.bin --from big.bin [--part-size 16MiB] [--concurrency 3] [--resume]
```

- 讀檔用 `createReadStream({ start, end })`，**不整包進記憶體**；
- `--resume`：先 `GET /upload/status`（或直接 `ListParts`）→ 只補缺的片；本機檔的
  size/mtime 與側車檔不符就重新 init；
- 每片算本地 MD5 與回傳 ETag 比對（實測一致）→ 抓得到「片上傳成功但內容壞掉」；
- 完成後比對大小。
- 沒有 `--resume` 時行為與現在相同（單次 PUT），維持相容。

### 3.7 併發、重試、背壓

- **重試**：每片最多 3 次，指數退避（0.5s/1s/2s）＋抖動；`5xx`／網路錯誤才重試，
  `4xx` 直接回報。
- **冪等**：同 `partNumber` 重傳會覆蓋舊片（S3 語意），所以重試安全。
- **背壓**：`concurrency × partSize` 就是瀏覽器與宿主的尖峰記憶體（3 × 16 MiB ≈ 48 MiB）。
- **取消**：`AbortController` → 中止當前 PUT → `AbortMultipartUpload`（不要留垃圾）。
- **工具端**：`minio_write` 目前是單次 PUT；大檔走 skill 的 `upload` 或面板，
  或之後加 `minio_upload`（multipart）工具。

### 3.8 一致性與驗證

- multipart 的最終 ETag **不是**物件 MD5（實測 `"…-2"`）→ 不能用它比對本地 MD5。
  三個可行做法：
  1. 比對大小（最省，能抓到截斷，抓不到內容錯位）；
  2. **組複合 ETag**：`md5(concat(各片 md5 的 binary)) + "-" + 片數` —— 我們本來就
     有每片的 MD5（片上傳時算過），可以直接驗到內容層級；
  3. 附加校驗：`CreateMultipartUpload` 帶 `x-amz-checksum-algorithm: SHA256`，
     每片帶 `x-amz-checksum-sha256`，完成時由伺服器驗（MinIO 支援度要再實測）。
- 下載側：單片（非 multipart）物件的 ETag == MD5 → `minio.mjs get` 可直接驗；
  multipart 物件只能驗大小或複合 ETag。

### 3.9 清理與成本

- 未完成的 multipart upload 會**一直佔用已上傳的片**（AWS 會計費；MinIO 也佔空間）。
- 三層防護：①面板「取消」立刻 `AbortMultipartUpload`；②`minio.mjs` 失敗時 abort；
  ③建議在 MinIO 加 lifecycle：`mc ilm rule add --expire-abort-incomplete-multipart-upload-days 1 dsh`。
- 面板提供「未完成的上傳」清單（`ListMultipartUploads` 實測可用）＋一鍵放棄。

### 3.10 錯誤對映表（前端文案）

| 情境 | 顯示 |
|:--|:--|
| `NoSuchUpload` | 「這個上傳已失效，正在重新開始」→ 自動重新 init |
| `EntityTooSmall` | 「分片設定有誤（每片需 ≥ 5 MiB）」→ 這是實作 bug，記日誌 |
| `InvalidPart` | 「有一片對不上，正在與伺服器重新對帳」→ `ListParts` 後重傳缺的片 |
| 網路中斷 | 「已暫停（第 N/M 片），網路恢復後可繼續」＋「繼續」按鈕 |
| 空間不足／`QuotaExceeded` | 直接顯示 S3 訊息，不重試 |

---

## 4. 共用層：程式碼放哪

```
src/core.js     （純函式）＋  rangeHeader(offset, size, etag?)        解析/組裝 Range
                           ＋ planParts(size)                         分片規劃
                           ＋ parseListParts(xml) / buildCompleteXml() multipart XML
src/s3.js       ＋  getObject({range})（已支援 range 參數，只差回傳 206 的轉發）
                ＋  createMultipartUpload / uploadPart / listParts /
                   completeMultipartUpload / abortMultipartUpload / listMultipartUploads
src/index.js    ＋  上面 5 條 upload/* 路由；/object 加 Range 轉發
client/index.js ＋  上傳狀態機、localStorage、進度 UI、未完成清單；下載分段器
scripts/        ＋  minio.mjs get --continue / upload（skill 那份同步改）
```

`getObject` 的 `range` 參數其實**已經存在**（`s3.js` 會設 `headers.Range`），
Phase 1 只需要宿主把 `req.headers.range` 接上去 + 回應碼處理。

---

## 5. 測試計畫

### 5.1 離線（`test/host.test.js` 的記憶體假 MinIO 要擴充）

假 MinIO 需要新增：`Range` 支援、multipart 狀態機、`EntityTooSmall` 規則、`ListMultipartUploads`。

| 案例 | 驗收 |
|:--|:--|
| `Range: bytes=0-9` | 206 + `Content-Range: bytes 0-9/N` + `Accept-Ranges: bytes` |
| `Range` 越界 | 416 + `Content-Range: bytes */N` |
| `If-Range` 不符 | 200 全量 |
| 無 Range | 200 + `Accept-Ranges`（相容性不能被破壞） |
| multipart 全流程 | init → 3 片 → complete → 物件大小正確 |
| **續傳**：只傳第 2、3 片 | complete 成功（第 1 片已存在） |
| 同一片重傳 | 覆蓋，最終 ETag 取最後一次 |
| complete 少一片 | 400 `InvalidPart` |
| abort 後 complete | 404 `NoSuchUpload` |
| 非最後一片 1 MiB | 400 `EntityTooSmall` |
| 0 byte / 剛好 partSize 整數倍 / 比 partSize 小 | 片數與位移正確 |
| >10000 片 | init 階段就以 `planParts` 擋下（回 400） |
| 工具取消（`exec.signal`） | 中止當前片並 abort（不留未完成 upload） |

### 5.2 真機

- 擴充 `.verify/multipart-probe.cjs`：**中斷注入**（第 N 片時主動斷 socket）→ 重跑 →
  驗證只補缺的片、最終物件位元組與本地檔一致（複合 ETag 或整檔下載比對）。
- `minio.mjs get --continue`：中斷在 60% → 續傳 → MD5 == 物件 ETag（Phase 1 已用
  curl `-C -` 驗過同一條路徑）。
- 大檔（≥1 GB）實測：記憶體峰值（宿主 RSS、瀏覽器 heap）不得隨檔案大小線性成長。

### 5.3 驗收條件（每期）

- Phase 1：`Range` 三種情境 + `If-Range` 皆有測試；`curl -C -` 與 `minio.mjs --continue`
  在真機中斷後都能補完且內容一致；既有 56 個測試持續全過。
- Phase 2：離線 multipart 全表格 + 真機 1 GB 上傳（含中斷續傳）；移除 256 MB 天花板。
- Phase 3：面板重整後能續傳（手動重整測試）；取消不留未完成 upload。
- Phase 4：直傳模式的 CORS 前置驗證通過；兩種模式可切換且 `/status` 顯示。

---

## 6. 分期實作計畫

| 期 | 內容 | 工作量 | 狀態 |
|:--|:--|:--|:--|
| **1** | 下載：`/object` 轉發 Range（206/416/If-Range/Accept-Ranges）＋ `minio.mjs get --continue` 串流 | 0.5 天 | ✅ **完成**（真機 8/8：`.verify/range-live.cjs`） |
| **2** | 上傳：`s3.js` multipart 六個方法 ＋ 宿主 5 條路由（模式 A）＋ `minio.mjs upload/uploads/abort` | 1.5 天 | ✅ **完成**（真機 12/12：`.verify/upload-live.cjs`；離線 64 個測試全過） |
| **3** | 面板：multipart 上傳、進度、暫停／續傳／取消、未完成清單 | 1 天 | ✅ **完成**（`.verify/panel-flow-live.cjs` 真機 12/12；續傳＝重新整理頁面後重選同一個檔案，伺服器接手） |
| **4** | 模式 B（presigned 直傳）＋併發＋校驗＋lifecycle 建議 | 0.5 天 | ⬜ 未做（`presignUploadPart()` 已實作並實測可直傳） |

### 8.0.1 Phase 3 的實作決定與落差

| 設計 | 實作 | 為什麼 |
|:--|:--|:--|
| 用 localStorage 記 `uploadId`／已完成片 | **不用 localStorage**，一律問伺服器（`ListMultipartUploads` + `ListParts`） | 本地狀態會與伺服器分岔（另一個分頁、另一台機器、被清掉的 upload）；伺服器才是唯一真相。`init` 本來就會接手同 key 的上傳，所以「重新整理頁面 → 重選同一個檔案」就是續傳 —— 瀏覽器也不可能保存檔案位元組，這是唯一誠實的做法 |
| 進度用 fetch | **`XMLHttpRequest.upload.onprogress`** | `fetch` 沒有上傳進度事件 |
| 取消 → `AbortMultipartUpload` | 同（「暫停」才保留進度、「取消」會清掉伺服器上的片） | 兩個動作語意不同，UI 分開給 |
| — | **修掉一個會讓 multipart 全滅的 bug**：`req.on('close')` 在**請求 body 讀完**就觸發，於是「收完這一片、正要送 S3」的瞬間被自己 abort。改成看 `res`（`writableFinished` 判準），並加了語意測試 | 真機驗證抓到；`test/host.test.js` 有專門的測試釘住 |

**不動既有行為**：沒有 Range、沒有走 multipart 的請求路徑一行都不改 —— 現有 56 個測試
是回歸網。

---

## 7. 取捨與「為什麼不那樣做」

| 選項 | 為什麼不選 |
|:--|:--|
| **tus**（resumable upload 協議） | 需要一個 tus server（或別人實作的 S3 後端）；S3 multipart 就是物件儲存的原生續傳機制，沒有理由再加一層協議。 |
| **resumable.js / Uppy** | 前端函式庫，底層一樣要後端分片端點；我們要的邏輯不多，引入依賴不划算。 |
| **把整檔切塊存成多個物件**（`big.bin.part0001`） | 使用者拿到的是碎片，讀取要自己合併；multipart 對客戶端是透明的。 |
| **presigned 全程直傳（單次 PUT）** | 單次 PUT 上限 5 GB，且**沒有任何續傳**；要續傳就一定是 multipart。 |
| **讓瀏覽器組完整 Blob 再上傳** | 多 GB 直接爆記憶體（這也是現在 256 MB 上限的來源）。 |
| **在宿主切片**（自己讀上游、自己回 Range） | 失去 S3 的精準 Range 與 `If-Range`，還多一份記憶體。 |

**已知的設計風險**：

1. **模式 B 與金鑰立場衝突**：presigned URL 是限時 capability（不是金鑰），但它讓
   瀏覽器能直接寫那個物件的某一片。要嘛接受（並限制有效期到 10 分鐘、單片、單 key），
   要嘛永久維持模式 A。**這是產品決策，不是技術限制。**
2. **瀏覽器自動續傳不可控**：靠 `<a download>` 的續傳行為依瀏覽器而異，所以面板若要
   「保證」續傳就得自己分段（Phase 3）。
3. **`Content-Type` 要記得帶**：multipart 的 `Content-Type` 只能設在
   `CreateMultipartUpload`（實測沒帶會存成 `binary/octet-stream`）；續傳時要沿用上一次的值。

---

## 8. 附錄

### 8.0 實作與設計的落差（2026-10-16，實作 Phase 1／2 時發現）

| 設計假設 | 實測結果 | 因此改成的做法 |
|:--|:--|:--|
| 轉發 `Range` 就夠，`If-Range` 交給 S3 | **MinIO 忽略 `If-Range`**：帶不符的 ETag 仍回 `206` | 宿主自己 `HEAD` 比對 ETag，不符就**退回 200 全量**（`src/index.js`）。少這一步，物件被覆寫時續傳會拼出壞檔。 |
| 416 會帶 `Content-Range: bytes */size` | 只回一段 XML，**沒有** `Content-Range` | 收到 416 後由宿主補 `Content-Range: bytes */size`（多一次 HEAD） |
| `complete` 少送片 → `InvalidPart` | **少送片會成功**（S3 不知道物件該多大），只是物件被截斷；只有**片號有洞**才 `InvalidPart` | 客戶端必須比對 `complete` 回傳的 `size`（宿主會回）；skill 另外用複合 ETag 驗 |
| 客戶端一定有側車檔（`uploadId`） | 瀏覽器清了 localStorage／CLI 被砍 → 側車檔沒了 | `--resume` 會**接手**伺服器上同 key 的上傳，前提是「已收到的片大小與規劃完全相符」，並在 stderr 說明 |

### 8.1 用 curl 手動跑一次 multipart（除錯用）

```bash
EP=http://10.17.26.8:7000; B=dsh; K=_mp/manual.bin; AUTH=(--aws-sigv4 "aws:amz:us-west-rack-2:s3" --user "$AK:$SK")

ID=$(curl -s "${AUTH[@]}" -X POST "$EP/$B/$K?uploads=" | sed -n 's:.*<UploadId>\(.*\)</UploadId>.*:\1:p')
E1=$(curl -s "${AUTH[@]}" -X PUT --data-binary @part1.bin -D - -o /dev/null "$EP/$B/$K?partNumber=1&uploadId=$ID" | tr -d '\r' | sed -n 's/^etag: //Ip')
E2=$(curl -s "${AUTH[@]}" -X PUT --data-binary @part2.bin -D - -o /dev/null "$EP/$B/$K?partNumber=2&uploadId=$ID" | tr -d '\r' | sed -n 's/^etag: //Ip')

curl -s "${AUTH[@]}" "$EP/$B/$K?uploadId=$ID"                       # ListParts：看已收到哪些片
printf '<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>%s</ETag></Part><Part><PartNumber>2</PartNumber><ETag>%s</ETag></Part></CompleteMultipartUpload>' "$E1" "$E2" \
  | curl -s "${AUTH[@]}" -X POST --data-binary @- -H 'Content-Type: application/xml' "$EP/$B/$K?uploadId=$ID"

curl -s "${AUTH[@]}" -X DELETE "$EP/$B/$K?uploadId=$ID"             # 放棄（AbortMultipartUpload）
curl -s "${AUTH[@]}" "$EP/$B?uploads="                              # 列出未完成的 upload
```

### 8.2 續傳下載（Phase 1 已可用的外部工具法，已實測）

```bash
curl --aws-sigv4 "aws:amz:us-west-rack-2:s3" --user "$AK:$SK" -C - -o big.bin "$EP/$B/big.bin"
# 實測：中斷在 50000/105567 bytes → 再跑一次補完，MD5 == 物件 ETag
```

### 8.3 實測環境

- MinIO `10.17.26.8:7000`（region `us-west-rack-2`），桶 `dsh`，`_mp_probe/` 前綴，
  探針跑完 **0 殘留物件、0 殘留未完成 upload**。
- 憑證不落檔：探針走 `src/storage.js` 的 `ConnectionProvider`（憑證檔 + BDD storage 記錄）。
