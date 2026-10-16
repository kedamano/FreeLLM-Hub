import type { Scheduler } from '../../scheduler/scheduler.js';
import { registerIpcHandler } from './handle.js';
import { readSetting } from './settings.ipc.js';
import { applyPersistedProviderEnabledFromSettings } from '../../core/providers/bootstrap.js';
import * as providerService from '../services/provider-service.js';

export function applyPersistedProviderEnabled(): void {
  applyPersistedProviderEnabledFromSettings(readSetting);
}

export function registerProvidersIpc(scheduler: Scheduler): void {
  registerIpcHandler('providers:list', async () => providerService.listProviders(scheduler));
  registerIpcHandler('providers:get', async (_e, providerId: string) => providerService.getProvider(providerId));
  registerIpcHandler('providers:test', async (_e, providerId: string) => providerService.testProvider(providerId));
  registerIpcHandler('providers:set-credential', async (_e, providerId: string, credential: string) =>
    providerService.setProviderCredential(providerId, credential)
  );
  registerIpcHandler('providers:get-credential', async (_e, providerId: string) =>
    providerService.getProviderCredential(providerId)
  );
  registerIpcHandler('providers:remove-credential', async (_e, providerId: string) =>
    providerService.removeProviderCredential(providerId)
  );
  registerIpcHandler('providers:toggle', async (_e, providerId: string, enabled: boolean) =>
    providerService.toggleProvider(scheduler, providerId, enabled)
  );
  registerIpcHandler('providers:update-baseurl', async (_e, providerId: string, baseUrl: string) =>
    providerService.updateProviderBaseUrl(providerId, baseUrl)
  );
  registerIpcHandler('providers:discover-models', async (_e, providerId: string) =>
    providerService.discoverProviderModels(providerId)
  );
  registerIpcHandler('providers:get-models', async (_e, providerId: string) =>
    providerService.getPersistedProviderModels(providerId)
  );
  registerIpcHandler('providers:create-custom', async (_e, input) =>
    providerService.createCustomProvider(input)
  );
  registerIpcHandler('providers:delete-custom', async (_e, providerId: string) =>
    providerService.deleteCustomProvider(scheduler, providerId)
  );
}
