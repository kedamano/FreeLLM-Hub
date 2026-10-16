import { getDatabase } from '../core/database/database.js';
import { mapCallLogRow, type CallLogRow } from './usage-recorder.js';
import { getActiveProfileId, profileKeyStore } from '../core/settings/profile-store.js';
import { readQuota, type QuotaInput } from '../scheduler/quota-settings.js';
import type {
  DashboardStats,
  ModelPricingType,
  ProviderUsageStat,
  ProviderId,
} from '../shared/types/index.js';

import type {
  CostSeriesPoint,
  CostSummary,
  ProviderDailyPoint,
  ProviderQuotaUsage,
} from '../shared/types/observability.js';

// The renderer may only import types from `src/shared`; these re-exports keep the
// producer and the UI contract pinned to one declaration.
export type {
  CostSeriesPoint,
  CostSummary,
  ProviderDailyPoint,
  ProviderQuotaUsage,
} from '../shared/types/observability.js';

export interface ProviderHealth {
  providerId: ProviderId;
  successRate: number;
  avgLatencyMs: number;
}

/** Scope helper: rows written before profiles existed belong to `default`. */
const PROFILE_MATCH = "COALESCE(profile_id, 'default') = ?";

function scopeSql(extra: string[] = []): string {
  return extra.length > 0 ? ` WHERE ${extra.join(' AND ')}` : '';
}

export function getDashboardStats(profileId: string = getActiveProfileId()): DashboardStats {
  const db = getDatabase();

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved
       FROM call_logs ${PROFILE_MATCH}`
    )
    .get(profileId) as {
    total: number;
    success: number | null;
    tokens: number;
    cost: number;
    saved: number;
  };

  const statusRows = db
    .prepare(
      `SELECT provider_id,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) as tokens,
              AVG(duration_ms) as avg_duration,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved
       FROM call_logs ${PROFILE_MATCH} GROUP BY provider_id`
    )
    .all(profileId) as Array<{
      provider_id: string;
      total: number;
      success: number | null;
      tokens: number | null;
      avg_duration: number | null;
      cost: number;
      saved: number;
    }>;

  const recentRows = db
    .prepare(`SELECT * FROM call_logs WHERE ${PROFILE_MATCH} ORDER BY timestamp DESC LIMIT 20`)
    .all(profileId) as CallLogRow[];

  const availableModels = db
    .prepare(
      `SELECT COUNT(*) as count FROM models
       WHERE status = 'available' AND provider_id IN (SELECT id FROM providers WHERE is_enabled = 1)`
    )
    .get() as { count: number };

  const totalRequests = totalsRow.total;
  const successRate = totalRequests > 0 ? (totalsRow.success || 0) / totalRequests : 0;

  const providerStats: ProviderUsageStat[] = statusRows.map((row) => ({
    providerId: row.provider_id as ProviderId,
    providerName: row.provider_id,
    requestCount: row.total,
    tokenCount: row.tokens || 0,
    successCount: row.success || 0,
    errorCount: row.total - (row.success || 0),
    avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
    costUsd: Number(row.cost ?? 0),
    savedCostUsd: Number(row.saved ?? 0),
  }));

  return {
    totalRequests,
    successRate,
    totalTokensUsed: totalsRow.tokens,
    totalCostUsd: Number(totalsRow.cost ?? 0),
    totalCostSaved: Number(totalsRow.saved ?? 0),
    activeProviders: providerStats.length,
    availableModels: availableModels.count,
    recentCalls: recentRows.map(mapCallLogRow),
    providerStats,
  };
}

export function getProviderHealth(
  limit: number = 200,
  profileId: string = getActiveProfileId()
): ProviderHealth[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT provider_id,
              COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              AVG(duration_ms) as avg_duration
       FROM (SELECT provider_id, status, duration_ms FROM call_logs WHERE ${PROFILE_MATCH} ORDER BY timestamp DESC LIMIT ?)
       GROUP BY provider_id`
    )
    .all(profileId, limit) as Array<{
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

export function getProviderStatistics(
  providerId: ProviderId,
  profileId: string = getActiveProfileId()
): ProviderUsageStat {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved,
              AVG(duration_ms) as avg_duration
       FROM call_logs WHERE provider_id = ? AND ${PROFILE_MATCH}`
    )
    .get(providerId, profileId) as {
      total: number;
      success: number | null;
      tokens: number;
      cost: number;
      saved: number;
      avg_duration: number | null;
    };

  return {
    providerId,
    providerName: providerId,
    requestCount: row.total,
    tokenCount: row.tokens || 0,
    successCount: row.success ?? 0,
    errorCount: row.total - (row.success ?? 0),
    costUsd: Number(row.cost ?? 0),
    savedCostUsd: Number(row.saved ?? 0),
    avgDurationMs: Math.round(Number(row.avg_duration ?? 0)),
  };
}

export function getDailyStats(days: number = 7, profileId: string = getActiveProfileId()): Array<{
  date: string;
  requests: number;
  tokens: number;
  successRate: number;
}> {
  const db = getDatabase();
  // call_logs.timestamp stores ISO-8601 strings; comparing them against
  // datetime('now') output ('YYYY-MM-DD HH:MM:SS') mis-orders the boundary day.
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT
        date(timestamp) as date,
        COUNT(*) as requests,
        SUM(prompt_tokens) + SUM(completion_tokens) as tokens,
        AVG(CASE WHEN status = 'success' THEN 1.0 ELSE 0.0 END) as success_rate
      FROM call_logs
      WHERE timestamp >= ? AND ${PROFILE_MATCH}
      GROUP BY date(timestamp)
      ORDER BY date DESC`
    )
    .all(cutoff, profileId) as Array<{ date: string; requests: number; tokens: number; success_rate: number }>;

  return rows.map((r) => ({
    date: r.date,
    requests: r.requests,
    tokens: r.tokens || 0,
    successRate: r.success_rate || 0,
  }));
}

