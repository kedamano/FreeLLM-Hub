import { useState, useEffect, useCallback } from 'react';

export interface UseIPCReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

type IPCCall<T> = () => Promise<T>;

export type FreeLLMApi = Window['freellm'];

const API_BASE = '/api';

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (!res.ok) {
    let message = `请求失败 (HTTP ${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body?.error === 'string') message = body.error;
    } catch {
      // response body was not JSON, keep default message
    }
    throw new Error(message);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return http<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
}

const seg = (value: string): string => encodeURIComponent(value);

function createHttpApi(): FreeLLMApi {
  return {
    providers: {
      list: () => http<unknown[]>('/providers'),
      get: (providerId: string) => http<unknown>(`/providers/${seg(providerId)}`),
      test: (providerId: string) =>
        postJson<{ success: boolean; error?: string }>(`/providers/${seg(providerId)}/test`),
      setCredential: (providerId: string, credential: string) =>
        postJson<{ success: boolean }>(`/providers/${seg(providerId)}/credential`, { credential }),
      getCredential: (providerId: string, index?: number) =>
        http<{ credential: string | null }>(
          `/providers/${seg(providerId)}/credential?index=${index ?? 0}`
        ),
      listCredentials: (providerId: string) =>
        http<{ credentials: Array<{ index: number; keyId: string; masked: string }> }>(
          `/providers/${seg(providerId)}/credentials`
        ),
      addCredential: (providerId: string, credential: string) =>
        postJson<{
          success: boolean;
          error?: string;
          credentials?: Array<{ index: number; keyId: string; masked: string }>;
        }>(`/providers/${seg(providerId)}/credentials`, { credential }),
      removeCredentialSlot: (providerId: string, index: number) =>
        http<{
          success: boolean;
          error?: string;
          credentials?: Array<{ index: number; keyId: string; masked: string }>;
        }>(`/providers/${seg(providerId)}/credentials/${index}`, { method: 'DELETE' }),
      removeCredential: (providerId: string) =>
        http<{ success: boolean }>(`/providers/${seg(providerId)}/credential`, { method: 'DELETE' }),
      toggle: (providerId: string, enabled: boolean) =>
        postJson<{ success: boolean }>(`/providers/${seg(providerId)}/toggle`, { enabled }),
      updateBaseUrl: (providerId: string, baseUrl: string) =>
        http<{ success: boolean; error?: string }>(`/providers/${seg(providerId)}/base-url`, {
          method: 'PUT',
          body: JSON.stringify({ baseUrl }),
        }),
      updateConfig: (providerId: string, input: { baseUrl?: string; settings?: Record<string, string> }) =>
        http<{ success: boolean; error?: string }>(`/providers/${seg(providerId)}/config`, {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      setQuota: (providerId: string, quota: { maxRequestsPerDay?: number; maxTokensPerDay?: number }) =>
        http<{ success: boolean; error?: string }>(`/providers/${seg(providerId)}/quota`, {
          method: 'PUT',
          body: JSON.stringify(quota),
        }),
      discoverModels: (providerId: string) =>
        postJson<{ success: boolean; models?: unknown[]; error?: string }>(
          `/providers/${seg(providerId)}/discover-models`
        ),
      getModels: (providerId: string) =>
        http<unknown[]>(`/providers/${seg(providerId)}/models`),
      createCustom: (input: { name: string; baseUrl: string; apiKey?: string }) =>
        postJson<{ success: boolean; providerId?: string; error?: string }>('/providers/custom', input),
      deleteCustom: (providerId: string) =>
        http<{ success: boolean; error?: string }>(`/providers/${seg(providerId)}`, { method: 'DELETE' }),
    },
    models: {
      list: () => http<unknown[]>('/models'),
      get: (providerId: string, modelId: string) =>
        http<unknown>(`/models/${seg(providerId)}/${seg(modelId)}`),
      discover: () => postJson<unknown[]>('/models/discover'),
      refresh: () => postJson<unknown[]>('/models/refresh'),
    },
    scheduler: {
      status: () => http<unknown>('/scheduler/status'),
      resetCircuit: (providerId: string) =>
        postJson<{ success: boolean }>('/scheduler/reset-circuit', { providerId }),
      resetAllCircuits: () => postJson<{ success: boolean }>('/scheduler/reset-all-circuits'),
    },
    settings: {
      get: (key: string) => http<string | null>(`/settings/${seg(key)}`),
      set: (key: string, value: string) =>
        http<{ success: boolean }>(`/settings/${seg(key)}`, { method: 'PUT', body: JSON.stringify({ value }) }),
      getAll: () => http<Record<string, string>>('/settings'),
    },
    usage: {
      dashboard: () => http<unknown>('/usage/summary'),
      providerStats: (providerId: string) => http<unknown>(`/usage/providers/${seg(providerId)}`),
      dailyStats: (days?: number) =>
        http<unknown>(`/usage/timeseries${days !== undefined ? `?days=${days}` : ''}`),
      recentCalls: (limit?: number) =>
        http<unknown[]>(`/usage/recent${limit !== undefined ? `?limit=${limit}` : ''}`),
    },
    gateway: {
      status: () => http<unknown>('/gateway/status'),
      getToken: () => http<string>('/gateway/token'),
      generateToken: () => postJson<string>('/gateway/generate-token'),
      updateConfig: (config: { host?: string; port?: number; authEnabled?: boolean }) =>
        http<unknown>('/gateway/config', { method: 'PUT', body: JSON.stringify(config) }),
    },
    app: {
      version: () => http<string>('/app/version'),
      dataPath: () => http<string>('/app/data-path'),
    },
  };
}

let httpApi: FreeLLMApi | null = null;

export function getFreellmApi(): FreeLLMApi | null {
  if (typeof window === 'undefined') return null;
  const injected = (window as { freellm?: FreeLLMApi }).freellm;
  if (injected) return injected;
  if (!httpApi) httpApi = createHttpApi();
  return httpApi;
}

export function useIPC<T>(ipcCall: IPCCall<T>, deps: unknown[] = []): UseIPCReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await ipcCall();
      setData(result as T);
    } catch (err) {
      const message = err instanceof Error ? err.message : '请求失败';
      setError(message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    execute();
  }, [execute]);

  return { data, loading, error, refetch: execute };
}

export function useIPCMutation<TArgs, TResult>() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutate = useCallback(async (fn: (args: TArgs) => Promise<TResult>, args: TArgs): Promise<TResult | null> => {
    setLoading(true);
    setError(null);
    try {
      const result = await fn(args);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : '操作失败';
      setError(message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  return { mutate, loading, error };
}
