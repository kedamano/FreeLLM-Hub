import { describe, it, expect } from 'vitest';
import { filterCandidates } from '../../src/scheduler/candidate-filter';
import type { ProviderModel } from '../../src/shared/types';

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

const models: ProviderModel[] = [
  createMockModel({ id: 'chat-model', providerId: 'groq', capabilities: { supported: ['chat', 'streaming'], contextWindow: 8192, supportsStreaming: true, supportsVision: false, supportsFunctionCalling: false, supportsJsonMode: false } }),
  createMockModel({ id: 'paid-model', providerId: 'openai', pricing: { type: 'paid', currency: 'USD' }, capabilities: { supported: ['chat'], contextWindow: 128000, supportsStreaming: true, supportsVision: false, supportsFunctionCalling: false, supportsJsonMode: false } }),
  createMockModel({ id: 'unavailable', providerId: 'groq', status: 'unavailable', capabilities: { supported: ['chat'], contextWindow: 8192, supportsStreaming: true, supportsVision: false, supportsFunctionCalling: false, supportsJsonMode: false } }),
  createMockModel({ id: 'json-model', providerId: 'groq', capabilities: { supported: ['chat', 'json-mode'], contextWindow: 16000, supportsStreaming: true, supportsVision: false, supportsFunctionCalling: false, supportsJsonMode: true } }),
  createMockModel({ id: 'vision-model', providerId: 'google', capabilities: { supported: ['chat', 'vision'], contextWindow: 32000, supportsStreaming: true, supportsVision: true, supportsFunctionCalling: false, supportsJsonMode: false } }),
];

describe('candidate-filter', () => {
  it('should filter out unavailable models', () => {
    const result = filterCandidates(models, {});
    expect(result.find((m) => m.id === 'unavailable')).toBeUndefined();
  });

  it('should filter by required capabilities', () => {
    const result = filterCandidates(models, {
      requiredCapabilities: ['json-mode'] as never[],
    });
    expect(result.every((m) => m.capabilities.supported.includes('json-mode' as never))).toBe(true);
  });

  it('should prefer free when specified', () => {
    const result = filterCandidates(models, { preferFree: true });
    expect(result.every((m) => m.pricing.type === 'free' || m.pricing.type === 'local')).toBe(true);
  });

  it('should exclude specified providers', () => {
    const result = filterCandidates(models, { excludeProviders: ['groq'] });
    expect(result.every((m) => m.providerId !== 'groq')).toBe(true);
  });

  it('should include only specified providers when specified', () => {
    const result = filterCandidates(models, { includeProviders: ['google'] });
    expect(result.every((m) => m.providerId === 'google')).toBe(true);
  });

  it('should filter by minimum context window', () => {
    const result = filterCandidates(models, { minContextWindow: 32000 });
    expect(result.every((m) => m.capabilities.contextWindow >= 32000)).toBe(true);
  });

  it('should use task-type capability requirements', () => {
    const result = filterCandidates(models, { taskType: 'classification' });
    expect(result.length).toBeGreaterThan(0);
  });
});
