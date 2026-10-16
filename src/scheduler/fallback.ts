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

const RETRIABLE_CODES = [
  'RATE_LIMITED',
  'TIMEOUT',
  'SERVER_ERROR',
  'ALL_FAILED',
  'NETWORK_ERROR',
];

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function isRetriable(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code) return RETRIABLE_CODES.includes(code);

  if (error instanceof Error) {
    const signature = `${error.name} ${error.message}`.toLowerCase();
    if (/401|403|unauthorized|forbidden|authentication|invalid api key|invalid key/.test(signature)) {
      return false;
    }
    if (/400|404|not found|bad request|invalid_request|unsupported/.test(signature)) {
      return false;
    }
    return true;
  }

  return false;
}
