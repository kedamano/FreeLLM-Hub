import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';

export function createSiliconFlowAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'siliconflow',
    providerName: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    authType: 'api-key',
    credentialId: apiKey ? 'siliconflow-key' : undefined,
    defaultHeaders: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    models: [
      {
        id: 'Qwen/Qwen3-8B',
        providerId: 'siliconflow',
        displayName: 'Qwen3 8B',
        description: 'Alibaba Qwen3 8B - free tier on SiliconFlow',
        capabilities: {
          supported: ['chat', 'streaming', 'function-calling', 'json-mode'],
          contextWindow: 32768,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: true,
          supportsJsonMode: true,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free small-model tier' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        providerId: 'siliconflow',
        displayName: 'Qwen2.5 7B Instruct',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 32768,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free small-model tier' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        providerId: 'siliconflow',
        displayName: 'DeepSeek R1 Distill 7B',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 32768,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD', notes: 'Free small-model tier' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ],
  });
}
