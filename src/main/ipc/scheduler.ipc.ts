import type { Scheduler } from '../../scheduler/scheduler.js';
import { registerIpcHandler } from './handle.js';
import * as schedulerService from '../services/scheduler-service.js';

export function registerSchedulerIpc(scheduler: Scheduler): void {
  registerIpcHandler('scheduler:status', async () => schedulerService.schedulerStatus(scheduler));
  registerIpcHandler('scheduler:reset-circuit', async (_e, providerId: string) =>
    schedulerService.resetCircuit(scheduler, providerId)
  );
  registerIpcHandler('scheduler:reset-all-circuits', async () => schedulerService.resetAllCircuits(scheduler));
}
