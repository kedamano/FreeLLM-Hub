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
  checkReadiness?(): ProviderReadiness;
}
```

## 开发新 Provider 步骤

### 1. 在目录里加一个 seed

内置服务商不再各自一个适配器文件：模型清单、价格、限速都写在
`src/core/providers/catalog.ts` 的 `BUILTIN_PROVIDER_SEEDS` 里，适配器由
`createStaticAdapter(seed, credential)`（`src/core/providers/openai-compatible/static-adapter.ts`）
统一装配，`bootstrap.ts` 直接遍历这份目录注册。加一个 OpenAI 兼容的服务商 = 加一段数据：

```typescript
{
  id: 'my-provider',
  name: 'My Provider',
  baseUrl: 'https://api.example.com/v1',
  currency: 'USD',
  caps: ['chat', 'streaming'],          // 该服务商模型的默认能力
  price: 'free',
  priceNote: 'Free tier with rate limits',
  requestsPerMinute: 30,
  tokensPerMinute: 100000,
  models: [
    { id: 'model-id', name: 'Human Readable Name', context: 8192, output: 2048 },
  ],
}
```

只有超出模板的行为才需要额外参数：Cloudflare 用 seed 里的 `configFields` / `requiredSettings` /
`resolveBaseUrl` 描述按账户寻址的地址，OpenRouter 用 `headers` 追加固定请求头。
真正不同的 API（Ollama）保留自己的适配器，但仍然进同一张注册表：`BUILT_IN_ENTRIES` 的第一项。

### 2. 注册

不需要写注册代码。数组顺序即注册顺序，也即服务商页与模型目录的展示顺序（本地服务在前）。
`tests/unit/model-catalog.test.ts` 会断言注册出来的适配器与目录一一对应。

### 3. IPC 凭证通道

凭证存储键格式：`${providerId}-key`（由 `credentialIdFor()` 生成，不要在 seed 里手写）。

凭证状态由 `credentialStore.has(key)` 确定。本地服务把 `authType` 设为 `'none'`，
此时即使密钥库里有残留值也不会挂上凭证。

### 4. Model 能力标注规范

- **`caps` 是唯一一份能力清单**：`capabilities.supported` 直接取它，
  `supportsStreaming / supportsVision / supportsFunctionCalling / supportsJsonMode` 由它派生。
  调度器读 `supported`，界面读四个布尔，两者从此不可能再各说各话——写第二份的机会没有了。
- 免费层没公布每分钟限额的服务商，必须同时加进 `PROVIDERS_WITHOUT_PUBLISHED_RATE_LIMITS`，
  否则测试失败；这条清单的作用是"沉默的全局限额兜底"要有名有姓。
- `contextWindow` 为最大上下文 token 数，`output` 若公布则必须 ≤ `context`
- `pricing.type` 必须是以下之一：`local`、`free`、`freemium`、`paid`、`unknown`
- `pricing.notes` 说明免费条件或限制

### 5. 测试要求

`tests/unit/model-catalog.test.ts` 已经按目录逐个服务商覆盖：模型 id 不重复且不含已下架型号、
能力清单非空且含 `chat`、`output ≤ context`、价格类型合法、布尔与 `supported` 一致、
限额要么声明要么进例外清单、`listModels()` 端出的就是目录里的这一份。
新 Provider 只要数据进目录就跑在这些断言上，另外仍需补：

- `validateCredential` 有效性检查（若该服务商有不同于通用 `GET /models` 的探活方式）
- `chat` 非流式与 `chatStream` 流式各一条（真实端点行为特殊时）
- 错误处理（401/403/429/500）

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

在 `src/core/providers/catalog.ts` 里加一个 seed（`authType` 留给运行期：只要
`provider-settings:<id>` 里的 OAuth 规格合法，装配阶段就会把它翻成 `oauth`），
并在 `oauthConfigFields()` 里补齐该服务商的端点默认值；其余流程复用上面的装配。

### 5. 测试

`tests/unit/oauth-core.test.ts` 覆盖 PKCE、授权 URL、令牌解析与错误分类；
`tests/unit/oauth-manager.test.ts` 覆盖托管、到期主动刷新、单飞合并、瞬时失败保留旧令牌与撤销判定。
接入真实服务商时，请用一个本地假令牌端点（`vi.stubGlobal('fetch', …)`）补一条端到端用例。
