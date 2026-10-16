import { registerIpcHandler } from './handle.js';
import * as oauthService from '../services/oauth-service.js';

/**
 * OAuth IPC surface.
 *
 * Only non-secret state crosses the bridge: the flow status, and a credential snapshot
 * that reports expiry/scope/status without ever returning an access or refresh token.
 */
export function registerOAuthIpc(): void {
  registerIpcHandler('oauth:start', async (_e, providerId?: string) => {
    const id = String(providerId ?? '').trim();
    if (!id) return { ok: false, error: '缺少服务商 ID' };
    return oauthService.startAuthorization(id);
  });

  registerIpcHandler('oauth:status', async (_e, state?: string) =>
    oauthService.flowStatus(String(state ?? ''))
  );

  registerIpcHandler('oauth:cancel', async (_e, stateOrProvider?: string) =>
    oauthService.cancelAuthorization(String(stateOrProvider ?? ''))
  );

  registerIpcHandler('oauth:refresh', async (_e, providerId?: string) =>
    oauthService.refreshNow(String(providerId ?? ''))
  );

  registerIpcHandler('oauth:unlink', async (_e, providerId?: string) =>
    oauthService.unlink(String(providerId ?? ''))
  );
}
