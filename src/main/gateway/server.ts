import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { Scheduler } from '../../scheduler/scheduler.js';
import { recordCall } from '../../usage/usage-recorder.js';
import { getProviderRegistry } from '../../core/providers/registry.js';
import type {
  GatewayRequest,
  ProviderId,
} from '../../shared/types/index.js';
import { generateRequestId } from '../../shared/utils/index.js';
import {
  AllProvidersFailedError,
  AuthenticationError,
  FreeLLMError,
  ProviderError,
  RateLimitError,
} from '../../shared/errors/index.js';
import { TASK_TYPES, type TaskType } from '../../shared/types/index.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { getAppConfig } from '../../core/config/app-config.js';
import { readSetting } from '../../core/settings/settings-store.js';
import { registerCommonMiddleware } from './middleware.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

function isSelfUrl(baseUrl: string | undefined, host: string, port: number): boolean {
  if (!baseUrl) return false;
  try {
    const u = new URL(baseUrl);
    const h = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
    return h === host && Number(u.port || 80) === port;
  } catch {
    return false;
  }
}

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  scheduler: Scheduler;
  authValidator?: (token: string) => boolean;
}

export interface GatewayStatus {
  running: boolean;
  host: string;
  port: number;
  url: string;
  lastError: string | null;
}

export class GatewayServer {
  private app: FastifyInstance | null = null;
  private scheduler: Scheduler;
  private host: string;
  private port: number;
  private configuredPort: number;
  private authValidator?: (token: string) => boolean;
  private lastError: string | null = null;

  constructor(options: GatewayServerOptions) {
    this.scheduler = options.scheduler;
    this.host = options.host || '127.0.0.1';
    this.port = options.port ?? 0;
    this.configuredPort = this.port;
    this.authValidator = options.authValidator;
  }

  async start(): Promise<{ host: string; port: number }> {
    if (!LOOPBACK_HOSTS.has(this.host)) {
      this.lastError = `Gateway host must be loopback (127.0.0.1 or localhost), got: ${this.host}`;
      throw new Error(this.lastError);
    }

    this.app = Fastify({
      logger: {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: { colorize: false, destination: resolveGatewayLogFile() },
        },
      },
      bodyLimit: 10 * 1024 * 1024,
    });

