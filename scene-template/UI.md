# UI.md —— DSH Web GUI「场景 / 分支 / 模板」输入区改造说明

> 这份文档解构 `scene-template`（原型期是动态插件 `awui-2/pkg-2…pkg-18`）这次改造所依赖的
> **前端概念、组件结构与底层原理**。每一条原理后面都附了**证据位置**（shipped 代码的文件:行），
> 因为在这个项目里我们发现：**最可靠的"文档"是 shipped 代码本身**（`.d.ts` 契约 + `client.js` 里的
> CSS 与渲染条件），而不是猜测。
>
> 结论沉淀成一句：**当平台提供了座位（Slot）、座位属性（props）和布局变量（CSS var）时，
> 优先用它们；量 DOM、改 DOM、猜 DOM 都要付出代价。**

---

## 1. 全景：这个 UI 是怎么"装"进 DSH Web GUI 的

DSH 的 Web GUI 本体就是一个**跑在浏览器里的 Cordis 应用**：页面把 shell 渲染出来，
再按 composition 把一批"客户端插件"挂进一个个 **Slot（座位）**。我们的输入区并没有 fork 任何 DSH 包，
只是**在两个座位上各挂了一个组件**。

### 三种交付形态（同一份代码的三种活法）

| 形态 | 怎么产生 | 生效范围 | 适用 |
|---|---|---|---|
| **动态 Client 插件** | Agent 调用 `cordis_define` + `cordis_run` | 当前页面 + 当前会话，**进程/页面一刷新就没** | 快速迭代、原型 |
| **静态 client bundle** | npm 包：`dsh.bundle.patch` + `dsh.client.platform: "web"` + `lib/client.js` | 安装到 profile，重启后**常驻** | 定型交付 |
| **宿主行（host row）** | `cordis.patch.yml` 里 `insert:` 一行 host 插件 | Node 端进程 | 数据/API/工具 |

这次改造走的路径是：**先用动态插件把交互打磨到位（23 个 Package 的逐步迭代），再固化成静态 bundle**
（`cordis-plugins/scene-template/`）。两者**代码几乎一样**，差异见 §6。

### 为什么需要"宿主行"才能有客户端 UI

`@deepseek-ai/dsh-client-modules` 通过**扫描 host composition 里的行**来决定给浏览器注入哪些
客户端模块。所以即使插件逻辑全在浏览器端，也必须：

1. `cordis.patch.yml` 里 `insert:` 一行（`name` = 包名）；
2. `package.json` 里声明 `dsh.client.platform: "web"`；
3. `lib/index.js` 提供一个**能加载的**宿主入口（哪怕 `apply(){}` 空实现 —— 行加载失败会让整个 boot 中止）；
4. `lib/client.js` 用 `window.__ModuleLoader__.load({ id, factory })` 注册，factory 返回插件对象。

静态客户端插件的标准形态（照抄 shipped 插件即可）：

```js
// 形态参考：@deepseek-ai/dsh-client-ui-jobs/lib/client.js:252-276
const inject = ["sessions", "slots", "locale"];
function apply(ctx) {
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({...}, Comp));
}
exports.apply = apply;
exports.inject = inject;
return module.exports;      // factory 的返回值就是插件
// React 通过 require("react") 拿（工厂里 require 可用）
```

---

## 2. 概念速查表

| 概念 | 一句话解释 | 关键点 / 证据 |
|---|---|---|
| **Cordis** | DSH 的插件运行时：一切能力都是"插件行"，由 Context 组装 | 生命周期由 **Fiber** 管理，`ctx.effect()` 注册的副作用随插件卸载自动回收 |
| **宿主半边 / 客户端半边** | 一个插件可以同时有 Node 端和浏览器端代码 | 动态形态下两端是 `code.host` / `code.client`；静态形态下是 `lib/index.js` / `lib/client.js` |
| **Slot（座位）** | UI 上被"预留"的可插拔位置 | 有 `kind`（single/list/keyed/chain）与 `scope`（root/session/session-maybe） |
| **occupant / cell id** | 往座位上放的东西；`id` 是自己这格的键 | 复用别人的 id 会**替换**那一格；新 id 是"并排新增" |
| **order** | 同一座位内的排序（升序） | slot 层会按 `order` 排序（`dsh-client-ui-renderer/lib/client.js:866`） |
| **ownerProps / standardProps** | 座位**主人**给的专属数据 / 平台给的标准 hook 与动作 | 我们用的是 `inputActions`、`useInput`、`sessionId`（`contract/slots.d.ts:241-256`） |
| **SlotOutlet 锚点** | 每个座位外层包一个 `display: contents` 的 div | **座位内容在布局上"穿透"到父容器**，父容器（flex/grid）直接看到座位里的元素 —— 这是 §4.4 的基础（`dsh-client-ui-renderer/lib/client.js:762-776`） |
| **list 座位渲染** | 多个 occupant 用 `Fragment` 平铺，不额外包一层 | `…/client.js:869` |
| **Hero 变体 / Composer 变体** | 新建空会话 vs 有内容的会话，输入区长得不一样 | `hero = sessionId === undefined \|\| (shellPhase === "blank" && (openState === "open" \|\| summaryBlank === true))`（`dsh-client-ui-conversation/lib/client.js:14868`） |
| **composerStack** | 输入区所在的 flex column 容器 | `.wSkVaW_composerStack{--dsh-composer-stack-gap:6px;gap:…;flex-direction:column;display:flex}`（同文件 CSS 段） |
| **两个 dock** | `conversation.input.dock` = 输入卡片**上方**；`conversation.composer.dock` = 卡片**下方** | 后者只在 `variant === "composer"` 时渲染（`…/client.js:16259`） |
| **dock 几何变量** | `--dsh-composer-card-max-width` / `--dsh-composer-side-clearance` / `--dsh-composer-dock-inset` | 定义在会话根 `.wSkVaW_root` 上，向下继承 |
| **Lexical editor** | 输入框是 **contenteditable + Lexical** 驱动，不是 `<textarea>` | "draft text … live in the shell's Lexical editor"（`contract/input.d.ts:1-7`）；`ComposerKeyboard.editor: LexicalEditor`（同文件:241） |
| **inputActions** | 座位给组件的**官方输入动作**：`setDraft/addAttachments/removeAttachment/pruneAttachments/submit` | `contract/input.d.ts:210-221`；文档措辞 "Replace the whole draft" |
| **InputState.draft** | 官方"当前草稿"（编辑器文档的 clipboard-text 投影） | `contract/input.d.ts:303-305`，通过 `useInput(s => s.draft)` 读 |
| **动态沙箱遮蔽符号** | 动态客户端半边里 `setTimeout/setInterval/clearTimeout/clearInterval/fetch/require/harness` 是**会抛错的参数陷阱** | `dsh-cordis-client-runner/lib/client.js:41-64` |
| **styles.insert** | 动态客户端插件注入 CSS 的官方口子（随包卸载清理） | 同上:157、`DynamicCordisStyles`:72-105 |
| **timer 服务** | 动态插件计时只能走 `inject: ['timer']` + `ctx.timeout()` | 客户端组合里装了浏览器版 `ClientTimerService`（`lib/types/client/timer.d.ts`） |

