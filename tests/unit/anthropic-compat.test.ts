import { describe, it, expect } from 'vitest';
import {
  AnthropicStreamTranslator,
  AnthropicTranslateError,
  estimateAnthropicTokens,
  mapStopReason,
  translateAnthropicRequest,
  translateErrorToAnthropic,
  translateGatewayResponse,
  translateToolChoice,
  type AnthropicMessagesRequest,
} from '../../src/main/gateway/anthropic';
import type { GatewayResponse, StreamChunk } from '../../src/shared/types/index';

const BASE: AnthropicMessagesRequest = {
  model: 'llama-3.3',
  max_tokens: 1024,
  messages: [{ role: 'user', content: '你好' }],
};

describe('anthropic request translation', () => {
  it('moves the top-level system prompt to the first gateway message', () => {
    const { gateway } = translateAnthropicRequest(
      { ...BASE, system: '你是聚合网关' },
      'req-1'
    );
    expect(gateway.messages[0]).toEqual({ role: 'system', content: '你是聚合网关' });
    expect(gateway.messages[1]).toEqual({ role: 'user', content: '你好' });
    expect(gateway.requestId).toBe('req-1');
    expect(gateway.maxTokens).toBe(1024);
  });

  it('joins system block arrays and skips empty ones', () => {
    const { gateway } = translateAnthropicRequest(
      {
        ...BASE,
        system: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      },
      'req-2'
    );
    expect(gateway.messages[0].content).toBe('第一段\n第二段');
  });

  it('defaults max_tokens like the Anthropic API requires', () => {
    const { gateway } = translateAnthropicRequest(
      { messages: BASE.messages } as AnthropicMessagesRequest,
      'req-3'
    );
    expect(gateway.maxTokens).toBe(4096);
  });

  it('maps image blocks to data-URL parts and keeps text alongside', () => {
    const { gateway } = translateAnthropicRequest(
      {
        ...BASE,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '这是什么' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
            ],
          },
        ],
      },
      'req-4'
    );
    expect(gateway.messages[0].content).toEqual([
      { type: 'text', text: '这是什么' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ]);
  });

  it('passes remote image sources through untouched', () => {
    const { gateway } = translateAnthropicRequest(
      {
        ...BASE,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'url', url: 'https://x/img.png' } }],
          },
        ],
      },
      'req-5'
    );
    expect(gateway.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: 'https://x/img.png' } },
    ]);
  });

  it('splits an assistant turn with text + tool_use into content plus toolCalls', () => {
    const { gateway } = translateAnthropicRequest(
      {
        ...BASE,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '我来查天气' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '杭州' } },
            ],
          },
        ],
      },
      'req-6'
    );
    expect(gateway.messages).toHaveLength(1);
    expect(gateway.messages[0]).toMatchObject({
      role: 'assistant',
      content: '我来查天气',
    });
    expect(gateway.messages[0].toolCalls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"杭州"}' },
      },
    ]);
  });

  it('explodes multiple tool_result blocks into one tool message each', () => {
    const { gateway } = translateAnthropicRequest(
      {
        ...BASE,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 25°C' },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_2',
                content: [{ type: 'text', text: '失败原因' }],
                is_error: true,
              },
            ],
          },
        ],
      },
      'req-7'
    );
    expect(gateway.messages).toEqual([
      { role: 'tool', toolCallId: 'toolu_1', content: '晴 25°C' },
      { role: 'tool', toolCallId: 'toolu_2', content: '失败原因' },
    ]);
  });

  it('drops thinking blocks with a warning instead of forwarding them', () => {
    const { gateway, warnings } = translateAnthropicRequest(
      {
        ...BASE,
        messages: [
          { role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理', signature: 'sig' }] },
        ],
      },
      'req-8'
    );
    expect(gateway.messages).toEqual([]);
    expect(warnings.some((w) => w.includes('thinking'))).toBe(true);
  });

  it('maps tools and every tool_choice spelling', () => {
    const { gateway } = translateAnthropicRequest(
      {
        ...BASE,
        tools: [
          { name: 'get_weather', description: '查天气', input_schema: { type: 'object' } },
        ],
        tool_choice: { type: 'tool', name: 'get_weather' },
      },
      'req-9'
    );
    expect(gateway.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object' },
        },
      },
    ]);
    expect(gateway.toolChoice).toEqual({
      type: 'function',
      function: { name: 'get_weather' },
    });
    expect(translateToolChoice('any')).toBe('required');
    expect(translateToolChoice('none')).toBe('none');
    expect(translateToolChoice('auto')).toBe('auto');
  });

  it('carries stop_sequences, temperature and top_p', () => {
    const { gateway } = translateAnthropicRequest(
      { ...BASE, stop_sequences: ['END', 'STOP'], temperature: 0.3, top_p: 0.9, stream: true },
      'req-10'
    );
    expect(gateway).toMatchObject({ stop: ['END', 'STOP'], temperature: 0.3, topP: 0.9, stream: true });
  });

  it('rejects an empty messages array with an invalid_request_error', () => {
    expect(() =>
      translateAnthropicRequest({ ...BASE, messages: [] }, 'req-11')
    ).toThrowError(AnthropicTranslateError);
  });
});

