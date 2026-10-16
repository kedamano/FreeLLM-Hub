import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createOpenRouterAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'openrouter',
    providerName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'openrouter-key' : undefined,
    defaultHeaders: apiKey
      ? { Authorization: `Bearer ${apiKey}`, 'HTTP-Referer': 'https://freellmhub.app', 'X-Title': 'FreeLLM Hub' }
      : {},
    models: [
      {
        id: 'meta-llama/llama-3.3-70b-instruct:free',
        providerId: 'openrouter',
        displayName: 'Llama 3.3 70B (free)',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling'],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free models, ~50 calls/day' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'deepseek/deepseek-chat-v3-0324:free',
        providerId: 'openrouter',
        displayName: 'DeepSeek V3 0324 (free)',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 163840,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free models, ~50 calls/day' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'qwen/qwen3-235b-a22b:free',
        providerId: 'openrouter',
        displayName: 'Qwen3 235B A22B (free)',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling'],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free models, ~50 calls/day' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
