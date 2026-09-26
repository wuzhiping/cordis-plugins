# CLIENT.md —— DSH Web GUI 客户端插件开发：知识体系 · 教学 · 对照解读

> 这份文档回答一个问题：**要在 DSH 的 Web GUI 上做插件（尤其是 UI / 主题类），必须掌握哪些"固定概念"？**
>
> 它从初学者最容易说出口的四个位置出发 ——
> **左边的 sidebar**、**会话里的 tabs（会话 / 轨迹）**、**中间的 chat input**、**设定那个弹出框** ——
> 把这些"看得见的方块"逐一还原成平台真实的机制：**Boot 链**、**Cordis 插件行**、**Slot（座位）**、
> **SlotMap（座位地图）**、**Token（设计令牌）**、**ThemeRuntime（主题运行时）**。
>
> 每一条结论都尽量附**证据位置**（本机真实文件 : 行 / 字段名）。在这个项目里最可靠的文档是 **shipped 代码本身**，
> 而不是猜测；本文件的所有机制名、字段名、CSS 变量名都能在你自己的磁盘上找到。
>
> 与 [`cordis-plugins/scene-template/UI.md`](cordis-plugins/scene-template/UI.md) 的关系：
> UI.md 是"一次具体改造的踩坑复盘"（输入区场景/模板面板），本文件是"整个客户端的概念地图"。
> 二者互补：先读本文件建立坐标系，再用 UI.md 看一个真实改造如何落进坐标系。

---

## 目录

