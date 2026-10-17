import type { ProviderId } from '../shared/types/index.js';
import { parseResetPolicy, resetPolicyKey, windowFor, type QuotaResetPolicy } from './reset-policy.js';
import { loggerFor } from '../core/log/logger.js';

const log = loggerFor('quota');

interface QuotaState {
  providerId: ProviderId;
  modelId?: string;
  requestCount: number;
  tokenCount: number;
  /** Accumulated USD for the window, so the quota panel needs no log scan. */
  costUsd: number;
  periodStart: string;
  periodEnd: string;
}

export interface QuotaConfig {
  maxRequestsPerDay?: number;
  maxTokensPerDay?: number;
  providerId: ProviderId;
  modelId?: string;
  /**
   * How the daily window is anchored. Defaults to the historical rolling 24h;
   * 'utc-daily' matches free tiers that reset at UTC midnight.
   */
  resetPolicy?: QuotaResetPolicy;
}

export interface PersistedQuotaState {
  providerId: ProviderId;
  modelId?: string;
  requestCount: number;
  tokenCount: number;
  costUsd?: number;
  periodStart: string;
  periodEnd: string;
}

/** One completed call, expressed as an increment rather than a snapshot. */
export interface QuotaDelta {
  providerId: ProviderId;
  modelId?: string;
  requests: number;
  tokens: number;
  costUsd: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * Optional write-through port so daily usage survives a restart. Without it the
 * manager stays purely in memory.
 */
export interface QuotaPersistence {
  load(): PersistedQuotaState[];
  /**
   * Add to the open window. Increments — not absolute values — are what let a second
   * process sharing this database contribute instead of overwriting the first one's
   * totals with its own (stale) snapshot.
   */
  add(delta: QuotaDelta): void;
  /** Absolute write, used only by explicit resets where overwriting is the whole point. */
  save(state: PersistedQuotaState): void;
}

export class QuotaManager {
  private quotas = new Map<string, QuotaState>();
  private configs = new Map<string, QuotaConfig>();
  private persistence?: QuotaPersistence;

  setConfig(config: QuotaConfig): void {
    const key = this.getKey(config.providerId, config.modelId);
    this.configs.set(key, config);
  }

  /** Removing the config is what "no daily limit" means; a zero-limit config would be a lie. */
  clearConfig(providerId: ProviderId, modelId?: string): void {
    this.configs.delete(this.getKey(providerId, modelId));
  }

  setPersistence(persistence?: QuotaPersistence): void {
    this.persistence = persistence;
  }

  /** Restore usage for periods that have not expired yet. Returns rows restored. */
  hydrate(): number {
    if (!this.persistence) return 0;

    let restored = 0;
    for (const row of this.persistence.load()) {
      if (new Date(row.periodEnd).getTime() <= Date.now()) continue;
      const modelId = row.modelId || undefined;
      this.quotas.set(this.getKey(row.providerId, modelId), {
        providerId: row.providerId,
        modelId,
        requestCount: row.requestCount,
        tokenCount: row.tokenCount,
        costUsd: row.costUsd ?? 0,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      });
      restored++;
    }
    return restored;
  }

  /**
   * Drop every in-memory usage bucket without writing anything. Used when switching
   * configuration profiles: each profile keeps its own daily counters in
   * `quota_tracking`, so the next `hydrate()` reloads the right ones.
   */
  clearUsageState(): void {
    this.quotas.clear();
  }

  /** Drop every configured limit as well as usage — the profile switch path. */
  clearAllConfigs(): void {
    this.configs.clear();
  }

  getConfiguredProviderIds(): ProviderId[] {
    return [...this.configs.values()].map((config) => config.providerId);
  }

  canProceed(providerId: ProviderId, modelId?: string, estimatedTokens?: number): boolean {
    const config = this.findConfig(providerId, modelId);
    if (!config) return true;

    const state = this.getOrCreateState(config.providerId, config.modelId);

    if (config.maxRequestsPerDay && state.requestCount >= config.maxRequestsPerDay) {
      return false;
    }

    if (
      config.maxTokensPerDay &&
      estimatedTokens &&
      state.tokenCount + estimatedTokens > config.maxTokensPerDay
    ) {
      return false;
    }

    return true;
  }

