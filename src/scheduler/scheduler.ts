import type {
  GatewayRequest,
  ProviderModel,
  ProviderConfig,
  ProviderId,
  GatewayUsage,
  SchedulerDecision,
} from '../shared/types/index.js';
import type { ProviderAdapter } from '../core/providers/contracts.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { filterCandidates } from './candidate-filter.js';
import { rankModels, type ModelScoreContext } from './scoring.js';
import { RetryPolicy } from './retry-policy.js';
import { QuotaManager, type QuotaConfig } from './quota-manager.js';
import { getTaskRoute } from './task-router.js';
import { isRetriable, getErrorCode } from './fallback.js';
import { getProviderRegistry } from '../core/providers/registry.js';
import type { ChatOptions } from '../core/providers/contracts.js';
import { AllProvidersFailedError, RateLimitError } from '../shared/errors/index.js';
import { estimateTokens, estimateMessagesTokens } from '../usage/tokenizer.js';

const MODEL_CATALOG_TTL_MS = 60000;
const PROVIDER_HEALTH_TTL_MS = 10000;

export interface SchedulerOptions {
  maxRetries?: number;
  timeoutMs?: number;
  preferFree?: boolean;
}

export interface SelectModelOptions {
  excludeProviders?: ProviderId[];
  excludeModels?: string[];
  estimatedTokens?: number;
}

interface ModelCatalogEntry {
  models: ProviderModel[];
  cachedAt: number;
}

export class Scheduler {
  private rateLimiter: RateLimiter;
  private circuitBreaker: CircuitBreaker;
  private retryPolicy: RetryPolicy;
  private quotaManager: QuotaManager;
  private providerConfigs = new Map<ProviderId, ProviderConfig>();
  private modelCatalog = new Map<string, ModelCatalogEntry>();
  private providerSuccessRates = new Map<string, number>();
  private providerLatencies = new Map<string, number>();
  private healthCachedAt = 0;

  constructor() {
    this.rateLimiter = new RateLimiter();
    this.circuitBreaker = new CircuitBreaker();
    this.retryPolicy = new RetryPolicy();
    this.quotaManager = new QuotaManager();
  }

  registerProviderConfig(config: ProviderConfig): void {
    this.providerConfigs.set(config.id, config);
  }

  forgetProvider(providerId: ProviderId): void {
    this.providerConfigs.delete(providerId);
  }

  setQuotaConfig(config: QuotaConfig): void {
    this.quotaManager.setConfig(config);
  }

