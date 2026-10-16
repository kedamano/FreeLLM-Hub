import type { Scheduler } from './scheduler.js';
import type { QuotaConfig } from './quota-manager.js';
import { deleteSetting, readSetting, writeSetting } from '../core/settings/settings-store.js';

export const QUOTA_KEY_PREFIX = 'provider-quota:';

export interface QuotaInput {
  maxRequestsPerDay?: number;
  maxTokensPerDay?: number;
}

export function quotaSettingsKey(providerId: string): string {
  return `${QUOTA_KEY_PREFIX}${providerId}`;
}

const MAX_REQUESTS = 10_000_000;
const MAX_TOKENS = 1_000_000_000;

/** Returns an error string for invalid input, or null when the input is usable. */
export function validateQuotaInput(input: QuotaInput): string | null {
  for (const [field, limit] of [
    ['maxRequestsPerDay', MAX_REQUESTS],
    ['maxTokensPerDay', MAX_TOKENS],
  ] as const) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > limit) {
      return `${field} 需要是 0 到 ${limit} 之间的数字（0 表示不限制）`;
    }
  }
  return null;
}

export function readQuota(providerId: string, read: (key: string) => string | null = readSetting): QuotaInput | undefined {
  const raw = read(quotaSettingsKey(providerId));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as QuotaInput;
    const requests = Number(parsed.maxRequestsPerDay);
    const tokens = Number(parsed.maxTokensPerDay);
    const quota: QuotaInput = {};
    if (Number.isFinite(requests) && requests > 0) quota.maxRequestsPerDay = requests;
    if (Number.isFinite(tokens) && tokens > 0) quota.maxTokensPerDay = tokens;
    return Object.keys(quota).length > 0 ? quota : undefined;
  } catch {
    return undefined;
  }
}

export function writeQuota(
  providerId: string,
  quota: QuotaInput,
  write: (key: string, value: string) => void = writeSetting,
  remove: (key: string) => void = deleteSetting
): void {
  const effective: QuotaInput = {};
  if (quota.maxRequestsPerDay) effective.maxRequestsPerDay = quota.maxRequestsPerDay;
  if (quota.maxTokensPerDay) effective.maxTokensPerDay = quota.maxTokensPerDay;

  if (Object.keys(effective).length === 0) {
    remove(quotaSettingsKey(providerId));
    return;
  }
  write(quotaSettingsKey(providerId), JSON.stringify(effective));
}

export function quotaConfigFor(providerId: string, quota?: QuotaInput): QuotaConfig {
  return {
    providerId: providerId as QuotaConfig['providerId'],
    maxRequestsPerDay: quota?.maxRequestsPerDay,
    maxTokensPerDay: quota?.maxTokensPerDay,
  };
}

/** Load every persisted per-provider daily quota into the scheduler. */
export function applyQuotaConfigsFromSettings(
  scheduler: Scheduler,
  providerIds: string[],
  read: (key: string) => string | null = readSetting
): string[] {
  const applied: string[] = [];
  for (const providerId of providerIds) {
    const quota = readQuota(providerId, read);
    if (!quota) continue;
    scheduler.setQuotaConfig(quotaConfigFor(providerId, quota));
    applied.push(providerId);
  }
  return applied;
}
