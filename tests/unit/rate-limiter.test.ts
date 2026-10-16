import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../src/scheduler/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(1000, 5);
  });

  it('should allow requests within limits', () => {
    expect(limiter.acquire('provider1')).toBe(true);
  });

  it('should reserve quota atomically on acquire', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.acquire('provider1', 10)).toBe(true);
    }
    expect(limiter.acquire('provider1', 10)).toBe(false);
  });

  it('should block requests exceeding token limit', () => {
    expect(limiter.acquire('provider1', 1001)).toBe(false);
  });

  it('should not reserve when the token check fails', () => {
    expect(limiter.acquire('provider1', 1001)).toBe(false);
    expect(limiter.acquire('provider1', 100)).toBe(true);
  });

  it('should use per-model limits when provided', () => {
    expect(limiter.acquire('provider1', 10, { requestsPerMinute: 2 })).toBe(true);
    expect(limiter.acquire('provider1', 10, { requestsPerMinute: 2 })).toBe(true);
    expect(limiter.acquire('provider1', 10, { requestsPerMinute: 2 })).toBe(false);
  });

  it('should treat per-model token limits as the ceiling', () => {
    expect(limiter.acquire('provider1', 50, { tokensPerMinute: 100 })).toBe(true);
    expect(limiter.acquire('provider1', 50, { tokensPerMinute: 100 })).toBe(true);
    expect(limiter.acquire('provider1', 10, { tokensPerMinute: 100 })).toBe(false);
  });

  it('should reconcile reserved estimate with record delta', () => {
    expect(limiter.acquire('provider1', 500)).toBe(true);
    limiter.record('provider1', -500 + 50);
    expect(limiter.check('provider1', 900)).toBe(true);
    expect(limiter.check('provider1', 951)).toBe(false);
  });

  it('should keep check read-only', () => {
    limiter.record('provider1', 100);
    expect(limiter.check('provider1', 100)).toBe(true);
    expect(limiter.check('provider1', 100)).toBe(true);
  });

  it('should release both the request slot and the token estimate on rollback', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.acquire('provider1', 100)).toBe(true);
    }
    expect(limiter.acquire('provider1', 100)).toBe(false);

    limiter.rollback('provider1', 100);

    expect(limiter.acquire('provider1', 100)).toBe(true);
  });

  it('should not let a rolled-back probe consume window capacity', () => {
    expect(limiter.acquire('provider1', 900)).toBe(true);
    expect(limiter.check('provider1', 200)).toBe(false);

    limiter.rollback('provider1', 900);

    expect(limiter.check('provider1', 1000)).toBe(true);
  });

  it('should ignore rollback for unknown keys and never go below zero', () => {
    expect(() => limiter.rollback('never-seen', 500)).not.toThrow();
    limiter.acquire('provider1', 100);
    limiter.rollback('provider1', 500);
    expect(limiter.check('provider1', 1000)).toBe(true);
  });

  it('should track different keys independently', () => {
    for (let i = 0; i < 5; i++) {
      limiter.acquire('provider1', 10);
    }
    expect(limiter.acquire('provider1')).toBe(false);
    expect(limiter.acquire('provider2')).toBe(true);
  });

  it('should reset state', () => {
    for (let i = 0; i < 5; i++) {
      limiter.acquire('provider1', 10);
    }
    expect(limiter.acquire('provider1')).toBe(false);
    limiter.reset('provider1');
    expect(limiter.acquire('provider1')).toBe(true);
  });

  it('should return retry after time', () => {
    for (let i = 0; i < 5; i++) {
      limiter.acquire('provider1', 10);
    }
    const retryAfter = limiter.getRetryAfter('provider1');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60000);
  });
});
