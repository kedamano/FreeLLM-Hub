import { describe, it, expect, beforeEach } from 'vitest';
import { RateLimiter } from '../../src/scheduler/rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(1000, 5);
  });

  it('should allow requests within limits', () => {
    expect(limiter.canProceed('provider1')).toBe(true);
  });

  it('should reserve quota atomically on canProceed', () => {
    for (let i = 0; i < 5; i++) {
      expect(limiter.canProceed('provider1', 10)).toBe(true);
    }
    expect(limiter.canProceed('provider1', 10)).toBe(false);
  });

  it('should block requests exceeding token limit', () => {
    expect(limiter.canProceed('provider1', 1001)).toBe(false);
  });

  it('should not reserve when the token check fails', () => {
    expect(limiter.canProceed('provider1', 1001)).toBe(false);
    expect(limiter.canProceed('provider1', 100)).toBe(true);
  });

  it('should use per-model limits when provided', () => {
    expect(limiter.canProceed('provider1', 10, { requestsPerMinute: 2 })).toBe(true);
    expect(limiter.canProceed('provider1', 10, { requestsPerMinute: 2 })).toBe(true);
    expect(limiter.canProceed('provider1', 10, { requestsPerMinute: 2 })).toBe(false);
  });

  it('should treat per-model token limits as the ceiling', () => {
    expect(limiter.canProceed('provider1', 50, { tokensPerMinute: 100 })).toBe(true);
    expect(limiter.canProceed('provider1', 50, { tokensPerMinute: 100 })).toBe(true);
    expect(limiter.canProceed('provider1', 10, { tokensPerMinute: 100 })).toBe(false);
  });

  it('should reconcile reserved estimate with record delta', () => {
    expect(limiter.canProceed('provider1', 500)).toBe(true);
    limiter.record('provider1', -500 + 50);
    expect(limiter.check('provider1', 900)).toBe(true);
    expect(limiter.check('provider1', 951)).toBe(false);
  });

  it('should keep check read-only', () => {
    limiter.record('provider1', 100);
    expect(limiter.check('provider1', 100)).toBe(true);
    expect(limiter.check('provider1', 100)).toBe(true);
  });

  it('should track different keys independently', () => {
    for (let i = 0; i < 5; i++) {
      limiter.canProceed('provider1', 10);
    }
    expect(limiter.canProceed('provider1')).toBe(false);
    expect(limiter.canProceed('provider2')).toBe(true);
  });

  it('should reset state', () => {
    for (let i = 0; i < 5; i++) {
      limiter.canProceed('provider1', 10);
    }
    expect(limiter.canProceed('provider1')).toBe(false);
    limiter.reset('provider1');
    expect(limiter.canProceed('provider1')).toBe(true);
  });

  it('should return retry after time', () => {
    for (let i = 0; i < 5; i++) {
      limiter.canProceed('provider1', 10);
    }
    const retryAfter = limiter.getRetryAfter('provider1');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60000);
  });
});
