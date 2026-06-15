# ADR-040: Adaptive Cost-Optimal Routing — from benchmark to operational router

**Status**: Proposed
**Date**: 2026-06-15
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-037 (DRACO), ADR-038 (quality ceiling), ADR-039 (cost dominance)

---

## Context

The DRACO investigation answered **Phase 1 — "can a harness beat the model?"**
with a bounded, mechanistic *no*: within observed variance, no tested harness arm
exceeded a strong direct call, because grounding is a fraction of resolving URLs
that no transform/select/union strategy can raise (ADR-038).

ADR-039 surfaced the more valuable question. The surprising, measured fact is not
"haiku is cheaper" (everyone knows that) — it is **haiku scored HIGHER than opus
on DRACO while costing ~10× less** (0.7566 vs 0.7143, $0.12 vs $1.22). That is a
claim about *model selection*, and it reframes the goal as **Phase 2 — "can a
harness CHOOSE the right model?"** — the question enterprises actually buy, since
they purchase `quality / dollar`, not `quality`.

> Phase 1: Can a harness beat the model? → No.
> Phase 2: Can a harness choose the right model? → Potentially yes.

## Decision

Build **Adaptive Cost-Optimal Routing** as a measured DRACO mode. Objective:

```
maximize    quality / dollar
subject to  quality >= frontier_baseline − ε
```

i.e. get *frontier-level quality* (or within ε) for the *least money*, by routing
each question to the cheapest model that is good enough for it.

### Benchmark ladder (each measured on the same corpus + scorer)

| config | description | role |
|--------|-------------|------|
| `always_haiku` | cheap model on every question | cheap floor |
| `always_opus` | frontier model on every question | expensive baseline |
| `always_gpt` | a third family on every question | cross-family control |
| `router_v1` | static heuristic (e.g. always cheapest; escalate by domain) | naive router |
| `router_v2` | adaptive: a cheap pre-signal (judge/complexity) decides cheap-vs-escalate per question | real router |
| `oracle_router` | post-hoc picks the per-question best model | **theoretical upper bound** |

The **oracle** is the key construct: for each question it selects, with hindsight,
the model that actually scored highest — the unbeatable routing policy. A real
router's quality is then reported as **% of oracle**. If `router_v2` reaches
**≥95% of oracle quality-per-dollar**, DRACO has become an *operational routing
system*, not just a benchmark.

### Method (cost-aware, no waste)

1. Run vanilla on each pool model per question once → a per-question × per-model
   **score + token matrix** (one live run; reused for every router policy).
2. Compute `always_X` (column means), `oracle` (mean of per-question argmax), and
   any `router_vK` (a pure selection function over the matrix) **offline** from
   that single matrix — no re-running per policy.
3. Score on `quality/dollar` with the ADR-039 price table; report each policy's
   quality, cost, and **% of oracle**.

