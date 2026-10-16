import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createNvidiaAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'nvidia',
    providerName: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'nvidia-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'deepseek-ai/deepseek-r1',
        providerId: 'nvidia',
        displayName: 'DeepSeek R1',
        description: 'DeepSeek R1 reasoning model on NVIDIA NIM',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 128000,
          maxOutputTokens: 32768,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free API with rate limits' },
        rateLimits: { requestsPerMinute: 40, tokensPerMinute: 40000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'meta/llama-3.3-70b-instruct',
        providerId: 'nvidia',
        displayName: 'Llama 3.3 70B Instruct',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling'],
          contextWindow: 131072,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free API with rate limits' },
        rateLimits: { requestsPerMinute: 40, tokensPerMinute: 40000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'nvidia/llama-3.1-nemotron-70b-instruct',
        providerId: 'nvidia',
        displayName: 'Llama 3.1 Nemotron 70B',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 32768,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free API with rate limits' },
        rateLimits: { requestsPerMinute: 40, tokensPerMinute: 40000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
