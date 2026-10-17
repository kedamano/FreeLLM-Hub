import { describe, it, expect, vi, afterEach } from 'vitest';

// The registration test below builds adapters through bootstrap, which only touches the
// database for custom providers; the unit-test double keeps that path out of the picture.
vi.mock('../../src/core/database/database', () => ({
  getDatabase: () => {
    throw new Error('no database in unit tests');
  },
}));

import {
  BUILTIN_PROVIDER_SEEDS,
  PROVIDERS_WITHOUT_PUBLISHED_RATE_LIMITS,
  builtInProviderIds,
  buildModels,
} from '../../src/core/providers/catalog';
import { createStaticAdapter } from '../../src/core/providers/openai-compatible/static-adapter';
import { registerAllProviders } from '../../src/core/providers/bootstrap';
import type { ProviderAdapter, ProviderRegistry } from '../../src/core/providers/contracts';

/** Model ids the upstream providers have withdrawn — they must never ship in the catalog. */
const DELISTED = new Set([
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen3-235b-a22b:free',
  'deepseek-ai/deepseek-r1',
  'meta/llama-3.3-70b-instruct',
]);

const PRICING_TYPES = ['free', 'freemium', 'paid', 'unknown', 'local'];

/**
 * Capability flags the model pages used to render while the router kept refusing the
 * request. These models now declare the capability in `supported`, so both agree.
 */
const ENRICHED: Array<[string, string, string]> = [
  ['groq', 'llama-3.3-70b-versatile', 'function-calling'],
  ['deepseek', 'deepseek-chat', 'function-calling'],
  ['deepseek', 'deepseek-reasoner', 'json-mode'],
  ['moonshot', 'kimi-k2-0905-preview', 'vision'],
  ['minimax', 'MiniMax-VL-01', 'vision'],
  ['zhipu', 'glm-4-flash', 'json-mode'],
  ['google-gemini', 'gemini-2.0-flash-lite', 'function-calling'],
];

function emptySecrets() {
  return {
    retrieve: () => null,
    store: () => undefined,
    delete: () => false,
  };
}

function listRegistry() {
  const adapters = new Map<string, ProviderAdapter>();
  const registry: ProviderRegistry = {
    register: (adapter) => {
      adapters.set(adapter.providerId, adapter);
    },
    unregister: (id) => {
      adapters.delete(id);
    },
    get: (id) => adapters.get(id),
    getAll: () => Array.from(adapters.values()),
  };
  return { registry, adapters };
}

