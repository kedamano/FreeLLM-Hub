import type {
  AuthType,
  ModelCapability,
  ModelPricingType,
  ProviderConfigField,
  ProviderModel,
} from '../../shared/types/index.js';
import { buildCapabilities } from '../../shared/utils/capabilities.js';

/**
 * The built-in model catalog, in one file.
 *
 * Before this, every provider carried its own adapter with hand-written `ProviderModel`
 * objects, and the same facts were written twice: once in `capabilities.supported` (which
 * the scheduler routes on) and once in the `supportsX` booleans (which the model page
 * renders). The two drifted — 18 of 41 models claimed a capability the router refused to
 * send traffic to. Here the capability list is written once and the flags are derived, so
 * the page and the scheduler cannot disagree again.
 *
 * Prices and rate limits move the same way: a provider states its defaults and models
 * override only what differs, instead of repeating `pricing: { type: 'free', … }` per model.
 */

/** One model, described by what differs from the provider defaults. */
export interface ModelSeed {
  id: string;
  /** Display name; falls back to the model id. */
  name?: string;
  /** One-line description shown in the catalog. */
  about?: string;
  /** The single source of truth for this model's capabilities. */
  caps?: ModelCapability[];
  /** Context window in tokens. */
  context: number;
  /** Maximum output tokens; omitted when the provider does not publish one. */
  output?: number;
  price?: ModelPricingType;
  priceNote?: string;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
}

export interface ProviderSeed {
  id: string;
  name: string;
  baseUrl: string;
  /** `none` for local servers that take no credential; defaults to `api-key`. */
  authType?: AuthType;
  currency: 'USD' | 'CNY';
  /** Inherited by models that do not declare their own caps. */
  caps: ModelCapability[];
  price: ModelPricingType;
  priceNote?: string;
  requestsPerMinute?: number;
  tokensPerMinute?: number;
  /** Non-secret fields the user must fill (Cloudflare's account id). */
  configFields?: ProviderConfigField[];
  requiredSettings?: string[];
  /** Recompute the effective baseUrl from settings; return null to keep the previous one. */
  resolveBaseUrl?: (settings: Record<string, unknown>) => string | null;
  /** Static headers merged with the bearer token (OpenRouter's referer/title). */
  headers?: Record<string, string>;
  models: ModelSeed[];
}

const CHAT = ['chat', 'streaming'] as const satisfies readonly ModelCapability[];

/**
 * Providers whose free tier publishes no per-minute limit. The scheduler then falls back to
 * its global default, which is a policy decision rather than data — listing the gaps here
 * keeps a new provider from silently inheriting it.
 */
export const PROVIDERS_WITHOUT_PUBLISHED_RATE_LIMITS: readonly string[] = [
  'siliconflow',
  'openrouter',
  'modelscope',
  'longcat',
  'zhipu',
  'moonshot',
  'deepseek',
  'minimax',
  'lmstudio',
];

const CLOUDFLARE_ACCOUNT_FIELD: ProviderConfigField = {
  key: 'accountId',
  label: 'Cloudflare Account ID',
  type: 'text',
  required: true,
  placeholder: 'Workers & Pages → 右上角账户 ID',
  help: 'Workers AI 接口按账户寻址，未填写时无法请求（可在 Cloudflare 控制台账户详情页复制）',
};

/** Workers AI addresses are account-scoped, so the baseUrl cannot exist before the field is filled. */
function cloudflareBaseUrl(settings: Record<string, unknown>): string | null {
  const accountId = typeof settings.accountId === 'string' ? settings.accountId.trim() : '';
  if (!accountId) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
}

/**
 * Array order *is* registration order, which is also the order the provider and model
 * pages list things in — local servers first, then the remote free pools.
 */
