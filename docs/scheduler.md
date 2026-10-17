# 调度器设计规范

## 调度流程

```
请求进入 -> 任务类型识别 -> 候选模型过滤 -> 能力匹配检查
         -> 评分排序 -> 熔断器检查 -> 限流器检查 -> 配额检查
         -> 选择最优模型 -> Provider Adapter 调用 -> 成功返回
                                                       -> 失败: 熔断记录 + 重试下个模型
```

## 评分算法

总分 = 免费加分 + 速度加分 + 能力匹配加分 + 上下文窗口加分 + 成功率加分 - 成本惩罚

### 权重配置

| 维度 | 权重 | 说明 |
|------|------|------|
| freeBonus | 30 | 按 pricing.type 给分：local=1.0, free=0.9, freemium=0.5, paid=0.1 |
| speedBonus | 15 | 延迟<200ms满分，<500ms 70%，<1000ms 40% |
| capabilityMatch | 25 | 满足必需能力的比例 |
| contextWindow | 10 | >=128K满分，>=32K 60%，>=8K 30% |
| successRate | 15 | 历史成功率 |
| costPenalty | 5 | 付费模型双倍扣分 |

## 熔断器

- **Closed**: 正常服务，允许所有请求
- **Open**: 连续 `failureThreshold` 次失败后打开，拒绝所有请求
- **Half-Open**: 经过 `resetTimeoutMs` 后进入半开，允许探测请求

默认配置：
- failureThreshold: 5
- resetTimeoutMs: 60000
- halfOpenMaxRequests: 1

## 限流器

按 `providerId:modelId` 维护 60 秒滑动窗口，默认每分钟 30 次请求 / 100,000 token，
模型自带 `rateLimits` 时以其为上限。三个方法职责严格分开：

| 方法 | 是否占用窗口 | 用途 |
|------|--------------|------|
| `check()` | 否 | 排序候选时只探测，不消耗额度 |
| `acquire()` | 是 | 真正派发请求前预扣一次请求 + 预估 token |
| `rollback()` | 释放 | 派发失败（含流式未产出首字节即失败）时撤销预扣 |
| `record()` | 调整 | 请求结束后用真实 token 数校正预估偏差 |

排序阶段全部候选都被窗口挡住时抛 `RateLimitError`（携带 `retryAfterMs`），
网关据此返回 429 + `Retry-After`，而不是把限流伪装成 502。

## 每日配额

`provider-quota:<providerId>` 以 JSON 存在 settings 表，启动时由
`hydrateQuotasFromSettings()` 载入调度器，因此配额不会因重启失效。

- 配额按 **供应商** 统计，`record()` 同时写入模型桶和供应商桶；
  查找配置时优先模型级、否则回退供应商级。
- 当日用量写入 `quota_tracking` 表，重启后自动恢复，超限后调度器直接跳过该供应商。
- 所有候选都超配额时抛 `QuotaExceededError`（429 + `Retry-After: 3600`）。
- 上限校验范围：请求 0–10,000,000，token 0–1,000,000,000，`0`/留空表示不限制。

## 任务路由

不同任务类型有不同的服务商优先级（`task_type` 由网关请求体解析后透传，
未知取值按 `general` 处理）：

| 任务类型 | 优先服务商 | 必需能力 |
|---------|-----------|---------|
| general | ollama > local > groq > google-gemini > cloudflare | chat |
| coding | ollama > groq > google-gemini > cerebras > cloudflare | chat + streaming |
| analysis | ollama > groq > google-gemini > huggingface | chat + streaming |
| creative | ollama > groq > google-gemini > cloudflare | chat |
| summarization | cloudflare > groq > ollama > google-gemini | chat |
| classification | groq > ollama > cloudflare > google-gemini | chat + json-mode |
| extraction | groq > ollama > google-gemini > cloudflare | chat + json-mode |
| translation | cloudflare > groq > ollama > google-gemini | chat |
| lightweight | ollama > cloudflare > groq > google-gemini | chat |

## 重试策略

- 最大重试次数：3
- 基础延迟：1000ms
- 退避乘数：2 (指数退避)
- 最大延迟：30,000ms
- 单次上游尝试截止时间：由网关传入的 `timeoutMs`（`REQUEST_TIMEOUT_MS`，默认 60000，
  下限 1000 / 上限 900000），每次重试都重新计时；到点映射为 `TIMEOUT` / 504 并继续回退
- 可重试错误码：RATE_LIMITED, TIMEOUT, SERVER_ERROR, ALL_FAILED, NETWORK_ERROR

## 错误语义

调度器抛出的错误由网关映射为 OpenAI 兼容响应，失败日志会记录真正的供应商而不是
`unknown`：

| 错误码 | HTTP | 说明 |
|--------|------|------|
| RATE_LIMITED | 429 | 带 `Retry-After`，日志状态记为 `rate_limited` |
| QUOTA_EXCEEDED | 429 | 每日配额耗尽，`Retry-After: 3600` |
| AUTH_FAILED | 401 | 凭证无效 |
| MODEL_NOT_FOUND | 404 | 指定的模型不存在 |
| BAD_REQUEST / INVALID_REQUEST / CONTEXT_LENGTH_EXCEEDED | 400 | 请求本身不合法 |
| TIMEOUT | 504 | 上游超时 |
| ALL_FAILED / CIRCUIT_OPEN | 503 | 无可用供应商，`Retry-After: 30` |
| NETWORK_ERROR / SERVER_ERROR / 其他上游错误 | 502 | 上游故障 |

## 配置档作用域

每日配额、启用状态、Base URL 与服务商参数都按配置档读取（`profile:<id>:<key>`），
非默认档未覆盖的项继承默认档的值。切换配置档时 `applyProfileToRuntime` 会：

1. 用新档的键重放服务商覆盖（启用/停用、Base URL、参数）；
2. 清空再按新档重建配额上限——新档没有配配额的服务商会被显式 `clearConfig`，避免沿用上一档的上限；
3. 换绑 `quota_tracking` 的持久化作用域并重载该档的当日用量。

密钥与熔断状态不参与切换：前者按服务商共享，后者按设计只活一个进程周期。

## 调度轨迹（SchedulerTrace）

`execute` / `executeStream` / `selectModel` 接受可选的 `trace` 回调，把决策过程交出来：

- `candidate.skipped` + 原因（`disabled` / `circuit_open` / `rate_limited` / `quota_exceeded` / `no_adapter` / `rate_limit_slot_taken`）
- `candidate.selected` + 评分
- `attempt.start` / `attempt.success` / `attempt.failed`（含是否还会重试）
- 流式的 `stream.started` / `stream.first_token` / `stream.failed`

网关用它写 `request_audit_events`。回调缺席时调度行为完全不变；回调抛错会被吞掉——
审计永远不能影响路由结果。
