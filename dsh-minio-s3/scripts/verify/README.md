# 真機驗證腳本

這些腳本**對真的 MinIO 跑**（不是 mock），用一套在實際環境驗證過的行為把外掛釘住：
Range／斷點續傳、multipart 上傳與續傳、面板實際會打的 HTTP 序列、空資料夾標記、
匯出設定的保護、region 自動修正……。離線測試（`npm test`）負責邏輯，這裡負責「線路」。

## 怎麼跑

```bash
npm run verify:live            # 全部（會先準備暫存連線設定，跑完刪除）
npm run verify:live range      # 只跑檔名／標籤含 range 的
node scripts/verify/run-all.cjs upload
```

前置條件：

1. **連線設定**：腳本用外掛自己的 `src/storage.js`（`ConnectionProvider`）向 BDD storage
   記錄要憑證，所以跟面板用的是同一組設定，**不需要另外填**。
   `run-all.cjs` 會把取到的設定寫到 `%TEMP%` 的暫存檔、給 skill 類腳本用 `$MINIO_CONFIG`
   讀，**跑完立刻刪除**；任何腳本都不會印出金鑰。
2. **面板要開著**（只有 `web-shell-check.cjs` 需要）：它會抓 `http://127.0.0.1:3080` 的
   `__DSH_BOOT__`，確認外掛的 client 半邊有被載入、URL 回 200、內容可以解析。
   換埠用 `DSH_WEB_URL`。
3. 腳本會在桶裡建立 `_` 開頭的暫存前綴（S3 桶名不能有 `_`，物件 key 可以），
   開頭與結尾各跑一次 `cleanup.cjs` 清掉。

## 各腳本在做什麼

| 腳本 | 釘住的行為 |
| --- | --- |
| `sigv4-vectors.cjs` | SigV4 對 AWS 官方測試向量（離線，不需要憑證） |
| `range-live.cjs` | `/object` 的 `Range` → `206` + `Content-Range` + `Accept-Ranges`；越界 → `416` 且補 `Content-Range: bytes */size`；**`If-Range` 由宿主自己比對**（MinIO 會忽略它） |
| `folder-marker-live.cjs` | 空資料夾的標記（`key === prefix`）不會變成資料夾裡的 0 位元組檔案 |
| `panel-flow-live.cjs` | 面板實際會打的整串：`init` → 分片 → 中途「重整頁面」→ `init` 接手 → 補缺片 → `complete` → 內容 MD5 一致 |
| `upload-live.cjs` | skill 的 `upload`／`--resume`／`uploads`／`abort`，含內容比對 |
| `skill-smoke.cjs` | skill CLI 的基本命令（`buckets`／`ls`／`head`／`cat`／`put`／`get`／`presign`／`init`／`config`） |
| `multipart-probe.cjs` | 直接對 S3 驗 multipart 的七個事實（ETag 形狀、`EntityTooSmall`、ListParts 轉義…），文件 `docs/resumable-transfer.md` 的來源 |
| `routes-live.cjs` | 路由表的 happy path |
| `export-live.cjs` | `POST /export` 的保護：POST-only、自訂標頭、`DSH_MINIO_S3_NO_EXPORT=1` 停用 |
| `s3-live-exercise.cjs` | `S3Client` 各操作的實機演練（含 key 編碼、資料夾標記） |
| `delete-fallback-live.cjs` | 「HTTP 200 但逐 key `<Error>`」時退回單物件刪除 |
| `region-fix-live.cjs` | region 猜錯時自動學到正確值並重試 |
| `cleanup.cjs` | 清掉 `_` 暫存前綴與未完成的 multipart 上傳 |
| `web-shell-check.cjs` | 面板載入：`__DSH_BOOT__` 有條目、bundle 200 且可解析（事故排查用） |
| `run-all.cjs` | 上面全部依序跑、彙總（一個失敗不影響其他） |

## 加新腳本

放在這個目錄、用 `PLUGIN = path.join(__dirname, '..', '..')` 推導路徑（**不要寫死絕對路徑**；
repo 要能搬到別的位置），印 `PASS`/`FAIL` 並以非 0 結束表示失敗，最後在 `run-all.cjs` 的
`SUITE` 加一筆（需要 `$MINIO_CONFIG` 的加 `config: true`）。
