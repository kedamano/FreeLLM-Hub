import { createHash, randomBytes } from 'node:crypto';

/**
 * OAuth 2.0 authorization-code + PKCE primitives (pure, no storage, no network state).
 *
 * Why this exists at all: several free tiers now hand out access tokens that expire in
 * under an hour instead of a long-lived API key. A desktop aggregator that only knows
 * static keys cannot use them for more than a few minutes, so credential refresh has to
 * be a first-class concept rather than something the user redoes by hand.
 */

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  /** ISO timestamp when the access token stops being valid. */
  expiresAt: string;
  scope?: string;
  idToken?: string;
  /** Opaque account/subject identifier when the provider returns one. */
  accountId?: string;
  issuedAt: string;
}

export interface OAuthProviderSpec {
  providerId: string;
  displayName: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  /** PKCE (RFC 7636) is required for public clients and always preferred. */
  usePkce: boolean;
  /** OpenAI-compatible API base the access token is accepted by. */
  baseUrl: string;
  /** Used when the provider omits `expires_in`. */
  defaultExpiresInSeconds?: number;
  extraAuthorizeParams?: Record<string, string>;
  /** `client_secret_post` (form field) vs `client_secret_basic` (HTTP basic). */
  clientAuthentication?: 'post' | 'basic';
}

/** Refresh this far ahead of actual expiry so a request never races the deadline. */
export const REFRESH_SKEW_MS = 120_000;

