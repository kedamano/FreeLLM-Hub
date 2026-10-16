import { getDatabase } from '../database/database.js';
import { readSetting, writeSetting, deleteSetting } from './settings-store.js';
import type { PlainKeyStore } from '../providers/provider-state.js';
import type { Profile, ProfileStats } from '../../shared/types/observability.js';

// Single declaration of the profile wire shape, shared with the renderer.
export type { Profile, ProfileStats } from '../../shared/types/observability.js';

/**
 * Multi-profile support.
 *
 * A profile is a named pool of free providers: which providers are enabled, which
 * base URL / account settings they use, and what daily quota each one gets. Different
 * projects want different pools (a coding project leans on Groq + Cerebras, a side
 * project may only be allowed to touch OpenRouter), so those four settings families
 * become profile-scoped while UI preferences, the gateway, credentials and the model
 * catalogue stay global.
 *
 * Storage deliberately reuses the existing `settings` table with a `profile:<id>:`
 * key prefix instead of adding a second key/value table:
 * - the `default` profile keeps using the historical bare keys, so an upgraded
 *   installation continues to see exactly the pool it already had configured;
 * - every other profile reads and writes `profile:<id>:<key>`, and creating a profile
 *   from an existing one is a straight key copy.
 */

export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_PROFILE_NAME = '默认配置档';
export const ACTIVE_PROFILE_SETTING_KEY = 'active_profile';
export const PROFILE_KEY_PREFIX = 'profile:';

/** Settings families that belong to a profile rather than to the whole app. */
export const PROFILE_SCOPED_PREFIXES = [
  'provider-enabled:',
  'provider-baseurl:',
  'provider-settings:',
  'provider-quota:',
  'task-routes',
] as const;

interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  is_default: number | null;
  is_active: number | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

function mapProfileRow(row: ProfileRow): Profile {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = null;
    }
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isDefault: Number(row.is_default ?? 0) === 1,
    isActive: Number(row.is_active ?? 0) === 1,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugifyProfileId(name: string): string {
  const ascii = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = ascii || 'profile';
  return `${base}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Insert the `default` profile on first use. Existing bare-key settings *are* the
 * default profile, so no data movement is required.
 */
export function ensureProfilesSeeded(): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO profiles (id, name, description, is_default, is_active)
     VALUES (?, ?, ?, 1, 1)`
  ).run(DEFAULT_PROFILE_ID, DEFAULT_PROFILE_NAME, '升级前已有的配置，使用全局密钥池');

  const activeCount = (
    db.prepare('SELECT COUNT(*) as count FROM profiles WHERE is_active = 1').get() as { count: number }
  ).count;
  if (activeCount === 0) {
    db.prepare('UPDATE profiles SET is_active = 1 WHERE id = ?').run(DEFAULT_PROFILE_ID);
  }
}

export function listProfiles(): Profile[] {
  ensureProfilesSeeded();
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM profiles ORDER BY is_default DESC, created_at ASC')
    .all() as ProfileRow[];
  return rows.map(mapProfileRow);
}

export function getProfile(profileId: string): Profile | null {
  ensureProfilesSeeded();
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId) as
    | ProfileRow
    | undefined;
  return row ? mapProfileRow(row) : null;
}

