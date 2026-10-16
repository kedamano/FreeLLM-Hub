import { getProviderRegistry } from './registry.js';
import { OpenAICompatibleAdapter } from './openai-compatible/adapter.js';
import { getDatabase } from '../database/database.js';
import {
  createOllamaAdapter,
  createLMStudioAdapter,
  createGroqAdapter,
  createGoogleGeminiAdapter,
  createCloudflareAdapter,
  createHuggingFaceAdapter,
  createCerebrasAdapter,
  createSiliconFlowAdapter,
  createNvidiaAdapter,
  createOpenRouterAdapter,
  createModelScopeAdapter,
  createSenseNovaAdapter,
  createLongCatAdapter,
  createZhipuAdapter,
  createMoonshotAdapter,
  createDeepSeekAdapter,
  createMiniMaxAdapter,
} from './index.js';
import type { ProviderAdapter, ProviderRegistry } from './contracts.js';
import {
  resolveProviderCredential,
  credentialKeyFor,
  type SecretKeyStore,
} from './credential-keys.js';
import {
  migrateLegacyProviderFields,
  applyProviderOverrides,
  PROVIDER_ENABLED_PREFIX,
  type PlainKeyStore,
} from './provider-state.js';
import { deleteSetting, readSetting, writeSetting } from '../settings/settings-store.js';

export const settingsBackedStore: PlainKeyStore = {
  get: readSetting,
  set: writeSetting,
  delete: deleteSetting,
};

interface ReadCredentialStore {
  retrieve(id: string): string | null;
}

interface HotSwapAdapter {
  setEnabled?(enabled: boolean): void;
  setCredential?(credential: string | undefined, credentialId?: string): void;
  setCredentials?(credentials: string[]): void;
  updateBaseUrl?(baseUrl: string): void;
}

export function hotSwap(adapter: ProviderAdapter): HotSwapAdapter {
  return adapter as unknown as HotSwapAdapter;
}

export function applyEnabled(adapter: ProviderAdapter, enabled: boolean): void {
  const api = hotSwap(adapter);
  if (typeof api.setEnabled === 'function') {
    api.setEnabled(enabled);
    return;
  }
  adapter.getProviderConfig().isEnabled = enabled;
}

export function applyCredential(adapter: ProviderAdapter, credential: string | undefined, credentialId?: string): void {
  const api = hotSwap(adapter);
  if (typeof api.setCredential === 'function') api.setCredential(credential, credentialId);
}

export const ENABLED_KEY_PREFIX = PROVIDER_ENABLED_PREFIX;

export function collectSlotCredentials(store: ReadCredentialStore, providerId: string): string[] {
  const values: string[] = [];
  const primary = store.retrieve(credentialKeyFor(providerId));
  if (primary) values.push(primary);
  for (let i = 2; ; i++) {
    const extra = store.retrieve(`${credentialKeyFor(providerId)}-${i}`);
    if (!extra) break;
    values.push(extra);
  }
  return values;
}

type BuiltInFactory = (credential?: string) => ProviderAdapter;

const BUILT_IN_FACTORIES: Record<string, BuiltInFactory> = {
  ollama: () => createOllamaAdapter(),
  lmstudio: () => createLMStudioAdapter(),
  groq: (key) => createGroqAdapter(key),
  'google-gemini': (key) => createGoogleGeminiAdapter(key),
  cloudflare: (key) => createCloudflareAdapter(undefined, key),
  huggingface: (key) => createHuggingFaceAdapter(key),
  cerebras: (key) => createCerebrasAdapter(key),
  siliconflow: (key) => createSiliconFlowAdapter(key),
  nvidia: (key) => createNvidiaAdapter(key),
  openrouter: (key) => createOpenRouterAdapter(key),
  modelscope: (key) => createModelScopeAdapter(key),
  sensenova: (key) => createSenseNovaAdapter(key),
  longcat: (key) => createLongCatAdapter(key),
  zhipu: (key) => createZhipuAdapter(key),
  moonshot: (key) => createMoonshotAdapter(key),
  deepseek: (key) => createDeepSeekAdapter(key),
  minimax: (key) => createMiniMaxAdapter(key),
};