export function randomOpaqueValue(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 code_verifier is 43-128 chars of [A-Za-z0-9-_~.]; base64url fits. */
export function createPkcePair(): PkcePair {
  const verifier = randomOpaqueValue(32);
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function validatePkcePair(pair: PkcePair): boolean {
  if (!pair.verifier || pair.verifier.length < 43 || pair.verifier.length > 128) return false;
  const expected = createHash('sha256').update(pair.verifier, 'ascii').digest('base64url');
  return expected === pair.challenge;
}

export interface BuildAuthorizeUrlInput {
  spec: OAuthProviderSpec;
  redirectUri: string;
  state: string;
  challenge?: string;
}

export function buildAuthorizationUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(input.spec.authorizationUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.spec.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  if (input.spec.scopes.length > 0) url.searchParams.set('scope', input.spec.scopes.join(' '));
  if (input.spec.usePkce && input.challenge) {
    url.searchParams.set('code_challenge', input.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [key, value] of Object.entries(input.spec.extraAuthorizeParams ?? {})) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** A raw token-endpoint response, normalised into a token set. */
export interface TokenEndpointResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number | string;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
  [key: string]: unknown;
}

export class OAuthTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

export function parseTokenResponse(
  payload: TokenEndpointResponse,
  spec: Pick<OAuthProviderSpec, 'defaultExpiresInSeconds'>,
  now: number = Date.now()
): OAuthTokenSet {
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new OAuthTokenError(
      typeof payload.error_description === 'string'
        ? payload.error_description
        : 'OAuth 令牌响应缺少 access_token',
      400,
      typeof payload.error === 'string' ? payload.error : 'invalid_response',
      false
    );
  }

  const expiresInSeconds = Number(payload.expires_in);
  const lifetimeMs =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? expiresInSeconds * 1000
      : (spec.defaultExpiresInSeconds ?? 3600) * 1000;

  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined,
    tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'Bearer',
    expiresAt: new Date(now + lifetimeMs).toISOString(),
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    idToken: typeof payload.id_token === 'string' ? payload.id_token : undefined,
    accountId:
      typeof payload.account_id === 'string'
        ? payload.account_id
        : typeof payload.sub === 'string'
          ? payload.sub
          : undefined,
    issuedAt: new Date(now).toISOString(),
  };
}

export function tokenExpiresInMs(token: OAuthTokenSet, now: number = Date.now()): number {
  const at = new Date(token.expiresAt).getTime();
  if (Number.isNaN(at)) return 0;
  return at - now;
}

/** True when the token is expired or close enough that refreshing now is cheaper. */
export function shouldRefresh(token: OAuthTokenSet, now: number = Date.now()): boolean {
  return tokenExpiresInMs(token, now) <= REFRESH_SKEW_MS;
}

export function isExpired(token: OAuthTokenSet, now: number = Date.now()): boolean {
  return tokenExpiresInMs(token, now) <= 0;
}

export function canRefresh(token: OAuthTokenSet): boolean {
  return typeof token.refreshToken === 'string' && token.refreshToken.length > 0;
}

export interface TokenRequestForm {
  grantType: 'authorization_code' | 'refresh_token';
  clientId: string;
  clientSecret?: string;
  code?: string;
  refreshToken?: string;
  redirectUri?: string;
  codeVerifier?: string;
  scopes?: string[];
  clientAuthentication?: 'post' | 'basic';
  extra?: Record<string, string>;
}

/** Build the form body + headers for a token-endpoint call. */
export function buildTokenRequest(
  spec: Pick<OAuthProviderSpec, 'clientAuthentication'>,
  form: TokenRequestForm
): { body: URLSearchParams; headers: Record<string, string> } {
  const params = new URLSearchParams();
  params.set('grant_type', form.grantType);
  const useBasic = (form.clientAuthentication ?? spec.clientAuthentication ?? 'post') === 'basic';

  if (form.grantType === 'authorization_code') {
    if (!form.code) throw new OAuthTokenError('缺少授权码', 400, 'invalid_request', false);
    params.set('code', form.code);
    if (form.redirectUri) params.set('redirect_uri', form.redirectUri);
    if (form.codeVerifier) params.set('code_verifier', form.codeVerifier);
  } else {
    if (!form.refreshToken) {
      throw new OAuthTokenError('没有可用的刷新令牌', 400, 'invalid_grant', false);
    }
    params.set('refresh_token', form.refreshToken);
    if (form.scopes?.length) params.set('scope', form.scopes.join(' '));
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (useBasic && form.clientSecret) {
    const basic = Buffer.from(`${form.clientId}:${form.clientSecret}`, 'utf8').toString('base64');
    headers.Authorization = `Basic ${basic}`;
  } else {
    params.set('client_id', form.clientId);
    if (form.clientSecret) params.set('client_secret', form.clientSecret);
  }

  for (const [key, value] of Object.entries(form.extra ?? {})) params.set(key, value);

  return { body: params, headers };
}

export interface TokenEndpointResult {
  token: OAuthTokenSet;
  raw: TokenEndpointResponse;
}

/**
 * Call a token endpoint. Network errors are reported as retryable so the caller can
 * distinguish "the provider is down" from "your refresh token was revoked".
 */
export async function requestToken(
  tokenUrl: string,
  spec: Pick<OAuthProviderSpec, 'clientAuthentication' | 'defaultExpiresInSeconds'>,
  form: TokenRequestForm,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<TokenEndpointResult> {
  const { body, headers } = buildTokenRequest(spec, form);
  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OAuthTokenError(
      `无法连接 OAuth 令牌端点: ${err instanceof Error ? err.message : String(err)}`,
      0,
      'network_error',
      true
    );
  }

  const text = await response.text().catch(() => '');
  let payload: TokenEndpointResponse = {};
  try {
    payload = text ? (JSON.parse(text) as TokenEndpointResponse) : {};
  } catch {
    /* some providers answer with HTML on gateway errors */
  }

  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : 'token_endpoint_error';
    throw new OAuthTokenError(
      typeof payload.error_description === 'string' ? payload.error_description : `HTTP ${response.status}`,
      response.status,
      code,
      // invalid_grant may be a transient provider hiccup; anything 5xx certainly is.
      response.status >= 500 || code === 'temporarily_unavailable'
    );
  }

  return { token: parseTokenResponse(payload, spec, now), raw: payload };
}
