import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import type { ProviderModel } from '../contracts.js';

function model(id: string, displayName: string, contextWindow: number, opts?: { free?: boolean; vision?: boolean }): ProviderModel {
  return {
    id,
    providerId: 'longcat',
    displayName,
    capabilities: {
      supported: ['chat', 'streaming'],
      contextWindow,
      supportsStreaming: true,
      supportsVision: !!opts?.vision,
      supportsFunctionCalling: false,
      supportsJsonMode: false,
    },
    pricing: { type: opts?.free === false ? 'freemium' : 'free', currency: 'CNY' },
    status: 'available',
    discoveredAt: new Date().toISOString(),
  };
}

export function createLongCatAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'longcat',
    providerName: 'LongCat (美团)',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'longcat-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      model('LongCat-Flash-Chat', 'LongCat Flash Chat', 131072),
      model('LongCat-Flash-Thinking', 'LongCat Flash Thinking', 131072),
    ],
  });
}
