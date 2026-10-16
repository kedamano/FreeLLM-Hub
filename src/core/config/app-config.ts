import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';

export interface AppConfig {
  isDev: boolean;
  userDataPath: string;
  dataDir: string;
  logDir: string;
  configFilePath: string;
  dbPath: string;
  gatewayHost: string;
  gatewayPort: number;
  logLevel: string;
}

let cachedConfig: AppConfig | null = null;

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
    logLevel: process.env.LOG_LEVEL || 'info',
  };

  return cachedConfig;
}

export function resetAppConfigCache(): void {
  cachedConfig = null;
}
