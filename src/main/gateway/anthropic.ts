import type {
  GatewayContent,
  GatewayContentPart,
  GatewayMessage,
  GatewayRequest,
  GatewayResponse,
  GatewayToolCall,
  GatewayUsage,
} from '../../shared/types/index.js';
import type { StreamChunk } from '../../core/providers/contracts.js';
import { estimateMessagesTokens } from '../../usage/tokenizer.js';

/**
 * Anthropic Messages API compatibility layer (`/v1/messages`).
 *
 * Claude Code, Cline and friends speak Anthropic wire format: top-level `system`,
 * content as typed blocks (`text` / `image` / `tool_use` / `tool_result` / `thinking`),
 * required `max_tokens`, `stop_sequences`, and SSE events instead of OpenAI's
 * data-chunks. This module is a *pure* translation layer between that dialect and the
 * gateway's OpenAI-shaped `GatewayRequest` / `GatewayResponse` / `StreamChunk` — no
 * Fastify, no fetch, no scheduler — so the HTTP wiring in `server.ts` stays thin and
 * every rule here is unit-testable without a server.
 *
 * Mapping decisions worth remembering:
 * - Anthropic carries the system prompt top-level; OpenAI wants it as the first
 *   message, so it is prepended.
 * - One Anthropic assistant message can hold text AND `tool_use` blocks; OpenAI splits
 *   that into `content` plus `tool_calls` on the same message.
 * - One Anthropic user message can hold several `tool_result` blocks; OpenAI wants one
 *   `tool` message per `tool_call_id`, so they are exploded.
 * - `thinking` request blocks are dropped (with a warning): sending chain-of-thought
 *   back to an OpenAI-compatible provider is not portable.
 */

export interface AnthropicContentBlockText {
  type: 'text';
  text: string;
}

export interface AnthropicContentBlockImage {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
}

export interface AnthropicContentBlockToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<AnthropicContentBlockText | AnthropicContentBlockImage>;
  is_error?: boolean;
}

export interface AnthropicContentBlockThinking {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export type AnthropicContentBlock =
  | AnthropicContentBlockText
  | AnthropicContentBlockImage
  | AnthropicContentBlockToolUse
  | AnthropicContentBlockToolResult
  | AnthropicContentBlockThinking;

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AnthropicToolChoice = 'auto' | 'any' | 'none' | { type: 'tool'; name: string };

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicMessagesRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | Array<AnthropicContentBlockText>;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  metadata?: { user_id?: string };
}

export interface TranslateResult {
  gateway: GatewayRequest;
  /** Non-fatal decisions a caller may want to log (never shown to the client). */
  warnings: string[];
}

const DEFAULT_MAX_TOKENS = 4096;

function blockText(block: AnthropicContentBlockText): string {
  return typeof block.text === 'string' ? block.text : '';
}

/** Anthropic `image` block -> OpenAI `image_url` part (data URL for base64 sources). */
function imageBlockToPart(block: AnthropicContentBlockImage): GatewayContentPart {
  if (block.source.type === 'url') {
    return { type: 'image_url', image_url: { url: block.source.url } };
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
  };
}