describe('built-in provider catalog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('has one entry per provider id and no duplicates', () => {
    const ids = BUILTIN_PROVIDER_SEEDS.map((seed) => seed.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('groq');
    expect(builtInProviderIds()).toEqual(ids);
  });

  describe.each(BUILTIN_PROVIDER_SEEDS)('$id', (seed) => {
    const models = buildModels(seed);

    it('lists at least one model with unique ids', () => {
      expect(models.length).toBeGreaterThan(0);
      const ids = models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const model of models) expect(DELISTED.has(model.id), model.id).toBe(false);
    });

    it('routes chat traffic and never exceeds its context window', () => {
      for (const model of models) {
        const { capabilities } = model;
        expect(capabilities.supported.length, model.id).toBeGreaterThan(0);
        expect(capabilities.supported, model.id).toContain('chat');
        expect(new Set(capabilities.supported).size, model.id).toBe(capabilities.supported.length);
        expect(capabilities.contextWindow, model.id).toBeGreaterThan(0);
        if (capabilities.maxOutputTokens !== undefined) {
          expect(capabilities.maxOutputTokens, model.id).toBeLessThanOrEqual(
            capabilities.contextWindow
          );
        }
      }
    });

    it('prices every model in a currency the cost ledger understands', () => {
      for (const model of models) {
        expect(PRICING_TYPES, model.id).toContain(model.pricing.type);
        expect(['USD', 'CNY'], model.id).toContain(model.pricing.currency);
      }
    });

    it('derives the rendered capability flags from the routed capability list', () => {
      for (const model of models) {
        const { supported, ...flags } = model.capabilities;
        expect(flags.supportsStreaming, model.id).toBe(supported.includes('streaming'));
        expect(flags.supportsVision, model.id).toBe(supported.includes('vision'));
        expect(flags.supportsFunctionCalling, model.id).toBe(supported.includes('function-calling'));
        expect(flags.supportsJsonMode, model.id).toBe(supported.includes('json-mode'));
      }
    });

    it('states a rate limit or records why it has none', () => {
      const declared = models.some((model) => model.rateLimits);
      if (declared) return;
      expect(
        PROVIDERS_WITHOUT_PUBLISHED_RATE_LIMITS,
        `${seed.id} publishes no rate limit but is not listed as such`
      ).toContain(seed.id);
    });

    it('serves the catalog through the adapter it is registered with', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
      const adapter = createStaticAdapter(seed, 'test-key');
      const served = await adapter.listModels();
      expect(served.map((model) => model.id)).toEqual(seed.models.map((model) => model.id));
    });
  });

  it('lists only providers that genuinely publish no rate limit', () => {
    const undeclared = BUILTIN_PROVIDER_SEEDS.filter(
      (seed) => seed.requestsPerMinute === undefined && seed.tokensPerMinute === undefined
    ).map((seed) => seed.id);
    expect([...undeclared].sort()).toEqual([...PROVIDERS_WITHOUT_PUBLISHED_RATE_LIMITS].sort());
  });

  it.each(ENRICHED)('%s/%s declares %s where it is routed', (providerId, modelId, capability) => {
    const seed = BUILTIN_PROVIDER_SEEDS.find((entry) => entry.id === providerId);
    expect(seed, providerId).toBeDefined();
    const model = buildModels(seed!).find((entry) => entry.id === modelId);
    expect(model, modelId).toBeDefined();
    expect(model!.capabilities.supported).toContain(capability);
    expect(model!.capabilities.supportsStreaming).toBeTypeOf('boolean');
  });

  it('registers exactly the catalog, in catalog order, with Ollama first', () => {
    const { registry, adapters } = listRegistry();
    registerAllProviders(registry, emptySecrets() as never, {
      settings: { get: () => null, set: () => undefined, delete: () => undefined },
      secrets: emptySecrets(),
    });

    expect([...adapters.keys()]).toEqual(['ollama', ...builtInProviderIds()]);
    for (const seed of BUILTIN_PROVIDER_SEEDS) {
      const served = adapters.get(seed.id)!.getProviderConfig();
      expect(served.id, seed.id).toBe(seed.id);
      expect(served.baseUrl, seed.id).toBe(seed.baseUrl);
    }
  });

  it('names only real providers and models in the task routes', async () => {
    const { getTaskRoute } = await import('../../src/scheduler/task-router.js');
    const { TASK_TYPES } = await import('../../src/shared/types/index.js');
    const providerIds = new Set(['ollama', ...builtInProviderIds()]);
    const modelIds = new Set(BUILTIN_PROVIDER_SEEDS.flatMap((seed) => seed.models.map((m) => m.id)));

    // 'local' is a legacy token that never matched a provider id; nothing else may drift.
    const legacyTokens = new Set(['local']);

    for (const taskType of TASK_TYPES) {
      const route = getTaskRoute(taskType);
      for (const provider of route.preferredProviders) {
        expect(
          providerIds.has(provider) || legacyTokens.has(provider),
          `${taskType}: unknown preferred provider '${provider}'`
        ).toBe(true);
      }
      for (const model of route.preferredModels) {
        expect(modelIds.has(model), `${taskType}: unknown preferred model '${model}'`).toBe(true);
      }
    }
  });

  it('does not attach a credential to a provider that takes none', () => {
    const seed = BUILTIN_PROVIDER_SEEDS.find((entry) => entry.authType === 'none');
    expect(seed).toBeDefined();
    const config = createStaticAdapter(seed!, 'a-stray-key').getProviderConfig();
    expect(config.authType).toBe('none');
    expect(config.credentialId).toBeUndefined();
  });
});
