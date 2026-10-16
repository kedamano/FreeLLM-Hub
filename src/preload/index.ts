import { contextBridge, ipcRenderer } from 'electron';

const api = {
  providers: {
    list: () => ipcRenderer.invoke('providers:list'),
    get: (providerId: string) => ipcRenderer.invoke('providers:get', providerId),
    test: (providerId: string) => ipcRenderer.invoke('providers:test', providerId),
    setCredential: (providerId: string, credential: string) =>
      ipcRenderer.invoke('providers:set-credential', providerId, credential),
    getCredential: (providerId: string) =>
      ipcRenderer.invoke('providers:get-credential', providerId),
    removeCredential: (providerId: string) =>
      ipcRenderer.invoke('providers:remove-credential', providerId),
    toggle: (providerId: string, enabled: boolean) =>
      ipcRenderer.invoke('providers:toggle', providerId, enabled),
    updateBaseUrl: (providerId: string, baseUrl: string) =>
      ipcRenderer.invoke('providers:update-baseurl', providerId, baseUrl),
    discoverModels: (providerId: string) =>
      ipcRenderer.invoke('providers:discover-models', providerId),
    getModels: (providerId: string) =>
      ipcRenderer.invoke('providers:get-models', providerId),
    createCustom: (input: { name: string; baseUrl: string; apiKey?: string }) =>
      ipcRenderer.invoke('providers:create-custom', input),
    deleteCustom: (providerId: string) =>
      ipcRenderer.invoke('providers:delete-custom', providerId),
  },

  models: {
    list: () => ipcRenderer.invoke('models:list'),
    get: (providerId: string, modelId: string) =>
      ipcRenderer.invoke('models:get', providerId, modelId),
    discover: () => ipcRenderer.invoke('models:discover'),
    refresh: () => ipcRenderer.invoke('models:refresh'),
  },

  scheduler: {
    status: () => ipcRenderer.invoke('scheduler:status'),
    resetCircuit: (providerId: string) =>
      ipcRenderer.invoke('scheduler:reset-circuit', providerId),
    resetAllCircuits: () => ipcRenderer.invoke('scheduler:reset-all-circuits'),
  },

  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    getAll: () => ipcRenderer.invoke('settings:get-all'),
  },

  usage: {
    dashboard: () => ipcRenderer.invoke('usage:dashboard'),
    providerStats: (providerId: string) =>
      ipcRenderer.invoke('usage:provider-stats', providerId),
    dailyStats: (days?: number) => ipcRenderer.invoke('usage:daily-stats', days),
    recentCalls: (limit?: number) => ipcRenderer.invoke('usage:recent-calls', limit),
  },

  gateway: {
    status: () => ipcRenderer.invoke('gateway:getStatus'),
    getToken: () => ipcRenderer.invoke('gateway:getToken'),
    generateToken: () => ipcRenderer.invoke('gateway:generateToken'),
    updateConfig: (config: { host?: string; port?: number; authEnabled?: boolean }) =>
      ipcRenderer.invoke('gateway:updateConfig', config),
  },

  app: {
    version: () => ipcRenderer.invoke('app:version'),
    dataPath: () => ipcRenderer.invoke('app:data-path'),
  },
};

contextBridge.exposeInMainWorld('freellm', api);

export type FreeLLMApi = typeof api;
