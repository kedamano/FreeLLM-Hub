import type { IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc-channels.js';

const ALLOWED_CHANNELS = new Set<string>(IPC_CHANNELS);

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
