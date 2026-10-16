import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getCredentialStore } from '../security/credential-store.js';
import { getProviderRegistry } from '../../core/providers/index.js';
import { getDatabase } from '../../core/database/database.js';
import { getActiveProfileId } from '../../core/settings/profile-store.js';
import {
  OAuthTokenManager,
  buildAuthorizationUrl,
  cancelProviderFlows,
  createFlow,
  createPkcePair,
  getFlow,
  oauthSecretId,
  pruneExpiredFlows,
  randomOpaqueValue,
  resolveOAuthSpec,
  setFlowStatus,
  storeClientSecret,
  type SecretStore,
} from '../../core/providers/oauth/oauth-manager.js';
import { OAuthTokenError, requestToken, validatePkcePair } from '../../core/providers/oauth/oauth-core.js';
import type { OAuthTokenSource } from '../../core/providers/openai-compatible/adapter.js';
import type { OAuthProviderSpec } from '../../core/providers/oauth/oauth-core.js';
import type { OAuthCredentialState, OAuthFlowState } from '../../shared/types/observability.js';

/**
 * OAuth orchestration for the desktop/web host.
 *
 * The redirect target is a one-shot loopback HTTP server: OAuth clients cannot accept a
 * POST and the out-of-band `oob` flow is retired, so a real authorization-code + PKCE
 * exchange needs somewhere for the browser to land. It binds to 127.0.0.1 only, on an
 * ephemeral port, and closes as soon as the provider has redirected back (or the flow
 * expires).
 */

const CALLBACK_PATH = '/oauth/callback';
const FLOW_SERVER_TTL_MS = 10 * 60_000;

let secretStore: SecretStore | null = null;

/** Adapter over the encrypted credential store (safeStorage / AES-GCM fallback). */
export function oauthSecretStore(): SecretStore {
  if (secretStore) return secretStore;
  const store = getCredentialStore();
  const adapter: SecretStore = {
    store: (id, value, meta) => (meta ? store.storeWithMetadata(id, value, meta) : store.store(id, value)),
    retrieve: (id) => store.retrieve(id),
    readMetadata: (id) => store.readMetadata(id),
    updateStatus: (id, status) => store.updateStatus(id, status),
    delete: (id) => store.delete(id),
  };
  secretStore = adapter;
  return adapter;
}

function specForProvider(providerId: string): OAuthProviderSpec | null {
  const config = getProviderRegistry().get(providerId)?.getProviderConfig();
  return resolveOAuthSpec(
    providerId,
    config?.displayName ?? providerId,
    config?.baseUrl ?? '',
    oauthSecretStore()
  );
}

let manager: OAuthTokenManager | null = null;

