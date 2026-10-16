/// <reference types="vite/client" />

import type {
  AuditDetailResult,
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
} from '../../shared/types/observability.js';

declare global {
  interface Window {
    freellm: {
      providers: {
        list: () => Promise<unknown[]>;
        get: (providerId: string) => Promise<unknown>;
        test: (providerId: string) => Promise<{ success: boolean; error?: string }>;
        setCredential: (providerId: string, credential: string) => Promise<{ success: boolean }>;
        getCredential: (providerId: string, index?: number) => Promise<{ credential: string | null }>;
        listCredentials: (providerId: string) => Promise<{
          credentials: Array<{ index: number; keyId: string; masked: string }>;
        }>;
        addCredential: (
          providerId: string,
          credential: string
        ) => Promise<{
          success: boolean;
          error?: string;
          credentials?: Array<{ index: number; keyId: string; masked: string }>;
        }>;
        removeCredentialSlot: (
          providerId: string,
          index: number
        ) => Promise<{
          success: boolean;
          error?: string;
          credentials?: Array<{ index: number; keyId: string; masked: string }>;
        }>;
        removeCredential: (providerId: string) => Promise<{ success: boolean }>;
        toggle: (providerId: string, enabled: boolean) => Promise<{ success: boolean }>;
        updateBaseUrl: (
          providerId: string,
          baseUrl: string
        ) => Promise<{ success: boolean; error?: string }>;
        updateConfig: (
          providerId: string,
          input: { baseUrl?: string; settings?: Record<string, string> }
        ) => Promise<{ success: boolean; error?: string }>;
        setQuota: (
          providerId: string,
          quota: { maxRequestsPerDay?: number; maxTokensPerDay?: number }
        ) => Promise<{ success: boolean; error?: string }>;
        discoverModels: (providerId: string) => Promise<{
          success: boolean;
          models?: unknown[];
          error?: string;
        }>;
        getModels: (providerId: string) => Promise<unknown[]>;
        createCustom: (input: {
          name: string;
          baseUrl: string;
          apiKey?: string;
          authType?: 'api-key' | 'oauth';
          oauth?: {
            authorizationUrl: string;
            tokenUrl: string;
            clientId: string;
            clientSecret?: string;
            scopes?: string;
            usePkce?: boolean;
          };
        }) => Promise<{ success: boolean; providerId?: string; error?: string }>;
        deleteCustom: (providerId: string) => Promise<{ success: boolean; error?: string }>;
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
        ) => Promise<{ success: boolean; error?: string; config?: unknown }>;
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
        dashboard: (profileId?: string) => Promise<unknown>;
        providerStats: (providerId: string, profileId?: string) => Promise<unknown>;
        dailyStats: (days?: number, profileId?: string) => Promise<unknown>;
        recentCalls: (limit?: number) => Promise<unknown[]>;
        costSummary: (days?: number, profileId?: string) => Promise<CostSummary>;
        quotaUsage: (profileId?: string) => Promise<ProviderQuotaUsage[]>;
        dailyByProvider: (days?: number, profileId?: string) => Promise<ProviderDailyPoint[]>;
        auditList: (query?: AuditQuery) => Promise<AuditListResult>;
        auditDetail: (requestId: string) => Promise<AuditDetailResult | null>;
        auditSummary: (days?: number, profileId?: string) => Promise<AuditSummary>;
      };
      profiles: {
        list: () => Promise<ProfileView[]>;
        active: () => Promise<ProfileView>;
        get: (profileId: string) => Promise<ProfileView | null>;
        create: (input: {
          name: string;
          description?: string;
          copyFrom?: string;
        }) => Promise<ProfileActionResult>;
        update: (
          profileId: string,
          patch: { name?: string; description?: string }
        ) => Promise<ProfileActionResult>;
        remove: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
        switch: (profileId: string) => Promise<ProfileActionResult>;
        duplicate: (
          from: string,
          to: string
        ) => Promise<{ ok: boolean; copied?: number; error?: string }>;
        resetPool: (profileId: string) => Promise<{ ok: boolean; cleared?: number }>;
      };
      oauth: {
        start: (
          providerId: string
        ) => Promise<{ ok: boolean; flow?: OAuthFlowState; error?: string }>;
        status: (
          state: string
        ) => Promise<{ flow: OAuthFlowState | null; credential: OAuthCredentialState | null }>;
        cancel: (state: string) => Promise<{ ok: boolean; error?: string }>;
        refresh: (
          providerId: string
        ) => Promise<{ ok: boolean; credential?: OAuthCredentialState; error?: string }>;
        unlink: (providerId: string) => Promise<{ ok: boolean; error?: string }>;
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
}

export {};
