# ADR-158: Darwin Trace Format & Cost Ledger — every dollar maps to a span

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-TRACE`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: A typed span trace over every harness decision, with a cost ledger that reconciles span costs against the frozen fitness cost inputs and surfaces spend leaks as a mutation signal.
**Related**: ADR-155 (Darwin Shield), ADR-156 (borrowed-pattern integration program — "mutate structured policies, not prompts"), ADR-072 (frozen scorer/promotion), ADR-082 (expected gains + effective-performance metric), ADR-074 (ruVector memory fabric), ADR-073 (archive), ADR-079 (SGM statistical gates + risk budget), ADR-153 (agentic-loop architecture), ADR-157 (Darwin Checkpoints)

> We borrow the **built-in tracing** pattern from the **OpenAI Agents SDK** (which auto-traces LLM generations, tool calls, handoffs, guardrails, and custom events into a span tree). We copy the *pattern*, not the product: no OpenAI SDK, no hosted traces dashboard, no `agents` runtime is imported. We graft its idea — make every decision a span with a parent, a kind, and a cost — onto Darwin Shield's deterministic swarm in `packages/darwin-mode/src/security/`. Because **Darwin Mode mutates structured policies, not prompts**, a trace here is a tree of *policy decisions* (which planner fired, which reviewer ran, which tool was invoked) — not a chat log. The discipline is strict: **every dollar spent maps to a span and a task outcome; no unaccounted model calls.** This makes the program thesis auditable — **the foundation model stays frozen; the harness evolves; the proof is in replay** — by proving where the harness's compute actually goes.

## Context

Darwin Shield already has a deterministic cost proxy: `costOf(genome)` in `src/security/swarm.ts` sums `reviewerCount`, `tools.length`, `retryBudget`, `fuzzBudgetSeconds/60`, a `contextPolicy` weight, and `modelMix.length`. That number flows into `RunMetrics.costUnits`, which `fitness()` in `scoring.ts` turns into the `costEfficiency` term (`clamp(1 - costUnits / COST_BUDGET, 0, 1)`, `COST_BUDGET = 20`). The scorer therefore *prices* a genome, but the price is a single opaque scalar. When a champion is expensive, we cannot say *why*: is the spend in reviewers, in oversized `hybrid` context, in frontier `modelMix` calls on low-risk repos, or in repeated repo summaries inside `runSwarm`?

The OpenAI Agents SDK tracing pattern answers exactly this: every generation, tool call, and guardrail is a span in a tree, so cost and latency are attributable. Applied to Darwin Shield, a span trace lets us find where money leaks — repeated repo summaries (`profileRepo(repo)` runs every repo every genome), unnecessary reviewers (a 5th reviewer that adds no detection or FP benefit — exactly the over-provisioning `scoring.ts` already warns about), oversized context (`hybrid` costs 2× `minimal` in `costOf`), and frontier calls on low-risk tasks.

The source's expected impact — **10–30% cost reduction after trace-based pruning** — is a **hypothesis to validate** on our corpus via ablation, not a fact to cite. The non-negotiable correctness property, by contrast, *is* a fact we will enforce: **Σ span costUnits == the run's accounted cost**, with zero unaccounted model calls.

## Decision

Add a **typed trace format** (PROPOSED new module `src/security/trace.ts`) emitted by `runSwarm` and the real loop (`real-loop.ts`), plus a **cost ledger** (PROPOSED `src/security/ledger.ts`) that aggregates spans by kind, enforces a reconciliation invariant against `RunMetrics`/`FitnessBreakdown`, and exposes per-kind leaks as a signal `ablation.ts` can act on.

### Trace span

```ts
// PROPOSED — src/security/trace.ts
export type SpanKind =
  | 'plan'        // planner decision (file-first | sink-first | …)
  | 'context'     // retrieval call (minimal | semantic | callgraph | hybrid)
  | 'model'       // a frozen-model generation (modelMix entry)
  | 'tool'        // a SecurityTool invocation (semgrep | codeql | …)
  | 'review'      // one adversarial reviewer pass
  | 'fuzz'        // a fuzz step bounded by fuzzBudgetSeconds
  | 'test'        // a repro/regression test run
  | 'guardrail'   // a policy.ts safety-gate decision
  | 'mutation';   // a genome mutation diff (structured, not a prompt)

