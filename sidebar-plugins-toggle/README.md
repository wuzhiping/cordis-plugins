# sidebar-plugins-toggle —— 介面精簡開關

## 這是什麼

兩個開關，都在 設定 → 一般，**預設都開**（= 都隱藏）：

1. **側欄「系统外掛」入口**：側欄最上面那一列（官方外掛
   `@deepseek-ai/dsh-client-ui-plugin-manager` 註冊的 `sidebar.panellist` 條目，
   id = `plugins`，order 0）隱藏。只有那一列消失：外掛主面板、設定 → 外掛 都照常。
2. **底部「更多」選單的兩項**：底部帳號選單（官方外掛
   `@deepseek-ai/dsh-client-ui-settings-account` 的 AccountMenu）裡的
   「意見反饋」與「登入」隱藏；「設定」那一項照常。

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

### B. 底部「更多」的兩項（選單是隨開隨渲染的）

選單項目是 `[role="menuitem"]`，只在選單打開時存在。所以靠同一個 MutationObserver：
一看到頁面有 menuitem 就**立刻**跑一次（不等 150ms 節流，避免項目先閃出來），把文字
（去空白）等於這幾個標籤的項目 `display:none` 並標上 `data-spt-more="1"`：

- 意見反饋：`意见反馈`（zh）、`意見反饋`（zh-TW）、`Feedback`（en）
- 登入：`登录`（zh）、`登入`（zh-TW）、`Sign in`（en）

zh-TW 的兩個字串是用 zhtw 外掛自己的 `convertS2T` 算出來核對過的
（意见反馈→意見反饋、登录→登入；`退出登录`→`退出登入` 不在名單裡，所以登出不受影響）。
關掉開關或外掛卸載時，標記過的項目會還原。

### 狀態儲存

| 開關 | localStorage key | 預設 |
|---|---|---|
| A 側欄那一列 | `sidebar-plugins-toggle:hidden` | `"1"`＝隱藏 |
| B 「更多」兩項 | `sidebar-plugins-toggle:more-hidden` | `"1"`＝隱藏 |

`"0"` 表示顯示。**每個瀏覽器各自一份**；要跨瀏覽器同步就得改走宿主 Config。

## 診斷（給 agent 用，畫面上看不到）

每次套用都會把結果寫成一個 keyed slot 佔位鍵：
`plugins.row.config` 底下 `key = "spt-diag:…"`（該 owner 永遠不會 dispatch 這個 key，
所以不會渲染任何東西）。用 `cordis_inspect_query`（client / Slots /
`listSubTree` root = `plugins.row.config`）讀，例如：

```
spt-diag:h=1 nav=1 row=6 sel=1 nth=1 m=1 by=label lab=系统外掛 disp=none
         h2=1 more=0 mt=- loc=http://127.0.0.1:3080
```

`h`／`h2` 兩個開關目前狀態、`nav`/`row` DOM 裡的側欄容器與列數、`sel` 標籤選擇器命中數、
`nth` 算出來的位置、`m`/`by` 最後用哪條路命中、`disp` 命中節點的 computed display、
`more` 這次隱藏了幾個選單項目、`mt` 選單目前看到的項目文字（選單關著時是 `-`）、
`loc` 是哪個頁面在回答。

## 已知脆弱點

- `_panelList` / `_panelRow` 是 CSS Module 的雜湊後綴（DSH 前端重建時前綴會變、後綴通常不變）。
  若哪天側欄改了類名，診斷會顯示 `nav=0 row=0`。
- 「更多」兩項是按**文字**比對，DSH 改文案或換語系時要同步更新 `MORE_LABELS`；
  診斷的 `mt=` 會顯示選單實際上的文字，直接照著補即可。
- 若整條規則都不見了，先重新整理頁面（用戶端外掛的模組世代在 HMR／重啟後可能沒被重新套用）。

## 安裝 / 移除

已用 `install_bundle` 裝進 profile `web`（`link:` 指向本目錄）。
移除：`plugin_manager` 的 `remove_bundle`，target = `sidebar-plugins-toggle`。

> ⚠️ `cordis-plugins/dshReset.ps1` 會把**不在 `$allowedPlugins` 白名單裡的外掛全部移除**。
> 這個 bundle 的名字已在白名單裡（2026-10-17 加入）；若改名或換 profile，記得同步，
> 否則下次跑 reset 就會被卸載 —— 症狀是「重新整理後側欄那一行又跑出來」。
