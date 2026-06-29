// POST /v1/messages — the Anthropic Messages API surface over Cognitum Fugu.
// Anthropic request → canonical → the SAME tier/route/meter/budget pipeline as
// /v1/chat/completions → Anthropic response. Auth via the existing cog_ scheme on x-api-key
// (case-insensitive; `anthropic-version` is accepted and ignored). The model→tier map lives in
// the translation adapter (opus→high, sonnet→mid, haiku→low, cognitum-* pass-through).
//
// HONESTY GUARD: the response `model` field and x_cognitum.resolved_model/resolved_tier always
// carry the REAL resolved model — when auto/low resolves to a non-Anthropic model (deepseek /
// glm / gpt), the caller sees that model, never a misrepresented Claude alias.
import type { Request, Response } from 'express';
import type { AppDeps } from '../deps';
import type { ApiKeyDoc } from '../auth/apiKey';
import type { XCognitum } from '../types/openai';
import type { AnthropicMessagesRequest } from '../anthropic/types';
import { extractApiKey, verifyApiKey } from '../auth/apiKey';
import { resolveTier } from '../tier/resolveTier';
import { executeNonStream } from '../core/pipeline';
import { priceUsd } from '../metering/pricing';
import { makeCounter } from '../metering/tokenizer';
import { meter } from '../metering/record';
import { maxOutputTokens, promptTokenFloor, worstCaseEstimateUsd } from '../budget/estimate';
import { anthropicToCanonical, buildAnthropicResponse, mapStopReason } from '../anthropic/translate';
import {
  contentBlockDeltaEvent,
  contentBlockStartEvent,
  contentBlockStopEvent,
  messageDeltaEvent,
  messageStartEvent,
  messageStopEvent,
  pingEvent,
} from '../anthropic/sse';
import {
  accountIdOf,
  agentIdOf,
  idempotencyCacheKey,
  idempotencyKeyOf,
  mergeRoutingControls,
  requestIdOf,
  sendError,
  sendRateLimited,
  setCognitumHeaders,
} from '../core/http';

const MAX_MESSAGES = 512;
const MAX_MESSAGE_CHARS = 131_072;

type ValidatedBody = AnthropicMessagesRequest | { error: string; code: string };

function validateMessagesBody(body: unknown): ValidatedBody {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object.', code: 'invalid_request' };
  const b = body as Partial<AnthropicMessagesRequest>;
  if (typeof b.model !== 'string' || b.model.length === 0) {
    return { error: 'Field "model" is required.', code: 'invalid_request' };
  }
  if (typeof b.max_tokens !== 'number' || !Number.isFinite(b.max_tokens) || b.max_tokens <= 0) {
    return { error: 'Field "max_tokens" is required and must be a positive integer.', code: 'invalid_request' };
  }
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return { error: 'Field "messages" must be a non-empty array.', code: 'invalid_request' };
  }
  if (b.messages.length > MAX_MESSAGES) {
    return { error: `Too many messages (max ${MAX_MESSAGES}).`, code: 'invalid_request' };
  }
  for (const m of b.messages) {
    const content = (m as { content?: unknown })?.content;
    if (typeof content === 'string' && content.length > MAX_MESSAGE_CHARS) {
      return { error: `A message exceeds the ${MAX_MESSAGE_CHARS}-character limit.`, code: 'invalid_request' };
    }
  }
  return b as AnthropicMessagesRequest;
}