describe('anthropic response translation', () => {
  const base: GatewayResponse = {
    requestId: 'req-42',
    model: 'llama-3.3-70b',
    providerId: 'groq',
    content: '今天晴',
    usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
    finishReason: 'stop',
    durationMs: 120,
    createdAt: new Date().toISOString(),
  };

  it('builds a text message with end_turn and echoed requested model', () => {
    const out = translateGatewayResponse(base, 'llama-3.3');
    expect(out).toMatchObject({
      id: 'msg_req-42',
      type: 'message',
      role: 'assistant',
      model: 'llama-3.3',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    expect(out.content).toEqual([{ type: 'text', text: '今天晴' }]);
  });

  it('emits tool_use blocks with parsed input and stop_reason tool_use', () => {
    const out = translateGatewayResponse(
      {
        ...base,
        content: '',
        toolCalls: [
          { id: 'toolu_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
        ],
        finishReason: 'tool_calls',
      },
      'llama-3.3'
    );
    expect(out.stop_reason).toBe('tool_use');
    expect(out.content).toEqual([
      { type: 'tool_use', id: 'toolu_9', name: 'get_weather', input: { city: '北京' } },
    ]);
  });

  it('keeps unparsable tool arguments visible instead of crashing', () => {
    const out = translateGatewayResponse(
      {
        ...base,
        content: '',
        toolCalls: [{ id: 't', type: 'function', function: { name: 'f', arguments: '{oops' } }],
      },
      'm'
    );
    expect(out.content[0]).toMatchObject({ type: 'tool_use', input: { _raw: '{oops' } });
  });

  it('maps the finish-reason table', () => {
    expect(mapStopReason('length')).toBe('max_tokens');
    expect(mapStopReason('tool_calls')).toBe('tool_use');
    expect(mapStopReason('content_filter')).toBe('refusal');
    expect(mapStopReason('stop_sequence')).toBe('stop_sequence');
    expect(mapStopReason(undefined)).toBe('end_turn');
    expect(mapStopReason('whatever')).toBe('end_turn');
  });
});

/** Drive the translator and return the parsed event stream. */
function runStream(chunks: StreamChunk[], model = 'llama-3.3') {
  const t = new AnthropicStreamTranslator('msg_req-x', model);
  const raw = chunks.map((chunk) => t.push(chunk)).join('') + t.finishAbruptly();
  return raw
    .split('\n\n')
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)![1];
      return { event, payload: JSON.parse(block.match(/^data: (.+)$/m)![1]) };
    });
}

