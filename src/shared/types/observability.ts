import type { ModelPricingType, ProviderId, TaskType } from './index.js';

/**
 * Contracts shared by the gateway audit trail, the cost/quota panel and the
 * configuration-profile UI.
 *
 * These live in `src/shared` because the renderer is only allowed to import from
 * `src/renderer` and `src/shared`; the main-process modules implement them and the
 * preload/HTTP bridges transport them, so a UI field and a SQL column can never drift
 * apart silently behind an `unknown`.
 */

export const AUDIT_STATUSES = [
  'in_progress',
  'success',
  'error',
  'rate_limited',
  'quota_exceeded',
  'rejected',
  'timeout',
  'aborted',
] as const;

export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const AUDIT_EVENT_TYPES = [
  'request.received',
  'request.rejected',
  'dispatch.start',
  'candidate.skipped',
  'candidate.selected',
  'attempt.start',
  'attempt.success',
  'attempt.failed',
  'response.head',
  'stream.first_token',
  'stream.completed',
  'stream.failed',
  'client.disconnected',
  'request.completed',
  'request.failed',
  'credential.rotated',
  'credential.refreshed',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export interface RequestAuditRecord {
  requestId: string;
  profileId: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  route: string;
  method: string;
  stream: boolean;
  requestedModel: string | null;
  taskType: string | null;
  status: AuditStatus;
  statusCode: number | null;
  providerId: string | null;
  modelId: string | null;
  attempts: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timeToFirstTokenMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  costUsd: number;
  savedCostUsd: number;
  params: Record<string, unknown> | null;
  clientAddress: string | null;
}

export interface RequestAuditEvent {
  seq: number;
  at: string;
  event: string;
  providerId: string | null;
  modelId: string | null;
  attempt: number | null;
  status: string | null;
  statusCode: number | null;
  reason: string | null;
  durationMs: number | null;
  detail: unknown;
}

export interface AuditQuery {
  limit?: number;
  offset?: number;
  status?: AuditStatus;
  providerId?: ProviderId;
  modelId?: string;
  requestId?: string;
  profileId?: string;
  from?: string;
  to?: string;
  failuresOnly?: boolean;
  search?: string;
}

export interface AuditListResult {
  total: number;
  items: RequestAuditRecord[];
}

export interface AuditDetailResult {
  request: RequestAuditRecord;
  events: RequestAuditEvent[];
}

export interface AuditSummary {
  windowDays: number;
  requests: number;
  /** Requests still in flight right now (a stale one means a crash mid-request). */
  inFlight: number;
  successRate: number;
  failureRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  avgTimeToFirstTokenMs: number | null;
  totalTokens: number;
  costUsd: number;
  savedCostUsd: number;
  byStatus: Array<{ status: string; count: number }>;
  topErrors: Array<{ code: string; message: string; count: number }>;
  providerBreakdown: Array<{
    providerId: string;
    requests: number;
    failures: number;
    tokens: number;
    avgDurationMs: number;
    costUsd: number;
  }>;
  volumeSeries: Array<{ date: string; requests: number; failures: number; tokens: number }>;
}

export interface CostSeriesPoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
  savedCostUsd: number;
}

export interface CostSummary {
  windowDays: number;
  profileId: string;
  requests: number;
  successfulRequests: number;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  referenceCostUsd: number;
  savedCostUsd: number;
  savedRate: number;
  currency: string;
  byProvider: Array<{
    providerId: ProviderId;
    requests: number;
    tokens: number;
    costUsd: number;
    savedCostUsd: number;
    share: number;
  }>;
  byModel: Array<{
    providerId: ProviderId;
    modelId: string;
    requests: number;
    tokens: number;
    costUsd: number;
    savedCostUsd: number;
    pricingType: ModelPricingType | null;
  }>;
  byTaskType: Array<{ taskType: string; requests: number; tokens: number; costUsd: number }>;
  series: CostSeriesPoint[];
}

export interface ProviderQuotaUsage {
  providerId: ProviderId;
  profileId: string;
  limitRequests: number | null;
  limitTokens: number | null;
  usedRequests: number;
  usedTokens: number;
  remainingRequests: number | null;
  remainingTokens: number | null;
  requestUsageRate: number | null;
  tokenUsageRate: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  todayCostUsd: number;
  todaySavedUsd: number;
  unbounded: boolean;
}

export interface ProviderDailyPoint {
  date: string;
  providerId: ProviderId;
  requests: number;
  tokens: number;
  costUsd: number;
}

export interface CallLogEntry {
  id: string;
  requestId: string;
  timestamp: string;
  providerId: ProviderId;
  modelId: string;
  taskType?: TaskType;
  status: 'success' | 'error' | 'timeout' | 'rate_limited';
  durationMs: number;
  promptTokens: number;
  completionTokens: number;
  errorMessage?: string;
  totalTokens?: number;
  profileId?: string;
  statusCode?: number;
  stream?: boolean;
  attempt?: number;
  costUsd?: number;
  savedCostUsd?: number;
}

export interface ProfileStats {
  profileId: string;
  enabledProviders: number;
  quotaConfigured: number;
  requests: number;
  tokens: number;
  costUsd: number;
  savedCostUsd: number;
}

export interface Profile {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  isActive: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileView extends Profile {
  stats: ProfileStats;
}

export interface ProfileActionResult {
  ok: boolean;
  error?: string;
  profile?: ProfileView;
  applied?: {
    profileId: string;
    enabledProviders: number;
    quotaProviders: number;
    restoredUsageBuckets: number;
    warnings: string[];
  };
}

/** Application self-update state, as the updater reports it to any surface. */
export interface UpdateStateView {
  phase: 'idle' | 'checking' | 'not-available' | 'available' | 'downloading' | 'ready' | 'error' | 'unsupported';
  version: string | null;
  percent: number | null;
  error: string | null;
  currentVersion: string;
  enabled?: boolean;
  autoDownload?: boolean;
}

/** Token state as surfaced to the UI — never contains a secret value. */
export interface OAuthCredentialState {
  providerId: ProviderId;
  configured: boolean;
  kind: 'api-key' | 'oauth' | 'none';
  expiresAt: string | null;
  /** Minutes until expiry; negative once expired. */
  secondsUntilExpiry: number | null;
  refreshable: boolean;
  scope: string | null;
  tokenType: string | null;
  status: 'active' | 'expired' | 'revoked' | 'refreshing' | 'error' | 'unconfigured';
  lastRefreshedAt: string | null;
  label: string | null;
}

export interface OAuthFlowState {
  state: string;
  providerId: ProviderId;
  status: 'pending' | 'authorized' | 'failed' | 'cancelled' | 'expired';
  authorizationUrl: string | null;
  error: string | null;
  expiresAt: string;
}
