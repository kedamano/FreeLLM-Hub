import type { GatewayContent, GatewayContentPart } from '../types/index.js';

/**
 * OpenAI's documented token allowance for a single low-resolution image tile plus its
 * 85-token base. Estimates only gate rate limits and quota, never billing, so one
 * conservative flat figure per image is enough and beats counting a data URL's
 * characters as if they were prose.
 */
const IMAGE_TOKEN_ALLOWANCE = 1024;

function isParts(content: GatewayContent): content is GatewayContentPart[] {
  return Array.isArray(content);
}

/** Text of a message body, with multimodal parts joined in order. */
export function contentToText(content: GatewayContent): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('');
}

/** Image references carried by a message body, in document order. */
export function contentToImages(content: GatewayContent): string[] {
  if (!isParts(content)) return [];
  return content
    .map((part) => (part?.type === 'image_url' ? part.image_url?.url : undefined))
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

/** Rough prompt-token weight of a body: its text plus a fixed allowance per image. */
export function contentTokenWeight(content: GatewayContent): { text: string; imageTokens: number } {
  const images = contentToImages(content);
  return { text: contentToText(content), imageTokens: images.length * IMAGE_TOKEN_ALLOWANCE };
}

/**
 * Validates the `content` field a client sent before it reaches the scheduler.
 * Anything that is neither a string, null, nor a well-formed parts array is rejected
 * at the boundary rather than half-parsed and shipped upstream.
 */
export function normalizeClientContent(value: unknown): { ok: true; content: GatewayContent } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, content: null };
  if (typeof value === 'string') return { ok: true, content: value };
  if (!Array.isArray(value)) {
    return { ok: false, error: 'message content must be a string, null, or an array of content parts' };
  }
  if (value.length === 0) {
    return { ok: false, error: 'message content array must not be empty' };
  }

  const parts: GatewayContentPart[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string') {
      return { ok: false, error: 'each content part needs a string type' };
    }
    const part = raw as Record<string, unknown>;
    const type = part.type as string;
    if (type === 'text') {
      if (typeof part.text !== 'string') return { ok: false, error: 'a text content part needs string text' };
      parts.push({ type, text: part.text });
      continue;
    }
    if (type === 'image_url') {
      const imageUrl = part.image_url as { url?: unknown; detail?: unknown } | undefined;
      if (!imageUrl || typeof imageUrl.url !== 'string' || !imageUrl.url) {
        return { ok: false, error: 'an image_url content part needs image_url.url' };
      }
      const detail = imageUrl.detail;
      parts.push({
        type,
        image_url: {
          url: imageUrl.url,
          detail: detail === 'low' || detail === 'high' ? detail : 'auto',
        },
      });
      continue;
    }
    // Unknown part types are forwarded verbatim: a provider the gateway does not know
    // about is allowed to carry its own content, and dropping it would silently change
    // the prompt.
    parts.push({ type, ...(part as Omit<GatewayContentPart, 'type'>) });
  }

  return { ok: true, content: parts };
}

export function contentHasImages(content: GatewayContent): boolean {
  return contentToImages(content).length > 0;
}
