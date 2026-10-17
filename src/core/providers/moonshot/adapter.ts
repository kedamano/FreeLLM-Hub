import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import type { ProviderModel } from '../contracts.js';

function model(id: string, displayName: string, contextWindow: number, free: boolean, vision = false): ProviderModel {
  return {
    id,
    providerId: 'moonshot',
    displayName,
    capabilities: {
      supported: ['chat', 'streaming', 'function-calling'],
      contextWindow,
      supportsStreaming: true,
      supportsVision: vision,
      supportsFunctionCalling: true,
      supportsJsonMode: true,
    },
    pricing: { type: free ? 'free' : 'paid', currency: 'CNY' },
    status: 'available',
    discoveredAt: new Date().toISOString(),
  };
}

export function createMoonshotAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'moonshot',
    providerName: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'moonshot-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      model('kimi-k2-0905-preview', 'Kimi K2 0905 Preview', 262144, false, true),
      model('moonshot-v1-8k', 'Moonshot v1 8K', 8192, false),
      model('moonshot-v1-auto', 'Moonshot v1 Auto', 131072, false),
    ],
  });
}
