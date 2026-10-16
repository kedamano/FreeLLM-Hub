import { beforeEach, describe, expect, it, vi } from 'vitest';

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
        return { run: () => ({ changes: 1 }) };
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
import { getCredentialStore } from '../../src/main/security/credential-store';
import * as providerService from '../../src/main/services/provider-service';

function makeAdapter(providerId: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    providerId,
    providerName: providerId,
    baseUrl: 'https://api.example.com/v1',
    authType: 'api-key',
  });
}

describe('multi-key credential slots', () => {
  beforeEach(() => {
    const store = getCredentialStore();
    for (const key of store.list()) store.delete(key);
    const registry = getProviderRegistry();
    for (const a of registry.getAll()) registry.unregister(a.providerId);
    registry.register(makeAdapter('groq'));
  });

  it('stores primary and backup keys in separate slots', () => {
    expect(providerService.setProviderCredential('groq', 'sk-primary-1234567890').success).toBe(true);
    const added = providerService.addProviderCredential('groq', 'sk-backup-abcdefghij');
    expect(added.success).toBe(true);
    expect(added.credentials).toHaveLength(2);
    expect(added.credentials![1].keyId).toBe('groq-key-2');
    expect(added.credentials![0].masked).toContain('…');
    expect(JSON.stringify(added.credentials)).not.toContain('sk-primary');
  });

  it('repacks slots when a middle key is removed', () => {
    providerService.setProviderCredential('groq', 'key-one-aaaaaaaa');
    providerService.addProviderCredential('groq', 'key-two-bbbbbbbb');
    providerService.addProviderCredential('groq', 'key-two-bbbbbbbb'.replace('two', 'three'));
    const res = providerService.removeProviderCredentialSlot('groq', 1);
    expect(res.success).toBe(true);
    expect(res.credentials).toHaveLength(2);
    expect(providerService.getProviderCredential('groq', 0).credential).toBe('key-one-aaaaaaaa');
    expect(providerService.getProviderCredential('groq', 1).credential).toBe('key-three-bbbbbbbb');
    expect(providerService.getProviderCredential('groq', 2).credential).toBeNull();
  });

  it('enforces the per-provider key cap', () => {
    providerService.setProviderCredential('groq', 'k0');
    for (let i = 1; i < providerService.MAX_CREDENTIALS_PER_PROVIDER; i++) {
      expect(providerService.addProviderCredential('groq', `k${i}`).success).toBe(true);
    }
    const overflow = providerService.addProviderCredential('groq', 'one-too-many');
    expect(overflow.success).toBe(false);
    expect(overflow.error).toContain('最多');
  });

  it('removeProviderCredential clears every slot', () => {
    providerService.setProviderCredential('groq', 'k0');
    providerService.addProviderCredential('groq', 'k1');
    providerService.removeProviderCredential('groq');
    expect(providerService.listProviderCredentials('groq').credentials).toHaveLength(0);
  });
});

describe('adapter key rotation on rate limit', () => {
  const okChat = () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
  });

  const limited = () => ({
    ok: false,
    status: 429,
    headers: new Headers(),
    text: async () => 'rate limited',
  });

  it('retries the next key after a 429 and succeeds', async () => {
    const auths: string[] = [];
    vi.stubGlobal('fetch', (url: unknown, init: { headers: Record<string, string> }) => {
      auths.push(init.headers.Authorization);
      return Promise.resolve(auths.length === 1 ? limited() : okChat());
    });
    const adapter = makeAdapter('rotate-ok');
    adapter.setCredentials(['key-a', 'key-b']);
    const result = await adapter.chat([{ role: 'user', content: 'hi' }], 'test-model');
    expect(result.content).toBe('hello');
    expect(auths).toEqual(['Bearer key-a', 'Bearer key-b']);
    vi.unstubAllGlobals();
  });

  it('throws after every key is rate limited', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      return Promise.resolve(limited());
    });
    const adapter = makeAdapter('rotate-fail');
    adapter.setCredentials(['key-a', 'key-b']);
    await expect(adapter.chat([{ role: 'user', content: 'hi' }], 'test-model')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(calls).toBe(2);
    vi.unstubAllGlobals();
  });

  it('does not rotate on non-key errors', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', () => {
      calls++;
      return Promise.resolve({
        ok: false,
        status: 400,
        headers: new Headers(),
        text: async () => 'bad request',
      });
    });
    const adapter = makeAdapter('rotate-skip');
    adapter.setCredentials(['key-a', 'key-b']);
    await expect(adapter.chat([{ role: 'user', content: 'hi' }], 'test-model')).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(calls).toBe(1);
    vi.unstubAllGlobals();
  });
});
