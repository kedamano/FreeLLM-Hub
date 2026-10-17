import { describe, it, expect, vi } from 'vitest';

import { buildCapabilities, GENERIC_CHAT_CAPS } from '../../src/shared/utils/capabilities';
import { BUILTIN_PROVIDER_SEEDS, PROVIDER_SEEDS_BY_ID, buildModels } from '../../src/core/providers/catalog';
import { createOllamaAdapter } from '../../src/core/providers/local/ollama-adapter';
import { createStaticAdapter } from '../../src/core/providers/openai-compatible/static-adapter';
import type { ModelCapabilities, ModelCapability } from '../../src/shared/types/index';

/**
 * The scheduler routes on `capabilities.supported` while the model page renders the
 * `supportsX` booleans. If those ever disagree, a model is offered for a capability it
 * then fails to deliver, so every producer must derive the booleans from the list.
 */
function expectFlagsDerivedFromList(caps: ModelCapabilities, label: string): void {
  expect(
    {
      streaming: caps.supportsStreaming,
      vision: caps.supportsVision,
      'function-calling': caps.supportsFunctionCalling,
      'json-mode': caps.supportsJsonMode,
    },
    label
  ).toEqual({
    streaming: caps.supported.includes('streaming'),
    vision: caps.supported.includes('vision'),
    'function-calling': caps.supported.includes('function-calling'),
    'json-mode': caps.supported.includes('json-mode'),
  });
}

describe('capability flag derivation', () => {
  it('projects every capability in the list onto its flag', () => {
    const caps = buildCapabilities(['chat', 'vision', 'json-mode'], 4096);
    expect(caps).toMatchObject({
      contextWindow: 4096,
      supportsStreaming: false,
      supportsVision: true,
      supportsFunctionCalling: false,
      supportsJsonMode: true,
    });
    expect(caps.maxOutputTokens).toBeUndefined();
  });

  it('keeps maxOutputTokens out of the object when unset', () => {
    expect('maxOutputTokens' in buildCapabilities(['chat'], 1024)).toBe(false);
    expect(buildCapabilities(['chat'], 1024, 256).maxOutputTokens).toBe(256);
  });

  it('treats an empty list as no capabilities at all', () => {
    const empty = buildCapabilities([], 0);
    expect(empty.supportsStreaming).toBe(false);
    expectFlagsDerivedFromList(empty, 'empty list');
  });

  it('copies the capability list it is given', () => {
    const supported: ModelCapability[] = ['chat'];
    const caps = buildCapabilities(supported, 1);
    caps.supported.push('vision');
    expect(supported).toEqual(['chat']);
  });

  it('keeps all 41 built-in catalog models consistent', () => {
    let modelCount = 0;
    for (const provider of BUILTIN_PROVIDER_SEEDS) {
      for (const model of buildModels(provider)) {
        modelCount += 1;
        expectFlagsDerivedFromList(model.capabilities, `${provider.id}/${model.id}`);
      }
    }
    expect(modelCount).toBeGreaterThan(0);
  });

  it('keeps configured Ollama models consistent', async () => {
    // No Ollama daemon here: listModels() falls back to the configured set.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const adapter = createOllamaAdapter({
      models: [
        { id: 'llama3', displayName: 'Llama 3' },
        { id: 'llava', displayName: 'Llava', supportsVision: true },
        { id: 'qwen', displayName: 'Qwen', capabilities: ['chat', 'function-calling'] },
      ],
    });
    try {
      const models = await adapter.listModels();
      for (const model of models) {
        expectFlagsDerivedFromList(model.capabilities, `ollama configured ${model.id}`);
      }
      // The legacy `supportsVision: true` shorthand also lands in the list the scheduler reads.
      const llava = models.find((m) => m.id === 'llava');
      expect(llava?.capabilities.supported).toContain('vision');
      expect(llava?.capabilities.supportsVision).toBe(true);
      expect(models.find((m) => m.id === 'qwen')?.capabilities.supportsJsonMode).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps Ollama models discovered from a running daemon consistent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [{ name: 'newly-pulled' }] }) })
    );
    const adapter = createOllamaAdapter();
    try {
      const models = await adapter.listModels();
      expect(models.map((m) => m.id)).toEqual(['newly-pulled']);
      expectFlagsDerivedFromList(models[0].capabilities, 'ollama discovered');
      expect(models[0].capabilities.supported).toEqual(GENERIC_CHAT_CAPS);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps the OpenAI-compatible unknown-model fallback consistent', async () => {
    // Groq returns models we have no seed for; the adapter synthesises a stand-in,
    // and that stand-in is what the scheduler and the model page both read.
    const adapter = createStaticAdapter(PROVIDER_SEEDS_BY_ID.groq, 'sk-test');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'brand-new-model' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const models = await adapter.listModels();
      expect(models.map((m) => m.id)).toEqual(['brand-new-model']);
      expectFlagsDerivedFromList(models[0].capabilities, 'openai-compatible fallback');
      expect(models[0].capabilities.supported).toEqual(GENERIC_CHAT_CAPS);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
