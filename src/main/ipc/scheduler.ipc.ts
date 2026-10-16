import type { Scheduler } from '../../scheduler/scheduler.js';
import { getProviderRegistry } from '../../core/providers/index.js';
import { registerIpcHandler } from './handle.js';

export function registerSchedulerIpc(scheduler: Scheduler): void {
  const registry = getProviderRegistry();

  registerIpcHandler('scheduler:status', async () => ({
    providers: registry.getAll().map((adapter) => ({
      providerId: adapter.providerId,
      providerName: adapter.providerName,
      circuitState: scheduler.getCircuitState(adapter.providerId),
      isEnabled: adapter.getProviderConfig().isEnabled,
    })),
  }));

  registerIpcHandler('scheduler:reset-circuit', async (_e, providerId: string) => {
    scheduler.resetCircuit(providerId);
    return { success: true };
  });

  registerIpcHandler('scheduler:reset-all-circuits', async () => {
    scheduler.getCircuitBreaker().resetAll();
    return { success: true };
  });
}