export function getActiveProfile(): Profile {
  const stored = readSetting(ACTIVE_PROFILE_SETTING_KEY);
  if (stored) {
    const profile = getProfile(stored);
    if (profile) return profile;
  }
  return (
    getProfile(DEFAULT_PROFILE_ID) ?? {
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      description: null,
      isDefault: true,
      isActive: true,
      metadata: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  );
}

export interface CreateProfileInput {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  /** Copy the pool configuration of an existing profile instead of starting empty. */
  copyFrom?: string;
}

export interface ProfileMutationResult<T> {
  ok: boolean;
  profile?: T;
  error?: string;
}

export function createProfile(input: CreateProfileInput): ProfileMutationResult<Profile> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return { ok: false, error: '配置档名称不能为空' };
  if (name.length > 40) return { ok: false, error: '配置档名称不能超过 40 个字符' };

  ensureProfilesSeeded();
  const db = getDatabase();
  const duplicate = db
    .prepare('SELECT id FROM profiles WHERE lower(name) = lower(?)')
    .get(name) as { id: string } | undefined;
  if (duplicate) return { ok: false, error: `已存在同名配置档：${name}` };

  const id = slugifyProfileId(name);
  db.prepare(
    `INSERT INTO profiles (id, name, description, is_default, is_active, metadata)
     VALUES (?, ?, ?, 0, 0, ?)`
  ).run(id, name, input.description?.trim() || null, input.metadata ? JSON.stringify(input.metadata) : null);

  if (input.copyFrom) {
    const copied = copyProfileKeys(input.copyFrom, id);
    if (copied === null) {
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
      return { ok: false, error: `来源配置档不存在：${input.copyFrom}` };
    }
  }

  return { ok: true, profile: getProfile(id) ?? undefined };
}

