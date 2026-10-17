import type {
  ProviderAdapter,
  ChatOptions,
  StreamChunk,
  ProviderConfig,
  ProviderModel,
  GatewayMessage,
  GatewayUsage,
  GatewayToolCall,
} from '../contracts.js';
import type { AuthType, ProviderConfigField, ProviderReadiness } from '../../../shared/types/index.js';
import { estimateTokenCount } from '../../../shared/utils/index.js';
import { buildCapabilities, GENERIC_CHAT_CAPS } from '../../../shared/utils/capabilities.js';
import { ProviderError } from '../../../shared/errors/index.js';
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
  /** User-created providers report isBuiltIn=false so the UI can group/delete them. */
  isBuiltIn?: boolean;
  /**
   * Short-lived credential source (OAuth). When present, `Authorization` is resolved
   * per request instead of being pinned to a static key, and a 401 triggers one
   * forced refresh before the error is surfaced.
   */
  tokenSource?: OAuthTokenSource;
}

export interface OAuthTokenStatus {
  authorized: boolean;
  expiresAt: string | null;
  refreshable: boolean;
  status: 'active' | 'expired' | 'revoked' | 'refreshing' | 'error' | 'unconfigured';
}

export interface OAuthTokenSource {
  /** A usable access token, refreshed proactively when it is close to expiry. */
  getToken(): Promise<string | null>;
  /** Force a refresh after the upstream rejected the current token. */
  refreshToken(): Promise<string | null>;
  /** Cheap, non-decrypting snapshot for `getProviderConfig()`. */
  status(): OAuthTokenStatus;
}

const BASE_URL_FIELD: ProviderConfigField = {
  key: 'baseUrl',
  label: 'Base URL',
  type: 'url',
  required: true,
  placeholder: 'https://api.example.com/v1',
};

/**
 * Chain-of-thought has no agreed field name: DeepSeek, Qwen, Kimi and vLLM publish
 * `reasoning_content`, while OpenRouter normalises to `reasoning`. Both are read here and
 * republished downstream under `reasoning_content`, which is what clients already branch on.
 */
