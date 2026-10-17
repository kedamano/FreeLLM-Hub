import { describe, it, expect } from 'vitest';
import {
  describeReset,
  encodeResetSetting,
  msIntoWindow,
  nextResetAt,
  normalizeResetSettingValue,
  parseResetPolicy,
  resetPolicyKey,
  windowFor,
  windowMatches,
} from '../../src/scheduler/reset-policy';

// A fixed moment with clean UTC arithmetic: 2026-10-17T08:00:00Z.
const NOW = Date.parse('2026-10-17T08:00:00.000Z');

describe('policy parsing', () => {
  it('defaults to rolling for anything unknown', () => {
    expect(parseResetPolicy(null)).toBe('rolling');
    expect(parseResetPolicy(undefined)).toBe('rolling');
    expect(parseResetPolicy('utc-daily')).toBe('utc-daily');
    expect(parseResetPolicy('bogus')).toBe('rolling');
  });

  it('normalizes tolerant setting values and rejects the rest', () => {
    expect(normalizeResetSettingValue(' utc-daily ')).toBe('utc-daily');
    expect(normalizeResetSettingValue('rolling')).toBe('rolling');
    expect(normalizeResetSettingValue('hourly')).toBeNull();
    expect(normalizeResetSettingValue(42)).toBeNull();
  });

  it('builds the settings key from the provider id', () => {
    expect(resetPolicyKey('groq')).toBe('quota-reset:groq');
  });
});

describe('rolling window', () => {
  it('starts at the current moment and ends 24h later', () => {
    const w = windowFor('rolling', NOW);
    expect(w.periodStart).toBe('2026-10-17T08:00:00.000Z');
    expect(w.periodEnd).toBe('2026-10-18T08:00:00.000Z');
    expect(nextResetAt('rolling', NOW)).toBe('2026-10-18T08:00:00.000Z');
  });

  it('never matches a persisted window except the exact same instant', () => {
    const w = windowFor('rolling', NOW);
    // A counter saved 16 hours ago is a different window: it must be discarded.
    expect(windowMatches('rolling', '2026-10-16T16:00:00.000Z', '2026-10-17T16:00:00.000Z', NOW)).toBe(false);
    expect(windowMatches('rolling', w.periodStart, w.periodEnd, NOW)).toBe(true);
  });

  it('has no elapsed time by definition: the window moves with the moment', () => {
    // A rolling window is anchored at `now`, so "time into window" is definitionally 0
    // at every instant - that is exactly why the utc-daily policy exists for providers
    // whose counters reset on a fixed schedule instead.
    expect(msIntoWindow('rolling', NOW)).toBe(0);
    expect(msIntoWindow('rolling', NOW + 3600_000)).toBe(0);
    expect(msIntoWindow('rolling', NOW - 3600_000)).toBe(0);
  });
});

describe('utc-daily window', () => {
  it('aligns to UTC midnight regardless of first use', () => {
    const w = windowFor('utc-daily', NOW);
    expect(w.periodStart).toBe('2026-10-17T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-10-18T00:00:00.000Z');
    // 08:00Z is 8 hours into the day.
    expect(msIntoWindow('utc-daily', NOW)).toBe(8 * 3600_000);
  });

  it('survives the user starting to use the pool late in the day', () => {
    // 23:30Z: still the same window that started at 00:00Z, ending in 30 minutes.
    const late = Date.parse('2026-10-17T23:30:00.000Z');
    const w = windowFor('utc-daily', late);
    expect(w.periodStart).toBe('2026-10-17T00:00:00.000Z');
    expect(w.periodEnd).toBe('2026-10-18T00:00:00.000Z');
    expect(nextResetAt('utc-daily', late)).toBe('2026-10-18T00:00:00.000Z');
  });

  it('matches a persisted window only within the same UTC day', () => {
    expect(
      windowMatches('utc-daily', '2026-10-17T00:00:00.000Z', '2026-10-18T00:00:00.000Z', NOW)
    ).toBe(true);
    // Yesterday's counters are stale even though the end timestamp is also "future-ish"
    // relative to a sloppy comparison.
    expect(
      windowMatches('utc-daily', '2026-10-16T00:00:00.000Z', '2026-10-17T00:00:00.000Z', NOW)
    ).toBe(false);
  });

  it('keeps the boundary exact at midnight', () => {
    const justBefore = Date.parse('2026-10-17T23:59:59.999Z');
    const justAfter = Date.parse('2026-10-18T00:00:00.000Z');
    expect(windowFor('utc-daily', justBefore).periodStart).toBe('2026-10-17T00:00:00.000Z');
    expect(windowFor('utc-daily', justAfter).periodStart).toBe('2026-10-18T00:00:00.000Z');
  });
});

describe('ui hint', () => {
  it('describes both policies tersely', () => {
    expect(describeReset('rolling', NOW)).toContain('24');
    expect(describeReset('utc-daily', NOW)).toContain('UTC');
    // The hint must include the reset time in UTC, not the viewer's local timezone.
    expect(describeReset('utc-daily', NOW)).toContain('00:00');
  });

  it('round-trips through the setting encoder', () => {
    expect(encodeResetSetting('utc-daily')).toBe('utc-daily');
    expect(parseResetPolicy(encodeResetSetting('rolling'))).toBe('rolling');
  });
});
