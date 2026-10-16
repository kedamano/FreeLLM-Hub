import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OAuthTokenManager,
  oauthSecretId,
  oauthTokenId,
  resolveOAuthSpec,
  storeClientSecret,
  type SecretStore,
  type SecretMeta,
} from '../../src/core/providers/oauth/oauth-manager';
import type { OAuthTokenSet } from '../../src/core/providers/oauth/oauth-core';

/** In-memory credential store; mirrors the shape the main process injects. */
function createFakeSecrets(): SecretStore & { rows: Map<string, { value: string; meta: SecretMeta }> } {
  const rows = new Map<string, { value: string; meta: SecretMeta }>();
  return {
    rows,
    store: (id, value, meta) => {
      rows.set(id, { value, meta: meta ?? {} });
    },
    retrieve: (id) => rows.get(id)?.value ?? null,
    readMetadata: (id) => rows.get(id)?.meta ?? null,
    updateStatus: (id, status) => {
      const row = rows.get(id);
      if (row) row.meta = { ...row.meta, status };
    },
    delete: (id) => rows.delete(id),
  };
}

const SPEC = {
  providerId: 'demo',
  displayName: 'Demo',
  authorizationUrl: 'https://auth.example.com/oauth2/authorize',
  tokenUrl: 'https://auth.example.com/oauth2/token',
  clientId: 'cid',
  scopes: ['model.read'],
  usePkce: true,
  baseUrl: 'https://api.example.com/v1',
};

function tokenWith(overrides: Partial<OAuthTokenSet>): OAuthTokenSet {
  return {
    accessToken: 'access-1',
    tokenType: 'Bearer',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    issuedAt: new Date().toISOString(),
    ...overrides,
  };
}

let secrets: ReturnType<typeof createFakeSecrets>;
let manager: OAuthTokenManager;