---

## 3. 组件结构

### 3.1 注册关系（三个 entry，两个座位）

| entry id | 座位 | 组件 | 职责 |
|---|---|---|---|
| `awui-top` (order 1) | `conversation.input.dock` | `TopScenarioPanel` | 场景 chips（未选时）/ 选中后的标题栏 + 分支 chips；**无任何静态标签** |
| `awui-top-templates` (order 2) | `conversation.input.dock` | `HeroTemplateEntry` | **hero 会话**下的模板墙（渲染时带 `order: 2`，视觉落到输入卡片下方）；普通会话返回 `null` |
| `awui-bottom` (order 100) | `conversation.composer.dock` | `BottomTemplatePanel` | **普通会话**下的模板墙（座位本身就在卡片下方） |

> 静态 bundle 里这三个 id 改为 `st-top` / `st-top-templates` / `st-bottom`，避免和动态原型并存时互相顶掉。

### 3.2 组件职责与状态

| 组件 | 本地状态 | 说明 |
|---|---|---|
| `TopScenarioPanel` | `scenarios` / `active` | 场景目录 + 选中场景的详情（branches）；分支选中后调 `inputActions.setDraft(branch.preset)`；左上角挂 `ExpertPet` |
| `ExpertPet` | `state` 由选择派生（`idle` / `scenario` / `branch`） | 专家宠物：**内联 SVG**（零外部资源）小机器人，透明正方形 44×44，绝对定位在面板**右上角**外挂；浮动 + 眨眼用注入的 CSS keyframes，状态一变就换 `key` 重挂载 → hop 动画重放；表情气泡 💭 → 💡 → ✨；可点击（`cursor: pointer` + tooltip），点一下在模块总线上发 `{type:'refresh'}` → 两个面板各自重拉清单与详情 |
| `TemplatePanel` | `active` / `dynTemplates` / `batch` / `batchInfo` / `batchLoading` / `preview` | 模板墙本体：静态模板、动态模板、推荐批次、预览弹窗 |
| `HeroTemplateEntry` | — | 判据：`heroLayout || !bottomMounted` → 渲染 `TemplatePanel`（`order: 2`），否则 `null` |
| `BottomTemplatePanel` | — | 包装：挂载时置位 `dockState.bottomMounted` 并广播，卸载时复位 |
| `useDragPan` | `drag` ref | 按住内容平移（阈值 4px → 捕获指针 → 抑制尾随 click） |
| `useSharedSelection` | — | 订阅模块内事件总线，拿"当前选择" |
| `useBottomDockFlag` | — | 订阅总线上的 dock 挂载状态（判断"卡片下方是否已有模板墙"） |

### 3.3 数据流

```
   ┌──────────── 模块内事件总线 (Set<listener>, emit/subscribe) ─────────────┐
   │  'set' / 'clear'  选中状态        'bottom-dock'  底部 dock 挂载标志      │
   └───────▲──────────────────────▲──────────────────────▲──────────────────┘
           │                      │                      │
   TopScenarioPanel        TemplatePanel          BottomTemplatePanel
     │      │                    │
     │      └─ api.getScenario ───┴─ api.getScenario / api.getDynamicTemplates
     │                              api.recommend / api.getPreview
     └─ props.inputActions.setDraft(preset)  ──►  写入 Lexical 草稿
        props.useInput(s => s.draft)         ◄──  读草稿（触发动态模板）
```