export interface TraceSpan {
  id: string;
  parentId?: string;            // span tree edge (root = the runSwarm call)
  kind: SpanKind;
  genomeId: string;             // HarnessGenome.id this span belongs to
  taskId: string;               // == BenchmarkReceipt.taskId
  model?: string;               // set iff kind === 'model' (a modelMix entry)
  tool?: string;                // set iff kind === 'tool' (a SecurityTool)
  tokensIn?: number;            // metered for 'model' spans (real-loop)
  tokensOut?: number;
  costUnits: number;            // this span's slice of the deterministic proxy
  durationMs: number;           // wall-clock (real) / proxy (sim) — never in fitness
  /** What the decision produced, for the leak detector + audit. */
  outcome:
    | 'finding'                 // a confirmed/needs-review finding
    | 'false_positive'
    | 'no_finding'
    | 'rejected_unsafe'         // guardrail tripped (policy.ts)
    | 'cache_hit'               // reused via ADR-157
    | 'ok';
  startedAt: string;            // fixed epoch in sim mode for byte-stable traces
}
```

### The reconciliation invariant (load-bearing)

The span tree must price the genome exactly as the frozen scorer does. The invariant:

```
Σ over spans s of s.costUnits  ==  RunMetrics.costUnits  ==  costOf(genome)   (sim mode)
```

and, equivalently, the `costEfficiency` term `FitnessBreakdown` computes from `RunMetrics.costUnits` must be derivable from the trace alone. In real-loop mode the right-hand side is metered USD; the equality holds against the metered total. This is the operationalization of "every dollar maps to a span": a run is **rejected** (fails acceptance) if the span sum diverges from the accounted cost, or if any `kind: 'model'` span exists without a corresponding metered call (an unaccounted model call) — or, the converse, a metered call with no span.

### Cost ledger

```ts
// PROPOSED — src/security/ledger.ts
import type { SpanKind, TraceSpan } from './trace.js';

export interface LedgerLine {
  kind: SpanKind;
  spans: number;
  costUnits: number;            // Σ costUnits for this kind
  findings: number;             // outcomes that produced a finding
  costPerFinding: number;       // costUnits / max(1, findings) — the leak metric
}

export interface CostLedger {
  byKind: LedgerLine[];
  totalCostUnits: number;
  /** MUST equal RunMetrics.costUnits — the reconciliation check. */
  accountedCostUnits: number;
  reconciled: boolean;          // totalCostUnits === accountedCostUnits
  /** Kinds whose costPerFinding exceeds a threshold = candidate leaks. */
  leaks: LedgerLine[];
}

