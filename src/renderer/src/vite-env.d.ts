/// <reference types="vite/client" />

interface Window {
  freellm: {
    providers: {
      list: () => Promise<unknown[]>;
      get: (providerId: string) => Promise<unknown>;
      test: (providerId: string) => Promise<{ success: boolean; error?: string }>;
      setCredential: (providerId: string, credential: string) => Promise<{ success: boolean }>;
      removeCredential: (providerId: string) => Promise<{ success: boolean }>;
      toggle: (providerId: string, enabled: boolean) => Promise<{ success: boolean }>;
      updateBaseUrl: (
        providerId: string,
        baseUrl: string
      ) => Promise<{ success: boolean; error?: string }>;
      discoverModels: (providerId: string) => Promise<{
        success: boolean;
        models?: unknown[];
        error?: string;
      }>;
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
      getToken: () => Promise<string>;
      generateToken: () => Promise<string>;
      updateConfig: (config: {
        host?: string;
        port?: number;
        authEnabled?: boolean;
      }) => Promise<unknown>;
    };
    app: {
      version: () => Promise<string>;
      dataPath: () => Promise<string>;
    };
  };
}
