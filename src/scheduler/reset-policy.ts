/**
 * Quota window semantics per provider.
 *
 * The scheduler's `QuotaManager` starts a rolling 24h window on first use, which is a
 * sane default for unknown providers but wrong for the most common free tiers: Groq,
 * Cerebras, Gemini and friends reset their counters at UTC midnight. A user who checks
 * the provider console at 08:00 local (UTC+8) sees a fresh allowance while this app
 * still reports "0 requests left today" from a window that started 16 hours ago - and
 * that mismatch is exactly what destroys trust in the local quota panel.
 *
 * So the policy is data, per provider, and this module owns the *pure* part: given a
 * policy and a moment, when did the current window start, when does it end, and how
 * long until the next reset. Applying it to live counters lives in QuotaManager (its
 * file, its wiring); keeping the math here means the boundaries are testable without
 * touching scheduler state.
 *
 * Config: `quota-reset:<providerId>` -> 'rolling' (default) | 'utc-daily'.
 */

export type QuotaResetPolicy = 'rolling' | 'utc-daily';

export const QUOTA_RESET_PREFIX = 'quota-reset:';

export const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface ResetWindow {
  /** Inclusive start (ISO). Counters accumulated before this no longer count. */
  periodStart: string;
  /** Exclusive end (ISO). At this instant the window rolls. */
  periodEnd: string;
}

export function parseResetPolicy(raw: string | null | undefined): QuotaResetPolicy {
  return raw === 'utc-daily' ? 'utc-daily' : 'rolling';
}

export function resetPolicyKey(providerId: string): string {
  return `${QUOTA_RESET_PREFIX}${providerId}`;
}

function utcMidnight(ms: number): number {
  const day = Math.floor(ms / 86_400_000);
  return day * 86_400_000;
}

/**
 * Window containing `now`.
 *
 * - rolling: `[now, now + 24h)` — preserves the historical first-use semantics.
 * - utc-daily: `[UTC midnight, next UTC midnight)` — matches "resets at 0:00 UTC"
 *   free tiers, regardless of when the user started using the pool.
 */
export function windowFor(policy: QuotaResetPolicy, now: number = Date.now()): ResetWindow {
  if (policy === 'rolling') {
    return {
      periodStart: new Date(now).toISOString(),
      periodEnd: new Date(now + ROLLING_WINDOW_MS).toISOString(),
    };
  }
  const start = utcMidnight(now);
  return {
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(start + 86_400_000).toISOString(),
  };
}

/** When the *next* reset happens, for the panel's countdown. */
export function nextResetAt(policy: QuotaResetPolicy, now: number = Date.now()): string {
  return windowFor(policy, now).periodEnd;
}

/**
 * Milliseconds the given moment is past the window start; used to decide whether
 * persisted counters are still inside the live window (anything negative is stale).
 */
export function msIntoWindow(policy: QuotaResetPolicy, now: number = Date.now()): number {
  const start = Date.parse(windowFor(policy, now).periodStart);
  return now - start;
}

/**
 * True when a persisted period (start/end pair) is still the live window for this
 * policy. This is the predicate a counter store uses to decide "hydrate or discard".
 */
export function windowMatches(
  policy: QuotaResetPolicy,
  periodStart: string,
  periodEnd: string,
  now: number = Date.now()
): boolean {
  const live = windowFor(policy, now);
  // Exact comparison against the computed boundaries: a rolling window can never
  // match unless it was started at `now` itself, so counters saved by an older
  // rolling window are deliberately discarded when the policy switches to utc-daily.
  return periodStart === live.periodStart && periodEnd === live.periodEnd;
}

/**
 * One-line human hint for the UI. Kept terse on purpose: the panel renders it under
 * the quota bar, and a sentence there costs more attention than it buys.
 */
export function describeReset(policy: QuotaResetPolicy, now: number = Date.now()): string {
  if (policy === 'rolling') {
    return '滚动 24 小时窗口（从首次调用起算）';
  }
  const next = new Date(nextResetAt(policy, now));
  const hours = next.toISOString().slice(11, 16);
  return `每日重置（UTC 0 点，服务器时间 ${hours} 前有效）`;
}

/** Serialize/deserialize the per-provider setting value. */
export function encodeResetSetting(policy: QuotaResetPolicy): string {
  return policy;
}

export function normalizeResetSettingValue(value: unknown): QuotaResetPolicy | null {
  if (value === 'rolling' || value === 'utc-daily') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'rolling' || normalized === 'utc-daily') return normalized;
  }
  return null;
}
