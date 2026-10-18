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

1. 一條 CSS 規則命中該列：

   ```css
   nav[class*="_panelList"] > button[class*="_panelRow"]:nth-of-type(1){display:none !important}
   ```

   列的識別有兩條路，兩條都寫進規則：

   - `aria-label` 幾種寫法：`插件`（zh 基底）、`外掛`（zhtw-traditional-chinese 的片語改寫）、
     `系统外掛`（zhtw 的側欄改名 hack）、`Plugins`（en），外加 `[aria-label$="外掛"]` 後綴。
   - `:nth-of-type(n)`：n 由 `ctx.slots.entriesOfSlot('sidebar.panellist')` 依 `order` 排序後
     `id === 'plugins'` 的位置算出 —— 跟側欄自己 `syncPanels()` 的排序同源，**不依賴文案**。

   `nav … > button …` 這一層確保不會誤傷「設定 → 外掛」那一項（它不是 `_panelRow`）。

2. 同一組選擇器再對命中節點寫一次 inline `style.display`，並用 `MutationObserver`
   （childList + `aria-label`/`class` 變更）重跑，所以 React 重建節點或別人動過樣式表之後
   仍會再蓋上去。

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
spt-diag:h=1 nav=1 row=6 sel=1 nth=1 m=1 by=label lab=插件 disp=none
         trg=1 ag=0 sgn=0 mi=0 more=0 mt=- loc=http://127.0.0.1:3080
```

`h` 側欄開關狀態、`nav`/`row` DOM 裡的側欄容器與列數、`sel` 標籤選擇器命中數、
`nth` 算出來的位置、`m`/`by` 最後用哪條路命中、`disp` 命中節點的 computed display、
`trg` 找到幾個帳號選單 trigger、`ag` 選單是否開著、`sgn` 是否未登入、`mi` 選單有幾項、
`more` 這次隱藏了幾項、`mt` 選單目前看到的項目文字（選單關著時是 `-`）、
`loc` 是哪個頁面在回答。

## 已知脆弱點

- `_panelList` / `_panelRow` 是 CSS Module 的雜湊後綴（DSH 前端重建時前綴會變、後綴通常不變）。
  若哪天側欄改了類名，診斷會顯示 `nav=0 row=0`。
- 「更多」兩項靠**位置**（第 2、3 項）。DSH 若要動帳號選單的項目順序／數量，診斷的 `mi=` 會先
  顯示出來（`mi≠3` 時退回文字比對，`mt=` 會顯示選單實際文字）。
- **部署路徑**：這個 bundle 在 profile 裡目前是 `github:` spec 安裝的**實體複本**
  （`profiles/web/node_modules/sidebar-plugins-toggle/`），不是 `link:`。
  所以工作區改完要嘛同步複本、要嘛 push 後重裝（或 `install_bundle` 指到工作區，改回 `link:`）——
  否則線上跑的是舊 commit，會出現「改了沒生效」的假象。
- 若整條規則都不見了，先重新整理頁面（用戶端外掛的模組世代在 HMR／重啟後可能沒被重新套用）。

## 安裝 / 移除

已用 `install_bundle` 裝進 profile `web`（`link:` 指向本目錄）。
移除：`plugin_manager` 的 `remove_bundle`，target = `sidebar-plugins-toggle`。

> ⚠️ `cordis-plugins/dshReset.ps1` 會把**不在 `$allowedPlugins` 白名單裡的外掛全部移除**。
> 這個 bundle 的名字已在白名單裡（2026-10-17 加入）；若改名或換 profile，記得同步，
> 否則下次跑 reset 就會被卸載 —— 症狀是「重新整理後側欄那一行又跑出來」。
