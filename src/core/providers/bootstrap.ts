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
import { resolveOAuthSpec } from './oauth/oauth-manager.js';
import type { OAuthTokenSource } from './openai-compatible/adapter.js';
import {
  deleteProfileSetting,
  readProfileSetting,
  writeProfileSetting,
} from '../settings/profile-store.js';

/**
 * Provider pool configuration is scoped to the active configuration profile, so
 * "which providers are enabled / which base URL / which quota" can differ per project
 * while credentials and UI preferences stay global. For the `default` profile the
 * namespace collapses onto the historical bare keys, which keeps existing databases
 * reading exactly the same rows they always did.
 */
export const settingsBackedStore: PlainKeyStore = {
  get: (key) => readProfileSetting(key),
  set: (key, value) => writeProfileSetting(key, value),
  delete: (key) => deleteProfileSetting(key),
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
  /**
   * Host-provided OAuth token source factory. Whether a provider is OAuth is data (its
   * settings row), but adapters are built by factory code, so the host injects the
   * capability and bootstrap decides which adapters get it.
   */
  tokenSourceFor?: (providerId: string) => OAuthTokenSource;
}

interface TokenSourceCapable {
  setTokenSource?: (source: OAuthTokenSource | undefined) => void;
}

/**
 * Wire OAuth token sources onto every adapter whose provider settings describe an OAuth
 * endpoint. Must run after `applyProviderOverrides`, because that is what loads the
 * per-profile `provider-settings:<id>` rows the decision is based on.
 */
export function attachOAuthTokenSources(
  adapters: ProviderAdapter[],
  secrets: { retrieve(id: string): string | null },
  tokenSourceFor?: (providerId: string) => OAuthTokenSource
): string[] {
  if (!tokenSourceFor) return [];
  const attached: string[] = [];

  for (const adapter of adapters) {
    const capable = adapter as unknown as TokenSourceCapable;
    if (typeof capable.setTokenSource !== 'function') continue;
    const config = adapter.getProviderConfig();
    const spec = resolveOAuthSpec(config.id, config.displayName, config.baseUrl, secrets);
    if (!spec) {
      capable.setTokenSource(undefined);
      continue;
    }
    capable.setTokenSource(tokenSourceFor(config.id));
    attached.push(config.id);
  }

  return attached;
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

  const oauthProviders = attachOAuthTokenSources(registry.getAll(), secrets, options.tokenSourceFor);
  if (oauthProviders.length > 0) {
    console.log(`[Bootstrap] OAuth 服务商: ${oauthProviders.join(', ')}`);
  }

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
  read: (key: string) => string | null = readProfileSetting,
  registry: ProviderRegistry = getProviderRegistry()
): void {
  for (const adapter of registry.getAll()) {
    const stored = read(`${ENABLED_KEY_PREFIX}${adapter.providerId}`);
    if (stored === null) continue;
    applyEnabled(adapter, stored !== 'false');
  }
}
