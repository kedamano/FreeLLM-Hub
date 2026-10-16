// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getFreellmApi, getAdminToken, setAdminToken } from '../../src/renderer/src/hooks/useIPC';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('HTTP api client in web mode', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete (window as { freellm?: unknown }).freellm;
    localStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends no Authorization header until an admin token is stored', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await getFreellmApi()!.providers.list();
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('attaches the stored admin token as a bearer header', async () => {
    setAdminToken('admin-open-token');
    expect(getAdminToken()).toBe('admin-open-token');

    fetchMock.mockResolvedValue(jsonResponse([]));
    await getFreellmApi()!.providers.list();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/providers');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer admin-open-token');
  });

  it('keeps the JSON content type alongside the bearer header', async () => {
    setAdminToken('admin-open-token');
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));
    await getFreellmApi()!.providers.setCredential('groq', 'sk-local-test');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer admin-open-token');
  });

  it('reveals plaintext only through the dedicated POST route', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ credential: 'sk-local-test' }));
    const res = await getFreellmApi()!.providers.revealCredential('groq', 2);

    expect(res).toEqual({ credential: 'sk-local-test' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/providers/groq/credential/reveal');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ index: 2 });
  });

  it('explains a 401 as a missing admin token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false }, 401));
    await expect(getFreellmApi()!.providers.list()).rejects.toThrow(/管理令牌/);
  });

  it('forgetting the token removes the header', () => {
    setAdminToken('admin-open-token');
    setAdminToken('');
    expect(getAdminToken()).toBe('');
    expect(localStorage.getItem('freellm.adminToken')).toBeNull();
  });
});
