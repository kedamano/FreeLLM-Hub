import type { Scheduler } from '../../scheduler/scheduler.js';
import type { ModelCapabilities, ModelPricing, ProviderModel } from '../../shared/types/index.js';
import { getProviderRegistry } from '../../core/providers/index.js';
import { applyEnabled, applyCredential, hotSwap, ENABLED_KEY_PREFIX } from '../../core/providers/bootstrap.js';
import { getCredentialStore } from '../security/credential-store.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { writeSetting } from '../../core/settings/settings-store.js';
import { getDatabase } from '../../core/database/database.js';

export function listProviders(scheduler: Scheduler) {
  const registry = getProviderRegistry();
  const credentialStore = getCredentialStore();
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
      metadata: config.metadata,
      hasCredential: credentialStore.has(`${config.id}-key`),
    };
  });
}

export function getProvider(providerId: string) {
  const registry = getProviderRegistry();
  const credentialStore = getCredentialStore();
  const adapter = registry.get(providerId);
  if (!adapter) return null;
  const config = adapter.getProviderConfig();
  return { ...config, hasCredential: credentialStore.has(`${config.id}-key`) };
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
    const credentialId = `${providerId}-key`;
    credentialStore.store(credentialId, credential);
    const adapter = getProviderRegistry().get(providerId);
    if (adapter) applyCredential(adapter, credential, credentialId);
    return { success: true };
  } catch (err) {
    return { success: false, error: redactSecrets(err instanceof Error ? err.message : 'Storage failed') };
  }
}

export function getProviderCredential(providerId: string): { credential: string | null } {
  try {
    return { credential: getCredentialStore().retrieve(`${providerId}-key`) ?? null };
  } catch {
    return { credential: null };
  }
}

export function removeProviderCredential(providerId: string): { success: boolean } {
  try {
    const credentialStore = getCredentialStore();
    const result = credentialStore.delete(`${providerId}-key`);
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
  if (typeof baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    return { success: false, error: 'Invalid base URL' };
  }
  const api = hotSwap(adapter);
  if (typeof api.updateBaseUrl === 'function') api.updateBaseUrl(baseUrl);
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

const EMPTY_CAPABILITIES: ModelCapabilities = {
  supported: [],
  contextWindow: 0,
  supportsStreaming: false,
  supportsVision: false,
  supportsFunctionCalling: false,
  supportsJsonMode: false,
};

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
