---
name: minio-file
description: 用一份 MinIO/S3 連線設定（dsh-minio-s3 面板「❗️ 複製設定」匯出的 JSON：endpoint／accessKey／secretKey／region／bucket）對遠端桶做檔案操作：列桶與列目錄、下載、上傳、刪除、複製／改名、建資料夾、產生簽章連結。內附零依賴的 minio.mjs（自行實作 AWS SigV4，不需要 mc 或 @aws-sdk），並記錄實測過的坑（region 對 presign 與批次刪除嚴格、MinIO 的 + 編碼、Content-MD5、copy-source 前導斜線）。當使用者提到 MinIO／S3／桶／物件儲存，或要上傳／下載／列出遠端檔案並提供連線設定時使用。
---

# MinIO 檔案操作

把 dsh-minio-s3 面板匯出的連線設定拿來直接操作桶裡的檔案。

## 前置：一份連線設定（第一次使用時要）

**第一次使用**：請使用者按 dsh-minio-s3 面板右上角的 **「❗️ 複製設定」**，把整段 JSON 交給
你（貼在對話裡，或存成檔案），然後用 `init` 收下：

```bash
node .dsh/skills/minio-file/minio.mjs init                     # 從 stdin 讀（貼上後 Ctrl+Z 換行、Enter）
node .dsh/skills/minio-file/minio.mjs init --from export.json   # 從檔案讀
```

它會驗證欄位、寫成 `./minio.json`（`--out <file>` 可換位置），並印出端點／帳號／**遮蔽後**的金鑰／
region／預設桶讓你核對。之後每次直接用，不必再問：

```bash
node .dsh/skills/minio-file/minio.mjs ls --json
```

匯出的 JSON 長這樣（`buckets` 只是附帶資訊，程式不看它；**這裡刻意把 secretKey 遮掉，實際會是明文**）：

```json
{
  "provider": "minio",
  "endpoint": "http://10.17.26.8:7000",
  "accessKey": "dsh",
  "secretKey": "…",
  "region": "us-west-rack-2",
  "bucket": "dsh",
  "usePathStyle": true,
  "forcePathStyle": true,
  "buckets": ["dsh"],
  "exportedAt": "2026-10-16T14:35:20.687Z"
}
```

- **設定搜尋順序**：`--config <file>` → `$MINIO_CONFIG` → `./minio.json` → `./.dsh/minio.json` → 環境變數
  （`MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` / `MINIO_REGION` / `MINIO_BUCKET`）。
- **隨時可以改**：換金鑰／端點／預設桶就再跑一次 `init`（覆寫同一份），或直接編輯那個檔；`config` 隨時
  顯示「現在用的是哪一份、值是什麼（金鑰遮蔽）」。要同時管多個端點就用 `--config a.json` / `--config b.json`，
  臨時換桶用 `--bucket <桶>`。
- 欄位名同時接受 BDD storage 記錄的原始格式（`S3_URL`、`S3_UID`、`S3_PWD`、`S3_BUCK`，或 `UID`/`PWD`/`BUCKET`）。
- 想自己查一份（而不是請使用者複製）：`POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/s3`，body
  `{"apiKey":"<本機 refs.AIFE_API_KEY 遮蔽後的值>"}`（遮蔽公式見 `cordis-plugins/dsh-minio-s3/README.md`）。
  **該請求只可送往 `abc.feg.com.tw`。**

> **金鑰等於通行證。** `init` 寫出的檔案權限是 0600、輸出時金鑰已遮蔽；但那份 `minio.json` 本身是明文，
> 不要 commit、不要貼進文件或截圖。用完（或換手機器）就刪掉它。`config`／其他命令的輸出都不含明文金鑰。

**帳號多半是單桶權限**：`buckets` 只會列出這個帳號看得到的桶（實測這台只回 `dsh`）；對其他桶操作會得到
`error: AccessDenied … (HTTP 403)` —— 這是權限問題，不是設定錯，請用設定裡的桶或 `--bucket`。

## 主要路徑：`minio.mjs`（零依賴，Node 18+）

```bash
node <此 skill 目錄>/minio.mjs <命令> [選項] --config minio.json
```

目前這台機器就放在工作目錄下：`C:\Users\shawoo\Desktop\feg.cn\.dsh\skills\minio-file\minio.mjs`（以 skill 工具回報的 base directory 為準；這個位置隨專案走）。

