// Anthropic SSE event synthesis (/v1/messages streaming). Pure builders that emit the
// Anthropic event-stream frames from ANY backend — including the non-Anthropic MockProvider /
// deepseek / glm — so a real Anthropic SDK streaming loop closes cleanly. The full sequence is:
//
//   message_start → content_block_start → ping
//     → content_block_delta(text_delta) × N
//   → content_block_stop → message_delta(stop_reason, output_tokens) → message_stop
//
// Each frame is `event: <name>\n data: <json>\n\n` (the Anthropic wire format). Builders return
// the raw frame string so the sequence is unit-testable without an HTTP socket.
import type { XCognitum } from '../types/openai';

function frame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** message_start — opens the message; usage.output_tokens starts at 0, input_tokens is known. */
export function messageStartEvent(args: {
  id: string;
  model: string;
  inputTokens: number;
}): string {
  return frame('message_start', {
    type: 'message_start',
    message: {
      id: args.id,
      type: 'message',
      role: 'assistant',
      model: args.model, // HONESTY GUARD — real resolved model
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: args.inputTokens, output_tokens: 0 },
    },
  });
}

/** content_block_start — opens the single text block (index 0). */
export function contentBlockStartEvent(): string {
  return frame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
}

/** ping — Anthropic emits at least one ping early in the stream; SDKs tolerate any number. */
export function pingEvent(): string {
  return frame('ping', { type: 'ping' });
}

/** content_block_delta — one text_delta chunk. */
export function contentBlockDeltaEvent(text: string): string {
  return frame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text },
  });
}

/** content_block_stop — closes the text block. */
export function contentBlockStopEvent(): string {
  return frame('content_block_stop', { type: 'content_block_stop', index: 0 });
}

/**
 * message_delta — carries the terminal stop_reason and the cumulative output_tokens. The
 * Cognitum routing block rides along here (resolved_model / resolved_tier / price) so a
 * streaming caller still sees the honest resolution without a custom trailer.
 */
export function messageDeltaEvent(args: {
  stopReason: string;
  outputTokens: number;
  xCognitum?: XCognitum;
}): string {
  return frame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: args.stopReason, stop_sequence: null },
    usage: { output_tokens: args.outputTokens },
    ...(args.xCognitum ? { x_cognitum: args.xCognitum } : {}),
  });
}

/** message_stop — terminates the stream (the Anthropic analog of OpenAI's [DONE]). */
export function messageStopEvent(): string {
  return frame('message_stop', { type: 'message_stop' });
}
