import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import type { ProviderModel } from '../contracts.js';

function model(id: string, displayName: string, contextWindow: number, free: boolean, vision = false): ProviderModel {
  return {
    id,
    providerId: 'zhipu',
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

export function createZhipuAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'zhipu',
    providerName: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    authType: 'api-key',
    credentialId: apiKey ? 'zhipu-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      model('glm-4-flash', 'GLM-4 Flash', 131072, true),
      model('glm-4.5-air', 'GLM-4.5 Air', 131072, false),
      model('glm-4-plus', 'GLM-4 Plus', 131072, false),
    ],
  });
}
