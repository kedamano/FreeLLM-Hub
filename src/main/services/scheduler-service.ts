import type { Scheduler } from '../../scheduler/scheduler.js';
import { getProviderRegistry } from '../../core/providers/index.js';

export function schedulerStatus(scheduler: Scheduler) {
  const registry = getProviderRegistry();
  return {
    providers: registry.getAll().map((adapter) => ({
      providerId: adapter.providerId,
      providerName: adapter.providerName,
      circuitState: scheduler.getCircuitState(adapter.providerId),
      isEnabled: adapter.getProviderConfig().isEnabled,
    })),
  };
}

export function resetCircuit(scheduler: Scheduler, providerId: string): { success: boolean } {
  scheduler.resetCircuit(providerId);
  return { success: true };
}

export function resetAllCircuits(scheduler: Scheduler): { success: boolean } {
  scheduler.getCircuitBreaker().resetAll();
  return { success: true };
}