| 命令 | 作用 |
|:--|:--|
| `buckets` | 列出所有桶 |
| `ls [prefix]` | 列一層（資料夾走 `folders`、物件走 `objects`）；`--recursive` 列出前綴下全部；`--max <n>` 預設 200 |
| `head --key <key>` | 物件是否存在、大小、型別、etag |
| `cat --key <key>` | 以 UTF-8 讀出內容（文字檔最快） |
| `get --key <key> --out <path>` | 下載到檔案，`--continue` 可續傳；省略 `--out` 時把原始位元組串流到 stdout |
| `put --key <key> --from <path>` | 上傳本地檔案（單次 PUT，小檔）；`--content <text>` 收行內文字；`--contentType <mime>` |
| `upload --key <key> --from <path>` | **multipart 上傳（大檔、可續傳）**：`--part-size 16MiB`、`--concurrency 3`、`--resume` |
| `uploads [--key <key>]` | 列出未完成的上傳與已收到的片 |
| `abort [--key <key>]` | 放棄未完成的上傳（清掉伺服器上的片） |
| `rm --key <k> [--key <k> …]` | 刪除（逐 key 失敗會自動退回單物件刪除） |
| `mv --key <來源> --to <目標>` | 複製 + 刪除原檔（S3 沒有 rename） |
| `mkdir --key <prefix/>` | 建立資料夾標記 |
| `mb --bucket <桶>` / `rb --bucket <桶>` | 建立／刪除桶（刪除僅限空桶） |
| `presign --key <key> [--expires 3600]` | 產生簽章連結（最長 7 天） |

共同選項：`--config <file>`、`--bucket <桶>`（覆寫設定裡的預設桶）、`--json`（輸出 JSON 供程式解析）、`--help`。

- **輸出**：預設人類可讀（`ls` 是 `<大小>\t<時間>\t<key>`，資料夾是 `dir\t<prefix>`）；`--json` 給結構化結果。
- **失敗**：stderr 一行 `error: <Code> <Message>`，結束碼 1（訊息帶 S3 的 Code，例如 `NoSuchKey`）。

### 實例

```bash
M='node .dsh/skills/minio-file/minio.mjs --config minio.json'   # 工作目錄＝專案根

$M buckets                                   # 有哪些桶
$M ls --json                                 # 預設桶的根目錄
$M ls reports/2026/ --recursive --json       # 某個前綴下全部物件
$M cat --key reports/2026/summary.md         # 讀文字內容
$M get --key photos/a.jpg --out a.jpg        # 下載
$M put --key reports/summary.md --from summary.md --contentType text/markdown
$M mkdir --key reports/2026/
$M mv --key reports/draft.md --to reports/2026/final.md
$M rm --key reports/2026/final.md
$M presign --key photos/a.jpg --expires 600  # 給別人用的連結
```

`ls --json` 的形狀（key 已正確解碼，含空白、`+`、中文）：

```json
{ "bucket": "dsh", "region": "us-west-rack-2",
  "folders": ["docs/"],
  "objects": [{ "key": "a b+中文.txt", "size": 105567, "lastModified": "2026-10-16T13:48:07.065Z", "etag": "…" }],
  "truncated": false, "nextToken": "" }
```

## 沒有 Node 時：`curl --aws-sigv4`（curl 8.x）

```bash
# 值直接取 minio.json：endpoint / accessKey / secretKey / region
C='curl -s --aws-sigv4 "aws:amz:<region>:s3" --user "<accessKey>:<secretKey>"'

$C "<endpoint>/"                                             # 列桶
$C "<endpoint>/<bucket>?list-type=2&prefix=&delimiter=%2F"   # 列一層
$C -o a.jpg "<endpoint>/<bucket>/photos/a.jpg"               # 下載
$C -X PUT --data-binary @a.md -H "Content-Type: text/markdown" \
   "<endpoint>/<bucket>/reports/a.md"                        # 上傳
$C -X DELETE "<endpoint>/<bucket>/reports/a.md"              # 刪單一物件
```

`<region>` 用設定裡的值（見下方第 1 點）。**批次刪除（`POST ?delete`）與 presign 不要用 curl 硬做** —— 前者要自己算 `Content-MD5`，後者要自己組查詢簽章；交給 `minio.mjs rm` / `presign`。

## 實測過的坑（2026-10，真機 MinIO）

1. **region**：MinIO 對一般簽章請求寬容（`us-east-1` 也收），但 **presign 與 `POST ?delete` 嚴格驗 region**。`minio.mjs` 會先用一個未簽章的 `GET /`（403 的 `<Region>`）把真值問出來；curl 就直接填設定裡的值。
2. **批次刪除的假成功**：`POST ?delete` 可能回 **HTTP 200 但逐 key `<Error>`**（region 錯時就是這樣）。一定要讀 `errors`，否則會「以為刪了、其實還在」——`minio.mjs rm` 遇到逐 key 失敗會自動退回單物件 `DELETE`。
3. `POST ?delete` 需要 **`Content-MD5`**（`minio.mjs` 自動算）；`<Key>` 是**原字串的 XML 轉義**，不要 URL 編碼（編碼過會刪到不存在的 key，還是回 200）。
4. `x-amz-copy-source` 是 **`/桶/key`，要以 `/` 開頭**，key 依 URL 規則編碼。
5. 列表要帶 **`encoding-type=url`**；MinIO 用 `url.QueryEscape`，**`+` 要當空白解**（`decodeURIComponent` 不認 `+`），否則 key 會對不上。
6. **SigV4 canonical headers 每一行（含最後一行）都以 `\n` 結尾** —— 少了那個空行，本地看起來全對，伺服器永遠回 `SignatureDoesNotMatch`。
7. 桶名規則：小寫字母／數字開頭，**不能有 `_`**（`_` 只能出現在 object key 或前綴裡，例如 `_dsh_minio_s3_probe/`）。
8. **空資料夾的標記會「變成資料夾裡的一個 0 位元組檔案」**：空資料夾是一個 key 以 `/` 結尾的 0 位元組物件（如 `docs/`）。用 `delimiter=/` 列**根目錄**時它會落在 `CommonPrefixes`（正常顯示為資料夾）；但列 **`docs/` 自己**時，它的 key 正好等於前綴，MinIO 就把它放進 `Contents` —— 於是你會在空資料夾裡看到一個叫 `docs` 的 0 位元組檔案。判斷方法：`key === 前綴` 的那一筆就是「這個資料夾自己」，要濾掉（`minio.mjs ls` 已處理）。真的 0 位元組檔案（如 `empty.txt`）不受影響。
9. **HEAD 沒有 body，所以錯誤拿不到 S3 Code**：`HEAD /桶/key` 對不存在的 key 回 `404`，但**回應 body 是空的**，解析不到 `<Code>`。`minio.mjs` 會用狀態碼補上標準語意（`404 → NoSuchKey`、`403 → AccessDenied`），所以看到的是 `error: NoSuchKey (HTTP 404)`，而不是看不懂的 `error: HTTP404`。

