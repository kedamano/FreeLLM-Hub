import type { IpcMainInvokeEvent } from 'electron';

const ALLOWED_CHANNELS = new Set<string>([
  'providers:list',
  'providers:get',
  'providers:test',
  'providers:set-credential',
  'providers:get-credential',
  'providers:remove-credential',
  'providers:toggle',
  'providers:update-baseurl',
  'providers:discover-models',
  'providers:get-models',
  'models:list',
  'models:get',
  'models:discover',
  'models:refresh',
  'scheduler:status',
  'scheduler:reset-circuit',
  'scheduler:reset-all-circuits',
  'settings:get',
  'settings:set',
  'settings:get-all',
  'usage:dashboard',
  'usage:provider-stats',
  'usage:daily-stats',
  'usage:recent-calls',
  'gateway:getStatus',
  'gateway:getToken',
  'gateway:generateToken',
  'gateway:updateConfig',
  'app:version',
  'app:data-path',
]);

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => Promise<unknown>;

export function createIpcGuard(channel: string, handler: IpcHandler): IpcHandler {
  return async (event, ...args) => {
    if (!isAllowedChannel(channel)) {
      throw new Error(`IPC channel not allowed: ${channel}`);
    }
    if (!event.sender || event.sender.isDestroyed()) {
      throw new Error('Invalid IPC sender');
    }
    return handler(event, ...args);
  };
}

export function isAllowedChannel(channel: string): boolean {
  return ALLOWED_CHANNELS.has(channel);
}

export function sanitizeIpcInput(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.slice(0, 10000);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 1000).map(sanitizeIpcInput);
  }
  if (typeof value === 'object' && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.length > 256) continue;
      result[k] = sanitizeIpcInput(v);
    }
    return result;
  }
  return value;
}
