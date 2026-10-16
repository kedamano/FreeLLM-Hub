import {
  getCostSummary,
  getDailyStats,
  getDailyStatsByProvider,
  getProviderQuotaUsage,
  getProviderStatistics,
  getDashboardStats,
} from '../../usage/statistics.js';
import { getRecentCalls, queryCallLogs } from '../../usage/usage-recorder.js';
import {
  getAuditSummary,
  getRequestAuditDetail,
  listRequestAudit,
  type AuditQuery,
} from '../../usage/audit-recorder.js';
import { getActiveProfileId } from '../../core/settings/profile-store.js';
import type { ProviderId } from '../../shared/types/index.js';

export function usageDashboard(profileId?: string) {
  return getDashboardStats(profileId || getActiveProfileId());
}

export function usageProviderStats(providerId: string, profileId?: string) {
  return getProviderStatistics(providerId as ProviderId, profileId || getActiveProfileId());
}

export function usageDailyStats(days?: number, profileId?: string) {
  return getDailyStats(days || 7, profileId || getActiveProfileId());
}

export function usageRecentCalls(limit?: number) {
  return getRecentCalls(limit || 100);
}

/** Cost / quota-ceiling roll-up that drives the usage charts. */
export function usageCostSummary(days?: number, profileId?: string) {
  return getCostSummary({
    days: days && days > 0 ? days : 30,
    profileId: profileId || getActiveProfileId(),
  });
}

export function usageQuotaUsage(profileId?: string) {
  return getProviderQuotaUsage(profileId || getActiveProfileId());
}

export function usageDailyByProvider(days?: number, profileId?: string) {
  return getDailyStatsByProvider(days && days > 0 ? days : 14, profileId || getActiveProfileId());
}

export function usageCallLogPage(query: Parameters<typeof queryCallLogs>[0] = {}) {
  return queryCallLogs({ ...query, profileId: query.profileId || getActiveProfileId() });
}

// ─── Gateway request audit ───────────────────────────────────────────

export function auditList(query: AuditQuery = {}) {
  return listRequestAudit({
    ...query,
    profileId: query.profileId ?? getActiveProfileId(),
  });
}

export function auditDetail(requestId: string) {
  return getRequestAuditDetail(String(requestId ?? '').slice(0, 80));
}

export function auditSummary(days?: number, profileId?: string) {
  return getAuditSummary({
    days: days && days > 0 ? days : 7,
    profileId: profileId || getActiveProfileId(),
  });
}
