import type { ProviderId } from '../shared/types/index.js';

interface QuotaState {
  providerId: ProviderId;
  modelId?: string;
  requestCount: number;
  tokenCount: number;
  periodStart: string;
  periodEnd: string;
}

export interface QuotaConfig {
  maxRequestsPerDay?: number;
  maxTokensPerDay?: number;
  providerId: ProviderId;
  modelId?: string;
}

export interface PersistedQuotaState {
  providerId: ProviderId;
  modelId?: string;
  requestCount: number;
  tokenCount: number;
  periodStart: string;
  periodEnd: string;
}

/**
 * Optional write-through port so daily usage survives a restart. Without it the
 * manager stays purely in memory.
 */
export interface QuotaPersistence {
  load(): PersistedQuotaState[];
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
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
      });
      restored++;
    }
    return restored;
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
    modelId?: string
  ): void {
    // Charge the model bucket when the call was model scoped...
    const state = this.getOrCreateState(providerId, modelId);
    state.requestCount += requests;
    state.tokenCount += tokens;
    this.persist(state);

    // ...and always keep the provider bucket in sync, because that is the scope
    // a daily quota is normally configured against.
    if (modelId) {
      const providerState = this.getOrCreateState(providerId);
      providerState.requestCount += requests;
      providerState.tokenCount += tokens;
      this.persist(providerState);
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

  private persist(state: QuotaState): void {
    if (!this.persistence) return;
    try {
      this.persistence.save({
        providerId: state.providerId,
        modelId: state.modelId,
        requestCount: state.requestCount,
        tokenCount: state.tokenCount,
        periodStart: state.periodStart,
        periodEnd: state.periodEnd,
      });
    } catch (err) {
      // Usage accounting must never take a completed request down with it.
      console.warn('[Quota] 用量持久化失败:', err instanceof Error ? err.message : err);
    }
  }

  private getKey(providerId: ProviderId, modelId?: string): string {
    return modelId ? `${providerId}:${modelId}` : providerId;
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
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return {
      providerId,
      modelId,
      requestCount: 0,
      tokenCount: 0,
      periodStart: now.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };
  }
}