function pickReasoning(primary?: string, fallback?: string): string | undefined {
  return primary || fallback || undefined;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly providerId: string;
  readonly providerName: string;
  /**
   * Not `readonly`: attaching an OAuth token source flips a provider from `api-key` to
   * `oauth`, and the scheduler uses `authType` to decide whether a credential is needed.
   */
  authType: AuthType;

  private baseUrl: string;
  private apiVersion?: string;
  private defaultHeaders: Record<string, string>;
  private knownModels: ProviderModel[];
  private credentialId?: string;
  private settings: Record<string, unknown>;
  private configFields: ProviderConfigField[];
  private requiredSettings: string[];
  private resolveBaseUrl?: (settings: Record<string, unknown>) => string | null;
  private builtIn: boolean;
  private enabled = true;
  private credentials: string[] = [];
  private credentialCursor = 0;
  private tokenSource?: OAuthTokenSource;

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
    this.builtIn = config.isBuiltIn !== false;
    this.tokenSource = config.tokenSource;
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
      isBuiltIn: this.builtIn,
      credentialStatus: this.resolveCredentialStatus(),
      credentialId: this.credentialId,
      settings: { ...this.settings },
      configFields: this.configFields,
      readiness: this.checkReadiness(),
    };
  }

  /**
   * An OAuth provider is only "configured" once a token exists, and `expired` is a
   * real state we can now report — previously that enum value was never written by
   * anything, so the UI could not distinguish "signed out" from "token needs a spin".
   */
  private resolveCredentialStatus(): ProviderConfig['credentialStatus'] {
    if (this.authType === 'none') return 'configured';
    if (this.tokenSource) {
      const status = this.tokenSource.status();
      if (!status.authorized) return 'unconfigured';
      if (status.status === 'expired' || status.status === 'revoked') return 'expired';
      return 'valid';
    }
    return this.credentialId ? 'configured' : 'unconfigured';
  }

  getOAuthStatus(): OAuthTokenStatus | null {
    return this.tokenSource?.status() ?? null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setCredential(credential: string | undefined, credentialId?: string): void {
    this.credentialId = credential ? credentialId || this.credentialId || credentialKeyFor(this.providerId) : undefined;
    this.credentials = credential ? [credential] : [];
    this.credentialCursor = 0;
    if (credential) {
      this.defaultHeaders = { ...this.defaultHeaders, Authorization: `Bearer ${credential}` };
    } else {
      delete this.defaultHeaders.Authorization;
    }
  }

  /** Replace the full key pool; the first key becomes active. */
  setCredentials(credentials: string[]): void {
    const cleaned = credentials.filter((c) => typeof c === 'string' && c.trim().length > 0);
    this.credentials = cleaned;
    this.credentialCursor = 0;
    if (cleaned.length > 0) {
      this.credentialId = this.credentialId || credentialKeyFor(this.providerId);
      this.defaultHeaders = { ...this.defaultHeaders, Authorization: `Bearer ${cleaned[0]}` };
    } else {
      this.credentialId = undefined;
      delete this.defaultHeaders.Authorization;
    }
  }

  private rotateCredential(): boolean {
    if (this.credentials.length < 2) return false;
    this.credentialCursor = (this.credentialCursor + 1) % this.credentials.length;
    this.defaultHeaders = {
      ...this.defaultHeaders,
      Authorization: `Bearer ${this.credentials[this.credentialCursor]}`,
    };
    return true;
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

  /**
   * Attach (or detach) an OAuth credential source after construction. Bootstrap uses
   * this because whether a provider is OAuth is data — it lives in the provider's
   * settings row — while adapters are built from factory code.
   */
  setTokenSource(source: OAuthTokenSource | undefined): void {
    this.tokenSource = source;
    if (source) {
      this.authType = 'oauth';
      this.credentialId = `${this.providerId}-oauth`;
      delete this.defaultHeaders.Authorization;
    } else if (this.authType === 'oauth') {
      this.authType = 'api-key';
      this.credentialId = undefined;
    }
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

    if (this.authType === 'oauth') {
      const status = this.tokenSource?.status();
      if (!status || !status.authorized) {
        return { ready: false, missingFields: ['credential'], reason: '尚未完成 OAuth 授权' };
      }
      if (status.status === 'expired' || status.status === 'revoked') {
        return { ready: false, missingFields: ['credential'], reason: 'OAuth 令牌已过期，请重新授权' };
      }
    }

    return { ready: true };
  }

  async isAvailable(): Promise<boolean> {
    if (!this.checkReadiness().ready) return false;
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: await this.buildRequestHeaders(),
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
        headers: await this.buildRequestHeaders(),
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
        headers: await this.buildRequestHeaders(),
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
  ): Promise<{
    content: string;
    toolCalls?: GatewayToolCall[];
    usage: GatewayUsage;
    finishReason: string;
  }> {
    const body = this.buildChatBody(messages, model, options, false);
    const maxAttempts = Math.max(1, this.credentials.length);
    let response: Response | undefined;
    let tokenRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: await this.buildRequestHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
          signal: withRequestTimeout(options?.signal),
        });
      } catch (err) {
        throw mapNetworkError(this.providerId, err);
      }
      if (response.ok) break;
      const errorText = await response.text();
      const error = mapHttpError(
        this.providerId,
        response.status,
        errorText,
        parseRetryAfterMs(response.headers.get('retry-after'))
      );
      if (!tokenRetried && (await this.tryRefreshAfterRejection(error))) {
        tokenRetried = true;
        continue;
      }
      if (attempt + 1 < maxAttempts && this.isKeyRetryable(error) && this.rotateCredential()) continue;
      throw error;
    }

    const result = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: GatewayToolCall[];
          reasoning_content?: string;
          reasoning?: string;
        };
        finish_reason?: string;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const choice = result.choices?.[0];
    const content = choice?.message?.content || '';
    const toolCalls = choice?.message?.tool_calls;
    const reasoningContent = pickReasoning(choice?.message?.reasoning_content, choice?.message?.reasoning);

    return {
      content,
      ...(toolCalls?.length ? { toolCalls } : {}),
      ...(reasoningContent ? { reasoningContent } : {}),
      usage: {
        promptTokens: result.usage?.prompt_tokens || estimateTokenCount(JSON.stringify(messages)),
        completionTokens:
          result.usage?.completion_tokens || estimateTokenCount(content + (reasoningContent || '')),
        totalTokens: result.usage?.total_tokens || 0,
      },
      finishReason: choice?.finish_reason || (toolCalls?.length ? 'tool_calls' : 'stop'),
    };
  }

  async *chatStream(
    messages: GatewayMessage[],
    model: string,
    options?: ChatOptions
  ): AsyncIterable<StreamChunk> {
    const body = this.buildChatBody(messages, model, options, true);
    const maxAttempts = Math.max(1, this.credentials.length);
    let response: Response | undefined;
    let tokenRetried = false;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: await this.buildRequestHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
          signal: withRequestTimeout(options?.signal),
        });
      } catch (err) {
        throw mapNetworkError(this.providerId, err);
      }
      if (response.ok && response.body) break;
      const errorText = response.ok ? 'Empty response body' : await response.text().catch(() => 'Unknown error');
      const error = response.ok
        ? new ProviderError(`Provider ${this.providerId} returned no stream`, this.providerId, 'SERVER_ERROR')
        : mapHttpError(
            this.providerId,
            response.status,
            errorText,
            parseRetryAfterMs(response.headers.get('retry-after'))
          );
      if (
        !tokenRetried &&
        error instanceof ProviderError &&
        (await this.tryRefreshAfterRejection(error))
      ) {
        tokenRetried = true;
        continue;
      }
      if (attempt + 1 < maxAttempts && this.isKeyRetryable(error) && this.rotateCredential()) continue;
      throw error;
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
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  reasoning?: string;
                  tool_calls?: unknown[];
                };
                finish_reason?: string;
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };

            const chunk: StreamChunk = {};
            const choice = parsed.choices?.[0];

            if (choice?.delta?.content) {
              chunk.content = choice.delta.content;
            }
            if (choice?.delta?.reasoning_content || choice?.delta?.reasoning) {
              chunk.reasoningContent = pickReasoning(choice.delta.reasoning_content, choice.delta.reasoning);
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

            // Reasoning models emit a delta per token with nothing in it but role and
            // empties; forwarding those multiplies SSE frames on the wire for no payload.
            if (chunk.content || chunk.reasoningContent || chunk.toolCalls || chunk.finishReason || chunk.usage) {
              yield chunk;
            }
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
      // An explicit credential always wins (the UI "test this key" path); otherwise ask
      // the OAuth source so testing an authorised provider does not send a bare request.
      const headers = credential
        ? this.buildHeaders({ Authorization: `Bearer ${credential}` })
        : await this.buildRequestHeaders();
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers,
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

  private isKeyRetryable(err: ProviderError): boolean {
    return (err.code === 'RATE_LIMITED' || err.code === 'AUTH_FAILED') && this.credentials.length > 1;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...extra,
    };
  }

  /**
   * Headers with the current credential resolved. For OAuth providers the access token
   * may have been rotated since `defaultHeaders` was last written, so the header is
   * rebuilt per request instead of cached.
   */
  private async buildRequestHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    if (!this.tokenSource) return this.buildHeaders(extra);
    const token = await this.tokenSource.getToken();
    const headers = this.buildHeaders(extra);
    if (token) headers.Authorization = `Bearer ${token}`;
    else delete headers.Authorization;
    return headers;
  }

  /**
   * An OAuth 401 is not "bad key" — it is an expired token the provider refused.
   * Refresh once and replay; a second 401 is reported as AUTH_FAILED so the scheduler
   * can fall back to another provider.
   */
  private async tryRefreshAfterRejection(err: ProviderError): Promise<boolean> {
    if (!this.tokenSource) return false;
    if (err.code !== 'AUTH_FAILED') return false;
    const refreshed = await this.tokenSource.refreshToken().catch(() => null);
    if (!refreshed) return false;
    this.defaultHeaders = { ...this.defaultHeaders, Authorization: `Bearer ${refreshed}` };
    return true;
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
      const formatted: Record<string, unknown> = { role: msg.role, content: msg.content };
      if (msg.name) formatted.name = msg.name;
      // A `tool` role message is meaningless to the upstream without the call it answers.
      if (msg.toolCallId) formatted.tool_call_id = msg.toolCallId;
      if (msg.toolCalls) {
        formatted.tool_calls = msg.toolCalls.map((tc: GatewayToolCall) => ({
          id: tc.id,
          type: tc.type,
          function: tc.function,
        }));
      }
      formattedMessages.push(formatted);
    }

    return {
      model,
      messages: formattedMessages,
      max_tokens: options?.maxTokens,
      temperature: options?.temperature,
      top_p: options?.topP,
      stop: options?.stop,
      tool_choice: options?.toolChoice,
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
      capabilities: buildCapabilities(GENERIC_CHAT_CAPS, 8192),
      pricing: { type: 'free', currency: 'USD' },
      status: 'available',
      discoveredAt: new Date().toISOString(),
    };
  }
}
