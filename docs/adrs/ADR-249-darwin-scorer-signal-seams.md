# ADR-249: Darwin scorer signal seams — opt-in injected trace quality + deterministic cost-units

- **Status**: Accepted — implemented in `packages/darwin-mode/src/scorer.ts` (additive optional argument, zero behaviour change when absent), regression-tested in `packages/darwin-mode/__tests__/scorer-signals.test.ts`.
- **Date**: 2026-08-10
- **Deciders**: ruv
- **Tags**: darwin-mode, scoring, promotion, determinism, credit-assignment, seams, metaharness
- **Extends**: ADR-072 (frozen scorer + promotion gate), ADR-075 (reproducibility clause), ADR-235 (additive-optional-field precedent), ADR-248 (`@metaharness/turn-credit` upstream signal producer)
- **Artifacts**: `packages/darwin-mode/src/scorer.ts` (`ScoreSignals`, `scoreVariant` 6th optional arg), `packages/darwin-mode/__tests__/scorer-signals.test.ts`

---

## Context

The frozen ADR-072 scorer has two deliberately blunt terms:

- **`traceQuality`** is a binary size heuristic: 0.9 if every trace's combined stdout+stderr stays
  under 4 MiB, else 0.5. It says nothing about *which turns mattered*. ADR-248 now ships exactly
  that signal — `creditByLabel` over a trajectory yields a per-decision credit distribution an
  upstream caller can fold into a scalar quality figure. But darwin-mode is dependency-free
  phase-1 and MUST NOT import `@metaharness/turn-credit`; per its own charter the adapters are
  structurally typed with no sibling imports, and the same discipline applies on the consuming end.
- **`costEfficiency`** (and `latencyEfficiency`) are pinned at 1.0. Folding raw wall-clock
  `durationMs` into the score made `finalScore` — and under parallel load, the winner's *identity* —
  non-reproducible, violating the ADR-075 reproducibility clause. The pin was the honest fix, but it
  leaves the scorer blind to cost even when a caller *can* supply a deterministic cost figure
  (token counts, tool-call counts, ADR-072 §cost proxy-seconds — anything derived reproducibly
  from the trace rather than from the clock).

ADR-235 established the pattern for evolving frozen decision code: **additive optional fields, with
the absent case byte-identical to the prior behaviour** (`LineageCommit` grew optional scores; the
verifier grew an optional `promotionRule`; nothing existing re-graded). The scorer needs the same
treatment: seams, not rewrites — a variant still must never be able to re-grade itself, and old
call sites must keep producing bit-identical scorecards.

## Decision

Add one optional trailing argument to `scoreVariant` — `signals?: ScoreSignals` — with two
independent, structurally-typed seams:

1. **Injected trace quality** (`signals.traceQuality?: number`). When present and finite, it
   replaces the size heuristic: clamped to [0,1], round6'd, and used as the `traceQuality` term.
   When absent (or non-finite — absent semantics, never a throw), the binary heuristic runs
   unchanged. The producer is upstream and unnamed by type: a plain number keeps darwin-mode free
   of a turn-credit import while letting a host derive the figure from ADR-248 `creditByLabel`,
   an LLM judge, or anything else deterministic.

2. **Deterministic cost input** (`signals.cost?: { units: number; budgetUnits: number }`), in
   abstract cost-units — explicitly NOT wall-clock. `costEfficiency` becomes:
   - **1.0** when the seam is absent, malformed (non-finite fields, `budgetUnits ≤ 0`,
     `units < 0`), or `units ≤ budgetUnits` (at/under budget);
   - **`round6(budgetUnits / units)`** over budget — monotone non-increasing in `units`,
     always in (0, 1), deterministic because both operands are caller-supplied constants.

   `latencyEfficiency` stays pinned at 1.0: wall-clock is still jitter, and ADR-075 still wins.

Everything downstream of the base terms is untouched: the ADR-072 penalty layer (coefficients,
regexes, `costOverrun` hook), the `SAFETY_GATE = 0.95`, all four promotion-gate clauses,
`src/bench/promotion.ts`, and `src/gepa/promotion.ts` are byte-for-byte unmodified. The seams can
only move the two weighted base terms they name.

## Consequences