- [0. 本机坐标：路径、版本与三类代码](#0-本机坐标路径版本与三类代码)
- [1. 先修正心智模型：你说的四个方块，平台叫什么](#1-先修正心智模型你说的四个方块平台叫什么)
- [2. 全景：这个 GUI 是怎么"长"出来的](#2-全景这个-gui-是怎么长出来的)
- [3. 三个必背的词：Plugin / Service / Slot](#3-三个必背的词plugin--service--slot)
- [4. 交付形态三选一（决定你写什么文件、生效多久）](#4-交付形态三选一决定你写什么文件生效多久)
- [5. 座位系统 Slot：全篇最核心的一章](#5-座位系统-slot全篇最核心的一章)
- [6. 座位地图：按你的心智模型逐个对应](#6-座位地图按你的心智模型逐个对应)
- [7. 主题系统：Token / ThemeRuntime / 三层色板](#7-主题系统token--themeruntime--三层色板)
- [8. CSS 与布局：把东西放进正确的盒子](#8-css-与布局把东西放进正确的盒子)
- [9. 本地化 locale：所有文案的唯一出口](#9-本地化-locale所有文案的唯一出口)
- [10. 设置持久化：settingsScope 与 Host 设置文档](#10-设置持久化settingsscope-与-host-设置文档)
- [11. 调试与验证：怎么知道"注册上了没有"](#11-调试与验证怎么知道注册上了没有)
- [12. 反模式与陷阱总表](#12-反模式与陷阱总表)
- [13. 术语表（中英对照）](#13-术语表中英对照)
- [14. 证据索引（本机文件 : 行）](#14-证据索引本机文件--行)

---

<a id="0-本机坐标路径版本与三类代码"></a>
## 0. 本机坐标：路径、版本与三类代码

本文所有 `<PKGS>`、`<CLI>` 缩写指：

| 变量 | 实际路径 | 里面是什么 |
|---|---|---|
| `$DSH_HOME` | `D:\Refine\Books\ntop\AI\dsh` | 运行中的用户目录：`profiles/`、`settings.yaml`、`sessions/`、`skills/` |
| `<PKGS>` | `D:\Refine\Books\ntop\AI\dsh\profiles\node_modules\@deepseek-ai` | **已安装的 shipped 客户端/服务端插件包**（含全部 `dsh-client-ui-*`），还有 `.d.ts` 契约 |
| `<CLI>` | `D:\Refine\Books\ntop\AI\node\global\node_modules\@deepseek-ai\dsh` | `dsh` 命令本体（`lib/bin.js`）+ 宿主侧包 |
| 你的工作区 | `C:\Users\shawoo\Desktop\feg.cn` | `cordis-plugins/`（自建插件）、`bundles/`（交付包） |

当前版本：`@deepseek-ai/dsh` **0.1.5-rc.2**（`<CLI>/package.json:4`）。

**三类代码，别混**（这是初学者最容易糊的一层）：

| 类型 | 在哪跑 | 你能碰什么 | 例子 |
|---|---|---|---|
| **shipped 包** | 浏览器 / Node | 只读参考，**不要改**（升级会被覆盖） | `<PKGS>/dsh-client-ui-sidebar/lib/client.js` |
| **宿主半边**（host half） | Node 进程 | Cordis 服务、工具注册、HTTP 路由、文件系统 | 你的 `lib/index.js` |
| **客户端半边**（client half） | 浏览器页面 | React 组件、Slot 注册、CSS、`ctx.locale` | 你的 `lib/client.js` |

一个"UI 插件"通常**两边都要有**：哪怕逻辑全在浏览器，也必须有一个能加载的宿主入口 ——
因为浏览器要加载哪些模块，是宿主侧扫出来的（见 §4.3）。

---

<a id="1-先修正心智模型你说的四个方块平台叫什么"></a>
## 1. 先修正心智模型：你说的四个方块，平台叫什么

先给结论表。左边是你的说法，右边是平台的真实名字与所在位置 —— **后面所有章节都在展开这张表**。

| 你的说法 | 平台术语 | 座位 key（英文/精确名） | kind / scope | 权威定义文件 |
|---|---|---|---|---|
| 左边的 sidebar | 左栏 + 它声明的 6 个子座位 | `sidebar`（子座位：`sidebar.brand.mark` / `sidebar.brand.name` / `sidebar.panellist` / `sidebar.workspaces` / `sidebar.settings` / `sidebar.footer.action`） | `single` / `root`（`panellist`、`footer.action` 是 `list`） | `<PKGS>/dsh-client-ui-layout/lib/types/client/index.d.ts:39`、`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:21-73` |
| 中间那一大块（会话主体） | 主栏 keyed 座位，`conversation` 是保留 key | `main`（key=`conversation`）；会话壳 `main.conversation` | `keyed` / `root`；`single` / `session-maybe` | `dsh-client-ui-layout/.../index.d.ts:48`、`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:113` |
| 会话建立后的 tabs（会话、轨迹） | Conversation View 列表座位 | `conversation.view` | `list` / `session` | `dsh-client-ui-conversation/.../contract/slots.d.ts:157`；`views.d.ts:6`（`ViewTab`） |
| 中间的 chat input | 常驻 composer 卡 + 它周围的"码头" | `conversation.composer.bar`（卡本体）、`conversation.composer`（chain 接管）、`conversation.input.dock`（卡上方）、`conversation.composer.dock`（卡下方）、`conversation.input.left/right/overlay/plan/model/attachments` | `single`/`session-maybe`、`chain`/`session`、`list`/`session` | `dsh-client-ui-conversation/.../contract/slots.d.ts:163-235`、`:330-346` |
| 设定那个弹出框 | 设置域：触发行在 sidebar 底部，弹窗内容由"节"组成 | 触发 `sidebar.settings` → 渲染 `settings.trigger` / `settings.header` / `settings.action` / `settings.close` / `settings.section` / `settings.general.item` / `settings.plugins.tab` / `settings.onboarding` | 全部 `root` | `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:11-119` |
| （你没提到但一定会碰到）右栏 | 边缘面板（推挤 / 全屏两种呈现） | `rightbar` → `rightbar.session` → `sidebar.right.pane.tab` | `single`/`root` → `single`/`session` → `keyed`/`session` | `dsh-client-ui-layout/.../index.d.ts:65`、`dsh-client-ui-sidebar-right/lib/client.js` |
| （你没提到但一定会碰到）全屏浮层 | 框架级浮层（toast / badge / 状态胶囊） | `shell.overlay` | `list` / `root` | `dsh-client-ui-layout/.../index.d.ts:80` |
| （你没提到）主题 | 令牌注册表 + 运行时 | `ctx.theme`（服务，不是座位） | — | `dsh-client-ui-theme/lib/types/client/index.d.ts:109-188` |

> **一句话总结整份文档**：GUI 上你看到的每一个方块，都是宿主（shipped 插件）**预先挖好的一个座位**；
> 你的插件做的事情是**注册一个 occupant（占座者）**坐进去。这就是 95% 的 UI 插件开发。

---

<a id="2-全景这个-gui-是怎么长出来的"></a>
## 2. 全景：这个 GUI 是怎么"长"出来的

### 2.1 Boot 链（从 HTTP 响应到第一帧）

```
① Node 宿主进程
   dsh web  →  profile `web` 的组合树（bundles + patch 层）
              →  dsh-client-modules 的**宿主半边**扫描所有启用的 Loader 行
              →  读出每个包的 package.json `dsh.client` 声明
              →  把它们的 lib/client.js 组成 boot graph，注入 <head>

② 浏览器加载 index.html
   <script>window.__ModuleLoader__</script>   ← 队列式门面（facade）
   <script>window.__DSH_BOOT__ = [...]</script> ← boot graph（哪些包、什么 URL、什么 rev）
   <script>shell bundle (index-*.js)</script>  ← 静态 shell：React / Cordis / ui-slots / ui-primitives

③ shell 启动
   __ModuleLoader__.create({ boot: __DSH_BOOT__, staticModules, loadBundle })
   → 逐个 materialize 客户端插件（懒加载：脚本执行只**注册工厂**，import 时才跑模块体）
   → 全部 roster 落地后：ctx.uiRenderer.mount(container)
   → React 应用首次渲染，renderSlot('root') → AppFrame → 各列 → 各座位
```

证据：
- 静态模块表（`staticModules`）**精确清单**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`
  —— 见 shell 打包产物 `dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`（搜索 `staticModules` 附近的 `function by()`）。
- `__ModuleLoader__.create({...})`、`__DSH_BOOT__`、`prefetchImmediateTier()`（按 `immediately` 预取）：
  同一文件，`class My{...}`（`async run()`）。
- 懒加载与 materialize 语义、`/plugins` combo URL、`rev` 内容哈希：`dsh-client-modules/README.md`（Use this package / Lazy-CJS model）。
- 挂载契约：`dsh-client-ui-renderer/README.md`（"Everything mounts after the complete roster settles"）。

### 2.2 三条必须记住的推论

1. **你写不了"页面"**。shell 的 HTML 是 shipped 的；你只能"坐进座位"。想在整页上盖一层，用 `shell.overlay`，不要碰 `root`。
2. **`root` 是陷阱座位**。`root` 是 `single`，被 `ui-layout` 的 `AppFrame` 占着。你再注册一个 `root`，
   不是"并排"，而是**把它顶掉** —— 页面只剩你的组件，sidebar/会话/右栏全部消失。
   这不是猜测，`registry.d.ts` 里写得很直白：*"DO NOT register here… the page would render your component alone,
   with every seat the frame declares gone"*（`dsh-client-ui-renderer/lib/types/client/registry.d.ts:23-31`）。
3. **加载顺序 = 声明顺序**。客户端 bundle 的加载图由 `dsh.client.inject` 决定（"ordered so dynamic providers
   load before their consumers"，`dsh-client-modules/README.md`）。

### 2.3 bundle 是怎么送到浏览器的（三个 URL 记住就够）

| 东西 | 形状 | 说明 |
|---|---|---|
| **bundle 路由** | `/plugins/...`（`kind: "prefix"`） | 由 `ClientModuleRegistry` 注册；**只服务宿主自己放进响应表里的 URL**：未知 URL → 404，非 GET/HEAD → 405，命中一律 `cache-control: public, max-age=31536000, immutable` |
| **combo URL** | `/plugins/??<id>/client.js,<id2>/client.js…&rev=<hash>` | 多个 bundle 拼成一个响应（每个以 `;\n` 结尾）；每个 URL **≤ 3 KiB**（超了自动分批）；`rev` 是 content hash |
| **单资源 URL** | `/plugins/??<id>/client.js&rev=<hash>` | 每行**同时**有一个；**这就是 HMR 用的 URL** |

同一个 boot graph 会**保留两代响应**（当前 + 上一代），覆盖"请求撞上 HMR 重组"的竞态；
未知组合或未知 rev 一律 404。

图形到达页面是 `window.__DSH_BOOT__`（宿主渲染成 `<script>globalThis["__DSH_BOOT__"] = …</script>`，
其中 `<` 被转义成 `\u003c`，防止插件可控字符串冲出 script 元素）；
先到的 `window.__ModuleLoader__.load(...)` 调用进**队列**，`create()` 被 shell 调用时才真正建立模块表。

---

<a id="3-三个必背的词plugin--service--slot"></a>
## 3. 三个必背的词：Plugin / Service / Slot

### 3.1 Cordis = 插件运行时

DSH 的一切能力都是**插件**，由 **Context（ctx）** 组装；插件生命周期由 **Fiber** 管理。

```js
// 客户端插件的标准形态（静态 bundle：lib/client.js）
const inject = ['slots', 'locale'];          // 我需要哪些服务
function apply(ctx) { /* 注册位、监听事件、开副作用 */ }
exports.apply = apply;
exports.inject = inject;                     // ← 少声明一个服务，用它时直接抛错
```

三条硬规则：

| 规则 | 说明 | 证据 |
|---|---|---|
| **`inject` 不声明就不能用** | 未声明的服务访问会抛 `... without inject` | `bundles/fdep-api-request/README.md`（host-shape 测试项） |
| **`ctx.effect(fn, label)` 立即调用 `fn`，把 `fn` 的**返回值**当 disposer** | 传一个"已经造好的 disposer"会当场执行它 —— 必须包成 `ctx.effect(() => dispose, label)` | 同一个 README："`ctx.effect(dispose)` unregistered the tool immediately" |
| **插件卸载时，注册在它 fiber 上的东西全自动回收** | 座位、样式、监听、定时器都随 fiber 走 | `registry.d.ts:67-83`（register 走 caller 的 `ctx.effect`） |

### 3.2 Service = 别人提供的能力

你在 `apply(ctx)` 里用到的都是服务：`ctx.slots`、`ctx.locale`、`ctx.sessions`、`ctx.uiSession`、`ctx.theme`、
`ctx.settingsScope`、`ctx.layout`、`ctx.uiConversation`、`ctx.remote`、`ctx.timer`、`ctx.uiWorkspace`。

- **可选服务**用 `ctx.get('name')` 拿，拿不到返回 `undefined`，插件照样激活。
  真实范例：`bundles/fdep-api-request/lib/client.js:895-899`（`inject: ['slots']` 是硬依赖，`uiWorkspace` 走 `ctx.get`，
  这样没有 workspace 服务的组合里侧边栏图标仍然出现）。
- **注册服务**用 `ctx.provide('theme', theme)` —— shipped `ui-theme` 就是这么把主题运行时暴露给全站的
  （`<PKGS>/dsh-client-ui-theme/lib/client.js`，`function apply` 内）。

### 3.3 Slot = 座位（下一章整章展开）

---

<a id="4-交付形态三选一决定你写什么文件生效多久"></a>
## 4. 交付形态三选一（决定你写什么文件、生效多久）

同一份 UI 代码有三种"活法"。**先选形态，再写代码** —— 它们的 API 一样，外围完全不同。

| 形态 | 怎么产生 | 生效范围 | 适用 |
|---|---|---|---|
| **动态 Client 插件**（dynamic Package） | 模型调用 `cordis_define` + `cordis_run` | 当前页面 + 当前会话；**进程/页面一刷新就没** | 快速迭代、原型、一次性小工具 |
| **静态 client bundle** | npm 包：`dsh.bundle.patch` + `dsh.client.platform: "web"` + `lib/client.js` | 装进 profile，**重启后常驻** | 定型交付 |
| **宿主行**（host row） | `cordis.patch.yml` 里 `insert:` 一行宿主插件 | Node 端进程 | 数据 / API / 工具 / HTTP 路由 |

标准路径是：**先用动态插件打磨（几十轮都正常），再固化成静态 bundle**。两者代码几乎一样。

### 4.1 动态 Package 的精确契约

工具（`dsh-tool-cordis`）提供 7 个：`cordis_inspect_list`、`cordis_inspect_query`、`cordis_inspect_self`、
`cordis_define`、`cordis_run`、`cordis_stop`、`cordis_undefine`。

`cordis_define` 参数（`<CLI>/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js:9221-9281`）：

| 参数 | 形状 | 说明 |
|---|---|---|
| `plugin` | `{kind:"new", idPrefix}` 或 `{kind:"existing", pluginId}` | `idPrefix` 是 3–6 个小写字母语义前缀，宿主补数字后缀 |
| `name` | string | 插件名 |
| `purpose` | string | 用途 |
| `code` | `{host?: string, client?: string}`，`additionalProperties:false` | **函数体字符串**（不是函数） |

- 两者至少给一个，否则抛 `cordis_define needs `code.host`, `code.client`, or both`（`dsh-cordis-host-runner/lib/index.js:1610`）。
- `cordis_run` 参数：`pluginId`、`packageId`（**不可变的 Package ID**）、`mode`（`"run"` | `"update"`）。
- **Package 是整版替换**：每次 `define` 都铸造一个全新不可变包，只装**这次提交的那半边**。
  所以"只重发 `code.client`"会把宿主半边弄丢（`createAttempt` 把 host 标记为 `absent`）——
  UI.md §4.6 记的那次"界面上场景栏一直加载中"就是踩这个。

动态客户端沙箱（不是 vm，是 `new Function(...parameters, body)` 闭包）：

| 符号 | 状态 |
|---|---|
| `React` / `console` / `styles` / `host` | **可用**（`host.call(method, args)` 调宿主 handler） |
| `setTimeout` `setInterval` `clearTimeout` `clearInterval` | **毒化**（抛教学错误，让你改用 `inject:['timer']` + `ctx.timeout()`） |
| `fetch` | **毒化**（"network belongs to the HOST half"） |
| `require` | **毒化**（"React arrives as the `React` closure symbol"） |
| `harness` | Proxy，任何属性访问都抛（宿主半边才是 `harness.handle`） |
| `process` / `Buffer` | 影子为 `undefined`（不是教学陷阱，直接引擎错误） |
| `ctx` | **不是闭包符号**，是返回的插件对象 `apply(ctx)` 的第一个参数 |

证据：`<PKGS>/dsh-cordis-client-runner/lib/client.js:41-70`（`DYNAMIC_CLIENT_REDIRECTS` / `closureTraps()` /
`harnessTrap()`）、`:154-163`（参数表）、`:171-181`（实参顺序）。

沙箱 ctx 允许的动作（`CTX_VERBS`）：`effect` `on` `once` `provide` `timeout` `interval` `setTimeout`
`setInterval` `throttle` `debounce`；其中计时动词要求 `declared.has("timer")`
（`dsh-cordis-client-runner/lib/client.js:204-224`、`:338`）。

CSS 注入：`styles.insert(css) → disposer`，自动打 `data-dyn=<pluginId>`、随包卸载清理
（`dsh-cordis-client-runner/lib/client.js:84-95`）。

### 4.2 静态 client bundle 的最小文件布局

```
your-plugin/
├── package.json          # 三处声明（见下）
├── cordis.patch.yml      # insert 一行宿主插件
├── lib/
│   ├── index.js          # 宿主半边（可以是空壳，但必须能加载）
│   └── client.js         # 浏览器半边（window.__ModuleLoader__.load）
└── README.md
```

`package.json` 的三处声明（照抄 `cordis-plugins/jeeflow-panel/package.json`）：

```json
{
  "name": "your-plugin",
  "type": "commonjs",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true }
  }
}
```

| 字段 | 必填 | 含义 |
|---|---|---|
| `dsh.bundle.patch` | 要当"层"就必填 | 本包的 patch 层文件（**相对包根**）。列进 `dsh.profile.bundles` 但没这个键 → **硬报错** `profile bundle "X" declares no dsh.bundle` |
| `exports["./client"]` | 有 `dsh.client` 就必填 | 浏览器半边入口。必须是**字符串**或 `{default: string}`；缺了 → **硬报错** `declares dsh.client but exports no "./client" bundle` |
| `dsh.client.platform` | ✅ | 必须是字符串。**只有 `"web"` 会被 Web 模块注册表消费**；其它值**静默**把包当作"不是客户端包"（不报错，只是不出现） |
| `dsh.client.immediately` | ✗ | `true` = 阶段一预取：宿主在模块门面 boot 期间就拉它的脚本（**只注册，不 materialize**） |
| `dsh.client.inject` | ✗ | **包名**数组：这些包的 row/factory 必须先到。类型注释明确写着 *"Informational package-name dependencies, **not** Cordis service injection"* |
| `dsh.client.external` | ✗ | 超出**基线种子**的精确模块请求（含子路径，如 `<pkg>/client`）。组合期会拒绝格式错误、自请求、同步环 |

> **基线种子（不用声明就能 `require`）**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
> `@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
> `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
> 除此之外的 `require` 必须有供应者，否则抛
> *"require(…) missed the module table — not a platform seed word, not a materialized module,
> and no registered package factory"*。

> ⚠️ 两个同名 `inject` 不是一回事：
> - `package.json` 的 `dsh.client.inject` = **包名**（模块到达顺序）
> - 插件对象导出的 `inject` = **服务名**（`slots`、`locale`…）
> 混了会得到"服务未声明"或"模块找不到"两类完全不同的报错。

`cordis.patch.yml` 的写法（jeeflow-panel 的真实内容，含关键注释）：

```yaml
# dsh patch-loader 语义：裸 `- id:` 行只**修补已存在的 entry**；
# 新 entry 必须用 `insert:` 块加进去。
- insert:
    - id: your-plugin
      name: your-plugin
```

宿主半边 `lib/index.js` —— **可以极简，但必须存在**：

```js
// 空壳也合法：本 bundle 只贡献浏览器端座位。
exports.name = 'your-plugin';
exports.apply = function () {};
```

浏览器半边 `lib/client.js` 的最小骨架：

```js
window.__ModuleLoader__.load({
  id: 'your-plugin',                    // ← 必须等于 package.json 的 name（尾部 /client 会被剥掉）
  factory: function (require) {
    'use strict';
    var module = { exports: {} };
    var exports = module.exports;

    var React = require('react');          // ← 没有 React 全局，必须 require
    var e = React.createElement;

    var inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.slots.inject('conversation.view', function () {
        return ctx.slots.register({ name: 'conversation.view', id: 'mine', order: 20, label: '我的面板' }, Comp);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;                 // factory 的返回值就是插件
  },
});
```

### 4.3 为什么"纯前端"的插件也需要一行宿主

`@deepseek-ai/dsh-client-modules` 的宿主半边**扫描 host composition 里的行**来决定给浏览器注入哪些客户端模块。
所以哪怕你的逻辑 100% 在浏览器，也必须：

1. `cordis.patch.yml` 里 `insert:` 一行（`name` = 你的包名）；
2. `package.json` 里声明 `dsh.client.platform: "web"` 与 `exports["./client"]`；
3. `lib/index.js` 提供一个**能加载**的宿主入口 —— **行加载失败会让整个 boot 中止**，不是"只少一个面板"；
4. `lib/client.js` 用 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，**`id` 必须等于包名**
   （多一个 `/client` 后缀会被剥掉；重复注册同一个 `id` 会抛 `duplicate factory registration`）。

**宿主半边的最低要求只有 `apply`**：插件形状检查是 `typeof object.apply === 'function'`（也接受裸函数），
`name` 只是诊断用的显示名（可选），`inject` 会影响激活（未解析的服务会让 fiber 停在 `pending`，
而 boot 末尾的**激活审计**会把它变成启动失败 —— 报 `plugin(s) failed to load`）。

### 4.4 安装、开发循环与"什么时候必须重启"

```sh
# 从任意目录（相对路径会被重新锚定到"你敲命令的目录"，见下）
dsh plugin --profile web add ./bundles/your-plugin
dsh plugin --profile web remove your-plugin
```

`dsh plugin` 实际做的事：**在 `$DSH_HOME/profiles/<name>` 里转发参数给 pnpm**。
`add .` / `../plugin`（以及它们的 `file:`/`link:` 形式）会被**重新锚定到你敲命令的 cwd** ——
因为 pnpm 的 cwd 是 profile 目录，不锚定的话 `add .` 会把 profile 自己链进去。
安装完成后它做一次**基于安装态的 reconcil**（不是依赖 diff）：解析出的包若声明了 `dsh.bundle`
就加入 `dsh.profile.bundles`；没有声明的只装成普通依赖并给一条 warning。
`dsh plugin` **没有子命令枚举**，argv 原样转发（`add` / `remove` / `update` / `why` / `install` …）。

**改 `lib/client.js` 不需要重启**：`@deepseek-ai/dsh-client-hmr` 每 **500ms** 对所有 graph row 的
客户端 bundle 做 `mtimeMs + size` 的 stat 轮询（**故意用轮询**：网络挂载不产生 inotify 事件），
变了就重新算内容哈希；**只有 rev 真的变了**才重组 graph 并通知，
通过 SSE **`/plugins/events`** 广播 `{type:"rebuilt", id, rev}`。
浏览器按 **invalidate → prefetch → registry-first 拆卸 → 排空旧 fiber → 移除自有的
`<style data-plugin>` → `entry.refresh()`** 原地换插件，不刷新页面。

三个容易踩的点：

- **invalidate 必须在 prefetch 之前**：还活着的 factory 会让 prefetch 变成 no-op，
  而在未删除的注册上重跑 bundle 是一个**会大声报错**的重复注册。
- **失败不回滚**：HMR 没有 rollback 策略。
- **下游级联是免费的**：下游 fiber 的激活 epoch 挂在 provider 的 fiber uid 上，
  所以换掉一个数据层插件会**原生级联**到它的 UI 依赖者（HMR 侧不需要任何簿记）。

对**手写的 out-of-tree 插件**（`"type":"commonjs"`、没有 build 脚本，如 jeeflow-panel / fdep-api-request）：
**文件本身就是被服务的产物，所以"保存"就是整个 rebuild**。
反之在**生产构建**里没有任何 watcher 会重写 bundle，所以什么都不会发生 ——
HMR 的触发源只有"有东西真的改写了磁盘上的 bundle 字节"。

三层迭代成本（`bundles/fdep-api-request/README.md` 的实测记录）：

| 层级 | 触发 | 代价 |
|---|---|---|
| Tier 1 | 改离线预览脚本 | 瞬时、离线 |
| Tier 2 | 改 `lib/client.js` | ~500ms，**不用重启、不用刷新** |
| Tier 3 | 改 `lib/index.js`（工具定义） | **必须重启宿主**（模块在 boot 时 import 一次） |

**必须重启的三种情况**（新同学最容易误判）：

1. 改 `lib/index.js`（宿主半边）；
2. **新增一行宿主 entry** —— 组合树是 boot 时组合的；
3. 改 `package.json` 的 `dsh.*` 声明（boot graph 已经发出去了）。

### 4.5 补丁层与组合顺序（精确语义，值得单独背）

profile 目录里的东西：

| 文件 | 谁写 | 说明 |
|---|---|---|
| `package.json` | `initProfile` / `dsh plugin` | `dependencies` + `dsh.profile.bundles`（有序层列表） |
| `cordis.patch.yml` | **你**（初始为空注释） | 你自己的补丁层，**在每个 bundle 层之后**应用 |
| `cordis.yml` | **每次 boot 被重写为 `[]`** | 组合树的"空根"，别编辑它（Loader 需要一个真实 include 根来锚定 `baseUrl`） |
| `pnpm-workspace.yaml` | `initProfile` | `nodeLinker: hoisted`、`autoInstallPeers: false` |
| `node_modules/` / `.dsh-module-fallback/` | pnpm / fallback heal | 装 out-of-tree 插件的地方 |

**层叠顺序（后者胜）**：

```
① bundles 的 patch（按 dsh.profile.bundles 顺序）
② profile 的 cordis.patch.yml
③ home 的 $DSH_HOME/cordis.patch.yml       ← 机器级偏好，因此压过 per-profile 层
④ --patch <file> 覆盖层（按 argv 顺序）
⑤ DSH_TELEMETRY_DISABLED 生成的 disable 补丁
```

bundle 名解析是**"先装 dsh 自带的，再找 profile 自己的"**，所以内置 bundle 永远来自运行中的 dsh 安装。

**patch 条目的语法**（一条 `applyEntryPatches` 决定全部语义）：

| 写法 | 效果 |
|---|---|
| `- id: X`（+ 任意覆盖键） | **修补已存在的 entry**。找不到就警告 `patch: entry "X" not found` 并**跳过** —— 它**从不创建**行 |
| `- insert: [ … ]`（不带 `id`） | 在组合列表**顶层追加新 entry** |
| `- id: G` + `insert: [ … ]` | 往**已存在的 group 的 `config`** 里插新 entry；`G` 不存在或不是 group → 警告并跳过 |

行字段：

| 键 | 含义 |
|---|---|
| `id` | 同一兄弟列表内唯一（见 §13 的 `duplicate loader entry id`） |
| `name` | **在 `insert:` 行里**= 要 import 的模块说明符；**在裸 `- id:` 行里只是一个断言**（会和目标比对，不匹配就跳过）——**不能用它改行的模块** |
| `config` | **整块替换，不是深合并**（所以补丁里的每一行都要把它拥有的键全部重述一遍） |
| `disabled` | 禁用这一行及其后代；允许 `!!js` 表达式 |
| `group` | 嵌套 entry 列表；只有 group 能被 `- id: G` + `insert:` 目标 |
| `inject` | 行级 cordis inject（例：`- id: webserver` / `inject: [webStartup]`） |

> **`name` 是断言不是赋值**这一条极其反直觉，也是"我改了名怎么没生效"的常见原因。

---

<a id="5-座位系统-slot全篇最核心的一章"></a>
## 5. 座位系统 Slot：全篇最核心的一章

### 5.1 三种交付形态下，座位的拿法不同

| | 动态 Package | 静态 bundle |
|---|---|---|
| 拿座位服务 | `ctx.get('slots')` | `inject: ['slots']` + `ctx.slots` |
| React | 沙箱闭包符号 `React` | `require("react")` |
| CSS | `styles.insert(css)` | 自建 `<style>` + `ctx.effect` 清理 |
| 计时 | `inject: ['timer']` + `ctx.timeout()` | 普通 `setTimeout` |
| 包内 RPC | `harness.handle`（host）↔ `host.call`（client） | 无：客户端直接 `fetch()`，或走宿主注册的同源路由 |

### 5.2 kind：四种座位类型

| kind | 语义 | 多个人注册会怎样 | 关键选项 |
|---|---|---|---|
| `single` | 独占座位（一个坑） | **后注册的替换前一个**（同 `id` 是"换掉这一格"） | `id`（可选，标识自己） |
| `list` | 列表座位（可加很多） | **并排新增**；按 `order` 升序排列；用 `Fragment` 平铺，不额外包 DOM | `id`、`order`、`label` |
| `keyed` | 按 key 索引的座位 | 同一个 `key` 是**替换**，新 `key` 是**新增** | `key` |
| `chain` | 选举式座位（谁先"认领"谁上） | 注册者提供 `select(ownerProps)`，返回非 null 即接管；`priority` 大者优先 | `select`、`priority` |

真实例子：
- `list`：`conversation.view`（会话/轨迹/你的 tab 并排）、`conversation.input.dock`、`settings.section`
- `single`：`sidebar`、`conversation.session.header`、`conversation.composer.bar`、`settings.trigger`
- `keyed`：`main`（key = 面板 id）、`conversation.chat.node`（key = 节点类型）、`sidebar.right.pane.tab`
- `chain`：`conversation.composer`（审批面板 / 提问面板 / 只读子代理各自用 `select` 抢输入区）

`chain` 的注册长这样（`dsh-client-ui-approval/lib/client.js`）：

```js
ctx.slots.inject('conversation.composer', () => ctx.slots.register({
  name: 'conversation.composer',
  priority: 1,
  select: ({ pendingInteraction }) =>
    pendingInteraction instanceof PendingApproval ? pendingInteraction : null,
  locale: NS,
  children: { 'conversation.approval.detail': { kind: 'single', scope: 'session' } },
}, ApprovalPanel));
```

### 5.3 scope：四种作用域

| scope | 含义 | 生命周期 | 典型座位 |
|---|---|---|---|
| `root` | 全局，与具体会话无关 | 与插件同生命周期 | `sidebar.*`、`main`、`shell.overlay`、`settings.*` |
| `session` | **强绑定**当前会话 | 切会话时按 sessionId 重建实例 | `conversation.view`、`conversation.session.header.actions`、`conversation.input.dock` |
| `session-maybe` | 可能没有会话（hero 新建页） | 同上，但标准 props 允许"缺席"（`sessionId: undefined`） | `main.conversation`、`conversation.composer.bar`、`conversation.input.attachments` |
| （`root` 上还有 store 作用域轴） | — | 最后一个持有者卸载时销毁实例 | — |

> **为什么 scope 这么重要**：session 作用域的座位会**按会话重建**。你在 UI.md §5 里读到的
> "切会话不是刷新页面，面板实例是同一个，只换 `sessionId`"—— 那是组件实例复用的事实；
> 但**座位实例的 store** 是按 scope key 缓存的，并在 scope 死亡时清空（`registry.d.ts:124-139`）。

### 5.4 register() 的完整选项（从 shipped 代码实测）

```js
ctx.slots.inject(<slotKey>, () => ctx.slots.register({ /* options */ }, Component));
```

| 选项 | 用于 | 说明 | 证据 |
|---|---|---|---|
| `name` | 全部 | 座位 key（必须等于你 `inject` 的那个 key） | 全站 |
| `id` | `single` / `list` | 自己这一格的键。**复用别人的 id = 替换那一格**；新 id = 并排新增 | `dsh-client-ui-theme/lib/client.js`（`id: "appearance"`） |
| `key` | `keyed` | 索引键 | `dsh-client-ui-sidebar-right/lib/client.js`（`key: GUIDE_ID`）、`dsh-client-ui-chat`（`key: "present"`） |
| `order` | `list` | 升序排序（`chat`=0、`trajectory`=10、自建=20 排在轨迹右边） | `dsh-client-ui-chat`/`-trajectory`/`jeeflow-panel` |
| `priority` | `chain` | 选举优先级 | `dsh-client-ui-approval`（`priority: 1`）、`-subagent`（`priority: -10`） |
| `select` | `chain` | `(ownerProps) => value \| null`，非 null 即接管 | 同上 |
| `label` | `list`（部分） | 显示文本；字符串或 `() => string`。`conversation.view` 用它生成 tab 文案；`sidebar.panellist` 用它做可见文本 + 无障碍名 + 折叠提示 | `jeeflow-panel/lib/client.js:312`、`fdep-api-request/lib/client.js:914` |
| `locale` | 需要 `t` 的座位 | 命名空间，决定注入的 `t`；`"common"` 用共享词表 | `dsh-client-ui-layout/lib/client.js`（`locale: "common"`） |
| `children` | 声明子环 | **声明即独占渲染权**：声明了 `a.b.c`，别人就能坐进去 | `dsh-client-ui-sidebar`（声明 6 个）、`ui-layout`（声明 4 个） |
| `store` | 需要私有状态 | store 工厂 → 按 scope 实例化；组件经 `PropsStore` 拿到 `useStore`/`actions` | `dsh-client-ui-theme`（`store`）、`-chat`（`store: chatStore`） |
| `inject` | 需要私有数据 | `inject(scopeKey | actions) => Props`，返回值并入组件 props | `dsh-client-ui-theme`（`inject: injected`，参数是 store actions）、`-sidebar-right`（参数是 sessionId） |

**返回值是 disposer**（也交由 caller 的 fiber 管理）。

### 5.5 inject(key, cb)：为什么必须包一层

```js
ctx.slots.inject('conversation.view', () => ctx.slots.register({...}, Comp));
```

`inject` 是"**声明感知**"的：如果那个座位**当前已被声明**，回调**同步立刻执行**；如果还没被声明，
回调会在**声明提交之后**执行；声明崩塌（collapse）会 dispose 你的 effect，之后重新声明会**再执行一次**。
控制器属于 caller 的 fiber，所以插件卸载会取消等待并移除已生效的贡献
（`registry.d.ts:85-100`）。

**这就是"我的插件比 sidebar 先加载也能坐进去"的原因**，也是 shipped 代码里 UI 注册一律写成
`ctx.slots.inject(key, () => ctx.slots.register(...))` 的原因。

### 5.6 组件 props：五个来源的合成

平台把一个座位的 props 由五部分**合成**（以 sidebar 为例，`SidebarSectionOwnerProps` 附近的类型定义）：

| 来源 | 类型 | 内容 |
|---|---|---|
| **ownerProps** | 座位主人给的 | 座位专属数据。如 `sidebar.workspaces` 只拿到 `{ wide, expandSidebar }`；`conversation.input.dock` 拿到 `{ session, input }`；`settings.section` 拿到 `{ close }` |
| **standardProps** | 平台标准注入 | 全局：`useSessions`、`useWorkspaces`、`usePanelInfo`、`useSessionPendingInteraction`；会话级：`useSession`、`sessionId`、`useProjection`、`useConversation`、`useInput`、`inputActions`、`useChat` |
| **renderSlot** | 显式下传 | 座位主人把子座位的渲染函数给你（`PropsRenderSlots`）。`children` 声明的子环就靠它 |
| **inject face** | 你的 registrant 私有 | 你在 `register({ inject })` 里返回的东西 |
| **locale `t`** | 框架注入 | 由 `locale` 选项决定命名空间；键在词表里查不到会落到 `common`，再落到 key 本身 |

完整 props 类型名（便于查 `.d.ts`）：`PropsRuntime` / `PropsLocale` / `PropsRenderSlots` / `InjectFace` / `PropsStore`。

**标准 props 精确清单**（三个合并接口）：

```ts
GlobalStandardProps {
  useSessions; useWorkspaces; usePanelInfo; useSessionPendingInteraction;
}
SessionStandardProps {
  useSession; sessionId; useProjection; useConversation; useInput; inputActions; useChat;
}
SessionMaybeStandardProps {   // sessionId 可能 undefined
  useSession; sessionId; useProjection; useConversation; useInput; inputActions;
}
```

证据：`dsh-client-ui-session/lib/types/client/index.d.ts`（Global/Session/SessionMaybe 三个 `declare module` 块）、
`dsh-client-ui-conversation/.../contract/slots.d.ts:237-256`、`dsh-client-ui-chat/.../contract/slots.d.ts:129-137`、
`dsh-client-ui-layout/.../index.d.ts:23-27`。

### 5.7 两条必须刻进肌肉记忆的写法

**(1) 注册时必须把 props 转发给组件** —— 这是"座位给了你数据你却收不到"的头号原因：

```js
// ✗ 错：slot props 根本没传进去，inputActions 不存在
ctx.slots.inject('conversation.input.dock', () =>
  ctx.slots.register({ name: 'conversation.input.dock', id: 'x', order: 1 }, () => e(MyPanel)));

// ✓ 对：forward props
ctx.slots.inject('conversation.input.dock', () =>
  ctx.slots.register({ name: 'conversation.input.dock', id: 'x', order: 1 },
    (props) => e(MyPanel, props)));
```

**(2) 组件不能抓 DOM 改数据，只能用服务给的动作。** 输入框是 **Lexical 驱动的 contenteditable**，
`el.textContent = text` + 手派 `input` 事件会被编辑器用自己的模型重渲染时冲掉。正确做法是官方动作：

| 需求 | 官方口子 | 契约位置 |
|---|---|---|
| 写整段草稿 | `inputActions.setDraft(text)`（"Replace the whole draft"） | `contract/input.d.ts:210-221` |
| 读当前草稿 | `useInput(s => s.draft)` | `contract/input.d.ts:303-305` |
| 附件 | `inputActions.addAttachments / removeAttachment / pruneAttachments` | 同上 |
| 发送 | `inputActions.submit(...)` | 同上 |

### 5.8 服务面：`ctx.slots` 的其余能力（调试与高级用法）

| 方法 | 用途 |
|---|---|
| `register(options, Comp)` | 唯一的注册入口 |
| `inject(key, cb)` | 声明感知的注册（见 5.5） |
| `entries(key)` / `entriesOfSlot(key)` | 快照 / 每格胜出者（**读渲染结果**用后者） |
| `snapshot(root?)` | 导出 JSON 安全的座位树（**Client Inspect 的底座**） |
| `spec(key)` | 查一个座位的声明（kind/scope/owner） |
| `subscribe(key, fn)` / `getVersion(key)` | 变更订阅 / uSES 版本号 |
| `onEntryError(fn)` | 座位内组件崩溃的监督缝（`abdicated` 表示已被摘除） |
| `install(renderer)` / `installLocale(face)` | shell 专用（boot-once） |
| `provideRoot(contribution)` | 贡献全局标准数据（hook 名必须全局唯一） |
| `installScope(scope, adapter)` / `bindStoreScope(binding)` | 作用域适配（框架内部） |

---

<a id="6-座位地图按你的心智模型逐个对应"></a>
## 6. 座位地图：按你的心智模型逐个对应

下面按"用户视线"的顺序走一遍。每个座位给出：**key / kind / scope / ownerProps / 你能干什么 / 真实范例**。

### 6.1 左栏（sidebar）

```
sidebar                         single, root   ← ui-sidebar 的 SidebarRoot 占着
├── sidebar.brand.mark          single, root   owner: { size }
├── sidebar.brand.name          single, root   owner: {}
├── sidebar.panellist           list,   root   owner: { size, active }   ← 全局面板图标行
├── sidebar.workspaces          single, root   owner: { wide, expandSidebar }  ← ui-workspace 占着
├── sidebar.settings            single, root   owner: { wide }          ← ui-settings-general 占着
└── sidebar.footer.action       list,   root   owner: { wide }
```

几何事实（`dsh-client-ui-layout/README.md`）：宽 264–420px，默认 280px；折叠保留 **56px rail**；
**<1024px 自动折叠**；右栏打开时会自动收起手动展开的 sidebar。

- **换品牌标/名**：坐 `sidebar.brand.mark` / `sidebar.brand.name`（不用 fork 整个 sidebar）。
- **加一个"全局面板"**（整块主区页面）：**两步** ——
  ① `sidebar.panellist` 加一个图标项（`id` + `order` + `label`）；
  ② `main`（keyed）用**同一个 `id` 作为 `key`** 注册页面本体。
  选择缺失的 `main` key 会**抛错**且不改当前选择（`dsh-client-ui-sidebar/README.md`）。

真实范例（`bundles/fdep-api-request/lib/client.js:896-925`，可直接照抄）：

```js
inject: ['slots'],
apply(ctx) {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: 'fdep-api-request', order: 50,
        label: () => 'MCP Gateway' },
      (iconProps) => e(Glyph, iconProps)));

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: 'fdep-api-request' },
      (slotProps) => e(Panel, slotProps)));
}
```

> ⚠️ 不要注册 `sidebar` 本身 —— 那是 `single`，你会**顶掉整个导航列**，连同它声明的 6 个子座位。
> `dsh-client-ui-layout/lib/types/client/index.d.ts:29-38` 明确写了这一点。

### 6.2 主栏（main）与会话壳

```
main                            keyed, root    ← key = 面板 id；`conversation` 是保留 key
└── (key="conversation") main.conversation   single, session-maybe
    ├── conversation.session              single, session
    ├── conversation.session.header       single, session
    ├── conversation.composer             chain,  session
    ├── conversation.composer.bar         single, session-maybe
    ├── conversation.input.dock           list,   session
    ├── conversation.hero.brand.mark      single, root
    ├── conversation.hero.workspace       single, root
    └── conversation.hero.agentPreset     single, root
```

`ctx.layout.selectPanel(id)` 选择全局面板（`null` = 回到会话，且不改当前 Session）；
`ctx.layout.toggleSidebar()` / `openRightbar(track, fullscreen)` / `closeRightbar()`。

### 6.3 会话头（header）与 tabs（**这就是你说的"会话 / 轨迹"**）

```
conversation.session.header            single, session
├── conversation.session.header.lineage    single, session  owner: { lineageSessionId, displayTitle, openTitle? }
├── conversation.session.header.actions    list,   session  owner: {}
├── conversation.session.header.utilities  list,   session  owner: {}
└── conversation.session.header.corner     single, session  owner: {}  ← 只在有内容时占位
```

**tab 系统本体**是 `conversation.view`（`list` / `session`）：

- tab 由注册项**投影**得到：`ViewTab { id, label }`，`label` 取注册选项的 `label`，缺省回落成 `id`
  （`dsh-client-ui-conversation/lib/types/client/contract/views.d.ts:6`）。
- 每会话的"当前 tab"存在 Conversation shell 的 per-session store 里：`view: string | null`
  （`null` 解析到已注册的 Chat），外加一次性的 `viewRequest`
  （`views.d.ts:17-25`）。
- 已注册顺序：**`chat` = order 0**、**`trajectory` = order 10**
  （`dsh-client-ui-chat/lib/client.js`、`dsh-client-ui-trajectory/lib/client.js`）。自建排 20 就在轨迹右边。
- ownerProps：`{ viewRequest, openView(view, focus), completeViewRequest() }`。想在自己的组件里**跳到别的 tab**，
  用 `openView(id, focus)`。

**自建一个 tab 的完整模板**（`cordis-plugins/jeeflow-panel/lib/client.js:298-319`，已在本机跑通）：

```js
function apply(ctx) {
  ctx.effect(installStyles, 'jeeflow-panel: styles');
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'jeeflow-panel: dictionaries');

  var t = ctx.locale.bind(NS);
  ctx.slots.inject('conversation.view', function () {
    return ctx.slots.register(
      { name: 'conversation.view', id: 'jeeflow', order: 20, locale: NS,
        label: function () { return t('view.jeeflow'); } },
      JeeflowView);
  });
}
```

### 6.4 输入区（**你说的 chat input**）—— 一个卡 + 五个码头

先把"盒子层级"画清楚（这是等宽/对齐问题的根源）：

```
composerStack (flex column)                     ← .wSkVaW_composerStack
├── HeroShell / heroWorkspaceRow                ← 只在 hero（新建空会话）时出现
├── [data-slot = conversation.input.dock]       ← list 座位，锚点 display:contents（布局穿透）
│      └── 你的 entry（order 决定它在卡片前还是后）
├── 输入卡片 inputBar                              ← .uV2eYG_card
│      ├── conversation.input.attachments      single, session-maybe
│      ├── conversation.input.overlay          list,   session
│      ├── conversation.input.left             list,   session   （卡片工具行左侧）
│      ├── conversation.input.plan             single, session
│      ├── conversation.input.model            single, session
│      └── conversation.input.right            list,   session   （提交键之前）
└── [data-slot = conversation.composer.dock]    ← list 座位，**只在 variant==='composer' 时渲染**
```

| 座位 | kind / scope | ownerProps | 想放什么进去 |
|---|---|---|---|
| `conversation.composer.bar` | single / session-maybe | `{ variant: 'hero'\|'composer', blocked?, disabled?, placeholder?, accessory?, workspacePickerOpen?, onRequestWorkspace? }` | **整卡接管**（会顶掉 shipped 输入条） |
| `conversation.composer` | **chain** / session | `{ sessionId, session, pendingInteraction }` | 按业务条件**有条件地**接管输入区（审批/提问/只读） |
| `conversation.input.dock` | list / session | `{ session, input }` | 卡片**上方**的整宽面板 |
| `conversation.composer.dock` | list / session | — | 卡片**下方**的整宽面板（**hero 下不存在**） |
| `conversation.input.left` / `.right` | list / session | — | 卡片工具行的紧凑控件 |
| `conversation.input.overlay` | list / session | — | 卡片**内部**的浮层（如 `/` `@` 候选菜单） |
| `conversation.input.plan` / `.model` | single / session | `{ locked }` | 计划 / 模型选择器 |
| `conversation.input.attachments` | single / session-maybe | 见 `ComposerAttachmentsOwnerProps` | 附件轨道与放置目标 |

**hero vs composer**（这个区分是很多"为什么我的东西不出现"的根因）：

```
hero = sessionId === undefined || (shellPhase === 'blank' && (openState === 'open' || summaryBlank === true))
```

- `hero`（新建空会话）：`conversation.composer.dock` **根本不渲染**；
- `composer`（有内容的会话）：两个 dock 都在。

**因此"想在卡片下方放东西，且两种布局都要有"的正确做法**不是浮层、不是量高度，而是：
**注册两个 entry** —— 一个进 `conversation.input.dock` 并给它 `order: 2`（在 flex 排序里落到卡片之后），
一个进 `conversation.composer.dock`；在不适用的那一边 `return null`（不产生元素 = 不产生 flex item）。
完整推理见 `cordis-plugins/scene-template/UI.md` §4.4。

### 6.5 右栏（rightbar）与浮层（shell.overlay）

```
rightbar                        single, root   owner: { width, viewportWidth, canShow }
└── rightbar.session            single, session
    ├── sidebar.right.pane.tab        keyed, session
    ├── sidebar.right.pane.tab.title  keyed, session
    ├── sidebar.right.tab.guide       chain, session
    └── sidebar.right.tab.menu.item   list,  session
shell.overlay                   list,   root   ← 全框架浮层，**点击穿透**，entry 自己 opt-in pointer-events
```

- 右栏几何：首次打开占 **45% 视口**，之后保留用户像素偏好，**上限 70%**；为保住中央 400px，
  先把右栏压到 300px，再报告"空间不足"让宿主关闭它（`dsh-client-ui-layout/README.md`）。
- `canShow` 为 false 时**确定性关闭**，且**变宽不会自动重开**。
- `shell.overlay` 是"自己想加一块浮层"的正确座位（toast / badge / 状态胶囊），
  它**故意不属于任何 feature**，且**天然点击穿透**。
- 想在右栏里开自己的 tab：用 `ctx.sidebarRightTabs.register({ id, kind, patterns?, priority?, canOpen?, title, guide? })`
  注册类型，再用 `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: definition.id }, Body)` 注册本体
  （`dsh-client-ui-sidebar-right/README.md`，`ui-sidebar-documentpreview` 是"第三方类型"的活证明）。

### 6.6 设定弹窗（**你说的"设定的那个弹出框"**）

设定是**一个域（domain）**，不是一个组件：底座 `dsh-client-ui-settings` 只声明座位 + 提供传输层，
不渲染任何界面；渲染界面的 shell 是 `dsh-client-ui-settings-general`（它占 `sidebar.settings`）。

```
sidebar.settings                    single, root   ← ui-settings-general 占着，画触发按钮 + 弹窗
settings.trigger                    single, root   owner: { wide }        ← 触发行内容（图标+文字）
settings.header                     single, root   owner: {}             ← 面板标题文字座位
settings.action                     list,   root   owner: {}             ← 内容列头部动作（Close 之前）
settings.close                      single, root   owner: {}             ← 关闭键的**无障碍标签文本**
settings.section                    list,   root   owner: { close }      ← 一页 = 一个 section
settings.general.item               list,   root   owner: {}             ← 「通用」页里的一行偏好
settings.plugins.tab                list,   root   owner: {}             ← 「插件」页里的一个 tab
settings.onboarding                 list,   root   owner: { stepId, complete, openSection }
```

三条反直觉但重要的规则：

1. **`settings.section` 的选项里带导航身份**：`id`（页面 key，`only` 过滤用）、`order`（导航位置）、
   `label`（**由注册者本地化**；语言变了注册者要**重新注册**新文案 —— shell 不订阅 locale 状态，
   而 ledger 的版本递增兼作 shell 的重渲染触发器）。
2. **`settings.general.item` 没有任何 label 投影**：section 只把行竖着堆起来，行自己画内部，
   **包括它自己的标签**；owner 不传任何 props。文案、当前值、写入路径**全是你的**
   （通过你自己的 inject face + `ctx.settingsScope`）。
3. **shell 零文案**：触发器文案、面板标题、关闭的无障碍名、section 内容**全部来自注册者**。

**加一行设置的模板**（`dsh-client-ui-theme/lib/client.js` 的 Appearance 行）：

```js
const injected = (actions) => {            // actions 来自 store 选项产出的 store
  bound = actions;
  sync(theme.getTheme());
  return { setTheme: (id) => theme.setTheme(id) };
};

ctx.slots.inject('settings.general.item', () => ctx.slots.register({
  name: 'settings.general.item',
  id: 'appearance',
  order: 10,
  store,                // 你的行状态 store（可省）
  locale: SETTINGS_NS,  // 行自己声明命名空间
  inject: injected,     // 注入你自己的写入口
}, AppearanceRow));
```

**加一整页设置的模板**：

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'my-theme',            // 页面 key（导航身份）
  order: 60,
  label: () => t('section.title'),   // 注册者本地化；语言变化要重新注册
  locale: NS,
}, MyThemeSection));
// 组件 props 里会有 { close } —— 需要"跳出去"的流程用得上
```

### 6.7 会话内容座位（消息 / 工具 / 轨迹）

```
conversation.chat.node              keyed, session   key = 节点类型；owner = ChatNodeOwnerProps
conversation.chat.commandview       keyed, session   key = 命令名
conversation.chat.turnTail          chain, session   ← 已完成 Turn 的动作行之前
conversation.chat.assistant-actions list,  session   owner: { messageId }
conversation.message.images         single, session  owner: { images, loadImage, align, compact? }
conversation.trajectory.*           （轨迹侧的对应座位）
tool.call.toolview                  keyed, session   key = 工具名（例：fdep 的 'present'）
```

- `conversation.chat.node` 是 `keyed`：**复用 key = 替换该节点渲染器；没有 occupant 的类型就不渲染那一行**。
- `conversation.chat.turnTail` 是 `chain`：注册者提供 `select(owner) => value | null`，
  **第一个接受的**渲染；全都拒绝就是空。
- 想给"每个助手回复"加一个动作按钮：用 `conversation.chat.assistant-actions`（`{ messageId }`），
  新 `id` 是新增，复用 id 是替换。

### 6.8 一张表看全 SlotMap

| 座位 key | kind | scope | 一句话 |
|---|---|---|---|
| `root` | single | root | **禁止注册**（会顶掉 AppFrame） |
| `sidebar` | single | root | 整个左栏（**不要替**） |
| `sidebar.brand.mark` / `.name` | single | root | 品牌标 / 名 |
| `sidebar.panellist` | list | root | 全局面板图标行 |
| `sidebar.workspaces` | single | root | 工作区/会话浏览区 |
| `sidebar.settings` | single | root | 设置触发行（弹窗入口） |
| `sidebar.footer.action` | list | root | 设置旁边的动作 |
| `main` | keyed | root | 中央面板（`conversation` 保留） |
| `shell.overlay` | list | root | 框架级浮层（点击穿透） |
| `rightbar` | single | root | 右栏轨道 |
| `rightbar.session` | single | session | 每会话的停靠面 |
| `sidebar.right.pane.tab` / `.title` | keyed | session | 右栏 tab 体 / 标题 |
| `sidebar.right.tab.guide` | chain | session | 替换 guide 体 |
| `sidebar.right.tab.menu.item` | list | session | tab 菜单项 |
| `main.conversation` | single | session-maybe | 会话壳 |
| `conversation.session` | single | session | 会话体 |
| `conversation.session.header` | single | session | 会话头 |
| `conversation.session.header.lineage` | single | session | 面包屑标题 |
| `conversation.session.header.actions` | list | session | 标题旁动作 |
| `conversation.session.header.utilities` | list | session | 右对齐工具 |
| `conversation.session.header.corner` | single | session | 最右角（有内容才占位） |
| `conversation.view` | list | session | **tabs（会话 / 轨迹 / …）** |
| `conversation.composer` | chain | session | 输入区接管选举 |
| `conversation.composer.bar` | single | session-maybe | 输入卡本体 |
| `conversation.input.dock` | list | session | 卡**上方** |
| `conversation.input.overlay` | list | session | 卡**内部**浮层 |
| `conversation.composer.dock` | list | session | 卡**下方**（hero 下不存在） |
| `conversation.input.left` / `.right` | list | session | 工具行左 / 右 |
| `conversation.input.plan` / `.model` | single | session | 计划 / 模型选择器 |
| `conversation.input.attachments` | single | session-maybe | 附件轨道 |
| `conversation.hero.workspace` | single | root | hero 工作区选择 |
| `conversation.hero.brand.mark` | single | root | hero 品牌标 |
| `conversation.hero.agentPreset` | single | root | hero 代理预设 |
| `conversation.chat.node` | keyed | session | 聊天节点渲染器 |
| `conversation.chat.commandview` | keyed | session | 命令卡渲染器 |
| `conversation.chat.turnTail` | chain | session | Turn 尾部 |
| `conversation.chat.assistant-actions` | list | session | 助手消息动作 |
| `conversation.message.images` | single | session | 图片渲染 |
| `settings.trigger` / `.header` / `.close` | single | root | 设置触发 / 标题 / 关闭标签 |
| `settings.action` | list | root | 头部动作 |
| `settings.section` | list | root | 设置页 |
| `settings.general.item` | list | root | 通用页的一行 |
| `settings.plugins.tab` | list | root | 插件页 tab |
| `settings.onboarding` | list | root | 引导步骤 |

> 这张表是**投影，不是权威**。权威是各包的 `contract/slots.d.ts`（`declare module '@deepseek-ai/dsh-client-ui-slots'` 块）。
> 升级后想核对，直接 grep：
> `Select-String -Path <PKGS>\dsh-client-ui-*\lib\types\client\**\*.d.ts -Pattern 'kind: "'`

---

<a id="7-主题系统token--themeruntime--三层色板"></a>
## 7. 主题系统：Token / ThemeRuntime / 三层色板

### 7.1 一句话架构

```
ctx.theme (ThemeRuntime)  ──发布──▶  ThemeSnapshot（不可变）
        │                                   │
        │ 注册主题 / 覆盖令牌                  │ ui-layout 的 theme presenter 消费
        ▼                                   ▼
   ThemeDefinition[]                纯 DOM 写入：html{color-scheme}
                                    body[data-ds-dark-theme]
                                    body 上的 inline CSS 变量（别名令牌）
                                    <meta name="theme-color">
```

关键设计：**ThemeRuntime 不碰 DOM**（"never touches the DOM"），
**ui-layout 的 presenter** 才是把快照投影到文档上的那一层
（`dsh-client-ui-theme/lib/types/client/index.d.ts:1-9`、`dsh-client-ui-layout/README.md` Theme presentation）。

### 7.2 用户能选什么

| 项 | 取值 | 默认 | 写在哪 |
|---|---|---|---|
| 配色方案 | `light` / `dark` / `system` | — | 设置 → 通用 → Appearance 行 |
| 内容字号 | 整数 **12–17 px** | **14** | 设置 → 通用 → Font size 步进器 |

- `system` 通过 `prefers-color-scheme` 解析；OS 切换时（偏好为 `system`）重新发布。
- 字号影响：会话标题与正文同增量（含**用户气泡**与 **composer 草稿**）；flow-row 标题/摘要/表格比正文低一档；
  小字与代码**固定不变**。
- 持久化：`ui-theme` 命名空间 → `$DSH_HOME/settings.yaml`。**非 loopback 页面不进 Host 持久化**，
  两个选择只在进程内有效。

### 7.3 三张令牌表 + 一张派生表

| 前缀 | 层 | 谁用 | 例子 |
|---|---|---|---|
| `--dsw-static-*` | **原始色板**（不可变值） | 一般**别直接用** | `--dsw-static-deepseek-450`、`--dsw-static-neutral-bluish-100`、`--dsw-static-red-600` |
| `--dsw-alias-*` | **语义别名**（**你的默认选择**） | 你 99% 的 CSS | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-border-l1..l4`、`--dsw-alias-label-primary/secondary/tertiary/caption/dimmed`、`--dsw-alias-brand-primary`、`--dsw-alias-state-success-primary`、`--dsw-alias-interactive-bg-hover`、`--dsw-alias-button-primary-fill`、`--dsw-alias-markdown-*` |
| `--dsw-specific-*` | 组件专用语义 | 只有对应组件 | `--dsw-specific-bubble`、`--dsw-specific-sidebar-fill`、`--dsw-specific-sidebar-nav-item-active`、`--dsw-specific-input-major`、`--dsw-specific-menu`、`--dsw-specific-selector`、`--dsw-specific-tip` |
| `--dsh-*` | **平台派生量**（不是配色） | 布局 / 字号 / 滚动条 | `--dsh-content-font-size`、`--dsh-content-font-size-secondary`、`--dsh-content-font-delta`、`--dsh-scrollbar-thumb`、`--dsh-composer-card-max-width` … |

另有非色板一族：`--dsw-font-*`（字号阶梯）、`--dsw-shadow-lv1..3`、`--dsw-elevation-*`、
`--dsw-corner-shape`、`--dsw-mask-blur`、`--dsw-linear-gradient-think`。

**权威性声明**（很重要，官方 README 原文）：*"The token sheets are the sole color authority —
values absent from the design system are deliberately not appended"*。
也就是说：**设计系统里没有的值，不要自己造**（例如不要发明 `--dsh-primary-color` 这种东西，
`bundles/fdep-api-request/lib/client.js` 的开头注释就记了这次翻车：早期用了不存在的 `--dsh-*` 名字，
每个值都回落成硬编码深灰，浅色模式下整个面板看着"脱节"）。语义上最接近的令牌胜出。

### 7.4 完整核对：别名令牌清单（本机实测）

以下从 `dsh-client-ui-theme/lib/client.js` 抽出（共 ~70 个 `--dsw-alias-*`）：

**背景 / 层**
`bg-base` `bg-layer-1` `bg-layer-2` `bg-layer-3` `bg-mask-1` `bg-mask-2` `bg-mask-3` `bg-mask-drop`
`bg-mask-photo` `bg-module-platform` `bg-multi-select` `bg-overlay` `bg-skeleton`

**边框**
`border-l1` `border-l2` `border-l3` `border-l4` `border-l2-darkmode-thin` `border-inverted` `border-inverted2`

**文字**
`label-primary` `label-secondary` `label-tertiary` `label-caption` `label-dimmed` `label-primary-dimmed`
`label-primary-foreground` `label-primary-inverted` `label-primary-bluish` `brand-text` `link`

**品牌 / 交互**
`brand-primary` `brand-primary-invert` `interactive-bg-hover` `interactive-bg-hover-accent`
`interactive-bg-hover-danger` `interactive-bg-hover-solid` `interactive-bg-active`

**按钮**
`button-primary-fill` `button-primary-hover` `button-primary-dimmed` `button-contrast-fill`
`button-elevated-fill` `button-floating-fill` `button-floating-hover` `button-ghost-active-fill`
`button-ghost-active-border` `button-ghost-active-hover` `button-info-fill` `button-info-hover`
`button-tool-bar-fill` `button-tool-bar-fill-invisible` `button-tool-bar-hover`

**状态**
`state-success-primary` `state-success-secondary` `state-success-tertiary`
`state-warn-primary` `state-warn-secondary` `state-warn-tertiary` `state-warn-label`
`state-error-primary` `state-error-secondary` `state-business-primary` `state-business-tertiary`

**Markdown / 提示**
`markdown-inline-code` `markdown-code-block` `markdown-code-block-banner` `markdown-tag`
`markdown-citation` `markdown-placeholder` `markdown-code-segment-selected` `markdown-code-segment-unselected`
`tooltip-bg` `toast-bg` `hovercard-bg`

**滚动条（有专门的重绑定契约）**
`scrollbar-bg-l1` `scrollbar-bg-l2` `scrollbar-hover-l1` `scrollbar-hover-l2`

如果你只记 12 个：`bg-base`、`bg-layer-1`、`bg-layer-2`、`border-l1`、`border-l2`、
`label-primary`、`label-secondary`、`label-tertiary`、`brand-primary`、`state-success-primary`、
`state-error-primary`、`interactive-bg-hover`。

### 7.5 页面上的主题落点（presenter 写了什么）

| 落点 | 内容 | 用途 |
|---|---|---|
| `html { color-scheme }` | `light` / `dark` | 原生 UA 控件（滚动条、表单）跟着走 |
| `body[data-ds-dark-theme]` | 由**快照的 `colorScheme` 字段**决定，**不是由 id 决定** | 少数必须分叉时的选择器 |
| `body` 上的 inline CSS 变量 | 该主题的别名令牌（+ 折叠后的覆盖层） | 你的 CSS 直接读 |
| `--dsh-content-font-size` | 当前内容字号 | 字号阶梯的根 |
| `<meta name="theme-color">` | 跟随 body 计算背景 | 移动端浏览器 chrome |

> **所以：不要自己写 `@media (prefers-color-scheme: dark)`**，也不要硬编码 `#fff` / `#0f172a`。
> 读令牌，主题自动生效。（`scene-template/UI.md` §9 的"已知取舍"里明确把"硬编码浅色"列为待改项。）

### 7.6 滚动条：一个"间接层"契约（值得单独学）

- `scrollbar.css` 把 `body` 上的 `--dsh-scrollbar-thumb` / `-hover` 绑到 **l1** 基础面的令牌；
- **抬升面**（菜单 / popover / 对话框）在自己容器上**重绑定**到 l2 令牌；
- 这对令牌的另一个合法目标是 `transparent` —— `ui-sidebar` 就是这么做的：
  **指针不在列内时重绑成透明**，指针离开后还保留 2 秒拇指，做到"没人指着的列表不带滚动条"；
- `--dsh-scrollbar-width` 镜像是 WebKit 滚动条的**布局宽度**，给需要贴着滚动条对齐的面用
  （`ui-conversation` 的 composer 座位就是消费者）；
- 两条渲染路径**构造上互斥**：Firefox 走 `@supports not selector(::-webkit-scrollbar)` 里的标准属性，
  WebKit 走伪元素，所以 hover 令牌只会在伪元素路径上生效。

### 7.7 字号与排版阶梯

- 根：`--dsh-content-font-size`（设置值，12–17，默认 14）。
- `gradient-shadow-text.css` 从它派生 `--dsh-content-font-delta`，把 Markdown 标题与正文阶梯整体位移。
- 次级档 `--dsh-content-font-size-secondary`：设置值 ≤14 时 **−1**，>14 时 **−2**（默认 **13px**），
  带自己的 `--dsh-content-font-delta-secondary`，供表格变体与 flow row 用（比正文低一阶）。
- 密集小字与代码**固定**，不随设置走。
- 阶梯之外：**用户气泡**与 **composer 草稿**直接读正文那对变量。

**实践建议**：自定义面板里的次级文字，写
`font-size: var(--dsh-content-font-size-secondary, 13px)` + `line-height: 20px`
（`jeeflow-panel` 就是这么写的，`lib/client.js:86,110`）。带 `, 13px` 兜底是为了在非标准组合里不塌。

### 7.8 高度 / 阴影 / 圆角

- **抬升（elevation）**：`--dsw-elevation-stroke`（0.5px 发丝线，颜色走可重绑的
  `--dsw-elevation-stroke-color`）、`--dsw-elevation-panel` / `--dsw-elevation-prominent` /
  `--dsw-elevation-soft`（composer 用的大模糊低透明档，叠两层淡软阴影在线之上）。
  **因此抬升面设 `border: 0`，不占布局的描边。**
- **圆角**：`corner-shape.css` 在 `@supports (corner-shape: superellipse(1.5))` 里定义 `--dsw-corner-shape`，
  通过通用选择器应用到所有元素及其 `::before`/`::after` —— 不支持 `corner-shape` 的引擎保持圆角。
  **整圆（`border-radius: 50%`）和胶囊（pill 半径）必须自己配 `corner-shape: round`**，
  因为超椭圆会把它们拉变形。

### 7.9 注册一个第三方主题（完整做法）

API 形状（`dsh-client-ui-theme/lib/types/client/index.d.ts`）：

```ts
interface ThemeDefinition {
  id: string;                        // setTheme 的参数
  colorScheme: 'light' | 'dark';     // presenter 用它切 body[data-ds-dark-theme]，不是 id
  tokens: Record<string, string>;    // --dsw-alias-* 覆盖，**单值**（按 colorScheme 生效）
}

register(definition: ThemeDefinition): () => void;

overrideTokens(source: string,
  tokens: Record<string, { light: string; dark: string }>): () => void;
//   ↑ 注意：override 层**必须两种模式都给值** —— 否则用户切到另一个方案时会读不清
```

用起来：

```js
// 1) 注册一个具体主题（它自带 colorScheme，所以 tokens 是单值）
ctx.effect(() => ctx.theme.register({
  id: 'feg-ink',
  colorScheme: 'dark',
  tokens: {
    '--dsw-alias-brand-primary': '#7c3aed',
    '--dsw-alias-bg-base': '#0b0f19',
    '--dsw-alias-bg-layer-1': '#111827',
    '--dsw-alias-border-l1': '#1f2937',
    '--dsw-alias-label-primary': '#e5e7eb',
  },
}), 'feg-ink: theme');

// 2) 或者在**当前主题之上**叠一层令牌（不改注册表）—— 推荐给"跟随用户明暗选择"的皮肤
ctx.effect(() => ctx.theme.overrideTokens('feg-skin', {
  '--dsw-alias-brand-primary': { light: '#2563eb', dark: '#60a5fa' },
  '--dsw-alias-border-l1':     { light: '#e2e8f0', dark: '#1e293b' },
}), 'feg-skin: token layer');

// 3) 切主题（唯一写入口；未知 id 抛错）
ctx.theme.setTheme('feg-ink');
ctx.theme.setFontSize(15);

// 4) 读快照 / 追变更
const snap = ctx.theme.getTheme();      // ThemeSnapshot（不可变，变更前引用稳定）
ctx.on('theme/change', (s) => { /* ... */ });
```

覆盖层的层叠规则（值得精确记住）：

- 每个来源（`source`）**一层**；同一 source 再次调用 **替换整层并重新叠到最上面**；
- 多层按 **seq 顺序**折叠，**后者逐令牌胜出**；
- 每层的值按**当前配色模式**取值，所以 presenter 拿到的合成快照**不需要知道覆盖层的存在**；
- 移除一层，它盖住的东西**自动恢复**；
- 注册重复 id 抛错（内建 `light`/`dark` 也占 id；`system` 是偏好值，**不是可注册 id**）；
- **dispose 掉"当前生效偏好"背后的主题**会把偏好重置为默认，UI 绝不会停留在未注册主题的令牌上。

> **依赖声明**：`ui-theme` **自己**的 `inject` 是 `['slots', 'locale', 'remote', 'settingsScope']`
> （`remote` 携带转发来的设置失效通知，`ctx.settingsScope.bind(spec)` 在 caller 的 ctx 上订阅它）。
> 而**你的第三方主题插件**消费的是它 `ctx.provide('theme', ...)` 出来的服务，
> 所以你的 `inject` 里写 **`'theme'`** 即可（需要读设置文档时再加 `'settingsScope'`）。

**注意 `register` 的 `tokens` 是 `Record<string,string>`（单值），而 `overrideTokens` 是
`Record<string,{light,dark}>`** —— 这两个形状不一样是刻意的：具体主题自己声明 `colorScheme`，
而覆盖层要保证两种模式下都合法。

### 7.10 主题相关反模式清单

| ✗ 不要 | ✓ 应该 |
|---|---|
| 硬编码 `#fff` / `#0f172a` | `var(--dsw-alias-bg-base)` / `var(--dsw-alias-label-primary)` |
| 自己写 `@media (prefers-color-scheme: dark)` | 读令牌；主题已处理 |
| 发明令牌名（`--dsh-primary`、`--dsw-alias-my-color`） | 用最接近的语义令牌；确实缺，走设计系统补 |
| 直接读 `--dsw-static-*` 原始色板 | 用 `--dsw-alias-*`（原始色板不随主题变） |
| 在组件里 `classList.toggle('dark')` | 什么都不做；`body[data-ds-dark-theme]` 由 presenter 管 |
| 自己造滚动条颜色 | 重绑定 `--dsh-scrollbar-thumb` / `-hover` |
| 抬升面同时给 `border` 和 `box-shadow` | 抬升面 `border: 0`，用 `--dsw-elevation-*` |
| `border-radius:50%` 不配 `corner-shape: round` | 整圆/胶囊成对写 |
| 用 `ctx.theme.setTheme` 去写"用户还没选的"主题 | `setTheme` 是唯一写入口，但只在用户意图下调用 |

---

<a id="8-css-与布局把东西放进正确的盒子"></a>
## 8. CSS 与布局：把东西放进正确的盒子

### 8.1 座位锚点是 `display: contents`（布局穿透）

每个座位外层包一个 `display: contents` 的 div（`dsh-client-ui-renderer/lib/client.js:762-776`）。
**这意味着座位内容在布局上"穿透"到父容器**：父容器（flex/grid）**直接看到座位里的元素**，
不经过中间那层 div。

两个直接后果：

1. `list` 座位里的多个 occupant 用 `Fragment` 平铺，**不额外包一层**
   （`dsh-client-ui-renderer/lib/client.js:869`）；
2. 你的 entry 的根元素**就是父容器的直接子项** —— 所以 `order`、`flex`、`gap` 都按"父容器的子项"来算。
   `scene-template` 的"模板墙"就是靠这条把 `order: 2` 用成"落到输入卡片之后"。

### 8.2 布局变量速查（`--dsh-*`）

| 变量 | 定义处（概念上） | 含义 |
|---|---|---|
| `--dsh-chat-content-width` | 会话根 | 聊天内容宽度基准 |
| `--dsh-chat-user-width` | 会话根 | 用户气泡宽度基准 |
| `--dsh-chat-flow-gap` | chat | flow（工具/过程）行间距 |
| `--dsh-composer-card-max-width` | 会话根 | **输入卡最大宽** = `chat-content-width + 32px` |
| `--dsh-composer-side-clearance` | 会话根 | 卡片两侧留白（**16px**） |
| `--dsh-composer-dock-inset` | 会话根 | 浮起提示卡的几何内缩（**8px**）—— **平级面板用不到** |
| `--dsh-composer-stack-gap` | composerStack | 栈内 gap（**6px**） |
| `--dsh-composer-height` | composer | 卡片高度 |
| `--dsh-composer-text-max-height` | composer | 草稿区最大高 |
| `--dsh-composer-hint` | composer | 提示行 |
| `--dsh-conversation-column-width` | 会话 | 会话列宽 |
| `--dsh-conversation-viewport-height` | 会话 | 会话可视高 |
| `--dsh-sidebar-inline-padding` | sidebar | 侧栏内水平内距 |
| `--dsh-scrollbar-width` | theme/scrollbar | WebKit 滚动条占位宽 |
| `--dsh-width-handle-pointer-y` | layout | 拖拽把手命中区 |
| `--dsh-table-lead` / `--dsh-table-spare` | chat | 表格排版余量 |

### 8.3 和输入卡对齐（最常被问的问题）

你的 entry 与输入卡是**同一个 `composerStack` 里的兄弟**（`conversation.input.dock` 锚点穿透）。
所以正确写法是**抄输入卡自己的盒子**：

```css
.my-panel {
  /* 100% = composerStack 宽度 */
  width: calc(100% - 2 * var(--dsh-composer-side-clearance));
  max-width: var(--dsh-composer-card-max-width);
  margin: 0 auto;                                  /* 居中靠 auto margin，不用算 */
  padding: 0 14px;                                 /* 内文左边界对齐输入文字 */
}
```

三条"抄公式"的纪律（`scene-template/UI.md` §4.1 的血泪版）：

1. **抄公式必须连同它的盒子上下文一起抄。** TodoPanel 的 `.lXshSW_root` 写的是
   `calc(100% - 2*clearance - 4*inset)` —— 多减的 4 个 `dock-inset` 是**它自己那层"浮起提示卡"**的几何，
   照抄到平级面板上正好每侧窄 16px。
2. **不要用 `getBoundingClientRect()` 量宽度补偿。** 父容器可能被 flex 居中/紧贴内容收缩，
   基准会随面板自己移动 —— 偏移量成了**自我依赖**的量，数据一多就飘。
3. **上下两个 dock 的基准公式不一样**（嵌套层数不同）：`conversation.composer.dock` 里的 shipped 组件用
   `padding: 0 8px`（多减 2 个 inset）。**先看 DOM 层级，再决定抄哪一行。**

### 8.4 隐藏滚动条只能靠 CSS

内联 `style` **无法**选中 `::-webkit-scrollbar` 伪元素，必须注入样式表：

```css
[data-my-scroll]::-webkit-scrollbar { display: none }
[data-my-scroll] { scrollbar-width: none; -ms-overflow-style: none }
```

（保留 `overflow-x: auto`，滚轮/触控板仍可用，只是看不见条。）

### 8.5 样式注入的两条路径

```js
// 静态 bundle：自建 <style> + ctx.effect 清理
function installStyles() {
  if (document.getElementById(STYLE_ID)) return function () {};
  var s = document.createElement('style');
  s.id = STYLE_ID; s.textContent = CSS;
  document.head.appendChild(s);
  return function () { s.parentNode && s.parentNode.removeChild(s); };
}
ctx.effect(installStyles, 'my-plugin: styles');   // ← 注意：不要把已造好的 disposer 直接传
```

```js
// 动态 Package：官方口子
const dispose = styles.insert(css);   // 自动打 data-dyn=<pluginId>，随包卸载清理
```

### 8.6 指针事件陷阱（拖动 + 点击）

`pointerdown` 就 `setPointerCapture` 会把随后的兼容鼠标事件（`mouseup` / `click`）一起**重定向到捕获元素**，
导致里面的 chip 点不中。正确做法：

- `pointerdown` **只记起点，不捕获**；
- `pointermove` 越过 **4px 阈值**、确认进入拖动后才 `setPointerCapture`；
- 拖动结束后紧随的那个 `click` 用 `onClickCapture` 里 `stopPropagation + preventDefault` 吞掉；
- `pointerType === 'touch'` 直接让位给原生滑动。

### 8.7 长驻 iframe（切 tab 不重新加载）

内嵌远程页面时，把 `<iframe>` 做成**模块级单例**：挂载时 re-parent 进 view 的 host div，
卸载时**停到屏外 keeper**（用 `visibility:hidden`，**不要 `display:none`** —— 后者会让文档停止运行），
而不是销毁它。`cordis-plugins/jeeflow-panel/lib/client.js:130-173` 是完整实现。

注意：跨域 iframe 的 `el.contentWindow.location.reload()` 会抛；
**同值赋值 `el.src = URL` 才是不抛的重载法**（同文件 `:235`）。

---

<a id="9-本地化-locale所有文案的唯一出口"></a>
## 9. 本地化 locale：所有文案的唯一出口

**规则：界面文案不走硬编码，走 `ctx.locale`。**

```js
var NS = 'my-plugin';
var zh = { 'view.mine': '我的面板', 'btn.reload': '重新整理' };
var en = { 'view.mine': 'My Panel',  'btn.reload': 'Reload' };

function apply(ctx) {
  // 1) 注册词表：一次给全部内建语言（双语平衡在注册时强制）
  ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'my-plugin: dictionaries');

  // 2) 绑定成稳定的翻译函数（同命名空间重复 bind 返回同一个函数，不破坏 memo）
  var t = ctx.locale.bind(NS);

  // 3) 用 t
  ctx.slots.register({ name: 'conversation.view', id: 'mine', order: 20, locale: NS,
    label: function () { return t('view.mine'); } }, Comp);
}
```

要点（`dsh-client-ui-locale/lib/types/client/index.d.ts`）：

- **查找链**：先按当前语言在**你声明的 fallback 链**里查你的命名空间，再在共享的 `common` 命名空间重复一遍，
  最后**显示 key 本身**。
- **英文是双重角色**：既是"浏览器没指定已注册语言"时的开屏语言，也是**落底语言**。
- **两种 `register` 形态**：类型化的 `register(ns, { zh, en })`（key 集合收窄成编译期检查）
  和 非类型化的 `register(ns, locale, dict)`（语言包/动态组合用）。
- **重复 `(ns, locale)` 抛错**（一个命名空间只有唯一 owner）。
- **注册会 bump revision**（已挂载的 outlet 能拾到晚到的词表），
  但**只有切换语言才发 `locale/change`** —— 目的是避免注册密集的启动阶段风暴式触发监听器。
- **座位选项里的 `label` 文案由注册者本地化**：语言变化时**注册者要重新注册**新文案
  （`settings.section` 的契约明确写了这一点，shell 不订阅 locale 状态）。
- 加一门**可选语言**：`ctx.locale.addLanguage({ id, label, fallback })`
  （fallback 必须已注册，且链必须终止于英文）。

**一个真实范例**：`cordis-plugins/jeeflow-panel` 只在词表里写**简体**，
`zhtw-traditional-chinese` bundle 在运行时把 `zh` 自动转成繁体 ——
所以插件作者只需要维护一份简体词表。这是"语言包"这一类插件的正确用法。

---

<a id="10-设置持久化settingsscope-与-host-设置文档"></a>
## 10. 设置持久化：settingsScope 与 Host 设置文档

### 10.1 一条铁律

**浏览器里只有一个 settings 文档镜像**（`SettingsDescribeMirror`），
所有派生面都从这**唯一来源**读 —— 所以任何时刻全站看到的是同一个文档 revision。
`settings.describe` 在客户端**只准有一个读者**（`dsh-client-ui-settings/README.md`）。

### 10.2 绑定一个命名空间

```js
// 你的插件 inject 里要有 'settingsScope'（以及 'remote'，它携带失效通知）
const scope = ctx.settingsScope.bind({ namespace: 'my-plugin' });

scope.getSnapshot();          // { section, base, user, revision, writable, mode }
//   user 里存在即"被覆盖"（即使值等于 base）；unset 清除这个覆盖

await scope.set('mode', 'compact');                    // 单操作
await scope.unset('mode');
await scope.mutate([{ path: ['mode'], value: 'x' }]);  // 多操作，原子
```

特性：

- **写被命名空间 revision 围栏**（`expectedRevision`）—— 并发写会被**拒绝**而不是静默覆盖。
  暂存式编辑器可以把"draft 开始时的 revision"作为固定围栏。
- **提交的写把答案折回镜像**（无需重读）；**被拒/失败的最近一次写触发一次镜像恢复读**；
  被取代的写把恢复留给后继者。
- **非 loopback 页面拿不到 durable settings**：scope 从 `unavailable` 起步，永不跨线，
  它支撑的每一行都是"死的"（即使 Connection 鉴权覆盖 API）。
- `bind` 在**caller 的 fiber** 上建 scope（服务代理在调用时把 `this.ctx` 绑到 caller），
  所以 scope 的 disposer 属于你的插件；绑定**不产生额外的一次线读**。

### 10.3 一行偏好设置该长什么样

职责划分（这是设计意图，照做就不会错）：

| 谁 | 负责 |
|---|---|
| `settings.general.item` 的 **owner（你）** | 文案、当前值、写入路径、失败呈现 —— **全是你** |
| section（`ui-settings-general` 的 General 页） | **只**把行竖着堆起来 |
| shell | 弹窗可见性、导航、chrome |

所以你的行组件要用自己的 `inject` face 拿数据、用自己的 `t` 拿文案、通过 `ctx.settingsScope` 写值。

---

<a id="11-调试与验证怎么知道注册上了没有"></a>
## 11. 调试与验证：怎么知道"注册上了没有"

### 11.1 四招（按性价比排序）

1. **Client Inspect 看座位占用**：`ctx.slots.snapshot(root?)` —— 不带 `root` 看拓扑，
   带 `root` 看 occupant 与 ownerProps/standardProps。判断"注册上了没有"。
   `entries(key)` 查原始项，`entriesOfSlot(key)` 查**每格胜出者**（渲染结果）。
2. **在用户看得见的面板里渲染一行临时读数**（最有效的一招）：例如
   `hero=… bottom=… inline=… wall=…`。它一次区分三种完全不同的故障：
   **没渲染** / **渲染了没数据** / **渲染了但看不见**。
3. **读自己的 boot 记录**：`window.__DSH_BOOT__` 里能看到你这个 bundle 的 **`rev`（内容哈希）**。
   改文件 → rev 变 → 证明宿主确实重读了；改回去 → rev 逐字节回来。
   `node test/dev-boot.js`（fdep 的做法）直接打印 URL + rev。
4. **看 HMR 通道**：SSE `/plugins/events`；改 `lib/client.js` 应看到 `rebuilt` 帧。
   `test/dev-events.js 10` 就是盯 10 秒。

### 11.2 离线合成验证 patch（不启动服务、不改 profile）

用 `@deepseek-ai/dsh-app-boot` 的 `loadProfile()` + `composeEntries()` 在进程内把
真实 profile 各层 + 你的新 bundle 的 patch 合成，确认**行落点与 id 不冲突**。
`scene-template/UI.md` §7.5 记了这条。

### 11.3 座位崩溃会被隔离

`ctx.slots.onEntryError((key, entry, error, { abdicated }) => …)` 观察**每个渲染期 entry 失败**
（包括没被摘除的）。`abdicated: true` 表示这次崩溃已经让该 entry 从它的格子里退休。
这是"镜像贡献健康度"的监督缝。

### 11.4 常见"注册了但看不见"的排查顺序

```
① 座位存在吗？        —— 没有会话/hero 布局下 conversation.composer.dock 根本不存在
② 声明存在吗？        —— 你 inject 的 key 必须已被某个包的 children 声明；否则回调在等
③ kind 对了没？       —— 往 keyed 座位注册不给 key；往 single 注册指望"并排"
④ scope 对了没？      —— session 座位没会话时不实例化
⑤ props 转发了吗？    —— () => e(Comp) 而不是 (p) => e(Comp, p)
⑥ 高度算得出来吗？    —— flex 容器里没给 min-height，iframe 会塌成 0
⑦ 被别人的 entry 顶了吗？—— single/keyed 同 id/key 是**替换**
⑧ CSS 读到了吗？      —— 令牌名打错 → 值回落 → 看着"没生效"
```

### 11.5 测试一个客户端 bundle，不用起浏览器

`bundles/fdep-api-request/test/client-contract.test.js` 是范本，它验证：

- loader 包装形状（`window.__ModuleLoader__.load` 的存在性与回退路径）；
- `require('react')` 依赖（**没有 React 全局**）；
- `slots.inject` / `slots.register` 契约；
- 真实渲染面板并点击按钮；
- 呈现契约（**每个 CSS 变量都是真令牌**、没有硬编码的明暗分叉）。

`bundles/fdep-api-request/test/preview.js` 更进一步：用真样式表把组件在多个状态渲染成**独立页面**
（带明暗切换），并在写盘前**自校验**（每个发出的 class 都要有规则、SVG 自闭合、不泄漏 React-only prop）。
它查出过三个真实缺陷：一个没有规则的 modifier class、被 HTML 解析器吞掉的 `<path>`、泄漏的 `key` 属性。

---

<a id="12-反模式与陷阱总表"></a>
## 12. 反模式与陷阱总表

| # | ✗ 反模式 | 为什么错 | ✓ 正确做法 |
|---|---|---|---|
| 1 | 注册 `root` 座位 | `root` 是 single，你**顶掉整个 AppFrame** | 整页浮层用 `shell.overlay` |
| 2 | 注册 `sidebar` 本身 | 顶掉导航列 + 它声明的 6 个子座位 | 坐进 `sidebar.*` 的子座位 |
| 3 | `register(opts, () => e(Comp))` | slot props 没传进去，`inputActions`/`t` 全没有 | `(props) => e(Comp, props)` |
| 4 | 直接改输入框 DOM | 输入框是 **Lexical contenteditable**，会被模型重渲染冲掉 | `inputActions.setDraft()` / `useInput(s=>s.draft)` |
| 5 | 用 `getBoundingClientRect()` 对齐输入卡 | 父容器会随内容收缩，基准自我依赖 | 抄 `--dsh-composer-*` 公式 |
| 6 | 照抄别处的宽度公式 | 盒子上下文不同（多减/少减 dock-inset） | 先看 DOM 层级，再决定抄哪行 |
| 7 | 硬编码颜色 / 自造令牌名 | 浅色主题下"脱节"；令牌表是唯一颜色权威 | `var(--dsw-alias-*)` |
| 8 | 自己写 `prefers-color-scheme` | presenter 已把结果写到 `body[data-ds-dark-theme]` | 什么都不做 |
| 9 | `ctx.effect(dispose)` | effect 会**立刻调用**它并把返回值当 disposer | `ctx.effect(() => dispose, label)` |
| 10 | 动态 Package 只重发 `code.client` | Package 是整版替换，宿主半边会被丢 | 每次带齐两半 |
| 11 | 动态客户端里用 `setTimeout` / `fetch` / `require` | 被沙箱毒化（抛教学错误） | `inject:['timer']`+`ctx.timeout()`；`host.call`；`React` 闭包符号 |
| 12 | 忘记 `inject` 就访问服务 | 抛 `... without inject` | 在插件对象 `inject` 数组里声明 |
| 13 | 用 `- id:` 想加**新**宿主行 | 裸 `- id:` 只修补**已存在**的 entry | 用 `- insert:` 块 |
| 14 | 同时用 bundle 列表 + `insert` 行注册同一个包 | 抛出 `duplicate loader entry id` | 只保留一处（见 §13 注释） |
| 15 | 在 `lib/client.js` 里 import 别的插件 | 客户端 bundle 纯净性门禁禁止跨插件值导入 | 走 cordis 服务 |
| 16 | 以为改 `lib/index.js` 也能热更 | 宿主模块只在 boot 时 import 一次 | 改宿主代码要重启 |
| 17 | `pointerdown` 就 `setPointerCapture` | 后续 `click` 被重定向，子元素点不中 | 过 4px 阈值再捕获 + 吞尾随 click |
| 18 | 用 `display:none` 停靠常驻 iframe | 文档停止运行，切回来要重载 | `visibility:hidden` + 屏幕外 keeper |
| 19 | 跨域 iframe 用 `contentWindow.location.reload()` | 抛跨域异常 | 同值赋值 `el.src = URL` |
| 20 | 内联 style 里写 `::-webkit-scrollbar` | 伪元素无法被内联 style 选中 | 注入样式表 |
| 21 | `label` 里写死中文 | 语言切换不刷新 | `t()` + 语言变化时重新注册 |
| 22 | 用 `--dsh-*` 当颜色令牌 | `--dsh-*` 是布局/派生量，不是配色 | 配色用 `--dsw-alias-*` |
| 23 | 抬升面同时给 border + shadow | 会多占布局描边 | `border: 0` + `--dsw-elevation-*` |
| 24 | 整圆不配 `corner-shape: round` | 超椭圆把圆拉变形 | 成对写 |

---

<a id="13-术语表中英对照"></a>
## 13. 术语表（中英对照）

| 中文 | 英文 | 一句话 |
|---|---|---|
| 插件 | Plugin | Cordis 里的一个能力单元，由 `apply(ctx)` 装配 |
| 半边 | half（host half / client half） | 同一个插件的 Node 端与浏览器端代码 |
| 上下文 | Context（ctx） | 插件拿服务的入口；生命周期由 Fiber 管 |
| 光纤 | Fiber | 插件实例的生命周期容器；卸载时回收它上面的一切 |
| 服务 | Service | 别人提供的能力（`ctx.slots` / `ctx.theme` / `ctx.locale`…） |
| 注入 | inject | 声明依赖。**两个同名概念**：包级（模块顺序）与服务级（服务名） |
| 副作用 | effect | `ctx.effect(fn, label)`：立即执行 `fn`，用其返回值做清理 |
| 座位 | Slot | UI 上预留的可插拔位置，有 kind 与 scope |
| 座位地图 | SlotMap | 全部座位 key 的类型化登记表（declaration merging） |
| 占座者 | occupant / entry | 坐进座位的一次注册 |
| 格 | cell | 一个座位里的某一"格"，由 `id`/`key` 决定；复用即替换 |
| 声明 | declaration | 座位主人用 `children` 挖出子环；**声明即独占渲染权** |
| 声明感知注入 | declaration-aware inject | `slots.inject(key, cb)`，声明出现/塌陷时重跑回调 |
| 作用域 | scope | `root` / `session` / `session-maybe` |
| 选举 | chain / election | 座位按 `select` + `priority` 决定谁上 |
| 令牌 | token | CSS 变量形式的设计常量（`--dsw-alias-*` 等三层） |
| 别名令牌 | alias token | 语义层令牌，随主题变；你的默认选择 |
| 静态令牌 | static token | 原始色板，不随主题变 |
| 主题定义 | ThemeDefinition | `{ id, colorScheme, tokens }` |
| 主题快照 | ThemeSnapshot | 不可变的主题状态，`theme/change` 携带 |
| 令牌覆盖层 | token override layer | `overrideTokens(source, {light,dark})`，按 seq 折叠加叠 |
| 呈现器 | presenter | ui-layout 里把主题快照写进 DOM 的那层（唯一碰 DOM 的） |
| 编排 | composition | 一套 profile 的插件组合 |
| 配置层 / 补丁层 | patch layer | `cordis.patch.yml` 里的 loader patch 条目 |
| 组合图 | boot graph | 注入给浏览器的"要加载哪些 bundle"清单（`__DSH_BOOT__`） |
| 模块门面 | module facade | `window.__ModuleLoader__` |
| 物料化 | materialize | 真正执行 bundle 模块体、跑 `factory(require)` |
| 座位出口 | SlotOutlet | 座位在 DOM 上的锚点（`display: contents`） |
| 内容贯通 | layout pass-through | 锚点 `display:contents` 造成的"座位内容直连父容器" |
| 抬升 | elevation | 面与面的"浮起"表达（描边 + 软阴影） |
| 空会话 | hero | 新建会话的空态布局（`composer.dock` 不存在） |

### 关于 `duplicate loader entry id`（实战备忘）

`$DSH_HOME/profiles/web/cordis.patch.yml` 里有一段值得抄的注释：

```yaml
# NOTE: this row is the SINGLE source for the plugin. It is deliberately NOT
# also listed in this profile's `dsh.profile.bundles` — two rows with the same
# loader id make the Loader throw `duplicate loader entry id`. The package
# stays in `dependencies` so `name: jeeflow-panel` resolves from the profile.
```

**精确规则**：Loader 在每次 `EntryGroup.update(config)` 时用一个 `Set` 检查
**同一个兄弟列表内**的 id 是否重复，重复就 `throw new TypeError('duplicate loader entry id: <id>')`。
它**不是全局检查**（嵌套 id 用 `:` 前缀区分），但**整个 profile 组合是"对空根的一次扁平 patch 列表"**，
所以每个层的顶层 `insert:` 都落进**同一个根 group 的 config 数组** —— 两层插入同一个 `id` 必然撞车。
而且 `applyEntryPatches` **不去重**（`data.push(...insert)` 两行都留着），
所以要等到 `root.update(data)` 才炸，**boot 直接失败**。

因此：**一个 bundle 的宿主行，只能在 bundle 自己的 `cordis.patch.yml` 与 profile 的
`cordis.patch.yml` 其中一处出现。** 如果你之后又跑了一次
`dsh plugin --profile web add/update`，它会把 bundle 条目重新加回 `dsh.profile.bundles`
（因为 `exportsPatch` 看到 `dsh.bundle.patch`）—— 那时要删掉重复的那一处。

**不要混淆的四个相邻错误**：

| 报错 | 含义 |
|---|---|
| `duplicate loader entry id: X` | 同一兄弟列表里两行同 id（本节） |
| `package X resolves from multiple active Loader sources` | 两行 loader entry 解析到**同一个包**（即使 id 不同）—— 客户端模块表层面 |
| `duplicate graph entry "X"` / `duplicate combo batch URL` | boot graph 里的重复（浏览器侧） |
| `duplicate factory registration for "X"` | 同一个 bundle 被执行了两次（没 invalidate） |
| `patch: entry "X" not found`（**只是 warning**） | 你想 `- id:` 修补一个不存在的行 —— 这正是"忘了用 `insert:`"的症状 |

---

<a id="14-证据索引本机文件--行"></a>
## 14. 证据索引（本机文件 : 行）

`<PKGS>` = `D:\Refine\Books\ntop\AI\dsh\profiles\node_modules\@deepseek-ai`
`<CLI>` = `D:\Refine\Books\ntop\AI\node\global\node_modules\@deepseek-ai\dsh`

### 座位系统

| 结论 | 位置 |
|---|---|
| `root` 是单座、被 AppFrame 占；注册它会顶掉一切 | `<PKGS>/dsh-client-ui-renderer/lib/types/client/registry.d.ts:23-31` |
| `register` 走 caller 的 `ctx.effect`；`inject` 的声明感知语义 | 同上 `:67-100` |
| 座位快照 / 声明查询 / 变更订阅 / 顺序遍历 | 同上 `:149-222` |
| `sidebar` 的 6 个子座位声明 | `<PKGS>/dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts:14-75` |
| sidebar 全量 owner props（`wide` / `size` / `active` / `startSession` …） | 同上 `:76-151` |
| `main` 是 `keyed`；`sidebar`/`rightbar` 是 `single`；`shell.overlay` 是 `list` 且点击穿透 | `<PKGS>/dsh-client-ui-layout/lib/types/client/index.d.ts:28-104` |
| 布局服务面（`selectPanel`/`toggleSidebar`/`openRightbar`/`closeRightbar`） | 同上 `:17-22` + `dsh-client-ui-layout/README.md` |
| 会话座位全家桶（header / view / composer / docks / hero） | `<PKGS>/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:110-256` |
| `ViewTab` / 每会话 `view` + `viewRequest` | `<PKGS>/dsh-client-ui-conversation/lib/types/client/contract/views.d.ts:1-26` |
| 标准 props（Global / Session / SessionMaybe） | `<PKGS>/dsh-client-ui-session/lib/types/client/index.d.ts`（三个 `declare module` 块） |
| `useChat` / chat 座位（node / commandview / turnTail / assistant-actions / images） | `<PKGS>/dsh-client-ui-chat/lib/types/client/contract/slots.d.ts:129-196` |
| `InputActions` / `InputState.draft` / Lexical | `<PKGS>/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:1-7, 210-221, 237-241, 303-305` |
| 设置域全部座位 + 契约注释 | `<PKGS>/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts:11-119` |
| `settings.general.item` 无 label 投影、行自画一切 | 同上 `:100-118` |
| `settings.section` 的 id/order/label 由注册者本地化 | 同上 `:56-71` |
| chain 座位的 `select` + `priority` 实例 | `<PKGS>/dsh-client-ui-approval/lib/client.js`、`dsh-client-ui-subagent/lib/client.js`、`dsh-client-ui-user-questions/lib/client.js` |
| `chat`=0 / `trajectory`=10 的 tab 注册 | `<PKGS>/dsh-client-ui-chat/lib/client.js`、`dsh-client-ui-trajectory/lib/client.js` |
| `standardProps` 下传与 `inputActions` 注入 | `<PKGS>/dsh-client-ui-conversation/lib/client.js`（`ctx.uiSession.provide`） |

### 主题与令牌

| 结论 | 位置 |
|---|---|
| ThemeRuntime API（`getTheme`/`setTheme`/`setFontSize`/`register`/`overrideTokens`） | `<PKGS>/dsh-client-ui-theme/lib/types/client/index.d.ts:109-188` |
| `ThemeDefinition` / `ThemeTokenModes` / `ThemeSnapshot` | 同上 `:27-83` |
| 字号 12–17 / 默认 14 / 三层色板 / 覆盖层折叠 | `<PKGS>/dsh-client-ui-theme/README.md` |
| 令牌是唯一颜色权威；第三方主题是扩展点不是产品 | 同上 Known Limitations |
| `--dsw-*` / `--dsh-*` 全量名 | `<PKGS>/dsh-client-ui-theme/lib/client.js`（grep `--dsw-`/`--dsh-`） |
| presenter 的 DOM 落点（color-scheme / data-ds-dark-theme / meta theme-color） | `<PKGS>/dsh-client-ui-layout/README.md`（Theme presentation） |
| 滚动条间接层契约 | `<PKGS>/dsh-client-ui-theme/README.md`（Scrollbar rebinding） |
| 字号阶梯与二级档 | 同上（`gradient-shadow-text.css` 段） |
| 抬升与 `corner-shape` | 同上 |
| `--dsh-composer-*` / `--dsh-chat-*` 等布局变量 | `<PKGS>/dsh-client-ui-conversation/lib/client.js`（grep `--dsh-`） |
| 消费令牌的真实 CSS 范例 | `cordis-plugins/jeeflow-panel/lib/client.js:76-112`、`bundles/fdep-api-request/lib/client.js`（`PANEL_CSS`） |

### 引导 / 模块 / 交付

| 结论 | 位置 |
|---|---|
| 静态模块表精确清单 | `<PKGS>/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js`（`staticModules` / `function by()`） |
| `__ModuleLoader__.create` / `__DSH_BOOT__` / `immediately` 预取 | 同上（`class My{ async run() }`） |
| 懒加载、materialize、`/plugins` combo、rev 哈希 | `<PKGS>/dsh-client-modules/README.md` |
| `dsh.client` 声明（`platform`/`inject`/`external`/`immediately`） | 同上（Declaring a client plugin / Sharing modules） |
| 客户端 bundle 纯净性门禁（禁跨插件值导入） | `<PKGS>/dsh-client-ui-settings/lib/types/client/settings-scope.d.ts:93-99` |
| HMR：500ms 轮询 + `/plugins/events` SSE + `rebuilt` | `bundles/fdep-api-request/README.md`（Development loop） |
| 三层迭代成本 | 同上（The three tiers） |
| JS 侧 `ctx.effect` 语义与踩坑 | 同上（What the contract testing changed，第 1 条） |
| 座位锚点 `display:contents` 与 list 平铺 | `<PKGS>/dsh-client-ui-renderer/lib/client.js:762-776, 869`（行号见 `scene-template/UI.md` §8） |
| 动态工具参数与沙箱毒化清单 | `<CLI>/node_modules/@deepseek-ai/dsh-tool-cordis/lib/index.js:9221-9281`；`<PKGS>/dsh-cordis-client-runner/lib/client.js:41-70, 154-181, 204-224, 338` |
| 动态宿主半边挂在 root context | `<CLI>/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/index.js:1594-1599, 2554-2560` |
| `ctx.timeout`/`interval`/`throttle`/`debounce` API | `<PKGS>/dsh-cordis-client-runner/lib/types/client/timer.d.ts` |
| locale 服务的完整契约 | `<PKGS>/dsh-client-locale/lib/types/client/index.d.ts` |
| settingsScope 契约 | `<PKGS>/dsh-client-ui-settings/lib/types/client/settings-scope.d.ts` |
| 输入区一次真实改造的八条原理 | `cordis-plugins/scene-template/UI.md` §4 |
| 全局面板（sidebar.panellist + main）实例 | `bundles/fdep-api-request/lib/client.js:896-925` |
| 常驻 iframe tab 实例 | `cordis-plugins/jeeflow-panel/lib/client.js` |
| 语言包（简→繁自动转换）实例 | `cordis-plugins/zhtw-traditional-chinese/lib/client.js` |

---

## 附录 A：最短上手路径（建议顺序）

1. **跑通一个只读的 tab**：抄 `jeeflow-panel`，把 iframe 换成一个 `div`，改 `id`/`order`/`label`，
   `dsh plugin --profile web add .`，重启 `dsh web`，确认轨迹右边多出一个 tab。
2. **加一行设置**：进 `settings.general.item`，写一个只有标题和一个按钮的行，
   点击时 `console.log`。确认它出现在「设置 → 通用」。
3. **加一整页设置**：进 `settings.section`，做一个只读的令牌展示页 ——
   把 `--dsw-alias-*` 的当前计算值列出来（用 `getComputedStyle(document.body).getPropertyValue(name)`）。
   这一步同时教会你 §7 的全部内容。
4. **改用令牌重写样式**：把你第 1 步里所有硬编码颜色换成 `--dsw-alias-*`，
   然后在设置里切明暗，确认你的面板跟着变。
5. **注册一个主题**：`ctx.theme.register({ id, colorScheme, tokens })`，
   然后再用 `overrideTokens` 做一个"跟随明暗的皮肤"。
6. **加一个全局面板**：抄 `fdep-api-request` 的 `sidebar.panellist` + `main` 两步。
7. **最后才碰输入区**：`conversation.input.dock` 放一个只读面板 → 再读 `cordis-plugins/scene-template/UI.md` §4.1/4.4
   解决等宽与 hero 缺位 → 最后才用 `inputActions.setDraft()` 写草稿。

## 附录 B：一句话记住每个概念

- **Slot** 是"平台给你留的坑"；**SlotMap** 是"坑的地图"；**kind** 决定"一个坑还是很多坑"；**scope** 决定"跟谁同生共死"。
- **register** 是"坐下"；**inject(key, cb)** 是"等坑挖好了再坐下"；**children** 是"我也挖坑给别人坐"。
- **props** 是"座位主人 + 平台 + 你注入"三方合成的结果；**组件必须转发 props**，否则你什么都没拿到。
- **不用 DOM 改数据**，用服务给的**动作**（`inputActions`）和**选择器**（`useInput`）。
- **不用颜色字面量**，用**别名令牌**；**不自己判断明暗**，读 `body[data-ds-dark-theme]` 或干脆什么都不做。
- **不用 `getBoundingClientRect` 对齐**，抄**布局变量公式**；抄公式要连**盒子上下文**一起抄。
- **改 `lib/client.js` 不用重启**；**改 `lib/index.js` 必须重启**。
- **Package 是整版替换**；**动态沙箱毒化 `setTimeout`/`fetch`/`require`**。

## 附录 C：shipped 客户端插件目录 —— "想学哪个座位，就读哪个包"

这些包都在 `<PKGS>` 下。**每个都是可以直接照抄的活教材**（比任何文档都准确）。
表里标出它主要坐哪个座位 / 用哪个服务，方便你按需定向阅读。

### C.1 框架层（先理解这几个，剩下的都是它们的用户）

| 包 | 一句话 | 读它的收获 |
|---|---|---|
| `dsh-client-ui-renderer` | React 座位绑定、`ctx.uiRenderer`、应用根 | `mount()`、座位出口、uSES 适配；**`registry.d.ts` 是座位系统的契约源** |
| `dsh-client-ui-layout` | 三列 AppFrame、`ctx.layout`、主题呈现器 | `root` 座位的唯一合法占用者；`main`/`sidebar`/`rightbar`/`shell.overlay` 的声明；主题如何写进 DOM |
| `dsh-client-ui-sidebar` | 侧栏壳 | `single` 座位如何用 `children` 声明子环；`wide` 折叠态 |
| `dsh-client-ui-conversation` | 会话装配、壳、composer、队列、视图导航 | **最大的一个包**：tabs、composer、docks、hero 判定、输入机（Lexical）全在这 |
| `dsh-client-ui-settings` | 设置域底座（只声明座位 + 传输层，**不渲染**） | `settingsScope` 与全部 `settings.*` 座位类型 |
| `dsh-client-ui-settings-general` | 设置 shell（触发/头部/导航/通用节/引导投影） | 一个"零自有文案"的 shell 长什么样 |
| `dsh-client-ui-theme` | 主题运行时 + `--dsw-*` 样式表 + Appearance 行 | **做主题必读**：`ThemeRuntime`、三张令牌表、presenter 契约 |
| `dsh-client-ui-session` | Session Controller 适配器（React hooks + 作用域座位） | `useSession`/`sessionId`/`useProjection` 从哪来 |
| `dsh-client-ui-slots`（在 shell 里，不单独安装） | 座位纯核 | 座位语义的最终真相；类型经 `SlotMap` 合并（`.d.ts` 不在磁盘，读各包的 `declare module` 块） |
| `dsh-client-ui-primitives` / `-dockkit` | 基线 UI 库 / 停靠套件 | 静态模块表里的共享库，`require` 直接可用 |

### C.2 座位范例（按座位挑）

| 想学 | 读这个包 | 关键点 |
|---|---|---|
| `conversation.view`（tab） | `dsh-client-ui-chat`（order 0）、`-trajectory`（order 10） | `label` 投影成 `ViewTab`；`children` 声明子环 |
| `conversation.composer`（chain） | `-approval`、`-user-questions`、`-subagent` | `select` + `priority` 选举；三档优先级实例 |
| `conversation.input.dock` | `-goal`（GoalBar 停在输入卡上方） | 最简洁的 dock 用法 |
| `conversation.input.plan` / `.model` | `-plan`、`-model-selection` | `single` 座位 + 会话投影 |
| `conversation.input.overlay` | `-input-trigger` | `/` `@` 候选菜单：`list` 座位里的浮层 |
| `conversation.input.attachments` | `-attachment` | 附件轨道 presentation |
| `conversation.chat.node`（keyed） | `-tool`、`-workflow-run`、`-cordis` | keyed 渲染器族 |
| `conversation.chat.turnTail`（chain） | `-deliverables` | `select(owner)` 选举 + `inject` 私有 face |
| `conversation.chat.assistant-actions` | `-message-feedback` | `list` + `{ messageId }` |
| `conversation.session.header.*` | `-jobs`（actions）、`-schedule`（utilities）、`-open-in-app`（actions）、`-sidebar-right`（corner） | header 四个子座位的真实用法 |
| `sidebar.panellist` + `main` | `bundles/fdep-api-request`（你的包）、`-settings-plugins` | 全局面板两步法 |
| `sidebar.brand.*` | `-brand-official` | 品牌座位的官方占用者 |
| `settings.general.item` | `-theme`、`-locale`、`-chat`、`-permission-presets` | 四种"一行偏好"的写法 |
| `settings.section` | `-settings-models`、`-settings-plugins` | 整页设置 |
| `settings.plugins.tab` | `-settings-plugin-inventory` | 插件页里的只读 tab |
| `rightbar` 族 | `-sidebar-right`、`-sidebar-files`、`-sidebar-documentpreview` | tab 类型注册两阶段（type + body） |
| `shell.overlay` | 无 shipped 占用者 | 官方明确说"shipped composition 不注册任何示例面板" |

### C.3 服务层

| 包 | 提供什么服务 | 用途 |
|---|---|---|
| `dsh-client-locale` | `ctx.locale`（`LocaleRuntime`） | 词表注册、语言目录、偏好持久化 |
| `dsh-client-modules` | `ctx.modules`（浏览器）/ `ctx.clientModules`（宿主） | 客户端模块系统本体 |
| `dsh-client-connection` | RPC 传输、generation 生命周期 | `ctx.remote` 的底座 |
| `dsh-client-file-upload` | `ctx.fileUpload` | 浏览器上传、流式接收、回执 |
| `dsh-client-resources` | `ctx.resources` + `useResource` | URL 地址 → 活值的统一资源模型 |
| `dsh-client-hmr` | SSE `/plugins/events` | 开发态热更 |
| `dsh-cordis-client-runner` | 动态客户端沙箱（`styles`/`timer`） | 动态 Package 的浏览器侧执行器 |

### C.4 快速定位一个小座位的用法

```powershell
# 谁注册了某个座位？
$root = "D:\Refine\Books\ntop\AI\dsh\profiles\node_modules\@deepseek-ai"
Get-ChildItem $root -Directory | Where-Object { $_.Name -like 'dsh-client-ui-*' } | ForEach-Object {
  $p = Join-Path $_.FullName 'lib\client.js'
  if (Test-Path $p) { $m = Select-String -Path $p -Pattern 'name: "conversation\.input\.dock"' -AllMatches
    if ($m) { "$($_.Name) : $($m.Count)" } }
}

# 某个座位的契约（kind/scope/owner）在哪？
Get-ChildItem $root -Recurse -File -Filter 'slots.d.ts' | Select-String -Pattern "'conversation\.view'" -List | Select-Object Path

# 一个令牌名到底存不存在？
Get-ChildItem "$root\dsh-client-ui-theme\lib\client.js" | Select-String -Pattern '\-\-dsw-alias-bg-layer-2' -AllMatches
```