/**
 * Cost/usage roll-up for the visualisation panel. Everything is derived from
 * `call_logs`, which now carries the per-call cost columns, so there is no
 * separate rollup job to drift out of sync.
 */
export function getCostSummary(options: { days?: number; profileId?: string } = {}): CostSummary {
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const profileId = options.profileId ?? getActiveProfileId();
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const where = scopeSql(['timestamp >= ?', PROFILE_MATCH]);

  const totals = db
    .prepare(
      `SELECT COUNT(*) as requests,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
              COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) as completion_tokens,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(reference_cost_usd), 0) as reference_cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved
       FROM call_logs${where}`
    )
    .get(cutoff, profileId) as {
    requests: number;
    successful: number | null;
    prompt_tokens: number;
    completion_tokens: number;
    cost: number;
    reference_cost: number;
    saved: number;
  };

  const byProvider = (
    db
      .prepare(
        `SELECT provider_id,
                COUNT(*) as requests,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost,
                COALESCE(SUM(saved_cost_usd), 0) as saved
         FROM call_logs${where}
         GROUP BY provider_id ORDER BY tokens DESC LIMIT 30`
      )
      .all(cutoff, profileId) as Array<{
        provider_id: string;
        requests: number;
        tokens: number;
        cost: number;
        saved: number;
      }>
  ).map((row) => ({
    providerId: row.provider_id as ProviderId,
    requests: row.requests,
    tokens: Number(row.tokens ?? 0),
    costUsd: Number(row.cost ?? 0),
    savedCostUsd: Number(row.saved ?? 0),
    share: totals.prompt_tokens + totals.completion_tokens > 0
      ? Number(row.tokens ?? 0) / (totals.prompt_tokens + totals.completion_tokens)
      : 0,
  }));

  const byModel = (
    db
      .prepare(
        `SELECT provider_id, model_id,
                COUNT(*) as requests,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost,
                COALESCE(SUM(saved_cost_usd), 0) as saved,
                MAX(pricing_type) as pricing_type
         FROM call_logs${where}
         GROUP BY provider_id, model_id ORDER BY tokens DESC LIMIT 40`
      )
      .all(cutoff, profileId) as Array<{
        provider_id: string;
        model_id: string;
        requests: number;
        tokens: number;
        cost: number;
        saved: number;
        pricing_type: string | null;
      }>
  ).map((row) => ({
    providerId: row.provider_id as ProviderId,
    modelId: row.model_id,
    requests: row.requests,
    tokens: Number(row.tokens ?? 0),
    costUsd: Number(row.cost ?? 0),
    savedCostUsd: Number(row.saved ?? 0),
    pricingType: (row.pricing_type ?? null) as ModelPricingType | null,
  }));

  const byTaskType = (
    db
      .prepare(
        `SELECT COALESCE(task_type, 'unspecified') as task_type,
                COUNT(*) as requests,
                COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
                COALESCE(SUM(cost_usd), 0) as cost
         FROM call_logs${where}
         GROUP BY task_type ORDER BY requests DESC`
      )
      .all(cutoff, profileId) as Array<{ task_type: string; requests: number; tokens: number; cost: number }>
  ).map((row) => ({
    taskType: row.task_type,
    requests: row.requests,
    tokens: Number(row.tokens ?? 0),
    costUsd: Number(row.cost ?? 0),
  }));

  const seriesRows = db
    .prepare(
      `SELECT date(timestamp) as date,
              COUNT(*) as requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved
       FROM call_logs${where}
       GROUP BY date(timestamp) ORDER BY date ASC`
    )
    .all(cutoff, profileId) as Array<{
    date: string;
    requests: number;
    tokens: number;
    cost: number;
    saved: number;
  }>;

  const series: CostSeriesPoint[] = fillMissingDays(seriesRows.map((row) => ({
    date: row.date,
    requests: row.requests,
    tokens: Number(row.tokens ?? 0),
    costUsd: Number(row.cost ?? 0),
    savedCostUsd: Number(row.saved ?? 0),
  })), days);

  const tokens = totals.prompt_tokens + totals.completion_tokens;

  return {
    windowDays: days,
    profileId,
    requests: totals.requests,
    successfulRequests: Number(totals.successful ?? 0),
    tokens,
    promptTokens: totals.prompt_tokens,
    completionTokens: totals.completion_tokens,
    costUsd: Number(totals.cost ?? 0),
    referenceCostUsd: Number(totals.reference_cost ?? 0),
    savedCostUsd: Number(totals.saved ?? 0),
    savedRate: totals.reference_cost > 0 ? Number(totals.saved ?? 0) / Number(totals.reference_cost) : 0,
    currency: 'USD',
    byProvider,
    byModel,
    byTaskType,
    series,
  };
}

