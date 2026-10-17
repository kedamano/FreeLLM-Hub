import { getProviderRegistry } from './registry.js';
import { getDatabase } from '../database/database.js';
import { loggerFor } from '../log/logger.js';
import { createOllamaAdapter } from './local/ollama-adapter.js';
import { createStaticAdapter } from './openai-compatible/static-adapter.js';
import { BUILTIN_PROVIDER_SEEDS } from './catalog.js';
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

const log = loggerFor('bootstrap');

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

interface BuiltInEntry {
  providerId: string;
  create: BuiltInFactory;
}

/**
 * Registration is generated from the catalog: adding a provider means adding a seed, not
 * writing another adapter file and factory entry. Ollama is the only built-in that stays
 * hand-written — it speaks its own API and reads its model list off the local server — so it
 * is simply the first entry of the same list. Order here is the order the UI shows.
 */
const BUILT_IN_ENTRIES: BuiltInEntry[] = [
  { providerId: 'ollama', create: () => createOllamaAdapter() },
  ...BUILTIN_PROVIDER_SEEDS.map<BuiltInEntry>((seed) => ({
    providerId: seed.id,
    create: (credential) => createStaticAdapter(seed, credential),
  })),
];

export const BUILT_IN_PROVIDER_IDS: string[] = BUILT_IN_ENTRIES.map((entry) => entry.providerId);

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

  for (const { providerId, create } of BUILT_IN_ENTRIES) {
    let credential: string | undefined;
    try {
      credential = resolveProviderCredential(secrets, providerId).credential ?? undefined;
    } catch (err) {
      log.warn({ err, providerId }, '凭证读取失败');
    }
    const adapter = create(credential);
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
  const migrated = migrateLegacyProviderFields(secrets, settings, BUILT_IN_PROVIDER_IDS);
  if (migrated.length > 0) {
    log.info({ keys: migrated }, '已迁移旧版配置字段');
  }

  const { errors } = applyProviderOverrides(adapters, settings);
  for (const error of errors) log.warn({ error }, 'provider 覆盖项未能应用');

  const oauthProviders = attachOAuthTokenSources(registry.getAll(), secrets, options.tokenSourceFor);
  if (oauthProviders.length > 0) {
    log.info({ providers: oauthProviders }, 'OAuth 服务商');
  }

  log.info({ count: registry.getAll().length }, 'providers registered');
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
      // Same template as the built-ins: a user pool is just a provider whose catalog is empty
      // until the first discovery, so only `isBuiltIn` and the editable base URL differ.
      const adapter = createStaticAdapter(
        {
          id: row.id,
          name: row.display_name,
          baseUrl: row.base_url,
          currency: 'USD',
          caps: [],
          price: 'unknown',
          models: [],
        },
        credential ?? undefined,
        { isBuiltIn: false }
      );
      adapter.setEnabled(row.is_enabled === 1);
      registry.register(adapter);
    }
  } catch (err) {
    log.warn({ err }, 'failed to load custom providers');
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
