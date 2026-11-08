# 过程播报插件

- [README](README.md) 说明产品与本地运行方式，[DESIGN](DESIGN.md) 维护会话入口与档位面板的设计约定。
- `index.js` 维护宿主端设置与播报行为。`client.js` 使用 Harness 插槽和配置表单读写设置，并在组件内管理手势预览。持久档位以宿主表单为准。
- UI 直接运行在 Harness 中。改动后核对插件实际加载的版本，按 DESIGN 检查受影响的主题和状态。
- 源码检查运行 `node --check client.js` 和 `node --check index.js`。档位交互回归运行 `node --test`。
