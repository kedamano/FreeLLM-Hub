import { registerIpcHandler } from './handle.js';
import * as usageService from '../services/usage-service.js';

export function registerUsageIpc(): void {
  registerIpcHandler('usage:dashboard', async () => usageService.usageDashboard());
  registerIpcHandler('usage:provider-stats', async (_e, providerId: string) =>
    usageService.usageProviderStats(providerId)
  );
  registerIpcHandler('usage:daily-stats', async (_e, days?: number) => usageService.usageDailyStats(days));
  registerIpcHandler('usage:recent-calls', async (_e, limit?: number) => usageService.usageRecentCalls(limit));
}
