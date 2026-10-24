# Kaneo · API Key Run-As 实施方案（简化版 v2）

- 日期：2026-10-24
- 目标：instance admin 用 API Key 认证时，可加请求头 `x-run-as` 以**任意用户身份**调用 API / MCP
- 约束：**不建表、不做迁移**；只覆盖 API 调用与 MCP
- 状态：**仅设计，未执行**
- v1 → v2 的变化：去掉 `run_as_audit` 表（改为日志留痕）；去掉 `validateWorkspaceAccess` 的 3 个调用点改造（改为一行简化）；去掉 `openapi.ts` 的 context 变量

---

## 1. 语义

**精确扮演**：请求的权限 **完全等于**目标用户，不叠加执行者（admin）的 instance-admin 权力。

| 用法 | 结果 |
|---|---|
| 不带 `x-run-as` | 以 key owner 自己身份操作（现状不变） |
| `x-run-as: <userId 或 email>` | 以目标身份操作。目标是普通成员 → 你**失去**跨工作区 admin 权限；目标是另一个 admin → 你获得他的 admin 权限 |
| 目标不在某工作区 | 该工作区 404（对目标不可见），不会因执行者是 admin 而放行 |

为什么这样：run-as 的用途是"以某人的身份复现他的问题"。叠加语义做不到这件事。

---

## 2. 准入（四道闸）

| # | 条件 |
|---|---|
| 1 | **必须 API Key 认证**。session / cookie 请求**完全忽略**该 header |
| 2 | key owner 必须是 instance admin（**每次请求现读 DB 的 role**，不信任缓存） |
| 3 | 目标用户存在，且未被 ban |
| 4 | `RUN_AS_ENABLED` 开关（默认开启，`false` 可关） |

**Key 的 scope 仍是天花板**：`c.get("apiKey")` 保持不变 → `assertApiKeyScope` 照常生效。一把只读 scope 的 admin key 做 run-as 就只能读，正好当"只读排查"key 用。

---

## 3. 实现（4 个文件，其中 2 个只改 1~4 行）

### 3.1 新增 `apps/api/src/utils/run-as.ts`（约 55 行，唯一的新文件）

```ts
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";
import type { User } from "better-auth/types";
import db, { schema } from "../database";
import { publishEvent } from "../events";
import { hasInstanceAdminRole } from "./instance-admin-role";
import { isBanActive } from "./user-ban";

const RUN_AS_HEADERS = ["x-run-as", "x-kaneo-run-as"];

export function isRunAsEnabled() {
  return process.env.RUN_AS_ENABLED !== "false";
}

async function resolveTarget(identifier: string) {
  const [byId] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.id, identifier))
    .limit(1);
  if (byId) return byId;
  const [byEmail] = await db
    .select()
    .from(schema.userTable)
    .where(eq(schema.userTable.email, identifier.toLowerCase()))
    .limit(1);
  return byEmail ?? null;
}

/**
 * Swap the effective identity to the requested user.
 *
 * Only meaningful for API-key authenticated requests: the key owner must be an
 * instance administrator. The key's own permission scope stays in the context,
 * so it keeps acting as a ceiling.
 */
export async function applyRunAs(
  c: Context,
  actor: { actorUserId: string; actorApiKeyId: string },
): Promise<void> {
  const identifier = RUN_AS_HEADERS.map((h) => c.req.header(h)).find((v) => v?.trim())?.trim();
  if (!identifier) return;

  if (!isRunAsEnabled()) {
    throw new HTTPException(403, { message: "Run-as is not enabled on this instance" });
  }

  // The actor's role is read fresh: an administrator can be demoted after the
  // key was issued.
  const [actorRow] = await db
    .select({ id: schema.userTable.id, role: schema.userTable.role })
    .from(schema.userTable)
    .where(eq(schema.userTable.id, actor.actorUserId))
    .limit(1);
  if (!actorRow || !hasInstanceAdminRole(actorRow.role)) {
    throw new HTTPException(403, { message: "Run-as requires an instance administrator" });
  }

  const target = await resolveTarget(identifier);
  if (!target) {
    throw new HTTPException(404, { message: "Run-as target not found" });
  }
  if (isBanActive(target)) {
    throw new HTTPException(403, { message: "Run-as target is banned" });
  }

  // Every downstream permission check reads userId / user, so swapping them
  // here is enough to act as the target.
  c.set("userId", target.id);
  c.set("userEmail", target.email);
  c.set("user", target as User);
  c.header("x-kaneo-run-as", target.id);

  // Trail: container log (durable per deployment) + realtime event bus.
  console.log(
    `[run-as] actor=${actorRow.id} target=${target.id} method=${c.req.method} path=${c.req.path}`,
  );
  await publishEvent("run_as.used", {
    actorUserId: actorRow.id,
    actorApiKeyId: actor.actorApiKeyId,
    targetUserId: target.id,
    method: c.req.method,
    path: c.req.path,
  });
}
```

