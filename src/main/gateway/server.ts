import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from 'fastify';
import cors from '@fastify/cors';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Scheduler } from '../../scheduler/scheduler.js';
import { recordCall } from '../../usage/usage-recorder.js';
import {
  auditRejectedRequest,
  beginRequestAudit,
  completeRequestAudit,
  recordAuditEvent,
  type AuditEventType,
  type AuditStatus,
} from '../../usage/audit-recorder.js';
import type { SchedulerTrace, TraceEvent } from '../../scheduler/trace.js';
import { getProviderRegistry } from '../../core/providers/registry.js';
import type {
  GatewayMessage,
  GatewayRequest,
  GatewayToolCall,
  ProviderId,
} from '../../shared/types/index.js';
import { generateRequestId } from '../../shared/utils/index.js';
import { normalizeClientContent } from '../../shared/utils/content.js';
import {
  AllProvidersFailedError,
  AuthenticationError,
  FreeLLMError,
  ProviderError,
  RateLimitError,
} from '../../shared/errors/index.js';
import { TASK_TYPES, type TaskType } from '../../shared/types/index.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../core/providers/request-errors.js';
import { getAppConfig } from '../../core/config/app-config.js';
import { readSetting } from '../../core/settings/settings-store.js';
import { registerCommonMiddleware } from './middleware.js';
import {
  AnthropicStreamTranslator,
  AnthropicTranslateError,
  estimateAnthropicTokens,
  translateAnthropicRequest,
  translateErrorToAnthropic,
  translateGatewayResponse,
  type AnthropicMessagesRequest,
} from './anthropic.js';
import { getAppLogger } from '../../core/log/logger.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const LOCAL_ORIGIN = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i;

/** Inbound `X-Request-Id` is honoured but never trusted: length and charset are pinned. */
function resolveRequestId(headerValue: unknown): string {
  if (typeof headerValue === 'string') {
    const value = headerValue.trim();
    if (value.length > 0 && value.length <= 64 && /^[A-Za-z0-9_.:-]+$/.test(value)) return value;
  }
  return generateRequestId();
}

/**
 * The scheduler builds a per-attempt `AbortSignal` from this value. Adapters apply the same
 * default internally, so wiring it here is what makes the deadline configurable and visible
 * to the gateway's own error mapping (a 504 rather than an opaque network failure).
 */
