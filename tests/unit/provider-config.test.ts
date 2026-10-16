import { describe, it, expect, beforeEach, vi } from 'vitest';

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
import { createCloudflareAdapter } from '../../src/core/providers/cloudflare/adapter';
import { createOllamaAdapter } from '../../src/core/providers/local/ollama-adapter';
import { settingsBackedStore } from '../../src/core/providers/bootstrap';
import { baseUrlKey, settingsKey } from '../../src/core/providers/provider-state';
import * as providerService from '../../src/main/services/provider-service';

describe('provider config persistence', () => {
  const registry = getProviderRegistry();

  beforeEach(() => {
    registry.unregister('cloudflare');
    registry.unregister('ollama');
    registry.register(createCloudflareAdapter(undefined, 'cf_token'));
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