export function getOAuthTokenManager(): OAuthTokenManager {
  if (!manager) {
    manager = new OAuthTokenManager(oauthSecretStore(), specForProvider, {
      trace: (providerId, message, detail) => {
        console.log(`[OAuth] ${providerId}: ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
      },
    });
  }
  return manager;
}

/**
 * The adapter-side view of the token manager, handed to providers at bootstrap.
 * Adapters never see the refresh token, only a function that yields a live access token.
 */
export function oauthTokenSourceFor(providerId: string): OAuthTokenSource {
  const tokenManager = getOAuthTokenManager();
  return {
    getToken: () => tokenManager.getValidToken(providerId),
    refreshToken: () =>
      tokenManager.forceRefresh(providerId).then((token) => token?.accessToken ?? null),
    status: () => {
      const described = tokenManager.describe(providerId);
      return {
        authorized: described.configured && described.status !== 'expired' && described.status !== 'revoked',
        expiresAt: described.expiresAt,
        refreshable: described.refreshable,
        status: described.status,
      };
    },
  };
}

/** True when a provider is configured for OAuth rather than a static key. */
export function isOAuthProvider(providerId: string): boolean {
  return specForProvider(providerId) !== null;
}

export function setOAuthClientSecret(providerId: string, secret: string): void {
  storeClientSecret(oauthSecretStore(), providerId, secret);
}

interface ActiveFlow {
  server: Server;
  timer: NodeJS.Timeout;
  providerId: string;
  state: string;
}

const activeFlows = new Map<string, ActiveFlow>();

function closeFlowServer(providerId: string): void {
  const active = activeFlows.get(providerId);
  if (!active) return;
  activeFlows.delete(providerId);
  clearTimeout(active.timer);
  active.server.closeAllConnections?.();
  active.server.close(() => undefined);
}

export interface StartAuthorizationResult {
  ok: boolean;
  error?: string;
  flow?: OAuthFlowState;
}

/**
 * Begin an authorization-code + PKCE exchange. Returns the URL for the UI to present and
 * opens it in the default browser when running inside Electron.
 */
export async function startAuthorization(providerId: string): Promise<StartAuthorizationResult> {
  const spec = specForProvider(providerId);
  if (!spec) return { ok: false, error: '该服务商未配置 OAuth（缺少授权端点或 Client ID）' };

  closeFlowServer(providerId);
  pruneExpiredFlows();

  const pkce = createPkcePair();
  if (spec.usePkce && !validatePkcePair(pkce)) return { ok: false, error: 'PKCE 参数生成失败' };

  const state = randomOpaqueValue(16);
  let server: Server;
  try {
    server = await listenForCallback(providerId, state, pkce, spec);
  } catch (err) {
    return {
      ok: false,
      error: `无法启动本地回调端口：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close(() => undefined);
    return { ok: false, error: '本地回调端口未就绪' };
  }

  // The redirect URI must match exactly what the provider registered, and it is only
  // known once the OS has assigned the ephemeral port — so the flow row is written now.
  const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
  const record = createFlow({
    state,
    providerId,
    profileId: getActiveProfileId(),
    codeVerifier: pkce.verifier,
    redirectUri,
    clientId: spec.clientId,
    scopes: spec.scopes,
  });

  const authorizationUrl = buildAuthorizationUrl({ spec, redirectUri, state, challenge: pkce.challenge });

  const timer = setTimeout(() => {
    setFlowStatus(state, 'expired', '授权超时未完成');
    closeFlowServer(providerId);
  }, FLOW_SERVER_TTL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  activeFlows.set(providerId, { server, timer, providerId, state });
  await openInBrowser(authorizationUrl);

  return {
    ok: true,
    flow: {
      state,
      providerId,
      status: 'pending',
      authorizationUrl,
      error: null,
      expiresAt: record.expiresAt,
    },
  };
}

function listenForCallback(
  providerId: string,
  state: string,
  pkce: { verifier: string; challenge: string },
  spec: OAuthProviderSpec
): Promise<Server> {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer((request, response) => {
      void handleCallback(request, response, providerId, state, pkce, spec);
    });
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectServer);
      resolveServer(server);
    });
  });
}

async function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  providerId: string,
  expectedState: string,
  pkce: { verifier: string; challenge: string },
  spec: OAuthProviderSpec
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== CALLBACK_PATH) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  const finish = (
    status: number,
    title: string,
    detail: string,
    flowStatusValue: 'authorized' | 'failed'
  ) => {
    setFlowStatus(expectedState, flowStatusValue, flowStatusValue === 'failed' ? detail : undefined);
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(callbackPage(title, detail));
    setTimeout(() => closeFlowServer(providerId), 250);
  };

  if ((url.searchParams.get('state') ?? '') !== expectedState) {
    // A state mismatch is the signature of a CSRF attempt against the loopback port.
    finish(400, '授权校验失败', 'state 不匹配，请重新发起授权。', 'failed');
    return;
  }

  const errorParam = url.searchParams.get('error');
  if (errorParam) {
    finish(200, '授权被拒绝', `服务商返回错误：${errorParam}`, 'failed');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    finish(400, '缺少授权码', '回调中没有 code 参数。', 'failed');
    return;
  }

  const flow = getFlow(expectedState);
  try {
    const { token } = await requestToken(
      spec.tokenUrl,
      {
        clientAuthentication: spec.clientAuthentication,
        defaultExpiresInSeconds: spec.defaultExpiresInSeconds,
      },
      {
        grantType: 'authorization_code',
        clientId: spec.clientId,
        clientSecret: spec.clientSecret,
        code,
        redirectUri: flow?.redirectUri,
        codeVerifier: spec.usePkce ? pkce.verifier : undefined,
        clientAuthentication: spec.clientAuthentication,
      }
    );
    getOAuthTokenManager().saveToken(providerId, token);
    finish(200, '授权成功', '可以关闭本页面并回到 FreeLLM Hub。', 'authorized');
  } catch (err) {
    const message =
      err instanceof OAuthTokenError ? `${err.errorCode}：${err.message}` : String(err);
    finish(200, '令牌交换失败', message, 'failed');
  }
}

