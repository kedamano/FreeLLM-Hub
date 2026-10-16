import { app } from 'electron';
import { getAppConfig } from '../../core/config/app-config.js';
import { registerIpcHandler } from './handle.js';

export function registerAppIpc(): void {
  registerIpcHandler('app:version', async () => app.getVersion());

  registerIpcHandler('app:data-path', async () => getAppConfig().dataDir);
}
