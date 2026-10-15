import { describe, it, expect } from 'vitest';
import { RetryPolicy } from '../../src/scheduler/retry-policy';

describe('RetryPolicy', () => {
  it('should allow retry within max retries', () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, retryableErrors: ['RATE_LIMITED', 'TIMEOUT'] });
    expect(policy.shouldRetry(0)).toBe(true);
    expect(policy.shouldRetry(1)).toBe(true);
    expect(policy.shouldRetry(2)).toBe(true);
  });

  it('should not allow retry beyond max retries', () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, retryableErrors: ['RATE_LIMITED'] });
    expect(policy.shouldRetry(3)).toBe(false);
    expect(policy.shouldRetry(5)).toBe(false);
  });

  it('should not retry non-retryable errors', () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, retryableErrors: ['RATE_LIMITED'] });
    expect(policy.shouldRetry(0, 'AUTH_FAILED')).toBe(false);
    expect(policy.shouldRetry(0, 'MODEL_NOT_FOUND')).toBe(false);
  });

  it('should allow retry for retryable errors', () => {
    const policy = new RetryPolicy({ maxRetries: 3, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, retryableErrors: ['RATE_LIMITED', 'TIMEOUT', 'SERVER_ERROR'] });
    expect(policy.shouldRetry(0, 'RATE_LIMITED')).toBe(true);
    expect(policy.shouldRetry(1, 'TIMEOUT')).toBe(true);
    expect(policy.shouldRetry(0, 'SERVER_ERROR')).toBe(true);
  });

  it('should use exponential backoff for delays', () => {
    const policy = new RetryPolicy({ maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 60000, backoffMultiplier: 2, retryableErrors: [] });
    expect(policy.getDelay(0)).toBe(1000);
    expect(policy.getDelay(1)).toBe(2000);
    expect(policy.getDelay(2)).toBe(4000);
    expect(policy.getDelay(3)).toBe(8000);
    expect(policy.getDelay(4)).toBe(16000);
  });

  it('should cap delay at maxDelayMs', () => {
    const policy = new RetryPolicy({ maxRetries: 10, baseDelayMs: 1000, maxDelayMs: 5000, backoffMultiplier: 2, retryableErrors: [] });
    expect(policy.getDelay(0)).toBe(1000);
    expect(policy.getDelay(1)).toBe(2000);
    expect(policy.getDelay(2)).toBe(4000);
    expect(policy.getDelay(3)).toBe(5000);
    expect(policy.getDelay(10)).toBe(5000);
  });

  it('should return correct max retries', () => {
    const policy = new RetryPolicy({ maxRetries: 5, baseDelayMs: 100, maxDelayMs: 5000, backoffMultiplier: 2, retryableErrors: [] });
    expect(policy.getMaxRetries()).toBe(5);
  });
});
