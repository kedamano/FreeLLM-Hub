import { describe, it, expect, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../src/scheduler/circuit-breaker';

describe('CircuitBreaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      failureThreshold: 3,
      resetTimeoutMs: 100,
      halfOpenMaxRequests: 1,
    });
  });

  it('should start in closed state', () => {
    expect(breaker.canExecute('provider1')).toBe(true);
    expect(breaker.isClosed('provider1')).toBe(true);
  });

  it('should open after threshold failures', () => {
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');

    expect(breaker.canExecute('provider1')).toBe(false);
    expect(breaker.isClosed('provider1')).toBe(false);
  });

  it('should reset to half-open after timeout', async () => {
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');

    expect(breaker.canExecute('provider1')).toBe(false);

    await new Promise((r) => setTimeout(r, 150));

    expect(breaker.canExecute('provider1')).toBe(true);
  });

  it('should close on success after half-open', async () => {
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');

    await new Promise((r) => setTimeout(r, 150));

    breaker.recordSuccess('provider1');
    expect(breaker.isClosed('provider1')).toBe(true);
  });

  it('should cap concurrent requests in half-open', async () => {
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');

    await new Promise((r) => setTimeout(r, 150));

    expect(breaker.canExecute('provider1')).toBe(true);
    expect(breaker.canExecute('provider1')).toBe(false);
  });

  it('should free a half-open slot on release', async () => {
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');

    await new Promise((r) => setTimeout(r, 150));

    expect(breaker.canExecute('provider1')).toBe(true);
    breaker.release('provider1');
    expect(breaker.canExecute('provider1')).toBe(true);
  });

  it('should reopen immediately on a half-open failure', async () => {
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');
    breaker.recordFailure('provider1');

    await new Promise((r) => setTimeout(r, 150));

    expect(breaker.canExecute('provider1')).toBe(true);
    breaker.recordFailure('provider1');
    expect(breaker.canExecute('provider1')).toBe(false);
  });

  it('should reset state', () => {
    breaker.recordFailure('provider1');
    breaker.reset('provider1');
    expect(breaker.isClosed('provider1')).toBe(true);
  });

  it('should reset all states', () => {
    breaker.recordFailure('p1');
    breaker.recordFailure('p2');
    breaker.resetAll();
    expect(breaker.isClosed('p1')).toBe(true);
    expect(breaker.isClosed('p2')).toBe(true);
  });
});