export function makeMessages(deps: AppDeps) {
  return async function postMessages(req: Request, res: Response): Promise<void> {
    const requestId = requestIdOf(req);
    const startedAt = Date.now();

    // a. AUTH — same cog_ scheme as /v1/chat/completions (x-api-key / Bearer). Express lowercases
    // header names, so x-api-key matches case-insensitively; anthropic-version is ignored.
    const auth = await verifyApiKey(extractApiKey(req.headers), deps.keyStore);
    if (!auth.ok) {
      if (auth.logCode) {
        console.warn(`[auth] ${requestId} rejected (${auth.logCode})${auth.logReason ? `: ${auth.logReason}` : ''}`);
      }
      sendError(res, requestId, auth.status, auth.code, auth.error);
      return;
    }

    const validated = validateMessagesBody(req.body);
    if ('error' in validated) {
      sendError(res, requestId, 400, validated.code, validated.error);
      return;
    }

    // Translate Anthropic → canonical, then merge X-Cognitum-* routing-control headers
    // (min/max_tier, fallback_policy) onto the canonical body so resolveTier honors them.
    const canonical = anthropicToCanonical(validated);
    mergeRoutingControls(canonical, req.headers);

    // a'. IDEMPOTENCY (§5.3) — a replay returns the cached Anthropic body, un-billed.
    const idemKey = idempotencyKeyOf(req.headers);
    const cacheKey = idemKey ? idempotencyCacheKey(auth.key, idemKey) : undefined;
    if (cacheKey) {
      const cached = await deps.idempotency.lookup(cacheKey);
      if (cached) {
        res.setHeader('X-Request-Id', requestId);
        res.setHeader('Idempotent-Replay', 'true');
        res.status(cached.status).json(cached.body);
        return;
      }
    }

    // b. TIER — model dial + difficulty + scope enforcement (§3.3, §6 item 2).
    const resolution = resolveTier(canonical, auth.key);
    if (resolution.kind === 'error') {
      sendError(res, requestId, resolution.status, resolution.code, resolution.error);
      return;
    }

    // c. RATE-LIMIT (§5.3).
    const limit = deps.config.tierPools[resolution.tier].rateLimitPerMin;
    const rl = await deps.rateLimiter.checkAndRecord(auth.key.key, resolution.tier, limit);
    if (!rl.allowed) {
      sendRateLimited(res, requestId, rl.retryAfterMs ?? 1000);
      return;
    }

    // d. RESERVE (ADR-204 §5.2) — worst-case at the ceiling tier, BEFORE the provider invoke.
    const ceilingTier = resolution.ceiling;
    const promptTokens = promptTokenFloor(deps.config, ceilingTier, canonical.messages);
    const estimateUsd = worstCaseEstimateUsd(
      deps.config,
      ceilingTier,
      promptTokens,
      maxOutputTokens(deps.config, canonical.max_tokens),
    );
    const reservation = await deps.budget.reserve({
      accountId: accountIdOf(auth.key),
      agentId: agentIdOf(req.headers, auth.key),
      ceilingTier,
      estimateUsd,
      reqType: canonical.stream ? 'streaming' : 'sync',
      resId: requestId,
    });
    if (!reservation.admit) {
      sendError(res, requestId, reservation.status, reservation.code, reservation.error);
      return;
    }
    const resId = reservation.resId;

    try {
      if (canonical.stream) {
        await streamAnthropic(deps, res, requestId, canonical, resolution, auth.key, auth.rawPrefix, startedAt, resId);
        return;
      }

      const outcome = await executeNonStream(deps, canonical, resolution);
      const xCognitum: XCognitum = {
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
      const response = buildAnthropicResponse({
        requestId,
        resolvedModel: outcome.resolvedModel, // HONESTY GUARD
        text: outcome.text,
        usage: outcome.usage,
        stopReason: mapStopReason('stop'),
        xCognitum,
      });

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
        idempotencyKey: idemKey,
      });
      if (resId) await deps.budget.commit(resId, outcome.priceUsd);

      if (cacheKey) await deps.idempotency.store(cacheKey, { status: 200, body: response });
      res.status(200).json(response);
    } catch (err) {
      console.error(`[upstream] ${requestId} provider error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, requestId, 502, 'upstream_error', 'Upstream provider error.');
    }
  };
}

/**
 * Anthropic SSE streaming (stream_oneshot — route ONCE up front, §3.3). Synthesizes the
 * Anthropic event sequence from whatever backend serves (incl. the non-Anthropic MockProvider):
 *   message_start → content_block_start → ping → content_block_delta×N
 *     → content_block_stop → message_delta → message_stop
 * The §5.1 family-correct progressive counter feeds the disconnect-billing floor: a client that
 * drops the TCP connection before message_stop is still billed (truncated:true) and the budget
 * lease is committed at the partial floor (§5.5).
 */
async function streamAnthropic(
  deps: AppDeps,
  res: Response,
  requestId: string,
  body: ReturnType<typeof anthropicToCanonical>,
  resolution: ReturnType<typeof resolveTier> & { kind: 'ok' },
  key: ApiKeyDoc,
  keyPrefix: string,
  startedAt: number,
  resId: string | undefined,
): Promise<void> {
  const id = `msg_${requestId}`;
  const tier = resolution.tier;
  const model = deps.config.tierPools[tier].models[0];

  setCognitumHeaders(res, requestId, {
    resolvedTier: tier,
    resolvedModel: model, // HONESTY GUARD — real resolved model in the headers too
    escalated: false,
    capDegraded: resolution.capDegraded,
    routingReason: resolution.routingReason,
  });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  // §5.1 family-correct prompt floor (input_tokens) + completion counter (output_tokens).
  const promptCounter = makeCounter(model, tier);
  for (const m of body.messages) promptCounter.pushDelta(m.content ?? '');
  const promptFloor = promptCounter.completionTokens();
  const completionCounter = makeCounter(model, tier);

  const write = (frame: string): void => {
    res.write(frame);
  };
  write(messageStartEvent({ id, model, inputTokens: promptFloor }));
  write(contentBlockStartEvent());
  write(pingEvent());

  // Disconnect billing floor (§5.1) + budget lease commit at the partial (§5.5).
  let finalized = false;
  res.on('close', () => {
    if (finalized) return;
    finalized = true;
    const completionTokens = completionCounter.completionTokens();
    const usage = {
      prompt_tokens: promptFloor,
      completion_tokens: completionTokens,
      total_tokens: promptFloor + completionTokens,
    };
    const truncatedPrice = priceUsd(deps.config, tier, usage);
    void meter(deps, {
      requestId,
      key,
      keyPrefix,
      tier,
      resolvedModel: model,
      usage,
      priceUsd: truncatedPrice,
      escalated: false,
      latencyMs: Date.now() - startedAt,
      tokensFromLocalFloor: true,
      truncated: true,
    });
    if (resId) void deps.budget.commit(resId, truncatedPrice);
  });

  for await (const delta of deps.provider.stream(model, body)) {
    if (finalized) break; // client disconnected → close handler billed
    if (delta.content) {
      completionCounter.pushDelta(delta.content);
      write(contentBlockDeltaEvent(delta.content));
    }
  }
  if (finalized) return; // disconnect already billed; do not double-write the terminal frames

  const completionTokens = completionCounter.completionTokens();
  const usage = {
    prompt_tokens: promptFloor,
    completion_tokens: completionTokens,
    total_tokens: promptFloor + completionTokens,
  };
  const price = priceUsd(deps.config, tier, usage);
  const xCognitum: XCognitum = {
    request_id: requestId,
    resolved_tier: tier,
    resolved_model: model, // HONESTY GUARD
    escalated: false,
    cap_degraded: resolution.capDegraded,
    routing_reason: resolution.routingReason,
    price_usd: price,
  };
  write(contentBlockStopEvent());
  write(messageDeltaEvent({ stopReason: mapStopReason('stop'), outputTokens: completionTokens, xCognitum }));
  write(messageStopEvent());
  res.end();

  finalized = true;
  await meter(deps, {
    requestId,
    key,
    keyPrefix,
    tier,
    resolvedModel: model,
    usage,
    priceUsd: price,
    escalated: false,
    latencyMs: Date.now() - startedAt,
    tokensFromLocalFloor: true,
  });
  if (resId) await deps.budget.commit(resId, price);
}
