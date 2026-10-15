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
import type { ModelCapability } from '../../../shared/types/index.js';

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
  private knownModels: ProviderModel[] = [];

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
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'configured',
      metadata: {
        description: '通过 Ollama 在本地运行开源大模型',
      },
    };
  }

  async isAvailable(): Promise<boolean> {
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
            ? { ...known, status: 'available', lastCheckedAt: new Date().toISOString() }
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

    const response = await fetch(`${this.baseUrl}/api/chat`, {
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
      signal: options?.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${err}`);
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

    const response = await fetch(`${this.baseUrl}/api/chat`, {
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
      signal: options?.signal,
    });

    if (!response.ok || !response.body) {
      const err = await response.text().catch(() => 'Unknown error');
      throw new Error(`Ollama stream failed (${response.status}): ${err}`);
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
  ): Array<{ role: string; content: string }> {
    const result: Array<{ role: string; content: string }> = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.content) {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }
}

export function createOllamaAdapter(config?: OllamaConfig): OllamaAdapter {
  return new OllamaAdapter(config);
}
