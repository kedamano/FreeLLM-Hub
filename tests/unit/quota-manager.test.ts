import { describe, it, expect, beforeEach } from 'vitest';
import { QuotaManager } from '../../src/scheduler/quota-manager';

describe('QuotaManager', () => {
  let manager: QuotaManager;

  beforeEach(() => {
    manager = new QuotaManager();
  });

  it('should allow proceeding without config (unlimited)', () => {
    expect(manager.canProceed('unknown-provider')).toBe(true);
  });

  it('should track and enforce request limits', () => {
    manager.setConfig({ providerId: 'groq', maxRequestsPerDay: 5 });
    expect(manager.canProceed('groq')).toBe(true);

    manager.record('groq', 5, 1000);
    expect(manager.canProceed('groq')).toBe(false);
  });

  it('should track and enforce token limits', () => {
    manager.setConfig({ providerId: 'gemini', maxTokensPerDay: 10000 });
    expect(manager.canProceed('gemini', undefined, 5000)).toBe(true);

    manager.record('gemini', 1, 5000);
    // 5000 used + 4000 requested = 9000 <= 10000, should pass
    expect(manager.canProceed('gemini', undefined, 4000)).toBe(true);
    // 5000 used + 6000 requested = 11000 > 10000, should fail
    expect(manager.canProceed('gemini', undefined, 6000)).toBe(false);
    // 5000 used + 1000 requested = 6000 <= 10000, should pass
    expect(manager.canProceed('gemini', undefined, 1000)).toBe(true);
  });

  it('should track usage correctly', () => {
    manager.setConfig({ providerId: 'test', maxRequestsPerDay: 100, maxTokensPerDay: 100000 });
    manager.record('test', 3, 5000);
    manager.record('test', 2, 3000);

    const usage = manager.getUsage('test');
    expect(usage.requestCount).toBe(5);
    expect(usage.tokenCount).toBe(8000);
  });

  it('should calculate remaining quota', () => {
    manager.setConfig({ providerId: 'cf', maxRequestsPerDay: 100, maxTokensPerDay: 50000 });
    manager.record('cf', 20, 10000);

    const remaining = manager.getRemainingQuota('cf');
    expect(remaining.requests).toBe(80);
    expect(remaining.tokens).toBe(40000);
    expect(remaining.unlimited).toBe(false);
  });

  it('should report unlimited for unconfigured provider', () => {
    const remaining = manager.getRemainingQuota('unknown');
    expect(remaining.unlimited).toBe(true);
  });

  it('should reset period', () => {
    manager.setConfig({ providerId: 'test', maxRequestsPerDay: 10 });
    manager.record('test', 8, 5000);
    expect(manager.canProceed('test')).toBe(true);

    manager.record('test', 3, 1000);
    expect(manager.canProceed('test')).toBe(false);

    manager.resetPeriod('test');
    expect(manager.canProceed('test')).toBe(true);
  });

  it('should reset all providers', () => {
    manager.setConfig({ providerId: 'p1', maxRequestsPerDay: 5 });
    manager.setConfig({ providerId: 'p2', maxRequestsPerDay: 5 });
    manager.record('p1', 5, 0);
    manager.record('p2', 5, 0);

    expect(manager.canProceed('p1')).toBe(false);
    expect(manager.canProceed('p2')).toBe(false);

    manager.resetAll();
    expect(manager.canProceed('p1')).toBe(true);
    expect(manager.canProceed('p2')).toBe(true);
  });
});
