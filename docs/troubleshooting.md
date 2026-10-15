# 疑难问题排查

## 应用启动问题

### 应用无法启动

1. 检查 Node.js 版本是否 >= 20
2. 运行 npm install 确保依赖完整
3. 检查 %APPDATA%\freellm-hub\logs\ 下的日志

### 白屏/渲染器空白

1. 开发模式检查 Vite 是否在 5173 端口运行
2. 检查 CSP 配置是否阻止了资源加载
3. 打开 DevTools 查看控制台错误

### IPC 通信失败

1. 确认 contextIsolation 为 true
2. 确认 preload 路径在 webPreferences 中正确设置
3. 检查通道名是否在白名单中

## Provider 连接问题

### Ollama 检测失败

1. 确认 Ollama 在运行：ollama serve
2. 检查 URL 默认 http://localhost:11434
3. 通过 UI 自定义配置页面修改 Base URL

### API Key 无效

1. 确认 Key 未过期
2. 确认服务商账户状态正常
3. 检查是否有区域限制

## 调度器问题

### 所有模型都不可用

1. 检查服务商是否已启用
2. 重置熔断器：调度器状态页面点击重置
3. 检查限流器是否触发（等待 retry-after 后重试）

## 数据库问题

### 数据库损坏

1. 关闭应用
2. 删除 %APPDATA%\freellm-hub\data\freellm-hub.db
3. 重新启动应用会自动重建

### 凭证无法解密

可能发生在切换用户或重装系统后：
1. 删除旧数据库
2. 重新配置所有凭证
