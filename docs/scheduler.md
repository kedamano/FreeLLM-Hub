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

基于滑动窗口的令牌桶：
- 每分钟最大请求数：30
- 每分钟最大 token 数：100,000

## 任务路由

不同任务类型有不同的服务商优先级：

| 任务类型 | 优先服务商 | 必需能力 |
|---------|-----------|---------|
| general | ollama > groq > gemini > cloudflare | chat |
| coding | ollama > groq > gemini > cerebras | chat + streaming |
| analysis | ollama > groq > gemini > hf | chat + streaming |
| creative | ollama > groq > gemini > cloudflare | chat |
| classification | groq > ollama > cloudflare > gemini | chat + json-mode |
| lightweight | ollama > cloudflare > groq > hf | chat |

## 重试策略

- 最大重试次数：3
- 基础延迟：1000ms
- 退避乘数：2 (指数退避)
- 最大延迟：30,000ms
- 可重试错误码：RATE_LIMITED, TIMEOUT, SERVER_ERROR, ALL_FAILED
