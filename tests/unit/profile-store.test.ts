import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openTestDatabase, type TestDatabase } from '../helpers/sqlite';
import { runMigrations } from '../../src/core/database/migrations';

const holder = vi.hoisted(() => ({ db: null as unknown as TestDatabase }));

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => holder.db,
}));

import {
  DEFAULT_PROFILE_ID,
  clearProfilePool,
  copyProfileKeys,
  createProfile,
  deleteProfile,
  ensureProfilesSeeded,
  getActiveProfile,
  getActiveProfileId,
  getProfile,
  getProfileStats,
  invalidateActiveProfileCache,
  isSettingInherited,
  listProfileOverrideKeys,
  listProfiles,
  namespacedProfileKey,
  onProfileChanged,
  profileKeyStore,
  readProfileSetting,
  setActiveProfile,
  updateProfile,
  writeProfileSetting,
} from '../../src/core/settings/profile-store';
import { readQuota, writeQuota } from '../../src/scheduler/quota-settings';

beforeEach(async () => {
  holder.db = (await openTestDatabase()).db;
  holder.db.pragma('foreign_keys = ON');
  runMigrations(holder.db as never);
  invalidateActiveProfileCache();
});

describe('configuration profiles', () => {
  it('seeds a default profile that is active and owns the bare settings keys', () => {
    ensureProfilesSeeded();
    const profiles = listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(DEFAULT_PROFILE_ID);
    expect(profiles[0].isDefault).toBe(true);
    expect(profiles[0].isActive).toBe(true);
    expect(getActiveProfileId()).toBe(DEFAULT_PROFILE_ID);
  });

  it('keeps the default profile on the historical bare keys', () => {
    expect(namespacedProfileKey(DEFAULT_PROFILE_ID, 'provider-enabled:groq')).toBe(
      'provider-enabled:groq'
    );
    expect(namespacedProfileKey('work', 'provider-enabled:groq')).toBe(
      'profile:work:provider-enabled:groq'
    );
  });

  it('creates, renames and refuses duplicate names', () => {
    ensureProfilesSeeded();
    const created = createProfile({ name: '工作项目', description: '只允许 Groq + Cerebras' });
    expect(created.ok).toBe(true);
    expect(created.profile?.description).toBe('只允许 Groq + Cerebras');

    const duplicate = createProfile({ name: ' 工作项目 ' });
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toMatch(/同名/);

    const renamed = updateProfile(created.profile!.id, { name: '个人项目' });
    expect(renamed.profile?.name).toBe('个人项目');

    expect(createProfile({ name: '' }).error).toMatch(/不能为空/);
    expect(createProfile({ name: 'x'.repeat(50) }).error).toMatch(/40/);
  });

  it('scopes provider enablement per profile without touching the other pool', () => {
    ensureProfilesSeeded();
    const { profile } = createProfile({ name: 'work' }) as { profile: { id: string } };

    // The legacy install state: groq enabled globally, gemini untouched.
    writeProfileSetting('provider-enabled:groq', 'true', DEFAULT_PROFILE_ID);
    writeProfileSetting('provider-enabled:gemini', 'false', DEFAULT_PROFILE_ID);
    writeProfileSetting('provider-enabled:groq', 'false', profile.id);

    expect(profileKeyStore(DEFAULT_PROFILE_ID).get('provider-enabled:groq')).toBe('true');
    expect(profileKeyStore(profile.id).get('provider-enabled:groq')).toBe('false');
    // Untouched in the new profile -> inherited from the default profile.
    expect(profileKeyStore(profile.id).get('provider-enabled:gemini')).toBe('false');
    expect(isSettingInherited('provider-enabled:gemini', profile.id)).toBe(true);
    expect(isSettingInherited('provider-enabled:groq', profile.id)).toBe(false);

    expect(listProfileOverrideKeys(profile.id)).toEqual(['provider-enabled:groq']);
    expect(listProfileOverrideKeys(DEFAULT_PROFILE_ID).sort()).toEqual([
      'provider-enabled:gemini',
      'provider-enabled:groq',
    ]);
  });

  it('switching the active profile changes what the scoped helpers read', () => {
    ensureProfilesSeeded();
    const { profile } = createProfile({ name: 'side-project' }) as { profile: { id: string } };
    writeProfileSetting('provider-quota:groq', JSON.stringify({ maxRequestsPerDay: 50 }), profile.id);
    writeProfileSetting('provider-quota:groq', JSON.stringify({ maxRequestsPerDay: 500 }), DEFAULT_PROFILE_ID);

    expect(readQuota('groq')?.maxRequestsPerDay).toBe(500);
    expect(setActiveProfile(profile.id).ok).toBe(true);
    expect(getActiveProfileId()).toBe(profile.id);
    expect(readQuota('groq')?.maxRequestsPerDay).toBe(50);
    expect(getProfile(profile.id)?.isActive).toBe(true);
    expect(getProfile(DEFAULT_PROFILE_ID)?.isActive).toBe(false);
  });

  it('notifies listeners exactly once per switch so the runtime can re-apply', () => {
    ensureProfilesSeeded();
    const { profile } = createProfile({ name: 'notify-me' }) as { profile: { id: string } };
    const seen: string[] = [];
    const dispose = onProfileChanged((id) => seen.push(id));

    setActiveProfile(profile.id);
    setActiveProfile(DEFAULT_PROFILE_ID);
    dispose();
    setActiveProfile(profile.id);

    expect(seen).toEqual([profile.id, DEFAULT_PROFILE_ID]);
  });

  it('copying a pool duplicates only the profile-scoped families', () => {
    ensureProfilesSeeded();
    writeProfileSetting('provider-quota:groq', JSON.stringify({ maxTokensPerDay: 1000 }), DEFAULT_PROFILE_ID);
    writeProfileSetting('theme', 'dark', DEFAULT_PROFILE_ID); // global preference

    const { profile } = createProfile({ name: 'copied', copyFrom: DEFAULT_PROFILE_ID }) as {
      profile: { id: string };
    };
    expect(readQuota('groq', (key) => readProfileSetting(key, profile.id))?.maxTokensPerDay).toBe(1000);
    expect(listProfileOverrideKeys(profile.id)).toEqual(['provider-quota:groq']);
    // Preferences stay global and are not namespaced onto the copy.
    expect(listProfileOverrideKeys(profile.id)).not.toContain('theme');
  });

  it('clearing a pool returns settings to inherited defaults', () => {
    ensureProfilesSeeded();
    const { profile } = createProfile({ name: 'temp' }) as { profile: { id: string } };
    writeProfileSetting('provider-enabled:groq', 'false', profile.id);
    expect(clearProfilePool(profile.id)).toBe(1);
    expect(profileKeyStore(profile.id).get('provider-enabled:groq')).toBeNull();
  });

  it('refuses to delete the default or the active profile', () => {
    ensureProfilesSeeded();
    expect(deleteProfile(DEFAULT_PROFILE_ID).error).toMatch(/默认/);

    const { profile } = createProfile({ name: 'active-one' }) as { profile: { id: string } };
    setActiveProfile(profile.id);
    expect(deleteProfile(profile.id).ok).toBe(false);

    setActiveProfile(DEFAULT_PROFILE_ID);
    expect(deleteProfile(profile.id).ok).toBe(true);
    expect(getProfile(profile.id)).toBeNull();
  });

  it('quotas written through the scheduler helper land in the active profile namespace', () => {
    ensureProfilesSeeded();
    const { profile } = createProfile({ name: 'quota-scope' }) as { profile: { id: string } };
    setActiveProfile(profile.id);

    writeQuota('groq', { maxRequestsPerDay: 20 });
    expect(
      holder.db
        .prepare('SELECT key FROM settings WHERE key = ?')
        .get(`profile:${profile.id}:provider-quota:groq`)
    ).toBeTruthy();

    writeQuota('groq', {});
    expect(readQuota('groq')).toBeUndefined();
  });

  it('profile stats stay separated once usage is attributed to a profile', () => {
    ensureProfilesSeeded();
    const { profile } = createProfile({ name: 'stats' }) as { profile: { id: string } };

    holder.db
      .prepare(
        `INSERT INTO call_logs (id, request_id, provider_id, model_id, status, prompt_tokens, completion_tokens, cost_usd, saved_cost_usd, profile_id)
         VALUES ('a','r1','groq','llama','success',10,20,0,0.3,?)`
      )
      .run(profile.id);
    holder.db
      .prepare(
        `INSERT INTO call_logs (id, request_id, provider_id, model_id, status, prompt_tokens, completion_tokens, cost_usd, saved_cost_usd, profile_id)
         VALUES ('b','r2','cerebras','qwen','success',5,5,0,0.1,?)`
      )
      .run(DEFAULT_PROFILE_ID);

    const mine = getProfileStats(profile.id);
    expect(mine.requests).toBe(1);
    expect(mine.savedCostUsd).toBeCloseTo(0.3, 6);
    expect(getProfileStats(DEFAULT_PROFILE_ID).requests).toBe(1);
  });
});
