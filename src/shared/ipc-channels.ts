/**
 * The renderer <-> main wire contract.
 *
 * Every invocable channel is listed here once; the main-process guard builds its
 * allowlist from this array, so a channel that exists is a channel that is allowed
 * and a typo cannot silently fall out of the security boundary.
 */
export const IPC_CHANNELS = [
  'providers:list',
  'providers:get',
  'providers:test',
  'providers:set-credential',
  'providers:get-credential',
  'providers:list-credentials',
  'providers:add-credential',
  'providers:remove-credential-slot',
  'providers:remove-credential',
  'providers:toggle',
  'providers:update-baseurl',
  'providers:update-config',
  'providers:set-quota',
  'providers:discover-models',
  'providers:get-models',
  'providers:create-custom',
  'providers:delete-custom',
  'providers:configure-oauth',
  'models:list',
  'models:get',
  'models:discover',
  'models:refresh',
  'scheduler:status',
  'scheduler:reset-circuit',
  'scheduler:reset-all-circuits',
  'settings:get',
  'settings:set',
  'settings:get-all',
  'usage:dashboard',
  'usage:provider-stats',
  'usage:daily-stats',
  'usage:recent-calls',
  'usage:cost-summary',
  'usage:quota-usage',
  'usage:daily-by-provider',
  'usage:audit-list',
  'usage:audit-detail',
  'usage:audit-summary',
  'profiles:list',
  'profiles:active',
  'profiles:get',
  'profiles:create',
  'profiles:update',
  'profiles:delete',
  'profiles:switch',
  'profiles:duplicate',
  'profiles:reset-pool',
  'oauth:start',
  'oauth:status',
  'oauth:cancel',
  'oauth:refresh',
  'oauth:unlink',
  'gateway:getStatus',
  'gateway:getToken',
  'gateway:generateToken',
  'gateway:updateConfig',
  'app:version',
  'app:data-path',
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export function isKnownChannel(channel: string): channel is IpcChannel {
  return (IPC_CHANNELS as readonly string[]).includes(channel);
}
