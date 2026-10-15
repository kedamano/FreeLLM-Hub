/// <reference types="vite/client" />

interface Window {
  freellm: {
    providers: {
      list: () => Promise<unknown[]>;
      get: (id: string) => Promise<unknown>;
      test: (id: string) => Promise<{ success: boolean; error?: string }>;
      setCredential: (id: string, cred: string) => Promise<{ success: boolean }>;
      removeCredential: (id: string) => Promise<{ success: boolean }>;
      toggle: (id: string, enabled: boolean) => Promise<{ success: boolean }>;
    };
    models: {
      list: () => Promise<unknown[]>;
      get: (providerId: string, modelId: string) => Promise<unknown>;
      discover: () => Promise<unknown[]>;
      refresh: () => Promise<unknown[]>;
    };
    scheduler: {
      status: () => Promise<unknown>;
      resetCircuit: (providerId: string) => Promise<{ success: boolean }>;
      resetAllCircuits: () => Promise<{ success: boolean }>;
    };
    settings: {
      get: (key: string) => Promise<string | null>;
      set: (key: string, value: string) => Promise<{ success: boolean }>;
      getAll: () => Promise<Record<string, string>>;
    };
    usage: {
      dashboard: () => Promise<unknown>;
      providerStats: (providerId: string) => Promise<unknown>;
      dailyStats: (days?: number) => Promise<unknown>;
      recentCalls: (limit?: number) => Promise<unknown[]>;
    };
    gateway: {
      status: () => Promise<unknown>;
      port: () => Promise<number>;
    };
    app: {
      version: () => Promise<string>;
      dataPath: () => Promise<string>;
    };
  };
}