export function updateProfile(
  profileId: string,
  patch: { name?: string; description?: string; metadata?: Record<string, unknown> }
): ProfileMutationResult<Profile> {
  ensureProfilesSeeded();
  const existing = getProfile(profileId);
  if (!existing) return { ok: false, error: '配置档不存在' };

  const db = getDatabase();
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  if (!name) return { ok: false, error: '配置档名称不能为空' };
  if (name.length > 40) return { ok: false, error: '配置档名称不能超过 40 个字符' };
  if (name !== existing.name) {
    const duplicate = db
      .prepare('SELECT id FROM profiles WHERE lower(name) = lower(?) AND id <> ?')
      .get(name, profileId) as { id: string } | undefined;
    if (duplicate) return { ok: false, error: `已存在同名配置档：${name}` };
  }

  const description =
    patch.description !== undefined ? patch.description.trim() || null : existing.description;
  const metadata =
    patch.metadata !== undefined ? JSON.stringify(patch.metadata) : existing.metadata
      ? JSON.stringify(existing.metadata)
      : null;

  db.prepare(
    `UPDATE profiles SET name = ?, description = ?, metadata = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name, description, metadata, profileId);

  return { ok: true, profile: getProfile(profileId) ?? undefined };
}

export function deleteProfile(profileId: string): { ok: boolean; error?: string } {
  ensureProfilesSeeded();
  const profile = getProfile(profileId);
  if (!profile) return { ok: false, error: '配置档不存在' };
  if (profile.isDefault) return { ok: false, error: '默认配置档不可删除' };
  if (profile.isActive) return { ok: false, error: '请先切换到其他配置档再删除' };

  const db = getDatabase();
  db.transaction(() => {
    for (const key of profileKeysFor(profileId)) {
      deleteSetting(key);
    }
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  })();

  return { ok: true };
}

export function setActiveProfile(profileId: string): ProfileMutationResult<Profile> {
  ensureProfilesSeeded();
  const profile = getProfile(profileId);
  if (!profile) return { ok: false, error: '配置档不存在' };

  const db = getDatabase();
  db.transaction(() => {
    db.prepare('UPDATE profiles SET is_active = 0 WHERE is_active = 1').run();
    db.prepare('UPDATE profiles SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(profileId);
  })();
  writeSetting(ACTIVE_PROFILE_SETTING_KEY, profileId);

  notifyProfileChanged(profileId);
  return { ok: true, profile };
}

/**
 * Read the active profile id without touching the `profiles` table. Used on the
 * request path, where the seeding write inside `getProfile()` would be pure overhead.
 * Invalidated whenever the active profile changes.
 */
let cachedActiveProfileId: string | null = null;

export function invalidateActiveProfileCache(): void {
  cachedActiveProfileId = null;
}

export function getActiveProfileId(): string {
  if (cachedActiveProfileId) return cachedActiveProfileId;
  const stored = readSetting(ACTIVE_PROFILE_SETTING_KEY);
  cachedActiveProfileId = stored && stored.trim() ? stored : DEFAULT_PROFILE_ID;
  return cachedActiveProfileId;
}

type ProfileListener = (profileId: string) => void;
const profileListeners = new Set<ProfileListener>();

export function onProfileChanged(listener: ProfileListener): () => void {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
}

function notifyProfileChanged(profileId: string): void {
  cachedActiveProfileId = profileId;
  for (const listener of profileListeners) {
    try {
      listener(profileId);
    } catch {
      /* one failing listener must not block the rest of the runtime */
    }
  }
}

export function namespacedProfileKey(profileId: string, key: string): string {
  if (!profileId || profileId === DEFAULT_PROFILE_ID) return key;
  return `${PROFILE_KEY_PREFIX}${profileId}:${key}`;
}

export function profileIdFromNamespacedKey(key: string): string | null {
  if (!key.startsWith(PROFILE_KEY_PREFIX)) return null;
  const rest = key.slice(PROFILE_KEY_PREFIX.length);
  const separator = rest.indexOf(':');
  return separator > 0 ? rest.slice(0, separator) : null;
}

export function bareKeyFromNamespacedKey(key: string): string {
  if (!key.startsWith(PROFILE_KEY_PREFIX)) return key;
  const rest = key.slice(PROFILE_KEY_PREFIX.length);
  const separator = rest.indexOf(':');
  return separator > 0 ? rest.slice(separator + 1) : rest;
}

/** A `PlainKeyStore` bound to the settings table (the historical global store). */
export function globalKeyStore(): PlainKeyStore {
  return {
    get: (key) => readSetting(key),
    set: (key, value) => writeSetting(key, value),
    delete: (key) => deleteSetting(key),
  };
}

/**
 * A `PlainKeyStore` scoped to one profile.
 *
 * The `default` profile reads the historical bare keys, so an upgraded installation
 * keeps exactly the pool it already had. Any other profile treats its own namespaced
 * keys as *overrides on top of the default profile*: a setting the profile never
 * touched (or explicitly reset) falls back to the default value. That inheritance is
 * what makes switching safe — profile state is always derived from `default + this
 * profile's overrides`, never from whatever profile happened to be active before.
 */
export function profileKeyStore(profileId: string = getActiveProfileId()): PlainKeyStore {
  const global = globalKeyStore();
  const namespaced = (key: string) => namespacedProfileKey(profileId, key);
  return {
    get: (key) => {
      if (profileId === DEFAULT_PROFILE_ID) return global.get(key);
      const own = global.get(namespaced(key));
      return own !== null ? own : global.get(key);
    },
    set: (key, value) => global.set(namespaced(key), value),
    delete: (key) => {
      if (profileId !== DEFAULT_PROFILE_ID) global.delete(namespaced(key));
      else global.delete(key);
    },
  };
}

/** True when a profile setting comes from the default profile rather than its own row. */
export function isSettingInherited(key: string, profileId = getActiveProfileId()): boolean {
  if (profileId === DEFAULT_PROFILE_ID) return false;
  const global = globalKeyStore();
  return global.get(namespacedProfileKey(profileId, key)) === null;
}

export function readProfileSetting(key: string, profileId = getActiveProfileId()): string | null {
  return readSetting(namespacedProfileKey(profileId, key));
}

export function writeProfileSetting(
  key: string,
  value: string,
  profileId = getActiveProfileId()
): void {
  writeSetting(namespacedProfileKey(profileId, key), value);
}

export function deleteProfileSetting(key: string, profileId = getActiveProfileId()): void {
  deleteSetting(namespacedProfileKey(profileId, key));
}

function profileKeysFor(profileId: string): string[] {
  if (profileId === DEFAULT_PROFILE_ID) return [];
  const db = getDatabase();
  const rows = db
    .prepare('SELECT key FROM settings WHERE key LIKE ?')
    .all(`${PROFILE_KEY_PREFIX}${profileId}:%`) as Array<{ key: string }>;
  return rows.map((row) => row.key);
}

/** Keys (unprefixed) that this profile explicitly overrides. */
export function listProfileOverrideKeys(profileId = getActiveProfileId()): string[] {
  if (profileId === DEFAULT_PROFILE_ID) {
    const db = getDatabase();
    const rows = db.prepare('SELECT key FROM settings').all() as Array<{ key: string }>;
    return rows
      .map((row) => row.key)
      .filter((key) => !key.startsWith(PROFILE_KEY_PREFIX) && isProfileScopedKey(key));
  }
  const db = getDatabase();
  const rows = db
    .prepare('SELECT key FROM settings WHERE key LIKE ?')
    .all(`${PROFILE_KEY_PREFIX}${profileId}:%`) as Array<{ key: string }>;
  return rows.map((row) => bareKeyFromNamespacedKey(row.key));
}

export function isProfileScopedKey(key: string): boolean {
  return PROFILE_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Copy one profile's pool configuration onto another. Returns null when the source
 * does not exist, otherwise the number of keys written.
 */
export function copyProfileKeys(fromProfileId: string, toProfileId: string): number | null {
  if (!getProfile(fromProfileId) || !getProfile(toProfileId)) return null;
  const db = getDatabase();
  const source = profileKeyStore(fromProfileId);
  const target = profileKeyStore(toProfileId);
  let copied = 0;

  for (const key of listProfileOverrideKeys(fromProfileId)) {
    const value = source.get(key);
    if (value === null) continue;
    target.set(key, value);
    copied += 1;
  }

  // Touch updated_at so the destination surfaces as recently edited.
  db.prepare('UPDATE profiles SET updated_at = datetime(\'now\') WHERE id = ?').run(toProfileId);
  return copied;
}

/** Reset a profile's pool back to the built-in defaults (keeps credentials global). */
export function clearProfilePool(profileId: string): number {
  const store = profileKeyStore(profileId);
  const keys = listProfileOverrideKeys(profileId);
  for (const key of keys) store.delete(key);
  return keys.length;
}

export function getProfileStats(profileId: string): ProfileStats {
  const db = getDatabase();
  const store = profileKeyStore(profileId);
  const enabledProviders = listProviderIdsWithOverride(profileId, 'provider-enabled:').filter(
    (providerId) => store.get(`provider-enabled:${providerId}`) !== 'false'
  ).length;
  const quotaConfigured = listProviderIdsWithOverride(profileId, 'provider-quota:').length;

  const usage = db
    .prepare(
      `SELECT COUNT(*) as requests,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) as tokens,
              COALESCE(SUM(cost_usd), 0) as cost,
              COALESCE(SUM(saved_cost_usd), 0) as saved
       FROM call_logs WHERE COALESCE(profile_id, 'default') = ?`
    )
    .get(profileId) as { requests: number; tokens: number; cost: number; saved: number };

  return {
    profileId,
    enabledProviders,
    quotaConfigured,
    requests: usage.requests,
    tokens: Number(usage.tokens ?? 0),
    costUsd: Number(usage.cost ?? 0),
    savedCostUsd: Number(usage.saved ?? 0),
  };
}

/** Provider ids that appear in one settings family for the given profile. */
function listProviderIdsWithOverride(profileId: string, prefix: string): string[] {
  const db = getDatabase();
  // A non-default profile inherits whatever the default profile configures, so the
  // enumerable set is its own namespaced rows unioned with the bare default rows.
  const patterns = [`${prefix}%`];
  if (profileId !== DEFAULT_PROFILE_ID) patterns.push(`profile:${profileId}:${prefix}%`);

  const ids = new Set<string>();
  for (const pattern of patterns) {
    const rows = db.prepare('SELECT key FROM settings WHERE key LIKE ?').all(pattern) as Array<{
      key: string;
    }>;
    for (const row of rows) {
      const id = bareKeyFromNamespacedKey(row.key).slice(prefix.length);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}
