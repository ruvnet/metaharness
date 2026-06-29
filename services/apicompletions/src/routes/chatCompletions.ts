// POST /v1/chat/completions (ADR-203 §3.1). Orchestrates the full request flow:
//   auth → tier → route → infer (JSON or SSE) → post-gen τ escalation → x_cognitum.
// Metering (usage_ledger write + Pub/Sub publish) and the scatter-gather rate limiter are
// wired in a later phase (§5.1/§5.3); this handler owns the CORE request path (§3.1 a–f).
import type { Request, Response } from 'express';
import type { AppDeps } from '../deps';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  XCognitum,
} from '../types/openai';
import { extractApiKey, verifyApiKey } from '../auth/apiKey';
import { resolveTier } from '../tier/resolveTier';
import { executeNonStream, effectiveEscalation } from '../core/pipeline';
import { priceUsd } from '../metering/pricing';
import {
  mergeRoutingControls,
  requestIdOf,
  sendError,
  setCognitumHeaders,
} from '../core/http';

function validateChatBody(body: unknown): ChatCompletionRequest | { error: string; code: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object.', code: 'invalid_request' };
  const b = body as Partial<ChatCompletionRequest>;
  if (typeof b.model !== 'string' || b.model.length === 0) {
    return { error: 'Field "model" is required.', code: 'invalid_request' };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { error: 'Field "messages" must be a non-empty array.', code: 'invalid_request' };
  }
  if (b.n !== undefined && b.n !== 1) {
    return { error: 'Only n=1 is supported in v1.', code: 'invalid_request' };
  }
  return b as ChatCompletionRequest;
}

export function makeChatCompletions(deps: AppDeps) {
  return async function postChatCompletions(req: Request, res: Response): Promise<void> {
    const requestId = requestIdOf(req);

    // a. AUTH — real cog_ scheme (§6): X-API-Key / Bearer → SHA-256 → store lookup.
    const auth = await verifyApiKey(extractApiKey(req.headers), deps.keyStore);
    if (!auth.ok) {
      sendError(res, requestId, auth.status, auth.code, auth.error);
      return;
    }

    const validated = validateChatBody(req.body);
    if ('error' in validated) {
      sendError(res, requestId, 400, validated.code, validated.error);
      return;
    }
    const body = validated;
    mergeRoutingControls(body, req.headers);

    // b. TIER — model dial + difficulty + scope enforcement (§3.3, §6 item 2).
    const resolution = resolveTier(body, auth.key);
    if (resolution.kind === 'error') {
      sendError(res, requestId, resolution.status, resolution.code, resolution.error);
      return;
    }

    try {
      // e/f. INFER + ESCALATE.
      if (body.stream) {
        await streamResponse(deps, req, res, requestId, body, resolution);
        return;
      }

      const outcome = await executeNonStream(deps, body, resolution);
      const x_cognitum: XCognitum = {
        request_id: requestId,
        resolved_tier: outcome.resolvedTier,
        resolved_model: outcome.resolvedModel,
        escalated: outcome.escalated,
        cap_degraded: outcome.capDegraded,
        routing_reason: outcome.routingReason,
        price_usd: outcome.priceUsd,
      };
      setCognitumHeaders(res, requestId, {
        resolvedTier: outcome.resolvedTier,
        resolvedModel: outcome.resolvedModel,
        escalated: outcome.escalated,
        capDegraded: outcome.capDegraded,
        routingReason: outcome.routingReason,
      });
      const response: ChatCompletionResponse = {
        id: `chatcmpl-${requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: outcome.text }, finish_reason: 'stop' },
        ],
        usage: outcome.usage,
        x_cognitum,
      };
      res.status(200).json(response);
    } catch (err) {
      sendError(
        res,
        requestId,
        502,
        'upstream_error',
        err instanceof Error ? err.message : 'Upstream provider error.',
      );
    }
  };
}

/**
 * SSE streaming (§3.3). Default `stream_oneshot`: route ONCE up front on the input signal
 * (resolution.tier already reflects it) — no post-gen escalation. `buffered` opts into
 * verifier-gated escalation at the cost of TTFT (buffer → verify → pseudo-stream).
 */
async function streamResponse(
  deps: AppDeps,
  _req: Request,
  res: Response,
  requestId: string,
  body: ChatCompletionRequest,
  resolution: ReturnType<typeof resolveTier> & { kind: 'ok' },
): Promise<void> {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${requestId}`;
  const writeChunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // `buffered`: run the full non-stream pipeline (with τ escalation), then flush as a
  // pseudo-stream — trades TTFT for verifier-gated escalation on a streaming-shaped reply.
  if (effectiveEscalation(body) === 'buffered') {
    const outcome = await executeNonStream(deps, body, resolution);
    setCognitumHeaders(res, requestId, outcome);
    res.setHeader('Content-Type', 'text/event-stream');
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: outcome.text }, finish_reason: null }],
    });
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      x_cognitum: {
        request_id: requestId,
        resolved_tier: outcome.resolvedTier,
        resolved_model: outcome.resolvedModel,
        escalated: outcome.escalated,
        cap_degraded: outcome.capDegraded,
        routing_reason: outcome.routingReason,
        price_usd: outcome.priceUsd,
      },
    });
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // stream_oneshot — stream live from the single resolved tier. Fallback-within-tier for
  // live streams is deferred; use the first model in the chain.
  const tier = resolution.tier;
  const model = deps.config.tierPools[tier].models[0];
  setCognitumHeaders(res, requestId, {
    resolvedTier: tier,
    resolvedModel: model,
    escalated: false,
    capDegraded: resolution.capDegraded,
    routingReason: resolution.routingReason,
  });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  let collected = '';
  for await (const delta of deps.provider.stream(model, body)) {
    if (delta.content) collected += delta.content;
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: delta.content ? { content: delta.content } : {}, finish_reason: delta.finishReason ?? null }],
    });
  }
  // Final usage estimate (§5.1 local floor) + x_cognitum on a trailing chunk.
  const approx = (s: string) => Math.max(1, Math.ceil(s.length / 4));
  const promptTokens = body.messages.reduce((n, m) => n + approx(m.content ?? ''), 0);
  const completionTokens = approx(collected);
  const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
  writeChunk({
    id,
    object: 'chat.completion.chunk',
    created,
    model: body.model,
    choices: [],
    usage,
    x_cognitum: {
      request_id: requestId,
      resolved_tier: tier,
      resolved_model: model,
      escalated: false,
      cap_degraded: resolution.capDegraded,
      routing_reason: resolution.routingReason,
      price_usd: priceUsd(deps.config, tier, usage),
    },
  });
  res.write('data: [DONE]\n\n');
  res.end();
}
