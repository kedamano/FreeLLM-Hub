import { getDatabase } from '../../database/database.js';
import { readProfileSetting } from '../../settings/profile-store.js';
import {
  buildAuthorizationUrl,
  canRefresh,
  createPkcePair,
  isExpired,
  randomOpaqueValue,
  requestToken,
  shouldRefresh,
  tokenExpiresInMs,
  type OAuthProviderSpec,
  type OAuthTokenSet,
} from './oauth-core.js';
import type { OAuthCredentialState } from '../../../shared/types/observability.js';

/**
 * OAuth token custody and refresh orchestration.
 *
 * Storage rules:
 * - the token set is one encrypted blob per provider (`<id>-oauth`), because an access
 *   token is useless without its refresh token and must never be split across rows;
 * - the client secret (confidential clients) is stored separately (`<id>-oauth-secret`);
 * - expiry, scope and status are duplicated as *plaintext metadata columns* on those rows
 *   so the UI can render "expiring in 12 minutes" without decrypting anything.
 *
 * The secret store is injected rather than imported so this module stays free of
 * Electron dependencies and is unit-testable with an in-memory map.
 */

export interface SecretStore {
  store(id: string, value: string, meta?: SecretMeta): void;
  retrieve(id: string): string | null;
  readMetadata?(id: string): SecretMeta | null;
  updateStatus?(id: string, status: NonNullable<SecretMeta['status']>): void;
  delete(id: string): boolean;
}

export interface SecretMeta {
  kind?: 'api-key' | 'oauth' | 'oauth-client-secret' | 'bootstrap-token' | 'gateway-token';
  providerId?: string;
  tokenType?: string;
  scope?: string;
  expiresAt?: string | null;
  refreshable?: boolean;
  status?: 'active' | 'expired' | 'revoked' | 'refreshing' | 'error';
  lastRefreshedAt?: string | null;
  label?: string | null;
}

export const OAUTH_TOKEN_SUFFIX = 'oauth';
export const OAUTH_SECRET_SUFFIX = 'oauth-secret';

export function oauthTokenId(providerId: string): string {
  return `${providerId}-${OAUTH_TOKEN_SUFFIX}`;
}

export function oauthSecretId(providerId: string): string {
  return `${providerId}-${OAUTH_SECRET_SUFFIX}`;
}

/** Provider settings keys that describe an OAuth-capable endpoint (all non-secret). */
export interface OAuthSettingsShape {
  oauth?: boolean;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string;
  usePkce?: boolean;
  defaultExpiresInSeconds?: number;
  clientAuthentication?: 'post' | 'basic';
  baseUrl?: string;
}

const OAUTH_CONFIG_FIELDS = [
  {
    key: 'authorizationUrl',
    label: '授权端点 (Authorization URL)',
    type: 'url' as const,
    required: true,
    placeholder: 'https://auth.example.com/oauth2/authorize',
  },
  {
    key: 'tokenUrl',
    label: '令牌端点 (Token URL)',
    type: 'url' as const,
    required: true,
    placeholder: 'https://auth.example.com/oauth2/token',
  },
  {
    key: 'clientId',
    label: 'Client ID',
    type: 'text' as const,
    required: true,
    help: '公开客户端可留空密钥，仅支持授权码 + PKCE',
  },
  {
    key: 'scopes',
    label: 'Scopes',
    type: 'text' as const,
    placeholder: 'openid model.read inference',
    help: '空格分隔，按服务商文档填写',
  },
];

