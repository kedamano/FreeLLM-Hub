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