- **Zero-cost adoption path:** every existing call site (e.g. `evolve.ts#evaluateVariant`) passes
  no `signals` and produces bit-identical scorecards — pinned by tests that hand-compute expected
  values from `scoreWeights()` (0.985 clean run, 0.71 half-pass, 0.925 oversized, 0.435
  post-penalty, 0.885 safety-zeroed) and assert exact equality for omitted / `undefined` / `{}`.
- **Credit-aware selection becomes possible without coupling:** a host that runs ADR-248 turn
  credit can now make Darwin prefer variants whose traces show concentrated, pivotal credit rather
  than merely small output — as *evidence folded into a weighted term*, never a gate by itself
  (the ADR-248 discipline carries over).
- **Cost pressure without clock noise:** a caller with a reproducible cost meter gets a real
  cost gradient (monotone in units) that can legitimately deny the score clause of promotion,
  while safety/regression clauses remain seam-blind by construction.
- **Determinism is delegated, honestly:** the scorer guarantees *reproducibility given its inputs*
  (same signals ⇒ same card, tested); it cannot verify the caller derived `units` or
  `traceQuality` deterministically. A caller that feeds wall-clock through the cost seam
  reintroduces exactly the ADR-075 violation the pin removed — the seam's contract says don't.

### Honest bounds

- With both seams absent, behaviour is **byte-identical** to the pre-seam scorer — that is the
  strongest claim here, and it is regression-tested; nothing about existing runs, archives, or
  published scores changes.
- The seams bound their own influence: at most `0.15` (traceQuality weight) + `0.10`
  (costEfficiency weight) of `baseScore`. They cannot flip `safetyScore`, any penalty, or any
  non-score gate clause.
- The injected trace-quality number is **trusted, not verified**: garbage in ⇒ garbage (but
  reproducible) out. The variant still cannot re-grade itself — signals enter from the kernel
  caller, not from `score_policy.ts` — but a *host* that injects a flattering signal weakens its
  own selection. Pair with ADR-235-style re-execution if the signal feeds published claims.
- The cost curve (`budget/units`, hinged at budget) is one defensible choice, not a measured
  optimum; no benchmark evidence yet says it selects better variants. `latencyEfficiency` remains
  a pinned 1.0 — this ADR narrows the pinned terms from two to one *seam-wise*, it does not claim
  latency is solved.

## 2026-08-17 addendum — the cost seam is now reachable from `evolve()`

MetaHarness Dream Cycle, 2026-08-17 (darwin-evolution). This ADR's own "Zero-cost adoption path"
consequence, above, observed in passing that `evolve.ts#evaluateVariant` "passes no `signals`" —
true, but also the *only* call site in the shipped orchestration loop, and it never gained a way to
pass any. The seam existed, tested in isolation (`scorer-signals.test.ts`), with nothing upstream able
to reach it: `EvolutionConfig` had no field to carry a cost figure, and no other production code
computed one for this purpose.

**Change**: `EvolutionConfig` gains an optional `costBudgetBytes: number`. When set,
`evaluateVariant` computes `variantBytes(variant.dir)` — the same deterministic surface-size signal
`'pareto'` selection already reads for tie-breaking (`evolve.ts`, pre-existing) — and passes it as
`signals.cost = { units, budgetUnits: costBudgetBytes }`. Omitted, `signals` stays `undefined` and the
call is byte-for-byte what it was: the "Zero-cost adoption path" claim above continues to hold, now
verified one level up (`evolve.test.ts`, 4 new tests, before/after stash repro:
`evaluateVariant is not a function` pre-fix → 9/9 post-fix; full package suite 632/632, 0 regressions).
`evaluateVariant` is also now exported (was module-private) so this wiring is directly testable
without running a full generation.

**Not done here, disclosed**: no `evolve()` caller sets `costBudgetBytes` yet (CLI flag or a config
default is a natural follow-up), and `variantBytes`'s pre-existing gameability (a whitespace/comment-
stripping mutation shrinks it for free) is now score-consequential rather than merely tie-break-
consequential once a caller does opt in — flagged in the accompanying gist as a next-night audit
candidate, not fixed tonight to keep this diff single-mechanism.

Full detail: `docs/dream-cycle/2026-08-17-gist.md`, issue and PR linked from the Dream Cycle ledger.
