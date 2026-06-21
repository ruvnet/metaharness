// SPDX-License-Identifier: MIT
//
// @metaharness/projects — trace.ts (ADR-158 Darwin Trace Format & Cost Ledger).
//
// Borrowed from the OpenAI Agents SDK tracing model: every unit of work emits a
// span, and every cost-unit must map to a span. The CostLedger reconciles traced
// spend against the externally-accounted spend so that no model call goes
// unattributed (leaks surface instead of hiding in the bill).
//
// The optimization (measured in bench/trace.bench.mjs): detectLeaks() scans a run
// for waste — repeated identical retrieval/memory/tool calls, frontier models used
// on low-risk work, and oversized retrieval context — and reports projected
// cost-unit savings as a fraction of the run total.

import type { ModelTier, SpanKind, TraceSpan } from './core.js';
import { idFrom, round6, sumCost } from './core.js';

// ─────────────────────────────────────────────────────────────────────────────
// Tracer — emits deterministic, ordered spans for one genome.
// ─────────────────────────────────────────────────────────────────────────────

/** Threshold (tokens) above which a retrieval span's context is "oversized". */
export const OVERSIZED_CONTEXT_TOKENS = 8000;

/** Records spans with deterministic ids (idFrom(genomeId, counter)). */
export class Tracer {
  private list: TraceSpan[] = [];
  private counter = 0;
  // `seed` is accepted for API symmetry with the rest of the program; span ids
  // are derived deterministically from a counter so replay is reproducible.
  constructor(private readonly genomeId: string, private readonly seed = 0) {}

  /** Append a span. Numeric fields default to 0 (deterministic, no Date.now). */
  span(
    kind: SpanKind,
    label: string,
    opts: {
      model?: ModelTier;
      tokensIn?: number;
      tokensOut?: number;
      costUnits?: number;
      durationMs?: number;
      outcome?: 'ok' | 'error' | 'skipped';
      parentId?: string;
    } = {},
  ): TraceSpan {
    const span: TraceSpan = {
      id: idFrom(this.genomeId, this.seed + this.counter),
      kind,
      genomeId: this.genomeId,
      label,
      tokensIn: opts.tokensIn ?? 0,
      tokensOut: opts.tokensOut ?? 0,
      costUnits: opts.costUnits ?? 0,
      durationMs: opts.durationMs ?? 0,
      outcome: opts.outcome ?? 'ok',
    };
    if (opts.model !== undefined) span.model = opts.model;
    if (opts.parentId !== undefined) span.parentId = opts.parentId;
    this.counter += 1;
    this.list.push(span);
    return span;
  }

  /** All emitted spans, in emission order. */
  spans(): TraceSpan[] {
    return this.list.slice();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CostLedger — reconcile traced spend vs. externally-accounted spend.
// ─────────────────────────────────────────────────────────────────────────────

/** Aggregates span cost and reconciles it against an external account. */
export class CostLedger {
  private list: TraceSpan[];

  constructor(spans: TraceSpan[] = []) {
    this.list = spans.slice();
  }

  /** Add a span to the ledger. */
  add(span: TraceSpan): void {
    this.list.push(span);
  }

  /** Total traced cost-units. */
  total(): number {
    return sumCost(this.list);
  }

  /** Cost-units grouped by span kind. */
  byKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.list) out[s.kind] = round6((out[s.kind] ?? 0) + s.costUnits);
    return out;
  }

  /**
   * Reconcile traced spend against `accountedCost`. `ok` iff traced === accounted
   * (to 6 dp) AND no model-kind span is missing cost (a model call with zero cost
   * is an unattributed call). If `expectedModelCalls` is given, any shortfall vs.
   * the number of model-kind spans counts as unaccounted model calls.
   */
  reconcile(
    accountedCost: number,
    expectedModelCalls?: number,
  ): { ok: boolean; traced: number; accounted: number; unaccounted: number; unaccountedModelCalls: number; modelCallsCertified: boolean } {
    const traced = this.total();
    const accounted = round6(accountedCost);
    const unaccounted = round6(accounted - traced);

    const modelSpans = this.list.filter((s) => s.kind === 'model');
    const zeroCostModel = modelSpans.filter((s) => s.costUnits === 0).length;
    const expectedShortfall =
      expectedModelCalls !== undefined ? Math.max(0, expectedModelCalls - modelSpans.length) : 0;
    const unaccountedModelCalls = zeroCostModel + expectedShortfall;

    // Honest limit: model-call completeness can only be CERTIFIED when the caller
    // supplies expectedModelCalls. Without it, `ok` proves cost reconciliation but
    // cannot prove a model call wasn't both unspanned AND unbilled.
    const modelCallsCertified = expectedModelCalls !== undefined;
    const ok = unaccounted === 0 && unaccountedModelCalls === 0;
    return { ok, traced, accounted, unaccounted, unaccountedModelCalls, modelCallsCertified };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Leak detection — the ROI surface.
// ─────────────────────────────────────────────────────────────────────────────

/** A detected source of wasted spend, with its projected savings. */
export interface Leak {
  kind: SpanKind;
  label: string;
  count: number;
  wastedCostUnits: number;
  reason: string;
}

/**
 * Scan spans for waste:
 *  (a) repeated identical (kind+label) retrieval/memory/tool spans — the 2nd+
 *      occurrences are waste (sum of their costUnits), reason 'repeated <kind>';
 *  (b) frontier model spans whose label is tagged 'low-risk' — reason
 *      'frontier on low-risk' (the whole span cost is the waste);
 *  (c) retrieval spans with tokensIn above the oversized threshold — reason
 *      'oversized context' (the span cost is the waste).
 * Sorted by wastedCostUnits descending.
 */
export function detectLeaks(spans: TraceSpan[]): Leak[] {
  const leaks: Leak[] = [];

  // (a) Repeated identical retrieval/memory/tool spans.
  const repeatKinds = new Set<SpanKind>(['retrieval', 'memory', 'tool']);
  const groups = new Map<string, TraceSpan[]>();
  for (const s of spans) {
    if (!repeatKinds.has(s.kind)) continue;
    const key = `${s.kind}::${s.label}`;
    const g = groups.get(key) ?? [];
    g.push(s);
    groups.set(key, g);
  }
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    const dups = g.slice(1); // first occurrence is legitimate; rest are waste
    leaks.push({
      kind: g[0].kind,
      label: g[0].label,
      count: dups.length,
      wastedCostUnits: round6(dups.reduce((a, s) => a + s.costUnits, 0)),
      reason: `repeated ${g[0].kind}`,
    });
  }

  // (b) Frontier model on low-risk work.
  for (const s of spans) {
    if (s.kind === 'model' && s.model === 'frontier' && s.label.includes('low-risk')) {
      leaks.push({
        kind: s.kind,
        label: s.label,
        count: 1,
        wastedCostUnits: round6(s.costUnits),
        reason: 'frontier on low-risk',
      });
    }
  }

  // (c) Oversized retrieval context.
  for (const s of spans) {
    if (s.kind === 'retrieval' && s.tokensIn > OVERSIZED_CONTEXT_TOKENS) {
      leaks.push({
        kind: s.kind,
        label: s.label,
        count: 1,
        wastedCostUnits: round6(s.costUnits),
        reason: 'oversized context',
      });
    }
  }

  leaks.sort((a, b) => b.wastedCostUnits - a.wastedCostUnits);
  return leaks;
}
