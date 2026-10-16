import { getDashboardStats, getProviderStatistics, getDailyStats } from '../../usage/statistics.js';
import { getRecentCalls } from '../../usage/usage-recorder.js';
import { registerIpcHandler } from './handle.js';

export function registerUsageIpc(): void {
  registerIpcHandler('usage:dashboard', async () => getDashboardStats());

  registerIpcHandler('usage:provider-stats', async (_e, providerId: string) =>
    getProviderStatistics(providerId as never)
  );

  registerIpcHandler('usage:daily-stats', async (_e, days?: number) => getDailyStats(days || 7));

  registerIpcHandler('usage:recent-calls', async (_e, limit?: number) => getRecentCalls(limit || 100));
}
