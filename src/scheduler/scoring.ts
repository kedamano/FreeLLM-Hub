import type { ProviderModel, TaskType, ModelPricingType } from '../shared/types/index.js';

export interface ScoringWeights {
  freeBonus: number;
  speedBonus: number;
  capabilityMatch: number;
  contextWindow: number;
  successRate: number;
  costPenalty: number;
}

const DEFAULT_WEIGHTS: ScoringWeights = {
  freeBonus: 30,
  speedBonus: 15,
  capabilityMatch: 25,
  contextWindow: 10,
  successRate: 15,
  costPenalty: 5,
};

export interface ModelScoreContext {
  taskType?: TaskType;
  requiredCapabilities?: string[];
  providerSuccessRates: Map<string, number>;
  providerLatencies: Map<string, number>;
}

export function scoreModel(
  model: ProviderModel,
  context: ModelScoreContext,
  weights: ScoringWeights = DEFAULT_WEIGHTS
): number {
  let score = 0;

  const pricingScore = scorePricing(model.pricing.type);
  score += pricingScore * weights.freeBonus;

  const latency = context.providerLatencies.get(model.providerId) || 500;
  if (latency < 200) score += weights.speedBonus;
  else if (latency < 500) score += weights.speedBonus * 0.7;
  else if (latency < 1000) score += weights.speedBonus * 0.4;

  if (context.requiredCapabilities && context.requiredCapabilities.length > 0) {
    const matched = context.requiredCapabilities.filter((cap) =>
      model.capabilities.supported.includes(cap as unknown as never)
    ).length;
    const matchRatio = matched / context.requiredCapabilities.length;
    score += matchRatio * weights.capabilityMatch;
  } else {
    score += weights.capabilityMatch;
  }

  if (model.capabilities.contextWindow >= 128000) score += weights.contextWindow;
  else if (model.capabilities.contextWindow >= 32000) score += weights.contextWindow * 0.6;
  else if (model.capabilities.contextWindow >= 8000) score += weights.contextWindow * 0.3;

  const successRate = context.providerSuccessRates.get(model.providerId) ?? 0.95;
  score += successRate * weights.successRate;

  if (model.pricing.type === 'paid') {
    score -= weights.costPenalty * 2;
  }

  return Math.max(0, score);
}

function scorePricing(pricingType: ModelPricingType): number {
  switch (pricingType) {
    case 'local':
      return 1.0;
    case 'free':
      return 0.9;
    case 'freemium':
      return 0.5;
    case 'paid':
      return 0.1;
    case 'unknown':
      return 0.3;
  }
}

export function rankModels(
  models: ProviderModel[],
  context: ModelScoreContext,
  weights?: ScoringWeights
): Array<{ model: ProviderModel; score: number }> {
  return models
    .map((model) => ({ model, score: scoreModel(model, context, weights) }))
    .sort((a, b) => b.score - a.score);
}
