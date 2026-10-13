# HANDOFF · ov-memory（OpenViking 记忆插件）

> 这份文件给**下一个接手或修改这个 bundle 的人**（也可能是几个月后的自己）。
> 它不重复 [README.md](./README.md) 的功能说明，而是讲**为什么长成现在这样**、
> **哪些坑已经踩过**、以及**下一步要做什么**。
>
> README = 这个插件「是什么、怎么用」。
> HANDOFF = 这个插件「为什么是這樣、哪里有地雷、接下来怎么改」。
>
> ## ⚠️ 硬规矩
>
> **每一次改进都必须同步更新这份文件**：改动内容写进 §8 变更记录，
> 影响到状态/结构/坑位的部分就地更新（§1/§2/§4/§6/§7）。
> 只改代码不改这里 = 下一个人会照着一份说谎的文档干活。

最后更新：**2026-10-13** · 基线：`OpenViking` HEAD `2e706d719`（upstream `@openviking/dsh-memory-plugin` v0.5.23）

---

## 0. 三十秒版

| 问题 | 答案 |
|---|---|
| 这是什么 | DSH bundle `ov-memory`：OpenViking 长期记忆（自动召回 / 采集 / 提交 / `viking://` 保护 / MCP 工具面 / 3 个 skill） |
| 代码从哪来 | upstream `OpenViking/examples/dsh-memory-plugin` 的 **vendored 副本**，只读参考，**永不修改上游** |
| 改名成什么 | 包名 `ov-memory`（upstream 是 `@openviking/dsh-memory-plugin`） |
| 共享模块在哪 | 真源 `cordis-plugins/memory-plugin-shared/lib`；`ov-memory/shared/` 是**生成副本**（提交进 git） |
| 连接从哪来 | **BDD storage 查询**：`POST …/dsh/storage/ov`，用 `refs.AIFE_API_KEY` 遮蔽后换回 `OPENVIKING_URL` + `OPENVIKING_API_KEY`。**不读环境变量**；查不到就 MCP / 技能 / 召回 / 采集**全部不激活**（§4.5） |
| 改完一定要跑 | `npm run check && npm test`；动了 shared 还要 `node scripts/sync-shared.mjs` |
| 上游发新版怎么办 | `node scripts/sync-upstream.mjs`（它会重放本地化），然后 review `README.md` |
| 现在被加载了吗 | **是**。2026-10-12 以 `link:` 装进 `web` profile 并已激活（见 §5.1 真机验收） |
| 验证跑在哪个 DSH | 本机 DSH `0.2.0-rc.2`（Node `v24.19.0`），**不是** lockfile 里的 `0.1.0-rc.6` |

---

## 1. 身份与来源

```
OpenViking/examples/dsh-memory-plugin     ← 上游原件（只读！）
        │  vendored（逐文件镜像 + 10 处本地化，见 §3）
        ▼
cordis-plugins/ov-memory                  ← 本 bundle（发布名 ov-memory）
        ▲
        │  共享运行时模块的唯一真源
OpenViking/examples/memory-plugin-shared/lib
        │  镜像
        ▼
cordis-plugins/memory-plugin-shared/lib   ← 真源副本
        │  scripts/sync-shared.mjs 生成
        ▼
cordis-plugins/ov-memory/shared/          ← 打包/安装用的生成副本（提交进 git）
```

比对结论（2026-10-12，忽略 CRLF）：`ov-memory` 与上游**仅 10 个路径不同**，
其余逐文件一致；`memory-plugin-shared/lib` 与上游**完全一致**。也就是说
**行为基准就是上游**，本地只有「身份 + 打包 + 文档 + 两处断言容忍」这类改动。

`repository` 字段指向 `github.com/wuzhiping/cordis-plugins` 的 `ov-memory/` 目录。

---

## 2. 目录结构

| 路径 | 角色 |
|---|---|
| `index.mjs` | Cordis 入口：装配 config/client/runtime，注册全部事件 |
| `runtime.mjs` | 核心状态机（召回 / 采集 / 提交 / dispose / pending latch / drainer） |
| `capture.mjs` | 事件 → OpenViking 消息 payload；插件消息构造；召回 query 提取 |
| `client.mjs` | HTTP 客户端（health / 会话 / 追加消息 / 提交） |
| `config.mjs` | 配置分层解析（委派给 shared），导出 `PLUGIN_VERSION` / `MCP_SERVER_NAME` |
| `lifecycle.mjs` | 启动时给 idle agent 注入 profile |
| `mcp.mjs` / `mcp-env.mjs` / `servers/mcp-proxy.mjs` | stdio → streamable-HTTP MCP 桥 |
| `uri-guard.mjs` | 拦截把 `viking://` 交给本地文件工具；给 bash 附提示 |
| `skills.mjs` / `skills/` | 独立 `ctx.skills` provider + 3 个内置 skill |
| `session-id.mjs` | DSH session id → 可移植的 `dsh-<id>` |
| `stored-credentials.mjs` | **连接的唯一来源**：读 `refs.AIFE_API_KEY` → 遮蔽 → `POST /BDD/API/AI/dsh/storage/ov` → `{url, apiKey}`；永不抛，用 `stage` 区分失败 |
| `shared/` | **生成物**，由 `scripts/sync-shared.mjs` 写入，**永远不要手改** |
| `scripts/sync-shared.mjs` | 从真源生成 `shared/`（`--check` 只校验） |
| `scripts/sync-upstream.mjs` | 从上游 checkout 重新 vendored（`--check` 只报告漂移） |
| `scripts/check.mjs` | 跨平台语法检查（本包 + `shared/` + 真源） |
| `sync-shared.test.mjs` | 副本漂移守卫 + 闭包解析守卫 |
| `.gitignore` | 只忽略 `node_modules/`（本地 scaffold，见 §6.4） |

