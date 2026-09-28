# jeeflow-panel

在 DSH Web GUI 的「**对话 / 轨迹**」tab 旁边再加一个「**工作流**」tab，里面用
`<iframe>` 内嵌远传页面：

```
https://abc.feg.cn/jeeflow/ui/       (jeeflow 工作流引擎)
```

## 它是怎么挂上去的

DSH 的会话 header 上的 tab 条是一个 slot：`conversation.view`（`kind: list`,
`scope: session`）。内置的两个 entry 是

| id | order | 来源 |
|----|-------|------|
| `chat` | `0` | `@deepseek-ai/dsh-client-ui-chat`（对话） |
| `trajectory` | `10` | `@deepseek-ai/dsh-client-ui-trajectory`（轨迹） |

tab 条本身是 `slots.entries("conversation.view")` 投影出来的，`label` 走
`resolveSlotLabel`（可以是字符串，也可以是返回字符串的函数），激活的 entry 由
`renderSlot("conversation.view", …, { only: active.id })` 渲染。

所以这个 bundle 只做一件事：往同一个 slot 里再注册一个 entry。

```js
ctx.slots.inject("conversation.view", () =>
  ctx.slots.register(
    {
      name: "conversation.view",
      id: "jeeflow",
      order: 20,               // chat = 0、trajectory = 10 → 排在轨迹右边
      locale: NS,              // 让视图拿到绑定好的 t()
      label: () => t("view.jeeflow"),
    },
    JeeflowView
  )
);
```

`inject: ["slots", "locale"]` 声明依赖；两处注册都包在 `ctx.effect` 里，卸载
插件时 tab 会一并消失。

## 两个实现细节

**1. iframe 是常驻单例，切 tab 不重新载入。**
`renderSlot(..., { only: active.id })` 只渲染当前激活的 entry，其余 entry 会
unmount。如果 iframe 直接写在 JSX 里，每次从「轨迹」切回「工作流」都会把整个
jeeflow 应用重新载入一遍（状态全丢）。

所以 iframe 只创建一次（模块级单例），挂载时用 `appendChild` 搬进视图里的
host div，卸载时搬回一个 `position:fixed; left:-20000px; visibility:hidden`
的 offscreen keeper。DOM 节点没被销毁，文档就一直活着。

**2. 高度。**
`wSkVaW_viewArea` 是 `flex:1; min-height:0` 的 flex column，父级
`scrollBody` 可滚动。iframe 在自动高度的 flex 项里 `height:100%` 会塌掉，
所以根容器给 `flex:1 1 auto; min-height:460px`、iframe 容器给
`min-height:320px` 保底。

## 安装

```sh
# 本地目录
dsh plugin --profile web add "link:C:/Users/shawoo/Desktop/feg.cn/cordis-plugins/jeeflow-panel"

# 或推到 GitHub 之后
dsh plugin --profile web add "github:wuzhiping/cordis-plugins#path:/jeeflow-panel"
```

`dsh plugin add` 会把 `jeeflow-panel` 写进 profile 的 `dependencies`，并因为
它声明了 `dsh.bundle.patch` 而自动加入 `dsh.profile.bundles` 层。

**加完之后需要重启 `dsh web`**（bundle 层在启动时合成）：

```sh
dsh web --host 127.0.0.1 --port 3080 --no-open
```

## 改配置

`lib/client.js` 顶部有一小段常量：

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `PANEL_URL` | `https://abc.feg.cn/jeeflow/ui/` | 要内嵌的远传页面 |
| `PANEL_TITLE` | `Jeeflow 工作流引擎` | iframe 的无障碍标题 |
| `VIEW_ID` | `jeeflow` | slot entry id；**每个 session 的 tab 选择按 id 持久化**，改了等于换一个 tab |
| `TAB_ORDER` | `20` | 排序，chat=0、trajectory=10 |
| `SLOW_MS` | `9000` | 超过这么久还没 `load` 就提示可能被挡 |

tab 文案在 `zh` / `en` 两个字典里（key `view.jeeflow`）。注册的是 `zh`，
`zhtw-traditional-chinese` 会在 zh-TW 下自动转成繁体。

## 已知限制

- **目标页面必须允许被 iframe 嵌入。** `https://abc.feg.cn/jeeflow/ui/` 目前
  没有 `X-Frame-Options`、也没有 CSP `frame-ancestors`，所以可以嵌。哪天加上
  了，tab 会变成空白（工具栏会给出提示），只能改用「另开新窗口」。
- iframe 是跨源的，DSH 读不到里面的 DOM，`reload` 靠重新赋值 `src`（赋同一个
  值也会触发导航）；`contentWindow.location.reload()` 跨源会抛异常，不能用。
- 这个 bundle 是纯前端插件，host 半边（`lib/index.js`）是空 stub，只为了让
  Loader 那一行能加载成功。

## 测试

```sh
node test/smoke.js
```

无依赖，用 stub 顶掉 `window.__ModuleLoader__` / `react` / `document`，校验
模块 id、`inject` 列表、注册出来的 entry 形状、渲染出的 DOM 结构、iframe 单例
的搬运行为，以及样式的安装 / 卸载。

## License

MIT