function callbackPage(title: string, detail: string): string {
  const safe = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${safe(title)}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#F4F5F7;color:#1F2937;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #EBECF0;border-radius:12px;padding:28px 32px;max-width:420px;text-align:center}
h1{font-size:17px;margin:0 0 8px}p{font-size:13px;color:#6B7280;margin:0;line-height:1.6}</style></head>
<body><div class="card"><h1>${safe(title)}</h1><p>${safe(detail)}</p></div></body></html>`;
}

async function openInBrowser(url: string): Promise<void> {
  try {
    // Lazy require keeps this module loadable from the standalone web server.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as { shell?: { openExternal: (target: string) => Promise<void> } };
    if (electron?.shell?.openExternal) await electron.shell.openExternal(url);
  } catch {
    /* web mode: the UI renders the link for the user to click */
  }
}

export interface FlowStatusResult {
  flow: OAuthFlowState | null;
  credential: OAuthCredentialState | null;
}

export function flowStatus(state: string): FlowStatusResult {
  const record = getFlow(state);
  if (!record) return { flow: null, credential: null };
  return {
    flow: {
      state: record.state,
      providerId: record.providerId,
      status: record.status,
      authorizationUrl: null,
      error: record.error,
      expiresAt: record.expiresAt,
    },
    credential: getOAuthTokenManager().describe(record.providerId),
  };
}

export function pendingAuthorizations(): OAuthFlowState[] {
  const rows = getDatabase()
    .prepare(
      `SELECT state, provider_id, status, error, expires_at FROM oauth_flows
       WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`
    )
    .all() as Array<{
    state: string;
    provider_id: string;
    status: string;
    error: string | null;
    expires_at: string;
  }>;

  return rows.map((row) => ({
    state: row.state,
    providerId: row.provider_id,
    status: row.status as OAuthFlowState['status'],
    authorizationUrl: null,
    error: row.error,
    expiresAt: row.expires_at,
  }));
}

/** Snapshot of a provider's OAuth credential state, or null when it is not OAuth. */
export function credentialState(providerId: string): OAuthCredentialState | null {
  if (!specForProvider(providerId)) return null;
  return getOAuthTokenManager().describe(providerId);
}

export async function refreshNow(
  providerId: string
): Promise<{ ok: boolean; error?: string; credential?: OAuthCredentialState }> {
  if (!specForProvider(providerId)) return { ok: false, error: '该服务商未配置 OAuth' };
  const token = await getOAuthTokenManager().forceRefresh(providerId);
  const credential = getOAuthTokenManager().describe(providerId);
  if (!token) {
    return { ok: false, error: '刷新失败：没有可用的刷新令牌，请重新授权', credential };
  }
  return { ok: true, credential };
}

export function cancelAuthorization(providerIdOrState: string): { ok: boolean; error?: string } {
  const active = activeFlows.get(providerIdOrState);
  if (active) {
    setFlowStatus(active.state, 'cancelled', '已取消');
    closeFlowServer(providerIdOrState);
    return { ok: true };
  }

  const record = getFlow(providerIdOrState);
  if (!record) return { ok: false, error: '授权流程不存在或已结束' };
  setFlowStatus(providerIdOrState, 'cancelled', '已取消');
  closeFlowServer(record.providerId);
  return { ok: true };
}

/** Sign out: drop the stored token and client secret for a provider. */
export function unlink(providerId: string): { ok: boolean } {
  getOAuthTokenManager().clearToken(providerId);
  oauthSecretStore().delete(oauthSecretId(providerId));
  cancelProviderFlows(providerId);
  return { ok: true };
}

/** Close any listening callback port — called on app shutdown. */
export function shutdownOAuthFlows(): void {
  for (const providerId of [...activeFlows.keys()]) closeFlowServer(providerId);
}
