import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS, type IpcChannel } from '../../src/shared/ipc-channels.js';
import { ADMIN_ROUTE_BINDINGS, routeParams, routeUrl } from '../../src/shared/api-contract.js';

describe('admin route contract', () => {
  it('binds exactly the declared IPC channels', () => {
    const bound = Object.keys(ADMIN_ROUTE_BINDINGS).sort();
    expect(bound).toEqual([...IPC_CHANNELS].sort());
  });

  it('declares paths relative to /api with a leading slash', () => {
    for (const [channel, binding] of Object.entries(ADMIN_ROUTE_BINDINGS)) {
      expect(binding.path.startsWith('/'), channel).toBe(true);
      expect(binding.path.startsWith('/api/'), channel).toBe(false);
      expect(binding.path, channel).not.toContain('?');
      expect(['GET', 'POST', 'PUT', 'DELETE'], channel).toContain(binding.method);
    }
  });

  it('uses unique named parameters and no bare :id', () => {
    for (const [channel, binding] of Object.entries(ADMIN_ROUTE_BINDINGS)) {
      const names = routeParams(channel as IpcChannel);
      expect(new Set(names).size, channel).toBe(names.length);
      expect(names, channel).not.toContain('id');
      expect(binding.path.match(/:/g)?.length ?? 0, channel).toBe(names.length);
    }
  });

  it('fills and encodes parameters', () => {
    expect(routeUrl('providers:get', { providerId: 'groq' })).toBe('/providers/groq');
    expect(routeUrl('providers:remove-credential-slot', { providerId: 'groq', index: 2 })).toBe(
      '/providers/groq/credentials/2'
    );
    expect(routeUrl('models:get', { providerId: 'a b/c', modelId: 'm#1' })).toBe(
      '/models/a%20b%2Fc/m%231'
    );
    expect(routeUrl('profiles:list')).toBe('/profiles');
  });

  it('rejects a missing or unknown parameter instead of building a wrong URL', () => {
    expect(() => routeUrl('providers:get', {})).toThrow(/missing the 'providerId'/);
    expect(() => routeUrl('providers:get', { providerId: 'groq', index: 1 })).toThrow(
      /does not declare a 'index'/
    );
    expect(() => routeUrl('models:list', { unexpected: 'x' })).toThrow(/does not declare/);
  });
});
