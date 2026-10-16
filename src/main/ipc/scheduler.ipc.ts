import type { Scheduler } from '../../scheduler/scheduler.js';
import type { IpcMainInvokeEvent } from 'electron';

export function registerSchedulerIpc(scheduler: Scheduler): void {
  const { ipcMain } = require('electron');

  ipcMain.handle('scheduler:status', async () => {
    const registry = require('../../core/providers/index.js').getProviderRegistry();
    const providers = registry.getAll().map((a: { providerId: string; providerName: string; getProviderConfig: () => { isEnabled: boolean } }) => ({
      providerId: a.providerId,
      providerName: a.providerName,
      circuitState: scheduler.getCircuitState(a.providerId),
      isEnabled: a.getProviderConfig().isEnabled,
    }));

    return { providers };
  });

  ipcMain.handle('scheduler:reset-circuit', async (_e: IpcMainInvokeEvent, providerId: string) => {
    scheduler.resetCircuit(providerId);
    return { success: true };
  });

  ipcMain.handle('scheduler:reset-all-circuits', async () => {
    scheduler.getCircuitBreaker().resetAll();
    return { success: true };
  });
}