---

## 3. 本地化清单（相对上游的**全部**差异）

上游发新版时，`scripts/sync-upstream.mjs` 会自动重放这些；**改这里的锚点必须同步改脚本的 `TRANSFORMS`**。

| 文件 | 改了什么 | 为什么 |
|---|---|---|
| `package.json` | `name` → `ov-memory`；`scripts` 换成 `sync`/`prepack`/`check`；`repository` 指向本仓库 | 本仓库的 bundle 名就是目录名；upstream 的 `prepack` 依赖它自己的仓库布局，在这里会**破坏文件**（§6.1） |
| `cordis.patch.yml` | 装载行 `name: 'ov-memory'` | DSH 从 profile 的 `node_modules` 解析这个名字，**必须等于包名**，否则启动即报 `duplicate loader entry id` / 解析失败 |
| `package-lock.json` | 两处 `name` → `ov-memory` | 与 manifest 自洽（仅 2 处，内容其余不动） |
| `bundle.test.mjs` | 两处断言：包名、patch 行名 | upstream 断言的是它的发布名 |
| `bundle.test.mjs` `skills.test.mjs` | `\n` → `\r?\n` | 本仓库 `core.autocrlf=true`，工作树是 CRLF，而断言读的是工作树 |
| `package.json` | 外加 `files` 增加 `stored-credentials.mjs` | 连接走 storage 查询后新增的模块 |
| `index.mjs` | **结构性改动**：连接改为异步解析，全部监听器以 `active` 门控 | 见 §4.5；这是一次 fork，不是改名 |
| `index.test.mjs` `mcp.test.mjs` `skills.test.mjs` `session-workspace.test.mjs` | `apply()` 现在要 `await`，且必须先 stub storage 查询 | 门控带来的测试接线 |
| `README.md` | 身份说明、Install 段、shared 说明、Upgrading 段、Configuration 段 | 见 §4.4 |

新增（上游没有）：`.gitignore`、`scripts/*`、`sync-shared.test.mjs`、`shared/`。

---

## 4. 工具链与不变量

### 4.1 `shared/` 为什么必须提交

DSH 装这个 bundle 有三种形态，**只有一种能看见包外的文件**：

| 安装形态 | 落地内容 | 能看见包外文件吗 |
|---|---|---|
| `dsh plugin add ./ov-memory`（`link:`） | 指向 checkout（symlink，Node 按 realpath 解析） | 能 —— 但正因如此，dsh peers 必须从 **checkout 自己的 `node_modules`** 解析（§6.4） |
| `github:<owner>/<repo>#path:/ov-memory` | **只物化 `ov-memory/` 子目录** | **不能** |
| `npm pack` / npm 包 | **只含 `files` 白名单内的文件** | **不能** |

证据：profile 里 `node_modules/scene-template` 等 GitHub `path:` 安装的落地目录**只有该子目录自己的文件**；
`npm pack --dry-run` 显示 tarball 只含包内文件。

所以共享模块走「真源 → 生成副本 → 提交」：`shared/` 必须存在且与真源一致，
否则打包/安装后是 `ERR_MODULE_NOT_FOUND`。

### 4.2 四条命令

```bash
npm run sync    # = node scripts/sync-shared.mjs   生成 shared/
npm run check   # 语法(80 模块) + shared 漂移 + 版本一致
npm test        # node --test *.test.mjs   （98 项：97 通过 / 1 跳过）
node scripts/sync-upstream.mjs [--check] [--from <checkout>]
```

**不变量**（改代码时不要破坏）：

1. `import "./shared/..."` / `"../shared/..."` 是**唯一**的共享模块引用形式；
   `sync-shared.mjs` 靠**解析后的路径**收集种子，因此 `servers/mcp-proxy.mjs` 的
   `../shared/` 也能被正确抓到（曾经只匹配字面 `./shared/`，漏了 2 个模块）。
2. `TRANSFORMS` 里每条锚点**必须恰好命中一次**，否则脚本报错中止——
   这是刻意的：上游改写该处时必须有人来看，而不是静默留一份过期本地化。
3. `sync-shared.test.mjs` 钉住"副本 == 真源闭包"与"闭包解析任意深度"。

### 4.3 上游同步的验证方式

`sync-upstream.mjs` 的正确性用**幂等性**验证（改完务必复跑）：

```powershell
# 临时副本里真跑一次，再与当前树对比，必须无差异（除 node_modules）
robocopy ...\cordis-plugins\ov-memory $probe\ov-memory /E /XD node_modules
node "$probe\ov-memory\scripts\sync-upstream.mjs" --from ...\OpenViking
git diff --no-index --ignore-cr-at-eol --name-status $probe\ov-memory ...\cordis-plugins\ov-memory
```

### 4.4 哪些文件人工持有（`--check` 里的 "held by hand"）

`README.md` 的本地改动是散在几处的**散文**，为散文做替换表会在"上游恰好重写周边文本"
的那次升级上崩掉。连接改走 storage 查询之后，`index.mjs` 与 4 个 apply 层测试文件
也加入了这一组 —— 那是**结构性 fork**，不是改名或行尾微调，用文本替换重放既不可读，
也会被上游第一次重排版打烂。

`sync-upstream.mjs` 的 `LOCALIZED` 就是这份清单；`--check` 会逐个打印它们
（"not compared, held by hand"），**升级时它们的上游版本仍会到达你面前，只是以"人工合并"的形式**。

### 4.5 连接：storage 查询，以及"查不到就什么都不挂"