**为什么用模块内事件总线而不是 React Context**：两个面板分别注册在**不同的座位**里，
组件树的共同祖先在 shipped 代码里，我们插不进去；而同一个 `lib/client.js` 的模块作用域是天然共享的。

---

## 4. 八条踩出来的原理（现象 → 根因 → 正确做法）

### 4.1 等宽 + 居中：**先确认"我和谁平级"，再抄 CSS 变量公式**

- **现象（两轮）**：面板比输入框窄（早期写死 `maxWidth: 768`）→ 改成"满宽"后又比输入框宽 →
  改成运行时 `getBoundingClientRect()` 量宽补偿，**数据一多就飘** → 换成"照抄 shipped dock 公式"
  后**还是每侧窄 16px**（chips 比输入文字多缩进一截，看起来"容器宽度对不上"）。
- **根因**：
  1. 输入卡片的宽度不是常量，由 CSS 变量算出；
  2. **抄公式必须连同它的盒子上下文一起抄**：TodoPanel 的 `.lXshSW_root` 写的是
     `calc(100% - 2*clearance - 4*inset)` —— 多减的那 4 个 `dock-inset` 是**它自己那层"浮起提示卡"**
     的几何，照抄到平级的面板上就正好每侧窄 16px；
  3. 用"父容器 content-box 左边"当基准不可靠 —— 父容器可能被 flex 居中/紧贴内容收缩，
     基准会随面板自己移动，偏移量成了**自我依赖**的量。
- **正确做法**：抄**输入卡片本身**的盒子（本 entry 与 `inputBar` 是同一个 `composerStack` 里的兄弟，
  经 SlotOutlet 的 `display: contents` 直接平铺）：

  ```js
  width:      calc(100% - 2*var(--dsh-composer-side-clearance))  /* 100% = composerStack 宽度 */
  max-width:  var(--dsh-composer-card-max-width)
  margin:     0 auto          /* 居中由 auto margin 保证，不需要算 */
  padding:    0 14px          /* 内文左边界对齐输入文字（.uV2eYG_input padding-left: 14px） */
  ```

- **证据**（`dsh-client-ui-conversation/lib/client.js`）：
  - 卡片 = `.uV2eYG_root{padding:0 var(--dsh-composer-side-clearance) 8px;align-items:center}` 里的
    `.uV2eYG_card{width:100%;max-width:var(--dsh-composer-card-max-width)}`
    → 卡片盒宽 = `min(stack宽 − 2×clearance, card-max-width)`；
  - 平级关系来自 composer 的 JSX：`composerBar = div.composerStack[.composerHero]` 的 children 是
    `[HeroShell, heroWorkspaceRow, renderSlot("conversation.input.dock"), inputBar]`（同文件 ~555912）
    → **场景面板与 inputBar 是兄弟**，所以 `100%` 就是 stack 宽度；
  - hero 布局也成立：`.wSkVaW_composerHero{width:min(calc(card-max + 2*clearance),100%);align-self:center}`
    —— 两种布局下"减 2×clearance + `margin:auto`"都与卡片重合；
  - 变量定义在 `.wSkVaW_root`：`--dsh-composer-card-max-width: calc(--dsh-chat-content-width + 32px)`、
    `--dsh-composer-side-clearance: 16px`、`--dsh-composer-dock-inset: 8px`（**最后一个本面板用不到**）。
- **顺手记下的边界**：`conversation.composer.dock`（卡片下方那个座位）里的 shipped 组件用的是
  `._7yHdaG_dock`（`padding: 0 8px`，多减 2 个 inset）—— 同一个"上/下"两个 dock，基准公式并不一样，
  因为它们的嵌套层数不同。**先看 DOM 层级，再决定抄哪一行。**

### 4.2 写输入框：**composer 是 Lexical，不能改 DOM**

- **现象**：点分支后输入框内容不变。
- **根因**（两层）：
  1. 组件注册时写成 `() => React.createElement(Comp)`，**slot props 根本没传进去**，`inputActions` 不存在；
  2. 就算拿到 DOM 也没用：输入框是 **Lexical 驱动的 contenteditable**，
     `el.textContent = text` + 手派 `input` 事件会被编辑器用自身模型重渲染时冲掉。
- **正确做法**：
  ```js
  // 注册时必须转发 props
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register({ name: 'conversation.input.dock', id: 'awui-top', order: 1 },
      (props) => React.createElement(TopScenarioPanel, props)));
  // 组件里用官方动作（"Replace the whole draft"）
  props.inputActions.setDraft(branch.preset);
  ```
- **证据**：`contract/input.d.ts:210-221`（InputActions）、`:1-7` 与 `:237-241`（Lexical）、
  `contract/slots.d.ts:241-248`（session 标准 props 含 `inputActions`）。

### 4.3 读输入框：**`useInput(s => s.draft)`**

- 动态模板要在"用户输入 ≥20 字"时触发。读草稿不需要 MutationObserver 猜 DOM：
  `InputState.draft` 就是编辑器文档的 clipboard-text 投影（`contract/input.d.ts:303-305`）。
- 动态插件里配合 `inject: ['timer']` + `ctx.timeout()` 做 600ms 防抖（见 4.6）。

### 4.4 新建会话第三部分缺位：**座位不存在时，用"第二个 entry + flex order"**

