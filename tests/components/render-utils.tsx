import React, type ReactElement } from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { vi } from 'vitest';

const createMockFreellm = () => ({
  providers: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    test: vi.fn().mockResolvedValue({ success: true }),
    setCredential: vi.fn().mockResolvedValue({ success: true }),
    removeCredential: vi.fn().mockResolvedValue({ success: true }),
    toggle: vi.fn().mockResolvedValue({ success: true }),
  },
  models: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    discover: vi.fn().mockResolvedValue([]),
    refresh: vi.fn().mockResolvedValue([]),
  },
  scheduler: {
    status: vi.fn().mockResolvedValue({ providers: [] }),
    resetCircuit: vi.fn().mockResolvedValue({ success: true }),
    resetAllCircuits: vi.fn().mockResolvedValue({ success: true }),
  },
  settings: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue({ success: true }),
    getAll: vi.fn().mockResolvedValue({}),
  },
  usage: {
    dashboard: vi.fn().mockResolvedValue({
      totalRequests: 0,
      successRate: 0,
      totalTokensUsed: 0,
      activeProviders: 0,
      availableModels: 0,
      recentCalls: [],
      providerStats: [],
    }),
    providerStats: vi.fn().mockResolvedValue({}),
    dailyStats: vi.fn().mockResolvedValue([]),
    recentCalls: vi.fn().mockResolvedValue([]),
  },
  gateway: {
    status: vi.fn().mockResolvedValue({ running: true, port: 0 }),
    port: vi.fn().mockResolvedValue(0),
  },
  app: {
    version: vi.fn().mockResolvedValue('0.1.0'),
    dataPath: vi.fn().mockResolvedValue('/tmp/data'),
  },
});

export function setupMockFreellm() {
  const mock = createMockFreellm();
  (window as unknown as { freellm: typeof mock }).freellm = mock;
  return mock;
}

export function renderWithDefaults(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return render(ui, { ...options });
}

export { render };
