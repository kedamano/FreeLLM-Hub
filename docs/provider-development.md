# Provider 适配器开发规范

## 契约

所有适配器必须实现 `ProviderAdapter` 接口：

```typescript
interface ProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly authType: AuthType;

  getProviderConfig(): ProviderConfig;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ProviderModel[]>;
  getModel(modelId: string): Promise<ProviderModel | null>;
  chat(messages, model, options?): Promise<{content, usage, finishReason}>;
  chatStream(messages, model, options?): AsyncIterable<StreamChunk>;
  validateCredential(credential?): Promise<{valid, reason?}>;
  getUsageInfo?(): Promise<ProviderUsageInfo>;
}
```

## 开发新 Provider 步骤

### 1. 创建适配器

在 `src/core/providers/<provider-name>/` 目录下创建适配器文件。

如果是 OpenAI 兼容 API，继承 `OpenAICompatibleAdapter` 基类：

```typescript
import { OpenAICompatibleAdapter } from '../openai-compatible/adapter';

export function createMyProviderAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'my-provider',
    providerName: 'My Provider',
    baseUrl: 'https://api.example.com/v1',
    authType: 'api-key',
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'model-id',
        providerId: 'my-provider',
        displayName: 'Human Readable Name',
        capabilities: { supported: [...], contextWindow: 8192, ... },
        pricing: { type: 'free', currency: 'USD', notes: '...' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
```

### 2. 注册表注册

在 `src/core/providers/index.ts` 中导出。

在 `src/main/app-lifecycle.ts` 的 `registerProviders()` 中注册。

### 3. IPC 凭证通道

凭证存储键格式：`${providerId}-key`

凭证状态由 `credentialStore.has(key)` 确定。

### 4. Model 能力标注规范

- `supported` 数组必须准确反映模型实际能力
- `contextWindow` 为最大上下文 token 数
- `pricing.type` 必须是以下之一：`local`、`free`、`freemium`、`paid`、`unknown`
- `pricing.notes` 说明免费条件或限制

### 5. 测试要求

新 Provider 适配器必须包含以下测试：

- `validateCredential` 有效性检查
- `listModels` 返回正确格式
- `chat` 非流式请求
- `chatStream` 流式请求
- 错误处理（401/403/429/500）
- 模型能力标注正确性

## 错误代码约定

| HTTP 状态码 | 内部错误码 | 说明 |
|-------------|-----------|------|
| 401 | AUTH_FAILED | 认证失败 |
| 403 | AUTH_FAILED | 权限不足 |
| 429 | RATE_LIMITED | 速率限制 |
| 500 | SERVER_ERROR | 服务端错误 |
| 503 | SERVER_ERROR | 服务不可用 |
| timeout | TIMEOUT | 请求超时 |

## 接入 OAuth 类服务商

有些免费层不发长期 API Key，而是发放有效期很短的访问令牌。这类服务商走授权码 + PKCE，
不需要为它写一个适配器：复用 `OpenAICompatibleAdapter`，把凭据来源换成 OAuth 令牌即可。

### 1. 配置端点（界面：服务商 → 该服务商 → OAuth）

写入 `provider-settings:<id>`（非机密）：

```json
{
  "oauth": true,
  "authorizationUrl": "https://auth.example.com/oauth2/authorize",
  "tokenUrl": "https://auth.example.com/oauth2/token",
  "clientId": "…",
  "scopes": "model.read inference",
  "usePkce": true
}
```

Client Secret（机密客户端才需要）单独走加密存储，键为 `<id>-oauth-secret`。
`resolveOAuthSpec()` 只有在 `oauth: true` 且两个端点与 `clientId` 合法时才返回规格，
否则返回 `null`，服务商继续沿用 API Key 路径。

### 2. 装配

`registerAllProviders(registry, credentialStore, { tokenSourceFor })` 在启动时（以及配置变更后）
对每个适配器调用 `attachOAuthTokenSources()`：命中 OAuth 规格的适配器会被 `setTokenSource()`，
其 `authType` 随之变成 `oauth`，`credentialStatus` 变成 `valid / expired / unconfigured`。

### 3. 运行期

- 每次请求前 `buildRequestHeaders()` 向令牌源要一个有效令牌；
- 到期前 2 分钟（`REFRESH_SKEW_MS`）主动刷新，多个并发请求合并成一次刷新；
- 上游返回 401 时强制刷新一次并重放请求，仍失败才抛 `AUTH_FAILED` 让调度器改路由；
- 刷新令牌被判定失效（`invalid_grant`）时状态落库为 `revoked`，界面提示重新授权。

### 4. 新增内置 OAuth 服务商

在 `src/core/providers/bootstrap.ts` 的工厂表里加一个用 `OpenAICompatibleAdapter` + `authType: 'oauth'`
的适配器，并在 `oauthConfigFields()` 里补齐该服务商的端点默认值；其余流程复用上面的装配。

### 5. 测试

`tests/unit/oauth-core.test.ts` 覆盖 PKCE、授权 URL、令牌解析与错误分类；
`tests/unit/oauth-manager.test.ts` 覆盖托管、到期主动刷新、单飞合并、瞬时失败保留旧令牌与撤销判定。
接入真实服务商时，请用一个本地假令牌端点（`vi.stubGlobal('fetch', …)`）补一条端到端用例。
