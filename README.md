# FreeLLM Hub

本地优先的 Windows 桌面大模型聚合、统一 API 接入、免费额度管理和智能调度平台。

## 产品定位

FreeLLM Hub 是你的个人 AI 推理资源管理中心。它聚合了多个官方免费大模型 API，支持本地开源模型接入，并通过智能调度系统自动选择最合适的模型来处理你的请求。

## 核心能力

- **免费模型聚合**：内置 17 家服务商，覆盖本地 Ollama / LM Studio 与 15 家提供免费额度的官方 API（Groq、Google Gemini、Cloudflare Workers AI、Hugging Face、Cerebras、SiliconFlow、NVIDIA NIM、OpenRouter、ModelScope、SenseNova、LongCat、智谱、Moonshot、DeepSeek、MiniMax），并可添加自定义 OpenAI 兼容服务商
- **智能调度**：根据任务类型、模型能力、限流状态、历史成功率和可用额度自动选择最优模型
- **故障切换**：某个模型限流或不可用时自动切换其他模型/服务商；流式请求在首字节前失败同样可以切换
- **统一 API**：在 `127.0.0.1` 提供 OpenAI 兼容网关（`/v1/chat/completions`、`/v1/models`），可直接对接 zcode 等编辑器
- **免费额度管理**：按服务商设置每日请求/Token 配额，用尽后自动跳过该服务商，配额与当日用量在重启后仍然生效
- **多密钥轮换**：每个服务商可保存最多 5 个 API Key，被限流时自动切换下一个密钥
- **安全存储**：使用 Electron `safeStorage`（Windows DPAPI）加密保存服务商凭证
- **两种运行形态**：Electron 桌面端，或 `npm run start:web` 启动的本地 Web 管理端（管理界面 3000、网关 3001）
- **用量统计**：完整的调用日志、每日统计与自动过期清理

## 技术栈

- **桌面应用**：Electron 33 + Vite 6 + TypeScript 5.7
- **前端**：React 18 + Tailwind CSS 3.4
- **本地服务**：Fastify 5 + better-sqlite3
- **构建**：electron-builder（Windows portable + NSIS 安装包，输出到 `release/`）
- **测试**：Vitest（单元/集成/组件）+ Playwright（E2E）

## 快速开始

### 环境要求

- Node.js 20 LTS 或更高版本
- Windows 10/11 64位
- npm 10+

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev        # Vite 开发服务器 + Electron 桌面窗口
npm run dev:web    # 仅启动本地 Web 服务（管理界面 + 网关，支持热重载）
```

### 以 Web 管理端运行

```bash
npm run build
npm run start:web
```

- 管理界面与 REST API：`http://127.0.0.1:3000`
- OpenAI 兼容网关：`http://127.0.0.1:3001/v1`

在任意支持自定义 OpenAI 地址的客户端（如 zcode）里把 Base URL 指向
`http://127.0.0.1:3001/v1`，密钥使用「设置」页展示的网关令牌即可。

### 构建与打包

```bash
# 构建主进程 + 渲染进程
npm run build

# 打包 Windows 安装包（portable + NSIS），输出到 release/
npm run package
```

### 测试与静态检查

```bash
npm test              # Vitest 单元 / 集成 / 组件测试
npm run typecheck     # tsc --noEmit（主进程与渲染进程）
npm run lint          # ESLint
npm run test:e2e      # Playwright（需要先 npm run build && npm run start:web）
```

## 支持的免费服务商

| 服务商 | 免费额度 | 认证方式 |
|--------|----------|----------|
| Ollama (本地) | 无限制 | 无需认证 |
| LM Studio (本地) | 无限制 | 无需认证 |
| Groq | 30 RPM / 100K TPM | API Key |
| Google Gemini | 15 RPM / 1M TPM | API Key |
| Cloudflare Workers AI | 10,000 neurons/天 | API Token + Account ID |
| Hugging Face | 200 RPM | Token |
| Cerebras | 免费层级 | API Key |
| SiliconFlow / NVIDIA NIM / OpenRouter / ModelScope / SenseNova / LongCat / 智谱 / Moonshot / DeepSeek / MiniMax | 以各家官方页面为准 | API Key |

每家服务商都可在「服务商」页设置每日请求/Token 配额（0 或留空表示不限制），
以及最多 5 个 API Key。

## 目录结构

```
src/
├── main/           # Electron 主进程
│   ├── gateway/    # OpenAI 兼容网关 (Fastify)
│   ├── ipc/        # IPC 通信处理器
│   ├── security/   # 安全模块
│   └── services/   # 业务服务层（IPC 与 REST 共用）
├── server/         # 独立 Web 进程：Admin REST API + 渲染产物静态服务
├── preload/        # Electron 预加载脚本
├── renderer/       # React 前端界面
│   └── src/
│       ├── pages/  # 页面组件
│       ├── hooks/  # 数据获取（IPC / HTTP 双实现）
│       └── components/ # 公共组件
├── core/           # 核心逻辑层
│   ├── config/     # 应用配置
│   ├── database/   # SQLite 数据层
│   ├── providers/  # Provider 适配器与注册表
│   └── settings/   # 设置存储
├── scheduler/      # 智能调度器（候选过滤、评分、熔断、限流、配额）
├── usage/          # 用量统计、Token 估算、日志保留
└── shared/         # 共享类型、错误、IPC 通道契约、工具
```

## 安全说明

- 所有凭证通过 Electron `safeStorage` 加密存储（使用 Windows DPAPI）
- 渲染进程与 Node.js 环境完全隔离 (`contextIsolation: true`)
- 凭证不出现在日志、错误消息或前端调试输出中
- IPC 通道有严格的输入验证和白名单控制

## License

MIT License
