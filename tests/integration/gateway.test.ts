import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const { mockChat, mockExecuteStream, mockListModels, mockGetProviderConfig, mockRecordCall } = vi.hoisted(() => ({
  mockChat: vi.fn(),
  mockExecuteStream: vi.fn(),
  mockListModels: vi.fn(),
  mockGetProviderConfig: vi.fn(),
  mockRecordCall: vi.fn(),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: {
    getPath: () => '/tmp/test-data',
    isPackaged: false,
  },
}));

vi.mock('../../src/core/providers/registry.js', () => ({
  getProviderRegistry: () => ({
    getAll: () => [
      {
        providerId: 'mock-provider',
        providerName: 'Mock Provider',
        getProviderConfig: mockGetProviderConfig,
        listModels: mockListModels,
        chat: mockChat,
        chatStream: vi.fn(),
        isAvailable: vi.fn().mockResolvedValue(true),
        validateCredential: vi.fn().mockResolvedValue({ valid: true }),
        getModel: vi.fn().mockResolvedValue(null),
      },
    ],
    get: () => ({
      providerId: 'mock-provider',
      chat: mockChat,
      chatStream: vi.fn(),
    }),
    register: vi.fn(),
    unregister: vi.fn(),
  }),
}));

vi.mock('../../src/usage/usage-recorder.js', () => ({
  recordCall: mockRecordCall,
}));

// This spec runs without a database; the audit trail itself is specified in
// gateway-audit.test.ts.
vi.mock('../../src/usage/audit-recorder.js', () => ({
  auditRejectedRequest: vi.fn(() => true),
  beginRequestAudit: vi.fn(() => true),
  completeRequestAudit: vi.fn(() => true),
  recordAuditEvent: vi.fn(() => true),
}));

import { GatewayServer, generateGatewayToken, safeTokenEquals } from '../../src/main/gateway/server';
import {
  AllProvidersFailedError,
  AuthenticationError,
  ProviderError,
  QuotaExceededError,
  RateLimitError,
} from '../../src/shared/errors/index';

const CHAT_PAYLOAD = { messages: [{ role: 'user', content: 'Hello' }] };

function chatSuccess() {
  mockChat.mockResolvedValue({
    content: 'This is a mock response',
    model: 'mock-model-1',
    providerId: 'mock-provider',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    finishReason: 'stop',
    durationMs: 5,
  });
}

