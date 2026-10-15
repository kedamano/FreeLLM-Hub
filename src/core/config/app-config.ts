import { app } from 'electron';
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

export function getAppConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const userDataPath = isDev
    ? resolve(process.cwd(), '.dev-data')
    : app.getPath('userData');

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
