import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createModelScopeAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'modelscope',
    providerName: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'modelscope-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'Qwen/Qwen3-235B-A22B',
        providerId: 'modelscope',
        displayName: 'Qwen3 235B A22B',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling', 'json-mode'],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'free', currency: 'CNY', notes: 'Free tier ~2000 calls/day' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'deepseek-ai/DeepSeek-V3',
        providerId: 'modelscope',
        displayName: 'DeepSeek V3',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'CNY', notes: 'Free tier ~2000 calls/day' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'Qwen/Qwen3-32B',
        providerId: 'modelscope',
        displayName: 'Qwen3 32B',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling'],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'CNY', notes: 'Free tier ~2000 calls/day' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
