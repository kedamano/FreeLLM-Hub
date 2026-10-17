import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

/**
 * The contract is only useful if all three ends agree on it, and two of those links are
 * plain string literals that the type system cannot see: the preload bridge's
 * `invoke('channel')` calls and the main process's `registerIpcHandler('channel')` calls.
 */
function literalsIn(dir: string, pattern: RegExp): Set<string> {
  const found = new Set<string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        for (const match of readFileSync(full, 'utf8').matchAll(pattern)) found.add(match[1]);
      }
    }
  };
  walk(dir);
  return found;
}

// Route params are filled with values that must survive Fastify's own validation; a new
// placeholder name in the contract has to be added here so the sweep stays honest.
const SAMPLE_PARAMS: Record<string, string> = {
  providerId: 'groq',
  modelId: 'llama-3.3-70b-versatile',
  profileId: 'default',
  requestId: 'req_01',
  state: 'state_01',
  key: 'gateway.port',
  index: '2',
};

function sampleUrl(channel: IpcChannel): string {
  const binding = ADMIN_ROUTE_BINDINGS[channel];
  return `/api${binding.path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, name: string) => {
    const value = SAMPLE_PARAMS[name];
    if (!value) throw new Error(`No sample value for route parameter '${name}' (${channel})`);
    return value;
  })}`;
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/fh-contract-test', isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
}));

vi.mock('../../src/core/config/app-config.js', () => ({
  isElectronRuntime: () => false,
  resetAppConfigCache: () => undefined,
  getAppConfig: () => ({
    isDev: true,
    userDataPath: '/tmp/fh-contract-test',
    dataDir: '/tmp/fh-contract-test/data',
    logDir: '/tmp/fh-contract-test/logs',
    configFilePath: '/tmp/fh-contract-test/settings.json',
    dbPath: ':memory:',
    gatewayHost: '127.0.0.1',
    gatewayPort: 3001,
    requestTimeoutMs: 60000,
    logLevel: 'info',
  }),
}));

// The handlers under test delegate to services that are replaced below, so the database is
// only touched by the modules imported for their pure helpers.
vi.mock('../../src/core/database/database.js', () => ({
  getDatabase: () => ({
    exec: () => undefined,
    prepare: () => ({ all: () => [], get: () => undefined, run: () => ({ changes: 1 }) }),
  }),
  closeDatabase: () => undefined,
}));

const benign = vi.hoisted(() => () => ({ ok: true, success: true, providers: [], models: [] }));

vi.mock('../../src/main/services/provider-service.js', () => ({
  listProviders: benign,
  getProvider: benign,
  testProvider: benign,
  setProviderCredential: benign,
  removeProviderCredential: benign,
  getProviderCredentialMasked: benign,
  getProviderCredential: benign,
  listProviderCredentials: benign,
  addProviderCredential: benign,
  removeProviderCredentialSlot: benign,
  createCustomProvider: benign,
  deleteCustomProvider: benign,
  toggleProvider: benign,
  updateProviderBaseUrl: benign,
  saveProviderConfig: benign,
  setProviderQuota: benign,
  configureOAuth: benign,
  discoverProviderModels: benign,
  getPersistedProviderModels: benign,
}));

vi.mock('../../src/main/services/model-service.js', () => ({
  collectModels: benign,
  getModel: benign,
  discoverAllModels: benign,
}));

vi.mock('../../src/main/services/scheduler-service.js', () => ({
  schedulerStatus: benign,
  resetCircuit: benign,
  resetAllCircuits: benign,
}));

vi.mock('../../src/main/services/settings-service.js', () => ({
  getSetting: () => '1',
  setSetting: benign,
  getAllSettings: benign,
}));

vi.mock('../../src/main/services/usage-service.js', () => ({
  usageDashboard: benign,
  usageProviderStats: benign,
  usageDailyStats: benign,
  usageRecentCalls: benign,
  usageCostSummary: benign,
  usageQuotaUsage: benign,
  usageDailyByProvider: benign,
  auditList: benign,
  auditDetail: benign,
  auditSummary: benign,
}));

vi.mock('../../src/main/services/profile-service.js', () => ({
  listProfileViews: benign,
  activeProfileView: benign,
  getProfileView: benign,
  createProfile: benign,
  renameProfile: benign,
  removeProfile: benign,
  switchProfile: benign,
  duplicateIntoProfile: benign,
  resetProfilePool: benign,
}));

vi.mock('../../src/main/services/oauth-service.js', () => ({
  startAuthorization: benign,
  flowStatus: benign,
  cancelAuthorization: benign,
  refreshNow: benign,
  unlink: benign,
}));

import { registerAdminApi } from '../../src/server/admin-api.js';
import { IPC_CHANNELS, type IpcChannel } from '../../src/shared/ipc-channels.js';
import { ADMIN_ROUTE_BINDINGS } from '../../src/shared/api-contract.js';

describe('API contract coverage', () => {
  it('preload channels and main handlers match the declared channel list', () => {
    const declared = new Set<string>(IPC_CHANNELS);
    const preloaded = literalsIn(path.join(SRC, 'preload'), /invoke\('([^']+)'/g);
    const handled = literalsIn(path.join(SRC, 'main'), /registerIpcHandler\(\s*'([^']+)'/g);
    expect([...preloaded].sort()).toEqual([...declared].sort());
    expect([...handled].sort()).toEqual([...declared].sort());
  });

  describe('every bound route resolves on the server', () => {
    let app: FastifyInstance;

    beforeAll(async () => {
      app = Fastify();
      await registerAdminApi(app, {
        scheduler: {} as never,
        gateway: {
          getStatus: () => ({ running: false }),
          getToken: () => 'tok',
          generateToken: async () => 'tok',
          updateConfig: async () => ({ success: true }),
        } as never,
        version: '0.0.0-test',
        adminToken: null,
      });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it('reports 404 for a url the contract does not bind, so the sweep below means something', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/not-a-real-route' });
      expect(res.statusCode).toBe(404);
    });

    for (const channel of IPC_CHANNELS) {
      it(`${channel} → ${ADMIN_ROUTE_BINDINGS[channel].method} ${ADMIN_ROUTE_BINDINGS[channel].path}`, async () => {
        const binding = ADMIN_ROUTE_BINDINGS[channel];
        const res = await app.inject({ method: binding.method, url: sampleUrl(channel) });
        // 404 = path not registered, 405 = registered under another method: either one is a
        // contract/server drift that would surface as a broken page for web-mode users.
        // 5xx would mean the route exists but the stubs no longer match the handler.
        expect(res.statusCode, `${channel} ${binding.method} ${binding.path}`).toBeLessThan(500);
        expect(res.statusCode, `${channel} ${binding.method} ${binding.path}`).not.toBe(404);
        expect(res.statusCode, `${channel} ${binding.method} ${binding.path}`).not.toBe(405);
      });
    }
  });
});
