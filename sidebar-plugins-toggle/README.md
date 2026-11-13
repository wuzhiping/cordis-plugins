# sidebar-plugins-toggle —— 介面精簡

## 這是什麼

兩件事，預設都生效：

1. **側欄「系统外掛」入口**（設定 → 一般 **有核取方塊**，預設開）：側欄最上面那一列
   （官方外掛 `@deepseek-ai/dsh-client-ui-plugin-manager` 註冊的 `sidebar.panellist`
   條目，id = `plugins`，order 0）隱藏。只有那一列消失：外掛主面板、設定 → 外掛 都照常。
2. **底部「更多」選單的兩項**（**永久隱藏，沒有開關**）：底部帳號選單（官方外掛
   `@deepseek-ai/dsh-client-ui-settings-account` 的 AccountMenu）裡的「意見反饋」與
   「登入」隱藏；「設定」那一項照常。

## 怎麼運作

### A. 側欄那一列（三層保險）

**DOM 結構注意**：DSH 0.2.2 起，側欄每一列多包了一層 `div._panelEntry`：

```html
<nav class="…_panelList">
  <div class="…_panelEntry">          <!-- 新增的包裝層 -->
    <button class="…_panelRow" aria-label="插件">…</button>
  </div>
  …
  <button class="…_panelRow" aria-haspopup="menu">   <!-- 列尾「更多」，不是面板 -->
```

所以選擇器用**後代**而不是直接子元素，且隱藏的單位是 `panelEntry`（只藏按鈕會留下空白間距）：

1. 一條 CSS 規則命中該列：

   ```css
   nav[class*="_panelList"] div[class*="_panelEntry"]:has(> button[class*="_panelRow"][aria-label="插件"]){display:none !important}
   nav[class*="_panelList"] button[class*="_panelRow"][aria-label="插件"]{display:none !important}
   ```

   列的識別有三條路，都寫進規則：

   - `aria-label` 幾種寫法：`插件`（zh 基底）、`外掛`（zhtw-traditional-chinese 的片語改寫）、
     `系统外掛`（zhtw 的側欄改名 hack）、`Plugins`（en），外加 `[aria-label$="外掛"]` 後綴。
   - `:has()`：直接命中「包含該按鈕的外層 panelEntry」，新結構下才藏得乾淨。
   - `:nth-of-type(1)`：plugins 的 order 是 0 且側欄的 `setPinned` 對它直接 return（永遠釘在頂），
     所以它一定是 nav 裡第一個面板列 —— **不依賴文案**的位置後備。

   `button[aria-haspopup="menu"]` 是列尾的「更多」按鈕，已排除，不會誤傷。

2. 同一組選擇器再對命中節點（收斂成 `panelEntry`）寫一次 inline `style.display`，並用
   `MutationObserver`（childList + `aria-label`/`class` 變更）重跑，所以 React 重建節點或
   別人動過樣式表之後仍會再蓋上去。

3. 開關狀態存在 `localStorage` 的 `sidebar-plugins-toggle:hidden`
   （`"1"` 隱藏（預設）、`"0"` 顯示）。**每個瀏覽器各自一份**。

### B. 底部「更多」的兩項（永久隱藏）

選單項目是 `[role="menuitem"]`，只在選單打開時存在。所以靠同一個 MutationObserver：
一看到頁面有 menuitem 就**立刻**跑一次（不等 150ms 節流，避免項目先閃出來）。

**認位置，不認文字**：帳號選單固定是 設定 / 意見反饋 / 登入（未登入）或 退出登入（已登入），
所以隱藏第 2 項、未登入時再隱藏第 3 項 → **任何語系（vi-VN…）都成立**，不需要翻譯表。
只在 trigger（`button[aria-haspopup="menu"][data-signed-out]`）的 `aria-expanded=true` 時動手，
所以不會誤傷別的選單（選單是 portal 到 body 的，不能靠祖先節點歸屬）。

