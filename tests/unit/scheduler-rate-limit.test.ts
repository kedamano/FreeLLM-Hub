import { describe, it, expect, afterEach, vi } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler';
import { getProviderRegistry } from '../../src/core/providers/registry';
import { RateLimitError, ProviderError } from '../../src/shared/errors';
import type { GatewayRequest, ProviderModel, ProviderConfig } from '../../src/shared/types';
import type { ProviderAdapter, StreamChunk } from '../../src/core/providers/contracts';

const registry = getProviderRegistry();
const registered: string[] = [];

function createModel(
  providerId: string,
  id: string,
  contextWindow: number,
  rateLimits?: ProviderModel['rateLimits']
): ProviderModel {
  return {
    id,
    providerId,
    displayName: `${providerId}/${id}`,
    capabilities: {
      supported: ['chat', 'streaming'],
      contextWindow,
      supportsStreaming: true,
      supportsVision: false,
      supportsFunctionCalling: false,
      supportsJsonMode: false,
    },
    pricing: { type: 'free', currency: 'USD' },
    rateLimits,
    status: 'available',
    discoveredAt: new Date().toISOString(),
  };
}

interface AdapterOverrides {
  chat?: ProviderAdapter['chat'];
  chatStream?: ProviderAdapter['chatStream'];
}

function registerAdapter(providerId: string, models: ProviderModel[], overrides: AdapterOverrides = {}): ProviderAdapter {
  const config: ProviderConfig = {
    id: providerId,
    displayName: providerId,
    authType: 'api-key',
    baseUrl: 'https://api.test.com/v1',
    isEnabled: true,
    isBuiltIn: true,
    credentialStatus: 'configured',
  };

  const adapter: ProviderAdapter = {
    providerId,
    providerName: providerId,
    authType: 'api-key',
    getProviderConfig: () => config,
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue(models),
    getModel: vi.fn().mockImplementation(async (modelId: string) => models.find((m) => m.id === modelId) ?? null),
    chat: overrides.chat ??
      vi.fn().mockResolvedValue({
        content: 'ok',
        usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
        finishReason: 'stop',
      }),
    chatStream: overrides.chatStream ??
      vi.fn().mockImplementation(async function* (): AsyncIterable<StreamChunk> {
        yield { content: 'ok', finishReason: 'stop' };
      }),
    validateCredential: vi.fn().mockResolvedValue({ valid: true }),
    getUsageInfo: vi.fn().mockResolvedValue({ remainingTokens: 1000 }),
  };

  registry.register(adapter);
  registered.push(providerId);
  return adapter;
}

function request(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  return {
    requestId: 'req-1',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 50,
    ...overrides,
  };
}

afterEach(() => {
  for (const providerId of registered.splice(0)) registry.unregister(providerId);
});

