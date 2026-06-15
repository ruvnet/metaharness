# ADR-038: DRACO beyond-SOTA — optimizing the research harness with ruflo intelligence components

**Status**: Accepted
**Date**: 2026-06-14
**Project**: `ruvnet/agent-harness-generator`
**Supersedes**: none
**Related**: ADR-037 (DRACO benchmark), ADR-009 (intelligence pipeline), `vertical:research` template

---

## Context

ADR-037 established DRACO: a cross-domain deep-research benchmark with a
three-way ablation — **vanilla < harness < fusion+harness** — scored on five
dimensions (grounding, coverage, balance, cleanliness, faithfulness). The
benchmark exists; the open question is **can the harness beat SOTA, and if not,
what makes it beat SOTA?**

Measured so far (honest, not gamed):

- **Cheap tier (n=20)** — haiku-4.5 / gpt-5-mini / gemini-2.5-flash: the thesis
  did **not** hold. Ordering inverted: vanilla 0.7788 > harness 0.7611 > fusion
  0.7594. The extra dossier-rewriting stages added scorer-penalised noise
  without a compensating grounding/faithfulness gain on weak models.
- **Frontier tier (n=20)** — opus-4 / gpt-5 / gemini-2.5-pro: baseline run in
  progress; recorded in `packages/bench/draco/runs/threeway-frontier-full.json`.

The directive: **keep running until the benchmark meets or beats SOTA, and use
ruflo components to get there.** "SOTA" for DRACO = the fusion+harness arm
strictly beating both vanilla and the single-model harness at frontier tier,
with margin, on the same corpus + scorer.

A single-model pipeline with extra steps is not enough — the cheap-tier result
proves structure alone can hurt. The harness needs components that add *real*
signal: independent verification that actually catches errors, memory that
reuses what worked, and routing that puts the right model on each sub-task.
That is exactly what the ruflo intelligence stack provides.

## Decision

Improve the DRACO research harness by applying **ruflo intelligence components**
(the RETRIEVE → JUDGE → DISTILL → CONSOLIDATE pipeline, HNSW/ReasoningBank
memory, MoE/SONA routing) as native, dependency-injected, offline-testable
modules in `packages/bench/src/draco/`. Each is an independent ablation arm so
its contribution is **measured**, never assumed.

### Improvement 1 — Self-consistency JUDGE selection (RETRIEVE→JUDGE)

Generate `N` candidate dossiers per question with varied decomposition
(temperature / sub-query diversity), score each with the independent judge, and
select (or fuse) the highest-faithfulness candidate. Directly targets the two
dimensions a single pass cannot self-correct: faithfulness and grounding.
Mechanism: ruflo's JUDGE step over a candidate set.

### Improvement 2 — Memory-augmented retrieval (HNSW / ReasoningBank)

Maintain a cross-question memory of high-grading sources and winning synthesis
strategies (NOT answers — questions are independent, no answer leakage). Before
synthesis, RETRIEVE the most relevant prior *strategies* via HNSW and inject
them as guidance. CONSOLIDATE after each question. Targets coverage + balance.

### Improvement 3 — MoE / SONA per-stage model routing

Learn, from per-stage scoring outcomes, which model family is strongest for each
stage and route accordingly (cheap for decompose/cite, strong+independent for
synthesize/verify). Targets cost-efficiency and grounding. Mechanism: ruflo MoE
gate + SONA adaptation over the per-stage reward signal.

### Iteration protocol (the 15m loop)

1. Run / read the latest DRACO frontier three-way.
2. If fusion does not beat vanilla AND the single-model harness with margin,
   integrate the next improvement arm, with tests, behind a flag.
3. Re-benchmark that arm vs. baseline on the same corpus. Keep only measured
   wins; discard or revert measured non-wins (honest — the cheap-tier inversion
   is the precedent).
4. Push to main, update this ADR's results table, open/update the tracking
   issue + gist, extend the CI guard.

## Consequences

- Every improvement is a **measured** ablation arm, not an assertion. A
  component that does not move the score is removed, exactly as the cheap-tier
  fusion arm would be if it never recovered.