    await this.app.register(cors, {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (LOCAL_ORIGIN.test(origin)) return callback(null, true);
        callback(null, false);
      },
    });

    if (this.authValidator) {
      this.app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        if (request.url === '/health' || request.url?.startsWith('/health')) return;

        const authHeader = request.headers.authorization;
        if (!authHeader) {
          return reply.status(401).send({
            error: { message: 'Missing authorization header. Use: Bearer <token>', type: 'auth_required' },
          });
        }

        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        if (!this.authValidator!(token)) {
          return reply.status(403).send({
            error: { message: 'Invalid token', type: 'auth_failed' },
          });
        }
      });
    }

    this.registerRoutes();
    registerCommonMiddleware(this.app);

    try {
      await this.app.listen({ host: this.host, port: this.port });
    } catch (err) {
      this.lastError = redactSecrets(err instanceof Error ? err.message : String(err));
      const app = this.app;
      this.app = null;
      await app?.close().catch(() => undefined);
      throw err;
    }

    this.lastError = null;
    const address = this.app.server.address();
    if (address && typeof address !== 'string') {
      this.port = address.port;
    }

    return { host: this.host, port: this.port };
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
    }
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.host;
  }

  getUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  isRunning(): boolean {
    return this.app !== null;
  }

  getStatus(): GatewayStatus {
    const running = this.isRunning();
    return {
      running,
      host: this.host,
      port: running ? this.port : this.configuredPort,
      url: running ? this.getUrl() : '',
      lastError: this.lastError,
    };
  }

  private registerRoutes(): void {
    if (!this.app) return;

    this.app.get('/health', async () => ({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '0.1.0',
    }));

    this.app.get('/v1/models', async () => {
      const registry = getProviderRegistry();
      const adapters = registry.getAll();
      const models: Array<Record<string, unknown>> = [];
      const selfList = this.app!.addresses();
      const selfAddr = selfList.length > 0 ? selfList[0] : null;

      for (const adapter of adapters) {
        const config = adapter.getProviderConfig();
        if (!config.isEnabled) continue;
        // A provider pointed back at this gateway would recurse forever.
        if (selfAddr && isSelfUrl(config.baseUrl, selfAddr.address, selfAddr.port)) continue;
        try {
          const providerModels = await adapter.listModels();
          for (const m of providerModels) {
            models.push({
              id: m.id,
              object: 'model',
              created: Date.now(),
              owned_by: m.providerId,
              provider: m.providerId,
            });
          }
        } catch {
          // Skip unreachable providers
        }
      }

      return { object: 'list', data: models };
    });

    this.app.get<{
      Querystring: { providerId?: string };
    }>('/admin/discover-models', async (request) => {
      const registry = getProviderRegistry();
      const providerId = request.query.providerId;

      if (providerId) {
        const adapter = registry.get(providerId);
        if (!adapter) return { success: false, error: 'Provider not found', models: [] };
        const models = await adapter.listModels();
        return { success: true, providerId, modelsFound: models.length, models };
      }

      const adapters = registry.getAll();
      const results: Array<{ providerId: string; modelsFound: number; error?: string }> = [];
      const allModels: Array<Record<string, unknown>> = [];

      for (const adapter of adapters) {
        if (!adapter.getProviderConfig().isEnabled) continue;
        try {
          const pmodels = await adapter.listModels();
          results.push({ providerId: adapter.providerId, modelsFound: pmodels.length });
          allModels.push(...pmodels.map((m) => ({ ...m, provider: m.providerId })));
        } catch (err) {
          results.push({
            providerId: adapter.providerId,
            modelsFound: 0,
            error: redactSecrets(err instanceof Error ? err.message : String(err)),
          });
        }
      }

      return { success: true, totalModels: allModels.length, results, models: allModels };
    });

    this.app.post<{
      Body: {
        model?: string;
        messages: Array<{ role: string; content: string }>;
        max_tokens?: number;
        temperature?: number;
        stream?: boolean;
        tools?: unknown[];
        response_format?: { type: string };
        task_type?: string;
      };
    }>('/v1/chat/completions', async (request, reply) => {
      const body = request.body;
      const requestId = generateRequestId();
      const startTime = Date.now();

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return reply.status(400).send({
          error: {
            message: 'messages field is required and must be a non-empty array',
            type: 'invalid_request',
            code: 'BAD_REQUEST',
          },
        });
      }

      const gatewayRequest: GatewayRequest = {
        requestId,
        messages: body.messages.map((m) => ({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: m.content,
        })),
        model: body.model,
        taskType: parseTaskType(body.task_type) ?? parseTaskType(readSetting('default_task_type')),
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        stream: body.stream,
        tools: body.tools,
        responseFormat: body.response_format,
      };

      if (body.stream) {
        return this.handleStreamRequest(reply, gatewayRequest, startTime);
      }

      return this.handleNonStreamRequest(reply, gatewayRequest, startTime);
    });
  }

  private async handleNonStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    startTime: number
  ) {
    try {
      const result = await this.scheduler.execute(request);

      recordCall({
        requestId: request.requestId,
        providerId: result.providerId,
        modelId: result.model,
        taskType: request.taskType,
        status: 'success',
        durationMs: result.durationMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
      });

      const response = {
        id: request.requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        provider: result.providerId,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.content, finish_reason: result.finishReason },
            finish_reason: result.finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage.promptTokens,
          completion_tokens: result.usage.completionTokens,
          total_tokens: result.usage.totalTokens,
        },
      };

      return reply.send(response);
    } catch (err) {
      const desc = describeError(err);
      recordCall({
        requestId: request.requestId,
        providerId: (extractProviderId(err) ?? 'unknown') as ProviderId,
        modelId: request.model ?? 'unknown',
        taskType: request.taskType,
        status: desc.code === 'RATE_LIMITED' ? 'rate_limited' : 'error',
        durationMs: Date.now() - startTime,
        promptTokens: 0,
        completionTokens: 0,
        errorMessage: redactSecrets(getSafeErrorMessage(err)),
      });

      if (desc.retryAfterSeconds) reply.header('Retry-After', String(desc.retryAfterSeconds));
      return reply.status(desc.status).send({
        error: {
          message: redactSecrets(getSafeErrorMessage(err)),
          type: desc.type,
          code: desc.code,
        },
      });
    }
  }

  private handleStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    startTime: number
  ) {
    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const stream = this.scheduler.executeStream(request);
    let clientGone = false;
    let closed = false;

    const closeStream = () => {
      if (closed) return;
      closed = true;
      void Promise.resolve(stream.return(undefined as never)).catch(() => undefined);
    };

    raw.on('close', () => {
      clientGone = true;
      closeStream();
    });
    raw.on('error', () => {
      clientGone = true;
      closeStream();
    });

    const write = (data: string): Promise<void> =>
      new Promise<void>((resolveWrite) => {
        if (clientGone || raw.writableEnded) return resolveWrite();
        if (raw.write(data)) resolveWrite();
        else raw.once('drain', () => resolveWrite());
      });

    (async () => {
      let providerId: ProviderId = 'unknown';
      let modelId = request.model ?? 'unknown';
      let finishReason = 'stop';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      try {
        for await (const chunk of stream) {
          if (clientGone) break;
          providerId = chunk.providerId ?? providerId;
          modelId = chunk.model ?? modelId;
          if (chunk.finishReason) finishReason = chunk.finishReason;
          if (chunk.usage) usage = chunk.usage;

          const sseData = JSON.stringify({
            id: request.requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: chunk.model,
            provider: chunk.providerId,
            choices: [
              {
                index: 0,
                delta: { content: chunk.content || '' },
                finish_reason: chunk.finishReason || null,
              },
            ],
          });

          await write(`data: ${sseData}\n\n`);
        }

        if (!clientGone) {
          const finalChunk = JSON.stringify({
            id: request.requestId,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
            },
          });

          await write(`data: ${finalChunk}\n\n`);
          await write('data: [DONE]\n\n');
        }

        recordCall({
          requestId: request.requestId,
          providerId,
          modelId,
          taskType: request.taskType,
          status: clientGone ? 'error' : 'success',
          durationMs: Date.now() - startTime,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          errorMessage: clientGone ? 'Client disconnected before completion' : undefined,
        });
      } catch (err) {
        const desc = describeError(err);
        if (providerId === 'unknown') providerId = (extractProviderId(err) ?? 'unknown') as ProviderId;
        recordCall({
          requestId: request.requestId,
          providerId,
          modelId,
          taskType: request.taskType,
          status: desc.code === 'RATE_LIMITED' ? 'rate_limited' : 'error',
          durationMs: Date.now() - startTime,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          errorMessage: redactSecrets(getSafeErrorMessage(err)),
        });

        if (!clientGone) {
          const errorData = JSON.stringify({
            error: {
              message: redactSecrets(getSafeErrorMessage(err)),
              type: desc.type,
              code: desc.code,
            },
          });
          await write(`data: ${errorData}\n\n`);
        }
      } finally {
        closeStream();
        if (!raw.writableEnded) raw.end();
      }
    })();

    return reply;
  }
}

