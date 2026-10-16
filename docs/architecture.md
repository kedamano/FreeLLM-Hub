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
- 仪表盘、服务商管理、模型目录、用量统计、设置页面

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
- SQLite + better-sqlite3
- 迁移脚本内置
- 凭证加密存储
- 调用日志与统计（`call_logs`）、供应商/模型目录（`providers`/`models`）、
  设置与配额（`settings`）、每日配额用量（`quota_tracking`）
- 熔断状态仅存内存：重启即给故障供应商一次新的机会，不落库

## 请求流程

```
客户端 -> /v1/chat/completions -> Gateway Auth
       -> Request Parsing -> Scheduler
       -> Candidate Filtering -> Model Scoring
       -> Provider Adapter -> Stream/Non-stream Response
       -> Usage Recording -> Response to Client
```

## 调度策略

1. 根据任务类型确定所需能力
2. 过滤出满足能力要求且可用的模型
3. 按免费程度、延迟、成功率评分
4. 检查熔断器、限流器、配额
5. 选择最高分模型执行
6. 失败时自动重试并切换模型
