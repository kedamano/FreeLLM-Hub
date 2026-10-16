import type { Scheduler } from '../../scheduler/scheduler.js';
import {
  clearProfilePool,
  copyProfileKeys,
  createProfile as createProfileRow,
  deleteProfile as deleteProfileRow,
  getActiveProfile,
  getActiveProfileId,
  getProfile,
  getProfileStats,
  listProfiles,
  onProfileChanged,
  profileKeyStore,
  setActiveProfile,
  updateProfile as updateProfileRow,
  type Profile,
  type ProfileStats,
} from '../../core/settings/profile-store.js';
import { getProviderRegistry } from '../../core/providers/index.js';
import { applyProviderOverrides } from '../../core/providers/provider-state.js';
import { applyQuotaConfigsFromSettings } from '../../scheduler/quota-settings.js';
import { createQuotaPersistence } from '../../usage/quota-store.js';
import { clearPricingCache } from '../../usage/cost-model.js';

export interface ProfileView extends Profile {
  stats: ProfileStats;
}

export interface ApplyProfileResult {
  ok: boolean;
  error?: string;
  profileId: string;
  enabledProviders: number;
  quotaProviders: number;
  restoredUsageBuckets: number;
  warnings: string[];
}

function toView(profile: Profile): ProfileView {
  return { ...profile, stats: getProfileStats(profile.id) };
}

export function listProfileViews(): ProfileView[] {
  return listProfiles().map(toView);
}

export function activeProfileView(): ProfileView {
  return toView(getActiveProfile());
}

export function getProfileView(profileId: string): ProfileView | null {
  const profile = getProfile(profileId);
  return profile ? toView(profile) : null;
}

/**
 * Re-apply a profile's pool onto the running scheduler: which providers are enabled,
 * their base URL / account settings, their daily quotas, and the usage buckets that
 * belong to that profile. Credentials stay shared because keys are per provider, not
 * per project — switching profiles must never look up a different secret.
 */
export function applyProfileToRuntime(
  scheduler: Scheduler,
  profileId: string = getActiveProfileId()
): ApplyProfileResult {
  const registry = getProviderRegistry();
  const adapters = registry.getAll();
  const store = profileKeyStore(profileId);

  const { errors } = applyProviderOverrides(adapters, store);
  for (const adapter of adapters) {
    scheduler.registerProviderConfig(adapter.getProviderConfig());
  }

  const quotaManager = scheduler.getQuotaManager();
  quotaManager.clearUsageState();
  const quotaProviders = applyQuotaConfigsFromSettings(
    scheduler,
    adapters.map((adapter) => adapter.providerId),
    (key) => store.get(key)
  );
  quotaManager.setPersistence(createQuotaPersistence(profileId));
  const restoredUsageBuckets = quotaManager.hydrate();

  // Model pricing is cached per provider:model and the cache is process-global;
  // the cost columns are profile-scoped, so drop it to be safe.
  clearPricingCache();

  const enabledProviders = adapters.filter(
    (adapter) => adapter.getProviderConfig().isEnabled
  ).length;

  return {
    ok: true,
    profileId,
    enabledProviders,
    quotaProviders: quotaProviders.length,
    restoredUsageBuckets,
    warnings: errors,
  };
}

export function switchProfile(
  scheduler: Scheduler,
  profileId: string
): { ok: boolean; error?: string; profile?: ProfileView; applied?: ApplyProfileResult } {
  const result = setActiveProfile(profileId);
  if (!result.ok || !result.profile) return { ok: false, error: result.error };

  const applied = applyProfileToRuntime(scheduler, result.profile.id);
  return { ok: true, profile: toView(result.profile), applied };
}

export function createProfile(
  input: { name?: unknown; description?: unknown; copyFrom?: unknown }
): { ok: boolean; error?: string; profile?: ProfileView } {
  const result = createProfileRow({
    name: String(input.name ?? ''),
    description: typeof input.description === 'string' ? input.description : undefined,
    copyFrom: typeof input.copyFrom === 'string' && input.copyFrom ? input.copyFrom : undefined,
  });
  if (!result.ok || !result.profile) return { ok: false, error: result.error };
  return { ok: true, profile: toView(result.profile) };
}

export function renameProfile(
  profileId: string,
  patch: { name?: unknown; description?: unknown }
): { ok: boolean; error?: string; profile?: ProfileView } {
  const result = updateProfileRow(profileId, {
    name: typeof patch.name === 'string' ? patch.name : undefined,
    description: typeof patch.description === 'string' ? patch.description : undefined,
  });
  if (!result.ok || !result.profile) return { ok: false, error: result.error };
  return { ok: true, profile: toView(result.profile) };
}

export function removeProfile(profileId: string): { ok: boolean; error?: string } {
  return deleteProfileRow(profileId);
}

/** Copy one profile's pool onto another (e.g. "start 项目B from 项目A"). */
export function duplicateIntoProfile(
  fromProfileId: string,
  toProfileId: string
): { ok: boolean; copied?: number; error?: string } {
  const copied = copyProfileKeys(fromProfileId, toProfileId);
  if (copied === null) return { ok: false, error: '来源或目标配置档不存在' };
  return { ok: true, copied };
}

/** Reset a profile back to built-in defaults, keeping the global credential pool. */
export function resetProfilePool(profileId: string): { ok: boolean; cleared?: number } {
  return { ok: true, cleared: clearProfilePool(profileId) };
}

/** Keep the runtime in sync with profile changes made outside the IPC path. */
export function watchProfileChanges(scheduler: Scheduler): () => void {
  return onProfileChanged((profileId) => {
    applyProfileToRuntime(scheduler, profileId);
  });
}
