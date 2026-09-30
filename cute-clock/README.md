# 🕐 cute-clock —— 元氣時鐘外掛

一個住在 DSH Web GUI 角落裡的元氣時鐘 —— 圓潤鐘面、兩隻耳朵、會眨眼、頭頂還有一顆跳動的小愛心。

## ✨ 它做了什麼

註冊三個座位：

| 位置 | 用途 |
|---|---|
| **`shell.overlay`** | 永遠飄在右下角的元氣小時鐘 · 顯示問候語、活力 slogan、時分秒、日期 |
| **`sidebar.panellist`** | 左欄新增 🕐 圖示，點擊切換到全域面板 |
| **`main` (keyed)** | 全螢幕"元氣時鐘"頁面：大鐘 + 大字時間 + 飄落花瓣 + 活力 slogan |

## 🕐 不隨 agent preset 退場

三個座位註冊在 root scope，**對所有工作階段一律渲染** —— 不論當前會話跑的是哪個 agent preset（標準模式、辦公模式、極簡模式…），浮層、左欄圖示、時鐘頁面都在。

舊版相反：它會讀 `SessionListState` 自己判斷，遇到 `HIDDEN_PRESETS = ['office']` 裡的 preset 就整塊退場（如果人正停在時鐘頁上還會順手切回工作階段）。那段開關已刪除，`useSessions` / `useHiddenHere` / `HIDDEN_PRESETS` 都不再存在。

## 🚧 擋到輸入區就整塊隱藏

角落那張浮動卡片是 `position:fixed`（右下角），而「輸入區」是頁面自己排版的 —— 輸入卡片會長高、輸入框上方有場景面板、下方有模板牆，**高度都隨內容變**（hero 與一般會話也不同），所以窄視窗或模板多的時候卡片會壓在輸入區上。

處理方式：**量實際外框，不看佈局也不猜 class**。

- 會和卡片搶位置的是這幾個選擇器（依可靠度排序）：
  `.uV2eYG_input`（DSH 輸入卡片）→ `[data-st-scroll]`（scene-template 的場景面板／模板牆）
  → `#st-top` / `#st-wall`（該插件的座位 id）→ `[contenteditable="true"],textarea`。
- 只要有任一個外框和卡片外框**相交（含 8px 安全距離）**，卡片就**整塊隱藏**：
  `opacity:0` + `visibility:hidden`（連帶讓出點擊），**不往任何方向滑走、也不留小圖標或藥丸**
  —— 右下角完全讓給輸入區。不再重疊時自己淡回來（CSS `transition` 250ms）。
- **判斷只看幾何，不看焦點。** 曾經加過「焦點在輸入框裡也藏」，結果是誤判來源：
  composer 常常自己拿到焦點（切工作區、開新工作階段、載入後自動聚焦），而且焦點會一直
  留著 —— 明明沒有任何重疊，卡片卻整場不出現。實測（`test/watch-card-state.js`）：
  舊版靜置 25 秒後 `overlapping=[]`、`focusish=true`、卡片已隱藏；只看幾何之後同一段
  時間內狀態零變化、卡片一直在。正在打字時輸入區本來就變大並與卡片重疊，所以「打字時
  讓開」這個效果仍然成立。
- 幾何由**同一個 300ms 的取樣迴圈**讀，另掛 `MutationObserver`（子樹變動）、
  `ResizeObserver`、`resize`、`scroll` 提早觸發重算，所以拖動視窗或輸入框長高時反應是即時的。
- **被量測的那個盒子不能會動**：`.cute-clock-card` 的 `:hover` 現在只改陰影，不再
  `translateY(-3px) rotate(-1deg)`。舊版的 hover 位移會改變量到的矩形（實測 top 639→633、
  高度 89→94），卡片稍微一動就跨過 8px 判定邊界 → 隱藏 → 滑鼠離開 → 顯示 → 又 hover，
  來回跳就是「滑鼠放上去會閃」。同理，時分秒改用**等寬數字**，免得秒數每秒變一次寬度。
- 沒有輸入區的畫面（例如設定頁）不會隱藏：找不到任何外框時卡片照常顯示。

`node test/verify-auto-yield.js` 會在執行中的 GUI 上驗證六件事：正常視窗只有一個時鐘且卡片可見、強制重疊會隱藏且不留殘骸、重疊消失就回來、**只有焦點（沒有重疊）不得隱藏**、失焦仍可見、760px 窄視窗不重疊。

`node test/watch-card-state.js` 是「誤判」的回歸測試：靜置 30 秒不做任何操作，只記錄狀態變化。沒有重疊時它必須是 **1 筆**（初始狀態）—— 舊版會出現第 2 筆「被隱藏」，那就是這次修掉的 bug。

