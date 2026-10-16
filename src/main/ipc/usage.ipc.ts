import { registerIpcHandler } from './handle.js';
import * as usageService from '../services/usage-service.js';
import { normalizeAuditQuery } from '../../usage/audit-query.js';

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
}
