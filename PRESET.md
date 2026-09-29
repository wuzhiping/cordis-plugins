# DSH Agent Preset 手册（本机版）

> 适用版本：本机安装 `@deepseek-ai/dsh` **0.1.7-rc.2**（global node_modules），profile = `web`。
> 适用范围：宿主 **Host**（`D:\Refine\Books\ntop\AI\dsh`）＋ profile（`D:\Refine\Books\ntop\AI\dsh\profiles\web`）＋ 本机已装的 bundle。
> 所有结论都在本机装好的包里核对过；带 `路径:行号` 的都能复查。上游 master 已比这个版本新（见 §12），升级后请重读 `docs` 与包 README。

---

## 目录

1. [一分钟速查](#1-一分钟速查)
2. [心智模型：Host plane 与 Preset plane](#2-心智模型host-plane-与-preset-plane)
3. [preset 声明格式](#3-preset-声明格式)
4. [两条落地路线](#4-两条落地路线)
5. [工具清单怎么定义](#5-工具清单怎么定义)
6. [skills 清单怎么定义](#6-skills-清单怎么定义)
7. [如何 enable / disable 插件](#7-如何-enable--disable-插件)
8. [场景提示词注入](#8-场景提示词注入)
9. [GUI 会看到什么](#9-gui-会看到什么)
10. [验证与回滚](#10-验证与回滚)
11. [常见坑](#11-常见坑)
12. [本机环境事实与已知缺口](#12-本机环境事实与已知缺口)
13. [参考索引](#13-参考索引)
14. [实操记录：preset-office（办公模式）](#14-实操记录preset-office办公模式)

---

## 1. 一分钟速查

**加一个 preset = 在 patch 层里插入一行 `@deepseek-ai/dsh-agent-preset` 声明。** GUI 侧不需要写任何代码（`ui-agent-preset` 已在 web bundle 里）。

```yaml
- insert:
    - id: preset-office                      # Loader 行 id，约定 preset-<config.id>
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: office                           # 必填：会话日志里保存的标识符
        name: 办公模式                        # 选填：名单展示名
        description: …                       # 选填：名单展示说明
        order: 10                            # 选填：名单排序（内建占 1-4）
        plugins:                             # 必填：该 agent 的子插件行列表
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are an office-work agent powered by the {{model}} model.
              suffix: Your working directory is {{cwd}}.
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
```

**装上去**：`plugin_manager` → `install_bundle`，target 填 bundle 目录的**绝对路径**（或直接写进 profile 的 `cordis.patch.yml`）。
**验证**：`plugin_manager list_plugins` 里出现 `preset-office` 行、无诊断；GUI 设置 → agent preset 分区出现卡片。

---

## 2. 心智模型：Host plane 与 Preset plane

### 2.1 组合的三个层次

```
bundle 的 *.patch.yml ─┐
profile 的 cordis.patch.yml ─┼→ 最终 Loader entry list → 插件树（scope / fiber）
命令行 overlay ─┘                  ↓
                       Host plane：共享服务（tools / prompt 注册表、agent loop、
                       session、settings、sandbox、LLM、jobs、subagent 注册表…）
                       Preset plane：每个 preset 一个隔离 scope，
                       挂"这一个 agent 贡献什么"（工具、prompt 段、委派后端）
```

**判断一行该放哪里的准则**（上游注释原文，web-app patch 第 427-529 行）：

- 某个 Service 会被**它 realm 之外的行读取** → 归 **Host**。例：`shell-env`（inject 给 shell 提供 `DSH_WEB_URL`）、jobs 注册表（生产者是 preset 行）、skill 注册表（host+scope 分层）、goal 服务与 round driver（Gateway remote 解析）、token meter（拥有进程级 projection）、subagent 注册表（进程单例 + 跨会话查询）。
- 只决定"**一个 agent** 贡献什么"（它的工具、它的 prompt 段、它的委派后端）→ 归 **Preset**。web 层因此把 `tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs` / `skill-filesystem` / `tool-skill` / `command-goal` / `tool-goal` / `plan-mode` / `compaction-*` / `tool-subagent*` / `agent-instructions` / `tool-todo` / `tool-web` 全部 `disabled: true`，交给每个会话的 preset 挂载。
- **"禁用"而不是"删除"是刻意的**：base 是共享的，某个 surface overlay 里若整行不存在，未来重排组合时它会悄悄复活。

### 2.2 生命周期（决定"改了为什么没生效"）

- preset 在**会话创建那一刻固定**：宿主拒绝让已存在的会话改用别的 preset。改声明、改默认值、改选择 → **只影响此后新建的会话**。
- 声明在加载时**急切激活一次**，同一 preset 被多个 agent 选择时共享同一份插件树（generation）。
- 改/删声明 → 旧代际退休，最后一个引用释放后销毁插件树。**重启按会话记录的 id 恢复；id 找不到就拒绝恢复**——不要随手复用/删除已在用的 id。
- 激活失败的行**不会从名单消失**：留在名单上带 `broken` 诊断，修好并重装前无法组装会话。

---

## 3. preset 声明格式

字段（本机 `Config.listConfigs` 查到的活 schema）：

| 字段 | 必填 | 类型 | 含义 |
|---|---|---|---|
| `id` | ✅ | string | 稳定标识符，小写字母/数字/连字符；会话日志保存它 |
| `plugins` | ✅ | list | 子插件行列表（可含 `cordis:group` 嵌套组） |
| `name` | — | string \| null | 名单展示名 |
| `description` | — | string \| null | 名单展示说明 |
| `order` | — | number \| null | 名单排序；内建 `standard`=1、`ptc`=2、`minimal`=3、`cordis`=4 |

行 id 约定 `preset-<config.id>`；`config.id` 才是**会话记录的 preset 标识符**。子行可省略行 id（Loader 自动分配），但沿用内建 id（`persona`、`agent-instructions`、`tool-fs`…）最安全。

内建声明的写法可抄（最短模板）：

- `D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml`（61 行）
- 同目录 `standard.patch.yml`（146 行，全量工具集）

---

## 4. 两条落地路线

两条路线**最终落到同一批 Loader 行**，GUI 效果完全一样。

### 路线 A：直接插进 profile patch（最小改动）

在 `D:/Refine/Books/ntop/AI/dsh/profiles/web/cordis.patch.yml` 末尾追加 §1 那段 `- insert:`。

- 优点：一次编辑、随 profile 走、HMR 大概率热生效、回滚就是删掉那几行。
- 缺点：不出现在 Plugins 页的 bundle 列表、不能 `set_bundle` 启停、不便于分享。
- 注意：**这一行会被 `dsh-config-editor` 重写**（GUI 保存任何设置都会原子替换该文件的配置覆盖项；它保留注释与 `!!js`）。

### 路线 B：工作区 bundle + `install_bundle`（推荐）

在 `C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/` 下建一个目录（本机自定义 bundle 都住这里，且是一个 git 仓库）：

`preset-office/package.json`

```json
{
  "name": "@local/preset-office",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "办公模式 agent preset：声明 preset-office（文档/表格/简报的读写、检查与交付）",
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`preset-office/cordis.patch.yml`：§1 的 `- insert:` 内容。

安装：

```
plugin_manager  action: install_bundle  target: C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/preset-office
```

它自己完成 package 安装与 bundle 选择（**不要**用 shell 复现这两步）。它会往 profile 的 `package.json` 写 `link:<绝对路径>` 依赖，并加入 `dsh.profile.bundles`。

- 优点：受管理、可启停（`set_bundle`）、`list_bundles` 可见、可分享；也是 GUI 里 Creator 模式产出的形态。
- 缺点：多一层目录与安装动作。

---

## 5. 工具清单怎么定义

"工具清单"不是配置文件里的一个列表，而是**该 agent 的 tools 注册表投影**（`dsh-tools` README.zh.md:28）：

| 来源 | 谁能改 | 说明 |
|---|---|---|
| preset 的 tool 插件行 | 你（`config.plugins`） | 每个 `dsh-tool-*` 行注册 `defineTool`，schema **自动进入系统提示词组装** |
| Host plane 已挂的工具 | 不由 preset 控制 | MCP 服务器发现的工具同样 `ctx.tools.register()`（本 profile 的 `cua-driver` 就是这样）；`dsh-plugin-manager/tools` 也是 host 侧 |
| 呈现模式 | host 行 `dsh-tools` 的 `mode` | `native`（每个 schema 一份，默认）/ `ptc`（只给 `run_code` + 生成 SDK）/ `both` |

要点：

- **要给** → 加对应包行；**不给** → 不写那一行（最干净，也省 token）。
- **要给但不能全给** → 只能靠插件的 `ctx.tools.restrict(filter)` 允许/拒绝掩码（按 agent 生效、取交集、dispose 时解除），**没有 YAML 白名单字段**。
- Host plane 的工具 preset **删不掉**：所以凡是想"只在 preset 里出现"的工具，web 层都先 `disabled: true`（见 §7）。
- 可选包清单：`D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md`（504 行，生成物；`Config` 列标注该行是否吃 `config`）。用 `grep -n tool-` 抽，别通读。
- 常用行片段（内建 preset 里的原样写法）：`tool-fs`(无 config)、`tool-fs-search`(`sampleOverCapGlobResults: false`)、`tool-pwsh` / `tool-bash`(平台守卫)、`tool-todo`(`allowParallelInProgress: true`)、`tool-web`(`fetch: true` / `searchTimeoutMs`)、`present`(`maxFiles` 默认 8)、`tool-ask-user`(无 config)、`tool-jobs`、`skill-filesystem` + `tool-skill`。
- 其他可挂的模型面工具包（`packages.md` 里标 `Config` 的）：`tool-str-replace-editor`、`tool-bash-persistent` / `tool-pwsh-persistent`、`tool-terminal`、`tool-goal`、`tool-subagent`（+ 后端 provider 行 `subagent-spawn-in-process` / `subagent-fork-in-process`）、`tool-workflow` + `workflow-ptc`、`tool-ralph`、`tool-session-query`、`tool-lsp`、`tool-workspace-dependencies`、`mcp-client`（把 MCP server 的工具注册进注册表）；无 config 的：`tool-subagent-control`、`tool-cordis`、`mcp-resources`。
- **呈现方式也能在 preset 里选**：`dsh-agent-tool-presentation`（agent 面呈现选择器，声明 `presentAs`）——`ptc` preset 就是这么做的（`ptc.patch.yml:144-147`）。host 行 `dsh-tools` 的 `mode` 是默认值，scope 可覆盖。

---

## 6. skills 清单怎么定义

模型看到的 skills = **skill provider 注册进 `ctx.skills` 的目录集合**，再由 `tool-skill` 渲染成会话目录。

- **注册表在 Host**（`dsh-skill`，base 行），并且是 **host + per-scope 分层**的：deployment 级 provider 进全局层，**preset 内挂的 provider 进该 preset 的层**；读取时合并 scope 链、最近层赢重名（web-app patch:472-479）。
- **目录发现用 `dsh-skill-filesystem`**（挂进 preset）。根与优先级（`dsh-skill-filesystem` README.zh.md:48-56）：

  | rank | 根 | 说明 |
  |---|---|---|
  | 100 | `<项目根>/.dsh/skills` | project-dsh |
  | 200 | `<项目根>/.agents/skills` | project-agents |
  | 300 | `customSkillDirs[]` | **preset 自己追加的目录** |
  | 400 | `$DSH_HOME/skills` | user-dsh（本机 = `D:/Refine/Books/ntop/AI/dsh/skills`） |
  | 500 | `$DSH_AGENTS_HOME/skills` | user-agents |
  | 600 | `bundledSkillDir` | `$DSH_BUNDLED_SKILL_DIR` |

- 一个 skill = 目录 bundle（`<name>/SKILL.md`）或平铺 `<name>.md`，YAML frontmatter 至少要有 `name` 与 `description`；**只发现一层深**，格式错误条目会静默消失。
- 想换场景的 skill 集合：调 `skill-filesystem` 的 `customSkillDirs` / `includeDefaultRoots`（默认 `true`）/ `bundledSkillDir`；`providerName` 默认 `filesystem`，`watch` 默认 `true`。
- **随包 Office provider**：`@deepseek-ai/dsh-skill-office`（行 id `skill-office`）注册恰好三个 skill：`office-docx`、`office-pptx`、`office-xlsx`，另带共享结构检查器 `assets/scripts/check_office.py`。config：`assetRoot`（默认包内 `assets/`）、`node`（默认当前独立 Node）、`cli`（默认已安装 kit 的 `lib/cli.js`，`false` 显式禁用）。
- 代价：skill 的 `description` 目录与加载后的正文都进上下文（目录是**仅追加**的持久 user 消息），所以 skill 集合同时是 token 成本与前缀稳定性的一部分。

---

## 7. 如何 enable / disable 插件

### 7.1 preset 内部：行级 `disabled`

- 子行 `disabled: true` → 该子插件不加载；接受 `true` / `false` / `null` / `!!js` 表达式。
- 组行（`name: cordis:group` + `group: true`）也能 `disabled`，整组子行随之不加载（注意：`group: true` 会强制激活以读取嵌套列表）。
- **作用域**：只影响这一个 preset 的 agent。
- 现成写法：`tool-subagent-codex: disabled: true`、`tool-ralph: disabled: true`、`tool-plugin-manager: disabled: true`（standard.patch.yml:103-118、125-130、144-146）。
- 平台守卫写在 `disabled` 上：`disabled: !!js process.platform === 'win32'`（bash 行）/ `!== 'win32'`（pwsh 行）。

### 7.2 Host plane 行：全局改（所有会话）

| 手段 | 作用域 | 特点 |
|---|---|---|
| profile patch 按 id 覆盖并写 `disabled: true` | 整个 profile / 所有会话 | 声明式、随 profile 走、可回滚；**`config` 是整体替换，不是深合并** |
| `plugin_manager set_plugin {target: rowId, enabled: false}` | 整个 profile / 所有会话 | 它自己写 profile patch 并即时生效；不能作用到 preset 内部子行 |

- `set_plugin` **只改 `disabled` 一个键**：命中最后一个同名非 insert 覆盖项就设值，否则追加 `{id, disabled: !enabled}`；`listPlugins()` 只消费 host loader 的 entries，而 preset 的组成在 `dsh-host-plugin-inventory` 的另一个数组 `agentPresets[]` 里 → **preset 子行没有可传给 `set_plugin` 的 entryId，传了就是 `unknown-plugin`**。要改 preset 子行，只能改声明本身（bundle patch / profile patch 里的 `preset-*` 行），由注册表的代际机制生效。
- 被禁用的 host 行若正好是某 preset 子行 `inject` 的服务，该子行**保持挂载但 pending**（审计 `waiting for <services>`），不会让 mount 失败。

### 7.3 `disabled` 的精确语义

- `disabledOf(row) = isJsExpr(disabled) ? Boolean(evaluate(expr)) : Boolean(disabled)` → 任何 truthy 值即禁用；`false` / `null` / `undefined` / `0` / `""` 是启用。
- **`group: true` 的行永远报告为启用**（`get disabled()` 直接 `return false`）：组行的禁用由**子行沿 owning parent 链继承**（任一祖先字面 `true` → 子行禁用；祖先含 `!!js` → 记为 `conditional`，交给真正的 mount 决定）。
- 命中禁用的行会被 **dispose 掉 fiber**（不是留着不初始化）。
- 在 preset 声明里，声明行带 Cordis 的 EntryGroup 标记，作用是**保留子配置里的 `!!js` 不求值**——所以每个子行的 `disabled` 是在**它自己挂载时、用它自己的 ctx** 求值的。

### 7.4 同名 id 的真实冲突发生在"效果层"，不在"id 层"

web-app patch 第 540-542 行的注释说：

> the preset-plane gate reads declared row ids **without regard to `disabled`**

但在 **0.1.7-rc.2 安装态里找不到这条门禁的任何实现**（全树 grep `presetPlane` / `preset plane` / `declared row` / `without regard to` 只命中那处注释与 `dsh-web-app/README.md`）。机制上也不会有 id 冲突：

- preset 子行挂在自己的**内存 PresetTree** 里（`write()` 是 no-op，不写回 profile），且 `Entry.id` 在存在父 entry 时会拼成 `parentEntry.id + ":" + id`——即 `preset-office:tool-fs`。呈现时注册表再把这层前缀剥掉。
- Loader 里**没有** "duplicate loader entry id" 这种检查（全树 grep 无此文本）；同 id 的 entry 会**复用同一槽位**而不是报错。

**真正会冲突的三处（都有实现证据）**：

| 冲突面 | 行为 | 报错/结果 |
|---|---|---|
| **工具名** | 注册表分层：host 行进 global 层，preset 行进该 preset 层；**近层遮蔽远层**；**同一层内重复**才失败 | 同层重复 / 占用保留名 `run_code` → 失败 |
| **服务名** | 同一 realm 内二次注册同名服务会被 cordis 拒绝 | `service "<name>" has been registered at <fiber>` |
| **preset 自己提供的服务泄漏进 root realm** | mount 审计拒绝整个 preset | `Preset services require isolate realms: <names>` |
| **skill 名** | 近层直接胜出重名 | 无报错，preset 层赢 |

**实践结论（修正版）**：

- 沿用内建 id（`persona` / `tool-fs` / `agent-instructions`…）很安全；用全新 id（`skill-office` / `present` / `tool-ask-user`）也完全可行——**id 本身不冲突**。
- 要小心的是**服务名与工具名**：不要把一个"提供全局命名服务 / provider"的行同时留在启用的 host 行里又在 preset 里再挂一份（subagent provider 是典型：全局唯一名字，两份会饿死 host 行并在第二个会话上碰撞）。要下沉，就先把 host 行 `disabled: true`。
- preset 内**提供**服务的行必须给它所在的组 `isolate`（如 `planning` 组的 `isolate: {planMode: true}`、`compaction` 组的 `isolate: {compaction: true, toolResultPruner: true}`），否则整次 mount 被拒。
- 被禁用的 host 行如果正好是某个 preset 子行 `inject` 的服务，**该子行保持挂载但 pending**（审计显示 `waiting for <services>`），不会让整次 mount 失败。
- 另有一个真会抛的错：**同一个 `config.id` 声明两次** → `Duplicate agent preset: <id>`。

---

## 8. 场景提示词注入

有五条通道，按稳定性从高到低：

| # | 通道 | 载体 | 位置 | 何时出现 |
|---|---|---|---|---|
| 1 | 场景 persona | `@deepseek-ai/dsh-persona` 的 `prefix` | system 段 `deployment:persona-prefix`（order **0**） | 恒常 |
| 2 | 场景追加规则 | 同上的 `suffix` | system 段 `deployment:persona-suffix`（order **10200**，在第一方指令之后） | 恒常 |
| 3 | 计划模式规则 | `@deepseek-ai/dsh-plan-mode` 的 `section` | system 段 `plan:policy`（order **500**） | 仅 plan mode 激活时非空 |
| 4 | 工作区指令文件 | `@deepseek-ai/dsh-agent-instructions` | **持久 user 消息**（`<system-reminder>`），非 system 段 | AGENTS.md 链 + 后续动态追加 |
| 5 | skill 目录与正文 | `skill-filesystem` / `skill-office` + `tool-skill` | 持久 user 消息 | 会话开始 + `/skill` 加载 |

关键语义（都验证过）：

- **persona 只能在 scope 内挂**（即 preset 子行）。全局挂载会与 prompt 注册表自己的人设注册相撞并报错。
- **`suffix` 省略或为空 = 遮蔽掉部署的 persona 后缀，而不是继承**。本 web profile 的部署后缀是 `Your working directory is {{cwd}}.`（web-app patch:16-20）→ 想在 office preset 里保留它，必须**显式重写**这一行。
- `prefix` / `suffix` 是模板，`{{model}}`、`{{cwd}}` 等变量**严格插值**；不认识的变量会报错。
- `complete: true` 让前缀成为**完整**系统提示词，抑制其他所有段（身份、后缀、工具引导全部不再追加）；多于一个有效 complete 段则组装失败。
- `includeRuntimeContext: false` 是**全有或全无**：连沙箱策略、批准策略、委派上下文一起关掉。办公场景建议保持默认 `true`。
- `agent-instructions` 的 config：`maxBytes` **必填**、`maxSourceBytes` 默认 1048576、`projectRootMarkers` 默认 `[".git"]`、`instructionFileCandidates` 默认 `["AGENTS.md","CLAUDE.md"]`、`localInstructionFileCandidates` 默认 `["AGENTS.local.md","CLAUDE.local.md"]`、`dshHome` 默认 `$DSH_HOME`。它**只跟随结构化 fs 工具**（不是 shell 的 `cd`），刷新靠文件 touch、没有 watcher。
- **KV cache**：#1-#3 是每个请求重复的固定前缀，改动会从第一个变化 token 起失去复用；#4-#5 是**仅追加**的消息，不会使更早的前缀失效。本机 `deepseek-flash` 路由已配 `systemPromptUpdate: in-history`（`D:/Refine/Books/ntop/AI/dsh/profiles/web/cordis.patch.yml:70`），提示词变更会追加到缓存历史之后。

---

## 9. GUI 会看到什么

三个面（都由 `@deepseek-ai/dsh-client-ui-agent-preset` 提供，已在 web bundle 里）：

1. **新建会话 chip** —— 事前选择（只影响即将创建/仍为空白的会话）。
2. **会话标题标签** —— 事后只读，报告该会话已记录的 preset。
3. **设置 → agent preset 分区** —— 名单卡片（默认项高亮、点击设默认）、"查看配置"只读 YAML 查看器（按 entry-list 方言渲染，含 `!!js`）、名单里有 `cordis` preset 时的 **Creator 模式入口**。

### 9.1 门槛：「代码工作工具」开关

- 字段：设置命名空间 **`ui-settings-account`** 的 **`developerTools`**，**默认 `false`**（volatile）。UI 文案："代码工作工具 —— 开启后显示轨迹、本轮代码差异，新对话中的 Agent 预设切换"。
- 关着 → 新会话 chip 不出现、卡片拒绝选择；**已保存的默认值仍继续组装新会话**。
- 打开它本身会往 profile patch 写一条 `ui-settings-account` 的覆盖行（这是正常的，settings 的写入通过 `dsh-config-editor` 落到 profile patch）。

### 9.2 默认值解析

- 部署默认：host 行 `agent-preset-registry` 的 `config.default`（本机 = `standard`，web-app patch:558-562）。
- 用户默认：同一命名空间的 volatile 字段 `selectedDefault`（GUI 点卡片设默认时写入；客户端常量 `AGENT_PRESET_SETTINGS_NS = "agent-preset-registry"`）。
- 生效值 = `selectedDefault ?? default`。
- **旧命名空间 `agent-presets` 已废弃**：`D:/Refine/Books/ntop/AI/dsh/settings.yaml.imported:43-44` 里还留着 `agent-presets: {default: standard}`，但当前注册表不读也不重写它。

---

## 10. 验证与回滚

**验证清单**

1. 路线 B 的话：profile 的 `package.json` 里出现 `link:<bundle 绝对路径>` 依赖，`dsh.profile.bundles` 末尾多了该 bundle。
2. `plugin_manager list_plugins`（数据量大，分页看尾部）：`include:preset-<id>` → `enabled: true`、`fiberPhase: "active"`、无诊断。
3. `cordis_inspect_query` → host `Config.listConfigs`（`name` 过滤）：`entries` 里出现 `include:preset-<id>`；再查该 entry 可看投影后的 JSON Schema。
4. GUI：设置 → agent preset 分区出现卡片；新建会话 chip 能选中；新会话标题标签显示它。
5. 「代码工作工具」开关已开（否则 chip 根本不渲染，这不是故障）。
6. 客户端在 `settings/document-updated` 与 `connection/reset` 时重读名单；必要时刷新页面；行没热生效就重启 `dsh web`。

> 名单里出现 `broken` 徽标 = 该 preset 的插件树激活失败：**行还在，但无法组装会话**，修好声明并重装后再试。

**回滚**

- 删掉 insert 行 / `plugin_manager remove_bundle`。
- 旧代际退休，已开始的会话照旧跑；但**别删仍在使用的 `config.id`**——那些会话重启时会拒绝恢复。
- bundle 目录可以留着（重装即可）；`dsh.profile.bundles` 与 `package.json` 依赖由 plugin_manager 自己维护。

---

## 11. 常见坑

1. **patch 覆盖是整体替换**：按 id 覆盖一行时必须把原行所有字段重写全（`config` 不深合并）。
2. **一个 id 只留一处声明**：本 profile 的 `jeeflow-panel` 注释记录了"同名两行会抛 `duplicate loader entry id`"的经验；**0.1.7-rc.2 的 Loader 里找不到这个检查**（同 id 会复用槽位）。无论如何，bundle 与 profile patch 同时声明同一个 id 只会带来困惑，保持单一声明处。真正会抛的是：同一个 `presetId` 声明两次 → `Duplicate agent preset: <id>`。
3. **别改安装目录**：`…/node_modules/@deepseek-ai/dsh-web-app/presets/*` 属于全局安装，升级即被覆盖。一切写进 profile 或自己的 bundle。
4. **persona 必需 `prefix`**；缺 `plugins` 或 `id` 的声明无法加载。
5. **`!!js` 只能出现在 plugin 的 `config` 或 `disabled` 里**；在 `config` 内是"该插件注入就绪后、对它自己的 ctx"求值。其他行元数据保持字面量。
6. **`group: true` 的组行会强制激活**以读取嵌套列表；disabled 的组行会带走整组。
7. **当前会话不能就地切换 preset**：新建会话验证。
8. **GUI 保存设置会重写 profile 的 `cordis.patch.yml`**（保留注释与 `!!js`，原子替换）。手工编辑与 GUI 编辑可以共存，但别用它当"只读文件"。

---

## 12. 本机环境事实与已知缺口

| 事实 | 值 |
|---|---|
| 安装版本 | `@deepseek-ai/dsh` 0.1.7-rc.2（npm 上已有 0.2.0-rc.1；上游 master 已比本机新约 3700+ 提交） |
| Host / profile | `D:/Refine/Books/ntop/AI/dsh` / `D:/Refine/Books/ntop/AI/dsh/profiles/web` |
| 内建 preset | `standard`(1) `ptc`(2) `minimal`(3) `cordis`(4)；部署默认 `standard` |
| 已有自定义 bundle | cute-clock、scene-template、zhtw-traditional-chinese、no-browser-auth、@local/aife-provider、fdep-api-request-bundle、today-material-panel、jeeflow-panel |
| 兼容旧目录 | `$DSH_HOME/.agent-presets/` 存在但**为空** → 无需迁移 |
| **office 缺口 1** | **没有 primary-runtime payload**（全盘无 `runtime.json`）→ `@deepseek-ai/dsh-tool-workspace-dependencies` 无法挂载（其 `source` 必填），office skill 里"call `load_workspace_dependencies`"的默认路径走不通，须回落到已配置环境 |
| **office 缺口 2** | 系统 Python 3.11.9 **缺少** `python-docx` / `openpyxl` / `python-pptx` → 目前能跑**结构检查**（`check_office.py` 只用标准库），但**创建/编辑** Office 文件前需要 `pip install python-docx openpyxl python-pptx`，或构建 primary-runtime payload |
| office 可用项 | LibreOffice Kit CLI 已在 `…/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js`（`libreoffice-kit-win32-x64` 也在），渲染/转 PDF 可用；`python` = 3.11.9（`py` = 2.7.12，脚本里别用 `py`） |
| 上游文档漂移 | 你上次读的那份 `ui-agent-preset` README（commit c291e79）描述的是"浏览器内复制/删除 preset"的旧设计，master 已改为"profile YAML 声明 + 只读查看器 + Creator 模式" |

---

## 13. 参考索引

**权威文档（本机）**

- `D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset/README.zh.md` —— 声明格式与字段表
- 同目录 `skills/editing-cordis-compositions/SKILL.md` —— 增删改 preset 的流程
- 同目录 `skills/cordis-composition-reference/SKILL.md` + `references/packages.md` —— patch 方言与可挂包清单
- `…/dsh-agent-preset-registry/README.zh.md` —— 名单/默认值/代际与审计不变量
- `…/dsh-tools/README.zh.md` —— 工具注册表、`mode`、`restrict`
- `…/dsh-persona/lib/types/index.d.ts`、`…/dsh-system-prompt/lib/types/index.d.ts` —— prompt 段与 order
- `…/dsh-agent-instructions/lib/types/config.d.ts` —— 指令文件发现配置
- `…/dsh-skill-filesystem/lib/types/index.d.ts` —— skill 根与优先级
- `…/dsh-skill-office/README.zh.md` + `assets/office-*/SKILL.md` —— 三个办公技能的实际要求
- `…/dsh-config-editor/README.zh.md` —— 设置如何写回 profile patch

**本机配置**

- `D:/Refine/Books/ntop/AI/dsh/profiles/web/cordis.patch.yml` —— profile patch（可插入 preset 声明）
- `D:/Refine/Books/ntop/AI/dsh/profiles/web/package.json` —— `dsh.profile.bundles` 启停清单
- `D:/Refine/Books/ntop/AI/node/global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml` —— host/preset 平面的划分注释（427-529 行）与 `agent-preset-registry` 行（555-562 行）
- `D:/Refine/Books/ntop/AI/dsh/skills/` —— 本机用户级 skills（`fdep-api-request`、`file-share`）

**跨工具用法**

- 读活 schema：`cordis_inspect_query` → host / `Config` / `listConfigs`（先按 `name` 列条目，再用 `entry` 取该行 JSON Schema）
- 读活 Service/Event 签名：`cordis_inspect_list` → host / `Service` / `Event`

---

## 14. 实操记录：preset-office（办公模式）

**产物**

- bundle：`C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/preset-office/`
  - `package.json` —— `name: @local/preset-office`，`dsh.bundle.patch: ./cordis.patch.yml`
  - `cordis.patch.yml` —— 一条 `preset-office` 声明（`config.id: office`、`name: 办公模式`、`order: 10`）
- 该 preset 的组成（均已按内建 preset 的写法核对）：

  | 行 | 作用 |
  |---|---|
  | `persona` | 办公身份 + 场景规则（**显式重写 suffix**，保留 `Your working directory is {{cwd}}.`） |
  | `agent-instructions` | `AGENTS.md`/`CLAUDE.md` 链，`maxBytes: 65536` |
  | `tool-fs` / `tool-fs-search` | 文档读写与检索 |
  | `tool-pwsh` / `tool-bash` | 执行 office 脚本与 LibreOffice Kit CLI（平台守卫二选一；删掉即"零执行"模式） |
  | `skill-office` | `office-docx` / `office-pptx` / `office-xlsx` + 共享结构检查器 |
  | `skill-filesystem` + `tool-skill` | 本地技能目录与本机 `$DSH_HOME/skills` |
  | `tool-ask-user` / `tool-todo` / `tool-web` / `present` | 澄清、进度、查资料、交付成品 |
  | `compaction`（组，`isolate`） | `compaction-basic` + `command-compact` + `tool-result-pruner` |

  **不装载**：bash 之外的一切代码开发工具、subagent/workflow/ralph、plan-mode、goal、jobs。

**安装（已执行）**

```
plugin_manager action=install_bundle target=C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/preset-office
→ stage: enable · enabled: true · application: applied · exitCode 0
```

**验证（已执行）**

| 检查 | 结果 |
|---|---|
| profile `package.json` | 新增 `"@local/preset-office": "link:C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/preset-office"`，并加入 `dsh.profile.bundles` 末尾 |
| `Config.listConfigs name=@deepseek-ai/dsh-agent-preset` | 从 4 条变 **5 条**，新增 `include:preset-office`（patchId `preset-office`） |
| `plugin_manager list_plugins`（尾部页） | `include:preset-office` → `enabled: true`、`fiberPhase: "active"`、无诊断 |
| profile `cordis.patch.yml` | **未被改写**（本次安装没动它） |

**还差你在 GUI 上做的两步**

1. 通用设置 → 打开「代码工作工具」（否则新会话 chip 不显示、卡片不可选）。
2. 刷新页面；设置 → agent preset 分区应出现「办公模式」卡片，新建会话 chip 里可选中它。**新建**一个会话用「办公模式」验证（当前会话不能就地切换）。

**顺带记下的 office 运行缺口**（首次真正做文档前要解决）

1. **没有 primary-runtime payload**（全盘无 `runtime.json`）→ `dsh-tool-workspace-dependencies` 的 `source` 必填、挂不上，office 技能默认的 `load_workspace_dependencies` 路径走不通，须回落到已配置环境。
2. **系统 Python 3.11.9 缺 `python-docx` / `openpyxl` / `python-pptx`**：结构检查（`check_office.py`，纯标准库）可以跑；**创建/编辑**前需要 `python -m pip install python-docx openpyxl python-pptx`，或构建 payload 后改用随包 Python。
3. LibreOffice Kit CLI **可用**（`…/@deepseek-ai/libreoffice-kit/lib/cli.js`），渲染与转 PDF 没问题；`py` 是 Python 2.7，脚本里请用 `python`。
