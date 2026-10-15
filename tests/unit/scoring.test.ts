import { describe, it, expect } from 'vitest';
import { scoreModel, rankModels } from '../../src/scheduler/scoring';
import type { ProviderModel, ModelScoreContext } from '../../src/shared/types';

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

const mockContext: ModelScoreContext = {
  taskType: 'general',
  providerSuccessRates: new Map([['test-provider', 0.95]]),
  providerLatencies: new Map([['test-provider', 200]]),
};

describe('scoring', () => {
  it('should score free models higher than paid', () => {
    const freeModel = createMockModel({ pricing: { type: 'free', currency: 'USD' } });
    const paidModel = createMockModel({ pricing: { type: 'paid', currency: 'USD' } });

    const freeScore = scoreModel(freeModel, mockContext);
    const paidScore = scoreModel(paidModel, mockContext);

    expect(freeScore).toBeGreaterThan(paidScore);
  });

  it('should score local models highest', () => {
    const localModel = createMockModel({ pricing: { type: 'local', currency: 'USD' } });
    const freeModel = createMockModel({ pricing: { type: 'free', currency: 'USD' } });

    const localScore = scoreModel(localModel, mockContext);
    const freeScore = scoreModel(freeModel, mockContext);

    expect(localScore).toBeGreaterThan(freeScore);
  });

  it('should rank models correctly', () => {
    const models = [
      createMockModel({ id: 'paid-1', pricing: { type: 'paid', currency: 'USD' } }),
      createMockModel({ id: 'free-1', pricing: { type: 'free', currency: 'USD' } }),
      createMockModel({ id: 'local-1', pricing: { type: 'local', currency: 'USD' } }),
    ];

    const ranked = rankModels(models, mockContext);

    expect(ranked[0].model.id).toBe('local-1');
    expect(ranked[1].model.id).toBe('free-1');
    expect(ranked[2].model.id).toBe('paid-1');
  });

  it('should prioritize models with larger context windows', () => {
    const smallCtx = createMockModel({
      capabilities: {
        supported: ['chat', 'streaming'],
        contextWindow: 4096,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
    });
    const largeCtx = createMockModel({
      capabilities: {
        supported: ['chat', 'streaming'],
        contextWindow: 128000,
        supportsStreaming: true,
        supportsVision: false,
        supportsFunctionCalling: false,
        supportsJsonMode: false,
      },
    });

    const smallScore = scoreModel(smallCtx, mockContext);
    const largeScore = scoreModel(largeCtx, mockContext);

    expect(largeScore).toBeGreaterThan(smallScore);
  });

  it('should return ordered scores descending', () => {
    const models = [
      createMockModel({ id: 'm1' }),
      createMockModel({ id: 'm2' }),
      createMockModel({ id: 'm3' }),
    ];

    const ranked = rankModels(models, mockContext);

    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });
});
