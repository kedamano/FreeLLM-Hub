import type { Scheduler } from '../../scheduler/scheduler.js';
import type { WindowManager } from '../window-manager.js';
import type { GatewayServer } from '../gateway/server.js';
import { registerProvidersIpc } from './providers.ipc.js';
import { registerModelsIpc } from './models.ipc.js';
import { registerSchedulerIpc } from './scheduler.ipc.js';
import { registerSettingsIpc } from './settings.ipc.js';
import { registerUsageIpc } from './usage.ipc.js';

export function registerAllIpcHandlers(
  scheduler: Scheduler,
  _windowManager: WindowManager,
  _gatewayServer: GatewayServer | null
): void {
  registerProvidersIpc(scheduler);
  registerModelsIpc();
  registerSchedulerIpc(scheduler);
  registerSettingsIpc();
  registerUsageIpc();
}
