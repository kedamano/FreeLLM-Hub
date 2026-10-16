import { describe, it, expect, beforeEach, vi } from 'vitest';
import { QuotaManager, type PersistedQuotaState } from '../../src/scheduler/quota-manager';

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

  it('should reset counters when the period expires', () => {
    manager.setConfig({ providerId: 'expiring', maxRequestsPerDay: 5 });
    manager.record('expiring', 5, 1000);
    expect(manager.canProceed('expiring', undefined, 10)).toBe(false);

    const usage = manager.getUsage('expiring');
    usage.periodEnd = new Date(Date.now() - 1000).toISOString();

    expect(manager.canProceed('expiring', undefined, 10)).toBe(true);
    expect(manager.getUsage('expiring').requestCount).toBe(0);
    expect(manager.getUsage('expiring').tokenCount).toBe(0);
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

  describe('quota scope', () => {
    it('enforces a provider-level quota for model scoped calls', () => {
      manager.setConfig({ providerId: 'groq', maxRequestsPerDay: 2 });

      // The scheduler always passes the model it is about to use; the provider
      // quota must still apply instead of silently looking unlimited.
      expect(manager.canProceed('groq', 'llama-3.3-70b', 500)).toBe(true);
      manager.record('groq', 1, 500, 'llama-3.3-70b');
      expect(manager.canProceed('groq', 'llama-3.3-70b', 500)).toBe(true);
      manager.record('groq', 1, 500, 'llama-3.3-70b');
      expect(manager.canProceed('groq', 'llama-3.3-70b', 500)).toBe(false);
      expect(manager.canProceed('groq', 'other-model', 500)).toBe(false);
    });

    it('aggregates usage from every model into the provider bucket', () => {
      manager.setConfig({ providerId: 'openrouter', maxTokensPerDay: 1000 });
      manager.record('openrouter', 1, 400, 'model-a');
      manager.record('openrouter', 1, 400, 'model-b');

      expect(manager.getUsage('openrouter').tokenCount).toBe(800);
      expect(manager.getUsage('openrouter', 'model-a').tokenCount).toBe(400);
      expect(manager.getRemainingQuota('openrouter', 'model-a').tokens).toBe(200);
      expect(manager.canProceed('openrouter', 'model-a', 300)).toBe(false);
    });

    it('prefers a model scoped config over the provider one', () => {
      manager.setConfig({ providerId: 'gemini', maxRequestsPerDay: 100 });
      manager.setConfig({ providerId: 'gemini', modelId: 'flash', maxRequestsPerDay: 1 });

      manager.record('gemini', 1, 10, 'flash');
      expect(manager.canProceed('gemini', 'flash', 10)).toBe(false);
      expect(manager.canProceed('gemini', 'pro', 10)).toBe(true);
    });

    it('treats a cleared config as unlimited again', () => {
      manager.setConfig({ providerId: 'xai', maxRequestsPerDay: 1 });
      manager.record('xai', 1, 10);
      expect(manager.canProceed('xai')).toBe(false);

      manager.clearConfig('xai');
      expect(manager.canProceed('xai')).toBe(true);
      expect(manager.getRemainingQuota('xai').unlimited).toBe(true);
    });
  });

  describe('quota persistence', () => {
    function fakePersistence(initial: PersistedQuotaState[] = []) {
      const rows = new Map<string, PersistedQuotaState>();
      for (const row of initial) {
        rows.set(`${row.providerId}|${row.modelId ?? ''}|${row.periodStart}`, row);
      }
      return {
        rows,
        load: vi.fn(() => Array.from(rows.values())),
        save: vi.fn((state: PersistedQuotaState) => {
          rows.set(`${state.providerId}|${state.modelId ?? ''}|${state.periodStart}`, state);
        }),
      };
    }

    it('restores usage so a daily quota survives a restart', () => {
      const periodEnd = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
      const periodStart = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const persistence = fakePersistence([
        { providerId: 'groq', modelId: undefined, requestCount: 5, tokenCount: 5000, periodStart, periodEnd },
      ]);

      manager.setPersistence(persistence);
      expect(manager.hydrate()).toBe(1);

      manager.setConfig({ providerId: 'groq', maxRequestsPerDay: 6 });
      expect(manager.canProceed('groq')).toBe(true);
      expect(manager.getRemainingQuota('groq').requests).toBe(1);
    });

    it('skips expired periods and writes through on record', () => {
      const past = new Date(Date.now() - 1000).toISOString();
      const persistence = fakePersistence([
        {
          providerId: 'stale',
          modelId: undefined,
          requestCount: 99,
          tokenCount: 99,
          periodStart: past,
          periodEnd: past,
        },
      ]);

      manager.setPersistence(persistence);
      expect(manager.hydrate()).toBe(0);

      manager.setConfig({ providerId: 'groq', maxRequestsPerDay: 10 });
      manager.record('groq', 1, 120);

      const saved = persistence.rows.get('groq||' + manager.getUsage('groq').periodStart)!;
      expect(saved.requestCount).toBe(1);
      expect(saved.tokenCount).toBe(120);
    });

    it('never lets a persistence failure break accounting', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      manager.setPersistence({ load: () => [], save: () => { throw new Error('SQLITE_BUSY'); } });
      manager.setConfig({ providerId: 'groq', maxRequestsPerDay: 10 });

      expect(() => manager.record('groq', 1, 100)).not.toThrow();
      expect(manager.getUsage('groq').requestCount).toBe(1);
      expect(warn).toHaveBeenCalledWith('[Quota] 用量持久化失败:', 'SQLITE_BUSY');
      warn.mockRestore();
    });
  });
});
