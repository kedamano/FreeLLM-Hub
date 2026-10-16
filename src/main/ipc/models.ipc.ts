import { registerIpcHandler } from './handle.js';
import * as modelService from '../services/model-service.js';

export function registerModelsIpc(): void {
  registerIpcHandler('models:list', async () => modelService.collectModels());
  registerIpcHandler('models:get', async (_e, providerId: string, modelId: string) =>
    modelService.getModel(providerId, modelId)
  );
  registerIpcHandler('models:discover', async () => modelService.discoverAllModels());
  registerIpcHandler('models:refresh', async () => modelService.collectModels());
}