```
$DSH_HOME/.credentials.yaml  refs.AIFE_API_KEY           ← 遮蔽用的钥匙（不是连接本身）
        │  maskKey() = "sk-" + base64(key + "@" + ISO)    ← 71 字符形（实测这个端点族吃它）
        ▼
POST https://abc.feg.com.tw/BDD/API/AI/dsh/storage/ov    body {"apiKey": <mask>}
        ▼
{ "OPENVIKING_URL": "https://ov.feg.cn", "OPENVIKING_API_KEY": "<64 字符>" }
        ▼
config.endpoint / config.baseUrl / config.apiKey          ← 覆盖 patch 与环境里的任何值
```

不变量（改代码时不要破坏）：

1. **`createOvHttp` 在构造时冻结 base URL**（`const baseUrl = cfg.baseUrl || cfg.endpoint`），
   所以拿到凭据后**必须重建 client**（`runtime.client = new OpenVikingClient(config)`），
   改 `config` 字段是没用的。
2. **注册同步、行为异步**：所有 `ctx.on` / `ctx.provide` / `ctx.effect` 仍在 `apply` 里同步完成，
   异步的只有 `activate()`；监听器用 `active` 门控。若把注册搬进 promise 的续体，
   凭据查询在途时到达的事件会被漏掉。
3. **失败绝不落到别的服务器**：`stage` 只有 `config` / `credential` / `request` / `response` 四种，
   任何一种失败都只记日志并返回 `false`，不挂 MCP、不挂 skill、不建 session。
4. **遮蔽值只能发给 `abc.feg.com.tw`**：`requireStorageUrl()` 会拒绝其它 host 与 http。
   MASK.md 的原则是"遮蔽值在传输中等同于密钥"。
5. **每个新会话重新确认**（在 `agent/created` 里，早于 profile 注入）：成功 → 刷新连接（重建 client）
   + 必要时**晚激活**；失败 → 该会话被拒绝。MCP 桥与 skill provider 是**进程级**挂载，
   没法给单个会话卸载，所以拒绝发生在**调用时**——`tools/pre-execute` 是 agent 作用域事件，
   带 `exec.agent`，`guardUnconfirmedBridgedTool` 据此拒绝 `mcp__openviking__*`。
6. **默认拒绝**：门控用"已确认集合"的**正向**判定（`confirmed.has(id)`），不是"未确认集合"。
   任何没走过确认的会话（被拒绝的、还没轮到的、`exec.agent` 缺 id 的）都拿不到记忆能力与桥接工具。
7. **确认有独立预算**：每会话确认 3 秒（`CONFIRM_TIMEOUT_MS`），boot 用默认 8 秒。
   因为它跑在**串行**的 `agent/created` 里，那里会 hold 住新会话的排队输入，
   所以 storage 端点挂掉时不能拖满 8 秒——超时就等于这次失败，再开一个新会话即可重试。
8. **失败绝不阻断会话创建**：`startAgent` 捕获一切、`agent/created` 永远 resolve `undefined`
   （返回别的值会 bail 串行派发，跳过它之后的监听器）。实测"没有账号"时新会话 **190ms** 建好；
   最坏情况（端点不可达）也只花确认预算（3 秒），且会话照建、只是没有记忆。

---

## 5. 已验证状态（截至 2026-10-13）

| 检查 | 结果 |
|---|---|
| `npm run check` | `checked 83 modules`；`shared/ matches memory-plugin-shared/lib` |
| `npm test` | 111 tests / **110 pass / 0 fail** / 1 skip（`live-recall` opt-in 真机 E2E） |
| `node scripts/sync-upstream.mjs --check` | `in sync`（人工持有清单见 §4.4） |
| 上游幂等性 | 临时副本真跑同步后与当前树**零源码差异** |
| `npm pack --dry-run` | **41 files**（含 20 个 `shared/*.mjs`） |
| `path:` 安装仿真 | 只复制 `ov-memory/`（无姊妹目录）时 `index.mjs` / `servers/mcp-proxy.mjs` / `shared/*` / `runtime.mjs` 全部 import 成功 |
| 上游仓库 | `git status --porcelain` 为空，HEAD 未变 —— **从未被修改** |

### 5.1 真机验收：`web` profile 以 `link:` 安装（2026-10-12，真实进程）

安装命令（`dsh plugin` 直通 pnpm；随后 `dsh-plugin-manager` 的 `reconcile()` 会自动把
声明了 `dsh.bundle` 的新依赖追加进 `dsh.profile.bundles`，并对 patch 做可加载校验，失败会回滚）：

```bash
dsh plugin --profile web add "C:\Users\shawoo\Desktop\feg.cn\cordis-plugins\ov-memory"
```

落地形态（与安装前备份逐项 diff，**只多了该有的东西**）：

| 位置 | 结果 |
|---|---|
| `profiles/web/package.json` → `dependencies` | `"ov-memory": "link:C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/ov-memory"` |
| `profiles/web/package.json` → `dsh.profile.bundles` | 末尾追加 `"ov-memory"` |
| `profiles/web/pnpm-lock.yaml` | +3 行（该 link 依赖的 specifier / version） |
| `profiles/web/node_modules/ov-memory` | `SymbolicLink` → checkout |

激活证据。**宿主进程 11:45:34 启动，安装在 16:30:34** —— 也就是说 DSH 在运行中
**热加载**了新 bundle，**本次没有重启**：