function toolResultToContent(
  block: AnthropicContentBlockToolResult
): GatewayContent {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return block.is_error ? 'tool failed' : '';
  const parts: GatewayContentPart[] = [];
  for (const inner of block.content) {
    if (inner.type === 'text') parts.push({ type: 'text', text: inner.text });
    else if (inner.type === 'image') parts.push(imageBlockToPart(inner));
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text ?? '' : parts;
}

function toolUseToGatewayCall(block: AnthropicContentBlockToolUse): GatewayToolCall {
  return {
    id: block.id,
    type: 'function',
    function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
  };
}

function anthropicToolToOpenAI(tool: AnthropicTool): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** `auto`/`any`/`none`/{tool} -> OpenAI's `auto`/`required`/`none`/{function}. */
export function translateToolChoice(choice: AnthropicToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (choice === 'auto') return 'auto';
  if (choice === 'none') return 'none';
  if (choice === 'any') return 'required';
  if (typeof choice === 'object' && choice.type === 'tool') {
    return { type: 'function', function: { name: choice.name } };
  }
  return undefined;
}

/** Anthropic `stop_reason` names, for response and stream tails. */
export type AnthropicStopReason = 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal';

export function mapStopReason(finishReason: string | undefined): AnthropicStopReason {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop_sequence':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

function systemToMessage(system: AnthropicMessagesRequest['system']): GatewayMessage | null {
  if (system === undefined) return null;
  if (typeof system === 'string') {
    return system.trim() ? { role: 'system', content: system } : null;
  }
  const text = system.map(blockText).join('\n').trim();
  return text ? { role: 'system', content: text } : null;
}

/**
 * Translate one Anthropic message into 1..N gateway messages. `tool_result` blocks
 * explode because OpenAI needs one `tool` message per tool_call_id, in tool-call order.
 */
function translateMessage(
  message: AnthropicMessage,
  warnings: string[]
): GatewayMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }

  const out: GatewayMessage[] = [];
  // These are mutated and reset as blocks accumulate; every flush must COPY them into
  // the message, because clearing the working arrays in place would also empty the
  // arrays a just-pushed message still references.
  let parts: GatewayContentPart[] = [];
  let textChunks: string[] = [];
  let toolCalls: GatewayToolCall[] = [];

  const flushAssistant = () => {
    if (message.role !== 'assistant') return;
    const content: GatewayContent =
      parts.length > 0 ? [...parts] : textChunks.join('') || null;
    if (toolCalls.length > 0 || content !== null) {
      out.push({
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { toolCalls: [...toolCalls] } : {}),
      });
    }
    parts = [];
    textChunks = [];
    toolCalls = [];
  };

  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        if (message.role === 'assistant') textChunks.push(blockText(block));
        else parts.push({ type: 'text', text: blockText(block) });
        break;
      case 'image':
        parts.push(imageBlockToPart(block));
        break;
      case 'tool_use':
        if (message.role === 'assistant') {
          toolCalls.push(toolUseToGatewayCall(block));
        } else {
          warnings.push(`tool_use block appeared in a ${message.role} message and was dropped`);
        }
        break;
      case 'tool_result':
        if (message.role === 'user') {
          // Close any open assistant accumulation before switching roles.
          flushAssistant();
          out.push({
            role: 'tool',
            toolCallId: block.tool_use_id,
            content: toolResultToContent(block),
          });
        } else {
          warnings.push('tool_result block appeared in an assistant message and was dropped');
        }
        break;
      case 'thinking':
        warnings.push('thinking block dropped: not portable to OpenAI-compatible providers');
        break;
      default:
        warnings.push(`unknown block type "${(block as { type?: string }).type}" dropped`);
        break;
    }
  }

  if (message.role === 'assistant') flushAssistant();
  else if (parts.length > 0) out.push({ role: message.role, content: parts });

  return out;
}

export function translateAnthropicRequest(
  body: AnthropicMessagesRequest,
  requestId: string
): TranslateResult {
  const warnings: string[] = [];
  const messages: GatewayMessage[] = [];

  const systemMessage = systemToMessage(body.system);
  if (systemMessage) messages.push(systemMessage);

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new AnthropicTranslateError(
      'invalid_request_error',
      'messages field is required and must be a non-empty array'
    );
  }
  for (const message of body.messages) {
    messages.push(...translateMessage(message, warnings));
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.map(anthropicToolToOpenAI)
    : undefined;

  const stop =
    Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0
      ? body.stop_sequences
      : undefined;

  return {
    gateway: {
      requestId,
      messages,
      model: body.model,
      // Anthropic requires max_tokens; gateway requests treat "absent" as provider
      // default, which is fine — but an explicit default keeps parity with clients
      // that rely on the Anthropic semantics of a hard cap.
      maxTokens: body.max_tokens ?? DEFAULT_MAX_TOKENS,
      temperature: body.temperature,
      topP: body.top_p,
      stop,
      toolChoice: translateToolChoice(body.tool_choice),
      stream: body.stream,
      tools,
    },
    warnings,
  };
}

