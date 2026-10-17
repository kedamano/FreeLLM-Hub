import type { Scheduler } from '../../scheduler/scheduler.js';
import {
  quotaConfigFor,
  readQuota,
  validateQuotaInput,
  writeQuota,
  applyQuotaConfigsFromSettings,
  type QuotaInput,
} from '../../scheduler/quota-settings.js';
import { createQuotaPersistence } from '../../usage/quota-store.js';
import type {
  AuthType,
  ModelCapabilities,
  ModelPricing,
  ProviderModel,
} from '../../shared/types/index.js';
import { getProviderRegistry } from '../../core/providers/index.js';
import { buildCapabilities } from '../../shared/utils/capabilities.js';
import { applyEnabled, applyCredential, hotSwap, ENABLED_KEY_PREFIX, makeCustomProviderId, settingsBackedStore } from '../../core/providers/bootstrap.js';
import { updateProviderConfig, persistProviderConfig } from '../../core/providers/provider-state.js';
import type { ProviderConfig } from '../../shared/types/index.js';
import {
  OpenAICompatibleAdapter,
  type OAuthTokenSource,
} from '../../core/providers/openai-compatible/adapter.js';
import {
  oauthConfigFields,
  resolveOAuthSpec,
} from '../../core/providers/oauth/oauth-manager.js';
import {
  credentialState as readOAuthCredentialState,
  oauthTokenSourceFor,
  setOAuthClientSecret,
} from './oauth-service.js';
import { getCredentialStore } from '../security/credential-store.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { deleteSetting, writeSetting } from '../../core/settings/settings-store.js';
import { readProfileSetting, writeProfileSetting } from '../../core/settings/profile-store.js';
import { getDatabase } from '../../core/database/database.js';

export const MAX_CREDENTIALS_PER_PROVIDER = 5;

function slotKeyFor(providerId: string, index: number): string {
  return index === 0 ? `${providerId}-key` : `${providerId}-key-${index + 1}`;
}

function listCredentialKeys(providerId: string): string[] {
  const store = getCredentialStore();
  const keys: string[] = [];
  if (store.has(`${providerId}-key`)) keys.push(`${providerId}-key`);
  for (let i = 2; store.has(`${providerId}-key-${i}`); i++) {
    keys.push(`${providerId}-key-${i}`);
  }
  return keys;
}

function maskKey(value: string | null): string {
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function syncAdapterCredentials(providerId: string): void {
  const adapter = getProviderRegistry().get(providerId);
  if (!adapter) return;
  const api = hotSwap(adapter);
  if (typeof api.setCredentials !== 'function') return;
  const store = getCredentialStore();
  const values = listCredentialKeys(providerId)
    .map((key) => store.retrieve(key))
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  api.setCredentials(values);
}

export interface ProviderCredentialSlot {
  index: number;
  keyId: string;
  masked: string;
}

export function listProviderCredentials(providerId: string): { credentials: ProviderCredentialSlot[] } {
  const store = getCredentialStore();
  return {
    credentials: listCredentialKeys(providerId).map((keyId, index) => ({
      index,
      keyId,
      masked: maskKey(store.retrieve(keyId)),
    })),
  };
}

export function addProviderCredential(
  providerId: string,
  credential: string
): { success: boolean; error?: string; credentials?: ProviderCredentialSlot[] } {
  if (!credential || typeof credential !== 'string' || !credential.trim()) {
    return { success: false, error: 'Key 不能为空' };
  }
  const keys = listCredentialKeys(providerId);
  if (keys.length >= MAX_CREDENTIALS_PER_PROVIDER) {
    return { success: false, error: `每个供应商最多保存 ${MAX_CREDENTIALS_PER_PROVIDER} 个 Key` };
  }
  try {
    getCredentialStore().store(slotKeyFor(providerId, keys.length), credential.trim());
    syncAdapterCredentials(providerId);
    return { success: true, credentials: listProviderCredentials(providerId).credentials };
  } catch (err) {
    return { success: false, error: redactSecrets(err instanceof Error ? err.message : '存储失败') };
  }
}

export function removeProviderCredentialSlot(
  providerId: string,
  index: number
): { success: boolean; error?: string; credentials?: ProviderCredentialSlot[] } {
  const store = getCredentialStore();
  const keys = listCredentialKeys(providerId);
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
    return { success: false, error: 'Key 不存在' };
  }
  const values = keys.map((k) => store.retrieve(k)).filter((v): v is string => !!v);
  values.splice(index, 1);
  for (const k of keys) store.delete(k);
  values.forEach((v, i) => store.store(slotKeyFor(providerId, i), v));
  syncAdapterCredentials(providerId);
  return { success: true, credentials: listProviderCredentials(providerId).credentials };
}

