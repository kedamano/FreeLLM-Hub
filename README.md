# FreeLLM Hub

本地优先的 Windows 桌面大模型聚合、统一 API 接入、免费额度管理和智能调度平台。

## 产品定位

FreeLLM Hub 是你的个人 AI 推理资源管理中心。它聚合了多个官方免费大模型 API，支持本地开源模型接入，并通过智能调度系统自动选择最合适的模型来处理你的请求。

## 核心能力

- **免费模型聚合**：接入 Groq、Google Gemini Flash、Cloudflare Workers AI、Hugging Face、Cerebras 等提供免费额度的服务商
- **本地模型支持**：通过 Ollama 和 LM Studio 接入本地运行的推理模型
- **智能调度**：根据任务类型、模型能力、限流状态、历史成功率和可用额度自动选择最优模型
- **故障切换**：当某个模型不可用时，自动切换到其他合适的模型
- **统一 API**：为外部应用提供 OpenAI 兼容的 API 接口
- **安全存储**：使用 Windows DPAPI 加密保存服务商凭证
- **用量统计**：完整的调用日志和资源用量追踪

## 技术栈

- **桌面应用**：Electron 33 + Vite 6 + TypeScript 5.7
- **前端**：React 18 + Tailwind CSS 3.4
- **本地服务**：Fastify 5 + better-sqlite3
- **构建**：electron-builder (Windows installer + portable)
- **测试**：Vitest + Playwright（计划中）

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
npm run dev
```

启动后会同时运行 Vite 开发服务器和 Electron 桌面窗口。

### 构建

```bash
# 构建主进程 + 渲染进程
npm run build

# 打包 Windows 安装包
npm run package
```

### 测试

```bash
npm test
```

## 支持的免费服务商

| 服务商 | 免费额度 | 认证方式 |
|--------|----------|----------|
| Ollama (本地) | 无限制 | 无需认证 |
| LM Studio (本地) | 无限制 | 无需认证 |
| Groq | 30 RPM / 100K TPM | API Key |
| Google Gemini Flash | 15 RPM / 1M TPM | API Key |
| Cloudflare Workers AI | 10,000 neurons/天 | API Token |
| Hugging Face | 200 RPM | Token |
| Cerebras | 免费层级 | API Key |

## 目录结构

```
src/
├── main/           # Electron 主进程
│   ├── gateway/    # 本地 API 网关 (Fastify)
│   ├── ipc/        # IPC 通信处理器
│   └── security/   # 安全模块
├── preload/        # Electron 预加载脚本
├── renderer/       # React 前端界面
│   └── src/
│       ├── pages/  # 页面组件
│       └── components/ # 公共组件
├── core/           # 核心逻辑层
│   ├── config/     # 应用配置
│   ├── database/   # SQLite 数据层
│   ├── domain/     # 领域模型
│   └── providers/  # Provider 适配器
├── scheduler/      # 智能调度器
├── usage/          # 用量统计和 Token 计算
└── shared/         # 共享类型、校验、工具
```

## 安全说明

- 所有凭证通过 Electron `safeStorage` 加密存储（使用 Windows DPAPI）
- 渲染进程与 Node.js 环境完全隔离 (`contextIsolation: true`)
- 凭证不出现在日志、错误消息或前端调试输出中
- IPC 通道有严格的输入验证和白名单控制

## License

MIT License