| 验收项 | 证据 |
|---|---|
| 装载行进入组合 | `cordis_inspect` host / Config：`include:openviking-memory-runtime`，`name: ov-memory` |
| 启动 profile 注入 | 会话上下文出现 `<openviking-context source="profile">`（含 `<available-memories>` 与 `<available-skills>`）。本会话的 agent 早于安装创建，所以这条走的是 **`agent/pre-step` 兜底投递**，不是 `agent/created` |
| 技能提供者 | 技能目录出现 `openviking-memory` / `openviking-skills` / `ov-experience-memory`；注入里另有服务端 `<available-skills>`（`viking://agent/skills/sirchmunk`） |
| MCP 工具面（端到端） | `mcp__openviking__health` → `healthy, storage: VikingFS`；`mcp__openviking__find` 返回真实记忆。链路：DSH → dsh-mcp-client → `servers/mcp-proxy.mjs` → 服务端 |
| 服务端与会话身份 | 服务端 `GET /health` → `version 0.5.0, auth_mode api_key`；`viking://user/pocoyo/sessions/` 按 mtime 倒序第一条 = 本会话 `dsh-session-a205040e-…`（`deriveDshSessionId` 的命名） |
| **采集 capture** | 该会话 `messages.jsonl` 里出现了**本次对话自己的 pwsh 工具结果**（`role:"user"`、`parts[0].type:"tool"`、`tool_name:"pwsh"`、`tool_status:"completed"`），以及**正在执行中**的 `mcp__openviking__grep`（`tool_status:"running"`）—— 采写是准实时的 |
| 召回 recall | **未直接观察到**（本轮注入只有 profile 块，没有 recall 块）。见 §7 TODO-1 剩余项 |

服务端是**远端** `https://ov.feg.cn`，不是本机服务。（该值当时由环境变量提供；
改走 storage 查询后由 §4.5 的端点给出 —— 同一台服务器。）

### 5.2 连接改造（storage 查询 + 失败即不激活）的验证，2026-10-12

| 验证 | 结果 |
|---|---|
| 端点契约实测（`POST /BDD/API/AI/dsh/storage/ov`） | mask71 → `200 {"OPENVIKING_URL":…, "OPENVIKING_API_KEY":…}`；mask67 → `200 {}`；无 apiKey → `500 apikey无效` |
| 模块真机跑通 | `fetchStoredConnection()` → `{ok:true, url:"https://ov.feg.cn", keyLen:64, ref:"AIFE_API_KEY"}`，凭据取自 `$DSH_HOME\.credentials.yaml` |
| **失败路径真机跑通（假 key）** | 用临时凭据文件放一把语法合法但服务器不认识的 `AIFE_API_KEY`，对**真端点**跑：`lookup → {ok:false, stage:"response", status:200, "carries no OPENVIKING_URL and OPENVIKING_API_KEY (received: no fields)"}`；再走**真 `apply()`** → `activated:false`、`mounted: []`（无 MCP、无 skill）、`registered: 0`，日志 `credentials_unavailable {"stage":"response","status":200,…}` |
| 契约/失败面测试 | `stored-credentials.test.mjs`：refs 解析、遮蔽公式（71 字符）、四个 stage（config/credential/request/response）、域名防线、"200 {}" 与 "500" 的区分 |
| 门控测试 | `index.test.mjs` 新增 **"a failed credential lookup activates nothing"**：断言没有挂 MCP、没有挂 skill、`agent/created` 不注入、`session/event` 不建 state、且**一次网络请求都没发出** |
| 离线门禁 | `npm run check` **83 modules**；`npm test` **109 项 / 108 通过 / 0 失败 / 1 skip** |
| 上游漂移 | `sync-upstream --check` → **in sync**（人工持有清单见 §4.4） |

⚠️ **本次改动尚未在运行中的 DSH 生效**：代码变更要重启才加载（§6.7）。当前运行进程仍是
旧的"从环境变量取连接"版本 —— 所以 §5.1 里那套结论描述的仍是旧路径，重启后要按新路径重验。

### 5.3 每会话确认（方案 A）的验证，2026-10-13

| 验证 | 结果 |
|---|---|
| 单元/集成 | 111 项 / 110 通过 / 0 失败。新增：**"a session whose confirmation fails is refused while the process stays connected"**（不注入、不建 state、`mcp__openviking__*` 被拒且带上 stage）与 **"late activation"**（boot 失败 → 首个确认成功的会话自己把桥与 skill 挂上） |
| 真机（真端点 + 真凭据） | `boot → activated:false, mounted:[]`；两个会话的桥接工具调用均被拒绝，拒绝理由为 `stage "response" (HTTP 200)`，日志有 `credentials_unavailable` |
| **"没有账号"场景实测**（2026-10-13，操作员**有意**移除 `/storage/ov` 记录） | boot：`activated:false`、`mounted:[]`、耗时 **545ms**；新建会话：`agent/created` 返回 `undefined`、**190ms** 完成、注入 0 条、pre-step 批次原样通过（无 recall）、桥接工具被拒且理由为"not enabled for this machine"、无 session state，两条 `credentials_unavailable` 日志（boot + 该会话） |
| **结论** | **没有账号 ⇒ 会话照样能建（190ms，不是被拖住），只是记忆能力整体为 0**。这正是这次故障注入要验证的性质 |
| 措辞区分 | 端点答了但**没有记录**（`empty: true`）说"not enabled for this machine"（不再叫人去查 key）；传输/500 类失败才说 `failed at stage "…"`。因为**未知 key 与被移除的记录在响应上不可区分**，所以空记录那句**从不**断言 key 是错的（§6.10） |

**推论**：`/storage/ov` 现在是**有意为空**的（操作员移除该 API key 对应的账号/记录）。
若此刻重启 DSH，新代码会**按设计拒绝挂载**：记忆功能整体关闭，而会话创建不受影响（上面的 190ms 实测）。

