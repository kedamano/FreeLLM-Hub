import type { Scheduler } from '../../scheduler/scheduler.js';
import { getProviderRegistry, type ProviderAdapter } from '../../core/providers/index.js';
import { getCredentialStore } from '../security/credential-store.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { registerIpcHandler } from './handle.js';
import { readSetting, writeSetting } from './settings.ipc.js';

const ENABLED_KEY_PREFIX = 'provider-enabled:';

interface HotSwapAdapter {
  setEnabled?(enabled: boolean): void;
  setCredential?(credential: string | undefined, credentialId?: string): void;
  updateBaseUrl?(baseUrl: string): void;
}

function hotSwap(adapter: ProviderAdapter): HotSwapAdapter {
  return adapter as unknown as HotSwapAdapter;
}

function applyEnabled(adapter: ProviderAdapter, enabled: boolean): void {
  const api = hotSwap(adapter);
  if (typeof api.setEnabled === 'function') {
    api.setEnabled(enabled);
    return;
  }
  adapter.getProviderConfig().isEnabled = enabled;
}

function applyCredential(adapter: ProviderAdapter, credential: string | undefined, credentialId?: string): void {
  const api = hotSwap(adapter);
  if (typeof api.setCredential === 'function') api.setCredential(credential, credentialId);
}

export function applyPersistedProviderEnabled(): void {
  const registry = getProviderRegistry();
  for (const adapter of registry.getAll()) {
    const stored = readSetting(`${ENABLED_KEY_PREFIX}${adapter.providerId}`);
    if (stored === null) continue;
    applyEnabled(adapter, stored !== 'false');
  }
}

export function registerProvidersIpc(scheduler: Scheduler): void {
  const registry = getProviderRegistry();
  const credentialStore = getCredentialStore();

  registerIpcHandler('providers:list', async () =>
    registry.getAll().map((adapter) => {
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
    })
  );

  registerIpcHandler('providers:get', async (_e, providerId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return null;
    const config = adapter.getProviderConfig();
    return { ...config, hasCredential: credentialStore.has(`${config.id}-key`) };
  });

  registerIpcHandler('providers:test', async (_e, providerId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };

    try {
      const result = await adapter.validateCredential();
      return { success: result.valid, error: result.reason };
    } catch (err) {
      return { success: false, error: redactSecrets(err instanceof Error ? err.message : 'Unknown error') };
    }
  });

  registerIpcHandler(
    'providers:set-credential',
    async (_e, providerId: string, credential: string) => {
      if (!credential || typeof credential !== 'string') {
        return { success: false, error: 'Invalid credential' };
      }
      try {
        const credentialId = `${providerId}-key`;
        credentialStore.store(credentialId, credential);
        const adapter = registry.get(providerId);
        if (adapter) applyCredential(adapter, credential, credentialId);
        return { success: true };
      } catch (err) {
        return { success: false, error: redactSecrets(err instanceof Error ? err.message : 'Storage failed') };
      }
    }
  );

  registerIpcHandler('providers:remove-credential', async (_e, providerId: string) => {
    try {
      const result = credentialStore.delete(`${providerId}-key`);
      const adapter = registry.get(providerId);
      if (adapter) applyCredential(adapter, undefined, undefined);
      return { success: result };
    } catch {
      return { success: false };
    }
  });

  registerIpcHandler('providers:toggle', async (_e, providerId: string, enabled: boolean) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };
    applyEnabled(adapter, !!enabled);
    writeSetting(`${ENABLED_KEY_PREFIX}${providerId}`, enabled ? 'true' : 'false');
    scheduler.registerProviderConfig(adapter.getProviderConfig());
    return { success: true, providerId, isEnabled: adapter.getProviderConfig().isEnabled };
  });

  registerIpcHandler('providers:update-baseurl', async (_e, providerId: string, baseUrl: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };
    if (typeof baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
      return { success: false, error: 'Invalid base URL' };
    }
    const api = hotSwap(adapter);
    if (typeof api.updateBaseUrl === 'function') api.updateBaseUrl(baseUrl);
    return { success: true };
  });

  registerIpcHandler('providers:discover-models', async (_e, providerId: string) => {
    const adapter = registry.get(providerId);
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
  });
}
