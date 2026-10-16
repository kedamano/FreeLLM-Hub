import type {
  ProviderAdapter,
  ChatOptions,
  StreamChunk,
  ProviderUsageInfo,
  ProviderConfig,
  ProviderModel,
  GatewayMessage,
  GatewayUsage,
} from '../contracts.js';
import { estimateTokenCount } from '../../../shared/utils/index.js';
import { contentToImages, contentToText } from '../../../shared/utils/content.js';
import type { ModelCapability, ProviderConfigField, ProviderReadiness } from '../../../shared/types/index.js';
import { mapHttpError, mapNetworkError, withRequestTimeout } from '../request-errors.js';
import { ProviderError } from '../../../shared/errors/index.js';

const OLLAMA_CONFIG_FIELDS: ProviderConfigField[] = [
  {
    key: 'baseUrl',
    label: 'Ollama 服务地址',
    type: 'url',
    required: true,
    placeholder: 'http://localhost:11434',
    help: '默认本机 11434 端口；远程部署时填写可访问的 http(s) 地址',
  },
];

export interface OllamaConfig {
  baseUrl?: string;
  models?: Array<{
    id: string;
    displayName: string;
    contextWindow?: number;
    capabilities?: ModelCapability[];
    supportsVision?: boolean;
    supportsFunctionCalling?: boolean;
  }>;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly providerId = 'ollama';
  readonly providerName = 'Ollama (本地)';
  readonly authType = 'none' as const;

  private baseUrl: string;
  private settings: Record<string, unknown> = {};
  private enabled = true;
  private knownModels: ProviderModel[] = [];
  private modelsRequest: Promise<ProviderModel[]> | null = null;