export function oauthConfigFields(): typeof OAUTH_CONFIG_FIELDS {
  return OAUTH_CONFIG_FIELDS;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The only credential-store capability spec resolution needs. */
export interface SecretReader {
  retrieve(id: string): string | null;
}

/**
 * Assemble the spec for a provider from its (profile-scoped) settings and the stored
 * client secret. Returns null when OAuth is not configured, so callers can fall back to
 * the plain API-key path instead of half-initialising an OAuth adapter.
 */
export function resolveOAuthSpec(
  providerId: string,
  displayName: string,
  fallbackBaseUrl: string,
  secrets: SecretReader,
  readSetting: (key: string) => string | null = readProfileSetting
): OAuthProviderSpec | null {
  let settings: OAuthSettingsShape = {};
  const raw = readSetting(`provider-settings:${providerId}`);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as OAuthSettingsShape;
      }
    } catch {
      return null;
    }
  }

  if (settings.oauth !== true) return null;
  if (!isHttpUrl(settings.authorizationUrl) || !isHttpUrl(settings.tokenUrl)) return null;
  if (typeof settings.clientId !== 'string' || !settings.clientId.trim()) return null;

  const baseUrl = isHttpUrl(settings.baseUrl) ? settings.baseUrl : fallbackBaseUrl;
  const clientSecret = secrets.retrieve(oauthSecretId(providerId)) ?? undefined;

  return {
    providerId,
    displayName,
    authorizationUrl: settings.authorizationUrl.trim(),
    tokenUrl: settings.tokenUrl.trim(),
    clientId: settings.clientId.trim(),
    clientSecret: clientSecret || undefined,
    scopes: (settings.scopes ?? '').split(/\s+/).filter(Boolean),
    usePkce: settings.usePkce !== false,
    baseUrl: baseUrl.replace(/\/$/, ''),
    defaultExpiresInSeconds:
      Number(settings.defaultExpiresInSeconds) > 0 ? Number(settings.defaultExpiresInSeconds) : undefined,
    clientAuthentication: settings.clientAuthentication === 'basic' ? 'basic' : 'post',
  };
}

export function storeClientSecret(secrets: SecretStore, providerId: string, secret: string): void {
  const trimmed = secret.trim();
  if (!trimmed) {
    secrets.delete(oauthSecretId(providerId));
    return;
  }
  secrets.store(oauthSecretId(providerId), trimmed, {
    kind: 'oauth-client-secret',
    providerId,
    label: `${providerId} OAuth client secret`,
  });
}

export class OAuthTokenManager {
  private inFlight = new Map<string, Promise<OAuthTokenSet | null>>();
  private cache = new Map<string, { token: OAuthTokenSet; readAt: number }>();
  private static readonly CACHE_MS = 5_000;

  constructor(
    private secrets: SecretStore,
    private specFor: (providerId: string) => OAuthProviderSpec | null,
    private hooks: {
      onTokenChanged?: (providerId: string, token: OAuthTokenSet | null) => void;
      trace?: (providerId: string, message: string, detail?: Record<string, unknown>) => void;
    } = {}
  ) {}

