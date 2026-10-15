# kaneo-web ⇄ 遠端儲存端點：payload 欄位與格式

這一頁是**契約**：`kaneo-web` 宿主半邊預期遠端儲存端點回什麼、以及它接受什麼寫法。
實作在 [`lib/secrets.js`](../lib/secrets.js) 的 `normalizeRestorePayload()` /
`pickField()`，並且有一組回歸測試把它釘住（`test/secrets.js`，含 2026-10-15 的實測回應）。

---

## 1. 我們送出去的請求

```
POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/kaneo
Content-Type: application/json

{ "apiKey": "sk-<base64(AIFE_API_KEY + '@' + ISO8601)>" }
```

| 欄位 | 型別 | 必填 | 值從哪來 |
|---|---|---|---|
| `apiKey` | string | 是 | **遮蔽後**的金鑰，公式在 `lib/secrets.js` 的 `maskKey()`：`sk-` + `base64(原文 + "@" + ISO 時間戳)`。原文取自宿主憑證（`ctx.credentials` → 退回 `$DSH_HOME/.credentials.yaml`），**永不離開宿主** |

實測的伺服器行為（與 ntfy／ov 兩個端點一致）：

| 回應 | 意思 |
|---|---|
| `200 {…}` | 格式對，且這把遮蔽金鑰有對應資料 |
| `200 {}` | 格式對，但**這把金鑰沒有資料**（不是錯誤碼，必須當成明確失敗呈現） |
| `500` | 請求格式不對（缺 `apiKey`／不是字串／遮蔽格式不符） |

---

## 2. 我們期待回來的 payload

### 2.1 實際形狀（2026-10-15 實測）

```json
{
  "REDIRECT_URL": "/dashboard",
  "API_KEY": "389de7025bba3268fdfd994e13b1d0f7c74b08b8db3af15636eead5ef2a9a82b"
}
```

**欄位名不重要** —— 比對是**大小寫不敏感**，而且忽略 `_`、`-`、`.`。
所以 `API_KEY`、`apiKey`、`api-key`、`Api_Key` 全部命中同一個語意。

### 2.2 API Key 候選欄位（至少要有其中一個）

依這個順序取（先命中先用；但**多個都會收成候選**，見 §2.5）：

| 我們接受的欄位名（大小寫／分隔符無關） | 型別 | 備註 |
|---|---|---|
| `apiKey` / `api_key` / `apikey` | string（或 number，會轉字串） | 主要名稱 |
| `key` | 同上 | |
| `token` / `accessToken` / `access_token` | 同上 | |
| `secret` | 同上 | |
| `apiKeyValue` | 同上 | |
| `value` | 同上 | 給「外層包一層 `{value: …}`」的寫法用 |

規則：

* 值必須是**非空字串**（`""` 視為沒有值；`null`／`undefined` 忽略）。
* number 會轉成字串；其他型別（物件／陣列／布林）忽略。
* API Key 的內容本身**不做格式檢查**（不要求 `sk-`、不要求長度）：格式是對方的事，
  我們只負責原樣帶進 iframe 的簽入網址。

### 2.3 登入後路徑（選填）

| 欄位名 | 型別 | 備註 |
|---|---|---|
| `redirect` / `redirectUrl` / `redirect_url` / `path` | string | 站內絕對路徑 |

* 只接受**以單一 `/` 開頭且第二個字元不是 `/`** 的值（`/dashboard`、`/p/demo`）。
* 不合法就**整個丟掉**（不回退、不報錯）：`https://evil.example`、`//evil.example`、
  `dashboard` 都不採用，面板改用本地設定值（預設 `/dashboard`）。
* 這條與 Kaneo 自己的 `safeRedirectPath` 同語意，等於兩邊各擋一次。

### 2.4 顯示用欄位（選填，不影響載入）

| 用途 | 接受欄位名 |
|---|---|
| 顯示名稱 | `name`、`displayName`、`identity`、`nickname`、`nick`、`title` |
| 使用者 | `uid`、`user`、`username`、`account`、`userName`、`email` |

目前面板只用 `redirect`；這兩個收起來備用（未來要在面板顯示「已取回 Jinbe 的設定」時就有資料）。

### 2.5 多個候選怎麼處理

* 收束層會把所有命中的金鑰欄位**全部**收集成 `candidates: [{ path, value }]`，
  `path` 是**回應裡真正的欄位名**（例如 `API_KEY`，不是我們的別名），
  同一個值只記一次。
