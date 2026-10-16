import { getDashboardStats, getProviderStatistics, getDailyStats } from '../../usage/statistics.js';
import { getRecentCalls } from '../../usage/usage-recorder.js';
import type { ProviderId } from '../../shared/types/index.js';

export function usageDashboard() {
  return getDashboardStats();
}

export function usageProviderStats(providerId: string) {
  return getProviderStatistics(providerId as ProviderId);
}

export function usageDailyStats(days?: number) {
  return getDailyStats(days || 7);
}

export function usageRecentCalls(limit?: number) {
  return getRecentCalls(limit || 100);
}
