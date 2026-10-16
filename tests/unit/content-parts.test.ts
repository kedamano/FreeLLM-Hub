import { describe, expect, it } from 'vitest';

import {
  contentHasImages,
  contentToImages,
  contentToText,
  contentTokenWeight,
  normalizeClientContent,
} from '../../src/shared/utils/content';
import { estimateMessagesTokens } from '../../src/usage/tokenizer';

const IMAGE = { type: 'image_url', image_url: { url: 'https://cdn.example.com/a.png' } };

describe('content part helpers', () => {
  it('joins text parts in order and ignores images', () => {
    expect(contentToText([{ type: 'text', text: 'a' }, IMAGE, { type: 'text', text: 'b' }])).toBe('ab');
  });

  it('collects image urls in document order', () => {
    expect(contentToImages([{ type: 'text', text: 'look' }, IMAGE])).toEqual([
      'https://cdn.example.com/a.png',
    ]);
    expect(contentHasImages('plain string')).toBe(false);
  });

  it('weights an image as a fixed allowance, not as its base64 length', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(40_000)}`;
    const asImage = estimateMessagesTokens([
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] },
    ]);
    const asText = estimateMessagesTokens([{ role: 'user', content: [{ type: 'text', text: dataUrl }] }]);

    expect(contentTokenWeight([{ type: 'text', text: 'hi' }, IMAGE]).imageTokens).toBe(1024);
    expect(asImage).toBeLessThan(asText);
    expect(asImage).toBeLessThan(2000);
  });
});

describe('normalizeClientContent', () => {
  it('passes strings and null through', () => {
    expect(normalizeClientContent('hi')).toEqual({ ok: true, content: 'hi' });
    expect(normalizeClientContent(null)).toEqual({ ok: true, content: null });
    expect(normalizeClientContent(undefined)).toEqual({ ok: true, content: null });
  });

  it('normalises image detail and defaults it to auto', () => {
    const result = normalizeClientContent([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA', detail: 'high' } },
      { type: 'image_url', image_url: { url: 'https://e.com/b.png', detail: 'nonsense' } },
    ]);

    expect(result.ok).toBe(true);
    const parts = (result as { ok: true; content: Array<Record<string, unknown>> }).content;
    expect(parts[0].image_url).toEqual({ url: 'data:image/png;base64,AA', detail: 'high' });
    expect(parts[1].image_url).toEqual({ url: 'https://e.com/b.png', detail: 'auto' });
  });

  it('forwards a provider-specific part type untouched', () => {
    const result = normalizeClientContent([
      { type: 'input_audio', input_audio: { data: 'AA', format: 'mp3' } },
    ]);

    expect(result).toEqual({
      ok: true,
      content: [{ type: 'input_audio', input_audio: { data: 'AA', format: 'mp3' } }],
    });
  });

  it('rejects shapes that would crash an adapter downstream', () => {
    expect(normalizeClientContent(42).ok).toBe(false);
    expect(normalizeClientContent([]).ok).toBe(false);
    expect(normalizeClientContent([null]).ok).toBe(false);
    expect(normalizeClientContent([{ text: 'no type' }]).ok).toBe(false);
    expect(normalizeClientContent([{ type: 'text' }]).ok).toBe(false);
    expect(normalizeClientContent([{ type: 'image_url' }]).ok).toBe(false);
    expect(normalizeClientContent([{ type: 'image_url', image_url: { url: '' } }]).ok).toBe(false);
  });

  it('explains the offending field in the error', () => {
    const result = normalizeClientContent([{ type: 'text' }]);
    expect(result.ok ? '' : result.error).toMatch(/text content part/);
  });
});
