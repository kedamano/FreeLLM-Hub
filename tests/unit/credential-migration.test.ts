import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => {
    throw new Error('no database in unit tests');
  },
}));

import { registerAllProviders } from '../../src/core/providers/bootstrap';
import { baseUrlKey, settingsKey } from '../../src/core/providers/provider-state';
import type { ProviderAdapter, ProviderRegistry } from '../../src/core/providers/contracts';

function fakeSecrets(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    retrieve: (id: string) => rows.get(id) ?? null,
    store: (id: string, value: string) => {
      rows.set(id, value);
    },
    delete: (id: string) => rows.delete(id),
  };
}

function fakeSettings(initial: Record<string, string> = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    get: (key: string) => rows.get(key) ?? null,
    set: (key: string, value: string) => {
      rows.set(key, value);
    },
    delete: (key: string) => {
      rows.delete(key);
    },
  };
}

function fakeRegistry(): ProviderRegistry & { adapters: Map<string, ProviderAdapter> } {
  const adapters = new Map<string, ProviderAdapter>();
  return {
    adapters,
    register: (adapter) => {
      adapters.set(adapter.providerId, adapter);
    },
    unregister: (id) => {
      adapters.delete(id);
    },
    get: (id) => adapters.get(id),
    getAll: () => Array.from(adapters.values()),
    getByCapability: () => [],
    getAvailable: async () => [],
  };
}

describe('registerAllProviders credential naming', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('registers every built-in provider', () => {
    const registry = fakeRegistry();
    registerAllProviders(registry, fakeSecrets(), { settings: fakeSettings() });
    expect(registry.adapters.size).toBe(17);
    expect(registry.adapters.has('ollama')).toBe(true);
    expect(registry.adapters.has('minimax')).toBe(true);
  });

  it('loads a key saved under the canonical <providerId>-key id', () => {
    const registry = fakeRegistry();
    registerAllProviders(registry, fakeSecrets({ 'groq-key': 'gsk_test' }), {
      settings: fakeSettings(),
    });
    expect(registry.adapters.get('groq')!.getProviderConfig().credentialStatus).toBe('configured');
  });

  it('finds keys older builds stored under legacy ids and rewrites them canonically', () => {
    const secrets = fakeSecrets({
      'google-key': 'aiza-legacy',
      'huggingface-token': 'hf-legacy',
      'cloudflare-token': 'cf-legacy',
    });
    const registry = fakeRegistry();
    registerAllProviders(registry, secrets, { settings: fakeSettings() });
    expect(secrets.rows.get('google-gemini-key')).toBe('aiza-legacy');
    expect(secrets.rows.has('google-key')).toBe(false);
    expect(secrets.rows.get('huggingface-key')).toBe('hf-legacy');
    expect(secrets.rows.get('cloudflare-key')).toBe('cf-legacy');
  });

  it('applies a persisted Ollama base URL', () => {
    const registry = fakeRegistry();
    registerAllProviders(registry, fakeSecrets(), {
      settings: fakeSettings({ [baseUrlKey('ollama')]: 'http://192.168.1.20:11434' }),
    });
    expect(registry.adapters.get('ollama')!.getProviderConfig().baseUrl).toBe(
      'http://192.168.1.20:11434'
    );
  });

  it('migrates the legacy ollama-config blob out of the secret store', () => {
    const secrets = fakeSecrets({ 'ollama-config': JSON.stringify({ baseUrl: 'http://10.0.0.5:11434' }) });
    const settings = fakeSettings();
    const registry = fakeRegistry();
    registerAllProviders(registry, secrets, { settings });
    expect(settings.rows.get(baseUrlKey('ollama'))).toBe('http://10.0.0.5:11434');
    expect(secrets.rows.has('ollama-config')).toBe(false);
    expect(registry.adapters.get('ollama')!.getProviderConfig().baseUrl).toBe('http://10.0.0.5:11434');
  });

  it('assembles the Cloudflare endpoint from a persisted account id', () => {
    const registry = fakeRegistry();
    registerAllProviders(registry, fakeSecrets({ 'cloudflare-key': 'cf_token' }), {
      settings: fakeSettings({
        [settingsKey('cloudflare')]: JSON.stringify({ accountId: 'acc_777' }),
      }),
    });
    const cf = registry.adapters.get('cloudflare')!.getProviderConfig();
    expect(cf.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc_777/ai/v1');
    expect(cf.readiness?.ready).toBe(true);
  });

  it('honours a persisted disabled flag', () => {
    const registry = fakeRegistry();
    registerAllProviders(registry, fakeSecrets({ 'groq-key': 'gsk' }), {
      settings: fakeSettings({ 'provider-enabled:groq': 'false' }),
    });
    expect(registry.adapters.get('groq')!.getProviderConfig().isEnabled).toBe(false);
  });
});
