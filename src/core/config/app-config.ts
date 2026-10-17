import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../providers/request-errors.js';

export interface AppConfig {
  isDev: boolean;
  userDataPath: string;
  dataDir: string;
  logDir: string;
  configFilePath: string;
  dbPath: string;
  gatewayHost: string;
  gatewayPort: number;
  /** Deadline the gateway hands to the scheduler for one provider attempt. */
  requestTimeoutMs: number;
  logLevel: string;
  /** Size a single `app.N.log` may reach before the transport rolls it. */
  logMaxSizeMb: number;
  /** Rolled files kept beside the active one; older ones are deleted. */
  logMaxFiles: number;
}

let cachedConfig: AppConfig | null = null;

/** Keep a mistyped `REQUEST_TIMEOUT_MS` from turning into an instant abort or a hung request. */
function resolveRequestTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1000) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.min(parsed, 15 * 60 * 1000);
}

/** A 0 or negative cap would delete the log on the first write, so both knobs have a floor. */
function resolvePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (raw === undefined || !Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function isElectronRuntime(): boolean {
  return getElectronApp() !== null;
}

function getElectronApp(): { isPackaged: boolean; getPath(name: string): string } | null {
  // process.versions.electron is also set when Electron runs in plain-node mode
  // (ELECTRON_RUN_AS_NODE), so probe the actual main-process API instead.
  if (!process.versions?.electron) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron') as { app?: { isPackaged: boolean; getPath(name: string): string } };
    return app && typeof app.getPath === 'function' ? app : null;
  } catch {
    return null;
  }
}

export function getAppConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const electronApp = getElectronApp();

  let userDataPath: string;
  let isDev: boolean;
  if (electronApp) {
    isDev = process.env.NODE_ENV === 'development' || !electronApp.isPackaged;
    userDataPath = isDev ? resolve(process.cwd(), '.dev-data') : electronApp.getPath('userData');
  } else {
    isDev = process.env.NODE_ENV === 'development';
    userDataPath = process.env.FREEELLM_DATA_DIR || resolve(process.cwd(), '.web-data');
  }

  const dataDir = resolve(userDataPath, 'data');
  const logDir = resolve(userDataPath, 'logs');

  for (const dir of [dataDir, logDir]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  cachedConfig = {
    isDev,
    userDataPath,
    dataDir,
    logDir,
    configFilePath: resolve(userDataPath, 'settings.json'),
    dbPath: resolve(dataDir, 'freellm-hub.db'),
    gatewayHost: process.env.GATEWAY_HOST || '127.0.0.1',
    gatewayPort: parseInt(process.env.GATEWAY_PORT || '0', 10),
    requestTimeoutMs: resolveRequestTimeoutMs(process.env.REQUEST_TIMEOUT_MS),
    logLevel: process.env.LOG_LEVEL || 'info',
    logMaxSizeMb: resolvePositiveInt(process.env.LOG_MAX_SIZE_MB, 10, 1024),
    logMaxFiles: resolvePositiveInt(process.env.LOG_MAX_FILES, 5, 100),
  };

  return cachedConfig;
}

export function resetAppConfigCache(): void {
  cachedConfig = null;
}
