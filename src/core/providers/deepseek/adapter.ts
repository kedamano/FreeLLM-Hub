import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import type { ProviderModel } from '../contracts.js';

function model(id: string, displayName: string, contextWindow: number): ProviderModel {
  return {
    id,
    providerId: 'deepseek',
    displayName,
    capabilities: {
      supported: ['chat', 'streaming'],
      contextWindow,
      maxOutputTokens: 8192,
      supportsStreaming: true,
      supportsVision: false,
      supportsFunctionCalling: true,
      supportsJsonMode: true,
    },
    pricing: { type: 'paid', currency: 'CNY', notes: '低价按量计费，常有充值活动' },
    status: 'available',
    discoveredAt: new Date().toISOString(),
  };
}

export function createDeepSeekAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'deepseek-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      model('deepseek-chat', 'DeepSeek Chat (V3)', 65536),
      model('deepseek-reasoner', 'DeepSeek Reasoner (R1)', 65536),
    ],
  });
}
