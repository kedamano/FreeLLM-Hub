import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const recorder = vi.hoisted(() => ({ recordCall: vi.fn() }));
const audit = vi.hoisted(() => ({
  begin: vi.fn(() => true),
  event: vi.fn(() => true),
  complete: vi.fn(() => true),
  rejected: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp/fh-embed-test', isPackaged: false },
}));

vi.mock('../../src/core/config/app-config.js', () => ({
  isElectronRuntime: () => false,
  resetAppConfigCache: () => undefined,
  getAppConfig: () => ({
    isDev: true,
    userDataPath: '/tmp/fh-embed-test',
    dataDir: '/tmp/fh-embed-test/data',
    logDir: '/tmp/fh-embed-test/logs',
    configFilePath: '/tmp/fh-embed-test/settings.json',
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
  getProviderRegistry: () => ({ getAll: () => registryState.adapters, get: (id: string) => registryState.byId[id] }),
}));

import { GatewayServer } from '../../src/main/gateway/server';

const registryState: {
  adapters: Array<Record<string, unknown>>;
  byId: Record<string, Record<string, unknown>>;
} = { adapters: [], byId: {} };

function adapter(providerId: string, impl?: (model: string) => Promise<unknown>) {
  return {
    providerId,
    providerName: providerId,
    embeddings: impl
      ? async (input: { model: string }) =>
          impl(input.model)
      : undefined,
    getProviderConfig: () => ({
      id: providerId,
      displayName: providerId,
      authType: 'api-key',
      baseUrl: 'https://x/v1',
      isEnabled: true,
      isBuiltIn: true,
      credentialStatus: 'configured',
    }),
  };
}

describe('/v1/embeddings route', () => {
  let server: GatewayServer;
  let app: FastifyInstance;

  beforeEach(async () => {
    registryState.adapters = [];
    registryState.byId = {};
    server = new GatewayServer({ host: '127.0.0.1', port: 0, scheduler: {} as never });
    await server.start();
    app = (server as unknown as { app: FastifyInstance }).app;
  });

  afterEach(async () => {
    await server.stop();
    vi.clearAllMocks();
  });

  it('dispatches to the first enabled adapter that implements embeddings', async () => {
    registryState.adapters = [adapter('no-embed'), adapter('siliconflow', async (model) => ({
      model,
      data: [{ index: 0, embedding: [0.1, 0.2] }],
      usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
    }))];
    registryState.byId = { 'no-embed': registryState.adapters[0], siliconflow: registryState.adapters[1] };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { model: 'bge-m3', input: '本地 RAG 分块' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ object: 'list', model: 'bge-m3', usage: { prompt_tokens: 5 } });
    expect(body.data).toEqual([{ index: 0, embedding: [0.1, 0.2] }]);
    expect(recorder.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'siliconflow', statusCode: 200 })
    );
  });

  it('addresses a provider exactly via provider/model', async () => {
    const calls: string[] = [];
    const first = adapter('openai', async () => {
      calls.push('openai');
      throw new Error('should not be called');
    });
    const second = adapter('siliconflow', async (model) => {
      calls.push('siliconflow');
      return { model, data: [{ index: 0, embedding: [1] }], usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } };
    });
    registryState.adapters = [first, second];
    registryState.byId = { openai: first, siliconflow: second };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { model: 'siliconflow/bge-m3', input: 'x' },
    });
    expect(response.statusCode).toBe(200);
    expect(calls).toEqual(['siliconflow']);
  });

  it('falls through a failing provider and reports the collected failures', async () => {
    const first = adapter('groq', async () => {
      throw new Error('embeddings not supported');
    });
    const second = adapter('siliconflow', async (model) => ({
      model,
      data: [{ index: 0, embedding: [3] }],
      usage: { promptTokens: 2, completionTokens: 0, totalTokens: 2 },
    }));
    registryState.adapters = [first, second];
    registryState.byId = { groq: first, siliconflow: second };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { model: 'bge-m3', input: ['a', 'b'] },
    });
    expect(response.statusCode).toBe(200);
    expect(recorder.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'groq', status: 'error' })
    );
    expect(recorder.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'siliconflow', status: 'success', attempt: 2 })
    );
  });

  it('answers 404 with an audit row when nothing serves embeddings', async () => {
    registryState.adapters = [adapter('no-embed')];
    registryState.byId = { 'no-embed': registryState.adapters[0] };

    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { model: 'bge-m3', input: 'x' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('MODEL_NOT_FOUND');
    expect(audit.complete).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected', statusCode: 404, errorCode: 'MODEL_NOT_FOUND' })
    );
  });

  it('rejects a missing input before touching any provider', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/embeddings',
      payload: { model: 'bge-m3' },
    });
    expect(response.statusCode).toBe(400);
    expect(audit.rejected).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 400, errorCode: 'BAD_REQUEST' })
    );
    expect(recorder.recordCall).not.toHaveBeenCalled();
  });
});
