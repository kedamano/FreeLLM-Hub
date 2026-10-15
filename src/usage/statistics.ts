import { getDatabase } from '../core/database/database.js';
import type { DashboardStats, ProviderUsageStat, ProviderId } from '../shared/types/index.js';

export function getDashboardStats(): DashboardStats {
  const db = getDatabase();

  const totalRow = db
    .prepare('SELECT COUNT(*) as count FROM call_logs')
    .get() as { count: number };

  const successRow = db
    .prepare("SELECT COUNT(*) as count FROM call_logs WHERE status = 'success'")
    .get() as { count: number };

  const tokenRow = db
    .prepare(
      'SELECT COALESCE(SUM(prompt_tokens), 0) as prompt, COALESCE(SUM(completion_tokens), 0) as completion FROM call_logs'
    )
    .get() as { prompt: number; completion: number };

  const statusRows = db
    .prepare(
      'SELECT provider_id, COUNT(*) as total, SUM(CASE WHEN status = \'success\' THEN 1 ELSE 0 END) as success FROM call_logs GROUP BY provider_id'
    )
    .all() as Array<{ provider_id: string; total: number; success: number }>;

  const recentRows = db
    .prepare('SELECT * FROM call_logs ORDER BY timestamp DESC LIMIT 20')
    .all() as Array<{
      id: string;
      request_id: string;
      timestamp: string;
      provider_id: string;
      model_id: string;
      task_type: string | null;
      status: string;
      duration_ms: number;
      prompt_tokens: number;
      completion_tokens: number;
      error_message: string | null;
    }>;

  const totalRequests = totalRow.count;
  const successRate = totalRequests > 0 ? successRow.count / totalRequests : 0;

  const providerStats: ProviderUsageStat[] = statusRows.map((row) => ({
    providerId: row.provider_id as ProviderId,
    providerName: row.provider_id,
    requestCount: row.total,
    tokenCount: 0,
    successCount: row.success,
    errorCount: row.total - row.success,
  }));

  return {
    totalRequests,
    successRate,
    totalTokensUsed: tokenRow.prompt + tokenRow.completion,
    totalCostSaved: 0,
    activeProviders: providerStats.length,
    availableModels: 0,
    recentCalls: recentRows.map((r) => ({
      id: r.id,
      requestId: r.request_id,
      timestamp: r.timestamp,
      providerId: r.provider_id as ProviderId,
      modelId: r.model_id,
      taskType: r.task_type as never,
      status: r.status as never,
      durationMs: r.duration_ms,
      promptTokens: r.prompt_tokens,
      completionTokens: r.completion_tokens,
      errorMessage: r.error_message || undefined,
    })),
    providerStats,
  };
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
