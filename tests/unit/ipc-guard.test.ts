import { describe, it, expect } from 'vitest';
import { isAllowedChannel, sanitizeIpcInput } from '../../src/main/security/ipc-guard';

describe('ipc-guard', () => {
  describe('isAllowedChannel', () => {
    it('should allow known provider channels', () => {
      expect(isAllowedChannel('providers:list')).toBe(true);
      expect(isAllowedChannel('providers:get')).toBe(true);
      expect(isAllowedChannel('providers:test')).toBe(true);
      expect(isAllowedChannel('providers:set-credential')).toBe(true);
      expect(isAllowedChannel('providers:remove-credential')).toBe(true);
      expect(isAllowedChannel('providers:toggle')).toBe(true);
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
    });

    it('should allow settings and usage channels', () => {
      expect(isAllowedChannel('settings:get')).toBe(true);
      expect(isAllowedChannel('settings:set')).toBe(true);
      expect(isAllowedChannel('usage:dashboard')).toBe(true);
      expect(isAllowedChannel('gateway:port')).toBe(true);
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
});