function resolveRequestTimeoutMs(): number {
  try {
    const configured = getAppConfig().requestTimeoutMs;
    return typeof configured === 'number' && configured > 0 ? configured : DEFAULT_REQUEST_TIMEOUT_MS;
  } catch {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
}

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

    // Annotated with the logger type Fastify stores on `request.log`: passing the pino instance
    // directly makes Fastify infer its narrower `Logger<never, boolean>` shape, which no longer
    // matches the `this.app` field and breaks every route registration.
    const loggerInstance: FastifyBaseLogger = getAppLogger();

    this.app = Fastify({
      // One id per request, generated before any hook runs, so the pino lines in the rolled
      // log and the SQLite audit trail can finally be joined together.
      genReqId: (request) => resolveRequestId(request.headers['x-request-id']),
      // The process-wide instance, not a gateway-only one: two pino loggers writing the same
      // rolled file would disagree about where the rotation boundary is.
      loggerInstance,
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
          auditRejectedRequest({
            requestId: String(request.id),
            route: request.routeOptions?.url ?? request.url,
            method: request.method,
            clientAddress: request.ip,
            statusCode: 401,
            errorCode: 'AUTH_REQUIRED',
            errorMessage: 'Missing authorization header',
          });
          return reply.status(401).send({
            error: { message: 'Missing authorization header. Use: Bearer <token>', type: 'auth_required' },
          });
        }

        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        if (!this.authValidator!(token)) {
          auditRejectedRequest({
            requestId: String(request.id),
            route: request.routeOptions?.url ?? request.url,
            method: request.method,
            clientAddress: request.ip,
            statusCode: 403,
            errorCode: 'AUTH_FAILED',
            errorMessage: 'Invalid token',
          });
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

    this.app.get('/v1/models', async (request) => {
      const requestId = String(request.id);
      const startedAt = Date.now();
      beginRequestAudit({
        requestId,
        route: '/v1/models',
        method: 'GET',
        clientAddress: request.ip,
      });
      const registry = getProviderRegistry();
      const adapters = registry.getAll();
      const models: Array<Record<string, unknown>> = [];
      const skipped: Array<{ providerId: string; reason: string }> = [];
      const selfList = this.app!.addresses();
      const selfAddr = selfList.length > 0 ? selfList[0] : null;

      for (const adapter of adapters) {
        const config = adapter.getProviderConfig();
        if (!config.isEnabled) {
          skipped.push({ providerId: adapter.providerId, reason: 'disabled' });
          continue;
        }
        // A provider pointed back at this gateway would recurse forever.
        if (selfAddr && isSelfUrl(config.baseUrl, selfAddr.address, selfAddr.port)) {
          skipped.push({ providerId: adapter.providerId, reason: 'self_reference' });
          continue;
        }
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
          skipped.push({ providerId: adapter.providerId, reason: 'unreachable' });
        }
      }

      completeRequestAudit({
        requestId,
        status: 'success',
        statusCode: 200,
        providerId: 'gateway',
        modelId: 'models.list',
        durationMs: Date.now() - startedAt,
      });
      if (skipped.length > 0) {
        recordAuditEvent({
          requestId,
          event: 'candidate.skipped',
          reason: 'models_list_skipped',
          detail: { skipped },
        });
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
        messages: Array<{
          role: string;
          content?: unknown;
          name?: string;
          tool_calls?: GatewayToolCall[];
          tool_call_id?: string;
        }>;
        max_tokens?: number;
        temperature?: number;
        top_p?: number;
        stop?: string | string[];
        n?: number;
        stream?: boolean;
        tools?: unknown[];
        tool_choice?: unknown;
        response_format?: { type: string };
        task_type?: string;
      };
    }>('/v1/chat/completions', async (request, reply) => {
      const body = request.body;
      // Fastify already created this id in genReqId, so the auth hook, the audit
      // row, the response body and the pino lines all speak about one request.
      const requestId = String(request.id);
      const startTime = Date.now();
      const routeUrl = request.routeOptions?.url ?? '/v1/chat/completions';

      reply.header('X-Request-Id', requestId);

      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        auditRejectedRequest({
          requestId,
          route: routeUrl,
          method: request.method,
          requestedModel: body.model,
          clientAddress: request.ip,
          statusCode: 400,
          errorCode: 'BAD_REQUEST',
          errorMessage: 'messages field is required and must be a non-empty array',
          params: { model: body.model, maxTokens: body.max_tokens },
        });
        return reply.status(400).send({
          error: {
            message: 'messages field is required and must be a non-empty array',
            type: 'invalid_request',
            code: 'BAD_REQUEST',
          },
        });
      }

      // Serving one candidate while the client asked for N would silently hand back a
      // truncated result, so refuse it instead of pretending the pool supports fan-out.
      if (body.n !== undefined && body.n !== 1) {
        auditRejectedRequest({
          requestId,
          route: routeUrl,
          method: request.method,
          requestedModel: body.model,
          clientAddress: request.ip,
          statusCode: 400,
          errorCode: 'BAD_REQUEST',
          errorMessage: 'n other than 1 is not supported',
          params: { model: body.model, n: body.n },
        });
        return reply.status(400).send({
          error: {
            message: 'n other than 1 is not supported by this gateway',
            type: 'invalid_request',
            code: 'BAD_REQUEST',
          },
        });
      }

      const taskType = parseTaskType(body.task_type) ?? parseTaskType(readSetting('default_task_type'));
      const stream = Boolean(body.stream);

      // `content` is whatever JSON the client sent: a string, null, or OpenAI multimodal
      // parts. Validating it here keeps a malformed body a 400 instead of a crash several
      // layers down inside an adapter.
      const gatewayMessages: GatewayMessage[] = [];
      for (const m of body.messages) {
        const normalized = normalizeClientContent(m.content);
        if (!normalized.ok) {
          auditRejectedRequest({
            requestId,
            route: routeUrl,
            method: request.method,
            requestedModel: body.model,
            clientAddress: request.ip,
            statusCode: 400,
            errorCode: 'BAD_REQUEST',
            errorMessage: normalized.error,
            params: { model: body.model, maxTokens: body.max_tokens },
          });
          return reply.status(400).send({
            error: { message: normalized.error, type: 'invalid_request', code: 'BAD_REQUEST' },
          });
        }
        gatewayMessages.push({
          role: m.role as 'system' | 'user' | 'assistant' | 'tool',
          content: normalized.content,
          ...(m.name ? { name: m.name } : {}),
          ...(m.tool_call_id ? { toolCallId: m.tool_call_id } : {}),
          ...(m.tool_calls ? { toolCalls: m.tool_calls } : {}),
        });
      }

      beginRequestAudit({
        requestId,
        route: routeUrl,
        method: request.method,
        stream,
        requestedModel: body.model,
        taskType,
        clientAddress: request.ip,
        // Parameter fingerprint only — message content is never persisted.
        params: {
          messageCount: body.messages.length,
          maxTokens: body.max_tokens,
          temperature: body.temperature,
          hasTools: Boolean(body.tools?.length),
          responseFormat: body.response_format?.type,
        },
      });

      const gatewayRequest: GatewayRequest = {
        requestId,
        messages: gatewayMessages,
        model: body.model,
        taskType,
        maxTokens: body.max_tokens,
        temperature: body.temperature,
        topP: body.top_p,
        stop: body.stop,
        toolChoice: body.tool_choice,
        stream: body.stream,
        tools: body.tools,
        responseFormat: body.response_format,
      };

      const { trace, attemptCount } = createRequestTrace(requestId);

      if (stream) {
        return this.handleStreamRequest(reply, gatewayRequest, startTime, trace, attemptCount);
      }

      return this.handleNonStreamRequest(reply, gatewayRequest, startTime, trace, attemptCount);
    });

    // ─── Anthropic Messages API (/v1/messages) ─────────────────────
    // Claude Code, Cline and friends speak this dialect; the translation lives in
    // ./anthropic.ts, so this route is only transport + accounting.

    this.app.post<{
      Body: AnthropicMessagesRequest;
    }>('/v1/messages', async (request, reply) => {
      const requestId = String(request.id);
      const startTime = Date.now();
      const routeUrl = request.routeOptions?.url ?? '/v1/messages';
      reply.header('X-Request-Id', requestId);

      let translated: ReturnType<typeof translateAnthropicRequest>;
      try {
        translated = translateAnthropicRequest(request.body ?? {}, requestId);
      } catch (err) {
        if (err instanceof AnthropicTranslateError) {
          auditRejectedRequest({
            requestId,
            route: routeUrl,
            method: request.method,
            requestedModel: request.body?.model,
            clientAddress: request.ip,
            statusCode: 400,
            errorCode: 'BAD_REQUEST',
            errorMessage: err.message,
          });
          return reply.status(400).send({
            type: 'error',
            error: { type: 'invalid_request_error', message: err.message },
          });
        }
        throw err;
      }

      const gatewayRequest = translated.gateway;
      beginRequestAudit({
        requestId,
        route: routeUrl,
        method: request.method,
        stream: Boolean(gatewayRequest.stream),
        requestedModel: gatewayRequest.model,
        taskType: gatewayRequest.taskType,
        clientAddress: request.ip,
        params: {
          messageCount: gatewayRequest.messages.length,
          maxTokens: gatewayRequest.maxTokens,
          temperature: gatewayRequest.temperature,
          hasTools: Boolean(gatewayRequest.tools?.length),
          dialect: 'anthropic',
        },
      });

      const { trace, attemptCount } = createRequestTrace(requestId);

      if (gatewayRequest.stream) {
        return this.handleAnthropicStreamRequest(reply, gatewayRequest, startTime, trace, attemptCount, requestId);
      }
      return this.handleAnthropicNonStreamRequest(reply, gatewayRequest, startTime, trace, attemptCount, requestId);
    });

    this.app.post<{
      Body: AnthropicMessagesRequest;
    }>('/v1/messages/count_tokens', async (request, reply) => {
      // A utility endpoint: no audit row, or the panel would fill with counter reads.
      try {
        const inputTokens = estimateAnthropicTokens(request.body ?? {});
        return reply.send({ input_tokens: inputTokens });
      } catch (err) {
        if (err instanceof AnthropicTranslateError) {
          return reply.status(400).send({
            type: 'error',
            error: { type: 'invalid_request_error', message: err.message },
          });
        }
        throw err;
      }
    });
  }

  private async handleNonStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    startTime: number,
    trace: SchedulerTrace,
    attemptCount: () => number
  ) {
    try {
      const result = await this.scheduler.execute(request, {
        trace,
        timeoutMs: resolveRequestTimeoutMs(),
      });

      recordCall({
        requestId: request.requestId,
        providerId: result.providerId,
        modelId: result.model,
        taskType: request.taskType,
        status: 'success',
        durationMs: result.durationMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        statusCode: 200,
        stream: false,
        attempt: Math.max(1, attemptCount()),
      });

      completeRequestAudit({
        requestId: request.requestId,
        status: 'success',
        statusCode: 200,
        providerId: result.providerId,
        modelId: result.model,
        attempts: Math.max(1, attemptCount()),
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        durationMs: Date.now() - startTime,
      });

      const toolCalls = result.toolCalls;

      const response = {
        id: request.requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: result.model,
        provider: result.providerId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              // OpenAI sends null content alongside tool_calls; clients branch on it.
              content: toolCalls?.length && !result.content ? null : result.content,
              ...(result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
              ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
              finish_reason: result.finishReason,
            },
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
      const providerId = (extractProviderId(err) ?? 'unknown') as ProviderId;
      const attempts = Math.max(1, attemptCount());
      const message = redactSecrets(getSafeErrorMessage(err));
      recordCall({
        requestId: request.requestId,
        providerId,
        modelId: request.model ?? 'unknown',
        taskType: request.taskType,
        status: desc.code === 'RATE_LIMITED' ? 'rate_limited' : 'error',
        durationMs: Date.now() - startTime,
        promptTokens: 0,
        completionTokens: 0,
        errorMessage: message,
        statusCode: desc.status,
        stream: false,
        attempt: attempts,
      });

      completeRequestAudit({
        requestId: request.requestId,
        status: auditStatusForError(desc),
        statusCode: desc.status,
        providerId,
        modelId: request.model ?? 'unknown',
        attempts,
        durationMs: Date.now() - startTime,
        errorCode: desc.code,
        errorMessage: message,
      });

      if (desc.retryAfterSeconds) reply.header('Retry-After', String(desc.retryAfterSeconds));
      return reply.status(desc.status).send({
        error: {
          message,
          type: desc.type,
          code: desc.code,
        },
      });
    }
  }

  private handleStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    startTime: number,
    trace: SchedulerTrace,
    attemptCount: () => number
  ) {
    reply.hijack();
    const raw = reply.raw;

    // The 200 SSE head is committed only once there is actually something to stream.
    // Before that moment a provider failure can still be answered as a normal JSON
    // error with its real status; after it, 200 is already on the wire and the error
    // can only ride the stream as a data frame.
    let headSent = false;
    const ensureHead = () => {
      if (headSent) return;
      headSent = true;
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Request-Id': request.requestId,
      });

      recordAuditEvent({
        requestId: request.requestId,
        event: 'response.head',
        statusCode: 200,
        detail: { stream: true },
      });
    };

    const stream = this.scheduler.executeStream(request, {
      trace,
      timeoutMs: resolveRequestTimeoutMs(),
    });
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
        if (clientGone || raw.writableEnded || raw.destroyed) return resolveWrite();
        const settle = () => {
          raw.removeListener('drain', settle);
          raw.removeListener('close', settle);
          raw.removeListener('error', settle);
          resolveWrite();
        };
        raw.once('drain', settle);
        // A disconnected client never fires `drain`, so without these the loop would
        // await forever and `completeRequestAudit` would leave the row in_progress.
        raw.once('close', settle);
        raw.once('error', settle);
        if (raw.write(data)) settle();
      });

    (async () => {
      let providerId: ProviderId = 'unknown';
      let modelId = request.model ?? 'unknown';
      let finishReason = 'stop';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let chunkCount = 0;
      let firstTokenMs: number | null = null;
      let sentRole = false;

      try {
        for await (const chunk of stream) {
          if (clientGone) break;
          providerId = chunk.providerId ?? providerId;
          modelId = chunk.model ?? modelId;
          if (chunk.finishReason) finishReason = chunk.finishReason;
          // Usage is reported once, in the closing chunk, so it never needs a frame of its own.
          if (chunk.usage) usage = chunk.usage;

          const delta: Record<string, unknown> = {};
          if (!sentRole) {
            delta.role = 'assistant';
            sentRole = true;
          }
          if (chunk.content) delta.content = chunk.content;
          // Reasoning rides beside content under its own key so a client that only knows
          // `content` never receives chain-of-thought text as if it were the answer.
          if (chunk.reasoningContent) delta.reasoning_content = chunk.reasoningContent;
          if (chunk.toolCalls?.length) delta.tool_calls = chunk.toolCalls;

          if (chunk.finishReason || Object.keys(delta).length > 0) {
            if (firstTokenMs === null) firstTokenMs = Date.now() - startTime;
            chunkCount += 1;

            const sseData = JSON.stringify({
              id: request.requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: chunk.model,
              provider: chunk.providerId,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: chunk.finishReason || null,
                },
              ],
            });

            ensureHead();
            await write(`data: ${sseData}\n\n`);
          }
        }

        if (clientGone) {
          recordAuditEvent({
            requestId: request.requestId,
            event: 'client.disconnected',
            providerId,
            modelId,
            detail: { chunksWritten: chunkCount },
          });
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

          ensureHead();
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
          totalTokens: usage.totalTokens,
          errorMessage: clientGone ? 'Client disconnected before completion' : undefined,
          statusCode: 200,
          stream: true,
          attempt: Math.max(1, attemptCount()),
        });

        completeRequestAudit({
          requestId: request.requestId,
          status: clientGone ? 'aborted' : 'success',
          statusCode: 200,
          providerId,
          modelId,
          attempts: Math.max(1, attemptCount()),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - startTime,
          timeToFirstTokenMs: firstTokenMs ?? undefined,
          errorCode: clientGone ? 'CLIENT_DISCONNECTED' : undefined,
          errorMessage: clientGone ? 'Client disconnected before completion' : undefined,
        });
      } catch (err) {
        const desc = describeError(err);
        if (providerId === 'unknown') providerId = (extractProviderId(err) ?? 'unknown') as ProviderId;
        const attempts = Math.max(1, attemptCount());
        const message = redactSecrets(getSafeErrorMessage(err));
        recordCall({
          requestId: request.requestId,
          providerId,
          modelId,
          taskType: request.taskType,
          status: desc.code === 'RATE_LIMITED' ? 'rate_limited' : 'error',
          durationMs: Date.now() - startTime,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          errorMessage: message,
          // Once the SSE head is out the client-visible status stays 200; the audit
          // row still records the real upstream outcome.
          statusCode: desc.status,
          stream: true,
          attempt: attempts,
        });

        completeRequestAudit({
          requestId: request.requestId,
          status: auditStatusForError(desc),
          statusCode: desc.status,
          providerId,
          modelId,
          attempts,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - startTime,
          timeToFirstTokenMs: firstTokenMs ?? undefined,
          errorCode: desc.code,
          errorMessage: message,
        });

        if (!clientGone) {
          const errorBody = { error: { message, type: desc.type, code: desc.code } };
          if (headSent) {
            await write(`data: ${JSON.stringify(errorBody)}\n\n`);
          } else {
            if (desc.retryAfterSeconds) {
              raw.setHeader('Retry-After', String(desc.retryAfterSeconds));
            }
            raw.writeHead(desc.status, {
              'Content-Type': 'application/json',
              'X-Request-Id': request.requestId,
            });
            raw.end(JSON.stringify(errorBody));
          }
        }
      } finally {
        closeStream();
        if (!raw.writableEnded && !raw.destroyed) raw.end();
      }
    })();

    return reply;
  }

  /** Anthropic dialect, non-stream: same scheduler, different response envelope. */
  private async handleAnthropicNonStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    startTime: number,
    trace: SchedulerTrace,
    attemptCount: () => number,
    requestId: string
  ) {
    const requestedModel = request.model ?? 'auto';
    try {
      const result = await this.scheduler.execute(request, {
        trace,
        timeoutMs: resolveRequestTimeoutMs(),
      });

      recordCall({
        requestId,
        providerId: result.providerId,
        modelId: result.model,
        taskType: request.taskType,
        status: 'success',
        durationMs: result.durationMs,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        statusCode: 200,
        stream: false,
        attempt: Math.max(1, attemptCount()),
      });

      completeRequestAudit({
        requestId,
        status: 'success',
        statusCode: 200,
        providerId: result.providerId,
        modelId: result.model,
        attempts: Math.max(1, attemptCount()),
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        durationMs: Date.now() - startTime,
      });

      return reply.send(translateGatewayResponse({ ...result, requestId }, requestedModel));
    } catch (err) {
      const desc = describeError(err);
      const providerId = (extractProviderId(err) ?? 'unknown') as ProviderId;
      const attempts = Math.max(1, attemptCount());
      const message = redactSecrets(getSafeErrorMessage(err));

      recordCall({
        requestId,
        providerId,
        modelId: request.model ?? 'unknown',
        taskType: request.taskType,
        status: desc.code === 'RATE_LIMITED' ? 'rate_limited' : 'error',
        durationMs: Date.now() - startTime,
        promptTokens: 0,
        completionTokens: 0,
        statusCode: desc.status,
        stream: false,
        attempt: attempts,
      });
      completeRequestAudit({
        requestId,
        status: auditStatusForError(desc),
        statusCode: desc.status,
        providerId,
        modelId: request.model ?? 'unknown',
        attempts,
        durationMs: Date.now() - startTime,
        errorCode: desc.code,
        errorMessage: message,
      });

      const envelope = translateErrorToAnthropic(desc.status, desc.code, message);
      if (desc.retryAfterSeconds) reply.header('Retry-After', String(desc.retryAfterSeconds));
      return reply.status(envelope.status).send(envelope.body);
    }
  }

  /**
   * Anthropic dialect, streaming. Same hijack-and-drain structure as the OpenAI stream
   * path; the dialect-specific work is owned by AnthropicStreamTranslator, which
   * converts gateway chunks into the content_block event grammar.
   */
  private handleAnthropicStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    startTime: number,
    trace: SchedulerTrace,
    attemptCount: () => number,
    requestId: string
  ) {
    reply.hijack();
    const raw = reply.raw;
    const requestedModel = request.model ?? 'auto';

    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Request-Id': requestId,
    });

    const translator = new AnthropicStreamTranslator(`msg_${requestId}`, requestedModel);
    let clientGone = false;
    let closed = false;
    let stream: AsyncGenerator<{
      content?: string;
      finishReason?: string;
      usage?: import('../../shared/types/index.js').GatewayUsage;
      model: string;
      providerId: ProviderId;
    }> | null = null;

    const closeStream = () => {
      if (closed) return;
      closed = true;
      if (stream) {
        void Promise.resolve(stream.return(undefined as never)).catch(() => undefined);
      }
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

    stream = this.scheduler.executeStream(request, { trace });

    void (async () => {
      let providerId: ProviderId = 'unknown';
      let modelId = request.model ?? 'unknown';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let firstTokenMs: number | null = null;

      try {
        for await (const chunk of stream) {
          if (clientGone) break;
          if (firstTokenMs === null) firstTokenMs = Date.now() - startTime;
          providerId = chunk.providerId ?? providerId;
          modelId = chunk.model ?? modelId;
          if (chunk.usage) usage = chunk.usage;
          const out = translator.push(chunk);
          if (out) await write(out);
        }

        if (clientGone) {
          recordAuditEvent({
            requestId,
            event: 'client.disconnected',
            providerId,
            modelId,
          });
        } else {
          // The usage tail chunk carries no finishReason, so the normal end of the
          // generator still owes the client message_delta + message_stop. When the
          // final chunk DID carry one, this is a no-op by design.
          const tail = translator.finishAbruptly();
          if (tail) await write(tail);
        }

        recordCall({
          requestId,
          providerId,
          modelId,
          taskType: request.taskType,
          status: clientGone ? 'error' : 'success',
          durationMs: Date.now() - startTime,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          errorMessage: clientGone ? 'Client disconnected before completion' : undefined,
          statusCode: 200,
          stream: true,
          attempt: Math.max(1, attemptCount()),
        });

        completeRequestAudit({
          requestId,
          status: clientGone ? 'aborted' : 'success',
          statusCode: 200,
          providerId,
          modelId,
          attempts: Math.max(1, attemptCount()),
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - startTime,
          timeToFirstTokenMs: firstTokenMs ?? undefined,
          errorCode: clientGone ? 'CLIENT_DISCONNECTED' : undefined,
          errorMessage: clientGone ? 'Client disconnected before completion' : undefined,
        });
      } catch (err) {
        const desc = describeError(err);
        if (providerId === 'unknown') providerId = (extractProviderId(err) ?? 'unknown') as ProviderId;
        const attempts = Math.max(1, attemptCount());
        const message = redactSecrets(getSafeErrorMessage(err));

        recordCall({
          requestId,
          providerId,
          modelId,
          taskType: request.taskType,
          status: desc.code === 'RATE_LIMITED' ? 'rate_limited' : 'error',
          durationMs: Date.now() - startTime,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          errorMessage: message,
          statusCode: desc.status,
          stream: true,
          attempt: attempts,
        });
        completeRequestAudit({
          requestId,
          status: auditStatusForError(desc),
          statusCode: desc.status,
          providerId,
          modelId,
          attempts,
          durationMs: Date.now() - startTime,
          timeToFirstTokenMs: firstTokenMs ?? undefined,
          errorCode: desc.code,
          errorMessage: message,
        });

        // An error after the tail already went out cannot be delivered: message_stop
        // terminates the grammar, so stay silent rather than violate it.
        if (!clientGone && !translator.isFinished()) {
          const envelope = translateErrorToAnthropic(desc.status, desc.code, message);
          await write(translator.fail(envelope.body.error.type, message));
        }
      } finally {
        closeStream();
        if (!raw.writableEnded) raw.end();
      }
    })();

    return reply;
  }
}

