import type {
  ProviderConfig,
  ProviderModel,
  GatewayMessage,
  GatewayUsage,
  GatewayToolCall,
  GatewayToolCallDelta,
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
  GatewayContent,
  GatewayContentPart,
  GatewayUsage,
  GatewayToolCall,
  GatewayToolCallDelta,
} from '../../shared/types/index.js';

export interface StreamChunk {
  content?: string;
  /** Chain-of-thought delta (`delta.reasoning_content`), kept apart from the answer. */
  reasoningContent?: string;
  finishReason?: string;
  usage?: GatewayUsage;
  toolCalls?: GatewayToolCallDelta[];
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
    toolCalls?: GatewayToolCall[];
    /** Chain-of-thought (`message.reasoning_content`), never merged into `content`. */
    reasoningContent?: string;
    usage: GatewayUsage;
    finishReason: string;
  }>;

  chatStream(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): AsyncIterable<StreamChunk>;

  /**
   * Embeddings pass-through (/v1/embeddings). Optional: only adapters whose provider
   * actually serves embedding models implement it. `input` accepts a string, an array
   * of strings, or token arrays and is forwarded verbatim.
   */
  embeddings?(input: {
    model: string;
    input: string | string[] | number[];
    encoding_format?: 'float' | 'base64';
  }): Promise<{
    model: string;
    data: Array<{ index: number; embedding: number[] | string }>;
    usage: GatewayUsage;
  }>;

  validateCredential(credential?: string): Promise<{ valid: boolean; reason?: string }>;

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
  topP?: number;
  stop?: string | string[];
  toolChoice?: unknown;
  systemPrompt?: string;
  tools?: unknown[];
  responseFormat?: { type: string };
  signal?: AbortSignal;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  unregister(providerId: string): void;
  get(providerId: string): ProviderAdapter | undefined;
  getAll(): ProviderAdapter[];
}

export type ProviderFactory = (credential?: string) => ProviderAdapter;
