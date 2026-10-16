import type {
  ProviderAdapter,
  ChatOptions,
  StreamChunk,
  ProviderUsageInfo,
  ProviderConfig,
  ProviderModel,
  GatewayMessage,
  GatewayUsage,
  GatewayToolCall,
} from '../contracts.js';
import type { AuthType, ProviderConfigField, ProviderReadiness } from '../../../shared/types/index.js';
import { estimateTokenCount } from '../../../shared/utils/index.js';
import { credentialKeyFor } from '../credential-keys.js';
import {
  mapHttpError,
  mapNetworkError,
  parseRetryAfterMs,
  withRequestTimeout,
} from '../request-errors.js';

export interface OpenAICompatibleConfig {
  providerId: string;
  providerName: string;
  baseUrl: string;
  apiVersion?: string;
  authType: AuthType;
  defaultHeaders?: Record<string, string>;
  models?: ProviderModel[];
  credentialId?: string;
  settings?: Record<string, unknown>;
  /** Editable non-secret fields surfaced to the UI. `baseUrl` is added automatically. */
  configFields?: ProviderConfigField[];
  /** Settings keys without which the provider cannot be called (e.g. `accountId`). */
  requiredSettings?: string[];
  /** Recompute the effective baseUrl after a settings edit. Return null to keep the previous one. */
  resolveBaseUrl?: (settings: Record<string, unknown>) => string | null;
}

