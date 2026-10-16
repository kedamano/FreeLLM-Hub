/**
 * Persisted, non-secret provider configuration: base URL overrides and provider
 * specific fields such as the Cloudflare account id.
 *
 * Layout of the `settings` table keys used here:
 *   provider-enabled:<providerId>   "true" | "false"
 *   provider-baseurl:<providerId>   validated http(s) url
 *   provider-settings:<providerId>  JSON object of non-secret fields
 */

import type { ProviderAdapter } from './contracts.js';
import { LEGACY_FIELD_MIGRATIONS, type SecretKeyStore } from './credential-keys.js';

export type { SecretKeyStore } from './credential-keys.js';

export const PROVIDER_ENABLED_PREFIX = 'provider-enabled:';
export const PROVIDER_BASE_URL_PREFIX = 'provider-baseurl:';
export const PROVIDER_SETTINGS_PREFIX = 'provider-settings:';

export interface PlainKeyStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface ProviderOverride {
  baseUrl?: string;
  settings?: Record<string, unknown>;
}

export function enabledKey(providerId: string): string {
  return `${PROVIDER_ENABLED_PREFIX}${providerId}`;
}

export function baseUrlKey(providerId: string): string {
  return `${PROVIDER_BASE_URL_PREFIX}${providerId}`;
}

export function settingsKey(providerId: string): string {
  return `${PROVIDER_SETTINGS_PREFIX}${providerId}`;
}

export function isValidBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function readProviderOverride(store: PlainKeyStore, providerId: string): ProviderOverride {
  const override: ProviderOverride = {};

  const storedBaseUrl = store.get(baseUrlKey(providerId));
  if (isValidBaseUrl(storedBaseUrl)) override.baseUrl = storedBaseUrl.trim();

  const raw = store.get(settingsKey(providerId));
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        override.settings = parsed as Record<string, unknown>;
      }
    } catch {
      /* corrupted row: fall back to adapter defaults */
    }
  }

  return override;
}

export function readProviderEnabled(store: PlainKeyStore, providerId: string): boolean | null {
  const stored = store.get(enabledKey(providerId));
  if (stored === null) return null;
  return stored !== 'false';
}

export function writeProviderEnabled(store: PlainKeyStore, providerId: string, enabled: boolean): void {
  store.set(enabledKey(providerId), enabled ? 'true' : 'false');
}

export interface ApplyResult {
  applied: string[];
  errors: string[];
}

/** Apply persisted enabled / baseUrl / settings overrides onto live adapters. */
export function applyProviderOverrides(
  adapters: ProviderAdapter[],
  store: PlainKeyStore
): ApplyResult {
  const applied: string[] = [];
  const errors: string[] = [];

  for (const adapter of adapters) {
    const override = readProviderOverride(store, adapter.providerId);

    if (override.baseUrl) {
      if (adapter.updateBaseUrl) {
        adapter.updateBaseUrl(override.baseUrl);
        applied.push(`${adapter.providerId}.baseUrl`);
      } else {
        errors.push(`${adapter.providerId}: 不支持自定义 Base URL`);
      }
    }

    if (override.settings && adapter.updateSettings) {
      adapter.updateSettings(override.settings);
      applied.push(`${adapter.providerId}.settings`);
    }

    const enabled = readProviderEnabled(store, adapter.providerId);
    if (enabled !== null && adapter.setEnabled) {
      adapter.setEnabled(enabled);
      applied.push(`${adapter.providerId}.enabled`);
    }
  }

  return { applied, errors };
}

export interface UpdateConfigResult {
  ok: boolean;
  error?: string;
  changed: string[];
  baseUrl?: string;
  settings?: Record<string, unknown>;
}

/**
 * Validate a UI edit and apply it to the live adapter. Unsupported targets are
 * reported instead of silently "succeeding" — that silence is what previously let a
 * bad Ollama base URL or a missing Cloudflare account id look saved while being ignored.
 */
