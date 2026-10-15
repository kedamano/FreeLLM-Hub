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

  it('should block requests exceeding request count limit', () => {
    for (let i = 0; i < 5; i++) {
      limiter.record('provider1', 10);
    }
    expect(limiter.canProceed('provider1')).toBe(false);
  });

  it('should block requests exceeding token limit', () => {
    expect(limiter.canProceed('provider1', 1001)).toBe(false);
  });

  it('should track different keys independently', () => {
    for (let i = 0; i < 5; i++) {
      limiter.record('provider1', 10);
    }
    expect(limiter.canProceed('provider1')).toBe(false);
    expect(limiter.canProceed('provider2')).toBe(true);
  });

  it('should reset state', () => {
    for (let i = 0; i < 5; i++) {
      limiter.record('provider1', 10);
    }
    expect(limiter.canProceed('provider1')).toBe(false);
    limiter.reset('provider1');
    expect(limiter.canProceed('provider1')).toBe(true);
  });

  it('should return retry after time', () => {
    for (let i = 0; i < 5; i++) {
      limiter.record('provider1', 10);
    }
    const retryAfter = limiter.getRetryAfter('provider1');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60000);
  });
});
