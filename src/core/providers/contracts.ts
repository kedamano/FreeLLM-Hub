import type {
  ProviderConfig,
  ProviderModel,
  GatewayMessage,
  GatewayUsage,
  ModelCapability,
  ProviderReadiness,
} from '../../shared/types/index.js';

// Re-export shared types for adapter consumers
export type {
  GatewayRequest,
  ModelCapability,
  ProviderConfig,
  ProviderConfigField,
  ProviderModel,
  ProviderReadiness,
  GatewayMessage,
  GatewayUsage,
  GatewayToolCall,
} from '../../shared/types/index.js';

export interface StreamChunk {
  content?: string;
  finishReason?: string;
  usage?: GatewayUsage;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly authType: ProviderConfig['authType'];

  getProviderConfig(): ProviderConfig;

  isAvailable(): Promise<boolean>;

  listModels(): Promise<ProviderModel[]>;

  getModel(modelId: string): Promise<ProviderModel | null>;

  chat(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): Promise<{
    content: string;
    usage: GatewayUsage;
    finishReason: string;
  }>;

  chatStream(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): AsyncIterable<StreamChunk>;

  validateCredential(credential?: string): Promise<{ valid: boolean; reason?: string }>;

  getUsageInfo?(): Promise<ProviderUsageInfo>;

  /** Whether the provider can serve requests right now (key + required fields present). */
  checkReadiness?(): ProviderReadiness;

  /**
   * Runtime reconfiguration hooks. Adapters that cannot honour one of these simply
   * leave it undefined; the IPC layer reports a real error instead of a fake success.
   */
  setEnabled?(enabled: boolean): void;

  updateBaseUrl?(baseUrl: string): void;

  updateSettings?(settings: Record<string, unknown>): void;

  setCredential?(credential: string | undefined, credentialId?: string): void;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  tools?: unknown[];
  responseFormat?: { type: string };
  signal?: AbortSignal;
}

export interface ProviderUsageInfo {
  remainingRequests?: number;
  remainingTokens?: number;
  resetTime?: string;
  quotaUsed?: number;
  quotaTotal?: number;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  unregister(providerId: string): void;
  get(providerId: string): ProviderAdapter | undefined;
  getAll(): ProviderAdapter[];
  getByCapability(capability: ModelCapability): ProviderAdapter[];
  getAvailable(): Promise<ProviderAdapter[]>;
}

export type ProviderFactory = (credential?: string) => ProviderAdapter;
