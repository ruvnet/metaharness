// POST /v1/completions (ADR-203 §2, §3.4). Legacy OpenAI completions shape; shares the
// SAME auth → tier → route → escalate pipeline as chat/completions — the `prompt` is
// adapted into a single user message, and the result is reshaped to the legacy
// `choices[].text` / object:"text_completion" envelope. Non-streaming (this phase).
import type { Request, Response } from 'express';
import type { AppDeps } from '../deps';
import type { ChatCompletionRequest, XCognitum } from '../types/openai';
import { extractApiKey, verifyApiKey } from '../auth/apiKey';
import { resolveTier } from '../tier/resolveTier';
import { executeNonStream } from '../core/pipeline';
import { meter } from '../metering/record';
import { mergeRoutingControls, requestIdOf, sendError, sendRateLimited, setCognitumHeaders } from '../core/http';

interface LegacyCompletionRequest extends Omit<ChatCompletionRequest, 'messages'> {
  prompt?: string | string[];
}

// Bound the adapted prompt size (§3.4, sec-review) — mirrors the chat-route MAX_MESSAGE_CHARS
// so a single in-byte-limit legacy body can't carry a pathological prompt into the tokenizer.
const MAX_PROMPT_CHARS = 131_072;

function promptToMessages(prompt: string | string[] | undefined): ChatCompletionRequest['messages'] | 'empty' | 'too_large' {
  let content: string | null = null;
  if (typeof prompt === 'string' && prompt.length > 0) {
    content = prompt;
  } else if (Array.isArray(prompt) && prompt.length > 0) {
    content = prompt.join('\n');
  }
  if (content === null) return 'empty';
  if (content.length > MAX_PROMPT_CHARS) return 'too_large';
  return [{ role: 'user', content }];
}

export function makeCompletions(deps: AppDeps) {
  return async function postCompletions(req: Request, res: Response): Promise<void> {
    const requestId = requestIdOf(req);
    const startedAt = Date.now();

    const auth = await verifyApiKey(extractApiKey(req.headers), deps.keyStore);
    if (!auth.ok) {
      if (auth.logCode) {
        console.warn(`[auth] ${requestId} rejected (${auth.logCode})${auth.logReason ? `: ${auth.logReason}` : ''}`);
      }
      sendError(res, requestId, auth.status, auth.code, auth.error);
      return;
    }

    const b = (req.body ?? {}) as LegacyCompletionRequest;
    if (typeof b.model !== 'string' || b.model.length === 0) {
      sendError(res, requestId, 400, 'invalid_request', 'Field "model" is required.');
      return;
    }
    if (b.n !== undefined && b.n !== 1) {
      sendError(res, requestId, 400, 'invalid_request', 'Only n=1 is supported in v1.');
      return;
    }
    const messages = promptToMessages(b.prompt);
    if (messages === 'empty') {
      sendError(res, requestId, 400, 'invalid_request', 'Field "prompt" must be a non-empty string or array.');
      return;
    }
    if (messages === 'too_large') {
      sendError(res, requestId, 400, 'invalid_request', `Field "prompt" exceeds the ${MAX_PROMPT_CHARS}-character limit.`);
      return;
    }

    const chatReq: ChatCompletionRequest = {
      model: b.model,
      messages,
      temperature: b.temperature,
      top_p: b.top_p,
      max_tokens: b.max_tokens,
      stop: b.stop,
      n: b.n,
      fallback_policy: b.fallback_policy,
      min_tier: b.min_tier,
      max_tier: b.max_tier,
      escalation: b.escalation,
    };
    mergeRoutingControls(chatReq, req.headers);

    const resolution = resolveTier(chatReq, auth.key);
    if (resolution.kind === 'error') {
      sendError(res, requestId, resolution.status, resolution.code, resolution.error);
      return;
    }

    // RATE-LIMIT (§5.3) — scatter-gather per (keyHash, tier).
    const limit = deps.config.tierPools[resolution.tier].rateLimitPerMin;
    const rl = await deps.rateLimiter.checkAndRecord(auth.key.key, resolution.tier, limit);
    if (!rl.allowed) {
      sendRateLimited(res, requestId, rl.retryAfterMs ?? 1000);
      return;
    }

    try {
      const outcome = await executeNonStream(deps, chatReq, resolution);
      const x_cognitum: XCognitum = {
        request_id: requestId,
        resolved_tier: outcome.resolvedTier,
        resolved_model: outcome.resolvedModel,
        escalated: outcome.escalated,
        cap_degraded: outcome.capDegraded,
        routing_reason: outcome.routingReason,
        price_usd: outcome.priceUsd,
      };
      setCognitumHeaders(res, requestId, outcome);

      // METER — ledger (truth) + Pub/Sub rollup (fire-and-forget) (§5.1).
      await meter(deps, {
        requestId,
        key: auth.key,
        keyPrefix: auth.rawPrefix,
        tier: outcome.resolvedTier,
        resolvedModel: outcome.resolvedModel,
        usage: outcome.usage,
        priceUsd: outcome.priceUsd,
        escalated: outcome.escalated,
        latencyMs: Date.now() - startedAt,
        tokensFromLocalFloor: outcome.tokensFromLocalFloor,
      });

      res.status(200).json({
        id: `cmpl-${requestId}`,
        object: 'text_completion',
        created: Math.floor(Date.now() / 1000),
        model: b.model,
        choices: [{ index: 0, text: outcome.text, finish_reason: 'stop' }],
        usage: outcome.usage,
        x_cognitum,
      });
    } catch (err) {
      // Generic wire body; the concrete attempted-model chain is logged server-side only (§3.4).
      console.error(`[upstream] ${requestId} provider error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, requestId, 502, 'upstream_error', 'Upstream provider error.');
    }
  };
}
