import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createSenseNovaAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'sensenova',
    providerName: 'SenseNova',
    baseUrl: 'https://token.sensenova.cn/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'sensenova-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'sensenova-6.8-flash-lite',
        providerId: 'sensenova',
        displayName: 'SenseNova 6.8 Flash Lite',
        description: 'Multimodal agent model, free public beta',
        capabilities: {
          supported: ['chat', 'streaming', 'vision', 'function-calling', 'json-mode'],
          contextWindow: 262144,
          maxOutputTokens: 65536,
          supportsStreaming: true,
          supportsVision: true,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'free', currency: 'CNY', notes: 'Token Plan free beta, weekly credits' },
        rateLimits: { requestsPerMinute: 15, tokensPerMinute: 1000000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'deepseek-v4-flash',
        providerId: 'sensenova',
        displayName: 'DeepSeek V4 Flash',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling', 'json-mode'],
          contextWindow: 1000000,
          maxOutputTokens: 65536,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'free', currency: 'CNY', notes: 'Token Plan free beta, weekly credits' },
        rateLimits: { requestsPerMinute: 15, tokensPerMinute: 1000000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'glm-5.2',
        providerId: 'sensenova',
        displayName: 'GLM 5.2',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling', 'json-mode'],
          contextWindow: 1000000,
          maxOutputTokens: 131072,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'free', currency: 'CNY', notes: 'Token Plan free beta, weekly credits' },
        rateLimits: { requestsPerMinute: 15, tokensPerMinute: 1000000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
