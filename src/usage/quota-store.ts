import { getDatabase } from '../core/database/database.js';
import type { PersistedQuotaState, QuotaPersistence } from '../scheduler/quota-manager.js';

/**
 * SQLite-backed daily quota usage. Provider-level buckets store an empty
 * model_id so the composite primary key stays deterministic (NULL is not
 * unique in SQLite).
 */
export function createQuotaPersistence(): QuotaPersistence {
  return {
    load(): PersistedQuotaState[] {
      const rows = getDatabase()
        .prepare(
          `SELECT provider_id, model_id, period_start, period_end, request_count, token_count
           FROM quota_tracking
           WHERE period_end > ?`
        )
        .all(new Date().toISOString()) as Array<{
        provider_id: string;
        model_id: string | null;
        period_start: string;
        period_end: string;
        request_count: number;
        token_count: number;
      }>;

      return rows.map((row) => ({
        providerId: row.provider_id,
        modelId: row.model_id || undefined,
        requestCount: row.request_count,
        tokenCount: row.token_count,
        periodStart: row.period_start,
        periodEnd: row.period_end,
      }));
    },

    save(state: PersistedQuotaState): void {
      getDatabase()
        .prepare(
          `INSERT INTO quota_tracking
             (provider_id, model_id, period_start, period_end, request_count, token_count)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider_id, model_id, period_start) DO UPDATE SET
             period_end = excluded.period_end,
             request_count = excluded.request_count,
             token_count = excluded.token_count`
        )
        .run(
          state.providerId,
          state.modelId ?? '',
          state.periodStart,
          state.periodEnd,
          state.requestCount,
          state.tokenCount
        );
    },
  };
}
