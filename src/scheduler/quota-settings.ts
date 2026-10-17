import type { Scheduler } from './scheduler.js';
import type { QuotaConfig } from './quota-manager.js';
import {
  deleteProfileSetting,
  readProfileSetting,
  writeProfileSetting,
} from '../core/settings/profile-store.js';

export const QUOTA_KEY_PREFIX = 'provider-quota:';

/**
 * Daily quotas are profile-scoped: a work project and a side project may give the same
 * provider very different ceilings. For the `default` profile the key stays the bare
 * `provider-quota:<id>`, so nothing moves for existing installations.
 */

export interface QuotaInput {
  maxRequestsPerDay?: number;
  maxTokensPerDay?: number;
  /** 'rolling' (default) or 'utc-daily'; see reset-policy.ts. */
  resetPolicy?: 'rolling' | 'utc-daily';
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
  }  if (
    input.resetPolicy !== undefined &&
    input.resetPolicy !== 'rolling' &&
    input.resetPolicy !== 'utc-daily'
  ) {
    return "resetPolicy 只能是 'rolling' 或 'utc-daily'";
  }

  return null;
}

export function readQuota(
  providerId: string,
  read: (key: string) => string | null = readProfileSetting
): QuotaInput | undefined {
  const raw = read(quotaSettingsKey(providerId));
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as QuotaInput;
    const requests = Number(parsed.maxRequestsPerDay);
    const tokens = Number(parsed.maxTokensPerDay);
    const quota: QuotaInput = {};
    if (Number.isFinite(requests) && requests > 0) quota.maxRequestsPerDay = requests;
    if (Number.isFinite(tokens) && tokens > 0) quota.maxTokensPerDay = tokens;
    if (parsed.resetPolicy === 'utc-daily' || parsed.resetPolicy === 'rolling') {
      quota.resetPolicy = parsed.resetPolicy;
    }
    return Object.keys(quota).length > 0 ? quota : undefined;
  } catch {
    return undefined;
  }
}

export function writeQuota(
  providerId: string,
  quota: QuotaInput,
  write: (key: string, value: string) => void = writeProfileSetting,
  remove: (key: string) => void = deleteProfileSetting
): void {
  const effective: QuotaInput = {};
  if (quota.maxRequestsPerDay) effective.maxRequestsPerDay = quota.maxRequestsPerDay;
  if (quota.maxTokensPerDay) effective.maxTokensPerDay = quota.maxTokensPerDay;
  if (quota.resetPolicy) effective.resetPolicy = quota.resetPolicy;

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
    resetPolicy: quota?.resetPolicy,
  };
}

/** Load every persisted per-provider daily quota into the scheduler. */
export function applyQuotaConfigsFromSettings(
  scheduler: Scheduler,
  providerIds: string[],
  read: (key: string) => string | null = readProfileSetting
): string[] {
  const applied: string[] = [];
  for (const providerId of providerIds) {
    const quota = readQuota(providerId, read);
    if (!quota) {
      // A profile that does not configure a provider must not inherit the previous
      // profile's limit that is still live in the scheduler.
      scheduler.getQuotaManager().clearConfig(providerId);
      continue;
    }
    scheduler.setQuotaConfig(quotaConfigFor(providerId, quota));
    applied.push(providerId);
  }
  return applied;
}
