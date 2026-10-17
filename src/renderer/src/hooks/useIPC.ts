import { useState, useEffect, useCallback } from 'react';
import { routeUrl } from '../../../shared/api-contract.js';
import type {
  AuditDetailResult,
  UpdateStateView,
  AuditListResult,
  AuditQuery,
  AuditSummary,
  CostSummary,
  OAuthCredentialState,
  OAuthFlowState,
  ProfileActionResult,
  ProfileView,
  ProviderDailyPoint,
  ProviderQuotaUsage,
} from '../../../shared/types/observability.js';

export interface UseIPCReturn<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

type IPCCall<T> = () => Promise<T>;

export type FreeLLMApi = Window['freellm'];

const API_BASE = '/api';

const ADMIN_TOKEN_KEY = 'freellm.adminToken';

/** The admin token is typed once into Settings and kept locally; the server never hands it out. */
export function getAdminToken(): string {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string): void {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // storage disabled (private mode): requests simply go without the header
  }
}

/** Build a query string, skipping absent values. */
function qs(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  return params.toString();
}

/** Same, but omits the `?` entirely when every value was absent. */
function withQuery(path: string, values: Record<string, string | number | undefined>): string {
  const query = qs(values);
  return query ? `${path}?${query}` : path;
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (init?.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = `请求失败 (HTTP ${res.status})`;
    if (res.status === 401) message = '需要管理令牌：请在设置页填入 ADMIN_TOKEN';
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

/**
 * Every URL here comes from `ADMIN_ROUTE_BINDINGS`, so the browser client and the IPC
 * client cannot drift apart from the routes the server actually registers.
 */
function createHttpApi(): FreeLLMApi {
  return {
    providers: {
      list: () => http<unknown[]>(routeUrl('providers:list')),
      get: (providerId: string) =>
        http<unknown>(routeUrl('providers:get', { providerId })),
      test: (providerId: string) =>
        postJson<{ success: boolean; error?: string }>(routeUrl('providers:test', { providerId })),
      setCredential: (providerId: string, credential: string) =>
        postJson<{ success: boolean }>(routeUrl('providers:set-credential', { providerId }), {
          credential,
        }),
      revealCredential: (providerId: string, index?: number) =>
        postJson<{ credential: string | null }>(
          routeUrl('providers:reveal-credential', { providerId }),
          { index: index ?? 0 }
        ),
      listCredentials: (providerId: string) =>
        http<{ credentials: Array<{ index: number; keyId: string; masked: string }> }>(
          routeUrl('providers:list-credentials', { providerId })
        ),
      addCredential: (providerId: string, credential: string) =>
        postJson<{
          success: boolean;
          error?: string;
          credentials?: Array<{ index: number; keyId: string; masked: string }>;
        }>(routeUrl('providers:add-credential', { providerId }), { credential }),
      removeCredentialSlot: (providerId: string, index: number) =>
        http<{
          success: boolean;
          error?: string;
          credentials?: Array<{ index: number; keyId: string; masked: string }>;
        }>(routeUrl('providers:remove-credential-slot', { providerId, index }), {
          method: 'DELETE',
        }),
      removeCredential: (providerId: string) =>
        http<{ success: boolean }>(routeUrl('providers:remove-credential', { providerId }), {
          method: 'DELETE',
        }),
      toggle: (providerId: string, enabled: boolean) =>
        postJson<{ success: boolean }>(routeUrl('providers:toggle', { providerId }), { enabled }),
      updateBaseUrl: (providerId: string, baseUrl: string) =>
        http<{ success: boolean; error?: string }>(routeUrl('providers:update-baseurl', { providerId }), {
          method: 'PUT',
          body: JSON.stringify({ baseUrl }),
        }),
      updateConfig: (providerId: string, input: { baseUrl?: string; settings?: Record<string, string> }) =>
        http<{ success: boolean; error?: string }>(routeUrl('providers:update-config', { providerId }), {
          method: 'PUT',
          body: JSON.stringify(input),
        }),
      setQuota: (providerId: string, quota: { maxRequestsPerDay?: number; maxTokensPerDay?: number }) =>
        http<{ success: boolean; error?: string }>(routeUrl('providers:set-quota', { providerId }), {
          method: 'PUT',
          body: JSON.stringify(quota),
        }),
      discoverModels: (providerId: string) =>
        postJson<{ success: boolean; models?: unknown[]; error?: string }>(
          routeUrl('providers:discover-models', { providerId })
        ),
      getModels: (providerId: string) =>
        http<unknown[]>(routeUrl('providers:get-models', { providerId })),
      createCustom: (input: {
        name: string;
        baseUrl: string;
        apiKey?: string;
        authType?: 'api-key' | 'oauth';
        oauth?: Record<string, unknown>;
      }) => postJson<{ success: boolean; providerId?: string; error?: string }>(routeUrl('providers:create-custom'), input),
      deleteCustom: (providerId: string) =>
        http<{ success: boolean; error?: string }>(routeUrl('providers:delete-custom', { providerId }), {
          method: 'DELETE',
        }),
      configureOAuth: (providerId: string, input: Record<string, unknown>) =>
        postJson<{ success: boolean; error?: string; config?: unknown }>(
          routeUrl('providers:configure-oauth', { providerId }),
          input
        ),
    },
    models: {
      list: () => http<unknown[]>(routeUrl('models:list')),
      get: (providerId: string, modelId: string) =>
        http<unknown>(routeUrl('models:get', { providerId, modelId })),
      discover: () => postJson<unknown[]>(routeUrl('models:discover')),
      refresh: () => postJson<unknown[]>(routeUrl('models:refresh')),
    },
    scheduler: {
      status: () => http<unknown>(routeUrl('scheduler:status')),
      resetCircuit: (providerId: string) =>
        postJson<{ success: boolean }>(routeUrl('scheduler:reset-circuit'), { providerId }),
      resetAllCircuits: () => postJson<{ success: boolean }>(routeUrl('scheduler:reset-all-circuits')),
    },
    settings: {
      get: (key: string) => http<string | null>(routeUrl('settings:get', { key })),
      set: (key: string, value: string) =>
        http<{ success: boolean }>(routeUrl('settings:set', { key }), {
          method: 'PUT',
          body: JSON.stringify({ value }),
        }),
      getAll: () => http<Record<string, string>>(routeUrl('settings:get-all')),
    },
    usage: {
      dashboard: (profileId?: string) =>
        http<unknown>(withQuery(routeUrl('usage:dashboard'), { profileId })),
      providerStats: (providerId: string, profileId?: string) =>
        http<unknown>(withQuery(routeUrl('usage:provider-stats', { providerId }), { profileId })),
      dailyStats: (days?: number, profileId?: string) =>
        http<unknown>(withQuery(routeUrl('usage:daily-stats'), { days, profileId })),
      recentCalls: (limit?: number) =>
        http<unknown[]>(withQuery(routeUrl('usage:recent-calls'), { limit })),
      costSummary: (days?: number, profileId?: string) =>
        http<CostSummary>(withQuery(routeUrl('usage:cost-summary'), { days, profileId })),
      quotaUsage: (profileId?: string) =>
        http<ProviderQuotaUsage[]>(withQuery(routeUrl('usage:quota-usage'), { profileId })),
      dailyByProvider: (days?: number, profileId?: string) =>
        http<ProviderDailyPoint[]>(
          withQuery(routeUrl('usage:daily-by-provider'), { days, profileId })
        ),
      auditList: (query?: AuditQuery) =>
        http<AuditListResult>(routeUrl('usage:audit-list'), {
          method: 'POST',
          body: JSON.stringify(query ?? {}),
        }),
      auditDetail: (requestId: string) =>
        http<AuditDetailResult | null>(routeUrl('usage:audit-detail', { requestId })),
      auditSummary: (days?: number, profileId?: string) =>
        http<AuditSummary>(withQuery(routeUrl('usage:audit-summary'), { days, profileId })),
      exportLogs: (input?: { format?: 'csv' | 'jsonl'; profileId?: string; limit?: number }) =>
        postJson<{ format: string; content: string }>(routeUrl('usage:export-logs'), input ?? {}),
      wipeData: (input?: { profileId?: string }) =>
        postJson<Record<string, number>>(routeUrl('usage:wipe-data'), input ?? {}),
    },
    update: {
      check: () => postJson<UpdateStateView>(routeUrl('update:check')),
      download: () => postJson<UpdateStateView>(routeUrl('update:download')),
      install: () => postJson<void>(routeUrl('update:install')),
      getState: () => http<UpdateStateView>(routeUrl('update:getState')),
      setEnabled: (input?: { enabled?: boolean; autoDownload?: boolean }) =>
        postJson<UpdateStateView>(routeUrl('update:setEnabled'), input ?? {}),
    },
    profiles: {
      list: () => http<ProfileView[]>(routeUrl('profiles:list')),
      active: () => http<ProfileView>(routeUrl('profiles:active')),
      get: (profileId: string) =>
        http<ProfileView | null>(routeUrl('profiles:get', { profileId })),
      create: (input: { name: string; description?: string; copyFrom?: string }) =>
        postJson<ProfileActionResult>(routeUrl('profiles:create'), input),
      update: (profileId: string, patch: { name?: string; description?: string }) =>
        http<ProfileActionResult>(routeUrl('profiles:update', { profileId }), {
          method: 'PUT',
          body: JSON.stringify(patch),
        }),
      remove: (profileId: string) =>
        http<{ ok: boolean; error?: string }>(routeUrl('profiles:delete', { profileId }), {
          method: 'DELETE',
        }),
      switch: (profileId: string) =>
        postJson<ProfileActionResult>(routeUrl('profiles:switch', { profileId })),
      duplicate: (from: string, to: string) =>
        postJson<{ ok: boolean; copied?: number; error?: string }>(routeUrl('profiles:duplicate'), {
          from,
          to,
        }),
      resetPool: (profileId: string) =>
        postJson<{ ok: boolean; cleared?: number }>(routeUrl('profiles:reset-pool', { profileId })),
    },
    oauth: {
      start: (providerId: string) =>
        postJson<{ ok: boolean; flow?: OAuthFlowState; error?: string }>(
          routeUrl('oauth:start', { providerId })
        ),
      status: (state: string) =>
        http<{ flow: OAuthFlowState | null; credential: OAuthCredentialState | null }>(
          routeUrl('oauth:status', { state })
        ),
      cancel: (state: string) =>
        postJson<{ ok: boolean; error?: string }>(routeUrl('oauth:cancel', { state })),
      refresh: (providerId: string) =>
        postJson<{ ok: boolean; credential?: OAuthCredentialState; error?: string }>(
          routeUrl('oauth:refresh', { providerId })
        ),
      unlink: (providerId: string) =>
        http<{ ok: boolean; error?: string }>(routeUrl('oauth:unlink', { providerId }), {
          method: 'DELETE',
        }),
    },
    gateway: {
      status: () => http<unknown>(routeUrl('gateway:getStatus')),
      getToken: () => http<string>(routeUrl('gateway:getToken')),
      generateToken: () => postJson<string>(routeUrl('gateway:generateToken')),
      updateConfig: (config: { host?: string; port?: number; authEnabled?: boolean }) =>
        http<unknown>(routeUrl('gateway:updateConfig'), {
          method: 'PUT',
          body: JSON.stringify(config),
        }),
    },
    app: {
      version: () => http<string>(routeUrl('app:version')),
      dataPath: () => http<string>(routeUrl('app:data-path')),
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