describe('anthropic stream translation', () => {
  it('emits the full grammar for a plain text answer', () => {
    const events = runStream([
      { content: '今天' },
      { content: '晴', finishReason: 'stop', usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } },
    ]);

    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(events[0].payload.message).toMatchObject({
      id: 'msg_req-x',
      role: 'assistant',
      model: 'llama-3.3',
    });
    expect(events[1].payload.content_block).toEqual({ type: 'text', text: '' });
    expect(events[2].payload.delta).toEqual({ type: 'text_delta', text: '今天' });
    expect(events[5].payload.delta).toEqual({ stop_reason: 'end_turn', stop_sequence: null });
    expect(events[5].payload.usage).toEqual({ output_tokens: 3 });
  });

  it('never emits empty text blocks', () => {
    const events = runStream([{ finishReason: 'stop' }]);
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });

  it('separates thinking and text into consecutive blocks', () => {
    const events = runStream([
      { reasoningContent: '先想一下' },
      { content: '答案' },
      { finishReason: 'stop' },
    ]);
    const starts = events.filter((e) => e.event === 'content_block_start');
    expect(starts.map((s) => s.payload.content_block.type)).toEqual(['thinking', 'text']);
    const thinkingDelta = events.find((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'thinking_delta');
    expect(thinkingDelta?.payload.index).toBe(0);
    const textDelta = events.find((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'text_delta');
    expect(textDelta?.payload.index).toBe(1);
  });

  it('streams tool calls as tool_use blocks with input_json_delta fragments', () => {
    const events = runStream([
      {
        toolCalls: [{ index: 0, id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"ci' } }],
      },
      {
        toolCalls: [{ index: 0, function: { arguments: 'ty":"北京"}' } }],
        finishReason: 'tool_calls',
      },
    ]);
    const kinds = events
      .filter((e) => e.event === 'content_block_start')
      .map((e) => e.payload.content_block);
    expect(kinds).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }]);
    const jsonDeltas = events
      .filter((e) => e.event === 'content_block_delta' && e.payload.delta.type === 'input_json_delta')
      .map((e) => e.payload.delta.partial_json);
    expect(jsonDeltas.join('')).toBe('{"city":"北京"}');
    expect(events.at(-2)?.payload.delta.stop_reason).toBe('tool_use');
  });

  it('does not finish twice and can end abruptly without a finish reason', () => {
    const t = new AnthropicStreamTranslator('msg_1', 'm');
    t.push({ content: 'a', finishReason: 'stop' });
    const extra = t.push({ content: 'b' });
    expect(extra).toBe('');
    expect(t.finishAbruptly()).toBe('');
  });

  it('emits an error event on stream failure', () => {
    const t = new AnthropicStreamTranslator('msg_2', 'm');
    const raw = t.fail('overloaded_error', '全部服务商不可用');
    expect(raw).toContain('event: error');
    expect(raw).toContain('overloaded_error');
  });
});

describe('count_tokens and error envelope', () => {
  it('estimates tokens over the whole conversation including tool schemas', () => {
    const n = estimateAnthropicTokens({
      ...BASE,
      system: '系统提示词',
      tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
    });
    expect(n).toBeGreaterThan(0);
  });

  it('maps gateway errors onto the Anthropic envelope', () => {
    expect(translateErrorToAnthropic(400, 'BAD_REQUEST', 'x').body.error).toEqual({
      type: 'invalid_request_error',
      message: 'x',
    });
    expect(translateErrorToAnthropic(429, 'RATE_LIMITED', 'x').body.error.type).toBe('rate_limit_error');
    expect(translateErrorToAnthropic(429, 'QUOTA_EXCEEDED', 'x').body.error.type).toBe('rate_limit_error');
    expect(translateErrorToAnthropic(503, 'ALL_FAILED', 'x')).toMatchObject({
      status: 503,
      body: { error: { type: 'overloaded_error' } },
    });
    expect(translateErrorToAnthropic(504, 'TIMEOUT', 'x').body.error.type).toBe('timeout_error');
  });
});
