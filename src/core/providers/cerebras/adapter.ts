import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createCerebrasAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'cerebras',
    providerName: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'cerebras-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'llama3.1-8b',
        providerId: 'cerebras',
        displayName: 'Llama 3.1 8B',
        description: 'Meta Llama 3.1 8B on Cerebras - ultra-fast inference',
        capabilities: {
          supported: ['chat', 'completion', 'streaming'],
          contextWindow: 131072,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free tier available' },
        rateLimits: { requestsPerMinute: 30, tokensPerMinute: 100000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