- **现象**：新建会话（hero）里场景/分支有、模板墙没有。
- **根因**：`conversation.composer.dock` 只在 `variant === "composer"` 时渲染
  （`dsh-client-ui-conversation/lib/client.js:16259`），而新建空会话 `hero === true`（同文件:14868）→
  **卡片下方根本没有座位**。此时唯一存在的相关座位是卡片上方的 `conversation.input.dock`。
- **正确做法**（不需要浮层、不需要测量）：
  1. 把模板墙做成**独立的第二个 entry** 注册进 `conversation.input.dock`；
  2. 因为 SlotOutlet 锚点是 `display: contents`（`dsh-client-ui-renderer/lib/client.js:762-776`），
     这个 entry 的根元素**直接就是 `composerStack`（flex column）的子项**；
  3. 给它 `order: 2`（场景面板与输入卡片都是 `order: 0`）→ 在 flex 排序里落到**输入卡片之后**；
  4. 普通会话里这个 entry 返回 `null`（不产生元素，也就没有 flex item），
     仍由 `conversation.composer.dock` 那份挂在卡片下方 —— 两边不重复。
  5. 未选场景时 `TemplatePanel` 自身也 `return null`，所以两份 entry 都不产生元素，
     第三部分在两种布局里都是"干净地不存在"。

  ```
  普通会话 (variant='composer')                新建空会话 (hero)
  ┌ composerStack (flex column) ┐              ┌ composerStack (flex column) ┐
  │ 对话内容 …                   │              │ HeroShell / 工作区选择        │
  │ [data-slot=input.dock] ←display:contents   │ [data-slot=input.dock]       │
  │   ├ 场景/分支面板  order 0    │              │   ├ 场景/分支面板  order 0    │
  │   └ (shipped todo/goal/queue)│              │   └ 模板墙        order 2 ───┼─┐
  │ [输入卡片]        order 0     │              │ [输入卡片]         order 0    │ │
  │ [composer.dock]              │              └──────────────────────────────┘ │
  │   └ 模板墙        order 100  │ ◄──────────── 模板墙在 flex 排序里落到卡片之后 ◄─┘
  └──────────────────────────────┘
  ```

### 4.5 能拖不能点：**`setPointerCapture` 会重定向 click**

- **现象**：加了"按住拖动平移"后，chip 点不中了（能拖，选不中）。
- **根因**：在 `pointerdown` 就 `setPointerCapture`，浏览器会把随后的兼容鼠标事件
  （`mouseup` / `click`）一起重定向到捕获元素（滚动容器），chip 收不到 `click`。
- **正确做法**：
  - `pointerdown` **只记起点，不捕获**；
  - `pointermove` 越过 **4px 阈值**、确认进入拖动后才 `setPointerCapture`；
  - 拖动结束后紧随的那个 `click` 用 `onClickCapture` 里 `stopPropagation + preventDefault` 吞掉；
  - 触屏（`pointerType === 'touch'`）直接让位给原生滑动。

### 4.6 动态插件专属：**计时器 / CSS 注入都有专门口子**

| 需求 | 动态 Package | 静态 bundle |
|---|---|---|
| 计时 | `inject: ['timer']` + `ctx.timeout(cb, ms)`（返回 disposer） | 普通 `setTimeout` / `clearTimeout` |
| 注入 CSS | `styles.insert(css)`（随包卸载清理） | 自己造 `<style>` 标签，用 `ctx.effect` 管清理 |
| 读写输入 | 同上（`inputActions` / `useInput` 与形态无关） | 同左 |

- 动态沙箱的遮蔽名单与教学错误：`dsh-cordis-client-runner/lib/client.js:41-64`；
  `styles` 是闭包符号：同文件 `:157`、`DynamicCordisStyles` `:72-105`；计时服务：`lib/types/client/timer.d.ts`。
- 另一条工程规则：动态 Package **是整版代码而不是增量**，每次 `cordis_define` 都要带上两半 ——
  只发 `code.client` 会把 host 半边（mock RPC）丢掉（我们踩过，表现为界面上场景栏一直"加载中…"）。

### 4.7 隐藏滚动条：**`::-webkit-scrollbar` 只能靠 CSS**

内联 `style` 无法选中 `::-webkit-scrollbar` 伪元素，所以必须注入样式表：

```css
[data-awui-scroll]::-webkit-scrollbar{display:none}
[data-awui-scroll]{scrollbar-width:none;-ms-overflow-style:none}
```

（滚动容器属性保留 `overflow-x: auto`，因此滚轮/触控板仍然可用，只是看不见滚动条。）

### 4.8 简体 → 繁体：**"拼 URL 之前"转，且没有一张表是够用的**

- **现象**：要求"界面上所有中文改成繁体"。看着只是替换字符，实际有三个坑。
- **坑 1 · 时机**：模板的封面是 `data:image/svg+xml`、mock 兜底的预览页是 `data:text/html`（真接口的
  `previewUrl` 是普通 URL，不走这条），两者都在
  host 半边用 `encodeURIComponent` 编码后塞进 URL —— **编码之后中文只剩 `%E4%BC%9A` 这种字节**，
  再想"把 URL 字符串转繁体"什么也转不到。所以转换必须发生在 `tpl(title, subtitle, sections)` 的入口，
  即"拼 URL 之前"。（推论：不要把 `s2t()` 写成对响应体的统一后处理。）
