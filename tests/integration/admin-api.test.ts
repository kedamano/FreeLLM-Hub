import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const h = vi.hoisted(() => {
  const providerConfig = {
    id: 'groq',
    displayName: 'Groq',
    authType: 'api-key' as const,
    baseUrl: 'https://api.groq.com/openai/v1',
    isEnabled: true,
    isBuiltIn: true,
    credentialStatus: 'unconfigured',
    metadata: { description: 'mock' },
  };
  return {
    providerConfig,
    listModels: vi.fn(),
    validateCredential: vi.fn(),
    getModel: vi.fn(),
  };
});

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: { getPath: () => '/tmp/fh-admin-test', isPackaged: false },
}));

vi.mock('../../src/core/config/app-config.js', () => ({
  isElectronRuntime: () => false,
  resetAppConfigCache: () => undefined,
  getAppConfig: () => ({
    isDev: true,
    userDataPath: '/tmp/fh-admin-test',
    dataDir: '/tmp/fh-admin-test/data',
    logDir: '/tmp/fh-admin-test/logs',
    configFilePath: '/tmp/fh-admin-test/settings.json',
    dbPath: ':memory:',
    gatewayHost: '127.0.0.1',
    gatewayPort: 3001,
    logLevel: 'info',
  }),
}));

vi.mock('../../src/core/database/database.js', () => {
  const settings = new Map<string, string>();
  const modelRows = new Map<string, Record<string, unknown>>();
  const providerRows = new Map<string, Record<string, unknown>>();
  const db = {
    exec: () => undefined,
    transaction(fn: () => void) {
      return fn;
    },
    prepare(sql: string) {
      if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
        return {
          get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined),
        };
      }
      if (sql.includes('INSERT OR REPLACE INTO settings')) {
        return {
          run: (key: string, value: string) => {
            settings.set(key, value);
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('SELECT key, value FROM settings')) {
        return { all: () => [...settings.entries()].map(([key, value]) => ({ key, value })) };
      }
      if (sql.includes('DELETE FROM settings WHERE key = ?')) {
        return {
          run: (key: string) => {
            settings.delete(key);
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('INSERT INTO providers')) {
        return {
          run: (id: string, display_name: string, auth_type: string, base_url: string) => {
            providerRows.set(id, { id, display_name, auth_type, base_url });
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('INSERT INTO models')) {
        return {
          run: (
            id: string,
            provider_id: string,
            display_name: string,
            description: string | null,
            capabilities: string,
            pricing: string,
            rate_limits: string | null,
            status: string
          ) => {
            modelRows.set(`${provider_id}:${id}`, {
              id,
              provider_id,
              display_name,
              description,
              capabilities,
              pricing,
              rate_limits,
              status,
              discovered_at: '2026-10-16 00:00:00',
              last_checked_at: '2026-10-16 00:00:00',
            });
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('SELECT * FROM models WHERE provider_id = ?')) {
        return {
          all: (providerId: string) =>
            [...modelRows.values()].filter((row) => row.provider_id === providerId),
        };
      }
      throw new Error(`Unexpected SQL in test db mock: ${sql}`);
    },
  };
  return { getDatabase: () => db as never, closeDatabase: () => undefined };
});

const usageMocks = vi.hoisted(() => ({
  getDashboardStats: vi.fn(),
  getProviderStatistics: vi.fn(),
  getDailyStats: vi.fn(),
  getRecentCalls: vi.fn(),
}));

vi.mock('../../src/usage/statistics.js', () => ({
  getDashboardStats: usageMocks.getDashboardStats,
  getProviderStatistics: usageMocks.getProviderStatistics,
  getDailyStats: usageMocks.getDailyStats,
  getProviderHealth: vi.fn(),
}));

vi.mock('../../src/usage/usage-recorder.js', () => ({
  recordCall: vi.fn(),
  getRecentCalls: usageMocks.getRecentCalls,
  getCallsByProvider: vi.fn(),
  deleteOldLogs: vi.fn(),
  mapCallLogRow: (row: unknown) => row,
}));

vi.mock('../../src/main/security/credential-store.js', () => {
  const data = new Map<string, string>();
  const store = {
    store: (id: string, value: string) => {
      data.set(id, value);
    },
    retrieve: (id: string) => data.get(id) ?? null,
    has: (id: string) => data.has(id),
    delete: (id: string) => data.delete(id),
    list: () => [...data.keys()],
    isAvailable: () => true,
  };
  return { getCredentialStore: () => store };
});

vi.mock('../../src/core/providers/registry.js', () => {
  const adapter = {
    providerId: 'groq',
    providerName: 'Groq',
    getProviderConfig: () => h.providerConfig,
    listModels: (...args: unknown[]) => h.listModels(...args),
    validateCredential: () => h.validateCredential(),
    getModel: (...args: unknown[]) => h.getModel(...args),
    isAvailable: async () => true,
  };
  const registry = {
    getAll: () => [adapter],
    get: (id: string) => (id === 'groq' ? adapter : undefined),
    register: vi.fn(),
    unregister: vi.fn(),
    getAvailable: async () => [adapter],
  };
  return { getProviderRegistry: () => registry };
});

import { registerAdminApi } from '../../src/server/admin-api';
import type { GatewayManager } from '../../src/main/gateway/gateway-manager';
import { Scheduler } from '../../src/scheduler/scheduler';
import { getCredentialStore } from '../../src/main/security/credential-store';

const STATIC_MODELS = [
  {
    id: 'llama-3.3-70b-versatile',
    providerId: 'groq',
    displayName: 'Llama 3.3 70B',
    capabilities: { supported: ['chat'], contextWindow: 128000 },
    pricing: { type: 'free', currency: 'USD' },
    status: 'available',
  },
];

const gatewayStatusShape = {
  running: true,
  host: '127.0.0.1',
  port: 3001,
  url: 'http://127.0.0.1:3001',
  authEnabled: false,
  hasToken: false,
  lastError: null,
};

function createGatewayFake() {
  return {
    getStatus: () => ({ ...gatewayStatusShape }),
    getToken: () => 'fh_testtoken',
    generateToken: async () => 'fh_rotated_token',
    updateConfig: async (config: Record<string, unknown>) => ({
      success: true,
      config: { host: '127.0.0.1', port: 3001, authEnabled: false, ...config },
      status: { ...gatewayStatusShape },
    }),
    getGatewayConfig: () => ({ host: '127.0.0.1', port: 3001, authEnabled: false }),
  };
}

describe('Admin API', () => {
  let app: FastifyInstance;
  const scheduler = new Scheduler();
  const gateway = createGatewayFake();

  beforeEach(async () => {
    h.listModels.mockReset();
    h.validateCredential.mockReset();
    h.getModel.mockReset();
    Object.values(usageMocks).forEach((fn) => fn.mockReset());
    h.providerConfig.isEnabled = true;

    app = Fastify();
    await registerAdminApi(app, {
      scheduler,
      gateway: gateway as unknown as GatewayManager,
      version: '0.1.0-test',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves app metadata', async () => {
    const version = await app.inject({ method: 'GET', url: '/api/app/version' });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toBe('0.1.0-test');

    const dataPath = await app.inject({ method: 'GET', url: '/api/app/data-path' });
    expect(dataPath.json()).toBe('/tmp/fh-admin-test/data');
  });

  it('lists providers with credential status', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/providers' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('groq');
    expect(list[0].hasCredential).toBe(false);
    expect(list[0].isEnabled).toBe(true);
  });

  it('stores a credential and reflects it in the provider list', async () => {
    const set = await app.inject({
      method: 'POST',
      url: '/api/providers/groq/credential',
      payload: { credential: 'sk-test-secret' },
    });
    expect(set.json()).toEqual({ success: true });
    expect(getCredentialStore().has('groq-key')).toBe(true);

    const list = await app.inject({ method: 'GET', url: '/api/providers' });
    expect((list.json() as Array<{ hasCredential: boolean }>)[0].hasCredential).toBe(true);

    const remove = await app.inject({ method: 'DELETE', url: '/api/providers/groq/credential' });
    expect(remove.json()).toEqual({ success: true });

    const list2 = await app.inject({ method: 'GET', url: '/api/providers' });
    expect((list2.json() as Array<{ hasCredential: boolean }>)[0].hasCredential).toBe(false);
  });

  it('toggles a provider and persists the flag on the config', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/groq/toggle',
      payload: { enabled: false },
    });
    expect(res.json()).toEqual({ success: true, providerId: 'groq', isEnabled: false });
    expect(h.providerConfig.isEnabled).toBe(false);

    const list = await app.inject({ method: 'GET', url: '/api/providers' });
    expect((list.json() as Array<{ isEnabled: boolean }>)[0].isEnabled).toBe(false);
  });

  it('discovers models and falls back to static list errors', async () => {
    h.listModels.mockResolvedValue(STATIC_MODELS);
    const ok = await app.inject({ method: 'POST', url: '/api/providers/groq/discover-models' });
    expect(ok.json()).toEqual({ success: true, providerId: 'groq', models: STATIC_MODELS });

    h.listModels.mockRejectedValue(new Error('ECONNREFUSED'));
    const failed = await app.inject({ method: 'POST', url: '/api/providers/groq/discover-models' });
    const body = failed.json() as { success: boolean; models: unknown[]; error: string };
    expect(body.success).toBe(false);
    expect(body.models).toEqual([]);
    expect(body.error).toContain('ECONNREFUSED');
  });

  it('persists discovered models and serves them back via GET /models', async () => {
    h.listModels.mockResolvedValue(STATIC_MODELS);
    const discover = await app.inject({ method: 'POST', url: '/api/providers/groq/discover-models' });
    expect((discover.json() as { success: boolean }).success).toBe(true);

    const res = await app.inject({ method: 'GET', url: '/api/providers/groq/models' });
    expect(res.statusCode).toBe(200);
    const models = res.json() as Array<Record<string, unknown>>;
    expect(models.map((m) => m.id)).toEqual(STATIC_MODELS.map((m) => m.id));
    expect(models[0].capabilities).toEqual(STATIC_MODELS[0].capabilities);
    expect(models[0].pricing).toEqual(STATIC_MODELS[0].pricing);
  });

  it('collects models for the catalog', async () => {
    h.listModels.mockResolvedValue(STATIC_MODELS);
    const res = await app.inject({ method: 'GET', url: '/api/models' });
    const models = res.json() as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe('llama-3.3-70b-versatile');
    expect(models[0].providerId).toBe('groq');
  });

  it('enforces the settings allowlist', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/not_allowed_key',
      payload: { value: 'x' },
    });
    expect(bad.statusCode).toBe(200);
    const badBody = bad.json() as { success: boolean; error: string };
    expect(badBody.success).toBe(false);
    expect(badBody.error).toContain('not allowed');

    const ok = await app.inject({
      method: 'PUT',
      url: '/api/settings/theme',
      payload: { value: 'dark' },
    });
    expect(ok.json()).toEqual({ success: true });

    const get = await app.inject({ method: 'GET', url: '/api/settings/theme' });
    expect(get.json()).toBe('dark');

    const getAll = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(getAll.json()).toEqual({ theme: 'dark' });
  });

  it('returns usage summary in the dashboard shape', async () => {
    usageMocks.getDashboardStats.mockReturnValue({
      totalRequests: 1,
      successRate: 1,
      totalTokensUsed: 30,
      totalCostSaved: 0,
      activeProviders: 1,
      availableModels: 0,
      recentCalls: [],
      providerStats: [
        { providerId: 'groq', providerName: 'groq', requestCount: 1, tokenCount: 30, successCount: 1, errorCount: 0 },
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/api/usage/summary' });
    const stats = res.json() as Record<string, unknown>;
    expect(stats.totalRequests).toBe(1);
    expect(stats.successRate).toBe(1);
    expect(stats.totalTokensUsed).toBe(30);
    expect(stats.providerStats).toBeInstanceOf(Array);
    expect((stats.providerStats as unknown[]).length).toBe(1);
  });

  it('returns recent calls and daily stats', async () => {
    usageMocks.getRecentCalls.mockReturnValue([{ id: 'l1', providerId: 'groq' }]);
    usageMocks.getDailyStats.mockReturnValue([{ date: '2026-10-16', requests: 1, tokens: 30, successRate: 1 }]);

    const recent = await app.inject({ method: 'GET', url: '/api/usage/recent?limit=10' });
    expect(recent.json()).toBeInstanceOf(Array);
    expect(recent.json()).toHaveLength(1);
    expect(usageMocks.getRecentCalls).toHaveBeenCalledWith(10);

    const daily = await app.inject({ method: 'GET', url: '/api/usage/timeseries?days=7' });
    expect(daily.json()).toBeInstanceOf(Array);
    // Usage queries are profile-scoped, so the active profile id travels with them.
    expect(usageMocks.getDailyStats).toHaveBeenCalledWith(7, 'default');
  });

  it('returns scheduler status and circuit resets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/scheduler/status' });
    const status = res.json() as { providers: Array<Record<string, unknown>> };
    expect(status.providers[0].providerId).toBe('groq');
    expect(status.providers[0].circuitState).toBe('closed');

    const reset = await app.inject({
      method: 'POST',
      url: '/api/scheduler/reset-circuit',
      payload: { providerId: 'groq' },
    });
    expect(reset.json()).toEqual({ success: true });

    const all = await app.inject({ method: 'POST', url: '/api/scheduler/reset-all-circuits' });
    expect(all.json()).toEqual({ success: true });
  });

  it('exposes gateway status, token and config update', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/gateway/status' });
    expect(status.json()).toEqual(gatewayStatusShape);

    const token = await app.inject({ method: 'GET', url: '/api/gateway/token' });
    expect(token.json()).toBe('fh_testtoken');

    const rotated = await app.inject({ method: 'POST', url: '/api/gateway/generate-token' });
    expect(rotated.json()).toBe('fh_rotated_token');

    const updated = await app.inject({
      method: 'PUT',
      url: '/api/gateway/config',
      payload: { port: 3002, authEnabled: false },
    });
    const body = updated.json() as { success: boolean; config: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.config.port).toBe(3002);
  });

  it('tests provider credentials', async () => {
    h.validateCredential.mockResolvedValue({ valid: true });
    const ok = await app.inject({ method: 'POST', url: '/api/providers/groq/test' });
    expect(ok.json()).toEqual({ success: true });

    h.validateCredential.mockRejectedValue(new Error('401 unauthorized'));
    const bad = await app.inject({ method: 'POST', url: '/api/providers/groq/test' });
    const body = bad.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe('string');
  });
});
