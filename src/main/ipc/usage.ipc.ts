import { getDashboardStats, getProviderStatistics, getDailyStats } from '../../usage/statistics.js';
import { getRecentCalls } from '../../usage/usage-recorder.js';

export function registerUsageIpc(): void {
  const { ipcMain } = require('electron');

  ipcMain.handle('usage:dashboard', async () => {
    return getDashboardStats();
  });

  ipcMain.handle('usage:provider-stats', async (_event, providerId: string) => {
    return getProviderStatistics(providerId as never);
  });

  ipcMain.handle('usage:daily-stats', async (_event, days?: number) => {
    return getDailyStats(days || 7);
  });

  ipcMain.handle('usage:recent-calls', async (_event, limit?: number) => {
    return getRecentCalls(limit || 100);
  });

  ipcMain.handle('gateway:status', async () => {
    return { running: true, port: 0 };
  });

  ipcMain.handle('gateway:port', async () => {
    return 0;
  });
}
