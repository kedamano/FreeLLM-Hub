import { getProviderRegistry } from '../../core/providers/index.js';
import { redactSecrets } from '../security/secret-redaction.js';
import { registerIpcHandler } from './handle.js';

export function registerModelsIpc(): void {
  const registry = getProviderRegistry();

  const collectModels = async () => {
    const models: Array<Record<string, unknown>> = [];
    for (const adapter of registry.getAll()) {
      if (!adapter.getProviderConfig().isEnabled) continue;
      try {
        for (const providerModel of await adapter.listModels()) {
          models.push({
            id: providerModel.id,
            providerId: providerModel.providerId,
            displayName: providerModel.displayName,
            capabilities: providerModel.capabilities,
            pricing: providerModel.pricing,
            status: providerModel.status,
          });
        }
      } catch {
        // skip unreachable providers
      }
    }
    return models;
  };

  registerIpcHandler('models:list', async () => collectModels());

  registerIpcHandler('models:get', async (_e, providerId: string, modelId: string) => {
    const adapter = registry.get(providerId);
    if (!adapter) return null;
    return adapter.getModel(modelId);
  });

  registerIpcHandler('models:discover', async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const adapter of registry.getAll()) {
      if (!adapter.getProviderConfig().isEnabled) continue;
      try {
        await adapter.listModels();
        results.push({ providerId: adapter.providerId, success: true });
      } catch (err) {
        results.push({
          providerId: adapter.providerId,
          success: false,
          error: redactSecrets(err instanceof Error ? err.message : 'Unknown error'),
        });
      }
    }
    return results;
  });

  registerIpcHandler('models:refresh', async () => collectModels());
}