beforeEach(() => {
  secrets = createFakeSecrets();
  manager = new OAuthTokenManager(secrets, () => SPEC);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('credential custody', () => {
  it('stores the token set as one encrypted-payload blob with plaintext expiry metadata', () => {
    const token = tokenWith({ refreshToken: 'refresh-1', scope: 'model.read' });
    manager.saveToken('demo', token);

    const row = secrets.rows.get(oauthTokenId('demo'));
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toEqual(token);
    expect(row!.meta.kind).toBe('oauth');
    expect(row!.meta.refreshable).toBe(true);
    expect(row!.meta.expiresAt).toBe(token.expiresAt);
    // The metadata column is what lets the UI render "expiring soon" without decrypting.
    expect(row!.meta.status).toBe('active');
  });

  it('never exposes the refresh token through describe()', () => {
    manager.saveToken('demo', tokenWith({ refreshToken: 'super-secret-r' }));
    const described = manager.describe('demo');
    expect(JSON.stringify(described)).not.toContain('super-secret-r');
    expect(JSON.stringify(described)).not.toContain('access-1');
    expect(described.refreshable).toBe(true);
  });

  it('reports unconfigured until a token exists', () => {
    expect(manager.describe('demo').status).toBe('unconfigured');
    expect(manager.describe('demo').configured).toBe(false);
  });

  it('clearToken removes the blob so the provider falls back to unconfigured', () => {
    manager.saveToken('demo', tokenWith({}));
    manager.clearToken('demo');
    expect(secrets.rows.has(oauthTokenId('demo'))).toBe(false);
    expect(manager.describe('demo').status).toBe('unconfigured');
  });

  it('survives a corrupted stored blob instead of throwing', () => {
    secrets.store(oauthTokenId('demo'), 'not-json');
    expect(manager.loadToken('demo')).toBeNull();
    expect(manager.describe('demo').status).toBe('unconfigured');
  });
});

describe('getValidToken', () => {
  it('returns the cached token while it is far from expiry', async () => {
    manager.saveToken('demo', tokenWith({ expiresAt: new Date(Date.now() + 3600_000).toISOString() }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await manager.getValidToken('demo')).toBe('access-1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes proactively inside the skew window', async () => {
    manager.saveToken(
      'demo',
      tokenWith({
        refreshToken: 'r1',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    );
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: 'access-2', expires_in: 3600 }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    expect(await manager.getValidToken('demo')).toBe('access-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(manager.loadToken('demo')?.accessToken).toBe('access-2');
  });

  it('keeps the previous refresh token when the provider does not rotate it', async () => {
    manager.saveToken(
      'demo',
      tokenWith({ refreshToken: 'r1', expiresAt: new Date(Date.now() + 1000).toISOString() })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }), { status: 200 })
      )
    );

    await manager.getValidToken('demo');
    expect(manager.loadToken('demo')?.refreshToken).toBe('r1');
  });

  it('collapses concurrent expirations into a single refresh call', async () => {
    manager.saveToken(
      'demo',
      tokenWith({ refreshToken: 'r1', expiresAt: new Date(Date.now() + 1000).toISOString() })
    );
    let release: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = Promise.all([
      manager.getValidToken('demo'),
      manager.getValidToken('demo'),
      manager.getValidToken('demo'),
    ]);

    // Let the first call reach the token endpoint before the other two short-circuit.
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release?.(new Response(JSON.stringify({ access_token: 'a2', expires_in: 3600 }), { status: 200 }));

    expect(await pending).toEqual(['a2', 'a2', 'a2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the token expired and there is no refresh token', async () => {
    manager.saveToken(
      'demo',
      tokenWith({ expiresAt: new Date(Date.now() - 1000).toISOString(), refreshToken: undefined })
    );
    expect(await manager.getValidToken('demo')).toBeNull();
    expect(secrets.rows.get(oauthTokenId('demo'))?.meta.status).toBe('expired');
  });

  it('keeps serving the old token on a transient refresh failure', async () => {
    manager.saveToken(
      'demo',
      tokenWith({
        refreshToken: 'r1',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    );
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));

    expect(await manager.getValidToken('demo')).toBe('access-1');
  });

  it('treats invalid_grant as revocation and stops using the token', async () => {
    manager.saveToken(
      'demo',
      tokenWith({
        refreshToken: 'r1',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      })
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
      )
    );

    expect(await manager.getValidToken('demo')).toBe('access-1');
    expect(secrets.rows.get(oauthTokenId('demo'))?.meta.status).toBe('revoked');
    expect(manager.describe('demo').status).toBe('revoked');
  });
});

describe('spec resolution from provider settings', () => {
  const settingsRow = JSON.stringify({
    oauth: true,
    authorizationUrl: 'https://auth.example.com/oauth2/authorize',
    tokenUrl: 'https://auth.example.com/oauth2/token',
    clientId: 'cid',
    scopes: 'a b',
    usePkce: true,
  });

  it('builds a spec when the provider opts into OAuth', () => {
    const spec = resolveOAuthSpec('demo', 'Demo', 'https://api.example.com/v1', secrets, () => settingsRow);
    expect(spec?.clientId).toBe('cid');
    expect(spec?.scopes).toEqual(['a', 'b']);
    expect(spec?.baseUrl).toBe('https://api.example.com/v1');
  });

  it('returns null when OAuth is not opted in, so the api-key path stays', () => {
    expect(
      resolveOAuthSpec('demo', 'Demo', 'https://api.example.com/v1', secrets, () =>
        JSON.stringify({ accountId: 'x' })
      )
    ).toBeNull();
  });

  it('returns null for a malformed settings row instead of half-configuring', () => {
    expect(
      resolveOAuthSpec('demo', 'Demo', 'https://api.example.com/v1', secrets, () => '{oops')
    ).toBeNull();
    expect(
      resolveOAuthSpec(
        'demo',
        'Demo',
        'https://api.example.com/v1',
        secrets,
        () => JSON.stringify({ oauth: true, authorizationUrl: 'not-a-url', tokenUrl: 'https://x/y', clientId: 'c' })
      )
    ).toBeNull();
  });

  it('picks up a stored client secret', () => {
    storeClientSecret(secrets, 'demo', 'top-secret');
    const spec = resolveOAuthSpec('demo', 'Demo', 'https://api.example.com/v1', secrets, () => settingsRow);
    expect(spec?.clientSecret).toBe('top-secret');
    expect(secrets.rows.get(oauthSecretId('demo'))?.meta.kind).toBe('oauth-client-secret');
  });

  it('an empty secret clears the stored one', () => {
    storeClientSecret(secrets, 'demo', 'top-secret');
    storeClientSecret(secrets, 'demo', '   ');
    expect(secrets.rows.has(oauthSecretId('demo'))).toBe(false);
  });
});
