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

最后更新：**2026-10-12** · 基线：`OpenViking` HEAD `2e706d719`（upstream `@openviking/dsh-memory-plugin` v0.5.23）

---

## 0. 三十秒版

| 问题 | 答案 |
|---|---|
| 这是什么 | DSH bundle `ov-memory`：OpenViking 长期记忆（自动召回 / 采集 / 提交 / `viking://` 保护 / MCP 工具面 / 3 个 skill） |
| 代码从哪来 | upstream `OpenViking/examples/dsh-memory-plugin` 的 **vendored 副本**，只读参考，**永不修改上游** |
| 改名成什么 | 包名 `ov-memory`（upstream 是 `@openviking/dsh-memory-plugin`） |
| 共享模块在哪 | 真源 `cordis-plugins/memory-plugin-shared/lib`；`ov-memory/shared/` 是**生成副本**（提交进 git） |
| 改完一定要跑 | `npm run check && npm test`；动了 shared 还要 `node scripts/sync-shared.mjs` |
| 上游发新版怎么办 | `node scripts/sync-upstream.mjs`（它会重放本地化），然后 review `README.md` |
| 现在被加载了吗 | **没有**。任何 profile 都还没装它（见 §7 TODO-1） |
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
| `README.md` | 身份说明、Install 段、shared 说明、Upgrading 段 | **唯一不参与自动同步的文件**，见 §4.4 |

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

### 4.4 `README.md` 为什么不自动同步

它的本地改动是散在五处的**散文**（身份段、Install 段、shared 生成说明、Testing、Upgrading）。
为散文做替换表会在"上游恰好重写周边文本"的那次升级上崩掉。脚本的做法是：
不动它，并在输出里打印 `review by hand (localized): README.md`。

---

## 5. 已验证状态（2026-10-12）

| 检查 | 结果 |
|---|---|
| `npm run check` | `checked 80 modules`；`shared/ matches memory-plugin-shared/lib` |
| `npm test` | 98 tests / **97 pass / 0 fail** / 1 skip（`live-recall` opt-in 真机 E2E） |
| `node scripts/sync-upstream.mjs --check` | `in sync`（仅 `README.md` 标注为人工持有） |
| 上游幂等性 | 临时副本真跑同步后与当前树**零源码差异** |
| `npm pack --dry-run` | **41 files**（含 20 个 `shared/*.mjs`） |
| `path:` 安装仿真 | 只复制 `ov-memory/`（无姊妹目录）时 `index.mjs` / `servers/mcp-proxy.mjs` / `shared/*` / `runtime.mjs` 全部 import 成功 |
| 上游仓库 | `git status --porcelain` 为空，HEAD 未变 —— **从未被修改** |

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

---

## 7. 待办（下一步改造候选）

| # | 事项 | 状态 / 备注 |
|---|---|---|
| 1 | **真机验收**：把 `ov-memory` 装进 `web` profile，重启 DSH，验证 profile 注入 / 召回 / 采集 / 提交 / MCP 工具真的起来 | 未做。**重启 DSH 会终止当前会话**，必须使用者点头；可先只装不重启 |
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
