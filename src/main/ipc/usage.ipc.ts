import { registerIpcHandler } from './handle.js';
import * as usageService from '../services/usage-service.js';
import { normalizeAuditQuery } from '../../usage/audit-query.js';
import { exportCallLogs, wipeUserData, type ExportFormat } from '../../usage/data-governance.js';
import { getActiveProfileId } from '../../core/settings/profile-store.js';

export function registerUsageIpc(): void {
  registerIpcHandler('usage:dashboard', async (_e, profileId?: string) =>
    usageService.usageDashboard(profileId)
  );
  registerIpcHandler('usage:provider-stats', async (_e, providerId: string, profileId?: string) =>
    usageService.usageProviderStats(providerId, profileId)
  );
  registerIpcHandler('usage:daily-stats', async (_e, days?: number, profileId?: string) =>
    usageService.usageDailyStats(days, profileId)
  );
  registerIpcHandler('usage:recent-calls', async (_e, limit?: number) =>
    usageService.usageRecentCalls(limit)
  );
  registerIpcHandler('usage:cost-summary', async (_e, days?: number, profileId?: string) =>
    usageService.usageCostSummary(days, profileId)
  );
  registerIpcHandler('usage:quota-usage', async (_e, profileId?: string) =>
    usageService.usageQuotaUsage(profileId)
  );
  registerIpcHandler('usage:daily-by-provider', async (_e, days?: number, profileId?: string) =>
    usageService.usageDailyByProvider(days, profileId)
  );
  registerIpcHandler('usage:audit-list', async (_e, query?: unknown) =>
    usageService.auditList(normalizeAuditQuery(query))
  );
  registerIpcHandler('usage:audit-detail', async (_e, requestId?: string) =>
    usageService.auditDetail(requestId ?? '')
  );
  registerIpcHandler('usage:audit-summary', async (_e, days?: number, profileId?: string) =>
    usageService.auditSummary(days, profileId)
  );
  registerIpcHandler('usage:export-logs', async (_e, input?: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const format: ExportFormat = raw.format === 'jsonl' ? 'jsonl' : 'csv';
    const profileId =
      typeof raw.profileId === 'string' && raw.profileId.trim() ? raw.profileId.trim() : getActiveProfileId();
    const limit = Number(raw.limit);
    return {
      format,
      profileId,
      content: exportCallLogs({ profileId, format, limit: Number.isFinite(limit) ? limit : undefined }),
    };
  });
  registerIpcHandler('usage:wipe-data', async (_e, input?: unknown) => {
    const raw = (input ?? {}) as Record<string, unknown>;
    const profileId = typeof raw.profileId === 'string' && raw.profileId.trim() ? raw.profileId.trim() : undefined;
    return wipeUserData(profileId);
  });
}
