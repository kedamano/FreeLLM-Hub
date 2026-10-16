import { describe, it, expect } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  assertAdminBindAllowed,
  canRevealCredential,
  isLoopbackAddress,
  tokenEquals,
} from '../../src/server/admin-auth';

const req = (ip: string, authorization?: string) =>
  ({ ip, headers: authorization ? { authorization } : {} }) as unknown as FastifyRequest;

describe('admin auth helpers', () => {
  it('recognises every loopback spelling', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.64.1.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('rejects routable and missing addresses', () => {
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress('::ffff:192.168.1.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('refuses an unauthenticated bind outside loopback', () => {
    expect(() => assertAdminBindAllowed('127.0.0.1', null)).not.toThrow();
    expect(() => assertAdminBindAllowed('localhost', null)).not.toThrow();
    expect(() => assertAdminBindAllowed('0.0.0.0', 'secret')).not.toThrow();
    expect(() => assertAdminBindAllowed('192.168.1.5', null)).toThrow(/ADMIN_TOKEN/);
    expect(() => assertAdminBindAllowed('0.0.0.0', null)).toThrow(/without authentication/);
  });

  it('compares tokens without throwing on length mismatch', () => {
    expect(tokenEquals('fh_exact_token!', 'fh_exact_token!')).toBe(true);
    expect(tokenEquals('short', 'aaaaaaaaaaaaaaaa')).toBe(false);
    expect(tokenEquals('', '')).toBe(true);
  });

  it('lets a token-holder reveal from anywhere but restricts the tokenless case to loopback', () => {
    expect(canRevealCredential(req('10.0.0.7'), 'admin-secret').ok).toBe(true);
    expect(canRevealCredential(req('127.0.0.1'), null).ok).toBe(true);

    const blocked = canRevealCredential(req('10.0.0.7'), null);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toContain('ADMIN_TOKEN');
  });
});
