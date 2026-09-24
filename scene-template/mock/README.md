# mock/ —— 按接口拆分的 mock 数据

给后端对齐《AI 工作流输入区 UI 规范 v0.1》§3 的接口用。**一个接口一个文件**，可以直接丢给
mock server（或照着写实现）。

数据来自 `../lib/client.js`（原型里的 mock）——本目录是**一次性导出的快照**，只用于这次接口对齐，
不是第二份真源。原型数据若变了，这个目录按需手工更新即可。

## 接口 ↔ 文件

| 文件 | 接口（规范 §3） | 形状 |
|---|---|---|
| `scenarios_list.json` | `GET /api/scenarios` | `{ "scenarios": ScenarioSkeleton[] }` —— 只有骨架，选中场景后再拉详情。**已上线**：`https://abc.feg.com.tw/BDD/API/AI/dsh/scene/list`（返回形状与本文件一致，前端已切过去，带 mock 回退） |
| `scenario_detail.json` | `GET /api/scenarios/{id}` | `{ "<scenarioId>": ScenarioDetail }`，6 个场景各一份。**已上线（但实现成了 POST）**：`POST https://abc.feg.com.tw/BDD/API/AI/dsh/scene/detail`，body `{"id":"scn_writing"}`；响应与本文件同形状且**已带 `hasDynamicTemplates`**。注意该路由对 GET 返回 `200` + **空 body**（陷阱），只有 POST 有数据 |
| `template_suggestion_for_scenarios.json` | `POST /api/scenarios/{id}/templates` | `{ "<scenarioId>": { "request": {...}, "response": { "templates": [...] } } }`，只有 `hasDynamicTemplates=true` 的场景有内容。**推荐已另起接口并上线**：`POST https://abc.feg.com.tw/BDD/API/AI/dsh/scene/suggestion_template`，body `{"scene_id":"scn_writing","content":"<输入框草稿>"}`；返回**裸数组 3 条**（不是 `{templates:[…]}`），且**每次调用顺序不同** —— 所以"换一批"就是再调一次，不需要 cursor；其 `previewUrl` 是相对路径 `/share/ehr/pages/dev/preview/template_preview.html`，前端需补 API 域名 |
| `template_preview.html` | `GET /api/templates/{id}/preview` | 一段完整 HTML（`Content-Type: text/html`，直接 iframe 渲染）。这里放 `tpl_meeting` 一份样例。**现状（2026-09-24 实测已可 iframe）**：前端预览用**模板对象里 API 返回的 `previewUrl`**（补成 `https://abc.feg.com.tw/share/ehr/pages/dev/preview/template_preview.html`），该地址 `200 text/html; charset=UTF-8`、777 字节、**既无 `X-Frame-Options` 也无 CSP** —— 之前那两个问题（`DENY` + `frame-ancestors` 不含 DSH 源；只回 4 字节 `node`）都已消失。**剩下的缺口是"一张页面对所有模板"**：`previewUrl` 对所有模板都相同，且忽略 `?id=` / `?template_id=` / `?templateId=&scene_id=`（返回逐字节相同的样例页，`<h2>` 恒为「會議紀要與決議看板」），`/share/ehr/pages/dev/preview/tpl_weekly.html` 是 404；需要后端按模板 id 参数化（或一模板一页）。这个 §3.4 接口只作为"模板没带 previewUrl"时的兜底 |
| `conversations_submit.json` | `POST /api/conversations` | `{ "<scenarioId>": Request }`，2 份 request 示例 |

带 `{id}` 的接口用「参数 → 响应」的字典放在同一个文件里，避免 6 个几乎同名的文件。

## 数据模型（同规范 §2）

**ScenarioSkeleton**（§3.1 列表）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 例 `scn_writing` |
| `name` | string | 显示名 |
| `icon` | string \| null | 见下面「待对齐 2」 |
| `hasDynamicTemplates` | bool | true = 模板受 input 影响 |

