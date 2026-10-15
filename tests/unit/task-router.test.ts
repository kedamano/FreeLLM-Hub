import { describe, it, expect } from 'vitest';
import { getTaskRoute, scoreModelForTask } from '../../src/scheduler/task-router';
import type { ProviderModel } from '../../src/shared/types';

function createMockModel(overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id: 'test-model',
    providerId: 'ollama',
    displayName: 'Test Model',
    capabilities: {
      supported: ['chat', 'streaming'],
      contextWindow: 8192,
      supportsStreaming: true,
      supportsVision: false,
      supportsFunctionCalling: false,
      supportsJsonMode: false,
    },
    pricing: { type: 'local', currency: 'USD' },
    status: 'available',
    discoveredAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('task-router', () => {
  it('should return route for each task type', () => {
    const taskTypes = ['general', 'coding', 'analysis', 'creative', 'summarization', 'classification', 'extraction', 'translation', 'lightweight'] as const;

    for (const taskType of taskTypes) {
      const route = getTaskRoute(taskType);
      expect(route.taskType).toBe(taskType);
      expect(route.preferredProviders.length).toBeGreaterThan(0);
      expect(route.minCapabilities).toContain('chat');
    }
  });

  it('should prefer local models', () => {
    const localModel = createMockModel({ providerId: 'ollama', pricing: { type: 'local', currency: 'USD' } });
    const paidModel = createMockModel({ providerId: 'openai', pricing: { type: 'paid', currency: 'USD' } });

    const localScore = scoreModelForTask(localModel, 'general');
    const paidScore = scoreModelForTask(paidModel, 'general');

    expect(localScore).toBeGreaterThan(paidScore);
  });

  it('should penalize models without required capabilities', () => {
    const chatOnly = createMockModel({ capabilities: { supported: ['chat'], contextWindow: 8192, supportsStreaming: true, supportsVision: false, supportsFunctionCalling: false, supportsJsonMode: false } });
    const fullCap = createMockModel({ capabilities: { supported: ['chat', 'json-mode'], contextWindow: 8192, supportsStreaming: true, supportsVision: false, supportsFunctionCalling: false, supportsJsonMode: true } });

    const chatScore = scoreModelForTask(chatOnly, 'classification');
    const fullScore = scoreModelForTask(fullCap, 'classification');

    expect(fullScore).toBeGreaterThan(chatScore);
  });
});
