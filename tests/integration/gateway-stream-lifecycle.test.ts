import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { FastifyInstance } from 'fastify';

const audit = vi.hoisted(() => ({
  begin: vi.fn(() => true),
  event: vi.fn(() => true),
  complete: vi.fn(() => true),
  rejected: vi.fn(() => true),
}));

const recorder = vi.hoisted(() => ({ recordCall: vi.fn() }));

const config = vi.hoisted(() => ({ requestTimeoutMs: 5000 as number | undefined }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp/fh-stream-test', isPackaged: false },
}));

vi.mock('../../src/core/config/app-config.js', () => ({
  isElectronRuntime: () => false,
  resetAppConfigCache: () => undefined,
  getAppConfig: () => ({
    isDev: true,
    userDataPath: '/tmp/fh-stream-test',
    dataDir: '/tmp/fh-stream-test/data',
    logDir: '/tmp/fh-stream-test/logs',
    configFilePath: '/tmp/fh-stream-test/settings.json',
    dbPath: ':memory:',
    gatewayHost: '127.0.0.1',
    gatewayPort: 0,
    requestTimeoutMs: config.requestTimeoutMs,
    logLevel: 'silent',
  }),
}));

vi.mock('../../src/usage/audit-recorder.js', () => ({
  beginRequestAudit: audit.begin,
  recordAuditEvent: audit.event,
  completeRequestAudit: audit.complete,
  auditRejectedRequest: audit.rejected,
}));

vi.mock('../../src/usage/usage-recorder.js', () => ({ recordCall: recorder.recordCall }));

vi.mock('../../src/core/providers/registry.js', () => ({
  getProviderRegistry: () => ({ getAll: () => [], get: () => undefined }),
}));

import { GatewayServer } from '../../src/main/gateway/server';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../src/core/providers/request-errors';
import { ModelNotFoundError, RateLimitError } from '../../src/shared/errors/index';
import type { GatewayRequest, ProviderId } from '../../src/shared/types/index';

const CHAT = { messages: [{ role: 'user', content: 'Hello' }] };
const streamCall = (model: string) => ({
  method: 'POST' as const,
  url: '/v1/chat/completions',
  payload: { ...CHAT, model, stream: true },
});

/** `ServerResponse` stand-in: `write()` reports backpressure, `close()` is emitted by hand. */
class FakeResponse extends EventEmitter {
  writableEnded = false;
  destroyed = false;
  frames: string[] = [];
  heads: Array<{ status: number; headers: Record<string, string> }> = [];

  writeHead(status: number, headers: Record<string, string>) {
    this.heads.push({ status, headers });
  }

  setHeader() {
    return this;
  }

  write(data: string) {
    this.frames.push(data);
    // Always refuse to drain on its own — only an explicit `close` frees the loop.
    return false;
  }

  end() {
    this.writableEnded = true;
  }
}

interface SchedulerSpy {
  execute: ReturnType<typeof vi.fn>;
  executeStream: ReturnType<typeof vi.fn>;
}

function makeScheduler(
  streamBody: (request: GatewayRequest) => AsyncGenerator<never, void, unknown> | AsyncIterable<unknown>
): SchedulerSpy {
  return {
    execute: vi.fn(async () => ({
      content: 'ok',
      model: 'llama',
      providerId: 'groq' as ProviderId,
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      finishReason: 'stop',
      durationMs: 1,
    })),
    executeStream: vi.fn((request: GatewayRequest) => streamBody(request)),
  };
}