  record(
    providerId: ProviderId,
    requests: number = 1,
    tokens: number = 0,
    modelId?: string,
    costUsd: number = 0
  ): void {
    // Charge the model bucket when the call was model scoped...
    const state = this.getOrCreateState(providerId, modelId);
    state.requestCount += requests;
    state.tokenCount += tokens;
    state.costUsd += costUsd;
    this.persistDelta(state, requests, tokens, costUsd);

    // ...and always keep the provider bucket in sync, because that is the scope
    // a daily quota is normally configured against.
    if (modelId) {
      const providerState = this.getOrCreateState(providerId);
      providerState.requestCount += requests;
      providerState.tokenCount += tokens;
      providerState.costUsd += costUsd;
      this.persistDelta(providerState, requests, tokens, costUsd);
    }
  }

  getUsage(providerId: ProviderId, modelId?: string): QuotaState {
    return this.getOrCreateState(providerId, modelId);
  }

  getRemainingQuota(
    providerId: ProviderId,
    modelId?: string
  ): { requests?: number; tokens?: number; unlimited: boolean } {
    const config = this.findConfig(providerId, modelId);
    if (!config) {
      return { unlimited: true };
    }

    const state = this.getOrCreateState(config.providerId, config.modelId);

    return {
      requests: config.maxRequestsPerDay
        ? Math.max(0, config.maxRequestsPerDay - state.requestCount)
        : undefined,
      tokens: config.maxTokensPerDay
        ? Math.max(0, config.maxTokensPerDay - state.tokenCount)
        : undefined,
      unlimited: false,
    };
  }

  resetPeriod(providerId: ProviderId, modelId?: string): void {
    const state = this.createState(providerId, modelId);
    this.quotas.set(this.getKey(providerId, modelId), state);
    this.persist(state);
  }

  resetAll(): void {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    for (const [key, state] of this.quotas) {
      const reset: QuotaState = {
        ...state,
        requestCount: 0,
        tokenCount: 0,
        costUsd: 0,
        periodStart: now.toISOString(),
        periodEnd: periodEnd.toISOString(),
      };
      this.quotas.set(key, reset);
      this.persist(reset);
    }
  }

  private findConfig(providerId: ProviderId, modelId?: string): QuotaConfig | undefined {
    if (modelId) {
      const scoped = this.configs.get(this.getKey(providerId, modelId));
      if (scoped) return scoped;
    }
    return this.configs.get(providerId);
  }

  private persistDelta(
    state: QuotaState,
    requests: number,
    tokens: number,
    costUsd: number
  ): void {
    if (!this.persistence) return;
    try {
      this.persistence.add({
        providerId: state.providerId,
        modelId: state.modelId,
        requests,
        tokens,
        costUsd,
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
      });
    } catch (err) {
      // Usage accounting must never take a completed request down with it.
      log.warn({ err }, '用量持久化失败');
    }
  }

  private persist(state: QuotaState): void {
    if (!this.persistence) return;
    try {
      this.persistence.save({
        providerId: state.providerId,
        modelId: state.modelId,
        requestCount: state.requestCount,
        tokenCount: state.tokenCount,
        costUsd: state.costUsd,
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
      });
    } catch (err) {
      // Usage accounting must never take a completed request down with it.
      log.warn({ err }, '用量持久化失败');
    }
  }

  private getKey(providerId: ProviderId, modelId?: string): string {
    return modelId ? `${providerId}:${modelId}` : providerId;
  }

  /** The window policy in force for a provider (config override, else rolling). */
  private policyFor(providerId: ProviderId): QuotaResetPolicy {
    const config = this.configs.get(providerId);
    return config?.resetPolicy ?? parseResetPolicy(this.readResetSetting?.(resetPolicyKey(providerId)) ?? null);
  }

  /** Optional settings hook so the policy is readable without a config row. */
  readResetSetting?: (key: string) => string | null;

  setResetPolicyReader(read: (key: string) => string | null): void {
    this.readResetSetting = read;
  }

  private getOrCreateState(providerId: ProviderId, modelId?: string): QuotaState {
    const key = this.getKey(providerId, modelId);
    let state = this.quotas.get(key);
    if (!state) {
      state = this.createState(providerId, modelId);
      this.quotas.set(key, state);
      return state;
    }

    if (new Date(state.periodEnd).getTime() <= Date.now()) {
      state = this.createState(providerId, modelId);
      this.quotas.set(key, state);
    }
    return state;
  }

  private createState(providerId: ProviderId, modelId?: string): QuotaState {
    const now = Date.now();
    const window = windowFor(this.policyFor(providerId), now);
    return {
      providerId,
      modelId,
      requestCount: 0,
      tokenCount: 0,
      costUsd: 0,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
    };
  }
}