`node test/verify-no-flicker.js` 是「閃爍」的回歸測試：把卡片分別停在判定邊界**外**與**內**，用真實滑鼠事件移上去 —— 邊界外必須盒子不變、保持可見、3 秒內 opacity 零次翻轉；邊界內必須維持隱藏、不來回跳。

## 🎀 可愛的細節

- 🕐 **圓潤鐘面**：三角耳朵、內耳粉色、閃亮的黑眼睛、Q 彈腮紅、微笑小嘴
- 👀 **眨眼動畫**：每 4.6 秒眨一次（左右眼錯開 0.08s，更自然）
- 👂 **耳朵抖動**：每 5.4 秒抖一次（右耳延遲 1.3s，錯峰）
- 💗 **頭頂愛心**：呼吸式縮放，1.4s 一個週期
- ⏰ **秒針帶彈性**：用 `cubic-bezier(.34,1.56,.64,1)` 模擬機械表的"嘀嗒"
- 🕐 **問候語隨時間切換**：早安/午安/晚安/夜深了…（帶 emoji）
- 🌸 **花瓣飄落**（僅大螢幕）：18 片隨機花瓣從頂部飄下
- 💪 **活力 slogan，每次開啟都不一樣**：75 條鬧鐘級打氣文案，按時段分 5 桶（morning/noon/afternoon/evening/night），**每次開啟面板或重新整理頁面都隨機抽一條**；浮動小卡片和大面板各抽各的；大面板上**點一下 slogan 就再換一條**。跨時段（比如 14:00）時會自動換到時段的句子
- 🔠 **大面板的 slogan 是 54px**（`.cute-clock-bigquote`，由 13.5px 連乘兩次 2 倍），`line-height:1.3`、`padding:20px 48px`、`max-width:min(760px,88vw)` —— 長句自然折成兩行、貼齊同一條中線（面板內容整組 `translateX(-50px)`）。浮動小卡片那句維持 11px，兩者刻意不同

## 💪 活力 slogan 機制

文案池在 `lib/client.js` 的 `ENERGY_PACK`，每個時段 15 條，共 75 條：

| 時段 | 小時 | 條數 |
|---|---|---|
| `morning` | 00–08 | 15 |
| `noon` | 09–13 | 15 |
| `afternoon` | 14–17 | 15 |
| `evening` | 18–21 | 15 |
| `night` | 22–23 | 15 |

- 抽取函式：`pickEnergySlogan(scope, rand)` —— `Math.random()` 隨機，`rand` 可注入方便測試
- 元件裡用 `useState(function () { return pickEnergySlogan(bucketOf(h)); })` 惰性初始值，
  所以**每次元件掛載（= 每次開啟面板 / 每次重新整理頁面）都會重新抽一次**
- `useEffect(..., [h])` 在跨時段時再抽一次，保證早上不會看到晚上的話
- 想加句子：直接往 `ENERGY_PACK` 對應陣列裡塞；想加時段：加一個 key 並在 `bucketOf()` 裡分支

## 🎨 主題適配

所有顏色一律使用 DSH 主題令牌（`--dsw-*`），**無需任何額外程式碼**，明暗主題自動切換：

```
背景：--dsw-alias-bg-layer-1
邊框：--dsw-alias-border-l2
文字：--dsw-alias-label-primary / -tertiary
強調：--dsw-alias-brand-primary
狀態：--dsw-alias-state-error-primary (腮紅/愛心/秒針)
陰影：--dsw-elevation-panel
```

## 📦 安裝

```sh
# 從外掛目錄外執行（cwd 會自動錨定）
dsh plugin --profile web add ./cordis-plugins/cute-clock

# 解除安裝
dsh plugin --profile web remove cute-clock
```

安裝完成後**重新啟動 web profile 一次**（新增宿主行需要重新啟動）。

## 🔄 開發循環

- 改 `lib/client.js`：**不用重新啟動**。檔案一改，模組群組的 `rev` 就變（服務端按內容重算），瀏覽器**重新整理頁面**即拿到新的那一份
- 改 `lib/index.js` / `package.json` / `cordis.patch.yml`：**必須重新啟動**宿主
- **先確認 profile 裡的安裝形態**：這個插件在 `profiles/web/node_modules/cute-clock` 是**目錄副本**（`LinkType` 為空），所以「改工作區」不會自動生效 —— 要先把 `lib/client.js` 複製進那個目錄（複製後 `rev` 自己會變），或重跑 `plugin_manager install_bundle`。同一 profile 裡 `jeeflow-panel` / `today-material-panel` 才是符號連結（那份改完刷新即可）。
  ```powershell
  Get-Item "$env:DSH_PROFILE_DIR\node_modules\cute-clock" | Select-Object LinkType, Target
  Copy-Item .\lib\client.js "$env:DSH_PROFILE_DIR\node_modules\cute-clock\lib\client.js" -Force
  ```

