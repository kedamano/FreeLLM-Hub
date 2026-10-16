import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/database/database.js', () => {
  const providerRows = new Map<string, Record<string, unknown>>();
  const settings = new Map<string, string>();
  const db = {
    exec: () => undefined,
    transaction(fn: () => void) {
      return fn;
    },
    prepare(sql: string) {
      if (sql.includes('SELECT id FROM providers')) {
        return { all: () => [...providerRows.keys()].map((id) => ({ id })) };
      }
      if (sql.includes('INSERT INTO providers')) {
        return {
          run: (
            id: string,
            display_name: string,
            auth_type: string,
            base_url: string,
            is_enabled: number,
            is_built_in: number,
            credential_status: string
          ) => {
            providerRows.set(id, {
              id,
              display_name,
              auth_type,
              base_url,
              is_enabled,
              is_built_in,
              credential_status,
            });
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('UPDATE providers SET base_url')) {
        return {
          run: (base_url: string, id: string) => {
            const row = providerRows.get(id);
            if (row) providerRows.set(id, { ...row, base_url });
            return { changes: row ? 1 : 0 };
          },
        };
      }
      if (sql.includes('DELETE FROM providers WHERE id = ?')) {
        return { run: (id: string) => ({ changes: providerRows.delete(id) ? 1 : 0 }) };
      }
      if (sql.includes('DELETE FROM models WHERE provider_id = ?')) {
        return { run: () => ({ changes: 0 }) };
      }
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
import { OpenAICompatibleAdapter } from '../../src/core/providers/openai-compatible/adapter';
import { makeCustomProviderId } from '../../src/core/providers/bootstrap';
import * as providerService from '../../src/main/services/provider-service';
import { Scheduler } from '../../src/scheduler/scheduler';

function makeBuiltInStub(id: string) {
  return new OpenAICompatibleAdapter({
    providerId: id,
    providerName: id,
    baseUrl: 'https://example.com/v1',
    authType: 'api-key',
  });
}

describe('makeCustomProviderId', () => {
  it('slugifies ascii names and dedupes', () => {
    const taken = new Set(['groq', 'custom-relay']);
    expect(makeCustomProviderId('My Relay', taken)).toBe('custom-my-relay');
    expect(makeCustomProviderId('My Relay', new Set(['custom-my-relay']))).toBe('custom-my-relay-2');
  });

  it('falls back to a generic id for non-ascii names', () => {
    expect(makeCustomProviderId('我的中转站', new Set())).toBe('custom-provider');
    expect(makeCustomProviderId('我的中转站', new Set(['custom-provider']))).toBe('custom-provider-2');
  });
});

describe('custom provider CRUD', () => {
  const registry = getProviderRegistry();
  const scheduler = new Scheduler();
  let createdId = '';

  beforeEach(() => {
    createdId = '';
  });

  afterEach(() => {
    if (createdId) registry.unregister(createdId);
    registry.unregister('stub-builtin');
  });

  it('creates a custom provider and persists it with credential', () => {
    const res = providerService.createCustomProvider({
      name: 'Codex Relay',
      baseUrl: 'https://codex-relay.example/v1/',
      apiKey: 'sk-test-123',
    });
    createdId = res.providerId ?? '';

    expect(res.success).toBe(true);
    expect(createdId).toBe('custom-codex-relay');
    const adapter = registry.get(createdId);
    expect(adapter).toBeTruthy();
    const config = adapter!.getProviderConfig();
    expect(config.isBuiltIn).toBe(false);
    expect(config.baseUrl).toBe('https://codex-relay.example/v1');
    expect(config.credentialStatus).toBe('configured');
    expect(registry.getAll().some((a) => a.providerId === createdId)).toBe(true);
    const cred = providerService.getProviderCredential(createdId);
    expect(cred.credential).toBe('sk-test-123');
  });

  it('rejects invalid input', () => {
    expect(providerService.createCustomProvider({ name: '', baseUrl: 'https://a.dev/v1' }).success).toBe(false);
    expect(providerService.createCustomProvider({ name: 'x', baseUrl: 'ftp://a.dev' }).success).toBe(false);
  });

  it('refuses to delete built-in providers', () => {
    registry.register(makeBuiltInStub('stub-builtin'));
    const res = providerService.deleteCustomProvider(scheduler, 'stub-builtin');
    expect(res.success).toBe(false);
    expect(registry.get('stub-builtin')).toBeTruthy();
  });

  it('deletes a custom provider with credential cleanup', () => {
    const created = providerService.createCustomProvider({
      name: 'To Delete',
      baseUrl: 'https://del.example/v1',
      apiKey: 'sk-del',
    });
    createdId = created.providerId ?? '';
    expect(registry.get(createdId)).toBeTruthy();

    const res = providerService.deleteCustomProvider(scheduler, createdId);
    expect(res.success).toBe(true);
    expect(registry.get(createdId)).toBeUndefined();
    expect(providerService.getProviderCredential(createdId).credential).toBeNull();
    createdId = '';
  });

  it('persists base URL updates for custom providers only', () => {
    const created = providerService.createCustomProvider({
      name: 'Relocating',
      baseUrl: 'https://old.example/v1',
    });
    createdId = created.providerId ?? '';

    expect(providerService.updateProviderBaseUrl(createdId, 'https://new.example/v1').success).toBe(true);
    expect(registry.get(createdId)!.getProviderConfig().baseUrl).toBe('https://new.example/v1');

    registry.register(makeBuiltInStub('stub-builtin'));
    providerService.updateProviderBaseUrl('stub-builtin', 'https://moved.example/v1');
    expect(registry.get('stub-builtin')!.getProviderConfig().baseUrl).toBe('https://moved.example/v1');
  });
});
