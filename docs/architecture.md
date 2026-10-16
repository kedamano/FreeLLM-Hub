# FreeLLM Hub 架构设计

## 系统分层

### 1. Electron 主进程
- 应用生命周期管理
- 本地 API 网关 (Fastify Server)
- SQLite 初始化与迁移
- 安全凭证存储 (Windows DPAPI)
- IPC 通信枢纽
- Windows 托盘与退出行为

### 2. Renderer 前端
- React + Vite 单页应用
- Tailwind CSS 样式
- 仪表盘、服务商管理、模型目录、用量与成本、请求审计、配置档、设置页面
- recharts 承担成本/额度趋势图；渲染层只从 `src/shared/types` 取契约类型

### 3. Local Gateway
- 统一 OpenAI 兼容 API (`/v1/chat/completions`)
- 请求解析与标准化
- 调度器调用
- 流式响应支持
- 失败处理与自动切换

### 4. Scheduler
- 候选模型过滤
- 模型评分与排名
- 熔断器 (Circuit Breaker)
- 限流器 (Rate Limiter)
- 配额管理 (Quota Manager)
- 重试策略与故障切换

### 5. Provider Adapters
- OpenAI 兼容适配器 (Groq, Cloudflare, HuggingFace, Cerebras, SiliconFlow, NVIDIA NIM, OpenRouter, ModelScope, SenseNova, LongCat, 智谱, Moonshot, DeepSeek, MiniMax)
- Google Gemini 适配器
- Ollama 本地适配器 (原生 API)
- LM Studio 适配器 (OpenAI 兼容)
- 用户自建自定义服务商（任意 OpenAI 兼容 Base URL）

### 6. Web 管理进程 (`npm run start:web`)
- 与桌面端共用 `src/main/services` 业务层，避免两套逻辑
- Fastify 提供 `/api/*` 管理 REST 接口，并直接托管 `dist/renderer` 静态产物
- 同一进程内启动 OpenAI 兼容网关（默认 3001）
- 启动时载入每日配额并恢复当日用量，同时启动调用日志过期清理定时器

### 7. 数据存储
- SQLite + better-sqlite3，**版本化迁移**（`src/core/database/migrations.ts`，版本号写入 `PRAGMA user_version`）
- 凭证加密存储（Electron `safeStorage`，Web 模式回退到 AES-256-GCM + 本机会话密钥文件）
- 调用账本 `call_logs`（含 `profile_id`、`status_code`、`stream`、`attempt` 与三列成本）、
  审计 `request_audit` / `request_audit_events`、服务商与模型目录 `providers` / `models`、
  设置 `settings`（含配置档命名空间键）、按配置档隔离的 `quota_tracking`、
  配置档 `profiles`、OAuth 待完成流程 `oauth_flows`
- 熔断状态仅存内存：重启即给故障供应商一次新的机会，不落库

### 8. 配置档（profiles）
- 一个配置档 = 一份"这个项目能用哪些免费池"的覆盖集：启用状态、Base URL / 参数、每日额度
- 物理上仍是 `settings` 表的键，只是加了 `profile:<id>:` 前缀；`default` 档继续用历史裸键，老库无需搬迁
- 非默认档读取顺序：**自己的键 → 默认档的键**，因此删除一个覆盖项就是"恢复继承"
- 全局共享的部分不随档切换：API 密钥、模型目录、网关配置、界面偏好
- 每日用量按档隔离（`quota_tracking.profile_id` 已进入主键），切换时重放覆盖并热重建调度器状态

### 9. 请求审计与可观测性
- Fastify 在 `genReqId` 阶段就确定 `request_id`（优先复用客户端的 `X-Request-Id`，做长度与字符集收敛），
  因此 auth 钩子、路由、`call_logs`、`request_audit`、pino 日志行说的是同一个请求
- 调度器通过可选的 `SchedulerTrace` 回调把「候选被跳过的原因、第几次尝试、是否还会重试」交给网关写入事件表
- 被挡在路由之外的流量（缺令牌 401、令牌无效 403、空 messages 400、未知路由 404、body 过大等）也会落审计行
- 流式响应在写响应头后无法改状态码，因此审计记录同时保留"客户端看到的 200"和"真实结果"
- 审计写入是尽力而为：任何一步失败都吞掉，绝不把正在服务的请求带下水

## 请求流程

```
客户端 -> /v1/chat/completions -> request_id (genReqId)
       -> Gateway Auth（失败也写审计）
       -> Request Parsing + beginRequestAudit
       -> Scheduler(trace=审计事件)
            -> Candidate Filtering -> Model Scoring
            -> 熔断/限流/配额检查（跳过原因落事件表）
       -> Provider Adapter（OAuth 服务商先确保令牌有效，401 触发一次强制刷新）
       -> Stream / Non-stream Response
       -> recordCall(账本) + completeRequestAudit(审计)
       -> Response to Client（带 X-Request-Id）
```

## 调度策略

1. 根据任务类型确定所需能力
2. 过滤出满足能力要求且可用的模型
3. 按免费程度、延迟、成功率评分
4. 检查熔断器、限流器、配额
5. 选择最高分模型执行
6. 失败时自动重试并切换模型
