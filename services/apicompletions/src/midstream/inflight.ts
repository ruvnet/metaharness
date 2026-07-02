// Inflight streaming escalation — Option C′ (ADR-203 §3.5). midstream-only, firewalled.
//
// rev-3 §3.3 REJECTED Option C (speculative-stream-then-error) because, with no inflight
// analysis, the only recovery from a bad streamed `low` answer was to corrupt the SSE
// contract and force a restart. `ruvnet/midstream` (a REAL Rust/WASM inflight LLM-stream
// analyser) changes that calculus: scan the output AS IT IS GENERATED and, on an EARLY
// failure signal, escalate mid-stream WITHOUT killing TTFT (the first tokens already flowed).
//
// CRITICAL FIREWALL (ADR-150 removable augmentation): this path runs ONLY when the midstream
// scanner is present. `@midstream/wasm` is NOT on npm today (404 verified 2026-06-29), so
// `loadInflightScanner()` returns null and the route DEGRADES to Option B (stream_oneshot).
// Everything here is OFF-BY-DEFAULT and the service is FULLY OPERATIONAL without it.
//
// Phase discipline (§3.5 item 5, HONEST): the scanner contract is scoped to EARLY-DETECTABLE
// failure modes only (loops / explicit refusals / structural errors) — NOT a "first-N-tokens
// confidence" magic number, which is deferred (Phase 3) until usage_ledger data shows it
// predicts escalation outcomes. Crate names in the proposal are illustrative (§3.5 item 6);
// this is written against midstream's API as a CONTRACT, not its (unverified) symbol names.
import type { Response } from 'express';
import type { AppDeps } from '../deps';
import type { ApiKeyDoc } from '../auth/apiKey';
import type { ChatCompletionRequest, Tier } from '../types/openai';
import type { TierResolution } from '../tier/resolveTier';
import { nextTierUp, tierRank } from '../tier/resolveTier';
import { loadMidstream } from './firewall';
import { makeCounter } from '../metering/tokenizer';
import { priceUsd } from '../metering/pricing';
import { meter } from '../metering/record';

/** An early-detectable failure signal raised by the inflight scanner (§3.5 item 5). */
export interface EscalationSignal {
  /** Human-readable cause (loop / refusal / structural error) — surfaced in routing_reason. */
  reason: string;
  /**
   * SDK-safe terminal stop value (§3.5 item 3). MUST be a value existing SDKs already treat
   * as a clean stop — `content_filter` (default) or `length` — never a custom token, so the
   * SDK closes its stream loop gracefully instead of hitting `Unexpected end of JSON input`.
   */
  finishReason: 'content_filter' | 'length';
}

/**
 * The inflight scanner contract (written against midstream's ACTUAL API as a contract,
 * §3.5 item 6). `push()` is fed each outbound delta as it is generated and returns an
 * `EscalationSignal` on an early failure, else null. Stateful across a single stream.
 */
export interface InflightScanner {
  push(delta: string): EscalationSignal | null;
}

/** Shape midstream is expected to expose once vendored/published — adapted to InflightScanner. */
interface MidstreamWithScan {
  scanInflight?: (req: ChatCompletionRequest) => InflightScanner;
}

/**
 * Firewall-gated scanner factory (§3.5 item 2). Returns a scanner ONLY when midstream is
 * present and exposes a `scanInflight` factory; otherwise null → the caller degrades to
 * Option B (stream_oneshot). **null is the operative state today** (`@midstream/wasm` 404).
 */
export async function loadInflightScanner(
  req: ChatCompletionRequest,
): Promise<InflightScanner | null> {
  const mod = (await loadMidstream()) as MidstreamWithScan | null;
  if (!mod || typeof mod.scanInflight !== 'function') return null;
  try {
    return mod.scanInflight(req);
  } catch {
    return null; // a faulty optional dep must never break the request — degrade to Option B
  }
}

/** Highest tier we may escalate to: the next tier up, capped at the resolution ceiling. */
function escalateTarget(current: Tier, ceiling: Tier): Tier | null {
  const next = nextTierUp(current);
  if (!next) return null;
  return tierRank(next) > tierRank(ceiling) ? null : next;
}

