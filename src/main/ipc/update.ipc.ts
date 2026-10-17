import { registerIpcHandler } from './handle.js';
import { getUpdateService } from '../services/update-service.js';

/**
 * App self-update IPC. In unpackaged/dev runs the service reports phase
 * 'unsupported' honestly instead of pretending to check a feed.
 */
export function registerUpdateIpc(): void {
  registerIpcHandler('update:check', async () => getUpdateService().check(true));
  registerIpcHandler('update:download', async () => getUpdateService().download());
  registerIpcHandler('update:install', async () => getUpdateService().install());
  registerIpcHandler('update:getState', async () => getUpdateService().getState());
  registerIpcHandler('update:setEnabled', async (_e, input?: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    if (typeof raw.enabled === 'boolean') getUpdateService().setEnabled(raw.enabled);
    if (typeof raw.autoDownload === 'boolean') getUpdateService().setAutoDownload(raw.autoDownload);
    return getUpdateService().getState();
  });
}
