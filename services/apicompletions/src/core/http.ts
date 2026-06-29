// Shared HTTP helpers for the OpenAI-compatible routes (ADR-203 §3.4, §6).
// Uniform error envelope { error, code, requestId }; X-Cognitum-* routing controls accepted
// as headers (mirroring the body fields); X-Cognitum-* response headers mirror x_cognitum.
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
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