/** Dense the series so a chart's x-axis keeps every day in the window. */
function fillMissingDays(points: CostSeriesPoint[], days: number): CostSeriesPoint[] {
  if (days > 180) return points;
  const byDate = new Map(points.map((point) => [point.date, point]));
  const result: CostSeriesPoint[] = [];
  const today = new Date();
  for (let offset = days - 1; offset >= 0; offset--) {
    const date = new Date(today.getTime() - offset * 24 * 60 * 60 * 1000);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}`;
    result.push(byDate.get(iso) ?? { date: iso, requests: 0, tokens: 0, costUsd: 0, savedCostUsd: 0 });
  }
  return result;
}

/**
 * Per-provider daily quota position for the current profile: the configured limit
 * from the profile-scoped settings, the live usage window from `quota_tracking`,
 * and today's cost contribution from `call_logs`.
 */
export function getProviderQuotaUsage(
  profileId: string = getActiveProfileId(),
  providerIds?: string[]
): ProviderQuotaUsage[] {
  const db = getDatabase();
  const store = profileKeyStore(profileId);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const ids = new Set<string>(providerIds ?? []);
  for (const row of db
    .prepare(`SELECT DISTINCT provider_id FROM quota_tracking WHERE ${PROFILE_MATCH}`)
    .all(profileId) as Array<{ provider_id: string }>) {
    ids.add(row.provider_id);
  }
  for (const row of db
    .prepare(`SELECT DISTINCT provider_id FROM call_logs WHERE ${PROFILE_MATCH}`)
    .all(profileId) as Array<{ provider_id: string }>) {
    ids.add(row.provider_id);
  }
  // Configured quotas live under `provider-quota:<id>` keys; enumerate them from
  // the settings table so a provider with a limit but no traffic still shows up.
  const quotaPrefix = 'provider-quota:';
  const namespaced =
    profileId === 'default' ? quotaPrefix : `profile:${profileId}:${quotaPrefix}`;
  for (const row of db.prepare('SELECT key FROM settings WHERE key LIKE ?').all(`${namespaced}%`) as Array<{
    key: string;
  }>) {
    const id = row.key.slice(namespaced.length);
    if (id) ids.add(id);
  }

  const usageRows = db
    .prepare(
      `SELECT provider_id,
              SUM(request_count) as requests,
              SUM(token_count) as tokens,
              MIN(period_start) as period_start,
              MAX(period_end) as period_end
       FROM quota_tracking
       WHERE ${PROFILE_MATCH} AND period_end > ?
       GROUP BY provider_id`
    )
    .all(profileId, new Date().toISOString()) as Array<{
    provider_id: string;
    requests: number | null;
    tokens: number | null;
    period_start: string | null;
    period_end: string | null;
  }>;
  const usageByProvider = new Map(usageRows.map((row) => [row.provider_id, row]));

  const costRows = db
    .prepare(
      `SELECT provider_id,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved
       FROM call_logs WHERE ${PROFILE_MATCH} AND timestamp >= ?
       GROUP BY provider_id`
    )
    .all(profileId, todayIso) as Array<{ provider_id: string; cost: number; saved: number }>;
  const costByProvider = new Map(costRows.map((row) => [row.provider_id, row]));

  const result: ProviderQuotaUsage[] = [];
  for (const providerId of [...ids].sort()) {
    if (!providerId || providerId === 'unknown') continue;
    const limit: QuotaInput | undefined = readQuota(providerId, (key) => store.get(key));
    const usage = usageByProvider.get(providerId);
    const cost = costByProvider.get(providerId);
    const usedRequests = Number(usage?.requests ?? 0);
    const usedTokens = Number(usage?.tokens ?? 0);
    const limitRequests = limit?.maxRequestsPerDay ?? null;
    const limitTokens = limit?.maxTokensPerDay ?? null;

    result.push({
      providerId: providerId as ProviderId,
      profileId,
      limitRequests,
      limitTokens,
      usedRequests,
      usedTokens,
      remainingRequests: limitRequests === null ? null : Math.max(0, limitRequests - usedRequests),
      remainingTokens: limitTokens === null ? null : Math.max(0, limitTokens - usedTokens),
      requestUsageRate: limitRequests && limitRequests > 0 ? usedRequests / limitRequests : null,
      tokenUsageRate: limitTokens && limitTokens > 0 ? usedTokens / limitTokens : null,
      periodStart: usage?.period_start ?? null,
      periodEnd: usage?.period_end ?? null,
      todayCostUsd: Number(cost?.cost ?? 0),
      todaySavedUsd: Number(cost?.saved ?? 0),
      unbounded: limitRequests === null && limitTokens === null,
    });
  }

  return result;
}

/** Stacked-series source: one row per (day, provider) inside the window. */
export function getDailyStatsByProvider(
  days: number = 14,
  profileId: string = getActiveProfileId()
): ProviderDailyPoint[] {
  const db = getDatabase();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT date(timestamp) as date, provider_id,
              COUNT(*) as requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost
       FROM call_logs WHERE ${PROFILE_MATCH} AND timestamp >= ?
       GROUP BY date(timestamp), provider_id
       ORDER BY date ASC`
    )
    .all(profileId, cutoff) as Array<{
    date: string;
    provider_id: string;
    requests: number;
    tokens: number;
    cost: number;
  }>;

  return rows.map((row) => ({
    date: row.date,
    providerId: row.provider_id as ProviderId,
    requests: row.requests,
    tokens: Number(row.tokens ?? 0),
    costUsd: Number(row.cost ?? 0),
  }));
}
