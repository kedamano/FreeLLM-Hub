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
- 路由用 HashRouter：同一个包既跑在 `file://` 的桌面窗口里，也跑在浏览器里，只有 hash 段在两种宿主下都能被前端改写
  （`src/renderer/src/lib/routes.ts` 把页面 id 与路径互转，未识别的页面重写回 `/`）
- 屏幕状态放在 URL 里（`src/renderer/src/hooks/useQueryParam.ts`）：`#/audit?request=…`、`#/providers?provider=…`、
  `#/models?q=…`、`#/usage?days=…` 都能直接分享、刷新后还原、被浏览器前进后退还原。写入一律 `replace`，
  且一个组件的所有 URL 改动都走同一个 patch 函数——react-router 的 `setSearchParams` 是整串替换而不是合并，
  同一次点击里两次独立写入会互相覆盖
- 请求 URL 一律由 `routeUrl()`（`src/shared/api-contract.ts`）拼装，查询串为空时不会留下多余的 `?`
- 服务商页面按面板拆分在 `src/renderer/src/pages/providers/`：页面只保留状态与请求，列表/配置/凭证/配额/弹窗各自渲染并回调，
  选中项与分组的同步靠 URL，删除供应商时要同时清掉 `provider` 和 `group`，否则列表展开的分组会和被选的供应商错位

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
- 内置服务商的模型清单、价格与每分钟限额集中在 `src/core/providers/catalog.ts`（16 个服务商 / 41 个模型），
  适配器由 `createStaticAdapter()` 按目录装配，`bootstrap.ts` 遍历目录注册——加服务商是加数据，不是加文件
- OpenAI 兼容适配器 (Groq, Google Gemini, Cloudflare Workers AI, HuggingFace, Cerebras,
  SiliconFlow, NVIDIA NIM, OpenRouter, ModelScope, SenseNova, LongCat, 智谱, Moonshot, DeepSeek,
  MiniMax, LM Studio)
- Ollama 本地适配器 (原生 API，唯一保留手写适配器的内置服务商)
- 用户自建自定义服务商（任意 OpenAI 兼容 Base URL）复用同一个装配函数
- 能力只写一次：`capabilities.supported` 是唯一事实，四个 `supportsX` 标志一律由
  `buildCapabilities()`（`src/shared/utils/capabilities.ts`）从它派生——目录、两个适配器兜底、
  SQLite 空值兜底都走这一个函数，因此调度器路由依据与模型页展示的徽章不可能再分叉
  （历史上 41 个模型里有 18 处分叉）；`tests/unit/model-capabilities.test.ts` 逐个断言这条不变量
- 适配器在请求路径上对传输错误保持沉默（返回缓存目录或空列表），所以手动「获取模型列表」拿到空结果时，
  `discoverProviderModels()` 会补一次 `validateCredential()` 探测：连不上就报 `success:false` 并带上原因，
  只有确实可达且目录为空才算成功——否则用户无法区分「服务没开」和「服务没模型」

### 6. Web 管理进程 (`npm run start:web`)
- 与桌面端共用 `src/main/services` 业务层，避免两套逻辑
- Fastify 提供 `/api/*` 管理 REST 接口，并直接托管 `dist/renderer` 静态产物
- 通道 ↔ REST 路由的映射只有一份：`src/shared/api-contract.ts` 的 `ADMIN_ROUTE_BINDINGS`
  声明每个 IPC 通道的 HTTP 方法与路径，web 模式的客户端只能用 `routeUrl()` 生成 URL；
  契约测试遍历全部通道注入请求，路径改名、方法写错、服务端漏注册都会当场 404/405 失败
- 同一进程内启动 OpenAI 兼容网关（默认 3001）
- 启动时载入每日配额并恢复当日用量，同时启动调用日志过期清理定时器
- 同一入口 `startServer()` 也挂在桌面程序的 `--web` 开关上（`src/main/web-mode.ts`）：
  Electron 主进程不建窗口直接服务，因而沿用桌面端数据目录与打包进应用的
  `better-sqlite3` Electron ABI；信号与退出路径先关闭服务再 `app.exit`

### 7. 数据存储
- SQLite + better-sqlite3，**版本化迁移**（`src/core/database/migrations.ts`，版本号写入 `PRAGMA user_version`）
- 凭证加密存储（Electron `safeStorage`，Web 模式回退到 AES-256-GCM + 本机会话密钥文件）
- 调用账本 `call_logs`（含 `profile_id`、`status_code`、`stream`、`attempt` 与三列成本）、
  审计 `request_audit` / `request_audit_events`、服务商与模型目录 `providers` / `models`、
  设置 `settings`（含配置档命名空间键）、按配置档隔离的 `quota_tracking`、
  配置档 `profiles`、OAuth 待完成流程 `oauth_flows`
- `quota_tracking` 按**增量**写入（`request_count = request_count + excluded…`），所以桌面端与
  `--web` 共用同一个库文件时用量是累加的，不会被后写入的一方用自己的快照覆盖；
  并发写由 WAL + `busy_timeout = 5000` 兜住
- 写入走 `src/usage/write-buffer.ts`：调用账本、审计行与审计事件先进队，攒到 64 条或
  200ms 后在**一个 `BEGIN IMMEDIATE` 事务**里落盘（一个请求原本要提交 8~12 次）。
  所有读入口通过 `readDatabase()` 先 drain，界面不会读到落后的数据；进程内退出路径
  （`app-lifecycle.ts` / `server/index.ts`）在 `closeDatabase()` 前显式 flush。
  入队时就把绑定值算好（配置档、时间戳），否则配置档切换与耗时请求会写错归属。
  配套的 pragma 是 `synchronous = NORMAL`（WAL 下省掉每次提交 fsync）与
  `journal_size_limit = 64MB`；被强杀时最多丢最近 200ms 的遥测写入，
  整批失败或单条失败会计入 `droppedWriteCount()` 并打一条 warning，不会静默丢数据
- 熔断与每分钟限流窗口仍是**每进程**内存态：跨进程共享的是当日配额（真正决定扣费的量），
  不是滑动窗口速率
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
- 流式响应只在**首帧**产出时才提交 `200` 响应头：首帧之前失败可以直接返回真实状态码与 JSON 错误，
  首帧之后才失败才只能"客户端看到 200 + SSE 错误帧"，审计记录同时保留两者
- 审计写入是尽力而为：任何一步失败都吞掉，绝不把正在服务的请求带下水
- 网关日志只有一个 pino 实例（`src/main/gateway/gateway-log.ts`）：Fastify 与网关的生命周期行共用它，
  由 `pino-roll` 按 `LOG_MAX_SIZE_MB` 轮转、`LOG_MAX_FILES` 限制保留份数。`log_retention_days` 清理的是
  数据行，磁盘上的日志文件靠这一层封顶；打包后的程序没有终端，生命周期日志也只有落到这个文件里才可查

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
