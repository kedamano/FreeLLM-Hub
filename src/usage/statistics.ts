import { getDatabase } from '../core/database/database.js';
import { mapCallLogRow, type CallLogRow } from './usage-recorder.js';
import type { DashboardStats, ProviderUsageStat, ProviderId } from '../shared/types/index.js';

export interface ProviderHealth {
  providerId: ProviderId;
  successRate: number;
  avgLatencyMs: number;
}

export function getDashboardStats(): DashboardStats {
  const db = getDatabase();

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) as tokens
       FROM call_logs`
    )
    .get() as { total: number; success: number | null; tokens: number };

  const statusRows = db
    .prepare(
      `SELECT provider_id,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) as tokens,
              AVG(duration_ms) as avg_duration
       FROM call_logs GROUP BY provider_id`
    )
    .all() as Array<{
      provider_id: string;
      total: number;
      success: number | null;
      tokens: number | null;
      avg_duration: number | null;
    }>;

  const recentRows = db
    .prepare('SELECT * FROM call_logs ORDER BY timestamp DESC LIMIT 20')
    .all() as CallLogRow[];

  const totalRequests = totalsRow.total;
  const successRate = totalRequests > 0 ? (totalsRow.success || 0) / totalRequests : 0;

  const providerStats: ProviderUsageStat[] = statusRows.map((row) => ({
    providerId: row.provider_id as ProviderId,
    providerName: row.provider_id,
    requestCount: row.total,
    tokenCount: row.tokens || 0,
    successCount: row.success || 0,
    errorCount: row.total - (row.success || 0),
  }));

  return {
    totalRequests,
    successRate,
    totalTokensUsed: totalsRow.tokens,
    totalCostSaved: 0,
    activeProviders: providerStats.length,
    availableModels: 0,
    recentCalls: recentRows.map(mapCallLogRow),
    providerStats,
  };
}

export function getProviderHealth(limit: number = 200): ProviderHealth[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT provider_id,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              AVG(duration_ms) as avg_duration
       FROM (SELECT provider_id, status, duration_ms FROM call_logs ORDER BY timestamp DESC LIMIT ?)
       GROUP BY provider_id`
    )
    .all(limit) as Array<{
      provider_id: string;
      total: number;
      success: number | null;
      avg_duration: number | null;
    }>;

  return rows.map((row) => ({
    providerId: row.provider_id as ProviderId,
    successRate: row.total > 0 ? (row.success || 0) / row.total : 0,
    avgLatencyMs: row.avg_duration || 0,
  }));
}

export function getProviderStatistics(providerId: ProviderId): ProviderUsageStat {
  const db = getDatabase();
  const row = db
    .prepare(
      'SELECT COUNT(*) as total, SUM(CASE WHEN status = \'success\' THEN 1 ELSE 0 END) as success, SUM(prompt_tokens) + SUM(completion_tokens) as tokens FROM call_logs WHERE provider_id = ?'
    )
    .get(providerId) as { total: number; success: number; tokens: number };

  return {
    providerId,
    providerName: providerId,
    requestCount: row.total,
    tokenCount: row.tokens || 0,
    successCount: row.success,
    errorCount: row.total - row.success,
  };
}

export function getDailyStats(days: number = 7): Array<{
  date: string;
  requests: number;
  tokens: number;
  successRate: number;
}> {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT
        date(timestamp) as date,
        COUNT(*) as requests,
        SUM(prompt_tokens) + SUM(completion_tokens) as tokens,
        AVG(CASE WHEN status = 'success' THEN 1.0 ELSE 0.0 END) as success_rate
      FROM call_logs
      WHERE timestamp >= datetime('now', '-' || ? || ' days')
      GROUP BY date(timestamp)
      ORDER BY date DESC`
    )
    .all(days) as Array<{ date: string; requests: number; tokens: number; success_rate: number }>;

  return rows.map((r) => ({
    date: r.date,
    requests: r.requests,
    tokens: r.tokens || 0,
    successRate: r.success_rate || 0,
  }));
}
