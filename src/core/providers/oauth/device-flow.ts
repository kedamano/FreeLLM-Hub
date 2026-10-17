import {
  OAuthTokenError,
  parseTokenResponse,
  type OAuthProviderSpec,
  type OAuthTokenSet,
} from './oauth-core.js';

/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * This is the flow for providers where the user authenticates on a *different* device
 * (phone / browser) than the one running the app - exactly the desktop-aggregator
 * situation, and the flow several "coding plan" free tiers use instead of API keys.
 *
 * Two-step shape:
 *   1. `requestDeviceAuthorization` -> show the user `verification_uri` + `user_code`
 *      (or just open `verification_uri_complete`).
 *   2. Poll `pollDeviceToken` no faster than the returned `interval` until it resolves
 *      into a token set or a hard error. `authorization_pending` and `slow_down` are
 *      *expected* responses while the user is typing, not failures.
 *
 * No built-in provider ships with a client_id here on purpose: a device flow is only as
 * legitimate as the client_id registered with the provider, and inventing one would be
 * impersonation. Specs that carry a real, registered client_id can adopt this in a few
 * lines (see `OAuthProviderSpec`).
 */

export interface DeviceAuthorizationSpec {
  clientId: string;
  scopes?: string[];
  extra?: Record<string, string>;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Pre-filled variant - opening this is strictly better when the provider sends it. */
  verificationUriComplete?: string;
  /** Seconds the grant stays valid; the caller must stop polling after this. */
  expiresIn: number;
  /** Seconds between polls (RFC default 5, providers may raise it via slow_down). */
  intervalSeconds: number;
}

export interface DevicePollState {
  deviceCode: string;
  /** Current poll interval in seconds; raised by `slow_down` responses. */
  intervalSeconds: number;
  /** Absolute deadline (ms epoch) after which the caller must stop and restart. */
  expiresAtMs: number;
}

const DEFAULT_DEVICE_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: on slow_down the interval grows by exactly 5 seconds. */
export const SLOW_DOWN_PENALTY_SECONDS = 5;

function formBody(params: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, value);
  return body.toString();
}

async function postForm(
  url: string,
  body: string,
  fetchImpl: typeof fetch
): Promise<{ status: number; payload: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new OAuthTokenError(
      `无法连接设备授权端点: ${err instanceof Error ? err.message : String(err)}`,
      0,
      'network_error',
      true
    );
  }
  const text = await response.text().catch(() => '');
  let payload: Record<string, unknown> = {};
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* HTML gateway errors */
  }
  return { status: response.status, payload };
}

function readString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Step 1: register a device flow and hand the user something to open. */
export async function requestDeviceAuthorization(
  deviceAuthorizationUrl: string,
  spec: DeviceAuthorizationSpec,
  fetchImpl: typeof fetch = fetch
): Promise<DeviceAuthorization> {
  const body = formBody({
    client_id: spec.clientId,
    ...(spec.scopes?.length ? { scope: spec.scopes.join(' ') } : {}),
    ...(spec.extra ?? {}),
  });

  const { status, payload } = await postForm(deviceAuthorizationUrl, body, fetchImpl);
  const errorCode = readString(payload, 'error');
  if (status < 200 || status >= 300 || errorCode) {
    throw new OAuthTokenError(
      readString(payload, 'error_description') ?? `设备授权被拒绝 (HTTP ${status})`,
      status,
      errorCode ?? 'device_authorization_failed',
      status >= 500
    );
  }

  const deviceCode = readString(payload, 'device_code');
  const userCode = readString(payload, 'user_code');
  const verificationUri = readString(payload, 'verification_uri');
  if (!deviceCode || !userCode || !verificationUri) {
    throw new OAuthTokenError(
      '设备授权响应缺少 device_code / user_code / verification_uri',
      status,
      'invalid_response',
      false
    );
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: readString(payload, 'verification_uri_complete'),
    expiresIn: Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 600,
    intervalSeconds: Number(payload.interval) > 0 ? Number(payload.interval) : DEFAULT_DEVICE_INTERVAL_SECONDS,
  };
}

export type DevicePollOutcome =
  | { kind: 'pending'; intervalSeconds: number }
  | { kind: 'expired' }
  | { kind: 'token'; token: OAuthTokenSet }
  | { kind: 'error'; error: OAuthTokenError };

/**
 * Step 2: one poll attempt. The CALLER owns the loop and the pacing - this returns the
 * (possibly raised) interval instead of sleeping, so tests and the UI control timing.
 */
export async function pollDeviceToken(
  tokenUrl: string,
  spec: Pick<OAuthProviderSpec, 'clientAuthentication' | 'defaultExpiresInSeconds'> & {
    clientId: string;
  },
  state: DevicePollState,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<DevicePollOutcome> {
  if (now >= state.expiresAtMs) return { kind: 'expired' };

  const body = formBody({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: state.deviceCode,
    client_id: spec.clientId,
  });

  const { status, payload } = await postForm(tokenUrl, body, fetchImpl);
  if (status >= 200 && status < 300 && typeof payload.access_token === 'string') {
    try {
      const token = parseTokenResponse(
        payload as Parameters<typeof parseTokenResponse>[0],
        { defaultExpiresInSeconds: spec.defaultExpiresInSeconds },
        now
      );
      return { kind: 'token', token };
    } catch (err) {
      // A 2xx body that fails validation is a provider bug, not a wait state.
      return {
        kind: 'error',
        error: new OAuthTokenError(
          err instanceof Error ? err.message : String(err),
          status,
          'invalid_response',
          false
        ),
      };
    }
  }

  const errorCode = readString(payload, 'error') ?? 'device_poll_failed';
  switch (errorCode) {
    case 'authorization_pending':
      return { kind: 'pending', intervalSeconds: state.intervalSeconds };
    case 'slow_down':
      return { kind: 'pending', intervalSeconds: state.intervalSeconds + SLOW_DOWN_PENALTY_SECONDS };
    case 'expired_token':
      return { kind: 'expired' };
    default:
      return {
        kind: 'error',
        error: new OAuthTokenError(
          readString(payload, 'error_description') ?? `设备流轮询失败 (${errorCode})`,
          status,
          errorCode,
          status >= 500
        ),
      };
  }
}

/** Convenience loop for hosts without UI constraints: polls until token/expire/error. */
export async function pollDeviceTokenUntilSettled(
  tokenUrl: string,
  spec: Pick<OAuthProviderSpec, 'clientAuthentication' | 'defaultExpiresInSeconds'> & {
    clientId: string;
  },
  state: DevicePollState,
  sleep: (ms: number) => Promise<void>,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  maxAttempts: number = 120
): Promise<DevicePollOutcome> {
  let interval = state.intervalSeconds;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const outcome = await pollDeviceToken(
      tokenUrl,
      spec,
      { ...state, intervalSeconds: interval },
      fetchImpl,
      now()
    );
    if (outcome.kind !== 'pending') return outcome;
    interval = outcome.intervalSeconds;
    await sleep(interval * 1000);
  }
  return { kind: 'expired' };
}