export function listProviders(scheduler: Scheduler) {
  const registry = getProviderRegistry();
  return registry.getAll().map((adapter) => {
    const config = adapter.getProviderConfig();
    scheduler.registerProviderConfig(config);
    return {
      id: config.id,
      displayName: config.displayName,
      authType: config.authType,
      baseUrl: config.baseUrl,
      isEnabled: config.isEnabled,
      isBuiltIn: config.isBuiltIn,
      credentialStatus: config.credentialStatus,
      configFields: config.configFields ?? [],
      settings: config.settings ?? {},
      baseUrlDerived:
        typeof (adapter as unknown as { resolveBaseUrl?: unknown }).resolveBaseUrl === 'function',
      metadata: config.metadata,
      hasCredential: listCredentialKeys(config.id).length > 0,
      quota: readQuota(config.id),
      quotaRemaining: scheduler.getQuotaManager().getRemainingQuota(config.id),
      // Non-secret OAuth snapshot: expiry, scope, refresh availability.
      oauth: readOAuthCredentialState(config.id),
    };
  });
}

export function setProviderQuota(
  scheduler: Scheduler,
  providerId: string,
  input: unknown
): { success: boolean; error?: string; quota?: QuotaInput } {
  if (!getProviderRegistry().get(providerId)) {
    return { success: false, error: 'Provider not found' };
  }
  const raw = (input ?? {}) as Record<string, unknown>;
  const quota: QuotaInput = {
    maxRequestsPerDay: raw.maxRequestsPerDay === undefined || raw.maxRequestsPerDay === null || raw.maxRequestsPerDay === ''
      ? undefined
      : Number(raw.maxRequestsPerDay),
    maxTokensPerDay: raw.maxTokensPerDay === undefined || raw.maxTokensPerDay === null || raw.maxTokensPerDay === ''
      ? undefined
      : Number(raw.maxTokensPerDay),
  };

  const invalid = validateQuotaInput(quota);
  if (invalid) return { success: false, error: invalid };

  writeQuota(providerId, quota);
  // Re-read so a cleared quota removes the scheduler config as well.
  const effective = readQuota(providerId);
  if (effective) {
    scheduler.setQuotaConfig(quotaConfigFor(providerId, effective));
  } else {
    scheduler.getQuotaManager().clearConfig(providerId);
  }
  return { success: true, quota: effective };
}

/** Load persisted daily quotas for every registered provider into the scheduler. */
export function hydrateQuotasFromSettings(scheduler: Scheduler): string[] {
  const applied = applyQuotaConfigsFromSettings(
    scheduler,
    getProviderRegistry().getAll().map((adapter) => adapter.providerId)
  );

  const quotaManager = scheduler.getQuotaManager();
  quotaManager.setPersistence(createQuotaPersistence());
  const restored = quotaManager.hydrate();
  if (restored > 0) {
    console.log(`[Quota] 已恢复 ${restored} 条当日用量记录，配额不会因重启清零`);
  }

  return applied;
}

export function getProvider(providerId: string) {
  const registry = getProviderRegistry();
  const adapter = registry.get(providerId);
  if (!adapter) return null;
  const config = adapter.getProviderConfig();
  return { ...config, hasCredential: listCredentialKeys(config.id).length > 0 };
}

export async function testProvider(providerId: string): Promise<{ success: boolean; error?: string }> {
  const registry = getProviderRegistry();
  const adapter = registry.get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found' };

  try {
    const result = await adapter.validateCredential();
    return { success: result.valid, error: result.reason };
  } catch (err) {
    return { success: false, error: redactSecrets(err instanceof Error ? err.message : 'Unknown error') };
  }
}

export function setProviderCredential(
  providerId: string,
  credential: string
): { success: boolean; error?: string } {
  if (!credential || typeof credential !== 'string') {
    return { success: false, error: 'Invalid credential' };
  }
  try {
    const credentialStore = getCredentialStore();
    credentialStore.store(slotKeyFor(providerId, 0), credential);
    syncAdapterCredentials(providerId);
    return { success: true };
  } catch (err) {
    return { success: false, error: redactSecrets(err instanceof Error ? err.message : 'Storage failed') };
  }
}

/**
 * The only credential shape allowed on the general API surface: enough to recognise
 * a key in the UI, never enough to use it. Plaintext leaves through
 * `getProviderCredential`, which the HTTP layer exposes as an explicit reveal call.
 */
