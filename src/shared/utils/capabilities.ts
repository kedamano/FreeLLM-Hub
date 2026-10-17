import type { ModelCapabilities, ModelCapability } from '../types/index.js';

/** The default capability set assumed for a model we know nothing about. */
export const GENERIC_CHAT_CAPS: readonly ModelCapability[] = Object.freeze([
  'chat',
  'completion',
  'streaming',
]);

/**
 * `supported` is the authoritative capability list; the four `supportsX` booleans are
 * projections of it. Every producer must go through here so the scheduler's routing
 * input and the badges on the model page can never disagree.
 */
export function buildCapabilities(
  supported: readonly ModelCapability[],
  contextWindow: number,
  maxOutputTokens?: number
): ModelCapabilities {
  const list = [...supported];
  return {
    supported: list,
    contextWindow,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    supportsStreaming: list.includes('streaming'),
    supportsVision: list.includes('vision'),
    supportsFunctionCalling: list.includes('function-calling'),
    supportsJsonMode: list.includes('json-mode'),
  };
}