  loadToken(providerId: string): OAuthTokenSet | null {
    const encrypted = this.secrets.retrieve(oauthTokenId(providerId));
    if (!encrypted) return null;
    try {
      const parsed = JSON.parse(encrypted) as OAuthTokenSet;
      if (typeof parsed?.accessToken !== 'string') return null;
      if (typeof parsed.expiresAt !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  saveToken(providerId: string, token: OAuthTokenSet): void {
    this.secrets.store(oauthTokenId(providerId), JSON.stringify(token), {
      kind: 'oauth',
      providerId,
      tokenType: token.tokenType,
      scope: token.scope,
      expiresAt: token.expiresAt,
      refreshable: canRefresh(token),
      status: 'active',
      lastRefreshedAt: token.issuedAt,
      label: `${providerId} OAuth access token`,
    });
    this.cache.set(providerId, { token, readAt: Date.now() });
    this.hooks.onTokenChanged?.(providerId, token);
  }

  clearToken(providerId: string): void {
    this.secrets.delete(oauthTokenId(providerId));
    this.cache.delete(providerId);
    this.inFlight.delete(providerId);
    this.hooks.onTokenChanged?.(providerId, null);
  }

  /**
   * Return a usable access token, refreshing proactively when it is close to expiry.
   * Returns null when the provider was never authorised — the adapter then reports
   * `unconfigured` instead of sending an unauthenticated request.
   */
  async getValidToken(providerId: string, now: number = Date.now()): Promise<string | null> {
    const token = this.peekToken(providerId, now);
    if (!token) return null;

    if (!shouldRefresh(token, now)) {
      return token.accessToken;
    }

    if (!canRefresh(token)) {
      this.secrets.updateStatus?.(oauthTokenId(providerId), 'expired');
      this.hooks.trace?.(providerId, 'token expired without a refresh token', {
        expiresAt: token.expiresAt,
      });
      return isExpired(token, now) ? null : token.accessToken;
    }

    const refreshed = await this.refresh(providerId, now);
    return refreshed?.accessToken ?? token.accessToken;
  }

  /** Force a refresh, e.g. after an upstream 401 that our clock-skew guard missed. */
  async forceRefresh(providerId: string, now: number = Date.now()): Promise<OAuthTokenSet | null> {
    return this.refresh(providerId, now);
  }

  private peekToken(providerId: string, now: number): OAuthTokenSet | null {
    const cached = this.cache.get(providerId);
    if (cached && now - cached.readAt < OAuthTokenManager.CACHE_MS) return cached.token;
    const token = this.loadToken(providerId);
    if (token) this.cache.set(providerId, { token, readAt: now });
    return token;
  }

  /** Single-flight: concurrent expirations must not fire N refreshes at the provider. */
  private refresh(providerId: string, now: number): Promise<OAuthTokenSet | null> {
    const existing = this.inFlight.get(providerId);
    if (existing) return existing;

    const task = (async (): Promise<OAuthTokenSet | null> => {
      const spec = this.specFor(providerId);
      const token = this.loadToken(providerId);
      if (!spec || !token?.refreshToken) return null;

      this.secrets.updateStatus?.(oauthTokenId(providerId), 'refreshing');
      try {
        const result = await requestToken(
          spec.tokenUrl,
          { clientAuthentication: spec.clientAuthentication, defaultExpiresInSeconds: spec.defaultExpiresInSeconds },
          {
            grantType: 'refresh_token',
            clientId: spec.clientId,
            clientSecret: spec.clientSecret,
            refreshToken: token.refreshToken,
            scopes: spec.scopes,
            clientAuthentication: spec.clientAuthentication,
          }
        );
        // Providers may or may not re-issue the refresh token; keep the old one otherwise.
        const next: OAuthTokenSet = {
          ...result.token,
          refreshToken: result.token.refreshToken ?? token.refreshToken,
          scope: result.token.scope ?? token.scope,
        };
        this.saveToken(providerId, next);
        this.hooks.trace?.(providerId, 'token refreshed', {
          expiresAt: next.expiresAt,
          expiresInMs: tokenExpiresInMs(next, now),
        });
        return next;
      } catch (err) {
        const revoked = !isTransientFailure(err);
        this.secrets.updateStatus?.(oauthTokenId(providerId), revoked ? 'revoked' : 'error');
        this.hooks.trace?.(providerId, 'token refresh failed', {
          message: err instanceof Error ? err.message : String(err),
          revoked,
        });
        // A transient failure must not discard a still-valid access token.
        return revoked ? null : token;
      } finally {
        this.inFlight.delete(providerId);
      }
    })();

    this.inFlight.set(providerId, task);
    return task;
  }

  describe(providerId: string, now: number = Date.now()): OAuthCredentialState {
    const token = this.loadToken(providerId);
    const meta = this.secrets.readMetadata?.(oauthTokenId(providerId));
    if (!token) {
      return {
        providerId,
        configured: false,
        kind: 'oauth',
        expiresAt: null,
        secondsUntilExpiry: null,
        refreshable: false,
        scope: null,
        tokenType: null,
        status: 'unconfigured',
        lastRefreshedAt: null,
        label: null,
      };
    }

    const remainingMs = tokenExpiresInMs(token, now);
    const status: OAuthCredentialState['status'] =
      meta?.status === 'revoked'
        ? 'revoked'
        : meta?.status === 'error'
          ? 'error'
          : remainingMs <= 0
            ? 'expired'
            : remainingMs < 15 * 60_000
              ? 'refreshing'
              : 'active';

    return {
      providerId,
      configured: true,
      kind: 'oauth',
      expiresAt: token.expiresAt,
      secondsUntilExpiry: Math.round(remainingMs / 1000),
      refreshable: canRefresh(token),
      scope: token.scope ?? null,
      tokenType: token.tokenType,
      status,
      lastRefreshedAt: token.issuedAt,
      label: meta?.label ?? null,
    };
  }
}

function isTransientFailure(err: unknown): boolean {
  const status = (err as { status?: number })?.status ?? 0;
  const code = (err as { errorCode?: string })?.errorCode ?? '';
  if (status >= 500) return true;
  return code === 'network_error' || code === 'temporarily_unavailable' || code === 'server_error';
}

// ─── Pending authorization flows ─────────────────────────────────────

export interface OAuthFlowRecord {
  state: string;
  providerId: string;
  profileId: string | null;
  status: 'pending' | 'authorized' | 'failed' | 'cancelled' | 'expired';
  authorizationUrl: string | null;
  error: string | null;
  createdAt: string;
  expiresAt: string;
}

const FLOW_TTL_MS = 10 * 60_000;

/**
 * Flows are persisted (not kept in a Map) so the loopback callback handler and the
 * status-polling IPC call agree even if the app was reloaded mid-authorization.
 */
export function createFlow(input: {
  state?: string;
  providerId: string;
  profileId?: string;
  codeVerifier: string;
  redirectUri: string;
  clientId?: string;
  scopes?: string[];
  now?: number;
}): OAuthFlowRecord {
  const db = getDatabase();
  const now = input.now ?? Date.now();
  const record: OAuthFlowRecord = {
    state: input.state ?? randomOpaqueValue(16),
    providerId: input.providerId,
    profileId: input.profileId ?? null,
    status: 'pending',
    authorizationUrl: null,
    error: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + FLOW_TTL_MS).toISOString(),
  };

  db.prepare(
    `INSERT OR REPLACE INTO oauth_flows
       (state, provider_id, profile_id, code_verifier, redirect_uri, client_id, scopes, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?)`
  ).run(
    record.state,
    input.providerId,
    record.profileId,
    input.codeVerifier,
    input.redirectUri,
    input.clientId ?? null,
    input.scopes?.join(' ') ?? null,
    record.expiresAt
  );

  return record;
}

export interface FlowDetail extends OAuthFlowRecord {
  codeVerifier: string;
  redirectUri: string;
}

export function getFlow(state: string): FlowDetail | null {
  const row = getDatabase()
    .prepare('SELECT * FROM oauth_flows WHERE state = ?')
    .get(state) as
    | {
        state: string;
        provider_id: string;
        profile_id: string | null;
        code_verifier: string;
        redirect_uri: string;
        status: string;
        error: string | null;
        created_at: string;
        expires_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    state: row.state,
    providerId: row.provider_id,
    profileId: row.profile_id,
    codeVerifier: row.code_verifier,
    redirectUri: row.redirect_uri,
    status: row.status as OAuthFlowRecord['status'],
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    authorizationUrl: null,
  };
}

export function setFlowStatus(
  state: string,
  status: OAuthFlowRecord['status'],
  error?: string
): void {
  getDatabase()
    .prepare('UPDATE oauth_flows SET status = ?, error = ? WHERE state = ?')
    .run(status, error ?? null, state);
}

export function pendingFlows(): OAuthFlowRecord[] {
  const rows = getDatabase()
    .prepare(
      `SELECT state, provider_id, profile_id, status, error, created_at, expires_at
       FROM oauth_flows WHERE status = 'pending' AND expires_at > datetime('now')
       ORDER BY created_at DESC LIMIT 10`
    )
    .all() as Array<{
    state: string;
    provider_id: string;
    profile_id: string | null;
    status: string;
    error: string | null;
    created_at: string;
    expires_at: string;
  }>;
  return rows.map((row) => ({
    state: row.state,
    providerId: row.provider_id,
    profileId: row.profile_id,
    status: row.status as OAuthFlowRecord['status'],
    authorizationUrl: null,
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }));
}

export function pruneExpiredFlows(now: number = Date.now()): number {
  const result = getDatabase()
    .prepare("DELETE FROM oauth_flows WHERE expires_at <= ? OR status IN ('authorized', 'cancelled')")
    .run(new Date(now).toISOString());
  return result.changes;
}

/** Mark every unfinished flow of a provider as cancelled (used on unlink). */
export function cancelProviderFlows(providerId: string): number {
  const result = getDatabase()
    .prepare("UPDATE oauth_flows SET status = 'cancelled', error = '已解绑' WHERE provider_id = ? AND status = 'pending'")
    .run(providerId);
  return result.changes;
}

export { buildAuthorizationUrl, createPkcePair, randomOpaqueValue };