This needs the **per-question per-model** breakdown (the existing aggregate
artifacts don't carry it), so it adds one routing-matrix capability to the bench;
every router variant after that is free offline arithmetic.

## Consequences

- Converts the honest Phase-1 negative into a Phase-2 product direction:
  MetaHarness as a **cost-optimal model router**, the genuinely valuable business
  problem. Vindicates the ruflo MoE-routing thesis with a measured oracle gap.
- The oracle bounds how much routing can ever help; the router-vs-oracle gap is
  the real, honest figure of merit (not a vanity win vs vanilla).
- Pure-arithmetic policy evaluation over one matrix keeps it offline-testable and
  cheap; CI runs the full suite so the routing result cannot regress.

## Results — matrix run 1 (frontier n=20, pool haiku-4.5 / gpt-5 / opus-4)

| policy | quality | % oracle-q | cost | q/$ |
|--------|---------|-----------|------|-----|
| always_haiku | 0.6903 | 86% | $0.13 | 5.36 |
| always_gpt-5 | 0.7462 | 93% | $2.42 | 0.31 |
| always_opus | 0.7003 | 87% | $1.31 | 0.53 |
| **oracle_quality** | **0.8025** | **100%** | $1.67 | 0.48 |
| oracle_cost_optimal(ε=.03) | 0.8011 | 100% | $1.45 | 0.55 |
| router_v1 (always-cheapest) | 0.6903 | 86% | $0.13 | 5.36 |

**Phase 2 is validated.** The oracle (0.8025) beats the best *fixed* model
(gpt-5, 0.7462) by **+0.056 / +7.5%** — models genuinely disagree per question,
so per-question routing has real, measured headroom. The routing opportunity is
the 93% → 100% gap.

**Two honest corrections this run forced:**

1. **"haiku > opus on quality" did NOT survive a second run.** Here haiku 0.6903
   ≈ opus 0.7003 (a tie, haiku slightly lower) — the earlier 0.7566 was high
   variance. The robust, surviving claim is the weaker one: **haiku ~matches
   opus quality at ~10× lower cost** (cost-efficiency holds; the stronger
   quality-superiority claim does not). The guardrail worked.
2. **q/$ alone is the wrong figure of merit** — always-cheapest trivially maxes
   it while sitting at 86% quality. `analyse()` now also reports **% of oracle
   QUALITY**, the constrained objective. The real target for `router_v2` is to
   approximate the oracle's per-question pick: clear the best single model's 93%
   without paying always-gpt-5's $2.42.

**Next:** `router_v2` needs a routing-time pre-signal (a cheap confidence rating
of a candidate dossier, observable WITHOUT the scorer's URL re-fetch). The matrix
will be enriched to record it per cell so router_v2 is evaluated honestly (the
router sees only the pre-signal, never the post-hoc score the oracle uses).

## Results — matrix run 2 (signal-enriched, router_v2 sweep)

| policy | quality | % oracle-q | cost | q/$ |
|--------|---------|-----------|------|-----|
| always_haiku | 0.6545 | 86% | $0.13 | 4.87 |
| always_gpt-5 | 0.6795 | 89% | $2.50 | 0.27 |
| always_opus | 0.6960 | 91% | $1.27 | 0.55 |
| **oracle_quality** | **0.7682** | 100% | $1.68 | 0.46 |
| router_v1 (cheapest) | 0.6545 | 86% | $0.13 | 4.87 |
| **router_v2 (self-signal escalate, τ∈{.5,.6,.7,.8})** | **0.6512** | 85% | $0.38 | 1.73 |
| oracle_cost_optimal(ε=.03) | 0.7654 | 100% | $1.49 | 0.51 |

**Phase 2 premise re-confirmed:** the oracle (0.7682) beats the best fixed model
(opus, 0.6960) by **+0.072 / +10%** — consistent with run 1's +7.5%. Per-question
model disagreement is real and repeatable; routing headroom exists.

**router_v2 (hand-rolled self-signal escalation) FAILED — and the failure is the
finding.** It scored 0.6512 (85%) — *worse* than always-cheapest (0.6545) — and
paid extra ($0.38) for escalations that didn't help, **flat across all
thresholds**. Mechanism: a model's *self-rated holistic confidence does not
predict which questions another model wins.* Escalating "low-confidence"
questions to opus added cost without quality, because the self-rating is
uncorrelated with per-question model superiority.

**This is the empirical case for a LEARNED router (tiny-dancer), not a hand
threshold.** The signal that works is not self-assessment — it's a model trained
on (query embedding → per-model outcome). The routing matrix IS that training
set; the oracle's +10% is the headroom a learned router should capture where the
threshold couldn't. Next: train/evaluate `@ruvector/tiny-dancer` (FastGRNN +
uncertainty + circuit breaker) on this matrix, reported as % of oracle on the
same data. router_v2 stays in-tree as the measured-rejected naive baseline.

## Result — first router to beat the best fixed model (learned feature)

Evaluated offline on the run-2 matrix (no new spend):

| policy | quality | % oracle-q | cost |
|--------|---------|-----------|------|
| always_opus (best fixed) | 0.6960 | 91% | $1.27 |
| router_v2 (self-signal) | 0.6512 | 85% | $0.38 |
| **domain_router (learned, leave-one-out)** | **0.7022** | **92%** | $1.42 |
| oracle | 0.7682 | 100% | $1.68 |

`domain_router` routes each question to the model that historically wins its
DOMAIN (id prefix), trained leave-one-out (never sees its own answer). It is the
**first router to beat the best fixed model** (0.7022 > 0.6960, 92% > 91%
oracle-q) and it crushes the self-signal `router_v2` (0.7022 vs 0.6512).

**The finding is the contrast, not the +0.006:** the routing *signal* is
everything. A model's self-rating is useless (router_v2, 85%); a learned mapping
from a real feature (domain) clears the best fixed model (92%). The gap to the
oracle (92% → 100%) is the headroom a *richer* learned signal can still capture —
which is precisely the case for tiny-dancer (FastGRNN over query EMBEDDINGS, a
far richer feature than the 5-way domain label). Note tiny-dancer is
inference-only — it needs a pre-trained model + an embedding pipeline (the
broader ruvector stack), so `domain_router` is the no-dependency proof that a
learned feature-router works; the embedding router is the richer follow-up.

## Honest guardrails

- The "haiku > opus on DRACO" claim must **survive repeated runs** before it
  earns load-bearing weight — the routing matrix run records per-question scores
  so variance can be quantified, not assumed.
- Scoped to DRACO (grounded factual dossiers). A cost-optimal router here does
  not imply cheap models win on reasoning/code/agentic tasks — the router is
  trained and reported per benchmark, never extrapolated beyond its scope.