describe('gateway streaming lifecycle', () => {
  let server: GatewayServer;
  let app: FastifyInstance;

  async function start(scheduler: never) {
    server = new GatewayServer({ host: '127.0.0.1', port: 0, scheduler });
    await server.start();
    app = (server as unknown as { app: FastifyInstance }).app;
  }

  beforeEach(() => {
    config.requestTimeoutMs = 5000;
  });

  afterEach(async () => {
    await server?.stop();
    vi.clearAllMocks();
  });

  it('answers a failure that happens before the first token with the real status', async () => {
    await start({
      executeStream: async function* () {
        throw new RateLimitError('groq' as ProviderId, 4500);
      },
    } as never);

    const response = await app.inject(streamCall('llama'));

    // Previously this was `200` plus an SSE error frame the SDK had to sniff for.
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({
      error: { message: expect.any(String), type: 'rate_limited', code: 'RATE_LIMITED' },
    });
    expect(response.body).not.toContain('data: ');

    const events = audit.event.mock.calls.map((call) => call[0]);
    expect(events.some((event) => event.event === 'response.head')).toBe(false);
    expect(audit.complete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rate_limited', statusCode: 429, providerId: 'groq' })
    );
  });

  it('maps an unroutable model to 404 instead of an empty 200 stream', async () => {
    await start({
      executeStream: async function* () {
        throw new ModelNotFoundError('nope');
      },
    } as never);

    const response = await app.inject(streamCall('nope'));

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('MODEL_NOT_FOUND');
    expect(recorder.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ stream: true, statusCode: 404, status: 'error' })
    );
  });

  it('keeps the 200 SSE contract once a chunk has already reached the client', async () => {
    await start({
      executeStream: async function* () {
        yield { content: 'hi', model: 'llama', providerId: 'groq' };
        throw new RateLimitError('groq' as ProviderId, 1000);
      },
    } as never);

    const response = await app.inject(streamCall('llama'));

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('data: {"id"');
    expect(response.body).toContain('"code":"RATE_LIMITED"');
    expect(audit.event.mock.calls.map((call) => call[0]).some((e) => e.event === 'response.head')).toBe(
      true
    );
  });

  it('finishes the audit row when the client disconnects while a write is backed up', async () => {
    const raw = new FakeResponse();
    const scheduler = makeScheduler(async function* () {
      yield { content: 'a'.repeat(64), model: 'llama', providerId: 'groq' };
      yield { content: 'b'.repeat(64), model: 'llama', providerId: 'groq' };
    });
    await start(scheduler as never);

    const reply = { hijack: vi.fn(), raw } as never;
    const streamRequest = (
      server as unknown as {
        handleStreamRequest: (
          reply: never,
          request: GatewayRequest,
          startTime: number,
          trace: never,
          attemptCount: () => number
        ) => unknown;
      }
    ).handleStreamRequest;

    streamRequest.call(
      server,
      reply,
      { requestId: 'req_backpressure', messages: [], taskType: 'chat' } as GatewayRequest,
      Date.now(),
      { emit: vi.fn() } as never,
      () => 1
    );

    // Nothing can drain until the peer goes away; the loop must not stall on `drain`.
    await vi.waitFor(() => expect(raw.frames.length).toBeGreaterThan(0));
    expect(audit.complete).not.toHaveBeenCalled();
    raw.emit('close');

    await vi.waitFor(() =>
      expect(audit.complete).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req_backpressure', status: 'aborted' })
      )
    );
    const events = audit.event.mock.calls.map((call) => call[0]);
    expect(events.some((event) => event.event === 'client.disconnected')).toBe(true);
  });

  it('forwards the configured timeout to both scheduler entry points', async () => {
    const scheduler = makeScheduler(async function* () {
      yield { content: 'x', model: 'llama', providerId: 'groq' };
    });
    await start(scheduler as never);

    await app.inject(streamCall('llama'));
    await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { ...CHAT, model: 'llama' } });

    expect(scheduler.executeStream.mock.calls[0][1]).toMatchObject({ timeoutMs: 5000 });
    expect(scheduler.execute.mock.calls[0][1]).toMatchObject({ timeoutMs: 5000 });
  });

  it('falls back to the provider default when no timeout is configured', async () => {
    const scheduler = makeScheduler(async function* () {
      yield { content: 'x', model: 'llama', providerId: 'groq' };
    });
    // Mutating the shared config double is the only way to reach the unconfigured branch:
    // the module mock reads `config.requestTimeoutMs` on every getAppConfig() call.
    config.requestTimeoutMs = undefined;
    await start(scheduler as never);

    await app.inject(streamCall('llama'));
    expect(scheduler.executeStream.mock.calls[0][1]).toMatchObject({
      timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
  });
});
