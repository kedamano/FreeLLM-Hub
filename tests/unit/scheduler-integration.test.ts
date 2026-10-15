import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler } from '../../src/scheduler/scheduler';
import type { ProviderModel, ProviderConfig, GatewayUsage } from '../../src/shared/types';
import type { ProviderAdapter, StreamChunk } from '../../src/core/providers/contracts';

function createMockModel(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: 'test-model',
    providerId: 'test-provider',
    displayName: 'Test Model',
    capabilities: {
      supported: ['chat', 'streaming'],
      contextWindow: 8192,
      supportsStreaming: true,
      supportsVision: false,
      supportsFunctionCalling: false,
      supportsJsonMode: false,
    },
    pricing: { type: 'free', currency: 'USD' },
    status: 'available',
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test-provider',
    displayName: 'Test Provider',
    authType: 'api-key',
    baseUrl: 'https://api.test.com/v1',
    isEnabled: true,
    isBuiltIn: true,
    credentialStatus: 'configured',
    ...overrides,
  };
}

function createMockAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    providerId: 'test-provider',
    providerName: 'Test Provider',
    authType: 'api-key',
    getProviderConfig: () => createMockConfig(),
    isAvailable: vi.fn().mockResolvedValue(true),
    listModels: vi.fn().mockResolvedValue([createMockModel()]),
    getModel: vi.fn().mockResolvedValue(createMockModel()),
    chat: vi.fn().mockResolvedValue({
      content: 'Hello from mock!',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: 'stop',
    }),
    chatStream: vi.fn().mockImplementation(async function* (): AsyncIterable<StreamChunk> {
      yield { content: 'Hello ' };
      yield { content: 'from ', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
      yield { content: 'stream!', finishReason: 'stop' };
    }),
    validateCredential: vi.fn().mockResolvedValue({ valid: true }),
    getUsageInfo: vi.fn().mockResolvedValue({ remainingTokens: 1000 }),
    ...overrides,
  };
}

describe('Scheduler Integration', () => {
  let scheduler: Scheduler;

  beforeEach(() => {
    scheduler = new Scheduler();
  });

  it('should register provider config', () => {
    const config = createMockConfig();
    scheduler.registerProviderConfig(config);
    // Should not throw
    expect(scheduler.getCircuitState('test-provider')).toBe('closed');
  });

  it('should reset circuit breaker', () => {
    scheduler.registerProviderConfig(createMockConfig());
    expect(scheduler.getCircuitState('test-provider')).toBe('closed');
    scheduler.resetCircuit('test-provider');
    expect(scheduler.getCircuitState('test-provider')).toBe('closed');
  });

  it('should expose rate limiter', () => {
    const limiter = scheduler.getRateLimiter();
    expect(limiter).toBeDefined();
    expect(limiter.canProceed('test-key')).toBe(true);
  });

  it('should expose quota manager', () => {
    const quotaManager = scheduler.getQuotaManager();
    expect(quotaManager).toBeDefined();
    expect(quotaManager.canProceed('some-provider')).toBe(true);
  });
});

describe('Mock Adapter Behavior', () => {
  it('should mock chat correctly', async () => {
    const adapter = createMockAdapter();
    const result = await adapter.chat(
      [{ role: 'user', content: 'Hello' }],
      'test-model',
      {}
    );
    expect(result.content).toBe('Hello from mock!');
    expect(result.usage.totalTokens).toBe(30);
    expect(result.finishReason).toBe('stop');
  });

  it('should mock stream correctly', async () => {
    const adapter = createMockAdapter();
    const chunks: string[] = [];

    for await (const chunk of adapter.chatStream(
      [{ role: 'user', content: 'Hi' }],
      'test-model',
      {}
    )) {
      if (chunk.content) chunks.push(chunk.content);
    }

    expect(chunks.join('')).toBe('Hello from stream!');
  });

  it('should mock validation correctly', async () => {
    const adapter = createMockAdapter();
    const result = await adapter.validateCredential('test-key');
    expect(result.valid).toBe(true);
  });

  it('should handle chat errors', async () => {
    const errorAdapter = createMockAdapter({
      chat: vi.fn().mockRejectedValue(new Error('Provider error')),
    });

    await expect(
      errorAdapter.chat([{ role: 'user', content: 'Hi' }], 'model', {})
    ).rejects.toThrow('Provider error');
  });

  it('should handle credential check failure', async () => {
    const failAdapter = createMockAdapter({
      validateCredential: vi.fn().mockResolvedValue({ valid: false, reason: 'Invalid key' }),
    });

    const result = await failAdapter.validateCredential();
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('Invalid key');
  });

  it('should handle rate limit errors', async () => {
    const rateLimitAdapter = createMockAdapter({
      chat: vi.fn().mockRejectedValue(new Error('Rate limited')),
    });

    await expect(
      rateLimitAdapter.chat([{ role: 'user', content: 'Hi' }], 'model', {})
    ).rejects.toThrow('Rate limited');
  });
});
