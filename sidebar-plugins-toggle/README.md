# sidebar-plugins-toggle —— 側欄「系统外掛」入口開關

## 這是什麼

側欄最上面那一列「系统外掛」（官方外掛 `@deepseek-ai/dsh-client-ui-plugin-manager`
註冊的 `sidebar.panellist` 條目，id = `plugins`，order 0）可以隱藏。
**只有那一列消失**：外掛主面板、設定 → 外掛 都照常運作。

同一個 bundle 在 設定 → 一般 加一列核取方塊控制顯示／隱藏，說明文字會直接寫出目前狀態
（「目前已隱藏…」／「目前顯示中…」）。

## 怎麼運作

三層保險，都不改 React 的資料：

1. 一條 CSS 規則命中該列：

   ```css
   nav[class*="_panelList"] > button[class*="_panelRow"]:nth-of-type(1){display:none !important}
   ```

   列的識別有兩條路，兩條都寫進規則：

   - `aria-label` 四種寫法：`插件`（zh 基底）、`外掛`（zhtw-traditional-chinese 的片語改寫）、
     `系统外掛`（zhtw 的側欄改名 hack），外加 `[aria-label$="外掛"]` 後綴；`Plugins`（en）。
   - `:nth-of-type(n)`：n 由 `ctx.slots.entriesOfSlot('sidebar.panellist')` 依 `order` 排序後
     `id === 'plugins'` 的位置算出 —— 跟側欄自己 `syncPanels()` 的排序同源，**不依賴文案**。

   `nav … > button …` 這一層確保不會誤傷「設定 → 外掛」那一項（它不是 `_panelRow`）。

2. 同一組選擇器再對命中節點寫一次 inline `style.display`，並用 `MutationObserver`
   （childList + `aria-label`/`class` 變更，150ms 節流）重跑，所以 React 重建節點或別人動過
   樣式表之後仍會再蓋上去。

3. 偏好存在 `localStorage` 的 `sidebar-plugins-toggle:hidden`（`"1"` 隱藏、`"0"` 顯示），
   預設隱藏。**每個瀏覽器各自一份**；要跨瀏覽器同步就得改走宿主 Config。

## 診斷（給 agent 用，畫面上看不到）

每次套用都會把結果寫成一個 keyed slot 佔位鍵：
`plugins.row.config` 底下 `key = "spt-diag:…"`（該 owner 永遠不會 dispatch 這個 key，
所以不會渲染任何東西）。用 `cordis_inspect_query`（client / Slots /
`listSubTree` root = `plugins.row.config`）讀，例如：

```
spt-diag:h=1 nav=1 row=6 sel=1 nth=1 m=1 by=label lab=系统外掛 disp=none css=457
         loc=http://127.0.0.1:3080 vis=visible
```

`h` 目前狀態、`nav`/`row` DOM 裡的側欄容器與列數、`sel` 標籤選擇器命中數、
`nth` 算出來的位置、`m`/`by` 最後用哪條路命中、`disp` 命中節點的 computed display、
`css` 注入規則長度、`loc`/`vis` 是哪個頁面在回答。

## 已知脆弱點

`_panelList` / `_panelRow` 是 CSS Module 的雜湊後綴（DSH 前端重建時前綴會變、後綴通常不變）。
若哪天側欄改了類名，診斷會顯示 `nav=0 row=0`。若整條規則都不見了，先重新整理頁面
（用戶端外掛的模組世代在 HMR／重啟後可能沒被重新套用）。

## 安裝 / 移除

已用 `install_bundle` 裝進 profile `web`（`link:` 指向本目錄）。
移除：`plugin_manager` 的 `remove_bundle`，target = `sidebar-plugins-toggle`。

> ⚠️ `cordis-plugins/dshReset.ps1` 會把**不在 `$allowedPlugins` 白名單裡的外掛全部移除**。
> 這個 bundle 的名字已在白名單裡（2026-10-17 加入）；若改名或換 profile，記得同步，
> 否則下次跑 reset 就會被卸載 —— 症狀是「重新整理後側欄那一行又跑出來」。
