import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleAdapter } from '../../src/core/providers/openai-compatible/adapter';
import type { GatewayMessage, StreamChunk } from '../../src/core/providers/contracts';

function makeAdapter(): OpenAICompatibleAdapter {
  const adapter = new OpenAICompatibleAdapter({
    providerId: 'reasoning-test',
    providerName: 'reasoning-test',
    baseUrl: 'https://api.example.com/v1',
    authType: 'api-key',
  });
  adapter.setCredentials(['key-1']);
  return adapter;
}

function stubJson(body: unknown) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => body })
  );
}

/** Feed raw SSE text through the same ReadableStream shape a real response body has. */
function stubSse(frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  vi.stubGlobal('fetch', () =>
    Promise.resolve({ ok: true, status: 200, headers: new Headers(), body })
  );
}

async function collect(adapter: OpenAICompatibleAdapter, messages: GatewayMessage[]) {
  const chunks: StreamChunk[] = [];
  for await (const chunk of adapter.chatStream(messages, 'test-model')) chunks.push(chunk);
  return chunks;
}

describe('reasoning_content pass-through', () => {
  it('keeps chain-of-thought apart from the answer in a non-streaming reply', async () => {
    stubJson({
      choices: [
        {
          message: { content: 'the answer', reasoning_content: 'let me think' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 30, total_tokens: 35 },
    });

    const result = await makeAdapter().chat([{ role: 'user', content: 'hi' }], 'test-model');

    expect(result.content).toBe('the answer');
    expect(result.reasoningContent).toBe('let me think');
    vi.unstubAllGlobals();
  });

  it('counts chain-of-thought in the fallback completion estimate', async () => {
    stubJson({
      choices: [{ message: { content: '', reasoning_content: 'a'.repeat(400) } }],
    });

    const result = await makeAdapter().chat([{ role: 'user', content: 'hi' }], 'test-model');

    expect(result.usage.completionTokens).toBeGreaterThan(0);
    vi.unstubAllGlobals();
  });

  it('accepts the OpenRouter spelling of chain-of-thought too', async () => {
    stubJson({
      choices: [{ message: { content: 'answer', reasoning: 'thought' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });

    const result = await makeAdapter().chat([{ role: 'user', content: 'hi' }], 'test-model');
    expect(result.reasoningContent).toBe('thought');
    vi.unstubAllGlobals();
  });

  it('streams reasoning deltas and still skips frames that carry nothing', async () => {
    stubSse([
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning":"thought"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"ing"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]);

    const chunks = await collect(makeAdapter(), [{ role: 'user', content: 'hi' }]);

    expect(chunks).toEqual([
      { reasoningContent: 'thought' },
      { reasoningContent: 'ing' },
      { usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 } },
      { content: 'answer' },
      { finishReason: 'stop' },
    ]);
    vi.unstubAllGlobals();
  });

  it('sends multimodal content parts upstream unchanged', async () => {
    let captured: Record<string, unknown> = {};
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      captured = JSON.parse(init.body) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      });
    });

    const parts = [
      { type: 'text' as const, text: 'what is in this image' },
      { type: 'image_url' as const, image_url: { url: 'https://e.com/a.png', detail: 'low' as const } },
    ];
    await makeAdapter().chat([{ role: 'user', content: parts }], 'test-model');

    const messages = captured.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toEqual(parts);
    vi.unstubAllGlobals();
  });
});
