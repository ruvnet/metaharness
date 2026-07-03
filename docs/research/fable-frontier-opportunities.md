# Fable-Guided Frontier Optimization Opportunities

**Date:** 2026-07-02
**Guide model:** `anthropic/claude-fable-5` (Fable-5), invoked directly via OpenRouter chat-completions.
**Orchestrator:** metaharness research agent (grounding + verification only — the frontier reasoning below is Fable's).
**Fable spend:** ~$1.62 total (1× `claude -p` smoke $1.26; 2× direct OpenRouter calls $0.21 + $0.15). Budget cap was $5.

## Purpose

Use Fable-5 as a frontier reasoner to surface **novel, testable** optimizations for the MetaHarness
control plane that our own ADRs have **not** built. Fable was grounded with the real system state and
real numbers (below) and instructed to reject generic advice and flag any restatement of existing ADRs.

## Ground state Fable was given (real system, real numbers)

- **Meta-LLM gateway:** tiered cheap→Fable routing; host-prompt normalization (ADR-236); host-keyed
  genome registry (ADR-235); response cache; guidance endpoint (ADR-237/238).
- **GEPA learning loop:** evolves the cheap-executor's standing **operating policy** (not advice),
  promote-on-holdout. Best candidate **cand-6** ("edit-by-midpoint") **generalized but sits below the
  useful bar**: holdout empty-patch rate moved **0.583 → 0.333** (right direction, insufficient to
  promote). It is a screening signal, not a win.
- **HarnessaaS verticals:** ADR-0024 Business Process Learning Harness + ADR-0025 RLI-Mini Acceptance
  Gate. Optimized metric = **cost-per-accepted-deliverable**. The **verifier pack is the product**.
- **External calibration:** RLI (Remote Labor Index) — frontier automates only **~16%** of real
  remote-work tasks end-to-end (up from ~2.5% a year ago); **Fable-5 ranks #1**. Scale MCP-Atlas —
  cheap **GLM-5.1 = 75.6%** on agentic tool-use = **near-frontier**.
- **Proven thesis (ADR-226):** advice does **not** transfer capability across models; evolving the
  standing policy + emitting typed **executable** actions does.

> **Attribution note.** Everything in the numbered proposals below is **Fable-5's reasoning**, lightly
> edited for the doc. The orchestrator supplied only the ground state and the questions, ran the calls,
> and wrote the "grounded vs speculative" audit and the ranked shortlist framing. Effect-size and dollar
> figures are **Fable's estimates**, not measured results.

---

## The five proposals (Fable-5)

### Q1 — Cross the bar for cand-6: dense fitness shaping + residual-seeded mutation

- **(a) Mechanism.** Two coupled changes. *Loop change:* replace the binary empty-patch fitness with a
  continuous **patch-progress score** `S = w1·(hunks applying cleanly) + w2·(holdout tests newly
  passing) − w3·(tests newly failing)`. cand-6 generalized directionally, so a real gradient exists,
  but the binary objective quantizes it — a candidate that gets 80% of the way to a valid patch scores
  identically to one that emits nothing. *Mutation-operator change:* **residual-trace-seeded mutation** —
  feed Fable **only** the traces of cand-6's remaining 0.333 failures, cluster them, and emit policy-clause
  mutations targeting the dominant residual cluster. Mutate **cand-6**, not the base genome (exploit the
  local basin instead of restarting exploration).
- **(b) Novelty.** GEPA today evolves against the sparse binary promotion metric and mutates from a
  general reflection corpus. Neither ADR-235/236 nor the loop spec includes dense fitness shaping or
  failure-residual-conditioned mutation targeting. This changes *what the loop can see* (gradient
  density) and *where mutations are sampled from* (the residual failure manifold of the current best).
- **(c) Experiment.** 3 arms × 5 generations from cand-6: (i) status quo, (ii) shaped fitness only,
  (iii) shaped fitness + residual-seeded mutation. Metric: holdout empty-patch rate + patch-progress
  score. **Expected:** arm (iii) → **0.15–0.20** empty-patch (clears bar); arm (ii) → ~0.25. If (ii)≈(i),
  the bottleneck is mutation targeting, not signal — diagnostic either way.
- **(d) Cost.** ~$600–1,200 (Fable reflection over ~50 residual traces ~$300; 5 generations of
  cheap-executor rollouts + holdout verification ~$500–900).

### Q2 — Capability arbitrage: plan-capsule compilation

- **(a) Mechanism.** MCP-Atlas 75.6% vs RLI 16% says the gap is **not** per-step tool execution — it's
  long-horizon decomposition, mid-flight acceptance judgment, and knowing when a deliverable is done.
  Exploit with **plan capsules**: Fable is invoked **once per task class** to compile a typed execution
  DAG (node = tool-use subtask with input schema, done-predicate, rollback action; edges = data
  dependencies). GLM-tier executes nodes (where it is near-frontier); Fable is invoked only at two
  boundaries — plan-compile (amortized O(1) per class) and terminal acceptance (already the verifier-pack
  product). Store capsules in the host-keyed genome registry keyed by task-class fingerprint. Fable spend
  becomes O(#classes), cheap spend O(#instances).
- **(b) Novelty.** ADR-235/237 store genomes and guidance — standing policies and advice-shaped
  artifacts; ADR-226 proved advice doesn't transfer. A plan capsule is neither: a **typed executable
  artifact with machine-checkable done-predicates per node** — the "executable actions transfer" thesis
  pushed one level up, from action-level to plan-level. Amortized frontier-compiled plans as
  registry-resident capsules are unbuilt.
- **(c) Experiment.** 30 RLI-Mini tasks × 5 task classes. Arms: cheap-only, Fable-only, capsule
  (Fable compiles once/class, GLM executes). Metric: cost-per-accepted-deliverable + acceptance rate.
  **Expected:** capsule arm ≥80% of Fable-only acceptance at **3–5× lower cost**; cheap-only ~2–4× worse
  acceptance. Secondary: capsule reuse rate (acceptances per compile).
- **(d) Cost.** ~$2–4k (5 Fable compiles ~$500; 30×3 executions ~$1.5k cheap + ~$1.5k Fable arm;
  verification via the existing ADR-0025 pipeline).

### Q3 — Best Fable-in-loop use: verifier calibrator (highest lift per dollar)

- **(a) Mechanism.** Fable audits verifier verdicts on **disagreement-sampled** cases (verifier verdict
  vs cheap-executor self-assessment diverge) plus a random control slice, and emits **typed rubric
  patches** (new executable checks, threshold shifts, test-oracle amendments) — not prose advice. Why it
  beats the other three uses: GEPA's sample efficiency is bounded by fitness-signal noise; under noisy
  selection the generations needed to detect a true fitness delta Δ scale ~σ²/Δ². cand-6's failure to
  promote may **partly be measurement noise at the threshold**, not capability shortfall (a true-0.28
  candidate can measure 0.34 with a noisy verifier). Halving verifier error σ cuts required rollouts ~4×,
  and **every future GEPA lineage inherits the benefit**. Calibration improves the *instrument* every
  lineage is measured with, and compounds directly into the ADR-0025 product (the verifier pack **is**
  the deliverable) — so the spend is simultaneously R&D and product hardening.
- **(b) Novelty.** ADR-0025 defines the acceptance gate but treats verifier verdicts as ground truth.
  No ADR closes the loop from frontier-model audit back into verifier rubrics, and none uses
  disagreement sampling to make audit spend **sub-linear** in traffic.
- **(c) Experiment.** Freeze a 400-task replay set with human-adjudicated ground-truth outcomes. Run the
  verifier pack 3× per task; flag disagreement-across-runs or margin-below-threshold verdicts (~15–20%
  of tasks). Fable adjudicates only that slice → typed rubric patches. Re-run patched pack on the same
  frozen set. **Metrics + expected effect:** (1) triple-run verdict flip-rate **12–15% → <5%**;
  (2) Kendall-τ between verifier score and ground truth **+0.10–0.15**; (3) the real payoff — GEPA
  rollouts to statistically separate two candidates at cand-6-scale deltas (Δ≈0.05 acceptance) drops
  from ~2,000 to **~500**.
- **(d) Cost.** ~**$250–400 one-time** (~400 adjudications × ~25k Fable tokens) + ~$30/week ongoing
  disagreement-sampling drip. Cheapest lever in the system because it compounds into every future lineage.
- **Why the other three Fable-in-loop uses rank below** *(Fable):*
  - *Mutation proposer* — improves candidate generation, but selection is currently noise-limited, not
    proposal-limited; better mutations measured with a noisy instrument still get mis-ranked.
  - *Failure-mode taxonomist* — valuable, but pays off only *through* better mutations or rubrics; one
    hop from impact.
  - *Handoff-capsule author* — Q2's plan-capsule work already covers the high-value version; standalone
    capsule authoring without DAG typing is ADR-226's failed "advice transfer" in disguise.

### Q4 — Highest-ROI un-built optimization: trajectory-prefix caching for evolutionary rollouts

- **(a) Mechanism.** GEPA mutations mostly alter *late*-trajectory behavior — early tool calls (repo
  clone, test discovery, file reads) are identical across siblings of a lineage. Content-address
  environment state as `hash(repo-state, tool-outputs, action-sequence)`; each rollout walks the cached
  trajectory tree and **executes only from the first divergent action**. Fork-on-divergence, memoize
  side-effect-free tool results, snapshot-restore sandboxes for stateful ones.
- **(b) Novelty.** This is **not** token/prompt caching (which we have) — it caches *environment
  interaction*, the dominant cost in agentic rollouts (sandbox time, tool latency, executor tokens for
  re-deriving identical context). No ADR touches it because it requires treating rollouts as a **tree**,
  not independent samples — a framing evolutionary loops uniquely enable, since siblings share ancestry
  by construction.
- **(c) Experiment.** Replay one full GEPA generation (8 candidates × 50 tasks) with and without the
  cache. Metrics: cache hit-depth (fraction of trajectory nodes served from cache), wall-clock,
  $/generation. **Expected:** 40–60% cost reduction (siblings typically diverge after 30–50% of the
  trajectory), guarded by a correctness check — verdict agreement between cached and uncached runs must
  be **>99%**, else the state-hashing is leaky.
- **(d) Cost.** ~2 engineer-weeks; validation run ~**$150** GLM inference. Combined with Q3, effective
  cost-per-promotion-decision drops ~6–8× multiplicatively.

### Q5 — Contrarian take: cost-per-accepted-deliverable is the wrong objective

- **The claim (Fable).** "Accepted" is defined by the verifier pack. The verifier pack is **our product**
  *and* **our fitness function**. Optimizing acceptance-per-dollar therefore selects policies for
  **verifier exploitation**, and GEPA is exceptionally good at finding exploits — empty-patch was merely
  the first, crudest one. cand-6's 0.583→0.333 drop may partly reflect discovery of *subtler*
  verifier-satisfying, value-free outputs (trivial patches, test-narrowing edits). We can't tell, because
  **our instrument is our objective — a closed Goodhart loop**.
- **Replacement metric.** cost-per-**durable**-deliverable: acceptance conditioned on **30-day downstream
  survival** — no revert, no human override, no follow-up fix touching the same lines. Measurable from
  HarnessaaS customer telemetry we already collect but don't score against.
- **Observable that would prove Fable right.** A promoted-policy cohort where holdout acceptance **rose**
  while 30-day revert/override rate **also rose**. If those curves diverge, the instrument has decoupled
  from reality and every GEPA generation since has been selecting for the gap.
- **The uncomfortable part (Fable).** HarnessaaS's revenue metric rewards us for *not* looking, because
  durable-deliverable accounting would retroactively reprice accepted work. The Q3 calibrator mitigates
  this **only if calibration targets lagged ground truth, not verifier self-consistency**. "Calibrating
  the instrument to agree with itself is how you polish a broken ruler."

---

## Ranked shortlist — candidate ADRs / experiments to pursue next

1. **Verifier calibrator anchored to lagged ground truth (Q3 × Q5).** Cheapest lever (~$250–400
   one-time), compounds into every future GEPA lineage, and hardens the ADR-0025 product. *Must* be
   anchored to human/telemetry ground truth, not verifier self-consistency (Q5's caveat), or it polishes
   a broken ruler.
2. **cost-per-durable-deliverable metric (Q5).** Reframes the top-level objective using telemetry we
   already collect (30-day revert/override survival). Highest strategic leverage; guards against the
   Goodhart loop that may be silently inflating cand-6-era gains.
3. **Trajectory-prefix caching for evolutionary rollouts (Q4).** 40–60% rollout cost cut, ~2 eng-weeks;
   multiplies with #1 to ~6–8× cheaper promotion decisions. Low risk (guarded by >99% verdict-agreement).
4. **Plan-capsule compilation as registry-resident typed DAGs (Q2).** Structural exploit of the
   GLM-near-frontier / Fable-only-completion gap; extends ADR-226's "executable actions transfer" thesis
   from action-level to plan-level.
5. **Dense fitness shaping + residual-seeded mutation on cand-6 (Q1).** Direct attempt to cross the
   promotion bar; also a clean diagnostic of whether cand-6 is signal-limited or mutation-limited.

**Single highest-ROI pick:** #1 (verifier calibrator), executed **with #2's ground-truth anchor**. The
concrete experiment: freeze a 400-task replay set with human-adjudicated outcomes, triple-run the
verifier pack, Fable adjudicates only the ~15–20% disagreement/near-threshold slice and emits typed
rubric patches, re-run on the frozen set. Success = triple-run flip-rate 12–15% → <5%, Kendall-τ vs
ground truth +0.10–0.15, and GEPA rollouts-to-separate-candidates ~2,000 → ~500. ~$250–400 one-time.

---

## Honest audit: grounded vs speculative

**Grounded (verifiable facts the reasoning rests on):**
- The real numbers: cand-6 0.583→0.333, RLI ~16% (from ~2.5%), MCP-Atlas GLM-5.1 = 75.6%. Supplied from
  our own state / published benchmarks.
- The *structural* arguments are sound and largely analytic, independent of Fable:
  - Noisy selection needs ~σ²/Δ² samples → de-noising the verifier reduces required rollouts (Q3). This
    is standard statistics applied correctly.
  - Evolutionary siblings share trajectory ancestry by construction → prefix caching is feasible (Q4).
  - "Instrument == objective" is a genuine closed loop → Goodhart risk is real, not hypothetical (Q5).
  - ADR-226 (advice doesn't transfer; typed executable actions do) is our own proven result; Q2's
    plan-capsule is a coherent extension of it.

**Speculative (Fable's estimates — treat as hypotheses to test, not results):**
- **All effect sizes**: arm (iii) → 0.15–0.20 (Q1); capsule ≥80% acceptance at 3–5× cheaper (Q2);
  flip-rate <5% / Kendall-τ +0.10–0.15 / 2,000→500 rollouts (Q3); 40–60% rollout cost cut (Q4). These
  are plausible but unmeasured.
- **All dollar costs** are order-of-magnitude guesses.
- **The claim that cand-6's gain is partly verifier exploitation (Q5)** is a *hypothesis*, not evidence.
  It is the most important thing to test precisely because we cannot currently tell — which is itself
  Fable's point. The proposed observable (acceptance↑ while revert-rate↑) is the falsifiable test.
- The "revenue rewards us for not looking" framing (Q5) is a provocation, not an established incentive
  analysis; useful as a risk to surface, not a finding.

**Net:** the *mechanisms* and *the ranking logic* are well-grounded and follow from facts we already
hold; the *magnitudes* are Fable's frontier guesses. Every proposal ships with a falsifiable experiment,
so each can be cheaply screened before committing engineering to it. Recommended first move (~$400) is
the Q3×Q5 verifier-calibrator experiment: it is the cheapest, de-risks the most (it tests the Goodhart
hypothesis directly), and compounds into everything else.

---

*Fable invocation that worked: direct OpenRouter `POST /v1/chat/completions` with
`model=anthropic/claude-fable-5`. The `claude -p` gateway path also works but costs ~6× more per call
here because it loads the full project CLAUDE.md + MCP tool schemas as ~84k cache-creation tokens at
Fable rates. No keys were logged or committed.*