export function getProviderCredentialMasked(
  providerId: string,
  index = 0
): { masked: string; hasCredential: boolean } {
  try {
    const value = getCredentialStore().retrieve(slotKeyFor(providerId, index));
    return { masked: maskKey(value), hasCredential: !!value };
  } catch {
    return { masked: '', hasCredential: false };
  }
}

export function getProviderCredential(
  providerId: string,
  index = 0
): { credential: string | null } {
  try {
    return { credential: getCredentialStore().retrieve(slotKeyFor(providerId, index)) ?? null };
  } catch {
    return { credential: null };
  }
}

export function removeProviderCredential(providerId: string): { success: boolean } {
  try {
    const credentialStore = getCredentialStore();
    const keys = listCredentialKeys(providerId);
    let result = false;
    for (const key of keys) result = credentialStore.delete(key) || result;
    const adapter = getProviderRegistry().get(providerId);
    if (adapter) applyCredential(adapter, undefined, undefined);
    return { success: result };
  } catch {
    return { success: false };
  }
}

export function toggleProvider(scheduler: Scheduler, providerId: string, enabled: boolean) {
  const adapter = getProviderRegistry().get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found' };
  applyEnabled(adapter, !!enabled);
  writeSetting(`${ENABLED_KEY_PREFIX}${providerId}`, enabled ? 'true' : 'false');
  scheduler.registerProviderConfig(adapter.getProviderConfig());
  return { success: true, providerId, isEnabled: adapter.getProviderConfig().isEnabled };
}

export function updateProviderBaseUrl(
  providerId: string,
  baseUrl: string
): { success: boolean; error?: string } {
  const adapter = getProviderRegistry().get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found' };
  const result = updateProviderConfig(adapter, { baseUrl });
  if (!result.ok) return { success: false, error: result.error };
  persistProviderConfig(settingsBackedStore, providerId, result);
  if (!adapter.getProviderConfig().isBuiltIn) {
    try {
      getDatabase()
        .prepare("UPDATE providers SET base_url = ?, updated_at = datetime('now') WHERE id = ?")
        .run(baseUrl, providerId);
    } catch (err) {
      console.warn(`[providers] failed to persist base URL for ${providerId}:`, err);
    }
  }
  return { success: true };
}

export function saveProviderConfig(
  providerId: string,
  input: { baseUrl?: unknown; settings?: unknown }
): { success: boolean; error?: string; config?: ProviderConfig } {
  const adapter = getProviderRegistry().get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found' };
  const result = updateProviderConfig(adapter, input);
  if (!result.ok) return { success: false, error: result.error };
  persistProviderConfig(settingsBackedStore, providerId, result);
  return { success: true, config: adapter.getProviderConfig() };
}

export function createCustomProvider(input: {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  authType?: unknown;
  oauth?: unknown;
}): { success: boolean; providerId?: string; error?: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim().replace(/\/$/, '') : '';
  const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const authType: AuthType = input.authType === 'oauth' ? 'oauth' : 'api-key';
  const oauth = normaliseOAuthInput(input.oauth);

  if (!name || name.length > 60) return { success: false, error: '名称无效（1-60 个字符）' };
  if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) return { success: false, error: 'Base URL 必须以 http(s):// 开头' };
  if (authType === 'oauth') {
    const invalid = validateOAuthInput(oauth);
    if (invalid) return { success: false, error: invalid };
  }

  const registry = getProviderRegistry();
  const db = getDatabase();
  const taken = new Set<string>([
    ...registry.getAll().map((a) => a.providerId),
    ...(db.prepare('SELECT id FROM providers').all() as Array<{ id: string }>).map((r) => r.id),
  ]);
  const providerId = makeCustomProviderId(name, taken);

  const adapter = new OpenAICompatibleAdapter({
    providerId,
    providerName: name,
    baseUrl,
    authType,
    isBuiltIn: false,
    credentialId: authType === 'oauth' ? `${providerId}-oauth` : apiKey ? `${providerId}-key` : undefined,
    defaultHeaders: authType === 'oauth' || !apiKey ? {} : { Authorization: `Bearer ${apiKey}` },
    configFields: authType === 'oauth' ? oauthConfigFields() : [],
    // OAuth providers are only usable once the browser flow has produced a token.
    ...(authType === 'oauth' ? { tokenSource: oauthTokenSourceFor(providerId) } : {}),
  });
  registry.register(adapter);

  db.prepare(`
    INSERT INTO providers (id, display_name, auth_type, base_url, is_enabled, is_built_in, credential_status)
    VALUES (?, ?, ?, ?, 1, 0, 'unconfigured')
  `).run(providerId, name, authType, baseUrl);
  writeProfileSetting(`${ENABLED_KEY_PREFIX}${providerId}`, 'true');

  if (authType === 'oauth' && oauth) {
    writeProfileSetting(
      `provider-settings:${providerId}`,
      JSON.stringify({
        oauth: true,
        authorizationUrl: oauth.authorizationUrl,
        tokenUrl: oauth.tokenUrl,
        clientId: oauth.clientId,
        scopes: oauth.scopes,
        usePkce: oauth.usePkce,
        baseUrl,
      })
    );
    if (oauth.clientSecret) setOAuthClientSecret(providerId, oauth.clientSecret);
  }

  if (authType === 'api-key' && apiKey) {
    try {
      getCredentialStore().store(`${providerId}-key`, apiKey);
    } catch (err) {
      registry.unregister(providerId);
      db.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
      return { success: false, error: redactSecrets(err instanceof Error ? err.message : '凭证存储失败') };
    }
  }
  return { success: true, providerId };
}

