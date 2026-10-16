import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  pricing: undefined as string | undefined,
  prepareCalls: 0,
}));

vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => ({
    prepare: (sql: string) => {
      if (sql.includes('SELECT pricing FROM models')) {
        state.prepareCalls += 1;
        return {
          get: () => (state.pricing ? { pricing: state.pricing } : undefined),
        };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  }),
}));

import {
  DEFAULT_CURRENCY_RATES,
  DEFAULT_REFERENCE_PRICE,
  clearPricingCache,
  computeModelCost,
  computeReferenceCost,
  quoteCallCost,
  resolveCurrencyRates,
  resolveReferencePrice,
  roundMoney,
  toUsd,
} from '../../src/usage/cost-model';

beforeEach(() => {
  state.pricing = undefined;
  clearPricingCache();
});

describe('reference price', () => {
  it('falls back to the built-in benchmark when the setting is absent or corrupt', () => {
    expect(resolveReferencePrice(null)).toEqual(DEFAULT_REFERENCE_PRICE);
    expect(resolveReferencePrice('not json')).toEqual(DEFAULT_REFERENCE_PRICE);
    expect(resolveReferencePrice('{"inputPer1M": -3}').inputPer1M).toBe(
      DEFAULT_REFERENCE_PRICE.inputPer1M
    );
  });

  it('accepts a partial override and keeps the defaults for the rest', () => {
    const resolved = resolveReferencePrice('{"inputPer1M":1.25,"label":"自定义"}');
    expect(resolved.inputPer1M).toBe(1.25);
    expect(resolved.outputPer1M).toBe(DEFAULT_REFERENCE_PRICE.outputPer1M);
    expect(resolved.label).toBe('自定义');
  });
});

describe('currency handling', () => {
  it('converts with the configured rate and leaves unknown currencies alone', () => {
    expect(toUsd(100, 'CNY', DEFAULT_CURRENCY_RATES)).toBeCloseTo(14, 6);
    expect(toUsd(100, 'USD')).toBe(100);
    expect(toUsd(100, 'xts')).toBe(100);
    expect(toUsd(100, 'usd', DEFAULT_CURRENCY_RATES)).toBeCloseTo(100, 6);
  });

  it('merges an override map over the defaults', () => {
    const rates = resolveCurrencyRates('{"CNY":0.2,"BRL":0.18}');
    expect(rates.CNY).toBe(0.2);
    expect(rates.BRL).toBe(0.18);
    expect(rates.USD).toBe(1);
    expect(resolveCurrencyRates('garbage').USD).toBe(1);
  });
});

describe('computeModelCost', () => {
  it('prices free and local models at zero', () => {
    const usage = { promptTokens: 1000, completionTokens: 2000 };
    expect(computeModelCost({ type: 'free', currency: 'USD' }, usage).costUsd).toBe(0);
    expect(computeModelCost({ type: 'local', currency: 'USD' }, usage).costUsd).toBe(0);
    expect(computeModelCost(undefined, usage)).toMatchObject({ costUsd: 0, pricingType: 'unknown' });
  });

  it('prices per-million token rates and converts the provider currency', () => {
    const result = computeModelCost(
      { type: 'paid', currency: 'CNY', inputPricePer1M: 1, outputPricePer1M: 2 },
      { promptTokens: 1_000_000, completionTokens: 500_000 }
    );
    // 1 CNY + 1 CNY = 2 CNY, converted at the default rate.
    expect(result.costUsd).toBeCloseTo(toUsd(2, 'CNY'), 6);
    expect(result.pricingType).toBe('paid');
  });

  it('treats a freemium model with no numbers as free rather than guessing', () => {
    expect(
      computeModelCost({ type: 'freemium', currency: 'USD' }, { promptTokens: 10, completionTokens: 10 })
        .costUsd
    ).toBe(0);
  });
});

describe('computeReferenceCost', () => {
  it('values a free call at the paid benchmark so savings are non-zero', () => {
    const value = computeReferenceCost(
      { promptTokens: 1_000_000, completionTokens: 1_000_000 },
      DEFAULT_REFERENCE_PRICE
    );
    expect(value).toBeCloseTo(DEFAULT_REFERENCE_PRICE.inputPer1M + DEFAULT_REFERENCE_PRICE.outputPer1M, 6);
  });

  it('rounds to micro-dollar precision', () => {
    expect(roundMoney(0.0000004)).toBe(0);
    expect(roundMoney(0.0000006)).toBe(0.000001);
    expect(roundMoney(Number.NaN)).toBe(0);
  });
});

describe('quoteCallCost', () => {
  it('reads pricing from the model catalogue and reports the saving', () => {
    state.pricing = JSON.stringify({ type: 'free', currency: 'USD' });
    const quote = quoteCallCost('groq', 'llama-3.3', { promptTokens: 100, completionTokens: 50 });
    expect(quote.costUsd).toBe(0);
    expect(quote.savedCostUsd).toBeGreaterThan(0);
    expect(quote.referenceCostUsd).toBe(quote.savedCostUsd);
    expect(quote.pricingType).toBe('free');
  });

  it('subtracts the real charge from the benchmark for a paid model', () => {
    state.pricing = JSON.stringify({
      type: 'paid',
      currency: 'USD',
      inputPricePer1M: 0.5,
      outputPricePer1M: 1,
    });
    const quote = quoteCallCost('deepseek', 'chat', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(quote.costUsd).toBeCloseTo(1.5, 6);
    expect(quote.savedCostUsd).toBeCloseTo(quote.referenceCostUsd - 1.5, 6);
  });

  it('degrades to zero cost when the model was never discovered', () => {
    state.pricing = undefined;
    const quote = quoteCallCost('mystery', 'unknown-model', {
      promptTokens: 10,
      completionTokens: 10,
    });
    expect(quote.costUsd).toBe(0);
    expect(quote.pricingType).toBe('unknown');
    // Nothing was charged, so the whole benchmark counts as saved — but the
    // pricing_type column keeps that assumption visible instead of silent.
    expect(quote.savedCostUsd).toBe(quote.referenceCostUsd);
  });

  it('caches the catalogue lookup so a hot path does not re-read the database', () => {
    state.pricing = JSON.stringify({ type: 'free', currency: 'USD' });
    state.prepareCalls = 0;
    quoteCallCost('groq', 'llama-3.3', { promptTokens: 1, completionTokens: 1 });
    quoteCallCost('groq', 'llama-3.3', { promptTokens: 1, completionTokens: 1 });
    expect(state.prepareCalls).toBe(1);

    clearPricingCache();
    quoteCallCost('groq', 'llama-3.3', { promptTokens: 1, completionTokens: 1 });
    expect(state.prepareCalls).toBe(2);
  });
});