  constructor(config?: OllamaConfig) {
    this.baseUrl = (config?.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    this.knownModels = (config?.models || []).map((m) => ({
      id: m.id,
      providerId: 'ollama',
      displayName: m.displayName || m.id,
      capabilities: {
        supported: m.capabilities || ['chat', 'completion', 'streaming'],
        contextWindow: m.contextWindow || 8192,
        supportsStreaming: true,
        supportsVision: m.supportsVision || false,
        supportsFunctionCalling: m.supportsFunctionCalling || false,
        supportsJsonMode: false,
      },
      pricing: { type: 'local', currency: 'USD', notes: '免费本地推理' },
      status: 'available',
      discoveredAt: new Date().toISOString(),
    }));
  }

  getProviderConfig(): ProviderConfig {
    return {
      id: 'ollama',
      displayName: 'Ollama (本地推理)',
      authType: 'none',
      baseUrl: this.baseUrl,
      isEnabled: this.enabled,
      isBuiltIn: true,
      credentialStatus: 'configured',
      settings: { ...this.settings },
      configFields: OLLAMA_CONFIG_FIELDS,
      readiness: this.checkReadiness(),
      metadata: {
        description: '通过 Ollama 在本地运行开源大模型',
      },
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  updateSettings(settings: Record<string, unknown>): void {
    this.settings = { ...this.settings, ...settings };
  }

  checkReadiness(): ProviderReadiness {
    if (!this.enabled) return { ready: false, reason: '服务商已禁用' };
    if (!/^https?:\/\//i.test(this.baseUrl)) return { ready: false, reason: 'Ollama 服务地址无效' };
    return { ready: true };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.checkReadiness().ready) return false;
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    if (!this.checkReadiness().ready) return [];
    if (this.modelsRequest) return this.modelsRequest;
    this.modelsRequest = this.fetchModels().finally(() => {
      this.modelsRequest = null;
    });
    return this.modelsRequest;
  }

  private async fetchModels(): Promise<ProviderModel[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) return this.knownModels;

      const data = (await response.json()) as {
        models?: Array<{ name: string; size?: number; details?: Record<string, unknown> }>;
      };

      if (data.models && data.models.length > 0) {
        const models: ProviderModel[] = data.models.map((m) => {
          const known = this.knownModels.find((k) => k.id === m.name);
          return known
            ? { ...known, status: 'available' as const, lastCheckedAt: new Date().toISOString() }
            : {
                id: m.name,
                providerId: 'ollama',
                displayName: m.name,
                capabilities: {
                  supported: ['chat', 'completion', 'streaming'] as ModelCapability[],
                  contextWindow: 8192,
                  supportsStreaming: true,
                  supportsVision: false,
                  supportsFunctionCalling: false,
                  supportsJsonMode: false,
                },
                pricing: { type: 'local' as const, currency: 'USD', notes: '本地免费推理' },
                status: 'available' as const,
                discoveredAt: new Date().toISOString(),
                lastCheckedAt: new Date().toISOString(),
              };
        });

        this.knownModels = models;
        return models;
      }

      return this.knownModels;
    } catch {
      return this.knownModels;
    }
  }

  async getModel(modelId: string): Promise<ProviderModel | null> {
    const models = await this.listModels();
    return models.find((m) => m.id === modelId) || null;
  }

  async chat(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage: GatewayUsage; finishReason: string }> {
    const ollamaMessages = this.convertMessages(messages, options?.systemPrompt);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: ollamaMessages,
          stream: false,
          options: {
            num_predict: options?.maxTokens,
            temperature: options?.temperature,
          },
        }),
        signal: withRequestTimeout(options?.signal),
      });
    } catch (err) {
      throw mapNetworkError(this.providerId, err);
    }

    if (!response.ok) {
      const err = await response.text();
      throw mapHttpError(this.providerId, response.status, err);
    }

    const result = (await response.json()) as {
      message?: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
      done: boolean;
    };

    const content = result.message?.content || '';

    return {
      content,
      usage: {
        promptTokens: result.prompt_eval_count || estimateTokenCount(JSON.stringify(messages)),
        completionTokens: result.eval_count || estimateTokenCount(content),
        totalTokens: (result.prompt_eval_count || 0) + (result.eval_count || 0),
      },
      finishReason: result.done ? 'stop' : 'length',
    };
  }

  async *chatStream(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const ollamaMessages = this.convertMessages(messages, options?.systemPrompt);

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: ollamaMessages,
          stream: true,
          options: {
            num_predict: options?.maxTokens,
            temperature: options?.temperature,
          },
        }),
        signal: withRequestTimeout(options?.signal),
      });
    } catch (err) {
      throw mapNetworkError(this.providerId, err);
    }

    if (!response.ok || !response.body) {
      const err = await response.text().catch(() => 'Unknown error');
      throw mapHttpError(this.providerId, response.status, err);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed) as {
              done: boolean;
              message?: { content: string };
              prompt_eval_count?: number;
              eval_count?: number;
            };

            if (parsed.message?.content) {
              yield { content: parsed.message.content };
            }
            if (parsed.done) {
              if (parsed.prompt_eval_count || parsed.eval_count) {
                yield {
                  usage: {
                    promptTokens: parsed.prompt_eval_count || 0,
                    completionTokens: parsed.eval_count || 0,
                    totalTokens: (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0),
                  },
                  finishReason: 'stop',
                };
              }
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async validateCredential(): Promise<{ valid: boolean; reason?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) return { valid: true };
      return { valid: false, reason: `HTTP ${response.status}` };
    } catch (err) {
      return {
        valid: false,
        reason: `无法连接到 Ollama (${this.baseUrl}): ${err instanceof Error ? err.message : '连接失败'}`,
      };
    }
  }

  async getUsageInfo(): Promise<ProviderUsageInfo> {
    return { remainingTokens: Infinity, quotaTotal: Infinity };
  }

  private convertMessages(
    messages: GatewayMessage[],
    systemPrompt?: string
  ): Array<{ role: string; content: string; images?: string[] }> {
    const result: Array<{ role: string; content: string; images?: string[] }> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      const text = contentToText(msg.content);
      // Ollama has no structured content field: the parts collapse into `content` and the
      // images move to its `images` array. Nothing is fetched here — a remote URL is
      // handed to the local Ollama server unchanged so this process never becomes the
      // one that reaches out to an arbitrary host.
      const images = contentToImages(msg.content).map(stripDataUrlPrefix).filter((img) => img.length > 0);
      if (!text && images.length === 0) continue;
      result.push({ role: msg.role, content: text, ...(images.length ? { images } : {}) });
    }

    return result;
  }
}

/** Ollama expects bare base64, so the `data:<mime>;base64,` envelope is removed. */
function stripDataUrlPrefix(url: string): string {
  const match = /^data:[^;]*;base64,(.*)$/s.exec(url);
  return match ? match[1] : url;
}

export function createOllamaAdapter(config?: OllamaConfig): OllamaAdapter {
  return new OllamaAdapter(config);
}
