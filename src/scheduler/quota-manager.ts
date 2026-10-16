import type { ProviderId } from '../shared/types/index.js';

interface QuotaState {
  providerId: ProviderId;
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

export class QuotaManager {
  private quotas = new Map<string, QuotaState>();
  private configs = new Map<string, QuotaConfig>();

  setConfig(config: QuotaConfig): void {
    const key = this.getKey(config.providerId, config.modelId);
    this.configs.set(key, config);
  }

  canProceed(providerId: ProviderId, modelId?: string, estimatedTokens?: number): boolean {
    const key = this.getKey(providerId, modelId);
    const config = this.configs.get(key);
    if (!config) return true;

    const state = this.getOrCreateState(providerId, modelId);

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
    const state = this.getOrCreateState(providerId, modelId);
    state.requestCount += requests;
    state.tokenCount += tokens;
  }

  getUsage(providerId: ProviderId, modelId?: string): QuotaState {
    return this.getOrCreateState(providerId, modelId);
  }

  getRemainingQuota(
    providerId: ProviderId,
    modelId?: string
  ): { requests?: number; tokens?: number; unlimited: boolean } {
    const key = this.getKey(providerId, modelId);
    const config = this.configs.get(key);
    const state = this.getOrCreateState(providerId, modelId);

    if (!config) {
      return { unlimited: true };
    }

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
    const key = this.getKey(providerId, modelId);
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    this.quotas.set(key, {
      providerId,
      requestCount: 0,
      tokenCount: 0,
      periodStart: now.toISOString(),
      periodEnd: periodEnd.toISOString(),
    });
  }

  resetAll(): void {
    const now = new Date();
    for (const [key, state] of this.quotas) {
      const periodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      this.quotas.set(key, {
        ...state,
        requestCount: 0,
        tokenCount: 0,
        periodStart: now.toISOString(),
        periodEnd: periodEnd.toISOString(),
      });
    }
  }

  private getKey(providerId: ProviderId, modelId?: string): string {
    return modelId ? `${providerId}:${modelId}` : providerId;
  }

  private getOrCreateState(providerId: ProviderId, modelId?: string): QuotaState {
    const key = this.getKey(providerId, modelId);
    let state = this.quotas.get(key);
    if (!state) {
      state = this.createState(providerId);
      this.quotas.set(key, state);
      return state;
    }

    if (new Date(state.periodEnd).getTime() <= Date.now()) {
      state = this.createState(providerId);
      this.quotas.set(key, state);
    }
    return state;
  }

  private createState(providerId: ProviderId): QuotaState {
    const now = new Date();
    const periodEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return {
      providerId,
      requestCount: 0,
      tokenCount: 0,
      periodStart: now.toISOString(),
      periodEnd: periodEnd.toISOString(),
    };
  }
}
