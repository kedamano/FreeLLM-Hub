import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpenRouterAdapter } from '../../src/core/providers/openrouter/adapter';
import { createNvidiaAdapter } from '../../src/core/providers/nvidia/adapter';

const DELISTED = new Set([
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'qwen/qwen3-235b-a22b:free',
  'deepseek-ai/deepseek-r1',
  'meta/llama-3.3-70b-instruct',
]);

describe('built-in model catalogs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['openrouter', createOpenRouterAdapter],
    ['nvidia', createNvidiaAdapter],
  ])('%s static catalog has no delisted model ids', async (_name, create) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 }))
    );
    const adapter = create('test-key');
    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(DELISTED.has(model.id), `${_name}: ${model.id}`).toBe(false);
    }
  });
});
