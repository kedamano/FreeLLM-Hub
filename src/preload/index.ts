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
    revealCredential: (providerId: string, index?: number) =>
      invoke('providers:reveal-credential', providerId, index ?? 0),
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
    setQuota: (providerId: string, quota: { maxRequestsPerDay?: number; maxTokensPerDay?: number }) =>
      invoke('providers:set-quota', providerId, quota),
    discoverModels: (providerId: string) => invoke('providers:discover-models', providerId),
    getModels: (providerId: string) => invoke('providers:get-models', providerId),
    createCustom: (input: {
      name: string;
      baseUrl: string;
      apiKey?: string;
      authType?: 'api-key' | 'oauth';
      oauth?: Record<string, unknown>;
    }) => invoke('providers:create-custom', input),
    deleteCustom: (providerId: string) => invoke('providers:delete-custom', providerId),
    configureOAuth: (
      providerId: string,
      input: {
        authorizationUrl: string;
        tokenUrl: string;
        clientId: string;
        clientSecret?: string;
        scopes?: string;
        usePkce?: boolean;
      }
    ) => invoke('providers:configure-oauth', providerId, input),
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
    dashboard: (profileId?: string) => invoke('usage:dashboard', profileId),
    providerStats: (providerId: string, profileId?: string) =>
      invoke('usage:provider-stats', providerId, profileId),
    dailyStats: (days?: number, profileId?: string) => invoke('usage:daily-stats', days, profileId),
    recentCalls: (limit?: number) => invoke('usage:recent-calls', limit),
    costSummary: (days?: number, profileId?: string) =>
      invoke('usage:cost-summary', days, profileId),
    quotaUsage: (profileId?: string) => invoke('usage:quota-usage', profileId),
    dailyByProvider: (days?: number, profileId?: string) =>
      invoke('usage:daily-by-provider', days, profileId),
    auditList: (query?: Record<string, unknown>) => invoke('usage:audit-list', query),
    auditDetail: (requestId: string) => invoke('usage:audit-detail', requestId),
    auditSummary: (days?: number, profileId?: string) => invoke('usage:audit-summary', days, profileId),
  },

  profiles: {
    list: () => invoke('profiles:list'),
    active: () => invoke('profiles:active'),
    get: (profileId: string) => invoke('profiles:get', profileId),
    create: (input: { name: string; description?: string; copyFrom?: string }) =>
      invoke('profiles:create', input),
    update: (profileId: string, patch: { name?: string; description?: string }) =>
      invoke('profiles:update', profileId, patch),
    remove: (profileId: string) => invoke('profiles:delete', profileId),
    switch: (profileId: string) => invoke('profiles:switch', profileId),
    duplicate: (from: string, to: string) => invoke('profiles:duplicate', from, to),
    resetPool: (profileId: string) => invoke('profiles:reset-pool', profileId),
  },

  oauth: {
    start: (providerId: string) => invoke('oauth:start', providerId),
    status: (state: string) => invoke('oauth:status', state),
    cancel: (state: string) => invoke('oauth:cancel', state),
    refresh: (providerId: string) => invoke('oauth:refresh', providerId),
    unlink: (providerId: string) => invoke('oauth:unlink', providerId),
  },

  update: {
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    getState: () => invoke('update:getState'),
    setEnabled: (input: { enabled?: boolean; autoDownload?: boolean }) =>
      invoke('update:setEnabled', input),
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
