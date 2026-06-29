// POST /v1/chat/completions (ADR-203 §3.1). Orchestrates the full request flow:
//   auth → idempotency → tier → rate-limit → route → infer (JSON or SSE) → post-gen τ
//   escalation → meter (usage_ledger truth + Pub/Sub rollup) → x_cognitum.
// Metering (§5.1), the scatter-gather rate limiter (§5.3), and the 24h idempotency cache
// (§5.3) are now wired here; the core routing/inference path is owned by core/pipeline.
import type { Request, Response } from 'express';
import type { AppDeps } from '../deps';
import type { ApiKeyDoc } from '../auth/apiKey';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  XCognitum,
} from '../types/openai';
import { extractApiKey, verifyApiKey } from '../auth/apiKey';
import { resolveTier } from '../tier/resolveTier';
import { executeNonStream, effectiveEscalation } from '../core/pipeline';
import { loadInflightScanner, streamInflight } from '../midstream/inflight';
import { priceUsd } from '../metering/pricing';
import { makeCounter } from '../metering/tokenizer';
import { meter } from '../metering/record';
import { maxOutputTokens, promptTokenFloor, worstCaseEstimateUsd } from '../budget/estimate';
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

// Explicit request-shape bounds (§3.4, sec-review). The global express.json limit only caps
// raw bytes; these bound the structural fan-out fed to the difficulty regexes / tokenizer so
// a single in-limit body can't carry a pathological messages array.
const MAX_MESSAGES = 512;
const MAX_MESSAGE_CHARS = 131_072; // 128 KiB of content per message

