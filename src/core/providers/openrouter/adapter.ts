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
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        providerId: 'openrouter',
        displayName: 'Nemotron 3 Super 120B A12B (free)',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 262144,
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
        id: 'google/gemma-4-31b-it:free',
        providerId: 'openrouter',
        displayName: 'Gemma 4 31B IT (free)',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 131072,
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
    ],
  });
}
