import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { mockExecute, mockExecuteStream, mockRecordCall } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockExecuteStream: vi.fn(),
  mockRecordCall: vi.fn(),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp/test-data', isPackaged: false },
}));

vi.mock('../../src/core/providers/registry.js', () => ({
  getProviderRegistry: () => ({
    getAll: () => [],
    get: () => undefined,
    register: vi.fn(),
    unregister: vi.fn(),
  }),
}));

vi.mock('../../src/usage/usage-recorder.js', () => ({ recordCall: mockRecordCall }));
// No database in this spec; audit writes are specified in gateway-audit.test.ts.
vi.mock('../../src/usage/audit-recorder.js', () => ({
  auditRejectedRequest: vi.fn(() => true),
  beginRequestAudit: vi.fn(() => true),
  completeRequestAudit: vi.fn(() => true),
  recordAuditEvent: vi.fn(() => true),
}));

import { GatewayServer } from '../../src/main/gateway/server';

const TOOL_CALLS = [
  { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
];

function successResult(overrides: Record<string, unknown> = {}) {
  mockExecute.mockResolvedValue({
    content: '',
    model: 'mock-model-1',
    providerId: 'mock-provider',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'tool_calls',
    durationMs: 5,
    ...overrides,
  });
}

describe('Gateway tool_calls passthrough', () => {
  let server: GatewayServer;
  let app: FastifyInstance;

  beforeEach(async () => {
    successResult({ toolCalls: TOOL_CALLS });
    mockExecuteStream.mockImplementation(async function* () {
      yield { toolCalls: [{ ...TOOL_CALLS[0], index: 0 }], model: 'mock-model-1', providerId: 'mock-provider' };
      yield { finishReason: 'tool_calls', model: 'mock-model-1', providerId: 'mock-provider' };
    });

    server = new GatewayServer({
      host: '127.0.0.1',
      port: 0,
      scheduler: { execute: mockExecute, executeStream: mockExecuteStream } as never,
    });
    await server.start();
    app = (server as unknown as { app: FastifyInstance }).app;
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
  });

  it('returns tool_calls in a non-streaming completion', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: '北京天气' }] },
    });

    expect(response.statusCode).toBe(200);
    const message = response.json().choices[0].message;
    expect(message.tool_calls).toEqual(TOOL_CALLS);
    expect(message.content).toBeNull();
    expect(message.finish_reason).toBe('tool_calls');
  });

  it('carries the assistant tool_calls and the tool answer into the scheduler', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [
          { role: 'user', content: '北京天气' },
          { role: 'assistant', content: null, tool_calls: TOOL_CALLS },
          { role: 'tool', content: '晴 24°C', tool_call_id: 'call_1' },
        ],
        tools: [{ type: 'function', function: { name: 'get_weather' } }],
        tool_choice: 'required',
        top_p: 0.5,
        stop: ['END'],
      },
    });

    const forwarded = mockExecute.mock.calls[0][0] as Record<string, unknown>;
    const messages = forwarded.messages as Array<Record<string, unknown>>;
    expect(messages[1].toolCalls).toEqual(TOOL_CALLS);
    expect(messages[2].toolCallId).toBe('call_1');
    expect(forwarded.toolChoice).toBe('required');
    expect(forwarded.topP).toBe(0.5);
    expect(forwarded.stop).toEqual(['END']);
  });

  it('emits tool_calls and the assistant role in the stream', async () => {
    const response = await fetch(`${server.getUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '北京天气' }], stream: true }),
    });

    const text = await response.text();
    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"get_weather"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it('refuses n greater than one instead of silently truncating it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }], n: 3 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
