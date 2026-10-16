import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import type { ProviderModel } from '../contracts.js';

function model(id: string, displayName: string, contextWindow: number, vision = false): ProviderModel {
  return {
    id,
    providerId: 'minimax',
    displayName,
    capabilities: {
      supported: ['chat', 'streaming'],
      contextWindow,
      supportsStreaming: true,
      supportsVision: vision,
      supportsFunctionCalling: true,
      supportsJsonMode: false,
    },
    pricing: { type: 'freemium', currency: 'CNY' },
    status: 'available',
    discoveredAt: new Date().toISOString(),
  };
}

export function createMiniMaxAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'minimax',
    providerName: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'minimax-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      model('MiniMax-M1', 'MiniMax M1', 800000),
      model('MiniMax-Text-01', 'MiniMax Text 01', 1000000),
      model('MiniMax-VL-01', 'MiniMax VL 01', 1000000, true),
    ],
  });
}
