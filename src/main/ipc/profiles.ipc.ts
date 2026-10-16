import type { Scheduler } from '../../scheduler/scheduler.js';
import { registerIpcHandler } from './handle.js';
import * as profileService from '../services/profile-service.js';

/**
 * Configuration profile IPC: list / create / rename / delete / switch.
 *
 * Switching is the only operation with runtime effect — it re-applies the pool
 * (enabled providers, base URLs, account settings, daily quotas and that profile's
 * usage buckets) onto the live scheduler, so the next request is routed by the new
 * profile without restarting the gateway.
 */
export function registerProfileIpc(scheduler: Scheduler): void {
  registerIpcHandler('profiles:list', async () => profileService.listProfileViews());

  registerIpcHandler('profiles:active', async () => profileService.activeProfileView());

  registerIpcHandler('profiles:get', async (_e, profileId?: string) =>
    profileId ? profileService.getProfileView(String(profileId)) : null
  );

  registerIpcHandler('profiles:create', async (_e, input?: unknown) =>
    profileService.createProfile((input ?? {}) as Record<string, unknown>)
  );

  registerIpcHandler('profiles:update', async (_e, profileId?: string, patch?: unknown) =>
    profileService.renameProfile(String(profileId ?? ''), (patch ?? {}) as Record<string, unknown>)
  );

  registerIpcHandler('profiles:delete', async (_e, profileId?: string) =>
    profileService.removeProfile(String(profileId ?? ''))
  );

  registerIpcHandler('profiles:switch', async (_e, profileId?: string) =>
    profileService.switchProfile(scheduler, String(profileId ?? ''))
  );

  registerIpcHandler('profiles:duplicate', async (_e, from?: string, to?: string) =>
    profileService.duplicateIntoProfile(String(from ?? ''), String(to ?? ''))
  );

  registerIpcHandler('profiles:reset-pool', async (_e, profileId?: string) =>
    profileService.resetProfilePool(String(profileId ?? ''))
  );
}