### 5.4 重启后的真机确认（2026-10-13 08:57，**新代码 + 无账号**）

这次重启同时证明了两件事：**新代码确实在跑**（旧代码没有门控，无账号也会照挂），
以及门控在真实进程里**按设计生效**。

| 检查 | 重启前（07:47 进程） | **重启后（08:57，PID 10288，`ov` 为空）** |
|---|---|---|
| 装载层 `include:openviking-memory-runtime`（`cordis_inspect` host/Config） | 在 | **仍在** —— bundle 被**装载**，被门控的是**挂载** |
| `<openviking-context>` 注入 | 有 | **无** |
| `openviking-memory` / `openviking-skills` / `ov-experience-memory` | 有 | **无**（技能目录里消失） |
| `mcp__openviking__*` 工具 | 有 | **无** |
| 系统提示的 MCP resource servers 段（由已挂载的 MCP server 生成） | 有 | **整段消失** |
| 新建会话 | — | **正常**（本次会话即新建） |

**因此 TODO-1c 的失败分支完成**；成功分支要等 `ov` 记录恢复后，用**新会话**（晚激活）
或再重启一次来确认。恢复记忆只需**重建那条 `ov` 记录**，**不必改代码** ——
每个新会话都会重新确认，晚激活会把 MCP 与 skill 自己挂回来。

**验证环境必须写清楚**：Node `v24.19.0`、本机 DSH `0.2.0-rc.2`、
npm registry **不可达**（所以本机跑测试靠 §6.4 的 junction scaffold，
依赖版本不是 lockfile 里的 `0.1.0-rc.6`）。

---

## 6. 踩过的坑

### 6.1 ★ `memory-plugin-shared/sync.mjs` 在这个布局里是**破坏性的**

**症状**：跑一次它，`memory-plugin-shared/lib/MANIFEST` 从 459 字节变成 **0 字节**，然后退出码非 0。

**根因**：它按 `examples/..` 推算仓库根（`ROOT = ../..`），在这里算到了 `feg.cn`；
找不到任何 target → 闭包为空 → 先 `writeManifest([])` **清空 MANIFEST**，
之后才在 `copySkill` 处因为找不到 skills 报错退出。

**实测**：副本沙箱里 `MANIFEST before: 459 → after: 0, exit -1`。

**对策**：**不要跑它**。它和 `install.sh`、`bootstrap.sh`、~40 个假定 OpenViking
仓库布局的测试一样，在这个仓库不可用；`ov-memory` 只用得到 `lib/` 与 `MANIFEST`。
（`scripts/sync-upstream.mjs` 会镜像 `lib/`，不会碰这些上游脚本。）

### 6.2 CRLF 与断言

**症状**：`skills.test.mjs` 在 Windows 上失败，`actual` 里全是 `\r\n`。

**根因**：本仓库 `core.autocrlf=true`（index 是 LF，工作树是 CRLF），
而断言写的是 `/^---\n/`。上游 CI 是 Linux/LF，所以那里一直是绿的。

**对策**：断言写 `\r?\n`（**不要**去归一整个工作树——`git add` 时
autocrlf 本来就会把 CRLF 收成 LF，工作树的行尾不是稳定状态）。
注意 `sync-upstream.mjs` 会把 `skills/*/SKILL.md` 恢复成上游的 CRLF，这是预期行为。

### 6.3 「只匹配字面 `./shared/`」会静默丢模块

第一版 `sync-shared.mjs` 用 `spec.startsWith("./shared/")` 收种子，
漏掉了 `servers/mcp-proxy.mjs` 的 `../shared/`，只生成 18/20 个模块。
**这种缺失运行时不报错**，只会在打包后炸。

**对策**：按**解析后的绝对路径**判断是否落在 `shared/` 里；并写测试钉住
`debug-log.mjs` / `mcp-proxy-core.mjs` 必须在闭包内。

### 6.4 `node_modules` 是本地 scaffold，不是正规安装

registry 不可达，所以本机跑测试用的 `ov-memory/node_modules/` 是 **6 个 junction**
指向本机 DSH 安装里的包（`@deepseek-ai/dsh-llm|dsh-mcp-client|dsh-skill-filesystem|dsh-tools|chokidar|semver`）。

两个后果：
- git 会**递归进 junction**（`git status -uall` 会列出上百条 node_modules 路径），
  所以有 `.gitignore` 兜住；
- `link:` 安装时 Node 从 checkout 的 realpath 解析 peers，**这份 scaffold 是让 `link:` 能跑起来的前提**；
  正式做法应该是 registry 恢复后 `npm ci`。

删除：`Remove-Item -Recurse -Force cordis-plugins\ov-memory\node_modules`

### 6.5 其它值得记住的上游设计约束（细节看 README）

- **注入走 `agent/pre-step` 的 user message，不走 system prompt**：DSH preset 里
  `complete: true` 的 persona（如 `minimal`）会在组装后覆盖掉所有其它 prompt section。
- **`agent/created` 监听器必须返回 `undefined`**：任何其它返回值会中断串行派发，
  跳过它之后的监听器。
- **`name: 'ov-memory'` 不可随意改**：它是 profile `node_modules` 的解析键。
- **`MCP_SERVER_NAME = "openviking"` 不可随意改**：它决定模型看到的
  `mcp__openviking__*` 工具名，是面向模型的契约。
- **`shared/` 是生成物**：改了会在下次 `sync` 被覆盖，要改就改真源。

### 6.6 从子进程 shell 看不到插件的凭据（DSH 会洗掉 KEY/SECRET/TOKEN）

