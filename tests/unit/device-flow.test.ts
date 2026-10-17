import { describe, it, expect, vi } from 'vitest';
import {
  pollDeviceToken,
  requestDeviceAuthorization,
  SLOW_DOWN_PENALTY_SECONDS,
  pollDeviceTokenUntilSettled,
} from '../../src/core/providers/oauth/device-flow';

const AUTH_URL = 'https://auth.example.com/device/code';
const TOKEN_URL = 'https://auth.example.com/oauth2/token';
const SPEC = { clientId: 'device-client', defaultExpiresInSeconds: 3600 };

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status });
}

describe('device authorization (step 1)', () => {
  it('posts client_id and scopes as a form and surfaces the verification pair', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(AUTH_URL);
      const body = String(init?.body);
      expect(body).toContain('client_id=device-client');
      expect(body).toContain('scope=model.read+model.write');
      expect(init?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
      return jsonResponse(200, {
        device_code: 'dc_1',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://auth.example.com/activate',
        verification_uri_complete: 'https://auth.example.com/activate?code=ABCD-EFGH',
        expires_in: 900,
        interval: 3,
      });
    });

    const auth = await requestDeviceAuthorization(
      AUTH_URL,
      { clientId: 'device-client', scopes: ['model.read', 'model.write'] },
      fetchMock as never
    );
    expect(auth).toEqual({
      deviceCode: 'dc_1',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.example.com/activate',
      verificationUriComplete: 'https://auth.example.com/activate?code=ABCD-EFGH',
      expiresIn: 900,
      intervalSeconds: 3,
    });
  });

  it('defaults the poll interval to 5s and expiry to 10min when omitted', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, {
        device_code: 'dc',
        user_code: 'UC',
        verification_uri: 'https://auth.example.com/activate',
      })
    );
    const auth = await requestDeviceAuthorization(AUTH_URL, { clientId: 'c' }, fetchMock as never);
    expect(auth.intervalSeconds).toBe(5);
    expect(auth.expiresIn).toBe(600);
  });

  it('surfaces a provider rejection (bad client_id) as a non-retryable error', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: 'invalid_client', error_description: 'unknown client' })
    );
    await expect(
      requestDeviceAuthorization(AUTH_URL, { clientId: 'bogus' }, fetchMock as never)
    ).rejects.toMatchObject({ errorCode: 'invalid_client', retryable: false });
  });

  it('reports a malformed 2xx body instead of returning a half authorization', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { user_code: 'UC' }));
    await expect(
      requestDeviceAuthorization(AUTH_URL, { clientId: 'c' }, fetchMock as never)
    ).rejects.toMatchObject({ errorCode: 'invalid_response' });
  });

  it('maps a network failure to a retryable error', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(
      requestDeviceAuthorization(AUTH_URL, { clientId: 'c' }, fetchMock as never)
    ).rejects.toMatchObject({ errorCode: 'network_error', retryable: true });
  });
});

describe('device token polling (step 2)', () => {
  const state = {
    deviceCode: 'dc_1',
    intervalSeconds: 5,
    expiresAtMs: Date.now() + 600_000,
  };

  it('returns the token on success', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
      expect(body).toContain('device_code=dc_1');
      return jsonResponse(200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600 });
    });
    const out = await pollDeviceToken(TOKEN_URL, SPEC, state, fetchMock as never);
    expect(out).toMatchObject({ kind: 'token', token: { accessToken: 'at' } });
  });

  it('treats authorization_pending as a wait with the unchanged interval', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'authorization_pending' }));
    const out = await pollDeviceToken(TOKEN_URL, SPEC, state, fetchMock as never);
    expect(out).toEqual({ kind: 'pending', intervalSeconds: 5 });
  });

  it('raises the interval by exactly 5s on slow_down (RFC 8628 §3.5)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'slow_down' }));
    const out = await pollDeviceToken(TOKEN_URL, SPEC, state, fetchMock as never);
    expect(out).toEqual({ kind: 'pending', intervalSeconds: 5 + SLOW_DOWN_PENALTY_SECONDS });
  });

  it('stops on expired_token instead of polling forever', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'expired_token' }));
    expect(await pollDeviceToken(TOKEN_URL, SPEC, state, fetchMock as never)).toEqual({
      kind: 'expired',
    });
  });

  it('reports access_denied as a hard error', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: 'access_denied', error_description: 'user said no' })
    );
    const out = await pollDeviceToken(TOKEN_URL, SPEC, state, fetchMock as never);
    expect(out).toMatchObject({
      kind: 'error',
      error: { errorCode: 'access_denied', message: 'user said no', retryable: false },
    });
  });

  it('expires locally once the grant deadline passes, without a network call', async () => {
    const fetchMock = vi.fn();
    const expiredState = { ...state, expiresAtMs: Date.now() - 1 };
    const out = await pollDeviceToken(TOKEN_URL, SPEC, expiredState, fetchMock as never);
    expect(out).toEqual({ kind: 'expired' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('poll loop convenience wrapper', () => {
  it('keeps polling through pending states and settles on the token', async () => {
    const responses = [
      jsonResponse(400, { error: 'authorization_pending' }),
      jsonResponse(400, { error: 'slow_down' }),
      jsonResponse(200, { access_token: 'final', expires_in: 60 }),
    ];
    const sleeps: number[] = [];
    const fetchMock = vi.fn(async () => responses.shift() ?? jsonResponse(400, { error: 'authorization_pending' }));
    const out = await pollDeviceTokenUntilSettled(
      TOKEN_URL,
      SPEC,
      { deviceCode: 'dc', intervalSeconds: 5, expiresAtMs: Date.now() + 600_000 },
      async (ms) => {
        sleeps.push(ms);
      },
      fetchMock as never
    );
    expect(out).toMatchObject({ kind: 'token', token: { accessToken: 'final' } });
    expect(sleeps).toEqual([5000, 10000]);
  });

  it('gives up after maxAttempts instead of polling a dead grant forever', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: 'authorization_pending' }));
    const out = await pollDeviceTokenUntilSettled(
      TOKEN_URL,
      SPEC,
      { deviceCode: 'dc', intervalSeconds: 0, expiresAtMs: Date.now() + 600_000 },
      async () => undefined,
      fetchMock as never,
      Date.now,
      3
    );
    expect(out).toEqual({ kind: 'expired' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