**ScenarioDetail**（§3.2 详情）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `name` / `description` | string | `description` 会作为**只读上下文 block** 注入到 input 前 |
| `icon` | string \| null | 同上 |
| `hasDynamicTemplates` | bool | **必须返回**，见下面「待对齐 1」 |
| `branches` | Branch[] | 每场景 3–4 个 |
| `templates` | Template[] | 静态"兜底集"；`hasDynamicTemplates=true` 时用户输入后还会再调 §3.3 |

**Branch**：`id`、`name`、`preset`（选中后填进 input，用户可改）

**Template**：`id`、`title`、`thumbnailUrl`、`previewUrl`、`contentType`
（`contentType` 枚举 `html | image | pdf | markdown`，mock 里全是 `html`）

**POST /api/conversations** 的 request：`scenarioId` + `branchId` + `input` + `templateIds[]`
四元组即完整上下文，另有 `workspace`、`permission`。

## 待对齐的 5 点（都是原型与规范/实现的差异）

1. **§3.2 的响应要带 `hasDynamicTemplates`。** 规范 §3.2 的示例里没有这个字段，但前端要靠它
   判断"要不要在用户输入后再调一次 §3.3"。**原型目前就漏了它，导致动态模板一次都没触发过** ——
   这不是 mock 的问题，是接口定义要补上（本目录的 `scenario_detail.json` 里已经带上）。
2. **`icon` 的形态。** 规范 §2.1 写"可选图标 URL"，mock 里放的是 emoji（`"✍️"`）。
   选一个：要么后端给图标 URL，要么规范改成允许 emoji/短字符串。
3. **模板要不要 `subtitle`。** 规范 §2.3 的 Template 只有 5 个字段，但原型的海报卡上显示了副标题
   （如"决议 / 待办 / 责任人 / 时间点"）。加字段就写进 §2.3，不加就从 UI 去掉。
4. **"✨ 推荐"（跨场景推荐池 + 翻批）算什么接口。** 规范里只有 §3.3 的"刷新模板"按钮，
   没有跨场景推荐。原型把它做成了"从 30 张模板的池子里每次取 4 张"。要么补一个接口
   （如 `POST /api/templates/recommend`，body 带 `cursor`，回 `nextCursor / batchIndex / total`），
   要么砍掉、只保留 §3.3。
5. **`previewUrl` 的形态，以及"案例内容"从哪来。** 规范说它是"弹窗预览的 HTML URL"（§3.4 另有接口返回 HTML 本体）；
   原型为离线自包含，直接内联 `data:text/html`。真接口按规范给 URL 即可，前端只把它当 iframe 的 `src`。
   同理 `thumbnailUrl` 在 mock 里是内联 SVG data URL，真接口给 http(s) 地址就行。
   **但现在多了一层用途**：选中的模板要作为"生成文件时可参考的案例内容"注入模型上下文，宿主会把
   `previewUrl` 抓下来转纯文本（>4000 字截断）。而远端目前**对所有模板返回同一张样例页**（`?id=` / `?template_id=`
   都被忽略，`<h2>` 恒为「會議紀要與決議看板」）→ 每张海报注入的内容是一样的。要让它有用，请二选一：
   ① 给 Template 加 `content`（纯文本/HTML 片段）字段，宿主优先用它；② 按模板 id 参数化预览页
   （`?template_id=<id>`）。**当前的兜底**：注入的上下文里一定带上 `預覽地址: <url>`（内联 `data:` 不算），
   抽不到内容时还会写明"需要时可直接抓该地址"，所以模型至少有一条 per-template 的参考线；
   mock 的内联模板本身是逐模板的，这条缺口只在接真接口后暴露。

## 两个说明

- **文案是繁体（zh-TW）**：产品界面用繁体，数据里的场景名/模板标题/预设词都是繁体原文，别当成乱码。
- `scenario_detail.json` 40KB 里大部分是内联 SVG 缩略图（一张约 1.5KB，浏览器里能直接显示）。
  不需要就忽略 `thumbnailUrl` 的值，看字段名即可。