/**
 * The SDK-safe truncation chunk (§3.5 item 3). ONE OpenAI-event-stream-conformant terminal
 * chunk: a clean `finish_reason` every SDK already handles, plus the namespaced escalation
 * block carrying the continuation handle. Emitting this (then `data: [DONE]`) lets a strict
 * SDK close its loop with NO dangling JSON; a bridging service then continues the answer at
 * the higher tier under the same `request_id` (§3.5 item 4).
 */
export function buildTruncationChunk(args: {
  id: string;
  created: number;
  model: string;
  signal: EscalationSignal;
  resolvedTier: Tier;
  nextContext: string;
}): Record<string, unknown> {
  return {
    id: args.id,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [{ index: 0, delta: {}, finish_reason: args.signal.finishReason }],
    x_cognitum: {
      escalated: true,
      resolved_tier: args.resolvedTier,
      next_context: args.nextContext,
      routing_reason: `inflight: ${args.signal.reason}`,
    },
  };
}

export interface InflightContext {
  deps: AppDeps;
  res: Response;
  requestId: string;
  body: ChatCompletionRequest;
  resolution: TierResolution;
  key: ApiKeyDoc;
  keyPrefix: string;
  startedAt: number;
  scanner: InflightScanner;
}

/**
 * Run the inflight (Option C′) streaming path with a PRESENT scanner. Streams the
 * starting-tier answer while feeding every delta to the scanner; on an early signal it
 * emits the SDK-safe truncation chunk and BRIDGES to the higher tier under the same
 * request_id (§3.5 item 4, service-bridge variant). Billing follows §3.5: the delivered
 * answer is billed at the escalated tier, and the discarded low-tier prefix is recorded
 * honestly in `discarded_prefix_tokens` (the inflight signal MINIMIZES that prefix — the
 * earlier the catch, the fewer tokens thrown away).
 *
 * This is the future-enabled path; today it is never reached (scanner is always null).
 */