## 大檔案：下載與上傳都支援斷點續傳（2026-10-16 實測）

```bash
# 下載（可續傳）：中斷後再跑同一行，會從本地檔的長度接上
node minio.mjs get --key big.bin --out big.bin --continue

# 上傳（multipart）：大檔不受記憶體限制；中斷後同一行加 --resume 只補缺的片
node minio.mjs upload --key big.bin --from big.bin --part-size 16MiB --concurrency 3 --resume

node minio.mjs uploads            # 有哪些未完成（中斷）的上傳、已收到幾片
node minio.mjs abort --key big.bin  # 放棄，清掉伺服器上的片
```

細節：

- **進度條**：`get --out` 與 `upload` 會在 **stderr** 畫進度條（`下載 [████░░] 47% 9.8/21.0 MiB 12.3 MiB/s ETA 00:01`），
  stdout 保持乾淨 —— 可以安心接管線或 `--json`。續傳時會多一段標示，這是判斷「有沒有真的接上」最快的方式：

  ```
  續傳下載 big.bin：從 29.3 KiB（28%）接續
  續傳下載 big.bin [███████░░░░░░░░░░░░░░░░░]  28%  29.3 KiB/103 KiB  ... (續傳自 28%)
  上傳 big.bin：從 16.0 MiB（76%）接續
  上傳 big.bin [██████████████████░░░░░░]  76%  16.0 MiB/21.0 MiB  ... 第 3/3 片（進行中 3）
  ```

  在管線／CI 裡預設**不畫**（stderr 不是終端機）；要強制顯示用 `DSH_MINIO_S3_FORCE_PROGRESS=1`，
  要關掉用 `--no-progress`（或 `--progress` 強制開）。
- **下載**：`--continue` 用 `Range` 續抓、**串流寫檔**（不再整包進記憶體）；會用側車檔
  `<out>.dshmeta.json` 記住物件的 ETag，物件換過就自動從 0 重來；單片物件完成後驗 MD5
  （multipart 物件只驗大小）。沒有 `--out` 時是純串流的原始位元組輸出。
- **上傳**：S3 multipart，`partSize` 預設 8MiB（物件大到超過 10000 片會自動放大），
  3 片併發、每片 3 次退避重試、**逐片比對 MD5**，最後用**複合 ETag**
  （`md5(各片 md5 串接)-片數`）驗內容 —— multipart 的最終 ETag 不是物件 MD5，所以不能
  拿 ETag 直接比。中斷後：側車檔 `<from>.dshupload.json` 還在就直接續；不見了就用
  `ListParts` 接手伺服器上的上傳（前提是片大小與規劃相符，會在 stderr 註明）。
  未完成的片會**一直佔空間**，確定不傳了請跑 `abort`。
- **`put` 仍是單次 PUT**（小檔用；沒有續傳）。
- 上限：單次 PUT 5 GB、multipart 5 TB；伺服器端對「非最後一片」有 5 MiB 下限
  （本 skill 用 8 MiB 起跳避開）。
- **面板（dsh-minio-s3）**：下載已受益（瀏覽器對有 `Accept-Ranges` 的下載會自動續傳）；
  面板的大檔上傳還沒接 multipart（> 256 MB 目前只能靠這個 skill）。

## 相關

- **面板／工具版**：`dsh-minio-s3` 外掛 —— 對話區「MinIO」頁籤，以及 `minio_list` / `minio_read` / `minio_write` / `minio_delete` / `minio_bucket` 五個工具（用同一個 BDD storage 連線，免設定）。需要登入宿主、且宿主程式碼改動要重啟 DSH 才生效。
- **本 skill** 適合：跨機器、腳本化、或宿主沒有那個外掛時；只要有一份設定 JSON 就能跑。
