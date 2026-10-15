import type {
  GatewayRequest,
  ProviderModel,
  ProviderConfig,
  ProviderId,
  TaskType,
  SchedulerDecision,
} from '../shared/types/index.js';
import type { ProviderAdapter } from '../core/providers/contracts.js';
import { RateLimiter } from './rate-limiter.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { filterCandidates } from './candidate-filter.js';
import { rankModels, type ModelScoreContext } from './scoring.js';
import { RetryPolicy } from './retry-policy.js';
import { QuotaManager } from './quota-manager.js';
import { getTaskRoute } from './task-router.js';
import { buildFallbackChain, isRetriable } from './fallback.js';
import { getProviderRegistry } from '../core/providers/registry.js';
import type { ChatOptions } from '../core/providers/contracts.js';

export interface SchedulerOptions {
  maxRetries?: number;
  timeoutMs?: number;
  preferFree?: boolean;
}

export class Scheduler {
  private rateLimiter: RateLimiter;
  private circuitBreaker: CircuitBreaker;
  private retryPolicy: RetryPolicy;
  private quotaManager: QuotaManager;
  private providerConfigs = new Map<ProviderId, ProviderConfig>();

  constructor() {
    this.rateLimiter = new RateLimiter();
    this.circuitBreaker = new CircuitBreaker();
    this.retryPolicy = new RetryPolicy();
    this.quotaManager = new QuotaManager();
  }

  registerProviderConfig(config: ProviderConfig): void {
    this.providerConfigs.set(config.id, config);
  }

  async selectModel(
    request: GatewayRequest,
    availableModels: ProviderModel[]
  ): Promise<SchedulerDecision | null> {
    const taskType = request.taskType || 'general';
    const route = getTaskRoute(taskType);

    const candidates = filterCandidates(availableModels, {
      taskType,
      requiredCapabilities: route.minCapabilities as never[],
      preferFree: true,
    });

    if (candidates.length === 0) {
      return null;
    }

    const scoreContext: ModelScoreContext = {
      taskType,
      requiredCapabilities: route.minCapabilities,
      providerSuccessRates: this.getSuccessRates(),
      providerLatencies: this.getLatencies(),
    };

    const ranked = rankModels(candidates, scoreContext);

    for (const { model, score } of ranked) {
      const providerId = model.providerId;
      const rateLimitKey = `${providerId}:${model.id}`;

      if (!this.circuitBreaker.canExecute(providerId)) continue;
      if (!this.rateLimiter.canProceed(rateLimitKey)) continue;
      if (!this.quotaManager.canProceed(providerId, model.id)) continue;

      const config = this.providerConfigs.get(providerId);
      if (!config) continue;

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
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    finishReason: string;
    durationMs: number;
  }> {
    const startTime = Date.now();
    const maxRetries = options?.maxRetries ?? this.retryPolicy.getMaxRetries();
    const registry = getProviderRegistry();
    const availableModels = registry.getAll().flatMap((a) => a.getProviderConfig().isEnabled ? this.getModelsForAdapter(a) : []);

    let lastError: Error | null = null;
    const attemptedProviders: ProviderId[] = [];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const decision = await this.selectModel(request, availableModels);
      if (!decision) {
        throw new Error('No available models for this request');
      }

      if (attemptedProviders.includes(decision.providerId)) {
        continue;
      }
      attemptedProviders.push(decision.providerId);

      const adapter = registry.get(decision.providerId);
      if (!adapter) continue;

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
        this.rateLimiter.record(`${decision.providerId}:${decision.model.id}`, result.usage.totalTokens);
        this.quotaManager.record(decision.providerId, 1, result.usage.totalTokens, decision.model.id);

        return {
          ...result,
          model: decision.model.id,
          providerId: decision.providerId,
          durationMs: Date.now() - startTime,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.circuitBreaker.recordFailure(decision.providerId);

        if (!isRetriable(err) || !this.retryPolicy.shouldRetry(attempt)) {
          break;
        }

        const delay = this.retryPolicy.getDelay(attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastError || new Error('All providers failed');
  }

  async *executeStream(
    request: GatewayRequest,
    options?: SchedulerOptions
  ): AsyncGenerator<{
    content?: string;
    finishReason?: string;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    model: string;
    providerId: ProviderId;
  }> {
    const registry = getProviderRegistry();
    const availableModels = registry.getAll().flatMap((a) => a.getProviderConfig().isEnabled ? this.getModelsForAdapter(a) : []);
    const decision = await this.selectModel(request, availableModels);

    if (!decision) {
      throw new Error('No available models for streaming');
    }

    const adapter = registry.get(decision.providerId);
    if (!adapter) throw new Error(`Provider ${decision.providerId} not found`);

    const chatOptions: ChatOptions = {
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: options?.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      tools: request.tools,
      responseFormat: request.responseFormat,
    };

    let fullContent = '';

    for await (const chunk of adapter.chatStream(request.messages, decision.model.id, chatOptions)) {
      if (chunk.content) {
        fullContent += chunk.content;
      }
      yield {
        content: chunk.content,
        finishReason: chunk.finishReason,
        usage: chunk.usage,
        model: decision.model.id,
        providerId: decision.providerId,
      };
    }

    this.circuitBreaker.recordSuccess(decision.providerId);
    this.rateLimiter.record(`${decision.providerId}:${decision.model.id}`, fullContent.length);
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

  private getModelsForAdapter(adapter: ProviderAdapter): ProviderModel[] {
    return adapter.getProviderConfig().isEnabled ? [] : [];
  }

  private getSuccessRates(): Map<string, number> {
    return new Map();
  }

  private getLatencies(): Map<string, number> {
    return new Map();
  }

  private estimateCost(model: ProviderModel, _request: GatewayRequest): number {
    if (model.pricing.type === 'local' || model.pricing.type === 'free') return 0;
    return 0.001;
  }
}