> **不建表的留痕方式**：`console.log` 落到容器日志（`docker logs` / Coolify 日志面板可查、可被日志系统采集），`publishEvent` 进现有事件总线。没有持久审计表——这符合"不建表"的约束，代价是**日志留存期取决于你的日志系统**。

### 3.2 `apps/api/src/utils/authenticate-api-request.ts`（+6 行）

`setApiKeyContext` 改成 async，在写完 context 后调用 run-as（`x-api-key` 与 `Authorization: Bearer` 两条路径都会经过它）：

```ts
async function setApiKeyContext(c: Context, apiKeyResult: VerifiedApiKey) {
  const key = apiKeyResult.key;
  c.set("userId", key.userId);
  c.set("userEmail", "");
  c.set("user", null);
  c.set("session", null);
  c.set("apiKey", {
    id: key.id,
    userId: key.userId,
    enabled: key.enabled,
    permissions: key.permissions,
  });
  setRateLimitHeaders(c, apiKeyResult.rateLimit);
  attachUserToScope(key.userId);
  // Run-as: act as another user (instance administrators only).
  await applyRunAs(c, { actorUserId: key.userId, actorApiKeyId: key.id });
}
```

两处调用点加 `await`：`setApiKeyContext(c, apiKeyResult)` → `await setApiKeyContext(...)`。

`resolveAssetBearerOrCookie()`（asset 路由 `/api/asset/{id}` 用，它会自己重新解析一遍身份）里的 API key 分支同样要加：

```ts
if (apiKeyResult?.status === "valid") {
  await applyRunAs(c, {
    actorUserId: apiKeyResult.key.userId,
    actorApiKeyId: apiKeyResult.key.id,
  });
  return { userId: c.get("userId"), apiKeyId: apiKeyResult.key.id };
}
```

否则 asset 下载会绕过 run-as（它重新解析后拿到的是 key owner）。

### 3.3 `apps/api/src/utils/validate-workspace-access.ts`（改 1 处，**调用点全不动**）

现在这段：

```ts
if (apiKeyId) {
  const apiKey = await db.select().from(schema.apikeyTable).where(and(
    eq(schema.apikeyTable.id, apiKeyId),
    or(eq(schema.apikeyTable.referenceId, userId), eq(schema.apikeyTable.userId, userId)),
    eq(schema.apikeyTable.enabled, true),
  )).limit(1);
  if (apiKey.length === 0) throw new HTTPException(403, { message: "Invalid API key for this workspace" });
}
```

其中 `or(eq(referenceId, userId), eq(userId, userId))` 是拿 **effective userId** 去比 key 的归属。run-as 后 effective user 是目标、key 属于执行者 → **必然 403**。