function resolveGatewayLogFile(): string {
  try {
    return resolvePath(getAppConfig().logDir, 'gateway.log');
  } catch {
    return resolvePath('logs', 'gateway.log');
  }
}

function parseTaskType(value: unknown): TaskType | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return (TASK_TYPES as readonly string[]).includes(normalized)
    ? (normalized as TaskType)
    : undefined;
}

interface ErrorDescription {
  status: number;
  type: string;
  code: string;
  retryAfterSeconds?: number;
}

/**
 * Translate scheduler/adapter errors into OpenAI-shaped HTTP semantics instead of
 * flattening everything onto 502, so clients can tell "retry later" (429) from
 * "this model does not exist" (404) from "the upstream broke" (502).
 */
function describeError(err: unknown): ErrorDescription {
  if (err instanceof RateLimitError) {
    return {
      status: 429,
      type: 'rate_limited',
      code: 'RATE_LIMITED',
      retryAfterSeconds: Math.max(1, Math.ceil((err.retryAfterMs ?? 60_000) / 1000)),
    };
  }
  if (err instanceof AuthenticationError) {
    return { status: 401, type: 'auth_error', code: 'AUTH_FAILED' };
  }
  if (err instanceof AllProvidersFailedError) {
    return { status: 503, type: 'no_providers_available', code: 'ALL_FAILED' };
  }

  const code = err instanceof FreeLLMError ? err.code : undefined;
  switch (code) {
    case 'MODEL_NOT_FOUND':
      return { status: 404, type: 'model_not_found', code: 'MODEL_NOT_FOUND' };
    case 'BAD_REQUEST':
    case 'INVALID_REQUEST':
      return { status: 400, type: 'invalid_request', code };
    case 'CONTEXT_LENGTH_EXCEEDED':
      return { status: 400, type: 'invalid_request', code };
    case 'QUOTA_EXCEEDED':
      return { status: 429, type: 'quota_exceeded', code, retryAfterSeconds: 3600 };
    case 'TIMEOUT':
      return { status: 504, type: 'timeout', code };
    case 'CIRCUIT_OPEN':
      return { status: 503, type: 'no_providers_available', code, retryAfterSeconds: 30 };
    case 'NETWORK_ERROR':
    case 'SERVER_ERROR':
      return { status: 502, type: 'upstream_error', code };
    default:
      // Unrecognised failures come from the upstream chain, not the gateway itself.
      return { status: 502, type: 'upstream_error', code: code ?? 'SERVER_ERROR' };
  }
}

