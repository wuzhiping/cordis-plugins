# windows 安装 Cua

```powershell
# 安装
irm https://cua.ai/driver/install.ps1 | iex

# 启动
cua-driver autostart kick

# 验证状态
cua-driver status

# 停止
cua-driver stop

```

# opencode 连接 Cua Driver

1. 生成 opencode 对应 mcp 配置
```powershell
cua-driver mcp-config --client opencode
```
2. opencode 添加 mcp 配置

- 将 JSON 粘贴到~/.config/opencode/opencode.json 中
- 启动 opencode 并确认 cua-driver 出现在 MCP 服务器列表中

3. opencode 测试

