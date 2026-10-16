import { describe, it, expect, vi } from 'vitest';
import {
  OAuthTokenError,
  buildAuthorizationUrl,
  buildTokenRequest,
  canRefresh,
  createPkcePair,
  isExpired,
  parseTokenResponse,
  requestToken,
  shouldRefresh,
  tokenExpiresInMs,
  validatePkcePair,
  REFRESH_SKEW_MS,
  type OAuthProviderSpec,
} from '../../src/core/providers/oauth/oauth-core';

const BASE_SPEC: OAuthProviderSpec = {
  providerId: 'demo',
  displayName: 'Demo',
  authorizationUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  clientId: 'client-abc',
  scopes: ['openid', 'model.read'],
  usePkce: true,
  baseUrl: 'https://api.example.com/v1',
};

describe('PKCE', () => {
  it('produces an S256 challenge that re-derives from the verifier', () => {
    const pair = createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.challenge).not.toBe(pair.verifier);
    expect(validatePkcePair(pair)).toBe(true);
  });

  it('rejects a tampered challenge', () => {
    const pair = createPkcePair();
    expect(validatePkcePair({ ...pair, challenge: 'x'.repeat(43) })).toBe(false);
  });

  it('does not reuse a verifier across flows', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier);
  });
});

describe('buildAuthorizationUrl', () => {
  it('carries the RFC-required parameters', () => {
    const url = new URL(
      buildAuthorizationUrl({
        spec: BASE_SPEC,
        redirectUri: 'http://127.0.0.1:45000/oauth/callback',
        state: 'state-123',
        challenge: 'chal',
      })
    );

    expect(url.origin + url.pathname).toBe('https://auth.example.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:45000/oauth/callback');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toBe('openid model.read');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('omits PKCE for a provider configured without it and keeps extra params', () => {
    const url = new URL(
      buildAuthorizationUrl({
        spec: {
          ...BASE_SPEC,
          usePkce: false,
          extraAuthorizeParams: { audience: 'free-tier', prompt: 'consent' },
        },
        redirectUri: 'http://127.0.0.1:1/oauth/callback',
        state: 's',
      })
    );
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.get('audience')).toBe('free-tier');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('never lets an extra param overwrite a protocol parameter', () => {
    const url = new URL(
      buildAuthorizationUrl({
        spec: { ...BASE_SPEC, extraAuthorizeParams: { state: 'evil' } },
        redirectUri: 'http://127.0.0.1:1/oauth/callback',
        state: 'real',
        challenge: 'chal',
      })
    );
    expect(url.searchParams.getAll('state')).toEqual(['real']);
  });
});

describe('token expiry', () => {
  const now = Date.parse('2026-10-16T10:00:00.000Z');

  it('derives expiresAt from expires_in', () => {
    const token = parseTokenResponse(
      { access_token: 'a', expires_in: 3600, refresh_token: 'r', scope: 'openid' },
      BASE_SPEC,
      now
    );
    expect(token.expiresAt).toBe(new Date(now + 3_600_000).toISOString());
    expect(token.tokenType).toBe('Bearer');
    expect(canRefresh(token)).toBe(true);
    expect(tokenExpiresInMs(token, now)).toBe(3_600_000);
  });

  it('falls back to the spec default when the provider omits expires_in', () => {
    const token = parseTokenResponse(
      { access_token: 'a' },
      { ...BASE_SPEC, defaultExpiresInSeconds: 900 },
      now
    );
    expect(token.expiresAt).toBe(new Date(now + 900_000).toISOString());
  });

  it('keeps the old refresh token when the provider does not rotate it', () => {
    const token = parseTokenResponse({ access_token: 'a', expires_in: 60 }, BASE_SPEC, now);
    expect(token.refreshToken).toBeUndefined();
  });

  it('flags a token inside the refresh window but not yet expired', () => {
    const token = parseTokenResponse({ access_token: 'a', expires_in: 3600 }, BASE_SPEC, now);
    const almostDue = now + 3_600_000 - (REFRESH_SKEW_MS - 1000);
    expect(shouldRefresh(token, almostDue)).toBe(true);
    expect(isExpired(token, almostDue)).toBe(false);
    expect(shouldRefresh(token, now)).toBe(false);
  });

  it('throws a structured error when access_token is missing', () => {
    expect(() => parseTokenResponse({ error: 'invalid_grant' }, BASE_SPEC, now)).toThrowError(
      OAuthTokenError
    );
    try {
      parseTokenResponse({ error: 'invalid_grant', error_description: 'expired' }, BASE_SPEC, now);
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthTokenError);
      expect((err as OAuthTokenError).errorCode).toBe('invalid_grant');
      expect((err as OAuthTokenError).message).toBe('expired');
    }
  });
});

describe('buildTokenRequest', () => {
  it('sends client credentials in the form body by default', () => {
    const { body } = buildTokenRequest({}, {
      grantType: 'refresh_token',
      clientId: 'cid',
      clientSecret: 'secret',
      refreshToken: 'rt',
    });
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('refresh_token')).toBe('rt');
  });

  it('uses HTTP basic auth when the provider requires it', () => {
    const { body, headers } = buildTokenRequest(
      { clientAuthentication: 'basic' },
      {
        grantType: 'authorization_code',
        clientId: 'cid',
        clientSecret: 'secret',
        code: 'c1',
        redirectUri: 'http://127.0.0.1:1/cb',
        codeVerifier: 'verifier',
        clientAuthentication: 'basic',
      }
    );
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from('cid:secret', 'utf8').toString('base64')}`
    );
    expect(body.has('client_secret')).toBe(false);
    expect(body.get('code_verifier')).toBe('verifier');
  });

  it('refuses an authorization_code exchange without a code', () => {
    expect(() =>
      buildTokenRequest({}, { grantType: 'authorization_code', clientId: 'cid' })
    ).toThrowError(OAuthTokenError);
  });

  it('refuses a refresh without a refresh token', () => {
    expect(() =>
      buildTokenRequest({}, { grantType: 'refresh_token', clientId: 'cid' })
    ).toThrowError(/刷新令牌/);
  });
});

describe('requestToken', () => {
  const form = {
    grantType: 'refresh_token' as const,
    clientId: 'cid',
    refreshToken: 'rt',
  };

  it('posts a url-encoded body and parses the token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded'
      );
      return new Response(JSON.stringify({ access_token: 'new', expires_in: 120 }), {
        status: 200,
      });
    });

    const { token } = await requestToken(BASE_SPEC.tokenUrl, {}, form, fetchMock as never);
    expect(token.accessToken).toBe('new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a 4xx rejection onto a non-retryable OAuthTokenError', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );
    await expect(requestToken(BASE_SPEC.tokenUrl, {}, form, fetchMock as never)).rejects.toMatchObject(
      { errorCode: 'invalid_grant', status: 400, retryable: false }
    );
  });

  it('maps a 5xx rejection onto a retryable error so a live token is kept', async () => {
    const fetchMock = vi.fn(async () => new Response('gateway down', { status: 503 }));
    await expect(requestToken(BASE_SPEC.tokenUrl, {}, form, fetchMock as never)).rejects.toMatchObject({
      status: 503,
      retryable: true,
    });
  });

  it('reports a network failure as retryable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(requestToken(BASE_SPEC.tokenUrl, {}, form, fetchMock as never)).rejects.toMatchObject({
      errorCode: 'network_error',
      retryable: true,
    });
  });

  it('survives a non-JSON error body', async () => {
    const fetchMock = vi.fn(async () => new Response('<html>boom</html>', { status: 502 }));
    await expect(requestToken(BASE_SPEC.tokenUrl, {}, form, fetchMock as never)).rejects.toBeInstanceOf(
      OAuthTokenError
    );
  });
});