const BASE_URL_FIELD: ProviderConfigField = {
  key: 'baseUrl',
  label: 'Base URL',
  type: 'url',
  required: true,
  placeholder: 'https://api.example.com/v1',
};

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly authType: AuthType;

  private baseUrl: string;
  private apiVersion?: string;
  private defaultHeaders: Record<string, string>;
  private knownModels: ProviderModel[];
  private credentialId?: string;
  private settings: Record<string, unknown>;
  private configFields: ProviderConfigField[];
  private requiredSettings: string[];
  private resolveBaseUrl?: (settings: Record<string, unknown>) => string | null;
  private enabled = true;

  constructor(config: OpenAICompatibleConfig) {
    this.providerId = config.providerId;
    this.providerName = config.providerName;
    this.authType = config.authType;
    this.apiVersion = config.apiVersion;
    this.defaultHeaders = config.defaultHeaders || {};
    this.knownModels = config.models || [];
    this.credentialId = config.credentialId;
    this.settings = { ...(config.settings || {}) };
    this.requiredSettings = config.requiredSettings || [];
    this.resolveBaseUrl = config.resolveBaseUrl;
    this.baseUrl = this.computeBaseUrl(config.baseUrl);
    this.configFields = [
      BASE_URL_FIELD,
      ...(config.configFields || []).filter((f) => f.key !== 'baseUrl'),
    ];
  }

  private computeBaseUrl(fallback: string): string {
    if (!this.resolveBaseUrl) return fallback.replace(/\/$/, '');
    const resolved = this.resolveBaseUrl(this.settings);
    return (resolved ?? fallback).replace(/\/$/, '');
  }

  getProviderConfig(): ProviderConfig {
    return {
      id: this.providerId,
      displayName: this.providerName,
      authType: this.authType,
      baseUrl: this.baseUrl,
      apiVersion: this.apiVersion,
      isEnabled: this.enabled,
      isBuiltIn: true,
      credentialStatus: this.authType === 'none' ? 'configured' : this.credentialId ? 'configured' : 'unconfigured',
      credentialId: this.credentialId,
      settings: { ...this.settings },
      configFields: this.configFields,
      readiness: this.checkReadiness(),
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setCredential(credential: string | undefined, credentialId?: string): void {
    this.credentialId = credential ? credentialId || this.credentialId || credentialKeyFor(this.providerId) : undefined;
    if (credential) {
      this.defaultHeaders = { ...this.defaultHeaders, Authorization: `Bearer ${credential}` };
    } else {
      delete this.defaultHeaders.Authorization;
    }
  }

  updateBaseUrl(baseUrl: string): void {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    if (this.baseUrl) {
      this.settings = { ...this.settings, baseUrlOverride: this.baseUrl };
    }
  }

  updateSettings(settings: Record<string, unknown>): void {
    const merged = { ...this.settings };
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'baseUrl') continue;
      if (typeof value === 'string' ? value.trim().length === 0 : value === undefined) {
        delete merged[key];
        continue;
      }
      merged[key] = value;
    }
    this.settings = merged;
    if (this.resolveBaseUrl) {
      const resolved = this.resolveBaseUrl(merged);
      if (resolved) this.baseUrl = resolved.replace(/\/$/, '');
    }
  }

  setCredentialId(credentialId: string | undefined): void {
    this.credentialId = credentialId;
  }

  checkReadiness(): ProviderReadiness {
    if (!this.enabled) return { ready: false, reason: '服务商已禁用' };

    const missingFields = this.requiredSettings.filter((key) => {
      const value = this.settings[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (missingFields.length > 0) {
      const labels = missingFields.map(
        (key) => this.configFields.find((f) => f.key === key)?.label || key
      );
      return {
        ready: false,
        missingFields,
        reason: `缺少必填配置: ${labels.join('、')}`,
      };
    }

    if (this.baseUrl.includes('{') || this.baseUrl.includes('}')) {
      return { ready: false, reason: 'Base URL 仍含未填充的占位符' };
    }

    if (this.authType === 'api-key' && !this.credentialId) {
      return { ready: false, missingFields: ['credential'], reason: '尚未配置 API Key' };
    }

    return { ready: true };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.checkReadiness().ready) return false;
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<ProviderModel[]> {
    const readiness = this.checkReadiness();
    if (!readiness.ready) {
      // Never send a request to a half-configured endpoint (e.g. a base URL that still
      // needs an account id). Surface the catalog as unavailable instead of 404-ing.
      return this.knownModels.map((m) => ({
        ...m,
        status: 'unavailable' as const,
        description: m.description ?? readiness.reason,
      }));
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) {
        return this.knownModels;
      }

      const data = (await response.json()) as { data?: Array<{ id: string; [key: string]: unknown }> };
      if (data.data && Array.isArray(data.data)) {
        return data.data.map((m) => this.mapToProviderModel(m.id));
      }

      return this.knownModels;
    } catch {
      return this.knownModels;
    }
  }

  async getModel(modelId: string): Promise<ProviderModel | null> {
    const found = this.knownModels.find((m) => m.id === modelId);
    if (found) return found;

    try {
      const response = await fetch(`${this.baseUrl}/models/${modelId}`, {
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        await response.json();
        return this.mapToProviderModel(modelId);
      }
    } catch {
      return null;
    }

    return null;
  }

  async chat(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): Promise<{ content: string; usage: GatewayUsage; finishReason: string }> {
    const body = this.buildChatBody(messages, model, options, false);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: withRequestTimeout(options?.signal),
      });
    } catch (err) {
      throw mapNetworkError(this.providerId, err);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw mapHttpError(
        this.providerId,
        response.status,
        errorText,
        parseRetryAfterMs(response.headers.get('retry-after'))
      );
    }

    const result = (await response.json()) as {
      choices?: Array<{ message?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const choice = result.choices?.[0];
    const content = choice?.message?.content || '';

    return {
      content,
      usage: {
        promptTokens: result.usage?.prompt_tokens || estimateTokenCount(JSON.stringify(messages)),
        completionTokens: result.usage?.completion_tokens || estimateTokenCount(content),
        totalTokens: result.usage?.total_tokens || 0,
      },
      finishReason: choice?.finish_reason || 'stop',
    };
  }

  async *chatStream(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const body = this.buildChatBody(messages, model, options, true);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: withRequestTimeout(options?.signal),
      });
    } catch (err) {
      throw mapNetworkError(this.providerId, err);
    }

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw mapHttpError(
        this.providerId,
        response.status,
        errorText,
        parseRetryAfterMs(response.headers.get('retry-after'))
      );
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
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6);
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string; tool_calls?: unknown[] }; finish_reason?: string }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };

            const chunk: StreamChunk = {};
            const choice = parsed.choices?.[0];

            if (choice?.delta?.content) {
              chunk.content = choice.delta.content;
            }
            if (choice?.finish_reason) {
              chunk.finishReason = choice.finish_reason;
            }
            if (parsed.usage) {
              chunk.usage = {
                promptTokens: parsed.usage.prompt_tokens || 0,
                completionTokens: parsed.usage.completion_tokens || 0,
                totalTokens: parsed.usage.total_tokens || 0,
              };
            }
            if (choice?.delta?.tool_calls) {
              chunk.toolCalls = choice.delta.tool_calls as StreamChunk['toolCalls'];
            }

            yield chunk;
          } catch {
            // Skip malformed SSE data
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async validateCredential(credential?: string): Promise<{ valid: boolean; reason?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: this.buildHeaders(credential ? { Authorization: `Bearer ${credential}` } : {}),
        signal: AbortSignal.timeout(8000),
      });

      if (response.ok) {
        return { valid: true };
      }

      if (response.status === 401 || response.status === 403) {
        return { valid: false, reason: 'Invalid or missing API key' };
      }

      return { valid: false, reason: `Server returned status ${response.status}` };
    } catch (err) {
      return { valid: false, reason: err instanceof Error ? err.message : 'Connection failed' };
    }
  }

  async getUsageInfo(): Promise<ProviderUsageInfo> {
    return {};
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...extra,
    };
  }

  private buildChatBody(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions,
    stream?: boolean
  ): Record<string, unknown> {
    const formattedMessages: Array<Record<string, unknown>> = [];

    if (options?.systemPrompt) {
      formattedMessages.push({ role: 'system', content: options.systemPrompt });
    }

    for (const msg of messages) {
      if (msg.toolCalls) {
        formattedMessages.push({
          role: msg.role,
          content: msg.content,
          tool_calls: msg.toolCalls.map((tc: GatewayToolCall) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function,
          })),
        });
      } else {
        formattedMessages.push({ role: msg.role, content: msg.content });
      }
    }

    return {
      model,
      messages: formattedMessages,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      stream: stream || false,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      tools: options?.tools,
      response_format: options?.responseFormat,
    };
  }

  private mapToProviderModel(modelId: string): ProviderModel {
    const known = this.knownModels.find((m) => m.id === modelId);
    if (known) return known;

    return {
      id: modelId,
      providerId: this.providerId,
      displayName: modelId,
      capabilities: {
        supported: ['chat', 'completion', 'streaming'],
        contextWindow: 8192,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
      pricing: { type: 'unknown', currency: 'USD' },
      status: 'unknown',
      discoveredAt: new Date().toISOString(),
    };
  }
}
