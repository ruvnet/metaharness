// SPDX-License-Identifier: MIT
//
// @metaharness/projects — shared core (ADR-156). The spine of the borrowed-pattern
// program: the canonical mutatable POLICY OBJECT, deterministic primitives (seeded
// RNG, stable hashing), the shared TraceSpan contract, and a seeded paired
// bootstrap. Everything here is dependency-free and deterministic — the program
// thesis is "Darwin Mode mutates structured policies, not prompts," and reproducible
// replay is the proof, so the foundations must be pure and seedable.

// ─────────────────────────────────────────────────────────────────────────────
// The canonical policy object (ADR-156). This typed object — not a prompt blob —
// is the through-line of the whole program. Every module reads or mutates it.
// ─────────────────────────────────────────────────────────────────────────────

/** Where a role's model spend lands. `frontier_on_failure` escalates only on retry. */
export type ModelTier = 'cheap' | 'frontier' | 'frontier_on_failure';

/** The structured policy Darwin mutates (the ADR-156 mutation surface). */
export interface PolicyObject {
  plannerModel: ModelTier;
  coderModel: ModelTier;
  reviewerModel: ModelTier;
  retrievalTopK: number;
  maxRetries: number;
  frontierEscalationThreshold: number; // 0..1
  securityReviewRequired: boolean;
  batchEval: boolean;
  cacheRepoContext: boolean;
}

/** The default policy — a cheap-first, security-on baseline. */
export function defaultPolicy(): PolicyObject {
  return {
    plannerModel: 'cheap',
    coderModel: 'cheap',
    reviewerModel: 'frontier_on_failure',
    retrievalTopK: 12,
    maxRetries: 2,
    frontierEscalationThreshold: 0.78,
    securityReviewRequired: true,
    batchEval: true,
    cacheRepoContext: true,
  };
}

/** Clamp a number to [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Validate a policy object's bounds; returns the list of violations (empty = ok). */
export function validatePolicy(p: PolicyObject): string[] {
  const errs: string[] = [];
  const tiers: ModelTier[] = ['cheap', 'frontier', 'frontier_on_failure'];
  for (const k of ['plannerModel', 'coderModel', 'reviewerModel'] as const) {
    if (!tiers.includes(p[k])) errs.push(`${k} must be a ModelTier`);
  }
  if (!(p.retrievalTopK >= 1 && p.retrievalTopK <= 100)) errs.push('retrievalTopK out of range 1..100');
  if (!(p.maxRetries >= 0 && p.maxRetries <= 6)) errs.push('maxRetries out of range 0..6');
  if (!(p.frontierEscalationThreshold >= 0 && p.frontierEscalationThreshold <= 1)) errs.push('frontierEscalationThreshold out of range 0..1');
  return errs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic primitives.
// ─────────────────────────────────────────────────────────────────────────────

/** Seeded PRNG (mulberry32). Same seed → same stream. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable 8-hex-char hash of any JSON-serializable value (key order normalized). */
export function hashJson(value: unknown): string {
  return fnv1a(stableStringify(value)).toString(16).padStart(8, '0');
}

/** Deterministic JSON stringify with sorted object keys (stable across runs).
 *  Mirrors JSON.stringify semantics so it can safely key a content-addressed
 *  cache: object properties whose value is `undefined` are omitted, and
 *  `undefined` array elements coerce to `null` (so `{a:undefined}` ≠ `{a:null}`). */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Round to 6 decimal places (the program's canonical numeric precision). */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared trace contract (ADR-158). Defined here so the ledger (trace.ts),
// the opportunity scanner (opportunity.ts) and the review gates (review-gates.ts)
// share one shape without importing each other.
// ─────────────────────────────────────────────────────────────────────────────

/** The kinds of work a span can represent. */
export type SpanKind =
  | 'planner'
  | 'model'
  | 'tool'
  | 'retrieval'
  | 'test'
  | 'review'
  | 'guardrail'
  | 'mutation'
  | 'handoff'
  | 'memory';

/** One unit of attributed work. Cost is in abstract cost-units (see COST_UNIT). */
export interface TraceSpan {
  id: string;
  parentId?: string;
  kind: SpanKind;
  genomeId: string;
  label: string;
  model?: ModelTier;
  tokensIn: number;
  tokensOut: number;
  costUnits: number;
  durationMs: number;
  outcome: 'ok' | 'error' | 'skipped';
}

/** Sum the cost-units of a set of spans. */
export function sumCost(spans: TraceSpan[]): number {
  return round6(spans.reduce((acc, s) => acc + s.costUnits, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Seeded paired bootstrap (shared by datasets.ts and review-gates.ts). Mirrors
// the Darwin Shield promotion statistic: certify that candidate beats incumbent.
// ─────────────────────────────────────────────────────────────────────────────

export interface BootstrapResult {
  meanDelta: number;
  lower95: number;
  upper95: number;
  /** Fraction of resamples with delta ≤ 0 (one-sided p-value proxy). */
  pValue: number;
  samples: number;
}

/**
 * Paired bootstrap of (candidate − incumbent) per-sample deltas. `lower95 > 0`
 * is the promotion signal: candidate is superior with 95% confidence. Deterministic
 * for a fixed seed; `incumbent` and `candidate` must be aligned per-sample arrays.
 */
export function bootstrapDelta(
  incumbent: number[],
  candidate: number[],
  opts: { seed?: number; resamples?: number } = {},
): BootstrapResult {
  const n = Math.min(incumbent.length, candidate.length);
  const resamples = Math.max(1, opts.resamples ?? 5000);
  if (n === 0) return { meanDelta: 0, lower95: 0, upper95: 0, pValue: 1, samples: 0 };
  const deltas = Array.from({ length: n }, (_, i) => candidate[i] - incumbent[i]);
  const rng = makeRng(opts.seed ?? 0);
  const means: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    let acc = 0;
    for (let i = 0; i < n; i += 1) acc += deltas[Math.floor(rng() * n)];
    means.push(acc / n);
  }
  means.sort((a, b) => a - b);
  const at = (q: number): number => means[clamp(Math.floor(q * (resamples - 1)), 0, resamples - 1)];
  const meanDelta = round6(deltas.reduce((a, b) => a + b, 0) / n);
  const nonPositive = means.reduce((acc, m) => acc + (m <= 0 ? 1 : 0), 0);
  return {
    meanDelta,
    lower95: round6(at(0.025)),
    upper95: round6(at(0.975)),
    pValue: round6(nonPositive / resamples),
    samples: n,
  };
}

/** Short unique-ish id from a seed/counter (deterministic). */
export function idFrom(prefix: string, n: number): string {
  return `${prefix}-${n.toString(36)}`;
}
