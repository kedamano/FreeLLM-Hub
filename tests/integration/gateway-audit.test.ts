import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const audit = vi.hoisted(() => ({
  begin: vi.fn(() => true),
  event: vi.fn(() => true),
  complete: vi.fn(() => true),
  rejected: vi.fn(() => true),
}));

const recorder = vi.hoisted(() => ({ recordCall: vi.fn() }));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp/fh-audit-test', isPackaged: false },
}));

vi.mock('../../src/core/config/app-config.js', () => ({
  isElectronRuntime: () => false,
  resetAppConfigCache: () => undefined,
  getAppConfig: () => ({
    isDev: true,
    userDataPath: '/tmp/fh-audit-test',
    dataDir: '/tmp/fh-audit-test/data',
    logDir: '/tmp/fh-audit-test/logs',
    configFilePath: '/tmp/fh-audit-test/settings.json',
    dbPath: ':memory:',
    gatewayHost: '127.0.0.1',
    gatewayPort: 0,
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
  getProviderRegistry: () => ({
    getAll: () => [],
    get: () => undefined,
  }),
}));

import { GatewayServer } from '../../src/main/gateway/server';
import { RateLimitError } from '../../src/shared/errors/index';
import type { GatewayRequest, ProviderId } from '../../src/shared/types/index';
import type { SchedulerTrace } from '../../src/scheduler/trace';

/**
 * A scheduler double that plays the part of the real one for audit purposes: it emits
 * the candidate decisions a fallback chain produces, then succeeds or throws.
 */
const fakeScheduler = {
  async execute(
    request: GatewayRequest,
    options?: { trace?: SchedulerTrace }
  ) {
    options?.trace?.emit({ stage: 'candidate.skipped', providerId: 'cerebras', modelId: 'qwen', reason: 'circuit_open', score: 71 });
    options?.trace?.emit({ stage: 'attempt.start', providerId: 'groq', modelId: 'llama', attempt: 0 });
    if (request.model === 'boom') {
      throw new RateLimitError('groq' as ProviderId, 4500);
    }
    options?.trace?.emit({ stage: 'attempt.success', providerId: 'groq', modelId: 'llama', attempt: 0, durationMs: 12 });
    return {
      content: 'ok',
      model: 'llama',
      providerId: 'groq' as ProviderId,
      usage: { promptTokens: 7, completionTokens: 5, totalTokens: 12 },
      finishReason: 'stop',
      durationMs: 12,
    };
  },

  async *executeStream(
    _request: GatewayRequest,
    options?: { trace?: SchedulerTrace }
  ) {
    options?.trace?.emit({ stage: 'attempt.start', providerId: 'groq', modelId: 'llama', attempt: 0 });
    yield { content: 'he', model: 'llama', providerId: 'groq' as ProviderId };
    yield { content: 'llo', model: 'llama', providerId: 'groq' as ProviderId };
    yield {
      usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
      model: 'llama',
      providerId: 'groq' as ProviderId,
    };
  },
};

const CHAT = { messages: [{ role: 'user', content: 'Hello' }] };

describe('gateway request audit', () => {
  let server: GatewayServer;
  let app: FastifyInstance;

  beforeEach(async () => {
    server = new GatewayServer({ host: '127.0.0.1', port: 0, scheduler: fakeScheduler as never });
    await server.start();
    app = (server as unknown as { app: FastifyInstance }).app;
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
  });

  it('opens and closes one audit record per successful request, carrying the trail', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...CHAT, model: 'llama', max_tokens: 100 },
    });
    expect(response.statusCode).toBe(200);

    const requestId = response.json().id;
    expect(requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBe(requestId);

    expect(audit.begin).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        route: '/v1/chat/completions',
        params: expect.objectContaining({ messageCount: 1, maxTokens: 100 }),
      })
    );

    const events = audit.event.mock.calls.map((call) => call[0]);
    expect(events.map((event) => event.event)).toEqual(
      expect.arrayContaining(['candidate.skipped', 'attempt.start', 'attempt.success'])
    );
    expect(events.find((event) => event.event === 'candidate.skipped')).toMatchObject({
      requestId,
      providerId: 'cerebras',
      reason: 'circuit_open',
      detail: { score: 71 },
    });

    expect(audit.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        status: 'success',
        statusCode: 200,
        providerId: 'groq',
        modelId: 'llama',
        attempts: 1,
        totalTokens: 12,
      })
    );

    // The ledger row now carries the same correlation id, HTTP status and stream flag.
    expect(recorder.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ requestId, statusCode: 200, stream: false, attempt: 1 })
    );
  });

  it('records the real failure status for a rate-limited dispatch', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...CHAT, model: 'boom' },
    });

    expect(response.statusCode).toBe(429);
    const requestId = response.headers['x-request-id'] as string;
    expect(audit.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId,
        status: 'rate_limited',
        statusCode: 429,
        errorCode: 'RATE_LIMITED',
        providerId: 'groq',
      })
    );
  });

  it('audits a streamed response with a head event, first token and terminal row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...CHAT, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: [DONE]');

    const events = audit.event.mock.calls.map((call) => call[0]);
    expect(events.some((event) => event.event === 'response.head')).toBe(true);
    expect(events.some((event) => event.event === 'stream.first_token' || event.event === 'attempt.start')).toBe(
      true
    );
    expect(audit.complete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'success', totalTokens: 10 })
    );
    expect(recorder.recordCall).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
  });

  it('audits rejected traffic that never reaches the scheduler', async () => {
    const guarded = new GatewayServer({
      host: '127.0.0.1',
      port: 0,
      scheduler: fakeScheduler as never,
      authValidator: (token) => token === 'good',
    });
    await guarded.start();
    const guardedApp = (guarded as unknown as { app: FastifyInstance }).app;

    const unauthenticated = await guardedApp.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: CHAT,
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(audit.rejected).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401, errorCode: 'AUTH_REQUIRED', route: '/v1/chat/completions' })
    );
    expect(recorder.recordCall).not.toHaveBeenCalled();

    const malformed = await guardedApp.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer good' },
      payload: { messages: [] },
    });
    expect(malformed.statusCode).toBe(400);
    expect(audit.rejected).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, errorCode: 'BAD_REQUEST' })
    );

    await guarded.stop();

    // Without auth enabled the unknown route reaches the 404 handler instead, and that
    // rejection is audited too (it used to vanish entirely).
    const unknownRoute = await app.inject({ method: 'GET', url: '/v1/nope' });
    expect(unknownRoute.statusCode).toBe(404);
    expect(audit.rejected).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 404, errorCode: 'NOT_FOUND' })
    );
  });

  it('honours an inbound X-Request-Id so a client trace id survives into the audit row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-request-id': 'client-trace-42' },
      payload: CHAT,
    });
    expect(response.json().id).toBe('client-trace-42');
    expect(audit.begin).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'client-trace-42' }));
  });

  it('does not treat an untrusted X-Request-Id as a storage key', async () => {
    const sneaky = 'x'.repeat(300) + "'; DROP TABLE call_logs; --";
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-request-id': sneaky },
      payload: CHAT,
    });
    const used = response.json().id as string;
    expect(used).not.toBe(sneaky);
    expect(used.length).toBeLessThanOrEqual(64);
    expect(used).toMatch(/^req_/);
  });
});