**症状**：`curl https://ov.feg.cn/api/v1/sessions/<id>` 得到
`UNAUTHENTICATED: Missing API Key when resolving identity`；`env` 里也只看到
`OPENVIKING_URL`，很容易误判「插件根本没配 key」。

**根因**：DSH 会从子进程继承的环境里**洗掉匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字**
（README 有写）。宿主进程有 key，我的 shell 没有；`OPENVIKING_URL` 不在这个形状里，所以活了下来。

**教训**：**不能用「我的 shell 有没有这个变量」判断插件拿到了什么。**
要验证凭据与身份，走插件自己的路径（MCP 工具调用）或看服务端结果，不要用 curl 复现 ——
curl 必然缺 key，得到的 401 与插件的真实状态无关。

**附带结论**：`link:` 安装在 checkout 里需要的 dsh peers（§6.4 的 junction scaffold）
在同账户其它机器的经验里也出现过同类问题（`openviking-ui` 的 `@deepseek-ai/schemastery`
解析失败，同样靠在 bundle 目录里建 `node_modules` 软链解决）。这是这套环境的**已知模式**，
不是本 bundle 特有的怪癖。

### 6.7 「bundle 新增」会热加载，「代码变更」不会

**观察到**：`dsh plugin add` 之后，运行中的进程**无需重启**就装载了这个 bundle（§5.1）。
但这不等于「改代码也会热更」：ESM 按 URL 缓存，`apply()` 在组合时执行一次。

- **新增 / 移除 bundle** → 可能立即生效（本次实测如此）；
- **改 `index.mjs` / `runtime.mjs` 等代码** → 必须重启 DSH 才会加载新代码。

**代价**：重启会中断当前会话。所以改代码的正确姿势是：先在 checkout 里跑
`npm run check && npm test`（离线可跑，见 §6.4），把「只有重启才能看的东西」攒成一批，
再一次性重启验证。

### 6.8 ★ 遮蔽形状：MASK.md 说 67，实测这个端点族要 71

**症状**：照 MASK.md 的"API contract"实现（inner 去掉 `sk-`，得到 67 字符），
端点回 `200 {}` —— 看起来像成功，实际什么都没拿到，插件会静默"连不上"。

**实测**（2026-10-12，同一把 `AIFE_API_KEY`）：

| 形状 | 长度 | 结果 |
|---|---|---|
| `sk-` + base64(**key** + `@ISO`) | 71 | `200` + 真实数据（`/storage/ov` 与对照 `/storage/ntfy` 都是） |
| `sk-` + base64(**key.slice(3)** + `@ISO`) | 67 | `200 {}`（格式对、查不到） |
| 空 / 缺字段 | — | `500 apikey无效` |

**结论**：**这个端点族吃 71 字符形**。MASK.md 的 67 字符说法至少对 `/storage/*` 不成立；
`stored-credentials.mjs` 的注释里已写明这个矛盾与测量。改形状之前先重量一次。

**顺带两个坑**：

- **`/storage/<name>` 映射到 `/opt/bpm/BDD/API/AI/dsh/storage/<name>.nools`**，所以
  "路由不存在"会表现为 `500 … openviking.nools ENOENT`，而"规则写错"会表现为
  `500 Invalid rule definition`（2026-10-12 修好前 `/storage/ov` 就是这个）。两者都不是
  插件的问题，但错误文本能一眼区分。
- **这台机器有两份凭据文件**：`C:\Users\shawoo\.dsh\.credentials.yaml`（只有 `FEG_API_KEY`）
  与 `$DSH_HOME\.credentials.yaml`（有 `AIFE_API_KEY`）。读错那份的后果正是 `200 {}` ——
  与"形状错"的症状一模一样，所以 `credentialsFilePath()` 必须 `DSH_HOME` 优先，
  且失败信息必须**打出文件名**。

### 6.9 凭据查询失败 ≠ 插件坏了

需求是"查不到就不要激活 MCP 与 SKILLS"，所以失败路径**必须**是安静的、可诊断的、
且不产生副作用的：只记一条 `credentials_unavailable`（含 `stage`），不挂任何东西，
不建 session，不写 pending queue。**不要在失败时回退到环境变量** ——
那就等于绕过了"连接只来自 storage"这条规则，而且会把"没配置"伪装成"能用"。

### 6.10 ★ `/storage/<name>` 的记录可以被移除：`200 {}` 不等于 key 坏

**症状**：插件什么都不挂（或某会话被拒），日志 `credentials_unavailable {"stage":"response","status":200}`。
很容易误判成"key 失效"或"插件坏了"。

**这不是异常，是这套设计的事实上的总开关**：`ov` 记录存在 ⇒ 记忆可用；记录被移除 ⇒
每个新会话都被拒、MCP 工具与 skill 都不激活。**操作员可以据此按机器关闭记忆，不需要改代码。**
（2026-10-13 就是这样一次**有意的故障注入**，用来验证"没有账号"的场景，见 §5.3。）

**2026-10-13 实测**（同一把 `AIFE_API_KEY`、同一分钟）：

| 端点 | 结果 | 含义 |
|---|---|---|
| `/storage/ntfy` | `200 {name,uid,pwd}` | **key 有效**，遮蔽与查询链路都正常 |
| `/storage/ov` | `200 {}` | 查询执行了，但**这条记录不存在** |

而 `200 {}` 与"key 不存在"（`/storage/ov` 对假 key 也是 `200 {}`）**长得一模一样** ——
所以单看目标的返回值无法区分"记录没了"和"key 错了"。

