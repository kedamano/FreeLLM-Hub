import type { Scheduler } from '../../scheduler/scheduler.js';
import { getProviderRegistry, type ProviderAdapter } from '../../core/providers/index.js';
import { getCredentialStore } from '../security/credential-store.js';
import type { IpcMainInvokeEvent } from 'electron';

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

  ipcMain.handle('providers:get', async (_e: IpcMainInvokeEvent, providerId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return null;
    const config = adapter.getProviderConfig();
    return {
      ...config,
      hasCredential: credentialStore.has(`${config.id}-key`),
    };
  });

  ipcMain.handle('providers:test', async (_e: IpcMainInvokeEvent, providerId: string) => {
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
    async (_e: IpcMainInvokeEvent, providerId: string, credential: string) => {
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

  ipcMain.handle('providers:remove-credential', async (_e: IpcMainInvokeEvent, providerId: string) => {
    try {
      const result = credentialStore.delete(`${providerId}-key`);
      return { success: result };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('providers:toggle', async (_e: IpcMainInvokeEvent, providerId: string, enabled: boolean) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };
    adapter.getProviderConfig().isEnabled = enabled;
    return { success: true };
  });

  ipcMain.handle('providers:update-baseurl', async (_e: IpcMainInvokeEvent, providerId: string, baseUrl: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found' };
    try {
      const { OpenAICompatibleAdapter } = require('../../core/providers/openai-compatible/adapter.js');
      if (adapter instanceof OpenAICompatibleAdapter && typeof (adapter as any).updateBaseUrl === 'function') {
        (adapter as any).updateBaseUrl(baseUrl);
      }
    } catch {
      // ignore
    }
    return { success: true };
  });

  ipcMain.handle('providers:discover-models', async (_e: IpcMainInvokeEvent, providerId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return { success: false, error: 'Provider not found', models: [] };
    try {
      const models = await adapter.listModels();
      return { success: true, providerId, models };
    } catch (err) {
      return { success: false, providerId, error: err instanceof Error ? err.message : String(err), models: [] };
    }
  });
}