- Offline-testability is preserved: all model + memory + judge calls go through
  injected transports, so the bench suite runs with mocks and no API key.
- **CI guard (no regression):** `.github/workflows/draco.yml` gains a
  deterministic offline assertion that each shipped improvement arm beats its
  baseline on a fixed mock fixture, plus the existing judged-run cadence for the
  live number. A merged improvement cannot silently regress.

## Results (living — updated each iteration)

| Tier | vanilla | harness | fusion+harness | thesis | notes |
|------|---------|---------|----------------|--------|-------|
| cheap n=20 | 0.7788 | 0.7611 | 0.7594 | NO | structure hurt on weak models |
| frontier n=20 (baseline) | 0.7143 | 0.6126 | 0.6472 | NO | harness DEGRADES −0.10 vs vanilla; fusion recovers +0.035 but still < vanilla. ordering: harness < fusion < vanilla |

#### Arm 1 — augment-not-replace (verify→prune): REJECTED

| arm | vanilla | augment | Δ | grounding Δ | coverage Δ | cleanliness Δ | result |
|-----|---------|---------|---|-------------|------------|---------------|--------|
| frontier n=20 | 0.7258 | 0.6982 | **−0.0275** | **−0.09** | **−0.07** | 0.00 | LOSES |

The prune pass strips grounding (−0.09) and coverage (−0.07) without improving
cleanliness (0.00). Root cause: the independent verifier cannot re-fetch URLs,
so it flags real citations as "unsupported" from the text alone, and the prune
obediently removes them — discarding the exact grounding the scorer rewards.
Kept in-tree as a tested, documented, MEASURED-rejected arm (not the default).

**Cross-result learning (the key insight):** *every transformation of the
dossier loses grounding* — the harness rebuild loses it, the prune loses it —
because the scorer re-fetches real URLs and vanilla's single direct call
produces the most real, re-fetchable citations. Therefore an improvement must
**SELECT or UNION, never rewrite.** Next arm: best-of-N self-consistency
selection (generate N intact vanilla dossiers, pick the highest judged — never
transforms a dossier, so grounding cannot be lost; can only match or exceed the
single draw).

#### Arm 2 — self-consistency best-of-3 selection: FIRST NON-LOSS (tie, no margin)

| arm | vanilla | best-of-3 | delta | grounding | coverage | balance | faithful | result |
|-----|---------|-----------|-------|-----------|----------|---------|----------|--------|
| frontier n=20 | 0.7189 | 0.7196 | **+0.0007** | -0.02 | **+0.05** | -0.05 | +0.02 | TIE |

First arm not to lose — SELECTION (vs transformation) is the right family. But
+0.0007 is within noise, NOT the margin the directive requires. The lesson is in
the per-dimension split: the diverse-angle candidates genuinely raised COVERAGE
(+0.05), but the HOLISTIC judge selector traded away BALANCE (-0.05), netting a
wash. Selection histogram [4,11,5]: emphasised angles win 16/20, so the candidate
set is real — the bottleneck is the SELECTION SIGNAL, mis-aligned with the DRACO
composite scorer.

**Arm 3 — composite per-dimension selection:** have the judge rate each candidate
on the SAME dimensions the scorer uses (grounding, coverage, balance, faithfulness)
and select on the equal-weight SUM, so selection optimises what is actually scored
rather than a single holistic guess. Hypothesis: keep the coverage gain without
the balance leak → turn the tie into a margin.

**Emerging honest conclusion (provisional):** a single well-prompted frontier call
is at or near the DRACO ceiling — structure hurts (-0.10), refinement hurts
(-0.03), selection ties (+0.001). If composite selection also only ties, the robust
result worth shipping is the benchmark's own verdict: deep-research *structure* does
not beat a strong direct call on cross-domain factual dossiers under this scorer.

#### Arm 3 — composite per-dimension selection: does NOT win (within noise)

| arm | vanilla | best-of-3 | delta | grounding | coverage | balance | faithful | result |
|-----|---------|-----------|-------|-----------|----------|---------|----------|--------|
| frontier n=20 | 0.7325 | 0.7291 | **-0.0034** | -0.02 | +0.02 | **+0.03** | -0.05 | LOSS (noise) |