萬一帳號選單形狀不是 3 項，才退回比對 `MORE_LABELS` 的文案（zh / zh-TW / en / vi 的
「意見反饋」「登入」寫法；zh-TW 的字串是用 zhtw 的 `convertS2T` 算出來核對的）。
被隱藏的項目標上 `data-spt-more="1"`，外掛卸載或狀態不符時還原。

## 診斷（給 agent 用，畫面上看不到）

每次套用都會把結果寫成一個 keyed slot 佔位鍵：
`plugins.row.config` 底下 `key = "spt-diag:…"`（該 owner 永遠不會 dispatch 這個 key，
所以不會渲染任何東西）。用 `cordis_inspect_query`（client / Slots /
`listSubTree` root = `plugins.row.config`）讀，例如：

```
spt-diag:h=1 nav=1 ent=8 row=9 sel=2 nth=1 m=1 by=label lab=系统外掛 disp=none
         rows=系统外掛/IM機器人/超級智慧體/自動化任務/元氣時鐘
         trg=1 ag=0 sgn=0 mi=0 more=0 mt=- loc=http://127.0.0.1:3080
```

`h` 側欄開關狀態、`nav` 側欄容器數、`ent` 面板列包裝層數、`row` 列按鈕數（含「更多」）、
`sel` 標籤選擇器命中數、`nth` 位置規則、`m`/`by` 最後用哪條路命中、`lab` 命中的 aria-label、
`disp` 命中按鈕的 computed display、`rows` 目前 DOM 裡前幾個列標籤（排查語系／改名最有用）、
`trg` 找到幾個帳號選單 trigger、`ag` 選單是否開著、`sgn` 是否未登入、`mi` 選單有幾項、
`more` 這次隱藏了幾項、`mt` 選單目前看到的項目文字（選單關著時是 `-`）、
`loc` 是哪個頁面在回答。

> 判讀訣竅：`row=0` 代表選擇器對不上 DOM 結構（多半是 DSH 升級改了包裝層）；
> `rows=` 會直接告訴你現在列標籤長什麼樣。2026-11-13 的 0.2.2 就是這樣發現的。

## 已知脆弱點

- `_panelList` / `_panelRow` / `_panelEntry` 是 CSS Module 的雜湊後綴（DSH 前端重建時前綴會變、
  後綴通常不變）。**DSH 升級最容易動到的就是這裡**：0.2.2 就把 `nav > button` 改成
  `nav > div > button`，讓舊選擇器整排落空。升級後先看診斷的 `nav/ent/row`。
- 「更多」兩項靠**位置**（第 2、3 項）。DSH 若要動帳號選單的項目順序／數量，診斷的 `mi=` 會先
  顯示出來（`mi≠3` 時退回文字比對，`mt=` 會顯示選單實際文字）。
- **部署路徑**：這個 bundle 在 profile 裡是 `git+https://git.feg.cn/shawoo/cordis-plugins#path:/sidebar-plugins-toggle`
  裝下來的**實體複本**（`profiles/web/node_modules/sidebar-plugins-toggle/`），不是 `link:`。
  所以工作區改完要嘛同步複本、要嘛 push 後重裝 —— 否則線上跑的是 git 上那一版，
  會出現「改了沒生效」的假象（2026-10-18 就踩過一次）。
- 若整條規則都不見了，先重新整理頁面（用戶端外掛的模組世代在 HMR／重啟後可能沒被重新套用）。

## 安裝 / 移除

已用 `install_bundle` 裝進 profile `web`（`link:` 指向本目錄）。
移除：`plugin_manager` 的 `remove_bundle`，target = `sidebar-plugins-toggle`。

> ⚠️ `cordis-plugins/dshReset.ps1` 會把**不在 `$allowedPlugins` 白名單裡的外掛全部移除**。
> 這個 bundle 的名字已在白名單裡（2026-10-17 加入）；若改名或換 profile，記得同步，
> 否則下次跑 reset 就會被卸載 —— 症狀是「重新整理後側欄那一行又跑出來」。