但这个归属比较在正常流程里是**恒真**的（`apiKeyId` 与 `userId` 都来自同一个已验证的 context），真正的校验早在 `verifyApiKey` 里做过了（enabled / 未过期 / owner 未被 ban）。所以**直接去掉归属比较**即可，3 个调用点（`workspace-access-middleware.ts:157`、`authorize-asset-access.ts:29`、`project/index.ts:401`）**一行都不用改**：

```ts
if (apiKeyId) {
  // The key was already verified during authentication (enabled, owner not
  // banned). Its owner is not compared to the effective user: with run-as the
  // effective user is the target while the key belongs to the actor.
  const [apiKey] = await db
    .select({ id: schema.apikeyTable.id })
    .from(schema.apikeyTable)
    .where(and(
      eq(schema.apikeyTable.id, apiKeyId),
      eq(schema.apikeyTable.enabled, true),
    ))
    .limit(1);
  if (!apiKey) {
    throw new HTTPException(403, { message: "Invalid API key for this workspace" });
  }
}
```

### 3.4 `apps/api/src/mcp/index.ts`（+5 行）

`/api/mcp` 不走全局 `authenticateApiRequest`（`index.ts:797` 明确排除），认证在 `validateBearerToken`。上一轮已加的 API key 分支里补一次调用：

```ts
if (process.env.MCP_ALLOW_API_KEY !== "false") {
  const result = await verifyApiKey(token);
  if (result?.status === "valid") {
    await applyRunAs(c, {
      actorUserId: result.key.userId,
      actorApiKeyId: result.key.id,
    });
    // effective user may now be the run-as target
    return { userId: c.get("userId"), token };
  }
}
```

`validateBearerToken` 目前返回 `{ userId, token }`，其中 `userId` 要改成 `c.get("userId")`（run-as 后是目标），`token` 仍是 API key（下游 REST 用它做 Bearer，`authenticateApiRequest` 会先当 key 验 → 成功）。

### 3.5 配置与文档（各 1~2 行）

| 文件 | 改动 |
|---|---|
| `.env.sample` | `# RUN_AS_ENABLED=true` + 一行注释 |
| `apps/docs/core/installation/environment-variables.mdx` | Authentication 表加一行 |
| `apps/docs/api-reference/authentication.mdx` | 新增小节：用法 + 限制 |

---

## 4. 改动量汇总

| 文件 | 类型 | 量 |
|---|---|---|
| `apps/api/src/utils/run-as.ts` | **新增** | ~55 行 |
| `apps/api/src/utils/authenticate-api-request.ts` | 修改 | +6 行（含 2 处 `await`） |
| `apps/api/src/utils/validate-workspace-access.ts` | 修改 | 换 1 段（**调用点 0 改动**） |
| `apps/api/src/mcp/index.ts` | 修改 | +5 行 |
| `.env.sample` + 2 个 docs | 修改 | 各 1~2 行 |
| `tests/api-integration/run-as.test.ts` | **新增** | ~7 个用例 |

**无 schema 变更、无迁移、无前端改动。**

---

## 5. 行为矩阵

| 请求 | 结果 |
|---|---|
| API key（非 admin）+ `x-run-as` | 403 |
| API key（admin）+ `x-run-as: 有效目标` | 200，以目标身份；响应头 `x-kaneo-run-as: <targetId>` |
| API key（admin）+ `x-run-as: 不存在` | 404 |
| API key（admin）+ `x-run-as: 被 ban` | 403 |
| API key（admin）+ `x-run-as`，`RUN_AS_ENABLED=false` | 403 |
| **session / cookie** + `x-run-as` | **忽略 header**，仍是自己（不报错） |
| API key（带 scope）+ `x-run-as` | 读 200；写 403 `API_KEY_SCOPE`（scope 仍是天花板） |
| 目标不是某工作区成员 | 该工作区 404（不回退成 admin 放行） |
| 目标是另一个 instance admin | 200 且拥有 admin 权限（精确扮演） |
| `/api/admin/*`、`/api/billing/*` | 403 `SESSION_REQUIRED`（`requireUserSession` 见到 apiKey 就拒） |
| `/api/ws/*` | **自动支持**（WS 握手也走 `authenticateApiRequest`）；浏览器 `new WebSocket()` 不能设 header，故浏览器端用不了 |

