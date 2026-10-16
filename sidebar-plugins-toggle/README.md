# sidebar-plugins-toggle —— 側欄「系统外掛」入口開關

## 這是什麼

側欄最上面那一列「系统外掛」（官方外掛 `@deepseek-ai/dsh-client-ui-plugin-manager`
註冊的 `sidebar.panellist` 條目，id = `plugins`，order 0）可以隱藏。
**只有那一列消失**：外掛主面板、設定 → 外掛 都照常運作。

同一個 bundle 在 設定 → 一般 加一列核取方塊控制顯示／隱藏。

## 怎麼運作

- 瀏覽器半邊（`client.js`）注入一條 CSS：

  ```css
  nav[class*="_panelList"] > button[class*="_panelRow"][aria-label="…"]{display:none !important}
  ```

  `aria-label` 涵蓋那一列在各語系下的四種寫法：`插件`（zh 基底）、`外掛`
  （zhtw-traditional-chinese 的片語改寫）、`系统外掛`（zhtw 的側欄改名 hack）、
  `Plugins`（en）。**不碰 DOM 節點**，所以 React 重繪、側欄收合、語系切換都不會失效；
  `nav … > button …` 這一層確保不會誤傷「設定 → 外掛」那一項（它不是 `_panelRow`）。

- 偏好存在 `localStorage` 的 `sidebar-plugins-toggle:hidden`（`"1"` 隱藏、`"0"` 顯示），
  預設隱藏。**每個瀏覽器各自一份**；要跨瀏覽器同步就得改走宿主 Config。

## 已知脆弱點

`_panelList` / `_panelRow` 是 CSS Module 的雜湊後綴（DSH 前端重建時前綴會變、後綴通常不變）。
若哪天側欄改了類名或 aria-label，這一列會重新出現 —— 修 `client.js` 的 `ROW_SELECTOR` 即可。

## 安裝 / 移除

已用 `install_bundle` 裝進 profile `web`（`link:` 指向本目錄）。
移除：`plugin_manager` 的 `remove_bundle`，target = `sidebar-plugins-toggle`。