export interface OAuthInput {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  usePkce: boolean;
}

function normaliseOAuthInput(input: unknown): OAuthInput | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  return {
    authorizationUrl: text(raw.authorizationUrl),
    tokenUrl: text(raw.tokenUrl),
    clientId: text(raw.clientId),
    clientSecret: text(raw.clientSecret) || undefined,
    scopes: text(raw.scopes),
    usePkce: raw.usePkce !== false,
  };
}

function validateOAuthInput(oauth: OAuthInput | null): string | null {
  if (!oauth) return '请填写 OAuth 配置';
  const isUrl = (value: string) => /^https:\/\/[^\s]+$/i.test(value);
  if (!isUrl(oauth.authorizationUrl)) return '授权端点必须是 https:// 地址';
  if (!isUrl(oauth.tokenUrl)) return '令牌端点必须是 https:// 地址';
  if (!oauth.clientId) return 'Client ID 不能为空';
  if (oauth.scopes.length > 300) return 'Scopes 过长';
  return null;
}

/**
 * Update a provider's OAuth endpoints / client id. The client secret goes to the
 * encrypted store, everything else is plain provider settings, and the live adapter is
 * re-attached so the change takes effect without a restart.
 */
export function configureOAuth(
  scheduler: Scheduler,
  providerId: string,
  input: unknown
): { success: boolean; error?: string; config?: unknown } {
  const registry = getProviderRegistry();
  const adapter = registry.get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found' };
  const oauth = normaliseOAuthInput(input);
  const invalid = validateOAuthInput(oauth);
  if (invalid || !oauth) return { success: false, error: invalid ?? '请填写 OAuth 配置' };

  const existing = readProfileSetting(`provider-settings:${providerId}`);
  let merged: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        merged = parsed as Record<string, unknown>;
      }
    } catch {
      /* corrupted settings row: start fresh */
    }
  }

  writeProfileSetting(
    `provider-settings:${providerId}`,
    JSON.stringify({
      ...merged,
      oauth: true,
      authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl,
      clientId: oauth.clientId,
      scopes: oauth.scopes,
      usePkce: oauth.usePkce,
    })
  );
  setOAuthClientSecret(providerId, oauth.clientSecret ?? '');

  reattachOAuthTokenSource(adapter);
  scheduler.registerProviderConfig(adapter.getProviderConfig());
  getDatabase()
    .prepare("UPDATE providers SET auth_type = 'oauth', updated_at = datetime('now') WHERE id = ?")
    .run(providerId);

  return { success: true, config: adapter.getProviderConfig() };
}

/** Re-run the OAuth attachment decision for one adapter after its settings changed. */
function reattachOAuthTokenSource(adapter: {
  providerId: string;
  getProviderConfig(): ProviderConfig;
  setTokenSource?: (source: OAuthTokenSource | undefined) => void;
}): void {
  const config = adapter.getProviderConfig();
  const spec = resolveOAuthSpec(
    config.id,
    config.displayName,
    config.baseUrl,
    { retrieve: (id) => getCredentialStore().retrieve(id) }
  );
  if (spec && typeof adapter.setTokenSource === 'function') {
    adapter.setTokenSource(oauthTokenSourceFor(config.id));
  }
}