export function buildLedger(
  spans: TraceSpan[],
  accountedCostUnits: number,   // RunMetrics.costUnits
  leakThreshold?: number,
): CostLedger;
```

A leak is a `LedgerLine` whose `costPerFinding` is high relative to its peers — e.g. a `review` line that cost 4 units across reviewers 2–5 but produced no additional `finding`/`false_positive_avoided` outcome (the over-provisioned 5th reviewer `scoring.ts` already penalizes), or a `context` line where `hybrid` doubled cost with no detection gain, or `model` spans on low-risk repos that yielded `no_finding`.

### Trace-based pruning as a mutation signal

The ledger feeds `ablation.ts` (which already knocks out each harness lever and measures lost fitness): a kind with high `costPerFinding` and *low ablation impact* is dead weight. PROPOSED: surface these as a **pruning hint** the mutator can bias toward — e.g. when the `review` ledger line is a leak and ablating a reviewer costs ~0 fitness, prefer the `reviewerCount − 1` mutation in `genome.ts`'s `mutate`. This keeps the mutation **structured** (a bounded `reviewerCount` change in `[1,5]`), honoring ADR-156 — we never mutate a prompt, we lower a policy knob the ledger proved wasteful. The pruning hint is advisory: the frozen scorer and `decidePromotion` (ADR-079) still decide whether the leaner child is actually promoted.

### Where traces persist

Spans are written into the ADR-073 archive next to the `BenchmarkReceipt` (which already carries `taskId`, `genomeId`, `inputHash`, `seed`) and indexed in ruVector (ADR-074) by `genomeId` so leak patterns compound across runs. Traces are deterministic in sim mode (fixed `startedAt`, proxy `costUnits`) so they replay byte-identically — the proof is in replay.

## Consequences

### What changes
- `runSwarm` (and `real-loop.ts`) emit a `TraceSpan[]` per evaluation, attached to the `BenchmarkReceipt`.
- A new `CostLedger` aggregates spans by kind and enforces the reconciliation invariant on every run.
- `ablation.ts` consumes the ledger to mark high-cost/low-impact kinds; the mutator can bias toward pruning them as a structured knob change.
- Spend becomes attributable: "this champion costs 14 units, 9 of them in `model` spans on low-risk repos" instead of "costUnits: 14".

### What does not change
- `fitness()` and the `0.10·cost_efficiency` weight in `scoring.ts` are untouched — the trace *explains* `RunMetrics.costUnits`, it does not redefine it. The scorer stays frozen.
- `costOf(genome)` remains the sim cost source of truth; the span sum must equal it (the invariant), not replace it.
- `HarnessGenome`, `safetyProfile: 'strict-defensive'`, and the bounds in `genome.ts` are unchanged; pruning only nudges existing bounded knobs.
- The safety gate is preserved and now *traced*: every `gateOutputs`/`detectUnsafe` decision is a `guardrail` span with `outcome` `rejected_unsafe` or `ok`, and `unsafeOutputs` must stay 0.

### What hurts
- **Reconciliation is strict and can fail the build.** If span emission misses a call (or double-counts), `reconciled` is false and the run is rejected. This is intentional — an unaccounted model call is the precise failure we forbid — but it raises the bar on instrumenting every call site in `runSwarm`/`real-loop.ts`.
- **Instrumentation overhead.** Every decision now allocates a span; in real-loop mode token metering must be wired to the actual model client.
- **Leak detection can mislead.** A high `costPerFinding` kind may be cheap insurance (a reviewer that rarely fires but catches a critical FP). Hence pruning is gated by ablation impact *and* the statistical promotion gate, never applied blindly.
- The 10–30% pruning saving is an **unproven hypothesis** until the ablation+pruning loop demonstrates it on our corpus; we must not present the OpenAI source's number as our result.

## Alternatives Considered

1. **Keep the opaque `costUnits` scalar.** Status quo. Rejected: cannot localize leaks, so cost-reducing mutations are guesswork rather than evidence-driven.
2. **Log free-text traces (printf-style).** Rejected: not reconcilable, not deterministic, not queryable; can't enforce "every dollar maps to a span."
3. **Adopt the OpenAI Agents SDK tracer directly.** Rejected per ADR-156: copy the pattern, not the product; our spans price *structured policy decisions*, not prompt/response pairs, and we will not depend on a hosted dashboard.
4. **Trace only `model` spans (cost-only).** Cheaper, but misses reviewer/context/fuzz leaks that dominate the `costOf` proxy. Rejected: most of the proxy is non-model spend.
5. **Make the trace authoritative for fitness (replace `costOf`).** Rejected: that mutates the frozen scorer (ADR-072). The trace must *reconcile to* the scorer, not become it.

## Test Contract

London-school unit tests mock the call/emit boundary and assert on span interactions; integration tests run the deterministic sim and reconcile against real `RunMetrics`.

- **`trace.unit.emitsSpanPerDecision`** (London) — with a mocked span sink, run `runSwarm` for a genome with `reviewerCount: 3`, `tools: ['semgrep','codeql']`, `contextPolicy: 'hybrid'`; assert exactly one `context` span, two `tool` spans (one per tool), three `review` spans, and a `guardrail` span per emitted finding, each with the correct `genomeId`/`taskId`.
- **`ledger.integration.reconciliation`** (the acceptance test) — run `runSwarm` over the standard corpus; build the ledger and assert (a) `Σ span.costUnits === RunMetrics.costUnits === costOf(genome)` (`reconciled === true`); (b) there are **zero unaccounted model calls** — every `kind: 'model'` span maps to exactly one metered call and vice-versa; (c) `costEfficiency` recomputed from the trace total equals `FitnessBreakdown.costEfficiency` from `scoring.ts`. A divergence fails the test.
- **`ledger.unit.leakDetectionOnSyntheticTrace`** (London) — feed `buildLedger` a synthetic `TraceSpan[]` with four `review` spans costing 4 units but zero incremental `finding` outcomes and one `tool` span costing 0.5 with one finding; assert the `review` line appears in `leaks` (high `costPerFinding`) and the `tool` line does not.
- **`ledger.unit.guardrailSpansAreTraced`** — inject a finding containing an unsafe pattern; assert a `guardrail` span with `outcome: 'rejected_unsafe'` is emitted, `detectUnsafe` fired, and `RunMetrics.unsafeOutputs` stays 0 (acceptance invariant).
- **`trace.integration.pruningSignalIsStructured`** — given a champion whose ledger flags `review` as a leak and whose `ablate()` shows ~0 fitness loss from a reviewer, assert the pruning hint proposes a bounded `reviewerCount − 1` mutation (still in `[1,5]`), and that the resulting child is only promoted if `decidePromotion` (`stats.ts`/ADR-079) clears it.
- **`trace.unit.deterministicReplay`** — run the same `(genome, corpus, seed)` twice; assert the two `TraceSpan[]` are byte-identical (fixed `startedAt`, proxy `costUnits`, stable span ids) — the trace replays exactly.
- **`ledger.unit.cacheHitSpansChargeZero`** — with ADR-157 cache hits, assert spans with `outcome: 'cache_hit'` carry `costUnits: 0` and the ledger still reconciles (reused cost is attributed to the original span, not double-counted).

## Reference implementation

A dependency-free, deterministic reference lives in the `@metaharness/projects` package (committed this session; 117 passing tests across the package). Module: `packages/projects/src/trace.ts` (+ `__tests__/trace.test.ts`, `bench/trace.bench.mjs`). It implements `Tracer`, `CostLedger` (whose `reconcile()` returns `modelCallsCertified`), and `detectLeaks`. The bench writes a receipt to `packages/projects/bench/results/trace.json`. Measured there — synthetic, deterministic simulation, not field data — the ledger reconciles exactly (Σ span cost == accounted) and `detectLeaks` finds 24 leaks projecting ~50.5% savings. This cost-ledger is also the substrate the optional real-LLM benches use to compute cost-per-finding.

## References

- OpenAI Agents SDK — built-in tracing of LLM generations, tool calls, handoffs, guardrails, and custom events into a span tree (`openai/openai-agents-python`, OpenAI Agents SDK "Tracing" docs). Pattern borrowed: span tree with parent/kind/cost; product not imported.
- ADR-155 (Darwin Shield) — `costOf`, `RunMetrics.costUnits`, `fitness()`/`FitnessBreakdown.costEfficiency`, `COST_BUDGET`, the safety gate this ADR traces.
- ADR-156 — borrowed-pattern integration program ("mutate structured policies, not prompts"); pruning stays a structured knob change.
- ADR-072 (frozen scorer) — the reconciliation target; the trace explains but never replaces it.
- ADR-082 (expected gains + effective-performance metric) — cost-attributed effective performance the ledger makes auditable.
- ADR-073 / ADR-074 — archive + ruVector persistence for spans and cross-run leak patterns.
- ADR-079 (SGM statistical gates) — gates whether a pruned, leaner child is actually promoted.
- ADR-157 (Darwin Checkpoints) — `cache_hit` spans and the cost-accounting cross-check.
