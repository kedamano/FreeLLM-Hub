import { describe, expect, it, vi } from 'vitest';

import { OllamaAdapter } from '../../src/core/providers/local/ollama-adapter';
import type { GatewayMessage } from '../../src/core/providers/contracts';

function captureChatBody(messages: GatewayMessage[]) {
  let captured: Record<string, unknown> = {};
  vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body) as Record<string, unknown>;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ message: { content: 'ok' }, done: true }),
    });
  });
  const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:11434' });
  return adapter
    .chat(messages, 'llava')
    .then(() => captured)
    .finally(() => vi.unstubAllGlobals());
}

describe('ollama multimodal conversion', () => {
  it('moves image parts into Ollama images and flattens text into content', async () => {
    const body = await captureChatBody([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      },
    ]);

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'user', content: 'describe this', images: ['QUJD'] });
  });

  it('never fetches a remote image url from this process', async () => {
    const body = await captureChatBody([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://e.com/a.png' } }],
      },
    ]);

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0].content).toBe('');
    expect(messages[0].images).toEqual(['https://e.com/a.png']);
  });

  it('still drops messages that carry neither text nor images', async () => {
    const body = await captureChatBody([
      { role: 'system', content: null },
      { role: 'user', content: 'hello' },
    ]);

    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
