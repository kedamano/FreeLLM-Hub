import { getDatabase } from '../core/database/database.js';
import { readSetting } from '../core/settings/settings-store.js';
import type { ModelPricing, ModelPricingType } from '../shared/types/index.js';

/**
 * Cost accounting for the free pool.
 *
 * Every provider in this app is either free or has a free tier, so "how much did I
 * spend" is the wrong question; the useful ones are "how much would this have cost on
 * a paid API" and "how close is each provider to its daily ceiling". We therefore
 * store three numbers per call:
 *
 *   cost_usd            what the provider actually charged (0 for free/local tiers)
 *   reference_cost_usd  what the same tokens would have cost at the reference price
 *   saved_cost_usd      reference - actual, floored at 0
 *
 * The reference price is a user-editable setting so the saving number stays meaningful
 * for whatever the user would otherwise have been paying for.
 */

export const COST_REFERENCE_SETTING_KEY = 'cost_reference_price';
export const CURRENCY_RATES_SETTING_KEY = 'currency_rates';

export interface ReferencePrice {
  label: string;
  currency: string;
  inputPer1M: number;
  outputPer1M: number;
}

export const DEFAULT_REFERENCE_PRICE: ReferencePrice = {
  label: 'GPT-4o 级付费基准',
  currency: 'USD',
  inputPer1M: 2.5,
  outputPer1M: 10,
};

/** Static conversion table; override with the `currency_rates` setting. */
export const DEFAULT_CURRENCY_RATES: Record<string, number> = {
  USD: 1,
  CNY: 0.14,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0068,
  KRW: 0.00072,
  RUB: 0.011,
};

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface CallCost {
  costUsd: number;
  referenceCostUsd: number;
  savedCostUsd: number;
  pricingType: ModelPricingType;
  currency: string;
}

function finiteOr(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

export function resolveReferencePrice(raw: string | null = readSetting(COST_REFERENCE_SETTING_KEY)): ReferencePrice {
  if (!raw) return DEFAULT_REFERENCE_PRICE;
  try {
    const parsed = JSON.parse(raw) as Partial<ReferencePrice>;
    const input = finiteOr(parsed.inputPer1M, DEFAULT_REFERENCE_PRICE.inputPer1M);
    const output = finiteOr(parsed.outputPer1M, DEFAULT_REFERENCE_PRICE.outputPer1M);
    return {
      label: typeof parsed.label === 'string' && parsed.label.trim() ? parsed.label.trim() : DEFAULT_REFERENCE_PRICE.label,
      currency:
        typeof parsed.currency === 'string' && parsed.currency.trim()
          ? parsed.currency.trim().toUpperCase()
          : DEFAULT_REFERENCE_PRICE.currency,
      inputPer1M: input,
      outputPer1M: output,
    };
  } catch {
    return DEFAULT_REFERENCE_PRICE;
  }
}

export function resolveCurrencyRates(
  raw: string | null = readSetting(CURRENCY_RATES_SETTING_KEY)
): Record<string, number> {
  const rates = { ...DEFAULT_CURRENCY_RATES };
  if (!raw) return rates;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [currency, rate] of Object.entries(parsed)) {
      const value = Number(rate);
      if (Number.isFinite(value) && value > 0) rates[currency.toUpperCase()] = value;
    }
  } catch {
    /* keep defaults */
  }
  return rates;
}

export function toUsd(amount: number, currency: string, rates = resolveCurrencyRates()): number {
  const normalized = (currency || 'USD').toUpperCase();
  const rate = rates[normalized];
  if (!Number.isFinite(rate) || rate <= 0) return amount; // unknown currency: assume USD scale
  return amount * rate;
}

/** What the provider charged for these tokens, in USD. */
export function computeModelCost(
  pricing: ModelPricing | null | undefined,
  usage: TokenUsage
): { costUsd: number; pricingType: ModelPricingType; currency: string } {
  const type: ModelPricingType = pricing?.type ?? 'unknown';
  if (!pricing || type === 'free' || type === 'local') {
    return { costUsd: 0, pricingType: type, currency: pricing?.currency ?? 'USD' };
  }

  const inputPrice = finiteOr(pricing.inputPricePer1M, 0);
  const outputPrice = finiteOr(pricing.outputPricePer1M, 0);
  const native =
    (usage.promptTokens / 1_000_000) * inputPrice +
    (usage.completionTokens / 1_000_000) * outputPrice;

  return {
    costUsd: roundMoney(toUsd(native, pricing.currency ?? 'USD')),
    pricingType: type,
    currency: (pricing.currency ?? 'USD').toUpperCase(),
  };
}

/** What the same tokens would have cost at the configured reference price. */
export function computeReferenceCost(
  usage: TokenUsage,
  reference: ReferencePrice = resolveReferencePrice()
): number {
  const native =
    (usage.promptTokens / 1_000_000) * reference.inputPer1M +
    (usage.completionTokens / 1_000_000) * reference.outputPer1M;
  return roundMoney(toUsd(native, reference.currency));
}

export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1e6) / 1e6;
}

const PRICING_CACHE_TTL_MS = 60_000;
const pricingCache = new Map<string, { pricing: ModelPricing | null; at: number }>();

/** Read a model's pricing out of the discovered catalogue (cached; may be absent). */
export function lookupModelPricing(
  providerId: string,
  modelId: string,
  now: number = Date.now()
): ModelPricing | null {
  if (!providerId || !modelId) return null;
  const key = `${providerId}:${modelId}`;
  const cached = pricingCache.get(key);
  if (cached && now - cached.at < PRICING_CACHE_TTL_MS) return cached.pricing;

  let pricing: ModelPricing | null = null;
  try {
    const db = getDatabase();
    const row = db.prepare('SELECT pricing FROM models WHERE provider_id = ? AND id = ?').get(
      providerId,
      modelId
    ) as { pricing: string } | undefined;
    if (row?.pricing) {
      const parsed = JSON.parse(row.pricing) as ModelPricing;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') pricing = parsed;
    }
  } catch {
    pricing = null;
  }

  pricingCache.set(key, { pricing, at: now });
  return pricing;
}

export function clearPricingCache(): void {
  pricingCache.clear();
}

/** Full cost breakdown for one completed call, used when writing the ledger row. */
export function quoteCallCost(
  providerId: string,
  modelId: string,
  usage: TokenUsage
): CallCost {
  const pricing = lookupModelPricing(providerId, modelId);
  const actual = computeModelCost(pricing, usage);
  const referenceCostUsd = computeReferenceCost(usage);
  return {
    costUsd: actual.costUsd,
    referenceCostUsd,
    savedCostUsd: roundMoney(Math.max(0, referenceCostUsd - actual.costUsd)),
    pricingType: actual.pricingType,
    currency: actual.currency,
  };
}
