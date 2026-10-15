import type { ProviderModel, ProviderId, ProviderConfig } from '../shared/types/index.js';

export interface FallbackResult {
  model: ProviderModel | null;
  providerConfig: ProviderConfig | null;
  attempts: Array<{ providerId: ProviderId; reason: string }>;
}

export function buildFallbackChain(
  models: ProviderModel[],
  failedProviderId: ProviderId,
  rankedModels: Array<{ model: ProviderModel; score: number }>,
  providerConfigs: Map<ProviderId, ProviderConfig>
): FallbackResult {
  const attempts: Array<{ providerId: ProviderId; reason: string }> = [];

  const candidates = rankedModels.filter(
    (r) => r.model.providerId !== failedProviderId && r.model.status !== 'unavailable'
  );

  for (const candidate of candidates) {
    const config = providerConfigs.get(candidate.model.providerId);
    if (!config || !config.isEnabled) {
      attempts.push({
        providerId: candidate.model.providerId,
        reason: 'Provider disabled or not configured',
      });
      continue;
    }

    return {
      model: candidate.model,
      providerConfig: config,
      attempts,
    };
  }

  return { model: null, providerConfig: null, attempts };
}

export function isRetriable(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: string }).code;
    return ['RATE_LIMITED', 'TIMEOUT', 'SERVER_ERROR', 'ALL_FAILED'].includes(code);
  }
  return false;
}
