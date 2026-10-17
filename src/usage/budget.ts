/**
 * Budget thresholds and breach evaluation for the free pool.
 *
 * Pure evaluation only: given a config and today's/month's usage numbers, decide the
 * level and which thresholds were crossed. Persisting the config, aggregating the
 * usage, and actually firing the notification are the caller's job — which keeps this
 * testable without a database and lets the notifier decide its own dedup policy via
 * `budgetNotificationKey`.
 *
 * Storage convention: the config lives in the profile-scoped settings as JSON under
 * `budget:<profileId>`; the caller passes a reader so tests need no database.
 */

export interface BudgetConfig {
  /** USD per UTC day; absent = no daily cost budget. */
  dailyCostUsd?: number;
  /** Tokens per UTC day; absent = no daily token budget. */
  dailyTokens?: number;
  /** USD per calendar month (UTC); absent = no monthly budget. */
  monthlyCostUsd?: number;
  /** Fraction of the limit where "warn" starts (default 0.8). */
  warnAtPercent?: number;
}

export interface BudgetUsage {
  costTodayUsd: number;
  tokensToday: number;
  costMonthUsd: number;
}

export type BudgetScope = 'daily-cost' | 'daily-tokens' | 'monthly-cost';

export interface BudgetBreach {
  scope: BudgetScope;
  used: number;
  limit: number;
  /** used/limit, capped at 1 for display but exact for comparison. */
  percent: number;
  level: 'warn' | 'exceeded';
}

export interface BudgetEvaluation {
  level: 'ok' | 'warn' | 'exceeded';
  breaches: BudgetBreach[];
}

export const BUDGET_DEFAULT_WARN_AT = 0.8;

function finitePositive(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

export function parseBudgetConfig(raw: string | null): BudgetConfig {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      dailyCostUsd: finitePositive(parsed.dailyCostUsd),
      dailyTokens: finitePositive(parsed.dailyTokens),
      monthlyCostUsd: finitePositive(parsed.monthlyCostUsd),
      warnAtPercent: finitePositive(parsed.warnAtPercent),
    };
  } catch {
    return {};
  }
}

function evaluateOne(
  scope: BudgetScope,
  used: number,
  limit: number,
  warnAt: number
): BudgetBreach | null {
  if (!(limit > 0)) return null;
  const percent = limit > 0 ? used / limit : 0;
  if (percent >= 1) return { scope, used, limit, percent, level: 'exceeded' };
  if (percent >= warnAt) return { scope, used, limit, percent, level: 'warn' };
  return null;
}

/** Worst level wins: exceeded > warn > ok. */
export function evaluateBudgets(
  config: BudgetConfig,
  usage: BudgetUsage
): BudgetEvaluation {
  const warnAt = config.warnAtPercent && config.warnAtPercent > 0 && config.warnAtPercent < 1
    ? config.warnAtPercent
    : BUDGET_DEFAULT_WARN_AT;

  const breaches: BudgetBreach[] = [];
  const cost = evaluateOne('daily-cost', usage.costTodayUsd, config.dailyCostUsd ?? 0, warnAt);
  if (cost) breaches.push(cost);
  const tokens = evaluateOne('daily-tokens', usage.tokensToday, config.dailyTokens ?? 0, warnAt);
  if (tokens) breaches.push(tokens);
  const month = evaluateOne('monthly-cost', usage.costMonthUsd, config.monthlyCostUsd ?? 0, warnAt);
  if (month) breaches.push(month);

  const level = breaches.some((b) => b.level === 'exceeded')
    ? 'exceeded'
    : breaches.length > 0
      ? 'warn'
      : 'ok';
  return { level, breaches };
}

/**
 * Stable dedup key for notifications: one alert per scope per period, so a dashboard
 * refresh loop cannot turn a budget breach into a notification storm. `null` when
 * there is nothing to announce. For daily scopes the key rolls over at UTC midnight
 * automatically, which is exactly the reset semantic the quotas use.
 */
export function budgetNotificationKey(
  breaches: BudgetBreach[],
  now: Date = new Date()
): string | null {
  if (breaches.length === 0) return null;
  const day = now.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const parts = breaches
    .map((breach) =>
      breach.scope === 'monthly-cost'
        ? `monthly-cost:${month}:${breach.level}`
        : `${breach.scope}:${day}:${breach.level}`
    )
    .sort();
  return parts.join('|');
}

/** UTC day/month buckets, exported so callers and tests agree on the boundaries. */
export function utcDayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function utcMonthIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