---

## 6. 与 v1 的差异（为什么能变简单）

| v1 | v2 | 原因 |
|---|---|---|
| 新建 `run_as_audit` 表 + 迁移 | `console.log` + `publishEvent` | 不建表 |
| `validateWorkspaceAccess` 加 `apiKeyOwnerUserId` 选项 + 3 个调用点传参 | 去掉恒真的归属比较 | 调用点 0 改动 |
| `BaseVariables` 加 `runAs` 上下文变量 | 不加 | actor 只在 `applyRunAs` 内部用得到 |
| 独立的 `resolveAssetBearerOrCookie` 重构 | 只在它的 key 分支加一次 `applyRunAs` | 最小改动 |

---

## 7. 风险

| 风险 | 说明 / 缓解 |
|---|---|
| **key 泄露 = 任意用户数据可读** | run-as 让持有 admin key 的人能读任何用户的私有内容（评论、通知、私有项目、附件）。缓解：① 专用 key ② 用只读 scope 的 key ③ 定期轮换 ④ `RUN_AS_ENABLED=false` 一键关 |
| 留痕不是审计表 | 只有容器日志 + 内存事件总线；日志留存期由你的日志系统决定。要长期留痕就把 `console.log` 换成写日志服务 |
| 业务活动被记成目标用户 | 任务评论/通知的 `createdBy` 是目标，不是执行者。排查"谁改的"要看日志，不能看活动流 |
| session 请求静默忽略 header | 调用方可能误以为生效 → 响应头 `x-kaneo-run-as` 只在 run-as 真正生效时出现，可据此判断 |
| scope 被误以为能绕过 | `c.get("apiKey")` 保留，`assertApiKeyScope` 照常 |

---

## 8. 测试（`tests/api-integration/run-as.test.ts`，7 个用例）

| # | 场景 | 期望 |
|---|---|---|
| 1 | 非 admin 的 key + `x-run-as` | 403 |
| 2 | admin 的 key + `x-run-as: <email>` | 200，`/api/user/me` 返回目标用户 |
| 3 | admin 的 key + `x-run-as: <userId>` | 200，同上 |
| 4 | admin 的 key + `x-run-as: 不存在` | 404 |
| 5 | **session 认证 + `x-run-as`** | **忽略 header**，仍是 session 用户 |
| 6 | admin key（scope `{task:["read"]}`）+ `x-run-as` | 读 200、写 403 `API_KEY_SCOPE` |
| 7 | 目标用户不是某工作区成员 | 该工作区 404（验证 §3.3 的简化生效） |

第 7 条是最容易写错的一条：它验证"归属比较去掉后，成员关系检查仍然按**目标**用户走"。

---

## 9. 落地顺序

1. `run-as.ts` 新模块。
2. `authenticate-api-request.ts`（2 处接入 + `setApiKeyContext` 改 async）。
3. `validate-workspace-access.ts` 简化归属比较。
4. `mcp/index.ts` 接入。
5. `.env.sample` + docs。
6. 测试跑通 → 部署（**无需迁移**）。

回滚：`RUN_AS_ENABLED=false` 立即全站失效（读 env，不需重启）。

---

## 10. 一句话结论

**在 API Key 认证成功的分支后调用一次 `applyRunAs(c, actor)`**：读 `x-run-as` → 校验"key owner 是 instance admin + 目标存在未 ban" → 把 `c.set("userId"/"user")` 换成目标 → 下游权限检查自动跟随。**唯一必须连带改的是 `validateWorkspaceAccess` 里那条恒真的 key 归属比较**（去掉它，3 个调用点零改动）。留痕用日志 + 事件总线，不建表。共 1 个新文件 + 3 个文件小改 + 1 个测试文件。