  async selectModel(
    request: GatewayRequest,
    availableModels: ProviderModel[],
    options?: SelectModelOptions
  ): Promise<SchedulerDecision | null> {
    const taskType = request.taskType || 'general';
    const route = getTaskRoute(taskType);
    const excluded = options?.excludeProviders || [];
    const excludedModels = options?.excludeModels || [];
    const estimatedTokens = options?.estimatedTokens ?? this.estimateRequestTokens(request);

    let candidates = filterCandidates(availableModels, {
      taskType,
      requiredCapabilities: route.minCapabilities,
      preferFree: true,
      excludeProviders: excluded,
    });

    // Drop already-attempted provider:model pairs *before* the exact-match
    // pinning below, so a rate-limited or failed model releases the pin and
    // the retry falls back to whatever else the free pool can serve.
    if (excludedModels.length > 0) {
      candidates = candidates.filter((m) => !excludedModels.includes(`${m.providerId}:${m.id}`));
    }

    if (request.model) {
      const requested = candidates.filter(
        (model) =>
          model.id === request.model ||
          `${model.providerId}/${model.id}` === request.model
      );
      if (requested.length > 0) {
        candidates = requested;
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    await this.refreshProviderHealth();

    const scoreContext: ModelScoreContext = {
      taskType,
      requiredCapabilities: route.minCapabilities,
      providerSuccessRates: this.providerSuccessRates,
      providerLatencies: this.providerLatencies,
    };

    const ranked = rankModels(candidates, scoreContext);
    const registry = getProviderRegistry();

    for (const { model, score } of ranked) {
      const providerId = model.providerId;

      const adapter = registry.get(providerId);
      if (!adapter) continue;

      const liveConfig = adapter.getProviderConfig();
      const registeredConfig = this.providerConfigs.get(providerId);
      const config = registeredConfig
        ? { ...liveConfig, isEnabled: registeredConfig.isEnabled }
        : liveConfig;
      if (!config.isEnabled) continue;

      if (!this.circuitBreaker.canExecute(providerId)) continue;

      const rateLimitKey = `${providerId}:${model.id}`;
      if (!this.rateLimiter.canProceed(rateLimitKey, estimatedTokens, model.rateLimits)) {
        this.circuitBreaker.release(providerId);
        continue;
      }

      if (!this.quotaManager.canProceed(providerId, model.id, estimatedTokens)) {
        this.circuitBreaker.release(providerId);
        continue;
      }

      return {
        model,
        providerId,
        providerConfig: config,
        reason: `Selected for task '${taskType}' with score ${score.toFixed(1)}`,
        score,
        estimatedCost: this.estimateCost(model, request),
      };
    }

    return null;
  }

  async execute(
    request: GatewayRequest,
    options?: SchedulerOptions
  ): Promise<{
    content: string;
    model: string;
    providerId: ProviderId;
    usage: GatewayUsage;
    finishReason: string;
    durationMs: number;
  }> {
    const startTime = Date.now();
    const maxRetries = options?.maxRetries ?? this.retryPolicy.getMaxRetries();
    const registry = getProviderRegistry();
    const availableModels = await this.collectModels(registry);
    const estimatedTokens = this.estimateRequestTokens(request);

    let lastError: Error | null = null;
    const attemptedProviders: ProviderId[] = [];
    const attemptedModels: string[] = [];
    const failures: Array<{ providerId: ProviderId; error: string }> = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const decision = await this.selectModel(request, availableModels, {
        excludeProviders: attemptedProviders,
        excludeModels: attemptedModels,
        estimatedTokens,
      });

      if (!decision) {
        if (lastError || failures.length > 0) break;
        throw new Error('No available models for this request');
      }

      const modelKey = `${decision.providerId}:${decision.model.id}`;
      if (!attemptedModels.includes(modelKey)) attemptedModels.push(modelKey);

      const adapter = registry.get(decision.providerId);
      if (!adapter) {
        this.circuitBreaker.release(decision.providerId);
        if (!attemptedProviders.includes(decision.providerId)) {
          attemptedProviders.push(decision.providerId);
        }
        continue;
      }

      const chatOptions: ChatOptions = {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
        tools: request.tools,
        responseFormat: request.responseFormat,
      };

      try {
        const result = await adapter.chat(request.messages, decision.model.id, chatOptions);

        this.circuitBreaker.recordSuccess(decision.providerId);
        this.rateLimiter.record(
          `${decision.providerId}:${decision.model.id}`,
          result.usage.totalTokens - estimatedTokens
        );
        this.quotaManager.record(decision.providerId, 1, result.usage.totalTokens, decision.model.id);

        return {
          ...result,
          model: decision.model.id,
          providerId: decision.providerId,
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        failures.push({
          providerId: decision.providerId,
          error: lastError.message,
        });
        this.circuitBreaker.recordFailure(decision.providerId);

        // A single hot (rate-limited) model must not blacklist its whole
        // provider — only that model is excluded. Other failures take the
        // provider out for subsequent attempts.
        if (
          !(err instanceof RateLimitError) &&
          !attemptedProviders.includes(decision.providerId)
        ) {
          attemptedProviders.push(decision.providerId);
        }

        if (!isRetriable(err) || !this.retryPolicy.shouldRetry(attempt, getErrorCode(err))) {
          break;
        }

        const delay = this.retryPolicy.getDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    if (failures.length > 1) {
      throw new AllProvidersFailedError(failures);
    }

    throw lastError || new Error('All providers failed');
  }

  async *executeStream(
    request: GatewayRequest,
    options?: SchedulerOptions
  ): AsyncGenerator<{
    content?: string;
    finishReason?: string;
    usage?: GatewayUsage;
    model: string;
    providerId: ProviderId;
  }> {
    const maxRetries = options?.maxRetries ?? this.retryPolicy.getMaxRetries();
    const registry = getProviderRegistry();
    const availableModels = await this.collectModels(registry);
    const estimatedTokens = this.estimateRequestTokens(request);

    const attemptedProviders: ProviderId[] = [];
    const attemptedModels: string[] = [];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const decision = await this.selectModel(request, availableModels, {
        estimatedTokens,
        excludeProviders: attemptedProviders,
        excludeModels: attemptedModels,
      });

      if (!decision) {
        if (lastError) break;
        throw new Error('No available models for streaming');
      }

      const modelKey = `${decision.providerId}:${decision.model.id}`;
      if (!attemptedModels.includes(modelKey)) attemptedModels.push(modelKey);

      const adapter = registry.get(decision.providerId);
      if (!adapter) {
        this.circuitBreaker.release(decision.providerId);
        if (!attemptedProviders.includes(decision.providerId)) {
          attemptedProviders.push(decision.providerId);
        }
        continue;
      }

      const chatOptions: ChatOptions = {
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
        tools: request.tools,
        responseFormat: request.responseFormat,
      };

      let fullContent = '';
      let upstreamUsage: GatewayUsage | null = null;
      let yieldedAny = false;

      try {
        for await (const chunk of adapter.chatStream(request.messages, decision.model.id, chatOptions)) {
          if (chunk.content) {
            fullContent += chunk.content;
          }
          if (chunk.usage) {
            upstreamUsage = chunk.usage;
          }
          yieldedAny = true;
          yield {
            content: chunk.content,
            finishReason: chunk.finishReason,
            usage: chunk.usage,
            model: decision.model.id,
            providerId: decision.providerId,
          };
        }
      } catch (err) {
        this.circuitBreaker.recordFailure(decision.providerId);
        lastError = err instanceof Error ? err : new Error(String(err));

        // Once bytes have reached the client we cannot restart the stream,
        // so fall back to another model only if the failure was immediate.
        const retriable = isRetriable(err) && this.retryPolicy.shouldRetry(attempt, getErrorCode(err));
        if (yieldedAny || !retriable) {
          throw err;
        }

        if (
          !(err instanceof RateLimitError) &&
          !attemptedProviders.includes(decision.providerId)
        ) {
          attemptedProviders.push(decision.providerId);
        }

        await new Promise((r) => setTimeout(r, this.retryPolicy.getDelay(attempt)));
        continue;
      }

      const promptTokens =
        upstreamUsage?.promptTokens ?? estimateMessagesTokens(request.messages);
      const completionTokens = upstreamUsage?.completionTokens ?? estimateTokens(fullContent);
      const totalTokens = upstreamUsage?.totalTokens ?? promptTokens + completionTokens;
      const usage: GatewayUsage = { promptTokens, completionTokens, totalTokens };

      this.circuitBreaker.recordSuccess(decision.providerId);
      this.rateLimiter.record(
        `${decision.providerId}:${decision.model.id}`,
        totalTokens - estimatedTokens
      );
      this.quotaManager.record(decision.providerId, 1, totalTokens, decision.model.id);

      yield { usage, model: decision.model.id, providerId: decision.providerId };
      return;
    }

    if (lastError) throw lastError;
    throw new Error('All providers failed for streaming request');
  }

  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  getQuotaManager(): QuotaManager {
    return this.quotaManager;
  }

  getCircuitState(providerId: string): string {
    return this.circuitBreaker.getState(providerId).state;
  }

  resetCircuit(providerId: string): void {
    this.circuitBreaker.reset(providerId);
  }

  private async collectModels(registry: {
    getAll(): ProviderAdapter[];
  }): Promise<ProviderModel[]> {
    const adapters = registry.getAll().filter((a) => {
      const config = a.getProviderConfig();
      if (!config.isEnabled) return false;
      // Providers that require a credential but have none configured can
      // never serve a request; keeping them out of the candidate pool lets
      // rate-limit fallback reach models that actually work.
      if (
        config.authType !== 'none' &&
        config.credentialStatus !== 'configured' &&
        config.credentialStatus !== 'valid'
      ) {
        return false;
      }
      return true;
    });
    const batches = await Promise.all(
      adapters.map(async (adapter) => {
        try {
          return await this.getModelsForAdapter(adapter);
        } catch {
          return [];
        }
      })
    );
    return batches.flat();
  }

  private async getModelsForAdapter(adapter: ProviderAdapter): Promise<ProviderModel[]> {
    const cached = this.modelCatalog.get(adapter.providerId);
    if (cached && Date.now() - cached.cachedAt < MODEL_CATALOG_TTL_MS) {
      return cached.models;
    }

    try {
      const models = await adapter.listModels();
      this.modelCatalog.set(adapter.providerId, { models, cachedAt: Date.now() });
      return models;
    } catch {
      if (cached) return cached.models;
      return [];
    }
  }

  private estimateRequestTokens(request: GatewayRequest): number {
    const promptTokens = estimateMessagesTokens(request.messages);
    return promptTokens + (request.maxTokens ?? 0);
  }

  private async refreshProviderHealth(): Promise<void> {
    if (Date.now() - this.healthCachedAt < PROVIDER_HEALTH_TTL_MS) return;
    this.healthCachedAt = Date.now();

    try {
      const { getProviderHealth } = await import('../usage/statistics.js');
      for (const entry of getProviderHealth()) {
        this.providerSuccessRates.set(entry.providerId, entry.successRate);
        this.providerLatencies.set(entry.providerId, entry.avgLatencyMs);
      }
    } catch {
      // call-log aggregation unavailable
    }
  }

  private estimateCost(model: ProviderModel, _request: GatewayRequest): number {
    if (model.pricing.type === 'local' || model.pricing.type === 'free') return 0;
    return 0.001;
  }
}
