import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/core/database/database.js', () => {
  const settings = new Map<string, string>();
  const db = {
    exec: () => undefined,
    transaction(fn: () => void) {
      return fn;
    },
    prepare(sql: string) {
      if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
        return { get: (key: string) => (settings.has(key) ? { value: settings.get(key) } : undefined) };
      }
      if (sql.includes('INSERT OR REPLACE INTO settings')) {
        return {
          run: (key: string, value: string) => {
            settings.set(key, value);
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('DELETE FROM settings WHERE key = ?')) {
        return { run: (key: string) => ({ changes: settings.delete(key) ? 1 : 0 }) };
      }
      throw new Error(`Unexpected SQL in test db mock: ${sql}`);
    },
    __settings: settings,
  };
  return { getDatabase: () => db as never, closeDatabase: () => undefined };
});

vi.mock('../../src/main/security/credential-store.js', () => {
  const data = new Map<string, string>();
  const store = {
    store: (id: string, value: string) => data.set(id, value),
    retrieve: (id: string) => data.get(id) ?? null,
    has: (id: string) => data.has(id),
    delete: (id: string) => data.delete(id),
    list: () => [...data.keys()],
    isAvailable: () => true,
  };
  return { getCredentialStore: () => store };
});

import { getProviderRegistry } from '../../src/core/providers/registry';
import { PROVIDER_SEEDS_BY_ID } from '../../src/core/providers/catalog';
import { createStaticAdapter } from '../../src/core/providers/openai-compatible/static-adapter';
import { createOllamaAdapter } from '../../src/core/providers/local/ollama-adapter';
import { settingsBackedStore } from '../../src/core/providers/bootstrap';
import { baseUrlKey, settingsKey } from '../../src/core/providers/provider-state';
import * as providerService from '../../src/main/services/provider-service';

describe('provider config persistence', () => {
  const registry = getProviderRegistry();

  beforeEach(() => {
    registry.unregister('cloudflare');
    registry.unregister('ollama');
    registry.register(createStaticAdapter(PROVIDER_SEEDS_BY_ID.cloudflare, 'cf_token'));
    registry.register(createOllamaAdapter());
  });

  it('saves Cloudflare accountId and derives the endpoint', () => {
    const res = providerService.saveProviderConfig('cloudflare', { settings: { accountId: 'acc_42' } });
    expect(res.success).toBe(true);
    const config = registry.get('cloudflare')!.getProviderConfig();
    expect(config.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc_42/ai/v1');
    expect(config.readiness?.ready).toBe(true);
    expect(JSON.parse(settingsBackedStore.get(settingsKey('cloudflare'))!)).toEqual({ accountId: 'acc_42' });
  });

  it('rejects an empty required setting instead of reporting success', () => {
    const res = providerService.saveProviderConfig('cloudflare', { settings: { accountId: '  ' } });
    expect(res.success).toBe(false);
    expect(res.error).toContain('Account ID');
  });

  it('rejects unknown setting keys', () => {
    const res = providerService.saveProviderConfig('cloudflare', { settings: { nope: '1' } });
    expect(res.success).toBe(false);
    expect(res.error).toContain('未知配置项');
  });

  it('persists a built-in base url so a restart keeps it', () => {
    expect(providerService.updateProviderBaseUrl('ollama', 'http://192.168.1.9:11434').success).toBe(true);
    expect(settingsBackedStore.get(baseUrlKey('ollama'))).toBe('http://192.168.1.9:11434');
    expect(registry.get('ollama')!.getProviderConfig().baseUrl).toBe('http://192.168.1.9:11434');
  });

  it('fails a malformed base url instead of silently accepting it', () => {
    const res = providerService.updateProviderBaseUrl('ollama', '192.168.1.9:11434');
    expect(res.success).toBe(false);
    expect(res.error).toContain('http');
  });
});

describe('manual model discovery reporting', () => {
  const registry = getProviderRegistry();

  function fakeAdapter(
    providerId: string,
    models: unknown[],
    probe: { valid: boolean; reason?: string }
  ) {
    return {
      providerId,
      listModels: async () => models,
      validateCredential: async () => probe,
      isAvailable: async () => probe.valid,
      getProviderConfig: () => ({ providerId, baseUrl: 'http://127.0.0.1:1', authType: 'api-key' }),
    } as never;
  }

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    registry.unregister('silent');
    warn.mockRestore();
  });

  it('surfaces an unreachable service instead of reporting an empty catalogue', async () => {
    registry.register(
      fakeAdapter('silent', [], { valid: false, reason: '无法连接到 Ollama (http://localhost:11434): fetch failed' })
    );

    const res = await providerService.discoverProviderModels('silent');

    expect(res.success).toBe(false);
    expect(res.error).toContain('fetch failed');
    expect(res.models).toEqual([]);
  });

  it('keeps a genuinely empty catalogue successful', async () => {
    registry.register(fakeAdapter('silent', [], { valid: true }));

    const res = await providerService.discoverProviderModels('silent');

    expect(res.success).toBe(true);
    expect(res.models).toEqual([]);
  });

  it('does not probe when models came back', async () => {
    const probe = vi.fn(async () => ({ valid: false, reason: 'should not be called' }));
    registry.register({ ...fakeAdapter('silent', [{ id: 'llama-3.1-8b' }], { valid: false }), validateCredential: probe } as never);

    const res = await providerService.discoverProviderModels('silent');

    expect(res.success).toBe(true);
    expect(probe).not.toHaveBeenCalled();
  });
});
