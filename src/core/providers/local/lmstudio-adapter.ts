import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createLMStudioAdapter(baseUrl?: string): OpenAICompatibleAdapter {
  const url = baseUrl || 'http://localhost:1234/v1';

  return new OpenAICompatibleAdapter({
    providerId: 'lmstudio',
    providerName: 'LM Studio (本地)',
    baseUrl: url.replace(/\/$/, ''),
    authType: 'none',
    credentialId: 'lmstudio-local',
    models: [
      {
        id: 'local-model',
        providerId: 'lmstudio',
        displayName: 'LM Studio 本地模型',
        description: '当前 LM Studio 中加载的模型',
        capabilities: {
          supported: ['chat', 'completion', 'streaming'],
          contextWindow: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'local', currency: 'USD', notes: '本地免费推理' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
    metadata: {
      description: '通过 LM Studio 的 OpenAI 兼容接口在本地运行模型',
    },
  });
}
