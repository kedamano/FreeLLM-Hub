import { getDatabase } from '../core/database/database.js';
import {
  evaluateBudgets,
  budgetNotificationKey,
  parseBudgetConfig,
  utcDayIso,
  type BudgetEvaluation,
  type BudgetConfig,
} from './budget.js';
import { notify as systemNotify } from '../main/services/update-service.js';

/**
 * Budget wiring: reads the profile-scoped budget config, aggregates today's/month's
 * usage from `call_logs`, evaluates thresholds, and notifies once per period.
 *
 * The dedup key persists in the profile-scoped settings (`budget:last-notify`), so a
 * refresh loop or an app restart cannot re-announce the same breach - and because the
 * key embeds the UTC day/month, the mute lifts automatically at the next period.
 *
 * Settings shape (`budget:<profileId>` JSON): see parseBudgetConfig.
 */

export const BUDGET_CONFIG_PREFIX = 'budget:';
export const BUDGET_LAST_NOTIFY_KEY = 'budget:last-notify';
export const DEFAULT_BUDGET_CHECK_INTERVAL_MS = 60_000;

interface SettingsLike {
  readSetting: (key: string) => string | null;
  writeSetting: (key: string, value: string) => void;
}

export function budgetConfigKey(profileId: string): string {
  return `${BUDGET_CONFIG_PREFIX}${profileId}`;
}

export function readBudgetConfig(
  profileId: string,
  settings: SettingsLike
): BudgetConfig {
  return parseBudgetConfig(settings.readSetting(budgetConfigKey(profileId)));
}

/** UTC-day/month aggregates straight off the ledger, scoped to one profile. */
export function getBudgetUsage(
  profileId: string,
  now: Date = new Date()
): { costTodayUsd: number; tokensToday: number; costMonthUsd: number } {
  const db = getDatabase();
  const dayStart = `${utcDayIso(now)}T00:00:00.000Z`;
  const monthStart = `${utcDayIso(now).slice(0, 7)}-01T00:00:00.000Z`;

  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN timestamp >= ? THEN cost_usd ELSE 0 END), 0) as cost_today,
         COALESCE(SUM(CASE WHEN timestamp >= ? THEN prompt_tokens + completion_tokens ELSE 0 END), 0) as tokens_today,
         COALESCE(SUM(cost_usd), 0) as cost_month
       FROM call_logs
       WHERE COALESCE(profile_id, 'default') = ? AND timestamp >= ?`
    )
    .get(dayStart, dayStart, profileId, monthStart) as {
    cost_today: number;
    tokens_today: number;
    cost_month: number;
  };

  return {
    costTodayUsd: Number(row?.cost_today ?? 0),
    tokensToday: Number(row?.tokens_today ?? 0),
    costMonthUsd: Number(row?.cost_month ?? 0),
  };
}

export function checkBudgets(
  profileId: string,
  settings: SettingsLike,
  now: Date = new Date()
): BudgetEvaluation {
  const config = readBudgetConfig(profileId, settings);
  const usage = getBudgetUsage(profileId, now);
  const evaluation = evaluateBudgets(config, usage);

  const key = budgetNotificationKey(evaluation.breaches, now);
  const lastKey = settings.readSetting(BUDGET_LAST_NOTIFY_KEY);
  if (key && key !== lastKey) {
    const worst = evaluation.breaches.find((b) => b.level === 'exceeded') ?? evaluation.breaches[0];
    const label: Record<string, string> = {
      'daily-cost': '今日成本',
      'daily-tokens': '今日 token 用量',
      'monthly-cost': '本月成本',
    };
    const scope = label[worst.scope] ?? worst.scope;
    const percent = Math.round(worst.percent * 100);
    const title = worst.level === 'exceeded' ? '预算已超限' : '预算接近上限';
    systemNotify(
      title,
      `${scope} 已达 ${percent}%（${worst.used.toLocaleString('en-US')} / ${worst.limit.toLocaleString('en-US')}）`
    );
    settings.writeSetting(BUDGET_LAST_NOTIFY_KEY, key);
  }

  return evaluation;
}

/** Periodic budget sweep. Returns a dispose function for shutdown paths. */
export function startBudgetChecks(
  profileId: string | (() => string),
  settings: SettingsLike,
  intervalMs: number = DEFAULT_BUDGET_CHECK_INTERVAL_MS
): () => void {
  const resolve = () => (typeof profileId === 'function' ? profileId() : profileId);
  const timer = setInterval(() => {
    try {
      checkBudgets(resolve(), settings);
    } catch (err) {
      // A budget sweep must never take the gateway down with it.
      console.warn('[Budget] 预算检查失败:', err instanceof Error ? err.message : String(err));
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