describe('Scheduler rate limit accounting', () => {
  it('does not consume window quota while ranking candidates', async () => {
    const adapter = registerAdapter('probe-provider', [createModel('probe-provider', 'm1', 128000, { requestsPerMinute: 2 })]);
    const scheduler = new Scheduler();
    const limiter = scheduler.getRateLimiter();

    for (let i = 0; i < 4; i++) {
      const decision = await scheduler.selectModel(request(), await adapter.listModels());
      expect(decision?.model.id).toBe('m1');
    }

    // Ranking only probes; the two request slots in the minute window are untouched.
    expect(limiter.acquire('probe-provider:m1', 1, { requestsPerMinute: 2 })).toBe(true);
    expect(limiter.acquire('probe-provider:m1', 1, { requestsPerMinute: 2 })).toBe(true);
    expect(limiter.acquire('probe-provider:m1', 1, { requestsPerMinute: 2 })).toBe(false);
  });

  it('rolls back the reservation when the dispatch fails', async () => {
    const failing = new ProviderError('400 bad request', 'rollback-provider', 'BAD_REQUEST');
    registerAdapter('rollback-provider', [createModel('rollback-provider', 'm1', 128000, { requestsPerMinute: 1 })], {
      chat: vi.fn().mockRejectedValue(failing) as unknown as ProviderAdapter['chat'],
    });
    const scheduler = new Scheduler();
    const limiter = scheduler.getRateLimiter();

    await expect(scheduler.execute(request())).rejects.toBe(failing);

    // The failed attempt reserved the only request slot; rollback must free it.
    expect(limiter.check('rollback-provider:m1', 1, { requestsPerMinute: 1 })).toBe(true);
  });

  it('surfaces RateLimitError when every candidate is throttled', async () => {
    registerAdapter('throttle-provider', [createModel('throttle-provider', 'm1', 128000, { requestsPerMinute: 1 })]);
    const scheduler = new Scheduler();

    expect(scheduler.getRateLimiter().acquire('throttle-provider:m1', 1, { requestsPerMinute: 1 })).toBe(true);

    await expect(scheduler.execute(request())).rejects.toBeInstanceOf(RateLimitError);
  });

  it('reports the throttling provider on the RateLimitError', async () => {
    registerAdapter('throttle-info-provider', [createModel('throttle-info-provider', 'm1', 128000, { requestsPerMinute: 1 })]);
    const scheduler = new Scheduler();
    scheduler.getRateLimiter().acquire('throttle-info-provider:m1', 1, { requestsPerMinute: 1 });

    const err = await scheduler
      .selectModel(request(), await registry.get('throttle-info-provider')!.listModels())
      .catch((e) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).providerId).toBe('throttle-info-provider');
    expect((err as RateLimitError).retryAfterMs).toBeGreaterThan(0);
  });

  it('falls over to another model when a stream fails before the first byte', async () => {
    const upstream = new ProviderError('upstream 503', 'stream-fail-provider', 'SERVER_ERROR');
    registerAdapter('stream-fail-provider', [createModel('stream-fail-provider', 'm-high', 128000)], {
      chatStream: vi.fn().mockImplementation(async function* (): AsyncIterable<StreamChunk> {
        throw upstream;
      }) as unknown as ProviderAdapter['chatStream'],
    });
    const backup = registerAdapter('stream-ok-provider', [createModel('stream-ok-provider', 'm-low', 8192)]);

    const scheduler = new Scheduler();
    const chunks: Array<{ providerId: string; content?: string }> = [];
    for await (const chunk of scheduler.executeStream(request(), { maxRetries: 1 })) {
      chunks.push({ providerId: chunk.providerId, content: chunk.content });
    }

    expect(backup.chatStream).toHaveBeenCalledTimes(1);
    expect(chunks.some((c) => c.providerId === 'stream-ok-provider' && c.content === 'ok')).toBe(true);
    expect(scheduler.getRateLimiter().check('stream-fail-provider:m-high', 1)).toBe(true);
  });

  it('throws ModelNotFoundError instead of a generic failure when nothing matches', async () => {
    const scheduler = new Scheduler();
    await expect(scheduler.execute(request({ model: 'does-not-exist' }))).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });
});

describe('Scheduler daily quota routing', () => {
  it('routes around a provider whose daily quota is exhausted', async () => {
    const hot = registerAdapter('quota-hot-provider', [createModel('quota-hot-provider', 'm-high', 128000)]);
    registerAdapter('quota-cool-provider', [createModel('quota-cool-provider', 'm-low', 8192)]);

    const scheduler = new Scheduler();
    scheduler.setQuotaConfig({ providerId: 'quota-hot-provider', maxRequestsPerDay: 1 });
    scheduler.getQuotaManager().record('quota-hot-provider', 1, 100, 'm-high');

    const result = await scheduler.execute(request());

    expect(result.providerId).toBe('quota-cool-provider');
    expect(hot.chat).not.toHaveBeenCalled();
  });

  it('reports QuotaExceededError when every provider is over its daily quota', async () => {
    registerAdapter('quota-only-provider', [createModel('quota-only-provider', 'm1', 128000)]);

    const scheduler = new Scheduler();
    scheduler.setQuotaConfig({ providerId: 'quota-only-provider', maxRequestsPerDay: 1 });
    scheduler.getQuotaManager().record('quota-only-provider', 1, 100, 'm1');

    await expect(scheduler.execute(request())).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
  });

  it('charges the provider bucket for a successful model call', async () => {
    registerAdapter('quota-charge-provider', [createModel('quota-charge-provider', 'm1', 128000)]);
    const scheduler = new Scheduler();
    scheduler.setQuotaConfig({ providerId: 'quota-charge-provider', maxRequestsPerDay: 1 });

    await scheduler.execute(request());

    expect(scheduler.getQuotaManager().canProceed('quota-charge-provider', 'm1', 10)).toBe(false);
  });
});