/**
 * Bridge the scheduler's routing decisions into the audit trail and keep the
 * attempt counter the gateway needs for "this request fell back twice before
 * succeeding".
 */
function createRequestTrace(requestId: string): { trace: SchedulerTrace; attemptCount: () => number } {
  let attempts = 0;

  const trace: SchedulerTrace = {
    emit: (event: TraceEvent) => {
      if (event.stage === 'attempt.start') attempts += 1;
      recordAuditEvent({
        requestId,
        event: mapStageToAuditEvent(event.stage),
        providerId: event.providerId,
        modelId: event.modelId,
        attempt: event.attempt,
        reason: event.reason,
        durationMs: event.durationMs,
        statusCode: event.statusCode,
        detail: event.detail ?? (event.score === undefined ? undefined : { score: event.score }),
      });
    },
  };

  return { trace, attemptCount: () => attempts };
}

function mapStageToAuditEvent(stage: TraceEvent['stage']): AuditEventType {
  switch (stage) {
    case 'candidate.skipped':
      return 'candidate.skipped';
    case 'candidate.selected':
      return 'candidate.selected';
    case 'attempt.start':
      return 'attempt.start';
    case 'attempt.success':
      return 'attempt.success';
    case 'attempt.failed':
      return 'attempt.failed';
    case 'stream.started':
      return 'dispatch.start';
    case 'stream.first_token':
      return 'stream.first_token';
    case 'stream.failed':
      return 'stream.failed';
    case 'credential.rotated':
      return 'credential.rotated';
    default:
      return 'request.received';
  }
}

/** Map an HTTP error description onto the audit status vocabulary. */
function auditStatusForError(desc: ErrorDescription): AuditStatus {
  if (desc.code === 'RATE_LIMITED') return 'rate_limited';
  if (desc.code === 'QUOTA_EXCEEDED') return 'quota_exceeded';
  if (desc.code === 'TIMEOUT') return 'timeout';
  return 'error';
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
