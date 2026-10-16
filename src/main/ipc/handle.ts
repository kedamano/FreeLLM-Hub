import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { createIpcGuard, isAllowedChannel, sanitizeIpcInput, type IpcHandler } from '../security/ipc-guard.js';
import { redactSecrets } from '../security/secret-redaction.js';

export interface IpcErrorResult {
  success: false;
  error: string;
}

function toIpcError(err: unknown): IpcErrorResult {
  const message = err instanceof Error ? err.message : String(err);
  return { success: false, error: redactSecrets(message) };
}

export function handle<T>(fn: IpcHandler): IpcHandler {
  return async (event: IpcMainInvokeEvent, ...args: any[]) => {
    try {
      return (await fn(event, ...args)) as T;
    } catch (err) {
      const failure = toIpcError(err);
      console.error(`[IPC] Handler failed: ${failure.error}`);
      return failure;
    }
  };
}

export function registerIpcHandler(channel: string, fn: IpcHandler): void {
  if (!isAllowedChannel(channel)) {
    console.error(`[IPC] Refusing to register non-allowlisted channel: ${channel}`);
    return;
  }

  const sanitized: IpcHandler = async (event, ...args) => fn(event, ...args.map(sanitizeIpcInput));
  ipcMain.handle(channel, handle(createIpcGuard(channel, sanitized)));
}