**诊断法（一次就够）**：打**同一个端点族的另一个 name**（如 `/storage/ntfy`）。
它返回数据 ⇒ key 与链路没问题，缺的是目标记录；它也回 `{}` ⇒ 才怀疑 key。

**其它已确认的性质**（2026-10-13）：`GET /storage/ov`、`POST {}` 都是 `500 apikey无效`
（只接受 `POST` + 非空 `apiKey`）；`/storage/ov/` 与 `/storage/ov` 等价；
`/storage/openviking` 会 `500 … openviking.nools ENOENT`（说明路由按 `<name>.nools` 映射）。

**教训**：这个端点的"数据不存在"是 `200`，所以**必须**把"缺少字段"当失败（插件已如此），
且排障时**先用对照端点把 key 从嫌疑名单里划掉**。

---

## 7. 待办（下一步改造候选）

| # | 事项 | 状态 / 备注 |
|---|---|---|
| **0** | **`/storage/ov` 当前为空（有意为之）**：这是操作员移除账号/记录后的状态，用来验证"没有账号"的场景（§5.3/§6.10）。**恢复方法：重建该记录**，不必改代码（每会话重新确认 + 晚激活会接上） | 已知状态。此时重启 DSH = 记忆整体关闭、但会话创建正常 |
| 1 | **真机验收 · 安装与激活**：装进 `web` profile 并确认真的起来 | **已完成 2026-10-12**（§5.1）：`link:` 安装、运行中热加载（未重启）、profile 注入 / 技能提供者 / MCP 工具面 / **采集** 全部实测通过 |
| 1b | **真机验收 · 剩余项**：① 直接观察到 recall 注入块（`source="recall"`）② 确认 commit 真的触发（`turn/end` 达阈值或会话 dispose）③ 重启 DSH 后的稳定性 | 未做（需先恢复 `ov` 记录才有记忆可验） |
| 1c | **重启验证门控** | **失败分支完成 2026-10-13 08:57**（§5.4）：装载层仍在、注入/技能/MCP 工具全部不出现、新建会话正常。成功分支待 `ov` 记录恢复后用新会话（晚激活）确认 |
| 2 | **清理 `memory-plugin-shared` 的上游冗余**（`sync.mjs` / `install.sh` / `bootstrap.sh` / ~40 个跑不了的测试），只留 `lib/` + `MANIFEST` | 未做。需确认（会删文件）。留着也不影响运行，只是噪音 + §6.1 的误跑风险 |
| 3 | 把 §6.4 的 junction scaffold 换成正式 `npm ci`（或 pnpm），并把 `link:` 安装的 node_modules 依赖写进 README | 阻塞在 registry 不可达 |
| 4 | 把 package 版本号策略定下来：本地化后是继续跟 upstream 0.5.23，还是自增（如 `0.5.23+local.1`） | 未决。`check:version` 要求 `PLUGIN_VERSION` == `package.json` 版本，改了要同步 `config.mjs` |
| 5 | 是否要把 `HANDOFF.md` 放进 `package.json` 的 `files` | 当前**不放**（内部文档，没必要进 npm 包）；`ntfy-teams` 放，体例不统一，可再定 |
| 6 | 上游发新版时：`node scripts/sync-upstream.mjs` → review `README.md` → `npm run check && npm test` → 更新本文件 §8 | 流程已就绪 |

---

## 8. 变更记录

> 每次改进都在这里追加一行；**代码改了而这里没改，等于这次改进没做完**。