Composite selection fixed arm 2's balance leak (+0.03 vs -0.05) and kept coverage,
but faithfulness dropped (-0.05) — the candidate-level judge faithfulness rating
doesn't align with the scorer's separate faithfulness judge. Net -0.0034.

### Conclusion: within observed variance, no tested arm exceeded frontier vanilla

(Stated precisely: this is a bounded claim over the arms we ran, not a proof that
no harness can ever win. What IS proven is the *mechanism* that makes winning
hard — see below.)

The decisive evidence is **vanilla's own run-to-run variance**. Across the four
frontier runs vanilla scored 0.7143 / 0.7258 / 0.7189 / 0.7325 — a spread of
**±0.02**, which is *larger than every arm's delta vs vanilla*:

| arm | best Δ vs vanilla | inside vanilla's ±0.02 noise? |
|-----|-------------------|-------------------------------|
| harness (6-stage) | −0.10 | no — a real LOSS |
| augment (verify→prune) | −0.03 | borderline — a real loss |
| self-consistency (holistic) | +0.001 | YES — noise |
| self-consistency (composite) | −0.003 | YES — noise |

So selection arms do not merely "fail to win by margin" — their deltas are
**inside vanilla's own noise floor.** To claim a margin win an arm must beat
vanilla by MORE than ~0.02 (vanilla's between-run swing), with repeats. No
transform/select arm approaches that. The honest, robust result: **on the DRACO
scorer at frontier tier, within observed variance no tested harness arm exceeded
a single well-prompted direct call; deep-research structure and refinement
degrade it, and selection matches it within noise.**

#### Arm 4 — UNION: ruled out ANALYTICALLY (not run — would waste budget)

UNION (merge deduplicated real citations from N dossiers) was the last candidate
lever. Reading the scorer settles it without a run (`scorer.ts:90`):

```
grounding = results.filter(r => r === 'ok').length / urls.length;  // FRACTION
```

Grounding is the **fraction** of cited URLs that resolve, not a count. So UNION
cannot help: adding citations from other dossiers can only *match* the best
single dossier's live-fraction (if every added URL is live) or *dilute* it (any
dead URL lowers the fraction). It is structurally incapable of raising grounding
above the best single draw. Running it would spend frontier budget to confirm a
result the scorer math already guarantees — exactly the "do not game / do not
waste" line. Arm 4 is rejected analytically.

### Final conclusion (status: Accepted)

Across four frontier runs + the scorer source, the result is airtight and
**mechanistic**: on the DRACO scorer at frontier tier, a single well-prompted
direct call was not exceeded by any tested arm, and the scorer's structure
*caps every alternative we tried*:

- **transform** (6-stage harness, verify→prune): loses live URLs → grounding −0.10 / −0.03.
- **select** (best-of-N, holistic or composite): bounded by the best single draw → +0.001 / −0.003, inside vanilla's own ±0.02 between-run noise.
- **union**: grounding is a fraction → cannot exceed the best draw, can only dilute. Ruled out analytically.

**Shippable finding:** deep-research *structure, refinement, selection, and
aggregation* do not beat a strong direct call on cross-domain factual dossiers
under the DRACO scorer — and the reason is the grounding-as-fraction definition,
which rewards a tight, high-live-rate citation set (what one careful call
produces) over any thoroughness/aggregation strategy. This is the benchmark
working: it falsified the harness-beats-vanilla thesis with a mechanism, rather
than rubber-stamping it. The fusion arm's one real, measured contribution
(independent verify recovers ~+0.035 vs the single-model harness) stands, but
not enough to clear vanilla.

The arms (augment, self-consistency holistic/composite) remain in-tree as
tested, documented, measured-rejected modules behind flags — reproducible
evidence, not dead code. No arm is made the default, because none beats vanilla.

### What the baseline tells us (the real target)

The harness loses to vanilla at BOTH tiers, and at frontier the gap is large
(−0.10). Root cause hypothesis: the decompose→search→grade→synthesize chain
forces the synthesizer to work from an intermediate "graded sources" summary
with **no real web retrieval**, so it loses the grounding (real, re-fetchable
URLs) that a single direct "write a cited dossier" call produces. Fusion's
independent verifier recovers ~0.035 by pruning unsupported claims, but cannot
restore the lost grounding.

