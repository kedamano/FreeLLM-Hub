# FreeLLM Hub API Reference

应用有两种运行形态，共享同一套 `src/main/services` 业务逻辑：

| 形态 | 启动方式 | 管理界面 | OpenAI 兼容网关 |
|------|----------|----------|-----------------|
| Electron 桌面端 | `npm run dev` | 桌面窗口 | 动态端口，经 `gateway:getStatus` 获取 |
| Web 管理端 | `npm run start:web` | `http://127.0.0.1:3000` | `http://127.0.0.1:3001/v1` |

## Gateway API (OpenAI Compatible)

桌面端网关监听 `127.0.0.1` 上的动态分配端口，实际端口通过 IPC `gateway:getStatus`
或管理端 REST `GET /api/gateway/status` 获取；Web 模式默认固定为 3001。

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
  "task_type": "coding",
  "tools": [],
  "response_format": { "type": "json_object" }
}
```

`task_type` 可选，取值 `general` / `coding` / `analysis` / `creative` /
`summarization` / `classification` / `extraction` / `translation` / `lightweight`，
用于能力过滤和优先级路由；未传时回落到设置项 `default_task_type`，
无法识别的取值按 `general` 处理（不会因此报错）。

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

| HTTP | `error.code` | `error.type` | 附带响应头 |
|------|--------------|--------------|-----------|
| 400 | `BAD_REQUEST` / `INVALID_REQUEST` / `CONTEXT_LENGTH_EXCEEDED` | `invalid_request` | |
| 401 | `AUTH_FAILED` | `auth_error` | |
| 404 | `MODEL_NOT_FOUND` | `model_not_found` | |
| 429 | `RATE_LIMITED` | `rate_limited` | `Retry-After`（窗口剩余秒数） |
| 429 | `QUOTA_EXCEEDED` | `quota_exceeded` | `Retry-After: 3600` |
| 503 | `ALL_FAILED` | `no_providers_available` | |
| 503 | `CIRCUIT_OPEN` | `no_providers_available` | `Retry-After: 30` |
| 504 | `TIMEOUT` | `timeout` | |
| 502 | `NETWORK_ERROR` / `SERVER_ERROR` / 其他上游错误 | `upstream_error` | |

流式请求在已产出首字节后失败时不会重放，只在 SSE 中输出上述错误对象并终止
（没有 `data: [DONE]`）。日志与凭证只以掩码形式出现。

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

## Web 管理端 REST API

`npm run start:web` 时在 `http://127.0.0.1:3000` 提供，与桌面端 IPC 一一对应，
返回体统一为 `{ success, error?, ...}` 或直接是数据。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/app/version` / `/api/app/data-path` | 版本与数据目录 |
| GET | `/api/providers` | 供应商列表（含 `quota`、`quotaRemaining`） |
| GET | `/api/providers/:id` | 单个供应商详情 |
| POST | `/api/providers/:id/test` | 连通性测试 |
| POST/DELETE/GET | `/api/providers/:id/credential` | 主凭证读写与删除 |
| GET/POST/DELETE | `/api/providers/:id/credentials[/:index]` | 多密钥槽位（最多 5 个） |
| POST | `/api/providers/custom`、DELETE `/api/providers/:id` | 自定义供应商增删 |
| POST | `/api/providers/:id/toggle` | 启用/禁用 |
| PUT | `/api/providers/:id/base-url` | 单独修改 Base URL |
| PUT | `/api/providers/:id/config` | 同时修改 Base URL 与 `settings`（如 Cloudflare `accountId`） |
| PUT | `/api/providers/:id/quota` | 设置每日配额，`0`/留空表示取消限制 |
| POST/GET | `/api/providers/:id/discover-models`、`/api/providers/:id/models` | 模型发现与列表 |
| GET/POST | `/api/models`、`/api/models/discover`、`/api/models/refresh` | 全量模型 |
| GET | `/api/usage/summary`、`/api/usage/timeseries`、`/api/usage/providers/:id`、`/api/usage/recent` | 用量统计 |
| GET/PUT | `/api/settings[/:key]` | 设置读写（凭证与网关密钥为保留前缀，不可写） |
| GET/POST | `/api/scheduler/status`、`/api/scheduler/reset-circuit`、`/api/scheduler/reset-all-circuits` | 调度器状态与熔断复位 |
| GET/POST/PUT | `/api/gateway/status`、`/api/gateway/token`、`/api/gateway/generate-token`、`/api/gateway/config` | 网关状态、密钥与监听配置 |

## IPC API (Renderer <-> Main)

通道白名单由 `src/shared/ipc-channels.ts` 单一定义生成，主进程守卫直接读取该数组。

### Provider 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `providers:list` | - | ProviderInfo[] | 列出所有服务商（含配额与剩余量） |
| `providers:get` | providerId | ProviderInfo | 获取单个服务商 |
| `providers:test` | providerId | {success, error?} | 测试连接 |
| `providers:set-credential` | (id, credential) | {success, error?} | 保存主凭证 |
| `providers:get-credential` | (id, index?) | {credential\|null} | 取回明文凭证（仅本机） |
| `providers:list-credentials` | providerId | {credentials[]} | 掩码后的密钥槽位 |
| `providers:add-credential` | (id, credential) | {success, credentials?} | 追加备用密钥 |
| `providers:remove-credential-slot` | (id, index) | {success, credentials?} | 删除指定槽位 |
| `providers:remove-credential` | providerId | {success} | 清空该服务商全部凭证 |
| `providers:toggle` | (id, enabled) | {success} | 启用/禁用 |
| `providers:update-baseurl` | (id, baseUrl) | {success, error?} | 修改 Base URL |
| `providers:update-config` | (id, {baseUrl?, settings?}) | {success, error?} | 一次写入地址与附加字段 |
| `providers:set-quota` | (id, {maxRequestsPerDay?, maxTokensPerDay?}) | {success, quota?, error?} | 设置每日配额 |
| `providers:discover-models` | providerId | {success, models?, error?} | 拉取该服务商模型 |
| `providers:get-models` | providerId | ModelInfo[] | 读取已入库模型 |
| `providers:create-custom` | {name, baseUrl, apiKey?} | {success, providerId?, error?} | 新建自定义服务商 |
| `providers:delete-custom` | providerId | {success, error?} | 删除自定义服务商 |

### Model 通道

| 通道 | 参数 | 返回 | 说明 |
|------|------|------|------|
| `models:list` | - | ModelInfo[] | 列出所有可用模型 |
| `models:get` | (providerId, modelId) | ModelInfo | 获取模型详情 |
| `models:discover` | - | ProviderModel[] | 触发模型发现 |
| `models:refresh` | - | ProviderModel[] | 刷新模型列表 |

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

## 配置档（Profile）

| IPC 通道 | Web REST | 说明 |
| --- | --- | --- |
| `profiles:list` | `GET /api/profiles` | 全部配置档 + 各自统计（启用数、配额数、请求/Token/成本） |
| `profiles:active` | `GET /api/profiles/active` | 当前生效的配置档 |
| `profiles:get` | `GET /api/profiles/:id` | 单个配置档 |
| `profiles:create` | `POST /api/profiles` | 新建，可 `copyFrom` 复制现有池 |
| `profiles:update` | `PUT /api/profiles/:id` | 重命名 / 改描述 |
| `profiles:delete` | `DELETE /api/profiles/:id` | 删除（默认档与生效中的档不可删） |
| `profiles:switch` | `POST /api/profiles/:id/activate` | 切换并即时重放到调度器 |
| `profiles:duplicate` | `POST /api/profiles/duplicate` | 覆盖到另一个档 |
| `profiles:reset-pool` | `POST /api/profiles/:id/reset-pool` | 清空该档覆盖，回到继承状态 |

## 成本与额度

| IPC 通道 | Web REST | 说明 |
| --- | --- | --- |
| `usage:cost-summary` | `GET /api/usage/cost?days=30&profileId=` | 成本台账：实际/基准/节省、按服务商/模型/任务类型、按天序列 |
| `usage:quota-usage` | `GET /api/usage/quota` | 每个服务商的每日额度上限、已用、剩余与今日成本 |
| `usage:daily-by-provider` | `GET /api/usage/timeseries-by-provider?days=14` | 堆叠趋势的 (日期, 服务商) 明细 |

成本三列写在 `call_logs`：`cost_usd`（服务商实际收取）、`reference_cost_usd`（按基准价折算）、
`saved_cost_usd`（两者之差，不小于 0）。基准价是可编辑设置 `cost_reference_price`
（`{label,currency,inputPer1M,outputPer1M}`），汇率覆盖设置 `currency_rates`。

## 请求审计

| IPC 通道 | Web REST | 说明 |
| --- | --- | --- |
| `usage:audit-list` | `GET /api/audit/requests` 或 `POST /api/audit/list` | 过滤 + 分页：`status/providerId/modelId/requestId/profileId/from/to/failuresOnly/search/limit/offset` |
| `usage:audit-detail` | `GET /api/audit/requests/:requestId` | 单请求的审计行 + 有序决策轨迹 |
| `usage:audit-summary` | `GET /api/audit/summary?days=7` | 成功率、P50/P95、首字节均值、Top 错误、按服务商与按天分布 |

网关响应头 `X-Request-Id` 与审计主键一致；若客户端自带合法的 `X-Request-Id`（≤64 字符，
仅 `[A-Za-z0-9_.:-]`）会被复用，否则由服务端生成，畸形值一律丢弃重写。

## OAuth

| IPC 通道 | Web REST | 说明 |
| --- | --- | --- |
| `providers:configure-oauth` | `POST /api/providers/:id/oauth` | 写入授权/令牌端点、Client ID、scopes、可选 Client Secret |
| `oauth:start` | `POST /api/oauth/:providerId/authorize` | 发起授权码 + PKCE，返回授权 URL 并尝试打开浏览器 |
| `oauth:status` | `GET /api/oauth/flows/:state` | 流程状态 + 当前令牌快照（不含令牌值） |
| `oauth:cancel` | `POST /api/oauth/flows/:state/cancel` | 取消并关闭回调端口 |
| `oauth:refresh` | `POST /api/oauth/:providerId/refresh` | 立即刷新一次 |
| `oauth:unlink` | `DELETE /api/oauth/:providerId` | 清除令牌与 Client Secret |
