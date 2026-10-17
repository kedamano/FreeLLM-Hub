import type {
  PersistedQuotaState,
  QuotaDelta,
  QuotaPersistence,
} from '../scheduler/quota-manager.js';
import { prepared } from '../core/database/statement-cache.js';
import { queueWrite, readDatabase } from './write-buffer.js';
import { DEFAULT_PROFILE_ID, getActiveProfileId } from '../core/settings/profile-store.js';

const ADD_QUOTA_SQL = `
  INSERT INTO quota_tracking
    (profile_id, provider_id, model_id, period_start, period_end, request_count, token_count, cost_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, provider_id, model_id, period_start) DO UPDATE SET
    period_end = excluded.period_end,
    request_count = quota_tracking.request_count + excluded.request_count,
    token_count = quota_tracking.token_count + excluded.token_count,
    cost_usd = quota_tracking.cost_usd + excluded.cost_usd
`;

const LOAD_QUOTA_SQL = `
  SELECT provider_id, model_id, period_start, period_end, request_count, token_count, cost_usd
  FROM quota_tracking
  WHERE period_end > ? AND profile_id = ?
`;

const SAVE_QUOTA_SQL = `
  INSERT INTO quota_tracking
    (profile_id, provider_id, model_id, period_start, period_end, request_count, token_count, cost_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(profile_id, provider_id, model_id, period_start) DO UPDATE SET
    period_end = excluded.period_end,
    request_count = excluded.request_count,
    token_count = excluded.token_count,
    cost_usd = excluded.cost_usd
`;

/**
 * SQLite-backed daily quota usage. Provider-level buckets store an empty
 * model_id so the composite primary key stays deterministic (NULL is not
 * unique in SQLite).
 *
 * Rows are namespaced by configuration profile: two profiles that both enable Groq
 * must not share one daily counter, otherwise switching pools would silently inherit
 * the other project's consumption. `profileId` is resolved lazily on every call so a
 * profile switch takes effect without rebuilding the manager.
 *
 * `add()` writes increments so a second process on the same database file (the desktop
 * window plus a `--web` run on other ports) accumulates into the shared window instead
 * of each one overwriting it with its own snapshot. SQLite's own concurrency handling
 * (WAL plus `busy_timeout`) covers the write contention.
 */
export function createQuotaPersistence(
  profileId: string | (() => string) = () => getActiveProfileId()
): QuotaPersistence {
  const resolve = (): string => {
    const value = typeof profileId === 'function' ? profileId() : profileId;
    return value && value.trim() ? value : DEFAULT_PROFILE_ID;
  };

  return {
    load(): PersistedQuotaState[] {
      const db = readDatabase();
      const rows = prepared(db, LOAD_QUOTA_SQL).all(new Date().toISOString(), resolve()) as Array<{
        provider_id: string;
        model_id: string | null;
        period_start: string;
        period_end: string;
        request_count: number;
        token_count: number;
        cost_usd: number | null;
      }>;

      return rows.map((row) => ({
        providerId: row.provider_id,
        modelId: row.model_id || undefined,
        requestCount: row.request_count,
        tokenCount: row.token_count,
        costUsd: Number(row.cost_usd ?? 0),
        periodStart: row.period_start,
        periodEnd: row.period_end,
      }));
    },

    add(delta: QuotaDelta): void {
      const profileId = resolve();
      queueWrite((db) =>
        prepared(db, ADD_QUOTA_SQL).run(
          profileId,
          delta.providerId,
          delta.modelId ?? '',
          delta.periodStart,
          delta.periodEnd,
          delta.requests,
          delta.tokens,
          delta.costUsd
        )
      );
    },

    save(state: PersistedQuotaState): void {
      const profileId = resolve();
      queueWrite((db) =>
        prepared(db, SAVE_QUOTA_SQL).run(
          profileId,
          state.providerId,
          state.modelId ?? '',
          state.periodStart,
          state.periodEnd,
          state.requestCount,
          state.tokenCount,
          state.costUsd ?? 0
        )
      );
    },
  };
}

/** Usage rows for one provider across profiles, for the quota trend chart. */
export function listQuotaWindows(profileId?: string): Array<{
  profileId: string;
  providerId: string;
  modelId: string;
  periodStart: string;
  periodEnd: string;
  requestCount: number;
  tokenCount: number;
  costUsd: number;
}> {
  const db = readDatabase();
  const rows = (
    profileId
      ? db.prepare('SELECT * FROM quota_tracking WHERE profile_id = ? ORDER BY period_start DESC').all(profileId)
      : db.prepare('SELECT * FROM quota_tracking ORDER BY period_start DESC').all()
  ) as Array<{
    profile_id: string;
    provider_id: string;
    model_id: string;
    period_start: string;
    period_end: string;
    request_count: number;
    token_count: number;
    cost_usd: number | null;
  }>;

  return rows.map((row) => ({
    profileId: row.profile_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    requestCount: row.request_count,
    tokenCount: row.token_count,
    costUsd: Number(row.cost_usd ?? 0),
  }));
}
