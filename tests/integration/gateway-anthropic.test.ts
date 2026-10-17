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
  app: { getPath: () => '/tmp/fh-anthropic-test', isPackaged: false },
}));

vi.mock('../../src/core/config/app-config.js', () => ({
  isElectronRuntime: () => false,
  resetAppConfigCache: () => undefined,
  getAppConfig: () => ({
    isDev: true,
    userDataPath: '/tmp/fh-anthropic-test',
    dataDir: '/tmp/fh-anthropic-test/data',
    logDir: '/tmp/fh-anthropic-test/logs',
    configFilePath: '/tmp/fh-anthropic-test/settings.json',
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
  getProviderRegistry: () => ({ getAll: () => [], get: () => undefined }),
}));

import { GatewayServer } from '../../src/main/gateway/server';
import { RateLimitError } from '../../src/shared/errors/index';
import type { GatewayRequest, ProviderId } from '../../src/shared/types/index';
import type { SchedulerTrace } from '../../src/scheduler/trace';

const fakeScheduler = {
  async execute(request: GatewayRequest, _options?: { trace?: SchedulerTrace }) {
    if (request.model === 'boom') throw new RateLimitError('groq' as ProviderId, 4500);
    return {
      content: '晴天',
      model: 'llama-3.3-70b',
      providerId: 'groq' as ProviderId,
      usage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 },
      finishReason: 'stop',
      durationMs: 15,
    };
  },
  async *executeStream(request: GatewayRequest, _options?: { trace?: SchedulerTrace }) {
    if (request.model === 'boom-stream') throw new RateLimitError('groq' as ProviderId, 4500);
    yield { content: '多云', model: 'llama-3.3-70b', providerId: 'groq' as ProviderId };
    yield {
      usage: { promptTokens: 9, completionTokens: 2, totalTokens: 11 },
      model: 'llama-3.3-70b',
      providerId: 'groq' as ProviderId,
    };
  },
};

const MESSAGES_BODY = {
  model: 'llama-3.3-70b',
  max_tokens: 512,
  system: '你是天气预报员',
  messages: [{ role: 'user', content: [{ type: 'text', text: '明天天气' }] }],
};

describe('Anthropic Messages compatibility route', () => {
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

  it('answers /v1/messages with the Anthropic envelope and audits the call', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/messages', payload: MESSAGES_BODY });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeTruthy();

    const body = response.json();
    expect(body).toMatchObject({
      id: expect.stringMatching(/^msg_/),
      type: 'message',
      role: 'assistant',
      model: 'llama-3.3-70b',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 9, output_tokens: 3 },
    });
    expect(body.content).toEqual([{ type: 'text', text: '晴天' }]);

    expect(audit.begin).toHaveBeenCalledWith(
      expect.objectContaining({ route: '/v1/messages', params: expect.objectContaining({ dialect: 'anthropic' }) })
    );
    expect(recorder.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200, stream: false })
    );
  });

  it('streams Anthropic SSE events, ending with message_stop (no [DONE])', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { ...MESSAGES_BODY, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const events = response.body
      .split('\n\n')
      .filter(Boolean)
      .map((block) => block.match(/^event: (.+)$/m)![1]);
    expect(events[0]).toBe('message_start');
    expect(events).toContain('content_block_delta');
    expect(events.at(-1)).toBe('message_stop');
    expect(response.body).not.toContain('[DONE]');

    expect(recorder.recordCall).toHaveBeenCalledWith(expect.objectContaining({ stream: true }));
  });

  it('streams thinking blocks separately from text blocks', async () => {
    const original = fakeScheduler.executeStream;
    fakeScheduler.executeStream = async function* (request: GatewayRequest) {
      yield { reasoningContent: '思考中', model: 'm', providerId: 'groq' as ProviderId };
      yield { content: '答', model: 'm', providerId: 'groq' as ProviderId };
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { ...MESSAGES_BODY, stream: true },
    });
    fakeScheduler.executeStream = original;

    const starts = [...response.body.matchAll(/content_block_start\ndata: (.+)/g)].map(
      (m) => JSON.parse(m[1]).content_block.type
    );
    expect(starts).toEqual(['thinking', 'text']);
  });

  it('maps provider failures onto the Anthropic error envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { ...MESSAGES_BODY, model: 'boom' },
    });
    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.type).toBe('error');
    expect(body.error).toEqual({ type: 'rate_limit_error', message: expect.any(String) });
  });

  it('maps stream failures onto an SSE error event after message_start', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { ...MESSAGES_BODY, model: 'boom-stream', stream: true },
    });
    expect(response.body).toContain('event: message_start');
    expect(response.body).toContain('event: error');
    expect(response.body).toContain('rate_limit_error');
  });

  it('translates tools into tool_use blocks and stop_reason tool_use', async () => {
    const original = fakeScheduler.execute;
    fakeScheduler.execute = async function (request: GatewayRequest) {
      expect(request.tools).toEqual([
        {
          type: 'function',
          function: { name: 'get_weather', description: '查天气', parameters: { type: 'object' } },
        },
      ]);
      expect(request.toolChoice).toEqual({ type: 'function', function: { name: 'get_weather' } });
      return {
        content: '',
        model: 'llama-3.3-70b',
        providerId: 'groq' as ProviderId,
        usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        finishReason: 'tool_calls',
        durationMs: 20,
        toolCalls: [
          { id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"杭州"}' } },
        ],
      };
    };
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        ...MESSAGES_BODY,
        tools: [
          { name: 'get_weather', description: '查天气', input_schema: { type: 'object' } },
        ],
        tool_choice: { type: 'tool', name: 'get_weather' },
      },
    });
    fakeScheduler.execute = original;

    const body = response.json();
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([
      { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '杭州' } },
    ]);
  });

  it('serves count_tokens without an audit row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: MESSAGES_BODY,
    });
    expect(response.statusCode).toBe(200);
    const tokens = response.json().input_tokens;
    expect(Number.isFinite(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
    expect(audit.begin).not.toHaveBeenCalledWith(expect.objectContaining({ route: '/v1/messages/count_tokens' }));
  });

  it('rejects malformed bodies with the Anthropic error envelope', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'llama-3.3-70b', messages: [] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: expect.stringContaining('messages') },
    });
    expect(audit.rejected).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, route: '/v1/messages' })
    );
  });

  it('honours an inbound X-Request-Id and echoes msg_-prefixed ids', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'x-request-id': 'client-trace-77' },
      payload: MESSAGES_BODY,
    });
    expect(response.json().id).toBe('msg_client-trace-77');
  });
});