* 只有 1 個候選 → 面板自動帶進欄位。
* 多個候選 → 面板列成 chip 讓使用者點選（**金鑰原文不渲染在畫面上**，只顯示
  `欄位名（N 字）→`）。

### 2.6 可以包在巢狀裡

為了容忍不同後端的包裝方式，收束層會逐層往內找：

* 頂層
* 頂層的 `data`、`settings`、`value`、`result`
* 以及 `data.<上述任一個>` 這種兩層組合（例如 `data.settings`）

例：`{"data":{"settings":{"API_KEY":"…","REDIRECT_URL":"/x"}}}` 也吃。

---

## 3. 完整回應範例（我們這端會怎麼解讀）

```json
{
  "API_KEY": "389de7025bba3268fdfd994e13b1d0f7c74b08b8db3af15636eead5ef2a9a82b",
  "REDIRECT_URL": "/dashboard",
  "name": "Jinbe"
}
```

→ 宿主回給面板：

```json
{
  "ok": true,
  "candidates": [
    { "path": "API_KEY", "value": "389de7025bba3268fdfd994e13b1d0f7c74b08b8db3af15636eead5ef2a9a82b" }
  ],
  "fields": { "redirect": "/dashboard", "name": "Jinbe" },
  "check": { "status": 401, "verdict": "invalid" },
  "raw": { "API_KEY": "…", "REDIRECT_URL": "/dashboard", "name": "Jinbe" },
  "ref": "AIFE_API_KEY"
}
```

`check` 是拿回金鑰後宿主對**簽入端點**做的一次預檢（`GET`，`redirect: 'manual'`，不跟隨轉址）：

| `verdict` | HTTP | 意思 |
|---|---|---|
| `ok` | 302/303 | 金鑰可以登入（iframe 載入時會發生的事） |
| `invalid` | 401 | `INVALID_API_KEY`：不屬於這個實例／已停用／已過期 |
| `forbidden` | 403 | 帶 scope 的金鑰，或該部署只允許管理員 |
| `not-enabled` | 404 | 該部署沒開 `API_KEY_SIGN_IN` |
| `rate-limited` | 429 | 命中限流 |
| `unknown` | 其他 | 說不出來（附 `status` 與 `error`） |

---

## 4. 三種失敗的回應長相（面板會怎麼說）

| 情境 | 宿主回 | 面板顯示 |
|---|---|---|
| `200 {}`（格式對、沒資料） | `{ ok:true, candidates:[], raw:{} }` | 「遠端沒有回傳可用的 API Key」＋原始回應 |
| 欄位名不在接受清單內 | `{ ok:true, candidates:[], raw:{…} }` | 同上 —— 所以**原始回應一定會攤開**，第一眼就能看出真實欄位名 |
| 上游 500 | `{ ok:false, step:"upstream", error:"…body {\"apiKey\":\"<mask key>\"}…" }` | 「遠端回 500：請求格式不對…」 |
| 上游 HTTP 4xx/5xx | `{ ok:false, step:"upstream", status, body }` | 「遠端回 HTTP nnn」＋回應片段 |
| 拿不到遮蔽金鑰 | `{ ok:false, step:"mask-key", error, tried:[refs] }` | 「拿不到遮蔽金鑰：…（試過 AIFE_API_KEY、FEG_API_KEY、DEEPSEEK_API_KEY）」 |
| 打不到端點 | `{ ok:false, step:"upstream", error }` | 「打不到遠端儲存端點：…」 |

---

## 5. 換環境要改哪裡

* 端點：`config.storageUrl`（預設就是本檔 §1 那條），改 profile 的
  `cordis.patch.yml` 裡 `kaneo-web` 那一行即可，不必改程式。
* 關掉整個「從遠端取回設定」：`config.enableRestore: false`。
* 遮蔽用的金鑰來源：`lib/secrets.js` 的 `MASK_KEY_REFS`
  （`AIFE_API_KEY` → `FEG_API_KEY` → `DEEPSEEK_API_KEY`），
  以及 `DSH_CREDENTIALS_PATH` 覆寫。
* **要收新的欄位名**：`lib/secrets.js` 的 `KEY_NAMES` / `REDIRECT_NAMES`，
  然後在 `test/secrets.js` 加一條（照 §2.1 那份實測回應的寫法）。
