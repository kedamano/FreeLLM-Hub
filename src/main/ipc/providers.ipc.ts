import type { Scheduler } from '../../scheduler/scheduler.js';
import { getProviderRegistry, type ProviderAdapter } from '../../core/providers/index.js';
import { getCredentialStore } from '../security/credential-store.js';

export function registerProvidersIpc(scheduler: Scheduler): void {
  const { ipcMain } = require('electron');
  const registry = getProviderRegistry();
  const credentialStore = getCredentialStore();

  ipcMain.handle('providers:list', async () => {
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
  });

  ipcMain.handle('providers:get', async (_event, providerId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return null;
    const config = adapter.getProviderConfig();
    return {
      ...config,
      hasCredential: credentialStore.has(`${config.id}-key`),
    };
  });

  ipcMain.handle('providers:test', async (_event, providerId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };

    try {
      const result = await adapter.validateCredential();
      return { success: result.valid, error: result.reason };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  });

  ipcMain.handle(
    'providers:set-credential',
    async (_event, providerId: string, credential: string) => {
      if (!credential || typeof credential !== 'string') {
        return { success: false, error: 'Invalid credential' };
      }
      try {
        credentialStore.store(`${providerId}-key`, credential);
        return { success: true };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Storage failed' };
      }
    }
  );

  ipcMain.handle('providers:remove-credential', async (_event, providerId: string) => {
    try {
      const result = credentialStore.delete(`${providerId}-key`);
      return { success: result };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('providers:toggle', async (_event, providerId: string, enabled: boolean) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };
    adapter.getProviderConfig().isEnabled = enabled;
    return { success: true };
  });
}
