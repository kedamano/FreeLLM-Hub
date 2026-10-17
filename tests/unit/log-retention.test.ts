import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// log-retention delegates its sweep to data-governance; mock that boundary so the
// tests assert what log-retention actually controls (when to sweep, when to warn).
const logWarn = vi.hoisted(() => vi.fn());
vi.mock('../../src/core/log/logger', () => ({
  loggerFor: () => ({ warn: logWarn, info: logWarn, error: logWarn, debug: logWarn }),
}));

const deleteOldLogs = vi.fn();
const readSetting = vi.fn();
const purgeWithRetentionPolicies = vi.fn();

vi.mock('../../src/usage/usage-recorder', () => ({
  deleteOldLogs: (before: string) => deleteOldLogs(before),
}));

vi.mock('../../src/core/settings/settings-store', () => ({
  readSetting: (key: string) => readSetting(key),
}));

vi.mock('../../src/usage/data-governance', () => ({
  purgeWithRetentionPolicies: (...args: unknown[]) => purgeWithRetentionPolicies(...args),
  resolveAuditRetention: () => 7,
  exportCallLogs: () => '',
  wipeUserData: () => ({ callLogs: 0, auditRequests: 0, auditEvents: 0, quotaRows: 0 }),
}));

import {
  DEFAULT_LOG_RETENTION_DAYS,
  LOG_RETENTION_SETTING_KEY,
  purgeOldLogs,
  resolveRetentionDays,
  startLogRetentionSchedule,
} from '../../src/usage/log-retention';

describe('log retention', () => {
  beforeEach(() => {
    readSetting.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back to the default window for unusable settings', () => {
    expect(resolveRetentionDays(null)).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(resolveRetentionDays('')).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(resolveRetentionDays('abc')).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(resolveRetentionDays('0')).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(resolveRetentionDays('-5')).toBe(DEFAULT_LOG_RETENTION_DAYS);
    expect(resolveRetentionDays('1.9')).toBe(1);
    expect(resolveRetentionDays('99999')).toBe(3650);
  });

  it('reads the configured window from settings', () => {
    readSetting.mockReturnValue('7');
    expect(resolveRetentionDays()).toBe(7);
    expect(readSetting).toHaveBeenCalledWith(LOG_RETENTION_SETTING_KEY);
  });

  it('deletes everything older than an ISO cutoff', () => {
    deleteOldLogs.mockReturnValue(3);
    const now = Date.UTC(2026, 9, 16, 12, 0, 0);

    const removed = purgeOldLogs(now, 30);

    expect(removed).toBe(3);
    expect(deleteOldLogs).toHaveBeenCalledWith(new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString());
  });

  it('sweeps on a fixed interval and stops on dispose', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 16)));
    purgeWithRetentionPolicies.mockReturnValue({ callLogs: 1, auditRequests: 1, auditEvents: 1 });

    const dispose = startLogRetentionSchedule(60_000);

    expect(purgeWithRetentionPolicies).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(purgeWithRetentionPolicies).toHaveBeenCalledTimes(3);

    dispose();
    vi.advanceTimersByTime(600_000);
    expect(purgeWithRetentionPolicies).toHaveBeenCalledTimes(3);
  });

  it('keeps the schedule alive when a sweep throws', () => {
    vi.useFakeTimers();
    logWarn.mockClear();
    purgeWithRetentionPolicies.mockImplementation(() => {
      throw new Error('SQLITE_BUSY');
    });

    const dispose = startLogRetentionSchedule(60_000);
    vi.advanceTimersByTime(60_000);

    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: 'SQLITE_BUSY' }) }),
      '调用记录清理失败'
    );
    dispose();
  });
});