| 日期 | 改动 | 验证 |
|---|---|---|
| 2026-10-12 | 把 upstream `examples/dsh-memory-plugin` vendored 进 `cordis-plugins/ov-memory`，改名 `ov-memory`（package/patch/lock/测试断言） | 与上游逐文件比对，仅 10 处有意差异 |
| 2026-10-12 | 共享模块改为「真源 `memory-plugin-shared/lib` → 生成副本 `shared/`」并提交；新增 `scripts/sync-shared.mjs`（含 `--check`）与 `sync-shared.test.mjs` 漂移守卫 | 20 模块闭包；副本与真源逐字节一致 |
| 2026-10-12 | 修复闭包种子只认字面 `./shared/` 导致的漏模块（18 → 20） | `sync-shared.test.mjs` 钉住 `debug-log` / `mcp-proxy-core` |
| 2026-10-12 | 支持打包 / GitHub `path:` 安装：`files` 加回 `shared/`、`prepack` 跑 sync | `npm pack` 41 files；`path:` 安装仿真在无姊妹目录时仍能 import |
| 2026-10-12 | 两处断言改为 CRLF 容忍（`bundle.test.mjs` / `skills.test.mjs`） | 全部 98 项测试在 CRLF 工作树下通过 |
| 2026-10-12 | 新增 `scripts/sync-upstream.mjs`：只读镜像上游 + 重放本地化（锚点必须唯一命中） | `--check` in sync；临时副本幂等性验证零差异 |
| 2026-10-12 | 文档：`cordis-plugins/README.md` 登记 bundle 行；`ov-memory/README.md` 改 Install/身份并加 Upgrading 段 | —— |
| 2026-10-12 | 新增本文件 `HANDOFF.md`，并确立「每次改进必须同步本文件」的规矩 | —— |
| 2026-10-12 | 修 `sync-upstream.mjs`：把 `HANDOFF.md` 列入 `LOCAL_ONLY`（新增的本地文件被 `--check` 误报成上游漂移） | `--check` 恢复 `in sync`；98 项测试仍全绿 |
| 2026-10-12 | **`link:` 安装进 `web` profile**：`dsh plugin --profile web add <checkout>`；`reconcile()` 自动追加 `dsh.profile.bundles` | 落地 diff 仅「1 条依赖 + 1 个 bundles 项」，lock +3 行（§5.1） |
| 2026-10-12 | **真机验收通过**（无代码改动）：运行中热加载后，profile 注入 / 技能提供者 / MCP 工具面 / 采集全部实测通过；确认 DSH 会在 `plugin add` 后热加载 bundle | §5.1，含 `cordis_inspect` 组合证据与会话 `messages.jsonl` 的采集证据 |
| 2026-10-12 | HANDOFF 增补 §5.1 真机验收、§6.6 凭据洗掉的坑；§7 TODO-1 拆为「已完成」与「剩余项」 | —— |
| 2026-10-12 | **连接改由 BDD storage 查询提供**：新增 `stored-credentials.mjs`（读 `refs.AIFE_API_KEY` → 遮蔽 → `POST /BDD/API/AI/dsh/storage/ov`），`OPENVIKING_URL` / `OPENVIKING_API_KEY` 环境变量不再被读取 | 真机 `fetchStoredConnection()` → `https://ov.feg.cn` + 64 字符 key，ref=`AIFE_API_KEY`（§5.2） |
| 2026-10-12 | **查不到凭据就什么都不激活**：`index.mjs` 全部监听器以 `active` 门控；不挂 MCP、不挂 skill、不建 session、不发任何请求 | `index.test.mjs` 新增负面测试 "a failed credential lookup activates nothing" |
| 2026-10-12 | 遮蔽形状按**实测**定为 71 字符；MASK.md 的 67 字符说法对 `/storage/*` 不成立（回 `200 {}`） | 对照实验：mask71 有数据、mask67 `200 {}`、无 key `500 apikey无效`（§6.8） |
| 2026-10-12 | fork 边界更新：`index.mjs` + 4 个 apply 层测试文件转入 `LOCALIZED`；`stored-credentials.mjs`、`stored-credentials.test.mjs`、`test-support.mjs` 转入 `LOCAL_ONLY`；`package.json` 的 `files` 增加一条 transform | `sync-upstream --check` 恢复 `in sync` |
| 2026-10-12 | 新增 `scripts/check.mjs` 覆盖到 3 个新模块（83 modules）；README 的 Configuration / Behavior / Requirements 段改写为 storage 连接模型 | `npm run check` + `npm test` 全绿 |
| 2026-10-12 | **假 key 的真机失败验证**：临时凭据文件放未知的 `AIFE_API_KEY` → 真端点回 `200 {}` → `apply()` 返回 false、`mounted: []`、零请求 | §5.2；该场景同时被 `index.test.mjs` 的负面测试固定 |
| 2026-10-13 | **每新会话用 mask key 重新确认（方案 A）**：`agent/created` 里重新查询 → 成功则刷新连接并必要时**晚激活**；失败则该会话被拒（不注入/不召回/不采集，且**调用时拒绝** `mcp__openviking__*`）。门控改为"已确认集合"的**正向**判定（默认拒绝） | 111 项测试 / 110 通过 / 0 失败；新增两个测试（拒绝该会话、晚激活） |
| 2026-10-13 | 测试替身修正：`on()` 从"只留最后一个监听器"改为**真正的 waterfall 组合**（`tools/pre-execute` 现在有两个监听器，旧替身会静默测错的那个） | 该缺陷曾让"拒绝桥接工具"的断言实际调到 URI guard |
| 2026-10-13 | **真机发现 `/storage/ov` 返回 `200 {}`** —— 后经确认是操作员**有意移除**该账号/记录，用来测试"没有账号"场景。据此把它改写为"事实上的总开关"（§6.10），并把 TODO-0 从"阻塞项"改为"已知状态 + 恢复方法" | §5.3/§6.10/TODO-0 |
| 2026-10-13 | **空记录与失败分开措辞**：`extractStoredConnection` 对"端点答了但没有连接"标记 `empty: true`；拒绝理由对空记录说 *"not enabled for this machine"*，对传输/500 类失败才说 *"failed at stage …"*。因为**未知 key 与被移除的记录在响应上不可区分**，空记录那句从不断言 key 错 | 新增/更新测试断言；`notJson` 不算 `empty` |
| 2026-10-13 | **"没有账号"场景真机实测**：boot `activated:false, mounted:[], 545ms`；新会话 `undefined / 190ms / 注入 0 / 批次原样 / 工具被拒 / 无 state` | §5.3；并新增测试 *"a confirmation that cannot complete never blocks or fails session creation"* |
| 2026-10-13 | **重启后真机确认（08:57，PID 10288）**：新代码 + 无账号 ⇒ 装载层仍在，但注入 / 3 个 skill / `mcp__openviking__*` / MCP resource servers 全部不出现，新建会话正常。**失败分支闭环，同时证明新代码已生效** | §5.4；TODO-1c 失败分支完成 |

---

## 9. 改一步的 SOP

1. 想清楚改的是**本包代码**、**共享模块**、还是**本地化层**：
   - 共享模块 → 改 `memory-plugin-shared/lib/`（真源），再 `npm run sync`；
   - `shared/` 里的内容 → **不要直接改**；
   - 改上游已有的文件 → 记住下次 `sync-upstream` 会覆盖，若本地改动要保留就写进 `TRANSFORMS`。
2. 改完跑 `npm run check && npm test`。
3. 涉及 shared 或上游结构 → 补跑 `node scripts/sync-shared.mjs --check` /
   `node scripts/sync-upstream.mjs --check`。
4. **同步本文件**：§8 追加变更行；受影响的状态（§1/§2/§4/§5/§6/§7）就地更新。
5. 需要重启 DSH 才能验证的（如装 profile），**先问**——那会中断当前会话。
