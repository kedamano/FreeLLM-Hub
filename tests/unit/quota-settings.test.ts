import { describe, it, expect, vi } from 'vitest';
import {
  QUOTA_KEY_PREFIX,
  applyQuotaConfigsFromSettings,
  quotaConfigFor,
  quotaSettingsKey,
  readQuota,
  validateQuotaInput,
  writeQuota,
  type QuotaInput
} from '../../src/scheduler/quota-settings';
import type { Scheduler } from '../../src/scheduler/scheduler';

function store(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    read: (key: string) => data.get(key) ?? null,
    write: vi.fn((key: string, value: string) => void data.set(key, value)),
    remove: vi.fn((key: string) => void data.delete(key)),
  };
}

describe('quota settings', () => {
  it('derives the settings key from the provider id', () => {
    expect(quotaSettingsKey('groq')).toBe(`${QUOTA_KEY_PREFIX}groq`);
  });

  it('accepts empty, zero and positive limits', () => {
    expect(validateQuotaInput({})).toBeNull();
    expect(validateQuotaInput({ maxRequestsPerDay: 0 })).toBeNull();
    expect(validateQuotaInput({ maxRequestsPerDay: 500, maxTokensPerDay: 250_000 })).toBeNull();
  });

  it('rejects negative, oversized and non-finite numbers', () => {
    expect(validateQuotaInput({ maxRequestsPerDay: -1 })).toContain('maxRequestsPerDay');
    expect(validateQuotaInput({ maxRequestsPerDay: 10_000_001 })).toContain('10000000');
    expect(validateQuotaInput({ maxTokensPerDay: 1_000_000_001 })).toContain('1000000000');
    expect(validateQuotaInput({ maxTokensPerDay: Number.NaN })).toContain('maxTokensPerDay');
    expect(validateQuotaInput({ maxRequestsPerDay: Number.POSITIVE_INFINITY })).toContain('maxRequestsPerDay');
  });

  it('reads persisted quotas and ignores unusable values', () => {
    const { read } = store({
      [quotaSettingsKey('groq')]: JSON.stringify({ maxRequestsPerDay: 120, maxTokensPerDay: 0 }),
      [quotaSettingsKey('openrouter')]: 'not json',
      [quotaSettingsKey('xai')]: JSON.stringify({ maxRequestsPerDay: 'many' }),
    });

    expect(readQuota('groq', read)).toEqual({ maxRequestsPerDay: 120 });
    expect(readQuota('openrouter', read)).toBeUndefined();
    expect(readQuota('xai', read)).toBeUndefined();
    expect(readQuota('missing', read)).toBeUndefined();
  });

  it('writes only effective limits and removes the entry when unlimited', () => {
    const { data, write, remove } = store();

    writeQuota('groq', { maxRequestsPerDay: 100, maxTokensPerDay: 0 }, write, remove);
    expect(JSON.parse(data.get(quotaSettingsKey('groq'))!)).toEqual({ maxRequestsPerDay: 100 });

    writeQuota('groq', { maxRequestsPerDay: 0, maxTokensPerDay: 0 } as QuotaInput, write, remove);
    expect(remove).toHaveBeenCalledWith(quotaSettingsKey('groq'));
    expect(data.has(quotaSettingsKey('groq'))).toBe(false);
  });

  it('maps stored quotas onto scheduler configs', () => {
    expect(quotaConfigFor('groq', { maxRequestsPerDay: 10 })).toEqual({
      providerId: 'groq',
      maxRequestsPerDay: 10,
      maxTokensPerDay: undefined,
    });
  });

  it('hydrates only providers that have a persisted quota', () => {
    const { read } = store({
      [quotaSettingsKey('groq')]: JSON.stringify({ maxRequestsPerDay: 300 }),
      [quotaSettingsKey('together')]: JSON.stringify({ maxTokensPerDay: 90_000 }),
    });
    const setQuotaConfig = vi.fn();
    const scheduler = { setQuotaConfig } as unknown as Scheduler;

    const applied = applyQuotaConfigsFromSettings(scheduler, ['groq', 'openrouter', 'together'], read);

    expect(applied).toEqual(['groq', 'together']);
    expect(setQuotaConfig).toHaveBeenNthCalledWith(1, {
      providerId: 'groq',
      maxRequestsPerDay: 300,
      maxTokensPerDay: undefined,
    });
    expect(setQuotaConfig).toHaveBeenNthCalledWith(2, {
      providerId: 'together',
      maxRequestsPerDay: undefined,
      maxTokensPerDay: 90_000,
    });
  });
});
