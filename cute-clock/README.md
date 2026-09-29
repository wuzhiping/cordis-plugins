# 🐱 cute-clock —— 猫咪时钟插件

一只住在 DSH Web GUI 角落里的猫咪时钟 —— 圆脸、耳朵、会眨眼、头顶还有一颗跳动的小爱心。

## ✨ 它做了什么

注册三个座位：

| 位置 | 用途 |
|---|---|
| **`shell.overlay`** | 永远飘在右下角的小猫咪 · 显示问候语、活力 slogan、时分秒、日期 |
| **`sidebar.panellist`** | 左栏新增 🕐 图标，点击切换到全局面板 |
| **`main` (keyed)** | 全屏"猫咪时钟"页面：大钟 + 大字时间 + 飘落花瓣 + 活力 slogan |

## 🏢 办公模式下自动退场

agent preset **无法** enable/disable 浏览器插件（preset 只在自己的 agent scope 里挂插件，而浏览器名册是宿主启动时按 `dsh.client` 行组好的）。所以本插件自己判断：**当前会话跑在隐藏名单里的 preset 上时，三个座位一起不渲染** —— 浮层、左栏图标、时钟页面全部消失；如果人正停在时钟页上，会顺手切回会话，不留下空主栏。

- 名单在 `lib/client.js` §0：`var HIDDEN_PRESETS = ['office'];` —— 登记的是 preset 的 **`config.id`**（当前即 `preset-office` 声明的 `office`）。想再挂别的模式，往数组里加即可。
- 判断依据：`shell.overlay` / `sidebar.panellist` / `main` 三个槽位都是 root scope，标准 props 带 `useSessions`（会话列表 + 当前选择）；当前会话由 `retainedBy.mainView > 0` 标记，其 `projectionValues.agentPreset` 正是 `ui-agent-preset` 读的同一个键。
- 没有会话时（新建页、空白页）照常显示；改完 `lib/client.js` **刷新页面**即可生效（纯 JS，无需构建）。

## 🎀 可爱的细节

- 🐱 **圆脸小猫**：三角耳朵、内耳粉色、闪亮的黑眼睛、Q 弹腮红、微笑小嘴
- 👀 **眨眼动画**：每 4.6 秒眨一次（左右眼错开 0.08s，更自然）
- 👂 **耳朵抖动**：每 5.4 秒抖一次（右耳延迟 1.3s，错峰）
- 💗 **头顶爱心**：呼吸式缩放，1.4s 一个周期
- ⏰ **秒针带弹性**：用 `cubic-bezier(.34,1.56,.64,1)` 模拟机械表的"嘀嗒"
- 🕐 **问候语随时间切换**：早安/午安/晚安/夜深了…（带 emoji）
- 🌸 **花瓣飘落**（仅大屏）：18 片随机花瓣从顶部飘下
- 💪 **活力 slogan，每次打开都不一样**：75 条闹钟级打气文案，按时段分 5 桶（morning/noon/afternoon/evening/night），**每次打开面板或刷新页面都随机抽一条**；浮动小卡片和大面板各抽各的；大面板上**点一下 slogan 就再换一条**。跨时段（比如 14:00）时会自动换到时段的句子

## 💪 活力 slogan 机制

文案池在 `lib/client.js` 的 `ENERGY_PACK`，每个时段 15 条，共 75 条：

| 时段 | 小时 | 条数 |
|---|---|---|
| `morning` | 00–08 | 15 |
| `noon` | 09–13 | 15 |
| `afternoon` | 14–17 | 15 |
| `evening` | 18–21 | 15 |
| `night` | 22–23 | 15 |

- 抽取函数：`pickEnergySlogan(scope, rand)` —— `Math.random()` 随机，`rand` 可注入方便测试
- 组件里用 `useState(function () { return pickEnergySlogan(bucketOf(h)); })` 惰性初始值，
  所以**每次组件挂载（= 每次打开面板 / 每次刷新页面）都会重新抽一次**
- `useEffect(..., [h])` 在跨时段时再抽一次，保证早上不会看到晚上的话
- 想加句子：直接往 `ENERGY_PACK` 对应数组里塞；想加时段：加一个 key 并在 `bucketOf()` 里分支

## 🎨 主题适配

所有颜色一律使用 DSH 主题令牌（`--dsw-*`），**无需任何额外代码**，明暗主题自动切换：

```
背景：--dsw-alias-bg-layer-1
边框：--dsw-alias-border-l2
文字：--dsw-alias-label-primary / -tertiary
强调：--dsw-alias-brand-primary
状态：--dsw-alias-state-error-primary (腮红/爱心/秒针)
阴影：--dsw-elevation-panel
```

## 📦 安装

```sh
# 从插件目录外执行（cwd 会自动锚定）
dsh plugin --profile web add ./cordis-plugins/cute-clock

# 卸载
dsh plugin --profile web remove cute-clock
```

安装完成后**重启 web profile 一次**（新增宿主行需要重启）。

## 🔄 开发循环

- 改 `lib/client.js`：**不用重启**，500ms 后 HMR 自动推送更新
- 改 `lib/index.js` / `package.json` / `cordis.patch.yml`：**必须重启**宿主

## 📁 文件结构

```
cute-clock/
├── package.json          # 三处 dsh.* 声明
├── cordis.patch.yml      # 把自己插入组合树
├── README.md
└── lib/
    ├── index.js          # 宿主半边（空壳，逻辑全在浏览器）
    └── client.js         # 浏览器半边（React + SVG + CSS 动画）
```

## 🪑 注册了什么座位（对照 CLIENT.md §1）

| 你的说法 | 平台术语 | key |
|---|---|---|
| 角落里的小猫咪 | 帧级浮层 | `shell.overlay` |
| 左栏 🕐 图标 | 全局面板图标行 | `sidebar.panellist` |
| 大时钟页面 | 中央面板 | `main` (key=`cute-clock`) |

### 加全局面板的两步走（CLIENT.md §6.1）

1. **`sidebar.panellist`** 加一个图标项（`id: 'cute-clock'`）
2. **`main`** 用**同一个 id 作为 key** 注册页面本体

点图标时调 `ctx.layout.selectPanel('cute-clock')` 切换面板，再次点调 `selectPanel(null)` 回到会话。

## ⚠️ 已知约束

- `ctx.layout.selectPanel` 是 `null` 时回到会话且**不改动当前 session**
- 选择不存在的 `main` key 会抛错 —— 所以 panellist 注册和 main 注册**必须成对出现**
- `shell.overlay` 本身"点击穿透"，但本插件的卡片主动 `pointer-events:auto`，不会挡住下面的交互
- 浮动小组件在页面会话期间一直挂载着，所以它的 slogan 是**刷新页面时换一次**；
  大面板每次点开都会重新挂载，所以**每次打开都是新的**（这正是"每次打开都生成"的语义）

## 🐾 可扩展点

- 加点击交互（点到小组件时切换大页面）
- 接入 `ctx.locale` 做多语言问候语
- 加闹钟/番茄钟功能（基于 `ctx.timeout` + `ctx.sessions` 写入会话提醒）
- 加自定义头像/主题色（基于 `ctx.theme`）

享受你的猫咪伙伴吧～ 🐾
