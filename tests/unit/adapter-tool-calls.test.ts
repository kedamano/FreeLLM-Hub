import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatibleAdapter } from '../../src/core/providers/openai-compatible/adapter';

function makeAdapter(): OpenAICompatibleAdapter {
  const adapter = new OpenAICompatibleAdapter({
    providerId: 'tools-test',
    providerName: 'tools-test',
    baseUrl: 'https://api.example.com/v1',
    authType: 'api-key',
  });
  adapter.setCredentials(['key-1']);
  return adapter;
}

const TOOL_CALLS = [
  { id: 'call_1', type: 'function' as const, function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
];

function upstreamResponse(body: unknown) {
  vi.stubGlobal('fetch', () =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => body,
    })
  );
}

function captureBody(): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    });
  });
  return { body: () => captured };
}

describe('adapter tool_calls round trip', () => {
  it('surfaces upstream tool_calls instead of dropping them', async () => {
    upstreamResponse({
      choices: [{ message: { content: null, tool_calls: TOOL_CALLS }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    });

    const result = await makeAdapter().chat([{ role: 'user', content: '北京天气' }], 'test-model');

    expect(result.toolCalls).toEqual(TOOL_CALLS);
    expect(result.finishReason).toBe('tool_calls');
    vi.unstubAllGlobals();
  });

  it('reports finish_reason tool_calls even when the upstream omits it', async () => {
    upstreamResponse({
      choices: [{ message: { tool_calls: TOOL_CALLS } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await makeAdapter().chat([{ role: 'user', content: 'hi' }], 'test-model');

    expect(result.finishReason).toBe('tool_calls');
    vi.unstubAllGlobals();
  });

  it('keeps tool_calls, tool_call_id and name on the outbound messages', async () => {
    const captured = captureBody();

    await makeAdapter().chat(
      [
        { role: 'user', content: '北京天气' },
        { role: 'assistant', content: null, toolCalls: TOOL_CALLS },
        { role: 'tool', content: '晴, 24°C', toolCallId: 'call_1', name: 'get_weather' },
      ],
      'test-model'
    );

    const messages = captured.body().messages as Array<Record<string, unknown>>;
    expect(messages[1].tool_calls).toEqual(TOOL_CALLS);
    expect(messages[2].tool_call_id).toBe('call_1');
    expect(messages[2].name).toBe('get_weather');
    vi.unstubAllGlobals();
  });

  it('forwards the sampling parameters the client sent', async () => {
    const captured = captureBody();

    await makeAdapter().chat([{ role: 'user', content: 'hi' }], 'test-model', {
      topP: 0.5,
      stop: ['END'],
      toolChoice: 'required',
      tools: [{ type: 'function', function: { name: 'get_weather' } }],
    });

    const body = captured.body();
    expect(body.top_p).toBe(0.5);
    expect(body.stop).toEqual(['END']);
    expect(body.tool_choice).toBe('required');
    expect(body.tools).toBeDefined();
    vi.unstubAllGlobals();
  });
});