function validateChatBody(body: unknown): ChatCompletionRequest | { error: string; code: string } {
  if (!body || typeof body !== 'object') return { error: 'Request body must be a JSON object.', code: 'invalid_request' };
  const b = body as Partial<ChatCompletionRequest>;
  if (typeof b.model !== 'string' || b.model.length === 0) {
    return { error: 'Field "model" is required.', code: 'invalid_request' };
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
  if (b.n !== undefined && b.n !== 1) {
    return { error: 'Only n=1 is supported in v1.', code: 'invalid_request' };
  }
  return b as ChatCompletionRequest;
}

export function makeChatCompletions(deps: AppDeps) {
  return async function postChatCompletions(req: Request, res: Response): Promise<void> {
    const requestId = requestIdOf(req);
    const startedAt = Date.now();

    // a. AUTH — real cog_ scheme (§6): X-API-Key / Bearer → SHA-256 → store lookup.
    const auth = await verifyApiKey(extractApiKey(req.headers), deps.keyStore);
    if (!auth.ok) {
      if (auth.logCode) {
        console.warn(`[auth] ${requestId} rejected (${auth.logCode})${auth.logReason ? `: ${auth.logReason}` : ''}`);
      }
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

    // a'. IDEMPOTENCY (§5.3) — a replay returns the cached result and is NOT re-billed or
    // rate-limited (short-circuits before tier/rate-limit/metering).
    const idemKey = idempotencyKeyOf(req.headers);
    // Namespace the attacker-chosen key by the authenticated principal so the cache cannot
    // leak across tenants / scopes (sec-review §5.3).
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
    const resolution = resolveTier(body, auth.key);
    if (resolution.kind === 'error') {
      sendError(res, requestId, resolution.status, resolution.code, resolution.error);
      return;
    }

    // c. RATE-LIMIT (§5.3) — scatter-gather per (keyHash, tier), per-tier limit.
    const limit = deps.config.tierPools[resolution.tier].rateLimitPerMin;
    const rl = await deps.rateLimiter.checkAndRecord(auth.key.key, resolution.tier, limit);
    if (!rl.allowed) {
      sendRateLimited(res, requestId, rl.retryAfterMs ?? 1000);
      return;
    }

    // d. RESERVE (ADR-204 §5.2) — atomic worst-case budget reservation at the CEILING tier,
    // BEFORE any provider invoke. Denies 402 (account/agent budget) or 429 (loop) at the
    // reservation write so an overspend is impossible (no reservation → no invoke). Unmetered
    // accounts admit transparently with no reservation (resId undefined → COMMIT is a no-op).
    const ceilingTier = resolution.ceiling;
    const promptTokens = promptTokenFloor(deps.config, ceilingTier, body.messages);
    const estimateUsd = worstCaseEstimateUsd(
      deps.config,
      ceilingTier,
      promptTokens,
      maxOutputTokens(deps.config, body.max_tokens),
    );
    const reservation = await deps.budget.reserve({
      accountId: accountIdOf(auth.key),
      agentId: agentIdOf(req.headers, auth.key),
      ceilingTier,
      estimateUsd,
      reqType: body.stream ? 'streaming' : 'sync',
      resId: requestId,
    });
    if (!reservation.admit) {
      sendError(res, requestId, reservation.status, reservation.code, reservation.error);
      return;
    }
    const resId = reservation.resId;

    try {
      // e/f. INFER + ESCALATE.
      if (body.stream) {
        await streamResponse(deps, req, res, requestId, body, resolution, auth.key, auth.rawPrefix, startedAt, resId);
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

      // g. METER — ledger (truth, awaited) + Pub/Sub rollup (fire-and-forget) (§5.1).
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

      // d'. COMMIT (ADR-204 §5.2) — release the worst-case estimate, record the actual spend.
      // Idempotent on resId; a no-op for unmetered accounts (resId undefined).
      if (resId) await deps.budget.commit(resId, outcome.priceUsd);

      if (cacheKey) await deps.idempotency.store(cacheKey, { status: 200, body: response });
      res.status(200).json(response);
    } catch (err) {
      // Never leak the concrete vendor model roster / provider name to the client (§3.4):
      // the attempted-model chain (ProviderError) is logged server-side keyed by requestId;
      // the wire body is a generic, stable message.
      console.error(`[upstream] ${requestId} provider error: ${err instanceof Error ? err.message : String(err)}`);
      sendError(res, requestId, 502, 'upstream_error', 'Upstream provider error.');
    }
  };
}

/**
 * SSE streaming (§3.3). Default `stream_oneshot`: route ONCE up front on the input signal
 * (resolution.tier already reflects it) — no post-gen escalation. `buffered` opts into
 * verifier-gated escalation at the cost of TTFT (buffer → verify → pseudo-stream).
 * Streaming closes the truncation billing hole (§5.1): a FAMILY-CORRECT progressive counter
 * is fed each delta, and the ledger is written from the local floor on normal completion OR
 * on early client disconnect (flagged `truncated:true`) — a dropped stream is still billed.
 */
async function streamResponse(
  deps: AppDeps,
  _req: Request,
  res: Response,
  requestId: string,
  body: ChatCompletionRequest,
  resolution: ReturnType<typeof resolveTier> & { kind: 'ok' },
  key: ApiKeyDoc,
  keyPrefix: string,
  startedAt: number,
  resId: string | undefined,
): Promise<void> {
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${requestId}`;
  const writeChunk = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // `inflight` (§3.5, Option C′): midstream-only. The firewall returns a scanner ONLY when
  // @midstream/wasm is present; today it is 404 on npm so loadInflightScanner → null and we
  // FALL THROUGH to stream_oneshot (Option B). This hook is off-by-default + fully working
  // without midstream; the SDK-safe truncation protocol lives in streamInflight for when the
  // WASM is vendored/published.
  if (body.escalation === 'inflight') {
    const scanner = await loadInflightScanner(body);
    if (scanner) {
      await streamInflight({ deps, res, requestId, body, resolution, key, keyPrefix, startedAt, scanner });
      return;
    }
    // midstream absent (operative state today) → degrade to Option B below.
  }

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
    await meter(deps, {
      requestId,
      key,
      keyPrefix,
      tier: outcome.resolvedTier,
      resolvedModel: outcome.resolvedModel,
      usage: outcome.usage,
      priceUsd: outcome.priceUsd,
      escalated: outcome.escalated,
      latencyMs: Date.now() - startedAt,
      tokensFromLocalFloor: outcome.tokensFromLocalFloor,
    });
    if (resId) await deps.budget.commit(resId, outcome.priceUsd);
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

  // §5.1 progressive billing: family-correct counter for the model that is actually serving,
  // seeded with the prompt tokens; fed each outbound delta as bytes stream out.
  const counter = makeCounter(model, tier);
  const promptTokens = body.messages.reduce((n, m) => {
    counter.pushDelta(m.content ?? '');
    return n;
  }, 0);
  const promptFloor = counter.completionTokens();
  // Reset the counter to count COMPLETION bytes only (prompt was just measured above).
  const completionCounter = makeCounter(model, tier);

  // Truncation guard (§5.1): if the client drops the TCP connection before [DONE], bill the
  // partial answer from the local floor with truncated:true rather than losing the usage.
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
    // §5.1 disconnect is BOTH un-locked AND billed (§5.5): commit the partial actual so the
    // dropped stream releases its lease at the truncated floor, not the worst-case estimate.
    if (resId) void deps.budget.commit(resId, truncatedPrice);
  });

  // A provider error AFTER the first chunk means headers are already flushed — we CANNOT fall
  // through to the outer sendError (that calls res.json() → 'headers already sent', hanging the
  // SSE socket). Instead emit a terminal SSE error chunk + [DONE] + end; the res.on('close')
  // handler then bills the partial answer exactly once (truncated:true). If the error happens
  // before any byte is written, rethrow so the outer catch can still send a clean 502 JSON.
  try {
    for await (const delta of deps.provider.stream(model, body)) {
      if (finalized) break; // client disconnected → stop streaming (close handler already billed)
      if (delta.content) completionCounter.pushDelta(delta.content);
      writeChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: delta.content ? { content: delta.content } : {}, finish_reason: delta.finishReason ?? null }],
      });
    }
  } catch (err) {
    console.error(`[upstream] ${requestId} stream error: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) {
      throw err; // nothing streamed yet → let the outer catch emit a generic 502 JSON envelope
    }
    if (!res.writableEnded) {
      writeChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        error: { code: 'upstream_error', message: 'Upstream provider error.' },
      });
      res.write('data: [DONE]\n\n');
      res.end(); // → 'close' fires → close handler bills the partial (truncated:true) once
    }
    return;
  }

  // If the client disconnected, the close handler already wrote the truncated ledger row;
  // do NOT run the normal-completion path (it would overwrite that row for the same requestId).
  if (finalized) return;

  // Final usage estimate (§5.1 local floor) + x_cognitum on a trailing chunk.
  const completionTokens = completionCounter.completionTokens();
  const usage = {
    prompt_tokens: promptFloor,
    completion_tokens: completionTokens,
    total_tokens: promptFloor + completionTokens,
  };
  const price = priceUsd(deps.config, tier, usage);
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
      price_usd: price,
    },
  });
  res.write('data: [DONE]\n\n');
  res.end();

  // Normal completion — write the ledger from the family-correct floor (no provider usage on
  // the live SSE path). Mark finalized FIRST so the close handler does not double-bill.
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
  // §5.2 COMMIT — release the worst-case estimate, book the streamed actual.
  if (resId) await deps.budget.commit(resId, price);
}