## 📁 檔案結構```
cute-clock/
├── package.json          # 三處 dsh.* 聲明
├── cordis.patch.yml      # 把自己插入組合樹
├── README.md
└── lib/
    ├── index.js          # 宿主半邊（空殼，邏輯全在瀏覽器）
    └── client.js         # 瀏覽器半邊（React + SVG + CSS 動畫）
```

## 🪑 註冊了什麼座位（對照 CLIENT.md §1）

| 你的說法 | 平台術語 | key |
|---|---|---|
| 角落裡的元氣小時鐘 | 幀級浮層 | `shell.overlay` |
| 左欄 🕐 圖示 | 全域面板圖示行 | `sidebar.panellist` |
| 大時鐘頁面 | 中央面板 | `main` (key=`cute-clock`) |

### 加全域面板的兩步走（CLIENT.md §6.1）

1. **`sidebar.panellist`** 加一個圖示項（`id: 'cute-clock'`）
2. **`main`** 用**同一個 id 作為 key** 註冊頁面本體

點圖示時調 `ctx.layout.selectPanel('cute-clock')` 切換面板，再次點調 `selectPanel(null)` 回到工作階段。

## ⚠️ 已知約束

- `ctx.layout.selectPanel` 是 `null` 時回到工作階段且**不改動當前 session**
- 選擇不存在的 `main` key 會拋錯 —— 所以 panellist 註冊和 main 註冊**必須成對出現**
- `shell.overlay` 本身"點擊穿透"，但本外掛的卡片主動 `pointer-events:auto`，不會擋住下面的互動
- 卡片擋到輸入區（或焦點在輸入框裡）時會**整塊隱藏**（見「擋到輸入區就整塊隱藏」），
  隱藏期間 `visibility:hidden` + `pointer-events:none`，不會攔到任何輸入區的互動。
  這是**幾何判斷**：日後 DSH 若換掉 `.uV2eYG_*` 這組 hash，只有 `[data-st-scroll]`
  （scene-template 自己的資料屬性）還認得，其餘選擇器會同時失效 ——
  那時把新的輸入卡片選擇器補進 `CLOCK_BLOCKERS` 即可
- 浮動小元件在頁面工作階段期間一直掛載着，所以它的 slogan 是**重新整理頁面時換一次**；
  大面板每次點開都會重新掛載，所以**每次開啟都是新的**（這正是"每次開啟都生成"的語義）

## ✨ 可擴充點

- 加點擊互動（點到小元件時切換大頁面）
- 接入 `ctx.locale` 做多語言問候語
- 加鬧鐘/番茄鐘功能（基於 `ctx.timeout` + `ctx.sessions` 寫入工作階段提醒）
- 加自訂頭像/主題色（基於 `ctx.theme`）

享受你的元氣小時鐘吧～ ✨

## 🧪 驗證工具

`test/` 下的 CDP 腳本，都是對**執行中的 GUI** 開一個用完就關的無頭瀏覽器，不動你自己的視窗（`verify-*` 是斷言，`probe-*` / `watch-*` 是量測）：

| 腳本 | 檢查什麼 |
|---|---|
| `node test/verify-clock.js` | 左欄是否出現「元氣時鐘」、浮動卡片（問候語／slogan／時分秒／日期）是否渲染、點一下是否切到全域大時鐘頁（大鐘 + 大字時間 + 18 片花瓣），以及畫面上是否還有「貓」字 |
| `node test/verify-office-gate.js` | 把當前工作階段切到**辦公模式**（舊版會因此整塊退場），確認浮動卡片與左欄圖示仍在，跑完會把 preset 還原 |
| `node test/verify-auto-yield.js` | 隱藏行為六項（見上一節）：正常視窗只有一個時鐘且可見、強制重疊會隱藏且不留殘骸、重疊消失就回來、**只有焦點不得隱藏**、失焦仍可見、760px 窄視窗不重疊 |
| `node test/verify-no-flicker.js` | 閃爍五項：hover 不改變盒子、hover 時仍可見、hover 3 秒 opacity 不翻轉、重疊時隱藏、重疊+hover 不來回跳 |
| `node test/watch-card-state.js` | 靜置 30 秒只記狀態變化；沒有重疊時必須只有 1 筆 |
| `node test/probe-hover-flicker.js` | 逐格記錄 hover 期間的盒子／opacity，用來重現與確認閃爍 |
| `node test/probe-card-box.js` | 卡片的最終盒子（寬高、右/下間距、文字欄寬、每行自然寬度） |
| `node test/probe-geometry.js` | 只讀幾何：卡片與輸入區各元素的外框，用來核對讓位判斷 |

兩者都用 `D:/Refine/Books/ntop/AI/dsh/profiles/node_modules/ws` 連 CDP，預設打 `http://127.0.0.1:3080`（可用 `DSH_DEV_BASE` 覆寫）。
