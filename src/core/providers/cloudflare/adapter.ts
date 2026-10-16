import { OpenAICompatibleAdapter } from '../openai-compatible/adapter.js';
import type { ProviderConfigField } from '../../../shared/types/index.js';
import { credentialIdFor } from '../credential-keys.js';

const CLOUDFLARE_ACCOUNT_FIELD: ProviderConfigField = {
  key: 'accountId',
  label: 'Cloudflare Account ID',
  type: 'text',
  required: true,
  placeholder: 'Workers & Pages → 右上角账户 ID',
  help: 'Workers AI 接口按账户寻址，未填写时无法请求（可在 Cloudflare 控制台账户详情页复制）',
};

function cloudflareBaseUrl(settings: Record<string, unknown>): string | null {
  const accountId = typeof settings.accountId === 'string' ? settings.accountId.trim() : '';
  if (!accountId) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

export function createCloudflareAdapter(accountId?: string, apiToken?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId: 'cloudflare',
    providerName: 'Cloudflare Workers AI',
    // Deliberately templated: without an account id no request is issued at all
    // (see OpenAICompatibleAdapter.checkReadiness / listModels gating).
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
    authType: 'api-key',
    credentialId: credentialIdFor('cloudflare', apiToken),
    defaultHeaders: apiToken ? { Authorization: `Bearer ${apiToken}` } : {},
    settings: accountId ? { accountId } : {},
    requiredSettings: ['accountId'],
    resolveBaseUrl: cloudflareBaseUrl,
    configFields: [CLOUDFLARE_ACCOUNT_FIELD],
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
