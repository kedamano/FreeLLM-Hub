export type ProviderId = string;

export type ModelCapability =
  | 'chat'
  | 'completion'
  | 'embedding'
  | 'vision'
  | 'function-calling'
  | 'json-mode'
  | 'streaming';

export type AuthType = 'api-key' | 'oauth' | 'none' | 'custom';

export type ModelPricingType = 'free' | 'freemium' | 'paid' | 'unknown' | 'local';

export interface ModelPricing {
  type: ModelPricingType;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  currency: string;
  notes?: string;
}

export interface ModelCapabilities {
  supported: ModelCapability[];
  contextWindow: number;
  maxOutputTokens?: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  supportsFunctionCalling: boolean;
  supportsJsonMode: boolean;
}

export interface ProviderModel {
  id: string;
  providerId: ProviderId;
  displayName: string;
  description?: string;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  rateLimits?: {
    requestsPerMinute?: number;
    tokensPerMinute?: number;
  };
  status: 'available' | 'limited' | 'unavailable' | 'unknown';
  discoveredAt: string;
  lastCheckedAt?: string;
}

export type ProviderConfigFieldType = 'url' | 'text' | 'password';

/**
 * A non-secret field the user may edit per provider. `key` is either the literal
 * `'baseUrl'` (handled by `updateBaseUrl`) or a name inside provider settings.
 */
export interface ProviderConfigField {
  key: string;
  label: string;
  type: ProviderConfigFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderReadiness {
  ready: boolean;
  reason?: string;
  missingFields?: string[];
}

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  authType: AuthType;
  baseUrl: string;
  apiVersion?: string;
  isEnabled: boolean;
  isBuiltIn: boolean;
  credentialStatus: 'unconfigured' | 'configured' | 'valid' | 'invalid' | 'expired';
  credentialId?: string;
  settings?: Record<string, unknown>;
  /** Editable non-secret fields rendered by the provider page. */
  configFields?: ProviderConfigField[];
  /** False when the provider cannot serve requests yet (missing key or account id). */
  readiness?: ProviderReadiness;
  metadata?: {
    icon?: string;
    docs?: string;
    tos?: string;
    description?: string;
  };
}

export const TASK_TYPES = [
  'general',
  'coding',
  'analysis',
  'creative',
  'summarization',
  'classification',
  'extraction',
  'translation',
  'lightweight',
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export interface GatewayRequest {
  requestId: string;
  messages: GatewayMessage[];
  model?: string;
  taskType?: TaskType;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  toolChoice?: unknown;
  stream?: boolean;
  tools?: unknown[];
  responseFormat?: { type: string };
}

/**
 * One OpenAI-style multimodal content part. `text` and `image_url` are interpreted by
 * the gateway; any other type is forwarded untouched so provider-specific parts
 * (`input_audio`, `file`) work without being redefined here.
 */
export interface GatewayContentPart {
  type: 'text' | 'image_url' | (string & {});
  text?: string;
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' };
}

/**
 * A message body: plain text, an array of multimodal parts, or null (which OpenAI uses
 * for assistant turns that carry only tool calls).
 */
export type GatewayContent = string | GatewayContentPart[] | null;

export interface GatewayMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: GatewayContent;
  name?: string;
  toolCallId?: string;
  toolCalls?: GatewayToolCall[];
}

export interface GatewayToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * Streaming form: providers split a call across chunks, so every field except the
 * positional `index` may be absent until the arguments finish arriving.
 */
export interface GatewayToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface GatewayResponse {
  requestId: string;
  model: string;
  providerId: ProviderId;
  content: string;
  /** Chain-of-thought some providers stream alongside `content` (`reasoning_content`). */
  reasoningContent?: string;
  toolCalls?: GatewayToolCall[];
  usage: GatewayUsage;
  finishReason: string;
  durationMs: number;
  createdAt: string;
}

export interface GatewayUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SchedulerDecision {
  model: ProviderModel;
  providerId: ProviderId;
  providerConfig: ProviderConfig;
  reason: string;
  score: number;
  estimatedCost: number;
}

export interface CallLog {
  id: string;
  requestId: string;
  timestamp: string;
  providerId: ProviderId;
  modelId: string;
  taskType?: TaskType;
  status: 'success' | 'error' | 'timeout' | 'rate_limited';
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  errorMessage?: string;
  totalTokens?: number;
  profileId?: string;
  statusCode?: number;
  stream?: boolean;
  attempt?: number;
  costUsd?: number;
  referenceCostUsd?: number;
  savedCostUsd?: number;
  pricingType?: ModelPricingType;
  currency?: string;
}

export interface DashboardStats {
  totalRequests: number;
  successRate: number;
  totalTokensUsed: number;
  totalCostSaved: number;
  totalCostUsd: number;
  activeProviders: number;
  availableModels: number;
  recentCalls: CallLog[];
  providerStats: ProviderUsageStat[];
}

export interface ProviderUsageStat {
  providerId: ProviderId;
  providerName: string;
  requestCount: number;
  tokenCount: number;
  successCount: number;
  errorCount: number;
  costUsd?: number;
  savedCostUsd?: number;
  avgDurationMs?: number;
}

export const DEFAULT_TASK_TYPE: TaskType = 'general';
