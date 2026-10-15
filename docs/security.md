# 安全规范

## 凭证存储

**原则**: 绝不以明文形式存储任何 API Key 或 Token。

### 存储机制

1. 使用 Electron `safeStorage` API
2. 底层使用 Windows DPAPI (Data Protection API)
3. 加密后的数据存储在 SQLite `credentials` 表
4. 每个用户/机器独立加密，跨机器无法解密

### 存储位置

加密数据存储在：`%APPDATA%\freellm-hub\data\freellm-hub.db`

DB 不被提交到 `.gitignore` 覆盖的路径之外。

## Electron 安全

### 渲染进程隔离

```
contextIsolation: true     // 渲染进程与 preload 隔离
nodeIntegration: false     // 渲染进程不能访问 Node.js API
sandbox: true              // 预加载脚本沙箱化
webSecurity: true          // 启用 web 安全策略
allowRunningInsecureContent: false
```

### Content Security Policy

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self';" />
```

### Preload 桥接

仅在 `preload/index.ts` 中通过 `contextBridge.exposeInMainWorld` 暴露必要 API，不暴露完整 ipcRenderer。

## IPC 安全

### 通道白名单

通过 `isAllowedChannel()` 验证所有 IPC 通道，未注册的通道拒绝处理。

### 输入验证

1. 类型校验（TypeScript 编译时 + 运行时 Zod 校验）
2. 长度限制（字符串最大 10000 字符）
3. 数组元素限制（最大 1000 个）
4. 对象属性名最大 256 字符
5. 数字值必须有限（排除 NaN, Infinity）

## 日志脱敏

所有日志输出经过 `redactSecrets()` 处理，匹配以下模式会被替换为 `****`：

- `Bearer <token>`
- `api_key: <key>`
- `token: <value>`
- `sk-...` 格式
- `Authorization: Bearing <token>`

## 凭证生命周期

| 状态 | 说明 | UI 显示 |
|------|------|---------|
| unconfigured | 未配置 | 黄色 "未配置" 标签 |
| configured | 已存储 | 绿色 "已配置" 标签 |
| valid | 验证可用 | 连接成功 |
| invalid | 验证失败 | 红色 "无效" 标签 |
| expired | 凭证过期 | 红色 "已过期" 标签 |

## 数据隔离

- 不同服务商凭证独立存储
- 删除服务商不影响其他凭证
- 应用退出时自动清理内存中的敏感数据