export class AnthropicTranslateError extends Error {
  constructor(
    readonly errorType: 'invalid_request_error',
    message: string
  ) {
    super(message);
    this.name = 'AnthropicTranslateError';
  }
}

// ─── Response translation ────────────────────────────────────────────

export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<AnthropicContentBlockText | AnthropicContentBlockToolUse | AnthropicContentBlockThinking>;
  stop_reason: AnthropicStopReason;
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

export function translateGatewayResponse(
  response: Pick<GatewayResponse, 'requestId' | 'content' | 'reasoningContent' | 'toolCalls' | 'usage' | 'finishReason'>,
  requestModel: string
): AnthropicMessagesResponse {
  const content: AnthropicMessagesResponse['content'] = [];

  if (response.reasoningContent) {
    content.push({ type: 'thinking', thinking: response.reasoningContent });
  }
  if (response.content) {
    content.push({ type: 'text', text: response.content });
  }
  for (const call of response.toolCalls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      input = { _raw: call.function.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }

  return {
    id: `msg_${response.requestId}`,
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: mapStopReason(response.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: response.usage.promptTokens,
      output_tokens: response.usage.completionTokens,
    },
  };
}

// ─── Streaming translation ───────────────────────────────────────────

interface OpenBlock {
  index: number;
  type: 'text' | 'thinking' | 'tool_use';
  toolId?: string;
  toolName?: string;
}

/**
 * Incremental Anthropic SSE event builder fed by gateway stream chunks.
 *
 * Blocks are opened lazily (empty text blocks are never emitted) and exactly one block
 * is open at a time, matching the Anthropic event grammar: `message_start`, then
 * `content_block_start` / `content_block_delta`* / `content_block_stop` per block, then
 * `message_delta` + `message_stop`.
 */
export class AnthropicStreamTranslator {
  private events: string[] = [];
  private messageStarted = false;
  private blocks: OpenBlock[] = [];
  private nextIndex = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private model: string;
  private readonly messageId: string;
  private finished = false;

  constructor(messageId: string, model: string) {
    this.messageId = messageId;
    this.model = model;
  }

  private sse(event: string, payload: Record<string, unknown>): void {
    this.events.push(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private ensureMessageStart(): void {
    if (this.messageStarted) return;
    this.messageStarted = true;
    this.sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    });
  }

  private closeOpenBlock(): void {
    const open = this.blocks[this.blocks.length - 1];
    if (!open) return;
    this.sse('content_block_stop', { type: 'content_block_stop', index: open.index });
    this.blocks.pop();
  }

  private openBlock(type: OpenBlock['type'], tool?: { id: string; name: string }): OpenBlock {
    this.ensureMessageStart();
    this.closeOpenBlock();
    const block: OpenBlock = { index: this.nextIndex++, type, ...(tool ?? {}) };
    this.blocks.push(block);
    const contentBlock =
      type === 'text'
        ? { type: 'text', text: '' }
        : type === 'thinking'
          ? { type: 'thinking', thinking: '' }
          : { type: 'tool_use', id: tool!.id, name: tool!.name, input: {} };
    this.sse('content_block_start', {
      type: 'content_block_start',
      index: block.index,
      content_block: contentBlock,
    });
    return block;
  }

  private blockFor(kind: 'text' | 'thinking'): OpenBlock | undefined {
    const open = this.blocks[this.blocks.length - 1];
    if (open && open.type === kind) return open;
    return this.openBlock(kind);
  }

  /** Feed one gateway chunk; returns the Anthropic SSE text to write (may be empty). */
  push(chunk: StreamChunk): string {
    // A finished stream accepts nothing further: late chunks after message_stop would
    // reopen blocks and produce a protocol-violating event sequence.
    if (this.finished) return '';
    this.events = [];

    if (chunk.usage) {
      this.inputTokens = chunk.usage.promptTokens || this.inputTokens;
      this.outputTokens = chunk.usage.completionTokens || this.outputTokens;
    }

    if (chunk.reasoningContent) {
      const block = this.blockFor('thinking');
      this.sse('content_block_delta', {
        type: 'content_block_delta',
        index: block!.index,
        delta: { type: 'thinking_delta', thinking: chunk.reasoningContent },
      });
    }

    if (chunk.content) {
      const block = this.blockFor('text');
      this.sse('content_block_delta', {
        type: 'content_block_delta',
        index: block!.index,
        delta: { type: 'text_delta', text: chunk.content },
      });
    }

    for (const delta of chunk.toolCalls ?? []) {
      if (delta.id || delta.function?.name) {
        this.closeOpenBlock();
        this.openBlock('tool_use', {
          id: delta.id ?? `toolu_${delta.index ?? 0}`,
          name: delta.function?.name ?? '',
        });
      }
      if (delta.function?.arguments) {
        // Tool blocks are always the newest open block after a start above.
        const open = this.blocks[this.blocks.length - 1];
        this.sse('content_block_delta', {
          type: 'content_block_delta',
          index: open.index,
          delta: { type: 'input_json_delta', partial_json: delta.function.arguments },
        });
      }
    }

    if (chunk.finishReason) {
      this.flushTail(chunk.finishReason, chunk.usage);
    }

    return this.events.join('');
  }

  private flushTail(finishReason: string | undefined, usage?: GatewayUsage): void {
    if (this.finished) return;
    this.finished = true;
    this.ensureMessageStart();
    this.closeOpenBlock();
    if (usage) {
      this.outputTokens = usage.completionTokens || this.outputTokens;
      this.inputTokens = usage.promptTokens || this.inputTokens;
    }
    this.sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: mapStopReason(finishReason), stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    this.sse('message_stop', { type: 'message_stop' });
  }

  /** Terminal events for a failed stream (used instead of Anthropic's error-less end). */
  fail(errorType: string, message: string): string {
    this.events = [];
    this.ensureMessageStart();
    this.sse('error', { type: 'error', error: { type: errorType, message } });
    return this.events.join('');
  }

  /** True once the terminal message_delta / message_stop pair has been emitted. */
  isFinished(): boolean {
    return this.finished;
  }

  /** Safety net: emit the tail if the generator ended without a finish reason. */
  finishAbruptly(): string {
    // Reset first: if the stream already flushed its tail inside push(), returning the
    // stale buffer would duplicate message_delta / message_stop.
    this.events = [];
    this.flushTail('end_turn');
    return this.events.join('');
  }

  /** Estimated prompt tokens, for the message_start usage block. */
  setInputTokens(tokens: number): void {
    this.inputTokens = tokens;
  }
}

/** `/v1/messages/count_tokens` — a cheap estimate over the translated conversation. */
export function estimateAnthropicTokens(body: AnthropicMessagesRequest): number {
  const warnings: string[] = [];
  const { gateway } = translateAnthropicRequest({ ...body, stream: false }, 'count_tokens');
  void warnings;
  let tokens = estimateMessagesTokens(gateway.messages);
  // Tool schemas travel with every request in the real API; count them roughly.
  if (Array.isArray(body.tools)) {
    tokens += Math.ceil(JSON.stringify(body.tools).length / 4);
  }
  return tokens;
}

/** Map gateway HTTP error semantics onto Anthropic's error envelope. */
export function translateErrorToAnthropic(
  status: number,
  code: string,
  message: string
): { status: number; body: { type: 'error'; error: { type: string; message: string } } } {
  let type = 'api_error';
  if (status === 400) type = 'invalid_request_error';
  else if (status === 401 || status === 403) type = 'authentication_error';
  else if (status === 404) type = 'not_found_error';
  else if (status === 429) type = 'rate_limit_error';
  else if (code === 'QUOTA_EXCEEDED') type = 'rate_limit_error';
  else if (code === 'TIMEOUT' || status === 504) type = 'timeout_error';
  else if (status >= 500 && code === 'ALL_FAILED') type = 'overloaded_error';
  return { status, body: { type: 'error', error: { type, message } } };
}