export const BUILTIN_PROVIDER_SEEDS: ProviderSeed[] = [
  {
    id: 'lmstudio',
    name: 'LM Studio (本地)',
    baseUrl: 'http://localhost:1234/v1',
    authType: 'none',
    currency: 'USD',
    caps: ['chat', 'completion', 'streaming'],
    price: 'local',
    priceNote: '本地免费推理',
    models: [
      {
        id: 'local-model',
        name: 'LM Studio 本地模型',
        about: '通过 LM Studio 的 OpenAI 兼容接口在本地运行模型',
        context: 8192,
      },
    ],
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    currency: 'USD',
    caps: ['chat', 'completion', 'streaming'],
    price: 'free',
    priceNote: 'Free tier with rate limits',
    requestsPerMinute: 30,
    tokensPerMinute: 100000,
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        name: 'Llama 3.3 70B Versatile',
        about: 'Meta Llama 3.3 70B - versatile model with strong reasoning',
        caps: ['chat', 'completion', 'streaming', 'json-mode', 'function-calling'],
        context: 131072,
        output: 32768,
      },
      {
        id: 'llama-3.1-8b-instant',
        name: 'Llama 3.1 8B Instant',
        about: 'Fast inference model for quick responses',
        caps: ['chat', 'completion', 'streaming', 'function-calling'],
        context: 131072,
        output: 8192,
      },
      {
        id: 'mixtral-8x7b-32768',
        name: 'Mixtral 8x7B',
        about: 'Mistral Mixtral 8x7B MoE model',
        context: 32768,
        output: 32768,
      },
    ],
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    currency: 'USD',
    caps: ['chat', 'completion', 'streaming', 'vision', 'function-calling', 'json-mode'],
    price: 'free',
    priceNote: 'Free tier: 15 RPM, 1M TPM',
    requestsPerMinute: 15,
    tokensPerMinute: 1000000,
    models: [
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        about: 'Google Gemini 2.0 Flash - fast multimodal model',
        context: 1048576,
        output: 8192,
      },
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        about: 'Google Gemini 2.5 Flash - latest fast model',
        price: 'freemium',
        priceNote: 'Free tier with limits',
        context: 1048576,
        output: 8192,
      },
      {
        id: 'gemini-2.0-flash-lite',
        name: 'Gemini 2.0 Flash Lite',
        about: 'Lightweight fast model for simple tasks',
        caps: ['chat', 'completion', 'streaming', 'function-calling'],
        priceNote: 'Free tier: 30 RPM',
        requestsPerMinute: 30,
        context: 1048576,
        output: 8192,
      },
    ],
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    // Deliberately templated: with no account id no request is issued at all
    // (see OpenAICompatibleAdapter.checkReadiness / listModels gating).
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts',
    currency: 'USD',
    caps: ['chat', 'completion', 'streaming'],
    price: 'free',
    priceNote: 'Workers free tier: 10,000 neurons/day',
    requestsPerMinute: 300,
    tokensPerMinute: 100000,
    configFields: [CLOUDFLARE_ACCOUNT_FIELD],
    requiredSettings: ['accountId'],
    resolveBaseUrl: cloudflareBaseUrl,
    models: [
      {
        id: '@cf/meta/llama-3.1-8b-instruct',
        name: 'Llama 3.1 8B Instruct',
        about: 'Meta Llama 3.1 8B - instruction tuned model',
        context: 131072,
        output: 2048,
      },
      {
        id: '@cf/google/gemma-7b-it',
        name: 'Gemma 7B IT',
        about: 'Google Gemma 7B instruction-tuned model',
        context: 8192,
        output: 2048,
      },
      {
        id: '@cf/mistral/mistral-7b-instruct-v0.2',
        name: 'Mistral 7B Instruct',
        about: 'Mistral AI 7B Instruct v0.2',
        context: 32768,
        output: 2048,
      },
    ],
  },
  {
    id: 'huggingface',
    name: 'Hugging Face Inference',
    baseUrl: 'https://api-inference.huggingface.co/v1',
    currency: 'USD',
    caps: ['chat', 'completion', 'streaming'],
    price: 'free',
    priceNote: 'Free with rate limits',
    requestsPerMinute: 200,
    tokensPerMinute: 50000,
    models: [
      {
        id: 'meta-llama/Llama-3.1-8B-Instruct',
        name: 'Llama 3.1 8B Instruct',
        about: 'Meta Llama 3.1 8B - free inference API',
        context: 131072,
        output: 2048,
      },
      {
        id: 'google/gemma-7b-it',
        name: 'Gemma 7B IT',
        about: 'Google Gemma 7B instruction-tuned',
        context: 8192,
        output: 2048,
      },
      {
        id: 'microsoft/Phi-3-mini-4k-instruct',
        name: 'Phi-3 Mini 4K',
        about: 'Microsoft Phi-3 Mini - compact high-quality model',
        context: 4096,
        output: 2048,
      },
    ],
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    currency: 'USD',
    caps: ['chat', 'completion', 'streaming'],
    price: 'free',
    priceNote: 'Free tier available',
    requestsPerMinute: 30,
    tokensPerMinute: 100000,
    models: [
      {
        id: 'llama3.1-8b',
        name: 'Llama 3.1 8B',
        about: 'Meta Llama 3.1 8B on Cerebras - ultra-fast inference',
        context: 131072,
        output: 8192,
      },
    ],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    currency: 'USD',
    caps: [...CHAT],
    price: 'free',
    priceNote: 'Free small-model tier',
    models: [
      {
        id: 'Qwen/Qwen3-8B',
        name: 'Qwen3 8B',
        about: 'Alibaba Qwen3 8B - free tier on SiliconFlow',
        caps: ['chat', 'streaming', 'function-calling', 'json-mode'],
        context: 32768,
        output: 8192,
      },
      {
        id: 'Qwen/Qwen2.5-7B-Instruct',
        name: 'Qwen2.5 7B Instruct',
        context: 32768,
        output: 8192,
      },
      {
        id: 'deepseek-ai/DeepSeek-R1-Distill-Qwen-7B',
        name: 'DeepSeek R1 Distill 7B',
        context: 32768,
        output: 8192,
      },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    currency: 'USD',
    caps: ['chat', 'streaming'],
    price: 'free',
    priceNote: 'Free API with rate limits',
    requestsPerMinute: 40,
    tokensPerMinute: 40000,
    models: [
      {
        id: 'deepseek-ai/deepseek-v4.1-flash',
        name: 'DeepSeek V4.1 Flash',
        about: 'DeepSeek V4.1 Flash on NVIDIA NIM',
        context: 128000,
        output: 32768,
      },
      {
        id: 'nvidia/llama-3.1-nemotron-51b-instruct',
        name: 'Llama 3.1 Nemotron 51B Instruct',
        caps: ['chat', 'streaming', 'function-calling'],
        context: 131072,
        output: 4096,
      },
      {
        id: 'nvidia/llama-3.1-nemotron-70b-instruct',
        name: 'Llama 3.1 Nemotron 70B',
        context: 32768,
        output: 4096,
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    currency: 'USD',
    caps: [...CHAT],
    price: 'free',
    priceNote: 'Free models, ~50 calls/day',
    headers: { 'HTTP-Referer': 'https://freellmhub.app', 'X-Title': 'FreeLLM Hub' },
    models: [
      {
        id: 'nvidia/nemotron-3-super-120b-a12b:free',
        name: 'Nemotron 3 Super 120B A12B (free)',
        context: 262144,
        output: 8192,
      },
      {
        id: 'google/gemma-4-31b-it:free',
        name: 'Gemma 4 31B IT (free)',
        context: 131072,
        output: 8192,
      },
    ],
  },
  {
    id: 'modelscope',
    name: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    currency: 'CNY',
    caps: [...CHAT],
    price: 'free',
    priceNote: 'Free tier ~2000 calls/day',
    models: [
      {
        id: 'Qwen/Qwen3-235B-A22B',
        name: 'Qwen3 235B A22B',
        caps: ['chat', 'streaming', 'function-calling', 'json-mode'],
        context: 131072,
        output: 8192,
      },
      {
        id: 'deepseek-ai/DeepSeek-V3',
        name: 'DeepSeek V3',
        context: 131072,
        output: 8192,
      },
      {
        id: 'Qwen/Qwen3-32B',
        name: 'Qwen3 32B',
        caps: ['chat', 'streaming', 'function-calling'],
        context: 131072,
        output: 8192,
      },
    ],
  },
  {
    id: 'sensenova',
    name: 'SenseNova',
    baseUrl: 'https://token.sensenova.cn/v1',
    currency: 'CNY',
    caps: ['chat', 'streaming', 'function-calling', 'json-mode'],
    price: 'free',
    priceNote: 'Token Plan free beta, weekly credits',
    requestsPerMinute: 15,
    tokensPerMinute: 1000000,
    models: [
      {
        id: 'sensenova-6.8-flash-lite',
        name: 'SenseNova 6.8 Flash Lite',
        about: 'Multimodal agent model, free public beta',
        caps: ['chat', 'streaming', 'vision', 'function-calling', 'json-mode'],
        context: 262144,
        output: 65536,
      },
      {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        context: 1000000,
        output: 65536,
      },
      {
        id: 'glm-5.2',
        name: 'GLM 5.2',
        context: 1000000,
        output: 131072,
      },
    ],
  },
  {
    id: 'longcat',
    name: 'LongCat (美团)',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    currency: 'CNY',
    caps: [...CHAT],
    price: 'free',
    models: [
      { id: 'LongCat-Flash-Chat', name: 'LongCat Flash Chat', context: 131072 },
      { id: 'LongCat-Flash-Thinking', name: 'LongCat Flash Thinking', context: 131072 },
    ],
  },
  {
    id: 'zhipu',
    name: '智谱 AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    currency: 'CNY',
    caps: ['chat', 'streaming', 'function-calling', 'json-mode'],
    price: 'paid',
    models: [
      { id: 'glm-4-flash', name: 'GLM-4 Flash', price: 'free', context: 131072 },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air', context: 131072 },
      { id: 'glm-4-plus', name: 'GLM-4 Plus', context: 131072 },
    ],
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    currency: 'CNY',
    caps: ['chat', 'streaming', 'function-calling', 'json-mode'],
    price: 'paid',
    models: [
      {
        id: 'kimi-k2-0905-preview',
        name: 'Kimi K2 0905 Preview',
        caps: ['chat', 'streaming', 'function-calling', 'json-mode', 'vision'],
        context: 262144,
      },
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', context: 8192 },
      { id: 'moonshot-v1-auto', name: 'Moonshot v1 Auto', context: 131072 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    currency: 'CNY',
    caps: ['chat', 'streaming', 'function-calling', 'json-mode'],
    price: 'paid',
    priceNote: '低价按量计费，常有充值活动',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', context: 65536, output: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', context: 65536, output: 8192 },
    ],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    currency: 'CNY',
    caps: ['chat', 'streaming', 'function-calling'],
    price: 'freemium',
    models: [
      { id: 'MiniMax-M1', name: 'MiniMax M1', context: 800000 },
      { id: 'MiniMax-Text-01', name: 'MiniMax Text 01', context: 1000000 },
      {
        id: 'MiniMax-VL-01',
        name: 'MiniMax VL 01',
        caps: ['chat', 'streaming', 'function-calling', 'vision'],
        context: 1000000,
      },
    ],
  },
];

/** Indexed by provider id; the bootstrap registers from this list. */
export const PROVIDER_SEEDS_BY_ID: Record<string, ProviderSeed> = Object.fromEntries(
  BUILTIN_PROVIDER_SEEDS.map((seed) => [seed.id, seed])
);

export function builtInProviderIds(): string[] {
  return BUILTIN_PROVIDER_SEEDS.map((seed) => seed.id);
}

/**
 * Expand a seed into the wire shape the adapters, scheduler and UI already use.
 * The `supportsX` flags are projections of `supported`, never a second opinion.
 */
export function buildModel(provider: ProviderSeed, model: ModelSeed): ProviderModel {
  const supported = [...(model.caps ?? provider.caps)];
  const requestsPerMinute = model.requestsPerMinute ?? provider.requestsPerMinute;
  const tokensPerMinute = model.tokensPerMinute ?? provider.tokensPerMinute;

  return {
    id: model.id,
    providerId: provider.id,
    displayName: model.name ?? model.id,
    description: model.about,
    capabilities: buildCapabilities(supported, model.context, model.output),
    pricing: {
      type: model.price ?? provider.price,
      currency: provider.currency,
      notes: model.priceNote ?? provider.priceNote,
    },
    rateLimits:
      requestsPerMinute === undefined && tokensPerMinute === undefined
        ? undefined
        : { requestsPerMinute, tokensPerMinute },
    status: 'available',
    discoveredAt: new Date().toISOString(),
  };
}

export function buildModels(provider: ProviderSeed): ProviderModel[] {
  return provider.models.map((model) => buildModel(provider, model));
}
