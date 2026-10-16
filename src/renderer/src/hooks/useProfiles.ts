import { useCallback, useEffect, useState } from 'react';
import { getFreellmApi } from './useIPC';
import type { ProfileView } from '../../../shared/types/observability.js';

/** Fired after the active profile changes so every panel reloads the new pool's data. */
export const PROFILE_CHANGED_EVENT = 'freellm:profile-changed';

export interface UseProfilesResult {
  profiles: ProfileView[];
  active: ProfileView | null;
  activeProfileId: string | undefined;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  switchTo: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
  create: (input: { name: string; description?: string; copyFrom?: string }) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  rename: (
    profileId: string,
    patch: { name?: string; description?: string }
  ) => Promise<{ ok: boolean; error?: string }>;
  remove: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
  resetPool: (profileId: string) => Promise<{ ok: boolean; error?: string }>;
}

function notifyProfileChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT));
}

/** Subscribe a panel to profile switches so its queries re-run with the new scope. */
export function useProfileChanges(onChange: () => void): void {
  useEffect(() => {
    const handler = () => onChange();
    window.addEventListener(PROFILE_CHANGED_EVENT, handler);
    return () => window.removeEventListener(PROFILE_CHANGED_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function useProfiles(): UseProfilesResult {
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  const [active, setActive] = useState<ProfileView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = getFreellmApi();
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [list, activeProfile] = await Promise.all([api.profiles.list(), api.profiles.active()]);
      setProfiles(list);
      setActive(activeProfile ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '配置档加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const switchTo = useCallback(
    async (profileId: string) => {
      const api = getFreellmApi();
      if (!api) return { ok: false, error: '不可用' };
      const result = await api.profiles.switch(profileId);
      if (result.ok) {
        setActive(result.profile ?? null);
        notifyProfileChanged();
        void refresh();
      }
      return { ok: result.ok, error: result.error };
    },
    [refresh]
  );

  const create = useCallback(
    async (input: { name: string; description?: string; copyFrom?: string }) => {
      const api = getFreellmApi();
      if (!api) return { ok: false, error: '不可用' };
      const result = await api.profiles.create(input);
      if (result.ok) void refresh();
      return { ok: result.ok, error: result.error };
    },
    [refresh]
  );

  const rename = useCallback(
    async (profileId: string, patch: { name?: string; description?: string }) => {
      const api = getFreellmApi();
      if (!api) return { ok: false, error: '不可用' };
      const result = await api.profiles.update(profileId, patch);
      if (result.ok) void refresh();
      return { ok: result.ok, error: result.error };
    },
    [refresh]
  );

  const remove = useCallback(
    async (profileId: string) => {
      const api = getFreellmApi();
      if (!api) return { ok: false, error: '不可用' };
      const result = await api.profiles.remove(profileId);
      if (result.ok) {
        notifyProfileChanged();
        void refresh();
      }
      return { ok: result.ok, error: result.error };
    },
    [refresh]
  );

  const resetPool = useCallback(
    async (profileId: string) => {
      const api = getFreellmApi();
      if (!api) return { ok: false, error: '不可用' };
      const result = await api.profiles.resetPool(profileId);
      notifyProfileChanged();
      void refresh();
      return { ok: result.ok };
    },
    [refresh]
  );

  return {
    profiles,
    active,
    activeProfileId: active?.id,
    loading,
    error,
    refresh,
    switchTo,
    create,
    rename,
    remove,
    resetPool,
  };
}
