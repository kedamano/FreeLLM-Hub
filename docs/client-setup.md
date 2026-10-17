# 客户端接入指南：Claude Code 与 Codex

FreeLLM Hub 在本机暴露一个 OpenAI 兼容网关（`/v1/chat/completions`）。本文覆盖两类最常见的接入对象：

- **Codex（CLI / 桌面端）**：说 OpenAI Chat 协议，**当前版本即可接入**；
- **Claude Code**：说 Anthropic Messages 协议，需要网关的 `/v1/messages` 翻译层（本仓库已备好纯翻译模块，网关接线发布后即可用，见文末状态表）。

## 第 0 步：拿到两样东西

无论哪个客户端，都需要：

1. **网关地址**（含端口）：
   - 桌面端：打开 FreeLLM Hub，仪表盘「本地网关」卡片显示实际地址（首次启动端口由系统分配，并非固定 3001；可在设置中固定）。
   - Web 模式（`npm run start:web`）：网关默认 `http://127.0.0.1:3001`，管理端默认 `http://127.0.0.1:3000`，可用 `GATEWAY_PORT` / `ADMIN_PORT` 环境变量覆盖。
2. **网关令牌**：设置 → 网关 → 生成/复制令牌（`fh_...`）。若开启了鉴权（默认开启），所有请求都要带它。

> 网关只监听 `127.0.0.1`。所有示例里的 `<PORT>` 请替换为你实际看到的端口。

---

## Codex CLI / 桌面端（OpenAI 协议，当前版本即可用）

Codex 默认说 **Responses API**，而本网关提供的是 Chat Completions，所以配置里必须显式声明 `wire_api = "chat"`，否则会得到 404。

编辑 `~/.codex/config.toml`（Windows：`C:\Users\<你>\.codex\config.toml`）：

```toml
model_provider = "freellm"
model = "llama-3.3-70b"        # 网关 /v1/models 列出的任意模型 ID

[model_providers.freellm]
name = "FreeLLM Hub"
base_url = "http://127.0.0.1:3001/v1"   # 换成你的实际网关地址
wire_api = "chat"                        # 关键：默认是 responses，必须改
env_key = "FREELLM_API_KEY"              # 从这个环境变量读令牌
```

再设置环境变量（Codex 会用它作为 `Authorization: Bearer` 头）：

```bash
# Windows PowerShell（当前会话）
$env:FREELLM_API_KEY = "fh_你的令牌"

# Windows 永久
setx FREELLM_API_KEY "fh_你的令牌"

# macOS / Linux
export FREELLM_API_KEY="fh_你的令牌"
```

验证：

```bash
curl http://127.0.0.1:3001/v1/chat/completions \
  -H "Authorization: Bearer fh_你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"ping"}]}'
```

Codex 桌面端读取同一份 `config.toml`，配置方式相同。

常见问题：

- **404 / "unknown route"**：忘了 `wire_api = "chat"`。
- **401 auth_required**：令牌没配对，或走了 `env_key` 以外的变量名。
- **模型不存在**：模型 ID 必须是网关 `/v1/models` 返回的 ID；自定义别名/映射见 roadmap。

---

## Claude Code（Anthropic 协议，需 /v1/messages 已接线）

Claude Code 说 Anthropic Messages 协议。本网关的翻译层已实现（系统提示、多模态、工具调用、流式事件、count_tokens 估算），接线发布后按下面配置即可。

### 方式一：环境变量（推荐，两行搞定）

```bash
# macOS / Linux
export ANTHROPIC_BASE_URL="http://127.0.0.1:3001"
export ANTHROPIC_AUTH_TOKEN="fh_你的令牌"

# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3001"
$env:ANTHROPIC_AUTH_TOKEN = "fh_你的令牌"
```

然后正常启动 `claude`。模型用 `/v1/models` 里的 ID：

```bash
export ANTHROPIC_MODEL="qwen3-coder-plus"
export ANTHROPIC_SMALL_FAST_MODEL="llama-3.1-8b-instant"   # 后台小任务用的便宜模型
```

### 方式二：settings.json（随项目固定）

`~/.claude/settings.json` 或项目下 `.claude/settings.json`：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3001",
    "ANTHROPIC_AUTH_TOKEN": "fh_你的令牌",
    "ANTHROPIC_MODEL": "qwen3-coder-plus",
    "ANTHROPIC_SMALL_FAST_MODEL": "llama-3.1-8b-instant"
  }
}
```

### 三个容易踩的坑

1. **必须用 `ANTHROPIC_AUTH_TOKEN`，不要用 `ANTHROPIC_API_KEY`。** 前者发送 `Authorization: Bearer`（网关认这个）；后者发送 `x-api-key` 头，网关不认。
2. **Claude Code 强制要求 `max_tokens`**，网关翻译层会补默认值 4096；想给大输出就在请求里带。
3. **`/v1/messages/count_tokens` 是估算值**（基于 tokenizer 估算，含工具 schema），够 Claude Code 做上下文预算，但不是服务商精确计数。

### 状态速查

| 能力 | 状态 |
| --- | --- |
| Codex（`/v1/chat/completions`，流式/非流式/工具） | ✅ 当前版本可用 |
| Claude Code（`/v1/messages` 非流式 + 流式 + count_tokens） | 🔜 翻译层已实现并测试，等网关路由接线发布 |
| `/v1/embeddings` | 🔜 规划中 |

---

## 通用建议

- **令牌安全**：网关令牌等同本机模型使用权，不要提交进仓库；泄露后在设置里重新生成即可作废旧的。
- **多项目隔离**：配合「配置档」使用——不同终端会话 `export` 不同的环境变量并不能隔离池；真正的按项目隔离用虚拟 API Key（roadmap）。
- **排障**：先看「请求审计」面板，每个请求的候选跳过原因与重试轨迹都在里面；被拒请求（含令牌错误）也有记录。