export function deleteCustomProvider(scheduler: Scheduler, providerId: string): { success: boolean; error?: string } {
  const registry = getProviderRegistry();
  const adapter = registry.get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found' };
  if (adapter.getProviderConfig().isBuiltIn) return { success: false, error: '内置供应商不可删除' };

  registry.unregister(providerId);
  try {
    const store = getCredentialStore();
    for (const key of listCredentialKeys(providerId)) store.delete(key);
  } catch {
    // credential store may be unavailable; provider row removal still proceeds
  }
  deleteSetting(`${ENABLED_KEY_PREFIX}${providerId}`);
  const db = getDatabase();
  db.prepare('DELETE FROM providers WHERE id = ?').run(providerId);
  db.prepare('DELETE FROM models WHERE provider_id = ?').run(providerId);
  scheduler.forgetProvider(providerId);
  return { success: true };
}

export async function discoverProviderModels(providerId: string): Promise<{
  success: boolean;
  providerId?: string;
  models?: unknown[];
  error?: string;
}> {
  const adapter = getProviderRegistry().get(providerId);
  if (!adapter) return { success: false, error: 'Provider not found', models: [] };
  try {
    const models = await adapter.listModels();
    if (models.length === 0) {
      // Adapters swallow transport errors and return an empty catalogue, so "no models"
      // would otherwise be indistinguishable from "could not reach the service".
      const probe = await adapter.validateCredential().catch((err) => ({
        valid: false,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (!probe.valid) {
        return {
          success: false,
          providerId,
          error: redactSecrets(probe.reason || '无法连接到服务商'),
          models: [],
        };
      }
    }
    try {
      persistDiscoveredModels(providerId, models);
    } catch (err) {
      console.warn(`[providers] failed to persist discovered models for ${providerId}:`, err);
    }
    return { success: true, providerId, models };
  } catch (err) {
    return {
      success: false,
      providerId,
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
      models: [],
    };
  }
}

function persistDiscoveredModels(providerId: string, models: ProviderModel[]): void {
  const registryEntry = getProviderRegistry().get(providerId);
  if (!registryEntry) return;
  const config = registryEntry.getProviderConfig();
  const db = getDatabase();

  const upsertProvider = db.prepare(`
    INSERT INTO providers (id, display_name, auth_type, base_url, is_enabled, is_built_in, credential_status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      display_name = excluded.display_name,
      base_url = excluded.base_url,
      is_enabled = excluded.is_enabled,
      credential_status = excluded.credential_status,
      updated_at = datetime('now')
  `);
  const upsertModel = db.prepare(`
    INSERT INTO models (id, provider_id, display_name, description, capabilities, pricing, rate_limits, status, discovered_at, last_checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id, provider_id) DO UPDATE SET
      display_name = excluded.display_name,
      description = excluded.description,
      capabilities = excluded.capabilities,
      pricing = excluded.pricing,
      rate_limits = excluded.rate_limits,
      status = excluded.status,
      last_checked_at = excluded.last_checked_at
  `);

  const tx = db.transaction(() => {
    upsertProvider.run(
      config.id,
      config.displayName,
      config.authType,
      config.baseUrl ?? '',
      config.isEnabled ? 1 : 0,
      config.isBuiltIn ? 1 : 0,
      config.credentialStatus
    );
    for (const model of models) {
      upsertModel.run(
        model.id,
        providerId,
        model.displayName,
        model.description ?? null,
        JSON.stringify(model.capabilities ?? {}),
        JSON.stringify(model.pricing ?? { type: 'unknown', currency: 'USD' }),
        model.rateLimits ? JSON.stringify(model.rateLimits) : null,
        model.status ?? 'available'
      );
    }
  });
  tx();
}

const EMPTY_CAPABILITIES = buildCapabilities([], 0);

export function getPersistedProviderModels(providerId: string): ProviderModel[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM models WHERE provider_id = ? ORDER BY display_name COLLATE NOCASE')
    .all(providerId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    providerId: String(row.provider_id),
    displayName: String(row.display_name),
    description: row.description ? String(row.description) : undefined,
    capabilities: parseJson<ModelCapabilities>(row.capabilities, EMPTY_CAPABILITIES),
    pricing: parseJson<ModelPricing>(row.pricing, { type: 'unknown', currency: 'USD' }),
    rateLimits: row.rate_limits ? parseJson<ProviderModel['rateLimits']>(row.rate_limits, undefined) : undefined,
    status: (row.status as ProviderModel['status']) ?? 'unknown',
    discoveredAt: String(row.discovered_at ?? ''),
    lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : undefined,
  }));
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