describe('Gateway HTTP Integration', () => {
  let server: GatewayServer;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockGetProviderConfig.mockReturnValue({
      id: 'mock-provider',
      displayName: 'Mock Provider',
      authType: 'api-key',
      baseUrl: 'https://api.mock.com/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'configured',
    });

    mockListModels.mockResolvedValue([
      {
        id: 'mock-model-1',
        providerId: 'mock-provider',
        displayName: 'Mock Model 1',
        capabilities: {
          supported: ['chat', 'streaming'],
          contextWindow: 8192,
          supportsStreaming: true,
          supportsVision: false,
          supportsFunctionCalling: false,
          supportsJsonMode: false,
        },
        pricing: { type: 'free', currency: 'USD' },
        status: 'available',
        discoveredAt: new Date().toISOString(),
      },
    ]);

    chatSuccess();
    mockExecuteStream.mockImplementation(async function* () {
      yield { content: 'Hello', model: 'mock-model-1', providerId: 'mock-provider' };
      yield { content: ' world', model: 'mock-model-1', providerId: 'mock-provider' };
      yield {
        finishReason: 'stop',
        usage: { promptTokens: 4, completionTokens: 6, totalTokens: 10 },
        model: 'mock-model-1',
        providerId: 'mock-provider',
      };
    });

    server = new GatewayServer({
      host: '127.0.0.1',
      port: 0,
      scheduler: {
        execute: mockChat,
        executeStream: mockExecuteStream,
      } as never,
    });

    await server.start();
    app = (server as unknown as { app: FastifyInstance }).app;
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return ok status', async () => {
      const response = await app.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body.timestamp).toBeDefined();
    });
  });

  describe('GET /v1/models', () => {
    it('should return model list', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/models' });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.object).toBe('list');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('mock-model-1');
      expect(body.data[0].owned_by).toBe('mock-provider');
    });
  });

  describe('POST /v1/chat/completions', () => {
    it('should return a completion and record the call', async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0].message.content).toBe('This is a mock response');
      expect(body.usage.total_tokens).toBe(30);
      expect(mockRecordCall).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'mock-provider', status: 'success', promptTokens: 10 })
      );
    });

    it('should reject an empty messages array with 400', async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { messages: [] } });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('BAD_REQUEST');
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('should forward temperature to the scheduler', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...CHAT_PAYLOAD, temperature: 0.5 },
      });

      expect(response.statusCode).toBe(200);
      expect(mockChat.mock.calls[0][0].temperature).toBe(0.5);
    });

    it('should forward max_tokens and model to the scheduler', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { model: 'mock-model-1', max_tokens: 100, messages: CHAT_PAYLOAD.messages },
      });

      expect(response.statusCode).toBe(200);
      expect(mockChat.mock.calls[0][0].maxTokens).toBe(100);
      expect(mockChat.mock.calls[0][0].model).toBe('mock-model-1');
    });

    it('should map AllProvidersFailedError to 503', async () => {
      mockChat.mockRejectedValue(new AllProvidersFailedError([{ providerId: 'mock-provider', error: 'boom' }]));

      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('ALL_FAILED');
      expect(mockRecordCall).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    });

    it('should map RateLimitError to 429 with Retry-After', async () => {
      mockChat.mockRejectedValue(new RateLimitError('mock-provider', 45_000));

      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('RATE_LIMITED');
      expect(response.headers['retry-after']).toBe('45');
    });

    it('should map QuotaExceededError to 429 and record the provider', async () => {
      mockChat.mockRejectedValue(new QuotaExceededError('mock-provider'));

      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(429);
      expect(response.json().error.code).toBe('QUOTA_EXCEEDED');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(mockRecordCall).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'mock-provider', status: 'error' })
      );
    });

    it('should map MODEL_NOT_FOUND to 404 and log the failing provider', async () => {
      mockChat.mockRejectedValue(
        new ProviderError('Model not found at mock-provider', 'mock-provider', 'MODEL_NOT_FOUND')
      );

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...CHAT_PAYLOAD, model: 'gone-model' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.type).toBe('model_not_found');
      expect(mockRecordCall).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: 'mock-provider', modelId: 'gone-model', status: 'error' })
      );
    });

    it('should map BAD_REQUEST to 400 instead of a generic 502', async () => {
      mockChat.mockRejectedValue(
        new ProviderError('context length exceeded', 'mock-provider', 'BAD_REQUEST')
      );

      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe('invalid_request');
      expect(response.json().error.code).toBe('BAD_REQUEST');
    });

    it('should forward task_type to the scheduler for capability routing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...CHAT_PAYLOAD, task_type: 'coding' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockChat.mock.calls[0][0].taskType).toBe('coding');
      expect(mockRecordCall).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'coding' }));
    });

    it('should ignore an unknown task_type instead of guessing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...CHAT_PAYLOAD, task_type: 'write-poetry' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockChat.mock.calls[0][0].taskType).toBeUndefined();
    });

    it('should map AuthenticationError to 401', async () => {
      mockChat.mockRejectedValue(new AuthenticationError('mock-provider', 'bad key sk-abcdefghijklmnopqrstuvwxyz'));

      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('AUTH_FAILED');
    });

    it('should map unknown errors to 502 without leaking details', async () => {
      mockChat.mockRejectedValue(new Error('connect ECONNREFUSED api-key=sk-abcdefghijklmnopqrstuvwxyz'));

      const response = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(502);
      expect(response.json().error.message).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    });
  });

  describe('streaming', () => {
    it('should stream SSE chunks, terminate with [DONE] and record the call', async () => {
      const response = await fetch(`${server.getUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...CHAT_PAYLOAD, stream: true }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const text = await response.text();
      expect(text).toContain('data: [DONE]');
      expect(text).toContain('"content":"Hello"');

      const doneIndex = text.indexOf('data: [DONE]');
      expect(doneIndex).toBeGreaterThan(-1);
      expect(text.slice(0, doneIndex)).toContain('"finish_reason":"stop"');
      expect(text.slice(0, doneIndex)).toContain('"total_tokens":10');

      expect(mockRecordCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'success', promptTokens: 4, completionTokens: 6, providerId: 'mock-provider' })
      );
    });

    it('should record an error event when the stream fails', async () => {
      mockExecuteStream.mockImplementation(async function* () {
        yield { content: 'partial', model: 'mock-model-1', providerId: 'mock-provider' };
        throw new RateLimitError('mock-provider');
      });

      const response = await fetch(`${server.getUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...CHAT_PAYLOAD, stream: true }),
      });

      const text = await response.text();
      expect(text).toContain('RATE_LIMITED');
      expect(text).not.toContain('data: [DONE]');
      expect(mockRecordCall).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rate_limited', providerId: 'mock-provider' })
      );
    });

    it('should stop upstream streaming when the client disconnects', async () => {
      const produced: number[] = [];
      mockExecuteStream.mockImplementation(async function* () {
        for (let i = 0; i < 20; i++) {
          produced.push(i);
          yield { content: `chunk-${i}`, model: 'mock-model-1', providerId: 'mock-provider' };
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
      });

      const controller = new AbortController();
      const response = await fetch(`${server.getUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...CHAT_PAYLOAD, stream: true }),
        signal: controller.signal,
      });

      const reader = response.body!.getReader();
      await reader.read();
      await reader.cancel();
      controller.abort();

      await vi.waitFor(
        () => {
          expect(mockRecordCall).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'error', errorMessage: 'Client disconnected before completion' })
          );
        },
        { timeout: 4000, interval: 50 }
      );

      expect(produced.length).toBeLessThan(20);
    });
  });

  describe('CORS', () => {
    it('should not allow arbitrary cross-origin requests', async () => {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('should allow a localhost origin', async () => {
      const response = await app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:5173' } });

      expect(response.statusCode).toBe(200);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });
  });

  describe('bearer auth', () => {
    const TOKEN = generateGatewayToken();
    let authServer: GatewayServer;
    let authApp: FastifyInstance;

    beforeEach(async () => {
      authServer = new GatewayServer({
        host: '127.0.0.1',
        port: 0,
        scheduler: { execute: mockChat, executeStream: mockExecuteStream } as never,
        authValidator: (token) => safeTokenEquals(token, TOKEN),
      });
      await authServer.start();
      authApp = (authServer as unknown as { app: FastifyInstance }).app;
    });

    afterEach(async () => {
      await authServer.stop();
    });

    it('should return 401 without an authorization header', async () => {
      const response = await authApp.inject({ method: 'POST', url: '/v1/chat/completions', payload: CHAT_PAYLOAD });

      expect(response.statusCode).toBe(401);
      expect(response.json().error.type).toBe('auth_required');
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('should return 403 for an invalid token and not run the route', async () => {
      const response = await authApp.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer wrong-token-value' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error.type).toBe('auth_failed');
      expect(mockListModels).not.toHaveBeenCalled();
    });

    it('should accept the valid token', async () => {
      const response = await authApp.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
    });

    it('should keep /health public', async () => {
      const response = await authApp.inject({ method: 'GET', url: '/health' });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('token generation', () => {
    it('should produce unique base64url tokens', () => {
      const tokens = new Set(Array.from({ length: 32 }, () => generateGatewayToken()));

      expect(tokens.size).toBe(32);
      for (const token of tokens) {
        expect(token.startsWith('fh_')).toBe(true);
        expect(token).toMatch(/^fh_[A-Za-z0-9_-]{32}$/);
      }
    });

    it('should compare tokens in constant time with length guard', () => {
      expect(safeTokenEquals('abc', 'abc')).toBe(true);
      expect(safeTokenEquals('abc', 'abcd')).toBe(false);
      expect(safeTokenEquals('abc', 'abd')).toBe(false);
      expect(safeTokenEquals('', '')).toBe(true);
    });
  });

  describe('host validation', () => {
    it('should refuse to bind a non-loopback host', async () => {
      const bad = new GatewayServer({ host: '0.0.0.0', port: 0, scheduler: {} as never });

      await expect(bad.start()).rejects.toThrow(/loopback/);
      expect(bad.getStatus()).toMatchObject({ running: false, lastError: expect.stringContaining('loopback') });
    });

    it('should report the actual listening port and last error on port conflict', async () => {
      const takenPort = server.getPort();
      const conflicting = new GatewayServer({ host: '127.0.0.1', port: takenPort, scheduler: {} as never });

      await expect(conflicting.start()).rejects.toThrow();
      const status = conflicting.getStatus();
      expect(status.running).toBe(false);
      expect(status.port).toBe(takenPort);
      expect(status.lastError).toContain('EADDRINUSE');
    });
  });

  describe('404 handler', () => {
    it('should return 404 for unknown routes', async () => {
      const response = await app.inject({ method: 'GET', url: '/unknown/path' });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBeDefined();
      expect(body.error.type).toBe('not_found');
    });
  });
});
