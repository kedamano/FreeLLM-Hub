import { describe, it, expect } from 'vitest';
import {
  budgetNotificationKey,
  evaluateBudgets,
  parseBudgetConfig,
  utcDayIso,
  utcMonthIso,
  type BudgetUsage,
} from '../../src/usage/budget';

const usage = (over: Partial<BudgetUsage> = {}): BudgetUsage => ({
  costTodayUsd: 0,
  tokensToday: 0,
  costMonthUsd: 0,
  ...over,
});

describe('budget config parsing', () => {
  it('accepts a partial config and ignores junk', () => {
    expect(parseBudgetConfig(null)).toEqual({});
    expect(parseBudgetConfig('not json')).toEqual({});
    expect(
      parseBudgetConfig('{"dailyCostUsd":5,"dailyTokens":-3,"monthlyCostUsd":"x","warnAtPercent":0.7}')
    ).toEqual({ dailyCostUsd: 5, warnAtPercent: 0.7 });
  });

  it('rejects zero and negative limits: a 0 budget would block everything', () => {
    expect(parseBudgetConfig('{"dailyCostUsd":0}')).toEqual({});
  });
});

describe('budget evaluation', () => {
  it('is ok when nothing is configured', () => {
    expect(evaluateBudgets({}, usage({ costTodayUsd: 99 }))).toEqual({
      level: 'ok',
      breaches: [],
    });
  });

  it('stays ok below the warn threshold', () => {
    const out = evaluateBudgets({ dailyCostUsd: 10 }, usage({ costTodayUsd: 7.9 }));
    expect(out.level).toBe('ok');
  });

  it('warns at 80 percent by default and exceeds at the limit', () => {
    const warn = evaluateBudgets({ dailyCostUsd: 10 }, usage({ costTodayUsd: 8 }));
    expect(warn.level).toBe('warn');
    expect(warn.breaches[0]).toMatchObject({ scope: 'daily-cost', level: 'warn', percent: 0.8 });

    const over = evaluateBudgets({ dailyCostUsd: 10 }, usage({ costTodayUsd: 11 }));
    expect(over.level).toBe('exceeded');
    expect(over.breaches[0]).toMatchObject({ scope: 'daily-cost', level: 'exceeded' });
  });

  it('honours a custom warn threshold', () => {
    const out = evaluateBudgets({ dailyTokens: 1000, warnAtPercent: 0.5 }, usage({ tokensToday: 600 }));
    expect(out.level).toBe('warn');
    expect(out.breaches[0].percent).toBeCloseTo(0.6, 6);
  });

  it('evaluates every configured scope and escalates to exceeded', () => {
    const out = evaluateBudgets(
      { dailyCostUsd: 1, dailyTokens: 100, monthlyCostUsd: 5 },
      usage({ costTodayUsd: 2, tokensToday: 150, costMonthUsd: 4 })
    );
    expect(out.level).toBe('exceeded');
    expect(out.breaches.map((b) => b.scope)).toEqual(['daily-cost', 'daily-tokens', 'monthly-cost']);
    expect(out.breaches.find((b) => b.scope === 'monthly-cost')?.level).toBe('warn');
    expect(out.breaches.find((b) => b.scope === 'monthly-cost')?.percent).toBeCloseTo(0.8, 6);
  });

  it('treats a missing usage number as zero rather than NaN', () => {
    const out = evaluateBudgets({ dailyCostUsd: 1 }, {
      costTodayUsd: Number.NaN,
      tokensToday: Number.NaN,
      costMonthUsd: Number.NaN,
    });
    expect(out.level).toBe('ok');
  });
});

describe('notification dedup key', () => {
  const day = utcDayIso(new Date('2026-10-17T09:00:00Z'));
  const month = utcMonthIso(new Date('2026-10-17T09:00:00Z'));

  it('is null when there is nothing to announce', () => {
    expect(budgetNotificationKey([])).toBeNull();
  });

  it('rolls over with the UTC day so yesterday\u2019s alert cannot mute today\u2019s', () => {
    const breaches = evaluateBudgets({ dailyCostUsd: 1 }, usage({ costTodayUsd: 2 })).breaches;
    const early = budgetNotificationKey(breaches, new Date('2026-10-16T23:59:00Z'));
    const late = budgetNotificationKey(breaches, new Date('2026-10-17T00:01:00Z'));
    expect(early).toContain('2026-10-16');
    expect(late).toContain('2026-10-17');
    expect(early).not.toBe(late);
  });

  it('pins monthly scopes to the month, daily scopes to the day', () => {
    const breaches = [
      { scope: 'daily-cost' as const, used: 2, limit: 1, percent: 2, level: 'exceeded' as const },
      { scope: 'monthly-cost' as const, used: 9, limit: 5, percent: 1.8, level: 'exceeded' as const },
    ];
    const key = budgetNotificationKey(breaches, new Date('2026-10-17T09:00:00Z'));
    expect(key).toBe(`daily-cost:${day}:exceeded|monthly-cost:${month}:exceeded`);
  });

  it('changes when the level escalates, so warn never mutes exceeded', () => {
    const warn = [{ scope: 'daily-tokens' as const, used: 850, limit: 1000, percent: 0.85, level: 'warn' as const }];
    const exceeded = [{ scope: 'daily-tokens' as const, used: 1200, limit: 1000, percent: 1.2, level: 'exceeded' as const }];
    const now = new Date('2026-10-17T09:00:00Z');
    expect(budgetNotificationKey(warn, now)).not.toBe(budgetNotificationKey(exceeded, now));
  });
});
