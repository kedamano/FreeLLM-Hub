import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Scheduler } from '../../scheduler/scheduler.js';
import { recordCall } from '../../usage/usage-recorder.js';
import { getProviderRegistry } from '../../core/providers/registry.js';
import {
  GatewayRequestSchema,
  type GatewayRequest,
  type GatewayResponse,
  type ProviderId,
} from '../../shared/types/index.js';
import { generateRequestId, safeJsonParse } from '../../shared/utils/index.js';
import type { ChatOptions } from '../../core/providers/contracts.js';

export interface GatewayServerOptions {
  host?: string;
  port?: number;
  scheduler: Scheduler;
}

export class GatewayServer {
  private app: FastifyInstance | null = null;
  private scheduler: Scheduler;
  private host: string;
  private port: number;

  constructor(options: GatewayServerOptions) {
    this.scheduler = options.scheduler;
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 0;
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

    this.registerRoutes();

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

      return reply.status(503).send({
        error: {
          message: err instanceof Error ? err.message : 'All providers unavailable',
          type: 'no_providers_available',
          code: 'ALL_FAILED',
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
            message: err instanceof Error ? err.message : 'Stream error',
            type: 'stream_error',
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
