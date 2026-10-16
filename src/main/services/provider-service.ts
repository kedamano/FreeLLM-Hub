import type { Scheduler } from '../../scheduler/scheduler.js';
import { getProviderRegistry } from '../../core/providers/index.js';
import { applyEnabled, applyCredential, hotSwap, ENABLED_KEY_PREFIX } from '../../core/providers/bootstrap.js';
import { getCredentialStore } from '../security/credential-store.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { writeSetting } from '../../core/settings/settings-store.js';

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