export function updateProviderConfig(
  adapter: ProviderAdapter,
  input: { baseUrl?: unknown; settings?: unknown }
): UpdateConfigResult {
  const changed: string[] = [];

  const baseUrl =
    typeof input.baseUrl === 'string' && input.baseUrl.trim() ? input.baseUrl.trim() : undefined;
  const settingsEdit =
    input.settings && typeof input.settings === 'object' && !Array.isArray(input.settings)
      ? (input.settings as Record<string, unknown>)
      : undefined;

  if (baseUrl && !isValidBaseUrl(baseUrl)) {
    return { ok: false, error: 'Base URL 必须是以 http:// 或 https:// 开头的合法地址', changed };
  }
  if (baseUrl && !adapter.updateBaseUrl) {
    return { ok: false, error: `${adapter.providerName} 不支持自定义 Base URL`, changed };
  }

  if (settingsEdit) {
    if (!adapter.updateSettings) {
      return { ok: false, error: `${adapter.providerName} 不支持自定义参数`, changed };
    }
    const fields = adapter.getProviderConfig().configFields ?? [];
    for (const [key, value] of Object.entries(settingsEdit)) {
      if (key === 'baseUrl') continue;
      const field = fields.find((f) => f.key === key);
      if (!field) return { ok: false, error: `未知配置项: ${key}`, changed };
      if (typeof value !== 'string') {
        return { ok: false, error: `配置项 ${field.label} 必须是字符串`, changed };
      }
      if (field.required && !value.trim()) {
        return { ok: false, error: `配置项 ${field.label} 不能为空`, changed };
      }
    }
  }

  if (baseUrl) {
    adapter.updateBaseUrl?.(baseUrl);
    changed.push('baseUrl');
  }
  if (settingsEdit && Object.keys(settingsEdit).length > 0) {
    adapter.updateSettings?.(settingsEdit);
    changed.push('settings');
  }

  if (changed.length === 0) {
    return { ok: false, error: '没有需要保存的更改', changed };
  }

  return { ok: true, changed, baseUrl, settings: settingsEdit };
}

/** Persist an applied edit. Only non-secret fields ever reach the settings table. */
export function persistProviderConfig(
  store: PlainKeyStore,
  providerId: string,
  result: Pick<UpdateConfigResult, 'baseUrl' | 'settings'>
): void {
  if (result.baseUrl) store.set(baseUrlKey(providerId), result.baseUrl);
  if (result.settings && Object.keys(result.settings).length > 0) {
    const existing = readProviderOverride(store, providerId).settings ?? {};
    store.set(settingsKey(providerId), JSON.stringify({ ...existing, ...result.settings }));
  }
}

/**
 * Move configuration that older builds kept inside the encrypted credential store
 * (Cloudflare account id, Ollama base URL blob) into the plain provider config rows,
 * then drop the stale rows so the credential inventory stays truthful.
 */
export function migrateLegacyProviderFields(
  secrets: SecretKeyStore,
  settings: PlainKeyStore,
  providerIds: Iterable<string>
): string[] {
  const migrated: string[] = [];

  for (const providerId of providerIds) {
    const migrations = LEGACY_FIELD_MIGRATIONS[providerId];
    if (!migrations || migrations.length === 0) continue;

    const existing = readProviderOverride(settings, providerId);
    const mergedSettings: Record<string, unknown> = { ...(existing.settings ?? {}) };
    let baseUrl = existing.baseUrl;
    let touched = false;

    for (const { legacyId, json } of migrations) {
      let raw: string | null = null;
      try {
        raw = secrets.retrieve(legacyId);
      } catch {
        raw = null;
      }
      if (!raw) continue;

      if (json) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (key === 'baseUrl' && isValidBaseUrl(value)) baseUrl = value.trim();
          else if (typeof value === 'string' && value.trim()) mergedSettings[key] = value.trim();
        }
      } else if (providerId === 'cloudflare' && raw.trim()) {
        mergedSettings.accountId = raw.trim();
      } else {
        continue;
      }

      touched = true;
      try {
        secrets.delete(legacyId);
      } catch {
        /* safeStorage unavailable: the migrated copy is already usable */
      }
    }

    if (!touched) continue;
    if (baseUrl) settings.set(baseUrlKey(providerId), baseUrl);
    if (Object.keys(mergedSettings).length > 0) {
      settings.set(settingsKey(providerId), JSON.stringify(mergedSettings));
    }
    migrated.push(providerId);
  }

  return migrated;
}
