import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { mockExecute, mockExecuteStream } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockExecuteStream: vi.fn(),
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

vi.mock('../../src/usage/usage-recorder.js', () => ({ recordCall: vi.fn() }));
// No database in this spec; audit writes are specified in gateway-audit.test.ts.
vi.mock('../../src/usage/audit-recorder.js', () => ({
  auditRejectedRequest: vi.fn(() => true),
  beginRequestAudit: vi.fn(() => true),
  completeRequestAudit: vi.fn(() => true),
  recordAuditEvent: vi.fn(() => true),
}));

import { GatewayServer } from '../../src/main/gateway/server';

const PARTS = [
  { type: 'text', text: 'what is in this image' },
  { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD', detail: 'low' } },
];

describe('gateway multimodal content and reasoning', () => {
  let server: GatewayServer;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockExecute.mockResolvedValue({
      content: 'a cat',
      model: 'mock-model-1',
      providerId: 'mock-provider',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
    });
    mockExecuteStream.mockImplementation(async function* () {
      yield { reasoningContent: 'thinking', model: 'mock-model-1', providerId: 'mock-provider' };
      yield { content: 'a cat', model: 'mock-model-1', providerId: 'mock-provider' };
      yield {
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        model: 'mock-model-1',
        providerId: 'mock-provider',
      };
      yield { finishReason: 'stop', model: 'mock-model-1', providerId: 'mock-provider' };
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

  it('forwards content parts to the scheduler without flattening them', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: PARTS }] },
    });

    expect(response.statusCode).toBe(200);
    const forwarded = mockExecute.mock.calls[0][0] as { messages: Array<Record<string, unknown>> };
    expect(forwarded.messages[0].content).toEqual(PARTS);
  });

  it('rejects a malformed content body with 400 before scheduling', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 42 }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
    expect(response.json().error.message).toMatch(/content/);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('rejects an empty content part array', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: [] }] },
    });

    expect(response.statusCode).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns chain-of-thought as reasoning_content, never inside content', async () => {
    mockExecute.mockResolvedValue({
      content: 'a cat',
      reasoningContent: 'it has ears',
      model: 'mock-model-1',
      providerId: 'mock-provider',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    const message = response.json().choices[0].message;
    expect(message.content).toBe('a cat');
    expect(message.reasoning_content).toBe('it has ears');
  });

  it('omits reasoning_content when the provider has none', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(response.json().choices[0].message.reasoning_content).toBeUndefined();
  });

  it('streams reasoning deltas beside content deltas', async () => {
    const response = await fetch(`${server.getUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    const text = await response.text();
    expect(text).toContain('"reasoning_content":"thinking"');
    expect(text).toContain('"content":"a cat"');
    expect(text).not.toContain('"delta":{},"finish_reason":null');

    // data frames: reasoning, answer, finish, closing usage summary — the usage-only
    // chunk must not add a fifth, and `[DONE]` is not counted as a frame.
    const frames = text.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]');
    expect(frames).toHaveLength(4);
    expect(JSON.parse(frames[3].slice(6)).usage.total_tokens).toBe(3);
  });
});