- **坑 2 · 没有一张完整的字表**：DSH 只随包发行 `zh` / `en`，简繁对照只能自己找。
  两条路都不完整：`zhtw-traditional-chinese` bundle 里的词表懂台湾惯用词和歧义字
  （`设置→設定`、`拖动→拖曳`、`界面→介面`、`刷新→重新整理`），但**字不全**（缺 `数/触/达/点/题/线/评/价`…）；
  Windows 的 `LCMapString(LCMAP_TRADITIONAL_CHINESE)` 字级全量，但**只按字、不看词**，
  而且会保守地保留"在繁体里也合法"的字（`后/里/台/于/么/周/采/舍/范`）。
  可行组合 = **词表优先 → 字表兜底 → 手工 POLISH 表收尾**（`怎么→怎麼`、`在于→在於`、`本周→本週`、
  `复数→複數`…），三张表叠起来才能做到"扫一遍没有残留"。
- **坑 3 · 过度转换**：字表把 `里→裡`，于是 `里程碑` 变成 `裡程碑`。这类必须靠"整词保护/回改"
  （工具里的 `S2T_GUARD` 与 POLISH 的 `裡程碑→里程碑`）。
- **落地方式**：交付物（bundle）里放**真·繁体字面量**（源码即真相，不带运行时代价）；
  动态原型里为了少改一遍 3000 字的数据，只在 host 半边挂一张最小 `s2t()` 词表。
  两者输出**必须一致** —— 所以词表和 POLISH 表是同一份（`tools/s2t/`）。
- **自查手段**：`node tools/s2t/convert.js --report <file>` —— 它的判据不是"看起来像不像繁体"，
  而是"**转换后还有没有字能被任何一张表改写**"，输出必须是 0（`里程碑` 这类整词由 `GUARD` 保护，
  所以不算残留）。附带一个免费的性质：**转换是幂等的** —— 对已转好的文件再跑 `--write` 是 no change，
  这正是上面三张表没有互相打架的证据。

---

## 5. 交互细节一览