export async function streamInflight(ctx: InflightContext): Promise<void> {
  const { deps, res, requestId, body, resolution, key, keyPrefix, startedAt, scanner } = ctx;
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${requestId}`;
  const writeChunk = (obj: unknown): void => {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const startTier = resolution.tier;
  const startModel = deps.config.tierPools[startTier].models[0];
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Request-Id', requestId);

  // Family-correct progressive counters (§5.1): one for the discarded low-tier prefix, one
  // for whatever tier ultimately delivers the billed answer.
  const prefixCounter = makeCounter(startModel, startTier);

  // Truncation/disconnect guard (§5.1): a dropped TCP connection before [DONE] still bills
  // the prefix generated so far (truncated:true) rather than losing the usage.
  let finalized = false;
  res.on('close', () => {
    if (finalized) return;
    finalized = true;
    const completion = prefixCounter.completionTokens();
    const promptFloor = body.messages.reduce(
      (n, m) => n + estimatePrompt(startModel, m.content ?? ''),
      0,
    );
    const usage = {
      prompt_tokens: promptFloor,
      completion_tokens: completion,
      total_tokens: promptFloor + completion,
    };
    void meter(deps, {
      requestId,
      key,
      keyPrefix,
      tier: startTier,
      resolvedModel: startModel,
      usage,
      priceUsd: priceUsd(deps.config, startTier, usage),
      escalated: false,
      latencyMs: Date.now() - startedAt,
      tokensFromLocalFloor: true,
      truncated: true,
    });
  });

  // --- Stream the starting tier, scanning each delta for an early failure signal. ---
  let signal: EscalationSignal | null = null;
  for await (const delta of deps.provider.stream(startModel, body)) {
    if (finalized) return; // client disconnected → close handler already billed (truncated)
    if (delta.content) {
      prefixCounter.pushDelta(delta.content);
      signal = scanner.push(delta.content);
    }
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: delta.content ? { content: delta.content } : {},
          finish_reason: delta.finishReason ?? null,
        },
      ],
    });
    if (signal) break; // early failure → stop the low-tier stream and hand off
  }
  if (finalized) return;

  const target = signal ? escalateTarget(startTier, resolution.ceiling) : null;

  // No signal (or already at the ceiling) → finish like Option B at the starting tier.
  if (!signal || !target) {
    finishAtTier(ctx, {
      id,
      created,
      tier: startTier,
      model: startModel,
      completionTokens: prefixCounter.completionTokens(),
      escalated: false,
      routingReason: resolution.routingReason,
      discardedPrefixTokens: undefined,
    });
    finalized = true;
    return;
  }

  // --- SDK-safe truncation handoff + higher-tier continuation (§3.5 items 3–4). ---
  const targetModel = deps.config.tierPools[target].models[0];
  const nextContext = `${requestId}:${target}`;
  writeChunk(
    buildTruncationChunk({ id, created, model: body.model, signal, resolvedTier: target, nextContext }),
  );

  const contCounter = makeCounter(targetModel, target);
  for await (const delta of deps.provider.stream(targetModel, body)) {
    if (finalized) return; // client disconnected during continuation → close handler billed
    if (delta.content) contCounter.pushDelta(delta.content);
    writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: delta.content ? { content: delta.content } : {},
          finish_reason: delta.finishReason ?? null,
        },
      ],
    });
  }
  if (finalized) return;

  finishAtTier(ctx, {
    id,
    created,
    tier: target,
    model: targetModel,
    completionTokens: contCounter.completionTokens(),
    escalated: true,
    routingReason: `${resolution.routingReason}; inflight ${startTier}->${target}: ${signal.reason}`,
    discardedPrefixTokens: prefixCounter.completionTokens(),
  });
  finalized = true;
}

/** Prompt-token floor for one message, family-correct for the resolved model (§5.1). */
function estimatePrompt(model: string, content: string): number {
  return makeCounterPrompt(model, content);
}

/** Tiny wrapper so the prompt floor reuses the SAME family ratio as the delta counter. */
function makeCounterPrompt(model: string, content: string): number {
  const c = makeCounter(model, 'low');
  c.pushDelta(content);
  return c.completionTokens();
}

/** Emit the final usage + x_cognitum trailing chunk, send [DONE], end, and meter the row. */
function finishAtTier(
  ctx: InflightContext,
  f: {
    id: string;
    created: number;
    tier: Tier;
    model: string;
    completionTokens: number;
    escalated: boolean;
    routingReason: string;
    discardedPrefixTokens?: number;
  },
): void {
  const { deps, res, requestId, body, resolution, key, keyPrefix, startedAt } = ctx;
  const promptTokens = body.messages.reduce(
    (n, m) => n + estimatePrompt(f.model, m.content ?? ''),
    0,
  );
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: f.completionTokens,
    total_tokens: promptTokens + f.completionTokens,
  };
  const price = priceUsd(deps.config, f.tier, usage);
  res.write(
    `data: ${JSON.stringify({
      id: f.id,
      object: 'chat.completion.chunk',
      created: f.created,
      model: body.model,
      choices: [],
      usage,
      x_cognitum: {
        request_id: requestId,
        resolved_tier: f.tier,
        resolved_model: f.model,
        escalated: f.escalated,
        cap_degraded: resolution.capDegraded,
        routing_reason: f.routingReason,
        price_usd: price,
        ...(f.discardedPrefixTokens !== undefined
          ? { discarded_prefix_tokens: f.discardedPrefixTokens }
          : {}),
      },
    })}\n\n`,
  );
  res.write('data: [DONE]\n\n');
  res.end();

  void meter(deps, {
    requestId,
    key,
    keyPrefix,
    tier: f.tier,
    resolvedModel: f.model,
    usage,
    priceUsd: price,
    escalated: f.escalated,
    latencyMs: Date.now() - startedAt,
    tokensFromLocalFloor: true,
    discardedPrefixTokens: f.discardedPrefixTokens,
  });
}
