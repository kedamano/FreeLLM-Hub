import { describe, it, expect } from 'vitest';
import { buildFallbackChain, isRetriable } from '../../src/scheduler/fallback';
import {
  AuthenticationError,
  ProviderError,
  RateLimitError,
} from '../../src/shared/errors';
import type { ProviderModel, ProviderConfig } from '../../src/shared/types';

function createModel(id: string, providerId: string, overrides: Partial<ProviderModel> = {}): ProviderModel {
  return {
    id,
    providerId,
    displayName: `${id} (${providerId})`,
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

function createConfig(id: string, isEnabled: boolean = true): ProviderConfig {
  return {
    id,
    displayName: id,
    authType: 'api-key',
    baseUrl: `https://api.${id}.com/v1`,
    isEnabled,
    isBuiltIn: true,
    credentialStatus: 'configured',
  };
}

describe('fallback', () => {
  describe('buildFallbackChain', () => {
    it('should skip failed provider', () => {
      const models = [
        createModel('m1', 'p1'),
        createModel('m2', 'p2'),
        createModel('m3', 'p3'),
      ];
      const ranked = [
        { model: models[0], score: 100 },
        { model: models[1], score: 80 },
        { model: models[2], score: 60 },
      ];
      const configs = new Map([['p2', createConfig('p2')], ['p3', createConfig('p3')]]);

      const result = buildFallbackChain(models, 'p1', ranked, configs);

      expect(result.model?.providerId).toBe('p2');
      expect(result.providerConfig?.id).toBe('p2');
      expect(result.attempts.length).toBe(0);
    });

    it('should skip unavailable models', () => {
      const models = [
        createModel('m1', 'p1'),
        createModel('m2', 'p2', { status: 'unavailable' }),
        createModel('m3', 'p3'),
      ];
      const ranked = [
        { model: models[0], score: 100 },
        { model: models[1], score: 80 },
        { model: models[2], score: 60 },
      ];
      const configs = new Map([['p3', createConfig('p3')]]);

      const result = buildFallbackChain(models, 'p1', ranked, configs);
      expect(result.model?.providerId).toBe('p3');
      // Unavailable models are filtered before the loop, so no "attempt" entries are added
      expect(result.attempts.length).toBe(0);
    });

    it('should skip disabled providers', () => {
      const models = [
        createModel('m1', 'p1'),
        createModel('m2', 'p2'),
        createModel('m3', 'p3'),
      ];
      const ranked = [
        { model: models[0], score: 100 },
        { model: models[1], score: 80 },
        { model: models[2], score: 60 },
      ];
      const configs = new Map([['p2', createConfig('p2', false)], ['p3', createConfig('p3')]]);

      const result = buildFallbackChain(models, 'p1', ranked, configs);
      expect(result.model?.providerId).toBe('p3');
      expect(result.attempts[0].providerId).toBe('p2');
      expect(result.attempts[0].reason).toContain('disabled');
    });

    it('should return null when no alternatives', () => {
      const models = [createModel('m1', 'p1')];
      const ranked = [{ model: models[0], score: 100 }];
      const configs = new Map<string, ProviderConfig>();

      const result = buildFallbackChain(models, 'p1', ranked, configs);
      expect(result.model).toBeNull();
      expect(result.providerConfig).toBeNull();
    });
  });

  describe('isRetriable', () => {
    it('should return true for retriable error codes', () => {
      expect(isRetriable({ code: 'RATE_LIMITED' })).toBe(true);
      expect(isRetriable({ code: 'TIMEOUT' })).toBe(true);
      expect(isRetriable({ code: 'SERVER_ERROR' })).toBe(true);
      expect(isRetriable({ code: 'ALL_FAILED' })).toBe(true);
      expect(isRetriable({ code: 'NETWORK_ERROR' })).toBe(true);
    });

    it('should return false for non-retriable errors', () => {
      expect(isRetriable({ code: 'AUTH_FAILED' })).toBe(false);
      expect(isRetriable({ code: 'MODEL_NOT_FOUND' })).toBe(false);
      expect(isRetriable({ code: 'QUOTA_EXCEEDED' })).toBe(false);
      expect(isRetriable({ code: 'BAD_REQUEST' })).toBe(false);
    });

    it('should use the typed error code', () => {
      expect(isRetriable(new RateLimitError('groq'))).toBe(true);
      expect(isRetriable(new AuthenticationError('groq'))).toBe(false);
      expect(
        isRetriable(new ProviderError('boom', 'groq', 'SERVER_ERROR'))
      ).toBe(true);
    });

    it('should treat bare provider errors as retriable', () => {
      expect(isRetriable(new Error('Chat request failed (500): upstream blew up'))).toBe(true);
      expect(isRetriable(new Error('fetch failed'))).toBe(true);
      expect(isRetriable(new Error('request timed out'))).toBe(true);
    });

    it('should not retry bare auth or bad-request errors', () => {
      expect(isRetriable(new Error('Chat request failed (401): invalid api key'))).toBe(false);
      expect(isRetriable(new Error('Chat request failed (404): model not found'))).toBe(false);
    });

    it('should return false for non-object errors', () => {
      expect(isRetriable('string error')).toBe(false);
      expect(isRetriable(null)).toBe(false);
      expect(isRetriable(undefined)).toBe(false);
      expect(isRetriable(42)).toBe(false);
    });
  });
});