export interface RegisterAllProvidersOptions {
  settings?: PlainKeyStore;
  secrets?: SecretKeyStore;
}

export function registerAllProviders(
  registry: ProviderRegistry,
  credentialStore: ReadCredentialStore,
  options: RegisterAllProvidersOptions = {}
): void {
  const secrets: SecretKeyStore = options.secrets ?? {
    retrieve: (id) => credentialStore.retrieve(id),
    store: (id, value) => {
      const writable = credentialStore as ReadCredentialStore & {
        store?: (id: string, value: string) => void;
      };
      writable.store?.(id, value);
    },
    delete: (id) => {
      const writable = credentialStore as ReadCredentialStore & {
        delete?: (id: string) => boolean;
      };
      return writable.delete?.(id) ?? false;
    },
  };

  const adapters: ProviderAdapter[] = [];

  for (const [providerId, factory] of Object.entries(BUILT_IN_FACTORIES)) {
    let credential: string | undefined;
    try {
      credential = resolveProviderCredential(secrets, providerId).credential ?? undefined;
    } catch (err) {
      console.warn(
        `[Bootstrap] ${providerId}: 凭证读取失败 (${err instanceof Error ? err.message : String(err)})`
      );
    }
    const adapter = factory(credential);
    adapters.push(adapter);
    registry.register(adapter);
  }

  for (const adapter of adapters) {
    const api = hotSwap(adapter);
    if (typeof api.setCredentials !== 'function') continue;
    const values = collectSlotCredentials(credentialStore, adapter.providerId);
    if (values.length > 1) api.setCredentials(values);
  }

  registerCustomProvidersFromDb(registry, credentialStore);

  const settings = options.settings ?? settingsBackedStore;
  const migrated = migrateLegacyProviderFields(secrets, settings, Object.keys(BUILT_IN_FACTORIES));
  if (migrated.length > 0) {
    console.log(`[Bootstrap] 已迁移旧版配置字段: ${migrated.join(', ')}`);
  }

  const { errors } = applyProviderOverrides(adapters, settings);
  for (const error of errors) console.warn(`[Bootstrap] ${error}`);

  console.log(`[Providers] Registered ${registry.getAll().length} providers`);
}

export const CUSTOM_PROVIDER_PREFIX = 'custom-';

export function makeCustomProviderId(name: string, existing: Set<string>): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = `${CUSTOM_PROVIDER_PREFIX}${slug || 'provider'}`;
  if (!existing.has(base)) return base;
  let n = 2;
  while (existing.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function registerCustomProvidersFromDb(
  registry: ProviderRegistry,
  credentialStore: ReadCredentialStore
): void {
  try {
    const rows = getDatabase()
      .prepare('SELECT id, display_name, base_url, is_enabled FROM providers WHERE is_built_in = 0')
      .all() as Array<{ id: string; display_name: string; base_url: string; is_enabled: number }>;
    for (const row of rows) {
      if (registry.get(row.id)) continue;
      const credential = credentialStore.retrieve(`${row.id}-key`);
      const adapter = new OpenAICompatibleAdapter({
        providerId: row.id,
        providerName: row.display_name,
        baseUrl: row.base_url,
        authType: 'api-key',
        isBuiltIn: false,
        credentialId: credential ? `${row.id}-key` : undefined,
        defaultHeaders: credential ? { Authorization: `Bearer ${credential}` } : {},
      });
      adapter.setEnabled(row.is_enabled === 1);
      registry.register(adapter);
    }
  } catch (err) {
    console.warn('[Bootstrap] Failed to load custom providers:', err);
  }
}

export function applyPersistedProviderEnabledFromSettings(
  readSetting: (key: string) => string | null,
  registry: ProviderRegistry = getProviderRegistry()
): void {
  for (const adapter of registry.getAll()) {
    const stored = readSetting(`${ENABLED_KEY_PREFIX}${adapter.providerId}`);
    if (stored === null) continue;
    applyEnabled(adapter, stored !== 'false');
  }
}
