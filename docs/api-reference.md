# FreeLLM Hub API Reference

## Gateway API (OpenAI Compatible)

网关默认监听 `127.0.0.1` 上的动态分配端口。实际端口通过 IPC `gateway:port` 获取。

### 聊天补全

```
POST /v1/chat/completions
Content-Type: application/json
Authorization: Bearer <token> (可选)
```

#### 请求体

```json
{
  "model": "可选，如不指定则由调度器自动选择",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "max_tokens": 1024,
  "temperature": 0.7,
  "stream": false,
  "tools": [],
  "response_format": { "type": "json_object" }
}
```

#### 非流式响应 (200)

```json
{
  "id": "req_...",
  "object": "chat.completion",
  "created": 1700000000,
  "model": "llama-3.3-70b-versatile",
  "provider": "groq",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "response text",
        "finish_reason": "stop"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 50,
    "total_tokens": 70
  }
}
```

#### 流式响应 (SSE)

```
data: {"id":"req_...","object":"chat.completion.chunk","created":1700000000,"model":"...","provider":"...","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"req_...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":50,"total_tokens":70}}

data: [DONE]
```

#### 错误响应

```json
{
  "error": {
    "message": "No available providers",
    "type": "no_providers_available",
    "code": "ALL_FAILED"
  }
}
```

### 模型列表

```
GET /v1/models
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "llama-3.3-70b-versatile",
      "object": "model",
      "created": 1700000000,
      "owned_by": "groq",
      "provider": "groq"
    }
  ]
}
```

### 健康检查

```
GET /health
```

```json
{
  "status": "ok",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "version": "0.1.0"
}
```

## IPC API (Renderer <-> Main)

通道白名单验证机制保障 IPC 安全。

### Provider 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `providers:list` | - | ProviderInfo[] | 列出所有服务商 |
| `providers:get` | providerId | ProviderInfo | 获取单个服务商 |
| `providers:test` | providerId | {success, error?} | 测试连接 |
| `providers:set-credential` | (id, credential) | {success} | 保存凭证 |
| `providers:remove-credential` | providerId | {success} | 删除凭证 |
| `providers:toggle` | (id, enabled) | {success} | 启用/禁用 |

### Model 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `models:list` | - | ModelInfo[] | 列出所有可用模型 |
| `models:get` | (providerId, modelId) | ModelInfo | 获取模型详情 |
| `models:discover` | - | DiscoveryResult[] | 触发模型发现 |
| `models:refresh` | - | RefreshResult[] | 刷新模型列表 |

### Scheduler 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `scheduler:status` | - | {providers: [...]} | 调度器状态 |
| `scheduler:reset-circuit` | providerId | {success} | 重置熔断器 |
| `scheduler:reset-all-circuits` | - | {success} | 重置所有熔断器 |

### Settings 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `settings:get` | key | string\|null | 获取设置 |
| `settings:set` | (key, value) | {success} | 保存设置 |
| `settings:get-all` | - | Record<string, string> | 获取所有设置 |

### Usage 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `usage:dashboard` | - | DashboardStats | 仪表盘数据 |
| `usage:provider-stats` | providerId | ProviderUsageStat | 服务商统计 |
| `usage:daily-stats` | days? | DailyStat[] | 每日统计 |
| `usage:recent-calls` | limit? | CallLog[] | 最近调用 |

### App 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `app:version` | - | string | 应用版本 |
| `app:data-path` | - | string | 数据目录路径 |
