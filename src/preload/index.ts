import { contextBridge, ipcRenderer } from 'electron';
// Type-only: the channel contract is compile-time, so a typo in a channel name is a
// build error and the sandboxed preload keeps a single runtime dependency (electron).
import type { IpcChannel } from '../shared/ipc-channels.js';

function invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke(channel, ...args);
}

const api = {
  providers: {
    list: () => invoke('providers:list'),
    get: (providerId: string) => invoke('providers:get', providerId),
    test: (providerId: string) => invoke('providers:test', providerId),
    setCredential: (providerId: string, credential: string) =>
      invoke('providers:set-credential', providerId, credential),
    getCredential: (providerId: string, index?: number) =>
      invoke('providers:get-credential', providerId, index ?? 0),
    listCredentials: (providerId: string) => invoke('providers:list-credentials', providerId),
    addCredential: (providerId: string, credential: string) =>
      invoke('providers:add-credential', providerId, credential),
    removeCredentialSlot: (providerId: string, index: number) =>
      invoke('providers:remove-credential-slot', providerId, index),
    removeCredential: (providerId: string) => invoke('providers:remove-credential', providerId),
    toggle: (providerId: string, enabled: boolean) => invoke('providers:toggle', providerId, enabled),
    updateBaseUrl: (providerId: string, baseUrl: string) =>
      invoke('providers:update-baseurl', providerId, baseUrl),
    updateConfig: (providerId: string, input: { baseUrl?: string; settings?: Record<string, string> }) =>
      invoke('providers:update-config', providerId, input),
    discoverModels: (providerId: string) => invoke('providers:discover-models', providerId),
    getModels: (providerId: string) => invoke('providers:get-models', providerId),
    createCustom: (input: { name: string; baseUrl: string; apiKey?: string }) =>
      invoke('providers:create-custom', input),
    deleteCustom: (providerId: string) => invoke('providers:delete-custom', providerId),
  },

  models: {
    list: () => invoke('models:list'),
    get: (providerId: string, modelId: string) => invoke('models:get', providerId, modelId),
    discover: () => invoke('models:discover'),
    refresh: () => invoke('models:refresh'),
  },

  scheduler: {
    status: () => invoke('scheduler:status'),
    resetCircuit: (providerId: string) => invoke('scheduler:reset-circuit', providerId),
    resetAllCircuits: () => invoke('scheduler:reset-all-circuits'),
  },

  settings: {
    get: (key: string) => invoke('settings:get', key),
    set: (key: string, value: string) => invoke('settings:set', key, value),
    getAll: () => invoke('settings:get-all'),
  },

  usage: {
    dashboard: () => invoke('usage:dashboard'),
    providerStats: (providerId: string) => invoke('usage:provider-stats', providerId),
    dailyStats: (days?: number) => invoke('usage:daily-stats', days),
    recentCalls: (limit?: number) => invoke('usage:recent-calls', limit),
  },

  gateway: {
    status: () => invoke('gateway:getStatus'),
    getToken: () => invoke('gateway:getToken'),
    generateToken: () => invoke('gateway:generateToken'),
    updateConfig: (config: { host?: string; port?: number; authEnabled?: boolean }) =>
      invoke('gateway:updateConfig', config),
  },

  app: {
    version: () => invoke('app:version'),
    dataPath: () => invoke('app:data-path'),
  },
};

contextBridge.exposeInMainWorld('freellm', api);

export type FreeLLMApi = typeof api;
