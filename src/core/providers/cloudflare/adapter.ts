import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createCloudflareAdapter(accountId?: string, apiToken?: string): OpenAICompatibleAdapter {
  const baseUrl = accountId
    ? `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
    : 'https://api.cloudflare.com/client/v4/accounts/placeholder/ai/v1';

  return new OpenAICompatibleAdapter({
    providerId: 'cloudflare',
    providerName: 'Cloudflare Workers AI',
    baseUrl,
    authType: 'api-key',
    credentialId: apiToken ? 'cloudflare-token' : undefined,
    defaultHeaders: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
    settings: { accountId },
    models: [
      {
        id: '@cf/meta/llama-3.1-8b-instruct',
        providerId: 'cloudflare',
        displayName: 'Llama 3.1 8B Instruct',
        description: 'Meta Llama 3.1 8B - instruction tuned model',
        capabilities: {
          supported: ['chat', 'completion', 'streaming'],
          contextWindow: 131072,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Workers free tier: 10,000 neurons/day' },
        rateLimits: { requestsPerMinute: 300, tokensPerMinute: 100000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: '@cf/google/gemma-7b-it',
        providerId: 'cloudflare',
        displayName: 'Gemma 7B IT',
        description: 'Google Gemma 7B instruction-tuned model',
        capabilities: {
          supported: ['chat', 'completion', 'streaming'],
          contextWindow: 8192,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Workers free tier: 10,000 neurons/day' },
        rateLimits: { requestsPerMinute: 300, tokensPerMinute: 100000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: '@cf/mistral/mistral-7b-instruct-v0.2',
        providerId: 'cloudflare',
        displayName: 'Mistral 7B Instruct',
        description: 'Mistral AI 7B Instruct v0.2',
        capabilities: {
          supported: ['chat', 'completion', 'streaming'],
          contextWindow: 32768,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Workers free tier: 10,000 neurons/day' },
        rateLimits: { requestsPerMinute: 300, tokensPerMinute: 100000 },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
