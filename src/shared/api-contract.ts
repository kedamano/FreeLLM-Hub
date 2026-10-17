import type { IpcChannel } from './ipc-channels.js';

export type AdminHttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * One invocable channel and the admin REST route that stands in for it when the UI runs
 * in the browser instead of inside the Electron window.
 */
export interface AdminRouteBinding {
  method: AdminHttpMethod;
  /** Path relative to `/api`, with `:name` placeholders filled from `params`. */
  path: string;
}

/**
 * The single source of truth for the three-way contract:
 * preload channel → main-process IPC handler → admin REST route.
 *
 * `Record<IpcChannel, ...>` makes a missing entry a build error, and the contract tests
 * assert every bound route is actually registered, so a rename on either side fails in CI
 * instead of turning into a runtime 404 for web-mode users.
 */
export const ADMIN_ROUTE_BINDINGS: Record<IpcChannel, AdminRouteBinding> = {
  'providers:list': { method: 'GET', path: '/providers' },
  'providers:get': { method: 'GET', path: '/providers/:providerId' },
  'providers:test': { method: 'POST', path: '/providers/:providerId/test' },
  'providers:set-credential': { method: 'POST', path: '/providers/:providerId/credential' },
  'providers:reveal-credential': { method: 'POST', path: '/providers/:providerId/credential/reveal' },
  'providers:list-credentials': { method: 'GET', path: '/providers/:providerId/credentials' },
  'providers:add-credential': { method: 'POST', path: '/providers/:providerId/credentials' },
  'providers:remove-credential-slot': {
    method: 'DELETE',
    path: '/providers/:providerId/credentials/:index',
  },
  'providers:remove-credential': { method: 'DELETE', path: '/providers/:providerId/credential' },
  'providers:toggle': { method: 'POST', path: '/providers/:providerId/toggle' },
  'providers:update-baseurl': { method: 'PUT', path: '/providers/:providerId/base-url' },
  'providers:update-config': { method: 'PUT', path: '/providers/:providerId/config' },
  'providers:set-quota': { method: 'PUT', path: '/providers/:providerId/quota' },
  'providers:discover-models': { method: 'POST', path: '/providers/:providerId/discover-models' },
  'providers:get-models': { method: 'GET', path: '/providers/:providerId/models' },
  'providers:create-custom': { method: 'POST', path: '/providers/custom' },
  'providers:delete-custom': { method: 'DELETE', path: '/providers/:providerId' },
  'providers:configure-oauth': { method: 'POST', path: '/providers/:providerId/oauth' },

  'models:list': { method: 'GET', path: '/models' },
  'models:get': { method: 'GET', path: '/models/:providerId/:modelId' },
  'models:discover': { method: 'POST', path: '/models/discover' },
  'models:refresh': { method: 'POST', path: '/models/refresh' },

  'scheduler:status': { method: 'GET', path: '/scheduler/status' },
  'scheduler:reset-circuit': { method: 'POST', path: '/scheduler/reset-circuit' },
  'scheduler:reset-all-circuits': { method: 'POST', path: '/scheduler/reset-all-circuits' },

  'settings:get': { method: 'GET', path: '/settings/:key' },
  'settings:set': { method: 'PUT', path: '/settings/:key' },
  'settings:get-all': { method: 'GET', path: '/settings' },

  'usage:dashboard': { method: 'GET', path: '/usage/summary' },
  'usage:provider-stats': { method: 'GET', path: '/usage/providers/:providerId' },
  'usage:daily-stats': { method: 'GET', path: '/usage/timeseries' },
  'usage:recent-calls': { method: 'GET', path: '/usage/recent' },
  'usage:cost-summary': { method: 'GET', path: '/usage/cost' },
  'usage:quota-usage': { method: 'GET', path: '/usage/quota' },
  'usage:daily-by-provider': { method: 'GET', path: '/usage/timeseries-by-provider' },
  'usage:audit-list': { method: 'POST', path: '/audit/list' },
  'usage:audit-detail': { method: 'GET', path: '/audit/requests/:requestId' },
  'usage:audit-summary': { method: 'GET', path: '/audit/summary' },

  'profiles:list': { method: 'GET', path: '/profiles' },
  'profiles:active': { method: 'GET', path: '/profiles/active' },
  'profiles:get': { method: 'GET', path: '/profiles/:profileId' },
  'profiles:create': { method: 'POST', path: '/profiles' },
  'profiles:update': { method: 'PUT', path: '/profiles/:profileId' },
  'profiles:delete': { method: 'DELETE', path: '/profiles/:profileId' },
  'profiles:switch': { method: 'POST', path: '/profiles/:profileId/activate' },
  'profiles:duplicate': { method: 'POST', path: '/profiles/duplicate' },
  'profiles:reset-pool': { method: 'POST', path: '/profiles/:profileId/reset-pool' },

  'oauth:start': { method: 'POST', path: '/oauth/:providerId/authorize' },
  'oauth:status': { method: 'GET', path: '/oauth/flows/:state' },
  'oauth:cancel': { method: 'POST', path: '/oauth/flows/:state/cancel' },
  'oauth:refresh': { method: 'POST', path: '/oauth/:providerId/refresh' },
  'oauth:unlink': { method: 'DELETE', path: '/oauth/:providerId' },
  'usage:export-logs': { method: 'POST', path: '/usage/export' },
  'usage:wipe-data': { method: 'POST', path: '/usage/wipe' },
  'update:check': { method: 'POST', path: '/update/check' },
  'update:download': { method: 'POST', path: '/update/download' },
  'update:install': { method: 'POST', path: '/update/install' },
  'update:getState': { method: 'GET', path: '/update/state' },
  'update:setEnabled': { method: 'PUT', path: '/update/enabled' },

  'gateway:getStatus': { method: 'GET', path: '/gateway/status' },
  'gateway:getToken': { method: 'GET', path: '/gateway/token' },
  'gateway:generateToken': { method: 'POST', path: '/gateway/generate-token' },
  'gateway:updateConfig': { method: 'PUT', path: '/gateway/config' },

  'app:version': { method: 'GET', path: '/app/version' },
  'app:data-path': { method: 'GET', path: '/app/data-path' },
};

const PLACEHOLDER = /:([A-Za-z][A-Za-z0-9]*)/g;

/** Placeholders declared for a channel, in order of appearance. */
export function routeParams(channel: IpcChannel): string[] {
  const names: string[] = [];
  for (const match of ADMIN_ROUTE_BINDINGS[channel].path.matchAll(PLACEHOLDER)) {
    names.push(match[1]);
  }
  return names;
}

/**
 * Fill a bound path with its `:params`. Values are URL-encoded here so no call site has
 * to remember it, and a missing or extra param is a programming error rather than a
 * silently wrong URL.
 */
export function routeUrl(
  channel: IpcChannel,
  params: Record<string, string | number> = {}
): string {
  const declared = routeParams(channel);
  const path = ADMIN_ROUTE_BINDINGS[channel].path.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined || value === '') {
      throw new Error(`Route '${channel}' is missing the '${name}' parameter`);
    }
    return encodeURIComponent(String(value));
  });

  for (const extra of Object.keys(params)) {
    if (!declared.includes(extra)) {
      throw new Error(`Route '${channel}' does not declare a '${extra}' parameter`);
    }
  }

  return path;
}
