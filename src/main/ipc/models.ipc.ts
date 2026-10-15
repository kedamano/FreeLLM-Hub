import { getProviderRegistry } from '../../core/providers/index.js';

export function registerModelsIpc(): void {
  const { ipcMain } = require('electron');
  const registry = getProviderRegistry();

  ipcMain.handle('models:list', async () => {
    const models: Array<Record<string, unknown>> = [];
    for (const adapter of registry.getAll()) {
      if (!adapter.getProviderConfig().isEnabled) continue;
      try {
        const providerModels = await adapter.listModels();
        for (const m of providerModels) {
          models.push({
            id: m.id,
            providerId: m.providerId,
            displayName: m.displayName,
            capabilities: m.capabilities,
            pricing: m.pricing,
            status: m.status,
          });
        }
      } catch {
        // Skip unreachable providers
      }
    }
    return models;
  });

  ipcMain.handle('models:get', async (_event, providerId: string, modelId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return null;
    return adapter.getModel(modelId);
  });

  ipcMain.handle('models:discover', async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const adapter of registry.getAll()) {
      if (!adapter.getProviderConfig().isEnabled) continue;
      try {
        const models = await adapter.listModels();
        results.push({
          providerId: adapter.providerId,
          providerName: adapter.providerName,
          modelsFound: models.length,
          error: null,
        });
      } catch (err) {
        results.push({
          providerId: adapter.providerId,
          providerName: adapter.providerName,
          modelsFound: 0,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
    return results;
  });

  ipcMain.handle('models:refresh', async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const adapter of registry.getAll()) {
      try {
        const models = await adapter.listModels();
        results.push({
          providerId: adapter.providerId,
          modelsRefreshed: models.length,
          success: true,
        });
      } catch (err) {
        results.push({
          providerId: adapter.providerId,
          modelsRefreshed: 0,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown',
        });
      }
    }
    return results;
  });
}
