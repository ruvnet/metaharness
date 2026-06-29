// Shared HTTP helpers for the OpenAI-compatible routes (ADR-203 §3.4, §6).
// Uniform error envelope { error, code, requestId }; X-Cognitum-* routing controls accepted
// as headers (mirroring the body fields); X-Cognitum-* response headers mirror x_cognitum.
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import type { ApiKeyDoc } from '../auth/apiKey';
import type { ChatCompletionRequest, EscalationStrategy, ErrorEnvelope, FallbackPolicy, Tier } from '../types/openai';

export function requestIdOf(req: Request): string {
  const hdr = req.headers['x-request-id'];
  return (typeof hdr === 'string' && hdr.length > 0 ? hdr : '') || randomUUID();
}

export function sendError(
  res: Response,
  requestId: string,
  status: number,
  code: string,
  error: string,
): void {
  const body: ErrorEnvelope = { error, code, requestId };
  res.status(status).json(body);
}

/** The optional `Idempotency-Key` request header (§5.3). */
export function idempotencyKeyOf(headers: Request['headers']): string | undefined {
  const v = headers['idempotency-key'];
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0) return v[0];
  return undefined;
}

/**
 * Namespace the client-chosen Idempotency-Key by the authenticated principal (§5.3,
 * sec-review). The raw header is attacker-chosen, so keying the cache on it verbatim lets
 * tenant B replay tenant A's cached completion (cross-tenant disclosure) AND skip
 * rate-limit/metering (billing bypass). We compose `${keyHash}:${idemKey}` — the per-key
 * SHA-256 hash (NOT the plaintext) — so the cache is strictly per API key and a lower-scope
 * key can never read another key's cached output.
 */
export function idempotencyCacheKey(key: ApiKeyDoc, idemKey: string): string {
  return `${key.key}:${idemKey}`;
}

/**
 * 429 rate-limit envelope (§5.3) — uniform error shape + the standard `Retry-After`
 * header (whole seconds, rounded up from the limiter's ms hint).
 */
export function sendRateLimited(res: Response, requestId: string, retryAfterMs: number): void {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.setHeader('Retry-After', String(seconds));
  res.setHeader('X-Request-Id', requestId);
  sendError(
    res,
    requestId,
    429,
    'rate_limit_exceeded',
    `Rate limit exceeded for this API key + tier. Retry after ~${seconds}s.`,
  );
}

function asTier(v: unknown): Tier | undefined {
  return v === 'low' || v === 'mid' || v === 'high' ? v : undefined;
}

/**
 * Resolve the per-agent / per-loop budget identity (ADR-204 §5.2). The optional
 * `X-Cognitum-Agent-Id` header names the autonomous agent / loop so its runaway cap is
 * tracked independently; absent it, all of a key's traffic collapses to one agent bucket
 * keyed by the account (or the key hash when the key carries no accountId). Bounded length so
 * an attacker-chosen header can't blow up the Firestore doc id.
 */
export function agentIdOf(headers: Request['headers'], key: ApiKeyDoc): string {
  const h = headers['x-cognitum-agent-id'];
  const raw = typeof h === 'string' ? h : Array.isArray(h) ? h[0] : undefined;
  if (raw && raw.length > 0) return raw.slice(0, 128);
  return key.accountId ?? key.key;
}

/** Account budget identity (ADR-204 §5.2) — the subscription doc key. */
export function accountIdOf(key: ApiKeyDoc): string {
  return key.accountId ?? key.key;
}

/**
 * Merge the X-Cognitum-* routing-control headers onto the request body fields (§3.4).
 * Body values take precedence; headers fill in when the body omits the field.
 */
export function mergeRoutingControls(body: ChatCompletionRequest, headers: Request['headers']): void {
  const h = (name: string): string | undefined => {
    const v = headers[name];
    return typeof v === 'string' ? v : undefined;
  };
  if (body.fallback_policy === undefined) {
    const fp = h('x-cognitum-fallback-policy');
    if (fp === 'fail_fast' || fp === 'best_effort') body.fallback_policy = fp as FallbackPolicy;
  }
  if (body.min_tier === undefined) body.min_tier = asTier(h('x-cognitum-min-tier')) ?? undefined;
  if (body.max_tier === undefined) body.max_tier = asTier(h('x-cognitum-max-tier')) ?? undefined;
  if (body.escalation === undefined) {
    const e = h('x-cognitum-escalation');
    if (e === 'stream_oneshot' || e === 'post_hoc' || e === 'buffered' || e === 'inflight') {
      body.escalation = e as EscalationStrategy;
    }
  }
}

export interface CognitumHeaderFields {
  resolvedTier: Tier;
  resolvedModel: string;
  escalated: boolean;
  capDegraded: boolean;
  routingReason: string;
}

/** HTTP header values must be ASCII; the routing reason can carry unicode (τ, →) in the
 *  JSON body but is folded to ASCII for the X-Cognitum-Routing-Reason header. */
function asciiHeader(s: string): string {
  return s
    .replace(/τ/g, 'tau')
    .replace(/[→➔➙]/g, '->')
    .replace(/[^\x20-\x7e]/g, '');
}

/** Mirror the x_cognitum block onto X-Cognitum-* response headers (§3.4). */
export function setCognitumHeaders(res: Response, requestId: string, f: CognitumHeaderFields): void {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Cognitum-Resolved-Tier', f.resolvedTier);
  res.setHeader('X-Cognitum-Resolved-Model', f.resolvedModel);
  res.setHeader('X-Cognitum-Escalated', String(f.escalated));
  res.setHeader('X-Cognitum-Cap-Degraded', String(f.capDegraded));
  res.setHeader('X-Cognitum-Routing-Reason', asciiHeader(f.routingReason));
}