| 交互 | 实现要点 |
|---|---|
| 场景 chips / 分支 chips | 单行不换行（`flex-wrap: nowrap` + `overflow-x: auto` + `flex: 1 1 auto; min-width: 0`）；**标签已删除**，所以整行就是 chips 本身，靠"选中色"区分层级（场景 = 蓝 `#2563eb`，分支 = 紫 `#7c3aed`）；**字号分两档**：场景清单是主选择（`big=true`：14px / `7px 15px` / `font-weight: 500`），分支比它小一档（13px / `4px 11px` / 400）——同一个 `S.chip(selected, color, big)`；**分支 chip 的文案是 `名称 + " ↘"`**（后置箭头，让它读起来像挂在已选场景下的子项） |
| 文案语言 | 界面上所有中文（chips、提示、按钮、海报标题/副标题、预览页 HTML）都是**繁体（zh-TW 惯用）**。bundle 里是**真·繁体字面量**（源码即真相，不额外带转换表）；动态原型里 mock 数据在 host 半边用 `s2t()` 词表转换、客户端标签直接写成繁体 —— 见 §6 |
| 加载过渡 | 五处加载各自有反馈，且**延迟刻意错开**（列表 520 / 详情 420 / 动态模板 760 / 推荐 640 / 预览 300ms，仅回退 mock 路径用）：场景栏 → 骨架 chip ×4；选定场景后 → 分支骨架 ×3；模板墙 → 骨架海报 ×3（复用海报卡尺寸，只是灰块）；「✨ 推薦」→ 按钮变「重新整理中…」+ 墙切骨架；双击海报 → **直接用模板对象里 API 返回的 `previewUrl`** 开弹窗（不再走 mock 的 data URL），iframe `load` 前盖一层骨架 + 「預覽載入中…」，2.5s 还没 load 就补一句提示（该提示只作通用诊断用：2026-09-24 实测这个 URL **已无 `X-Frame-Options`、也无 CSP**，嵌入不再被拒）。骨架 = 与真实元素同尺寸同圆角的灰块 + 注入的 `.st-skel` 呼吸动画；数据到位时容器换 `key` 并带 `.st-in` 淡入。**重取时机**：清单按 slot 的 `sessionId + tick`、详情按 `scenarioId + sessionId + tick` —— 所以新开会话/切会话/**点宠物**都会重拉（切会话不是刷新页面，面板实例是同一个，只换 `sessionId`）；已有数据时保持旧列表静默替换，只有首次加载才闪骨架。延迟由 mock 侧 `LATENCY` 提供（host 半边用 `ctx.timeout`，静态 bundle 用本地 `setTimeout`） |
| 专家宠物 | 面板**右上角**一个**透明正方形**（44×44，无背景/无边框），**扶正挂在角外**（不斜）：中心落在面板右上角点附近（`right/top = PET_HANG - PET/2`，`PET_HANG = 6` —— 正好骑在角上会被列右边界裁，偏进来 6px 既不裁也不压内容）。面板用 `S.panelPet`（`position: relative` + `marginTop: PET_AIR = 44`）为它留出**面板上方**的空气（输入框不动，也不会压到 hero 那行工作区 chip），左右都**不占槽位**，chips 与输入文字同列。动效四条 CSS 动画分工：`.st-pet-sway`（左右轻摆 ±3°）、`.st-pet-hop`（状态变化重放一次）、`.st-pet-float`（轻浮动）、`<g>.st-pet-eyes`（`transform-box: fill-box` 眨眼）；旋转只作用在本体上（`S.petRotate`），表情气泡放在宠物左侧（`right: PET-4`，面板内那一侧，探出去不会被列边界裁）。想换成 emoji 或自带 PNG，只改 `ExpertPet` 一个组件。**它也是唯一的手动刷新入口**：点一下 → 总线发 `{type:'refresh'}` → 两个面板的 `useRefreshTick()` 让依赖 `tick` 的 effect 重跑（拉清单 + 拉当前场景详情），命中区就是那个 44×44 透明方块，不会挡住下面的 chip |
| 拖动平移 | 见 4.5；光标 `grab`、`user-select: none`、`touch-action: pan-x` |
| 选分支 → 写草稿 | `inputActions.setDraft(preset)`（**整体替换**，符合 spec §4.3"换分支 = 清空 + 填 preset"） |
| 选中场景 → 收起列表 | 场景整行用 `scenarioChosen` 门控（选完就收，长名字列表不常驻）；顶部换成标题栏，里面就是那一个**场景徽章**，点徽章右侧的 `✕` = `clearSelection()`，回到场景列表 |
| 标题栏即"当前场景" | 静态标题（`✨ AI 工作流 · 场景`）删除，**未选场景时标题栏整行不存在**（不占位、不显示提示语）：只剩**场景胶囊**（图标 + 名称 + 右侧 `✕` 关闭按钮、`var(--dsw-alias-brand-primary)` 底色 + 投影、`max-width: 62%` 省略号）。原先右侧的 `→ 分支名` 次级标签与 `换场景` 按钮都已去掉 —— 分支选中状态由分支 chips 自身的高亮表达，关闭动作收进徽章的 ✕ |
| 模板墙 | 200×~250 海报卡（SVG 封面 + 标题 + 副标题），横向拖动；单击选中、双击预览 |
| 预览弹窗 | `iframe` + **模板对象里 API 返回的 `previewUrl`**（相对路径补 `https://abc.feg.com.tw`，2026-09-24 实测 `200 text/html`、无 `X-Frame-Options`/CSP → 能嵌）+ `sandbox=""`（预览页是纯 HTML/CSS，不需要脚本与外网）；缺口是**所有模板共用同一个预览页**，`?id=`/`?template_id=` 都被忽略，等后端按模板 id 参数化 |
| 推荐翻批 | 客户端持游标 → `api.recommend(cursor)` 取下一批 4 张；host 侧**无状态切片**（将来换真 API 就是普通分页） |
| 动态模板 | 草稿 ≥20 字 → 600ms 防抖 → `api.getDynamicTemplates(scenarioId, draft, branchId)` |
| 未选场景 | **第三部分整块 `return null`**（推荐按场景给，没有场景就没有可展示的内容）：不渲染标题、不渲染提示语、不渲染 `✨ 推荐`；取消选中会清掉已取回的推荐批次 |

---

## 6. 原型（动态 Package）→ 可安装 bundle 的差异清单

| 维度 | 动态 Package | 静态 bundle |
|---|---|---|
| 入口 | `cordis_define({ code: { host, client } })`，函数体 | `lib/index.js`（宿主）+ `lib/client.js`（`window.__ModuleLoader__.load`） |
| React | 沙箱注入的 `React` 闭包符号 | `require("react")` |
| 插座访问 | `ctx.get('slots')` | `inject: ['slots']` + `ctx.slots` |
| 计时 | `inject: ['timer']` + `ctx.timeout` | `setTimeout` / `clearTimeout` |
| CSS | `styles.insert(css)` | 自建 `<style>` + `ctx.effect` 清理 |
| 包内 RPC | `harness.handle`（host）↔ `host.call`（client） | 没有包内 RPC：客户端直接 `fetch()` 真接口；需要通知宿主时走一条同源路由（host `webServer.register` + client `fetch('/plugins/scene-template/selection')`） |
| **真接口（清单/详情/推荐）** | 清单：host 半边 `ctx.get('web').fetch({ url })`（GET）。详情与推荐都是 **POST**，而客户端沙箱只有 `ctx/React/host/styles/console`、host builtins 也没有 `fetch`、`web.fetch` 又只收 `{url}`（GET only）→ host 用 `ctx.get('subprocess').spawn({ argv:['curl', …] })` 桥一发，stdout 走 collect reader 读 | 浏览器里直接 `fetch()`（列表 GET、详情/推荐 POST）；三个接口都是 `access-control-allow-origin: *`（POST 预检 204、allow-methods 含 POST），不需要代理。超时/非 2xx/形状不对 → 回退内联 mock，来源只放在 hover 提示里（场景列 / 分支行 / 模板墙 / 推荐按钮各一处）。推荐接口返回**裸数组 3 条**且每次顺序不同 → "换一批"=再调一次，无 cursor；其 `previewUrl` 是相对路径，前端补 API 域名 |
| **选中 → 上下文注入** | 客户端 `host.call('selection.sync', …)` 把选中按 `sessionId` 交给宿主；宿主注册 `systemPrompt.context({name:'scene-template/selection', order:130, text})`，`text(context)` 里直接用 `context.agent.id` 定位会话（退路才是 `agents.currentInitiator()`） | 同一条链路，只换通道：同源 POST `/plugins/scene-template/selection`（`lib/index.js` 的 exact 路由，带 256KB 上限）。渲染文本、`{{` 消毒、模板内容缓存两边逐行一致 |
| 生效 | 内存，刷新/重启即失 | 写进 profile，重启常驻 |
| slot id | `awui-*` | `st-*` |
| 中文（简→繁） | 运行时转换：host 半边一张 `s2t()` 词表负责数据与预览页 HTML（`data:` URL 里中文已被 percent-encode，**必须在拼 URL 之前转**），客户端标签直接写成繁体 | 源码里就是繁体字面量：`tools/s2t/`（zhtw 词表 + Windows `LCMapString` 字表 + POLISH 手工表）一次性转换，交付物不带转换表 |
| 交付 | 会话内的 Run 卡片 + 审批 | `dsh plugin --profile web add ./scene-template` |

> **接真后端的唯一改动点**：`lib/client.js` 里的 `api` 对象（五个方法签名与
> 《AI 工作流输入区 UI 规范 v0.1》§3 的接口一一对应），组件一行都不用动。

---

## 7. 这次真正用到的调试手法（可复用）

1. **Client Inspect 看座位占用**：`Slots.listSubTree`（不带 `root` 看拓扑，带 `root` 看 occupant 与
   `ownerProps` / `standardProps`）。判断"注册上了没有"。
2. **`cordis_inspect_self`**：看 `runtime.host.status` / `runtime.client.status` / diagnostics。
   我们靠它发现"只发了 client 半边导致 host 缺失"。
3. **面板内临时读数**（本轮最有效的一招）：在**用户看得见的面板**里渲染一行
   `hero=… bottom=… inline=… wall=…`。它一次区分了三种完全不同的故障：
   **没渲染** / **渲染了没数据** / **渲染了但看不见**。
4. **读 shipped 源码当文档**：`.d.ts` 给契约，`client.js` 给渲染条件与 CSS 真实值
   （本次的关键结论 —— `display: contents` 锚点、`variant === "composer"` 门控、
   `hero` 的判定式、dock 宽度公式 —— 全部来自这里）。
5. **离线合成验证 patch**：用 `loadProfile()` + `composeEntries()`（`@deepseek-ai/dsh-app-boot`）
   在进程内把真实 profile 各层 + 新 bundle 的 patch 合成，确认行落点与 id 不冲突，
   不必启动服务、也不必改 profile。

---

## 8. 证据索引（文件 : 行）

| 结论 | 位置 |
|---|---|
| 座位锚点是 `display: contents`（布局穿透） | `@deepseek-ai/dsh-client-ui-renderer/lib/client.js:762-776` |
| list 座位用 Fragment 平铺 occupant | 同上 `:869` |
| `hero` 判定式 | `@deepseek-ai/dsh-client-ui-conversation/lib/client.js:14868` |
| composerStack 子项顺序（Hero → 工作区 → input.dock → 输入条） | 同上 `:14919-14930` |
| `conversation.composer.dock` 只在 `variant === "composer"` 渲染 | 同上 `:16259` |
| `composerStack` 是 flex column；`composerHero` 宽度公式 | 同上 CSS 段（`.wSkVaW_composerStack` / `.wSkVaW_composerHero`） |
| dock 宽度三件套变量 | 同上（`.wSkVaW_root`：`--dsh-composer-card-max-width` / `--dsh-composer-side-clearance` / `--dsh-composer-dock-inset`） |
| dock 公式用法（Todo / Goal / Queue） | `.lXshSW_root`（同文件 CSS）、`@deepseek-ai/dsh-client-ui-goal/lib/client.js:127`、`._7yHdaG_dock`（conversation CSS 段） |
| 输入卡片标记 `data-composer-card` | `dsh-client-ui-conversation/lib/client.js:16068` |
| `InputActions.setDraft` 契约 | `…/lib/types/client/contract/input.d.ts:210-221` |
| `InputState.draft` 契约 | 同上 `:303-305` |
| 输入框是 Lexical contenteditable | 同上 `:1-7`、`:237-241` |
| session 标准 props（`inputActions` / `useInput` / `sessionId`） | `…/contract/slots.d.ts:241-256` |
| 动态客户端沙箱遮蔽名单（计时器/fetch/require/harness） | `@deepseek-ai/dsh-cordis-client-runner/lib/client.js:41-64` |
| `styles.insert` / `DynamicCordisStyles` | 同上 `:157`、`:72-105` |
| 静态客户端插件标准形态 | `@deepseek-ai/dsh-client-ui-jobs/lib/client.js:250-278` |
| `systemPrompt.context` 契约（`name` / `order` / `text`，**空文本会被丢弃**） | host Service `systemPrompt`；`@deepseek-ai/dsh-system-prompt/lib/index.js:144-148`（`renderContextSections` 过滤 `text.length > 0`） |
| **provider 拿到的 `context` 里就有 `agent`** —— `{ agent, scope: agent, signal? }` | `@deepseek-ai/dsh-agent/lib/index.js` 的 `assembleContextFor(agent, signal)`；`dsh-system-prompt` 里 `entry.text(context)` 原样传入 |
| 注入的 runtime context **会变成一条 plugin 来源的 user 消息**（对话里可见） | `@deepseek-ai/dsh-agent-loop/lib/index.js` 的 `preStep`（`:888-895`：`project(...)` → `[...claimed, context]`）与 `RuntimeContextProjection.project`（`:336-355`：`source:{kind:'plugin', form:'snapshot', sections}`，**值没变就不重复注入**） |
| `agents.currentInitiator()` 是 AsyncLocalStorage、驱动链内可读 | `@deepseek-ai/dsh-agent/lib/index.js`（`currentInitiator()` / `withInitiator()`）—— 现在只作会话定位的**退路** |
| runtime context 的内置顺序表（110 / 115 / 120） | `dsh-system-prompt/lib/index.js` 的 `CONTEXT_ORDERS`（`SANDBOX_POLICY` / `APPROVAL_POLICY` / `SUBAGENT_DELEGATION`） |
| `{{name}}` 会被当提示词变量解析，**未知变量直接抛错** | 同上 `interpolate()`（`:150-175`）—— 所以注入正文必须消毒 |
| 动态宿主半边挂在 **rootCtx** 上（`requireGroup()` → `rootCtx.plugin`），所以它的注册默认是全局的 | `@deepseek-ai/dsh-cordis-host-runner/lib/index.js:2554-2560` |
| 沙箱 ctx 允许的动作（`effect` / `on` / `provide` / timer 系列） | 同上 `CTX_VERBS`（`:629-660`） |
| 宿主 runner 自己怎么"给会话喂上下文" | 同上 `injectUserContext()`（`:2469-2481`）—— `agent.inject(createUserMessage({source:{kind:'plugin'}}))`，即 `agent/pre-step` 那条退路的形状 |

---

## 9. 已知取舍与后续

| 项 | 现状 | 后续可选 |
|---|---|---|
| 数据 | 场景清单 + 详情 + **推荐** 已接真接口（`/scene/list` GET、`/scene/detail` POST `{"id":…}`、`/scene/suggestion_template` POST `{scene_id, content}`，均带回退）；动态模板仍是 mock；预览已走 API 的 `previewUrl`（实测可 iframe，缺口是所有模板指向同一张页面，等后端按 id 参数化）；已按规范 §3 逐个接口导出到 `cordis-plugins/scene-template/mock/`（5 个文件）+ 对齐说明 | 换成真接口：只改 `api`（以及接一个网络口子）；待对齐点见 `mock/README.md`（`hasDynamicTemplates` 后端已补上 ✓；推荐接口已独立并上线 ✓） |
| 选中数据的注入 | 场景（名称 + 说明）、分支（名称，preset 已在输入框）、模板（标题 + **案例内容**，上限 4000 字 + **预览地址**）按 session 注入每次模型步的 runtime context；宠物 hover 上有一行「會注入模型上下文：…／上次組裝：已注入 N 字」可自查。**预览地址是必给的兜底**：抽不到内容时注入里仍带 `預覽地址: <url>` 与「需要時可抓取上面的預覽地址查看完整範例」，模型可自行抓页；内联 `data:` URL 不进上下文（它本身就是内容且动辄几 KB）。**案例内容的数据缺口**：远端 `previewUrl` 对所有模板返回同一张样例页 → 此刻每张海报注入的内容是一样的（mock 的内联 `data:` 模板反而是逐模板的） | 后端给模板加 `content` 字段（或按模板 id 参数化预览页）；宿主里加一个"有 `content` 就直接用"的分支即可 |
| 注入的会话定位 | `systemPrompt.context` 的 provider 直接读 `context.agent.id`（`dsh-agent` 的 `assembleContextFor` 一定带上 `agent`），`agents.currentInitiator()` 只作退路；宠物 hover 上会写明是哪条路径（`已注入 N 字（context.agent）`）。**踩过的坑**：Inspect 给出的 `AssembleContext` 类型只声明了 `scope`/`signal`，照着它写就会去猜会话（第一版就是这么错的 —— 猜不到时静默注入空串） | 若哪天 `agent` 真的不在 assembly context 里了，退路还有 `agent/pre-step`（payload 直接带 `agent`） |
| 模拟延迟 | 各接口有 `LATENCY`（520/420/760/640/300ms）—— 只为让 loading 过渡可见 | 接真接口时删掉 `LATENCY`/`delayed`（或置 0） |
| 顶栏读数 | 调试期加的 `[diag3]` 已删除（`S.diag` 与那段读数不再存在） | 需要时按 §7.3 临时加回即可 |
| 配色 | 硬编码浅色（`#f8fafc` / `#0f172a` 等） | 换用 `--dsw-alias-*` 主题变量以支持暗色 |
| 文案 | 界面文案 = 繁体（zh-TW 惯用）；**代码注释**：bundle 里已一并转繁，动态原型里仍是简体（不影响界面） | 让原型注释也统一：把 `tools/s2t/convert.js --polish` 的输出贴回下一个 Package |
| 文档 | `UI.md` / `README.md` 保持简体（是给人读的说明，不是界面文案） | 需要的话同一套工具能一次性转繁 |
| 文案 | 中文硬编码 | 走 `ctx.locale.register(ns, {zh, en})`（`inject: ['locale']`） |
| 多选 | 一律单选 | spec §8 的 out-of-scope（多模板/多场景） |
| 持久化 | 无（刷新即回默认） | spec §4.5 的"用户级状态机" |
