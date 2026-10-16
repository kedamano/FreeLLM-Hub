import { describe, it, expect, vi } from 'vitest';
import { isAllowedChannel, sanitizeIpcInput } from '../../src/main/security/ipc-guard';

const { registeredChannels, handlerRegistry, ipcMainMock } = vi.hoisted(() => {
  const registeredChannels: string[] = [];
  const handlerRegistry = new Map<string, (event: any, ...args: any[]) => Promise<unknown>>();
  return {
    registeredChannels,
    handlerRegistry,
    ipcMainMock: {
      handle: (channel: string, handler: (event: any, ...args: any[]) => Promise<unknown>) => {
        registeredChannels.push(channel);
        handlerRegistry.set(channel, handler);
      },
    },
  };
});

vi.mock('electron', () => ({ ipcMain: ipcMainMock }));

import { registerIpcHandler } from '../../src/main/ipc/handle';

describe('ipc-guard', () => {
  describe('isAllowedChannel', () => {
    it('should allow known provider channels', () => {
      expect(isAllowedChannel('providers:list')).toBe(true);
      expect(isAllowedChannel('providers:get')).toBe(true);
      expect(isAllowedChannel('providers:test')).toBe(true);
      expect(isAllowedChannel('providers:set-credential')).toBe(true);
      expect(isAllowedChannel('providers:remove-credential')).toBe(true);
      expect(isAllowedChannel('providers:toggle')).toBe(true);
      expect(isAllowedChannel('providers:update-baseurl')).toBe(true);
      expect(isAllowedChannel('providers:discover-models')).toBe(true);
    });

    it('should allow known model channels', () => {
      expect(isAllowedChannel('models:list')).toBe(true);
      expect(isAllowedChannel('models:get')).toBe(true);
      expect(isAllowedChannel('models:discover')).toBe(true);
      expect(isAllowedChannel('models:refresh')).toBe(true);
    });

    it('should allow scheduler channels', () => {
      expect(isAllowedChannel('scheduler:status')).toBe(true);
      expect(isAllowedChannel('scheduler:reset-circuit')).toBe(true);
      expect(isAllowedChannel('scheduler:reset-all-circuits')).toBe(true);
    });

    it('should allow settings, usage, gateway and app channels', () => {
      expect(isAllowedChannel('settings:get')).toBe(true);
      expect(isAllowedChannel('settings:set')).toBe(true);
      expect(isAllowedChannel('settings:get-all')).toBe(true);
      expect(isAllowedChannel('usage:dashboard')).toBe(true);
      expect(isAllowedChannel('usage:provider-stats')).toBe(true);
      expect(isAllowedChannel('usage:daily-stats')).toBe(true);
      expect(isAllowedChannel('usage:recent-calls')).toBe(true);
      expect(isAllowedChannel('gateway:getStatus')).toBe(true);
      expect(isAllowedChannel('gateway:getToken')).toBe(true);
      expect(isAllowedChannel('gateway:generateToken')).toBe(true);
      expect(isAllowedChannel('gateway:updateConfig')).toBe(true);
      expect(isAllowedChannel('app:version')).toBe(true);
      expect(isAllowedChannel('app:data-path')).toBe(true);
    });

    it('should reject unknown channels', () => {
      expect(isAllowedChannel('providers:destroy')).toBe(false);
      expect(isAllowedChannel('system:exec')).toBe(false);
      expect(isAllowedChannel('fs:readFile')).toBe(false);
      expect(isAllowedChannel('')).toBe(false);
      expect(isAllowedChannel('random-channel')).toBe(false);
    });
  });

  describe('sanitizeIpcInput', () => {
    it('should truncate long strings', () => {
      const long = 'a'.repeat(20000);
      const result = sanitizeIpcInput(long) as string;
      expect(result.length).toBe(10000);
    });

    it('should clamp non-finite numbers', () => {
      expect(sanitizeIpcInput(NaN)).toBe(0);
      expect(sanitizeIpcInput(Infinity)).toBe(0);
      expect(sanitizeIpcInput(-Infinity)).toBe(0);
    });

    it('should preserve valid numbers', () => {
      expect(sanitizeIpcInput(42)).toBe(42);
      expect(sanitizeIpcInput(3.14)).toBe(3.14);
      expect(sanitizeIpcInput(0)).toBe(0);
    });

    it('should limit array size', () => {
      const array = Array.from({ length: 2000 }, (_, i) => i);
      const result = sanitizeIpcInput(array) as unknown[];
      expect(result.length).toBe(1000);
    });

    it('should limit object key length', () => {
      const obj: Record<string, unknown> = {};
      obj['a'.repeat(300)] = 'value';
      obj['short'] = 'visible';
      const result = sanitizeIpcInput(obj) as Record<string, unknown>;
      expect(result['short']).toBe('visible');
      expect(result['a'.repeat(300)]).toBeUndefined();
    });

    it('should handle nested structures', () => {
      const input = {
        name: 'test',
        data: { key: 'a'.repeat(15000) },
      };
      const result = sanitizeIpcInput(input) as { data: { key: string } };
      expect(result.name).toBe('test');
      expect(result.data.key.length).toBe(10000);
    });
  });

  describe('registerIpcHandler', () => {
    const validEvent = { sender: { isDestroyed: () => false } } as never;

    const getHandler = (channel: string) => {
      const handler = handlerRegistry.get(channel);
      if (!handler) throw new Error(`Handler not registered for ${channel}`);
      return handler;
    };

    it('registers allowlisted channels only', () => {
      registerIpcHandler('usage:dashboard', async () => ({ totalRequests: 0 }));
      registerIpcHandler('system:exec', async () => 'nope');

      expect(registeredChannels).toContain('usage:dashboard');
      expect(registeredChannels).not.toContain('system:exec');
    });

    it('returns the handler payload on success', async () => {
      registerIpcHandler('app:version', async () => '1.2.3');
      await expect(getHandler('app:version')(validEvent)).resolves.toBe('1.2.3');
    });

    it('rejects handlers for destroyed senders', async () => {
      registerIpcHandler('models:list', async () => []);
      const destroyed = { sender: { isDestroyed: () => true } } as never;
      await expect(getHandler('models:list')(destroyed)).resolves.toEqual({
        success: false,
        error: 'Invalid IPC sender',
      });
    });

    it('returns a consistent error envelope and redacts secrets', async () => {
      registerIpcHandler('scheduler:status', async () => {
        throw new Error('auth failed with Bearer sk-abcdefghijklmnopqrstuvwxyz');
      });
      const result = (await getHandler('scheduler:status')(validEvent)) as {
        success: boolean;
        error: string;
      };
      expect(result.success).toBe(false);
      expect(result.error).not.toContain('bcdefghijklmnopqrstuvwxyz');
      expect(result.error).toContain('****');
    });

    it('sanitizes oversized string arguments', async () => {
      registerIpcHandler('settings:set', async (_e, key: string, value: string) => ({
        key,
        length: value.length,
      }));
      const result = (await getHandler('settings:set')(validEvent, 'theme', 'x'.repeat(20000))) as {
        key: string;
        length: number;
      };
      expect(result.length).toBe(10000);
    });
  });
});