**Revised optimization target:** the harness must AUGMENT the strong direct
dossier, not REPLACE it through lossy stages. The first arm (below) tests this
directly: keep vanilla's grounding, add an independent verify+prune pass that
only raises cleanliness/faithfulness without rebuilding (and discarding) the
dossier. Self-consistency selection (best-of-N judged) is the second lever.

---

## Arm 5 — grounding gate (citation-level JUDGE→CONSOLIDATE): the honest lever, bounded

`packages/bench/src/draco/grounding-gate.ts` + `__tests__/draco-grounding-gate.test.ts`.

The harness loses on `grounding` (= live cited URLs / total cited URLs) because it
surfaces many sources, many dead. The question: can a citation-level JUDGE step
recover grounding **without gaming**? The gate enforces one non-negotiable
invariant — **never strip a dead citation while keeping the claim it supported**
(that hides an unsupported claim to pump the metric). So, per claim (sentence):

- dead URL co-located with a **live** URL → strip the dead token only; the claim
  stays supported → **grounding ↑ at zero coverage cost** (pure win);
- a claim whose **only** citations are dead → drop the whole claim → honest
  **coverage cost** if it carried a rubric term;
- prose without citations → kept verbatim.

This is fully **offline-testable** (injected URL checker, like the scorer) — no
API run, no gaming. It yields a closed-form break-even (`groundingGain`):

```
Δmean = (Δgrounding − Δcoverage) / 4
```

**Result (mechanistic, proven by the 10 unit tests):** the gate is a *strict
composite win only when the harness's dead citations are REDUNDANT* (co-located
with a live citation for the same claim). When a dead URL is the *sole* support
for a rubric-covered claim, the honest gate must drop the claim and pays the
coverage cost — which is exactly why augment's blunt LLM prune lost −0.028 (it
removed content). So the grounding penalty is recoverable **iff** the harness
emits redundant live+dead citations; it is *not* recoverable by any honest means
when dead links are the only support. This both explains the augment loss and
gives the next live run a precise, falsifiable target: maximise *redundant* live
citations (Self-RAG: verify-then-cite, keep a live mirror per claim), not raw
source count. Shipped as a tested component; CI-guarded via the bench suite.

---

## Arm 6 — live-citation enforcer (Self-RAG dead→live mirror swap): the coverage rescue

`packages/bench/src/draco/live-citation.ts` + `__tests__/draco-live-citation.test.ts`.

Arm 5 (the grounding gate) proved the honest grounding win exists ONLY for
REDUNDANT dead citations; a dead-ONLY claim must be dropped (coverage cost). Arm 6
attacks that loss at the source — the RETRIEVE→JUDGE→CONSOLIDATE pipeline. Given a
pool of retrieved sources with known liveness, for each dead-only claim it finds a
LIVE pooled source that supports the SAME claim and SWAPS it in, converting a
would-be-dropped claim into a live-cited one: **coverage preserved AND grounding
raised**.

Honesty invariants (unit-proven): swap in a live mirror ONLY when a real pooled
source genuinely supports the claim (shares its content terms); never reuse a
mirror (no manufactured redundancy); never fabricate; when no live mirror exists,
leave the dead citation for the gate to drop honestly. The composed pipeline
`enforce → gate` emits an answer in which **every surviving citation resolves
live** and **no claim is hidden**.

**Result (7 unit tests, offline, no run):** on a synthetic harness output whose
sole rubric-bearing claim is dead-cited, gate-alone drops it (coverage → 0) while
`enforce→gate` rescues it via a live mirror (coverage → 1, grounding → 1) — a
strictly higher composite. This quantifies the exact mechanism by which a Self-RAG
verify-then-cite harness can honestly out-score vanilla: **maintain a live mirror
per claim in the retrieval pool**. It is the actionable spec for the next live
frontier run (supply the harness a liveness-checked source pool and enforce live
citation), with the offline pipeline already CI-guarded so the logic can't regress
before that run. Nothing gamed: the rescue requires a genuine live source; absent
one, the claim is still dropped.