/** Providers that actually served (or were attempted by) the scheduler, for call logging. */
function extractProviderId(err: unknown): ProviderId | null {
  if (err instanceof ProviderError) return err.providerId as ProviderId;
  if (err instanceof AllProvidersFailedError) {
    const first = err.errors[0]?.providerId;
    return first ? (first as ProviderId) : null;
  }
  return null;
}

function getSafeErrorMessage(err: unknown): string {
  if (err instanceof RateLimitError) {
    return 'Rate limited by provider. Please try again later.';
  }
  if (err instanceof AuthenticationError) {
    return 'Authentication failed. Please check your API key configuration.';
  }
  if (err instanceof AllProvidersFailedError) {
    return 'All providers are currently unavailable. Please try again later.';
  }
  if (err instanceof FreeLLMError) {
    switch (err.code) {
      case 'MODEL_NOT_FOUND':
        return `No available provider can serve model '${err.details?.modelId ?? ''}'. Check the model id on the 模型目录 page.`;
      case 'BAD_REQUEST':
      case 'INVALID_REQUEST':
      case 'CONTEXT_LENGTH_EXCEEDED':
        return 'The request was rejected by the provider. Check the message content, max_tokens and model context window.';
      case 'QUOTA_EXCEEDED':
        return 'Daily quota reached for this provider. Try again after the quota period resets.';
      case 'TIMEOUT':
        return 'The provider timed out while processing the request.';
      case 'NETWORK_ERROR':
        return 'Failed to reach the provider.';
      case 'SERVER_ERROR':
        return 'The provider returned a server error.';
      default:
        break;
    }
  }
  if (err instanceof Error && err.message) {
    return redactSecrets(err.message).slice(0, 300);
  }
  return 'An error occurred while processing your request.';
}

/** Generate a secure gateway access token */
export function generateGatewayToken(): string {
  return `fh_${randomBytes(24).toString('base64url')}`;
}

/** Constant-time token comparison */
export function safeTokenEquals(candidate: string, expected: string): boolean {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(expected, 'utf8'));
}
