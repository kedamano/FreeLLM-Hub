import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { Scheduler } from '../../scheduler/scheduler.js';
import { recordCall } from '../../usage/usage-recorder.js';
import { getProviderRegistry } from '../../core/providers/registry.js';
import type {
  GatewayRequest,
  GatewayResponse,
  ProviderId,
} from '../../shared/types/index.js';
import { generateRequestId } from '../../shared/utils/index.js';
import type { ChatOptions } from '../../core/providers/contracts.js';
import { AllProvidersFailedError, RateLimitError, AuthenticationError } from '../../shared/errors/index.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { registerCommonMiddleware } from './middleware.js';

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  scheduler: Scheduler;
  authValidator?: (token: string) => boolean;
}

export class GatewayServer {
  private app: FastifyInstance | null = null;
  private scheduler: Scheduler;
  private host: string;
  private port: number;
  private authValidator?: (token: string) => boolean;

  constructor(options: GatewayServerOptions) {
    this.scheduler = options.scheduler;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 0;
    this.authValidator = options.authValidator;
  }

  async start(): Promise<{ host: string; port: number }> {
    this.app = Fastify({
      logger: {
        level: 'info',
        transport: {
          target: 'pino-pretty',
          options: { colorize: false, destination: 'logs/gateway.log' },
        },
      },
      bodyLimit: 10 * 1024 * 1024,
    });

    await this.app.register(cors, { origin: true });

    // Register auth middleware if validator is provided
    if (this.authValidator) {
      this.app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
        // Skip auth for health check
        if (request.url === '/health' || request.url?.startsWith('/health')) return;

        const authHeader = request.headers.authorization;
        if (!authHeader) {
          reply.status(401).send({
            error: { message: 'Missing authorization header. Use: Bearer <token>', type: 'auth_required' },
          });
          return;
        }

        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        if (!this.authValidator!(token)) {
          reply.status(403).send({
            error: { message: 'Invalid token', type: 'auth_failed' },
          });
        }
      });
    }

    this.registerRoutes();
    registerCommonMiddleware(this.app);

    await this.app.listen({ host: this.host, port: this.port });

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

      for (const adapter of adapters) {
        if (!adapter.getProviderConfig().isEnabled) continue;
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
            error: err instanceof Error ? err.message : String(err),
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
      recordCall({
        requestId: request.requestId,
        providerId: 'unknown' as ProviderId,
        modelId: 'unknown',
        taskType: request.taskType,
        status: 'error',
        durationMs: Date.now() - startTime,
        promptTokens: 0,
        completionTokens: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      });

      const statusCode = getErrorStatusCode(err);
      return reply.status(statusCode).send({
        error: {
          message: getSafeErrorMessage(err),
          type: getErrorType(err),
          code: getErrorCode(err),
        },
      });
    }
  }

  private handleStreamRequest(
    reply: import('fastify').FastifyReply,
    request: GatewayRequest,
    _startTime: number
  ) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const stream = this.scheduler.executeStream(request);

    (async () => {
      let fullContent = '';
      let finishReason = 'stop';
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

      try {
        for await (const chunk of stream) {
          if (chunk.content) fullContent += chunk.content;
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

          reply.raw.write(`data: ${sseData}\n\n`);
        }

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

        reply.raw.write(`data: ${finalChunk}\n\n`);
        reply.raw.write('data: [DONE]\n\n');
      } catch (err) {
        const errorData = JSON.stringify({
          error: {
            message: redactSecrets(getSafeErrorMessage(err)),
            type: getErrorType(err),
            code: getErrorCode(err),
          },
        });
        reply.raw.write(`data: ${errorData}\n\n`);
      } finally {
        reply.raw.end();
      }
    })();

    return reply;
  }
}

function getErrorStatusCode(err: unknown): number {
  if (err instanceof RateLimitError) return 429;
  if (err instanceof AuthenticationError) return 401;
  if (err instanceof AllProvidersFailedError) return 503;
  return 502;
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
  if (err instanceof Error) {
    return 'An error occurred while processing your request.';
  }
  return 'Unknown error occurred.';
}

function getErrorType(err: unknown): string {
  if (err instanceof RateLimitError) return 'rate_limited';
  if (err instanceof AuthenticationError) return 'auth_error';
  if (err instanceof AllProvidersFailedError) return 'no_providers_available';
  return 'server_error';
}

function getErrorCode(err: unknown): string {
  if (err instanceof RateLimitError) return 'RATE_LIMITED';
  if (err instanceof AuthenticationError) return 'AUTH_FAILED';
  if (err instanceof AllProvidersFailedError) return 'ALL_FAILED';
  return 'SERVER_ERROR';
}

/** Generate a secure gateway access token */
export function generateGatewayToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'fh_';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}
