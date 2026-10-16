import type { Scheduler } from '../../scheduler/scheduler.js';
import type { WindowManager } from '../window-manager.js';
import type { GatewayServer } from '../gateway/server.js';
import { registerProvidersIpc, applyPersistedProviderEnabled } from './providers.ipc.js';
import { registerModelsIpc } from './models.ipc.js';
import { registerSchedulerIpc } from './scheduler.ipc.js';
import { registerSettingsIpc } from './settings.ipc.js';
import { registerUsageIpc } from './usage.ipc.js';
import { registerProfileIpc } from './profiles.ipc.js';
import { registerOAuthIpc } from './oauth.ipc.js';
import { registerAppIpc } from './app.ipc.js';

export function registerAllIpcHandlers(
  scheduler: Scheduler,
  _windowManager: WindowManager,
  _gatewayServer: GatewayServer | null
): void {
  applyPersistedProviderEnabled();
  registerProvidersIpc(scheduler);
  registerModelsIpc();
  registerSchedulerIpc(scheduler);
  registerSettingsIpc();
  registerUsageIpc();
  registerProfileIpc(scheduler);
  registerOAuthIpc();
  registerAppIpc();
}
