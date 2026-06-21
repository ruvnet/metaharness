# ADR-165: Darwin Opportunity Scanner — ROI-ranked automation discovery

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-DISCOVERY`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Decide WHERE to point Darwin's evolution budget by ranking candidate automations by ROI, verification strength, and risk before any evolution run starts.
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection), ADR-074 (ruVector memory), ADR-076 (parent-vs-child benchmark), ADR-078 (HGM clade metaproductivity), ADR-079 (SGM statistical gates + risk budget), ADR-082 (expected gains + effective-performance), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-156 (umbrella — "mutate structured policies, not prompts"), ADR-158 (trace/cost ledger), ADR-161 (cost memory), ADR-166 (human review gates — consumes the same risk score)

> We borrow the **CrewAI Discovery** pattern — surface automation opportunities ranked by *effort, value, and readiness* inferred from observed agent-run behaviour — and copy the pattern, not the product. CrewAI Discovery is a workflow-mining feature of a commercial orchestrator; we reuse only its idea that the highest-leverage move is choosing *which* workflow to automate before spending compute on it. Grafted onto Darwin Mode, this becomes a pre-flight scanner that ranks tasks so the evolution loop spends its frozen-scorer budget where model spend is high and verification is strong. The thesis is unchanged: **the foundation model stays frozen; the harness evolves; the proof is in replay** — and **Darwin Mode mutates structured policies, not prompts.** The Opportunity Scanner does not mutate anything; it produces a ranked, structured target list that the existing `evolve` / `real-evolve` loop consumes.

## Context

Darwin Mode (ADR-070) and Darwin Shield (ADR-155) can evolve a harness against any task that exposes a frozen, replayable scorer. That is also the trap: the loop will happily burn generations improving a task that was cheap to begin with, or one whose "improvement" cannot be verified. Two facts from the existing code make this concrete:

1. **Verification strength is not uniform.** `packages/darwin-mode/src/security/semgrep-oracle.ts` and `fuzz-oracle.ts` give *strong, replayable* verdicts — a finding either reproduces under a test/fuzzer or it does not (`Finding.verdict: 'confirmed' | 'false_positive' | 'needs_review'`, `RunMetrics.reproduced`). A task backed by those oracles has high testability; a task whose only signal is a model's self-report has low testability and is a poor place to spend evolution budget, because the frozen scorer (`scoring.ts::fitness`) has nothing trustworthy to fold in.
2. **Cost is observable.** `RunMetrics.costUnits` and the deterministic `costOf(genome)` proxy in `swarm.ts`, plus the trace/cost ledger (ADR-158) and cost memory (ADR-161), already record what each run actually spent. We can therefore estimate where model spend is *high* — which is exactly where automation ROI is highest.

What is missing is the step *before* evolution: a ranking that says "evolve THIS workflow, not that one." Today that choice is implicit and manual. The acceptance bar for enterprise proof — "show me the ten things worth automating, with money and risk attached" — cannot be met by a loop that has no notion of opportunity.

This ADR proposes the **Darwin Opportunity Scanner**: a deterministic pass over a repo's workflows and historical run traces that emits an ROI-ranked, fully-attributed target list. It is the dispatcher for Darwin's evolution budget.

## Decision

Add a **proposed** module `packages/darwin-mode/src/security/opportunity.ts` (name proposed; sits beside `bench.ts` / `ablation.ts`). It defines one structured score per candidate and one frozen, deterministic ranking function. No prompts, no model calls in the ranker itself — it reads structured signals (the same discipline as ADR-156).

```ts
/** A class of automatable work observed across agent runs / the repo. */
export type TaskClass =
  | 'security-scan'      // backed by semgrep/fuzz oracles — strong verification
  | 'test-repair'        // backed by the repo test command — strong verification
  | 'patch-write'        // backed by patch-passes-test (RunMetrics.patchesPassing)
  | 'review'             // adversarial reviewer agent — medium verification
  | 'doc-write'          // disclosure-writer style output — weak verification
  | 'triage';            // routing / classification — weak verification

/** Verification methods, ranked by how replayable/strong they are. */
export type VerificationMethod =
  | 'oracle-reproduced'  // semgrep-oracle.ts / fuzz-oracle.ts confirmed + reproduced
  | 'test-suite'         // repo test command (deterministic pass/fail)
  | 'static-agreement'   // >=2 static tools agree (RunMetrics.toolAgreements)
  | 'human-review'       // routed to a human gate (ADR-166)
  | 'self-report';       // model assertion only — weakest, discounts the score

/**
 * One ranked automation opportunity. Every field is structured and bounded so
 * the ranking is reproducible (ADR-156: structured policies, not prompts).
 * All [0,1] terms are higher-is-better EXCEPT failureRisk and modelComplexity.
 */
export interface OpportunityScore {
  id: string;
  taskClass: TaskClass;
  /** How valuable automating this is (frequency x manual effort displaced). 0..1. */
  automationValue: number;
  /** Strength of available verification. 0..1 (oracle-backed -> high). */
  testability: number;
  /** Fraction of current model spend this could remove. 0..1. */
  costSavingPotential: number;
  /** Probability an automated run does the wrong thing undetected. 0..1. */
  failureRisk: number;
  /** How hard the task is for the frozen model (drives spend + risk). 0..1. */
  modelComplexity: number;
  // ---- the four acceptance-required, money/method/risk fields ----
  /** Estimated current monthly model spend on this task, in cost units (ADR-158/161). */
  estimatedMonthlyCost: number;
  /** Expected monthly saving if automated, in the same units. <= estimatedMonthlyCost. */
  expectedSaving: number;
  /** How an automated result is verified (drives testability + ADR-166 routing). */
  verificationMethod: VerificationMethod;
  /** Composite risk in 0..1 (failureRisk weighted up by low verification). */
  riskScore: number;
  /** The derived rank key (higher = evolve sooner). Set by rankOpportunities. */
  roi: number;
}

export interface ScannerInputs {
  /** Candidate tasks distilled from repo workflows + historical traces. */
  candidates: Omit<OpportunityScore, 'roi'>[];
  /** Cost-ledger / cost-memory lookups already populated (ADR-158/161). */
  costLedgerVersion: string;
}

/**
 * FROZEN, deterministic ROI ranking. Pure function of its inputs (no I/O, no
 * clock, no model) so the same candidates always produce the same order — the
 * ranking-determinism test depends on this. ROI rewards value, verification, and
 * savings; it penalizes risk and complexity. Verification strength is the gate:
 * a high-value task with self-report-only verification is deliberately demoted,
 * because Darwin's frozen scorer (ADR-072) cannot trust an unverifiable signal.
 */
export function rankOpportunities(inputs: ScannerInputs): OpportunityScore[] {
  const scored = inputs.candidates.map((c): OpportunityScore => {
    const verifFloor = VERIFICATION_WEIGHT[c.verificationMethod]; // 1.0 oracle .. 0.2 self-report
    const roi = round6(
      0.30 * c.automationValue +
        0.25 * c.costSavingPotential +
        0.20 * c.testability * verifFloor +
        0.15 * (1 - c.failureRisk) +
        0.10 * (1 - c.modelComplexity) -
        0.20 * c.riskScore,
    );
    return { ...c, roi };
  });
  // Deterministic total order: ROI desc, then id asc as a stable tie-break.
  return scored.sort((a, b) => (b.roi - a.roi) || (a.id < b.id ? -1 : 1));
}

/** Verification-method multiplier: replayable oracles count, self-report barely does. */
export const VERIFICATION_WEIGHT: Record<VerificationMethod, number> = {
  'oracle-reproduced': 1.0,
  'test-suite': 0.9,
  'static-agreement': 0.7,
  'human-review': 0.6,
  'self-report': 0.2,
};
```

The scanner's output (top-N `OpportunityScore[]`) is the input to `evolve` / `real-evolve.ts`: Darwin spends generations on the highest-ROI, strongly-verified targets first. The four acceptance-required fields (`estimatedMonthlyCost`, `expectedSaving`, `verificationMethod`, `riskScore`) are carried verbatim into the enterprise-facing report, so "the top-10 recommended automations each include estimated monthly cost, expected saving, verification method, and risk score" is satisfied structurally by the type, not by prose.

Grounding the terms in real signals:

- **testability ← oracles.** `oracle-reproduced` maps to `semgrep-oracle.ts` + `fuzz-oracle.ts` (`Finding.verdict === 'confirmed'`, `RunMetrics.reproduced > 0`). These are replayable, so they dominate the verification weight. This is the literal expression of "pick workflows where verification is strong."
- **estimatedMonthlyCost / costSavingPotential ← cost ledger.** Read from the trace/cost ledger (ADR-158) and cost memory (ADR-161), aggregated from `RunMetrics.costUnits` / `costOf(genome)`. "Don't optimize low-value tasks first" becomes: low `estimatedMonthlyCost` ⇒ low ROI.
- **riskScore ← failureRisk × inverse verification.** A high-complexity task with weak verification carries the most risk; this same `riskScore` is what ADR-166 reads to decide whether a human gate is required.

Expected impact (HYPOTHESES, not commitments): higher ROI per benchmark run because budget lands on high-spend, strongly-verified workflows; faster enterprise sales proof because every recommendation ships with money and risk attached. These are to be validated by the bench harness (`bench.ts`), not assumed.

## Consequences

**What changes.** Choosing the evolution target becomes an explicit, auditable, reproducible step. The output is a structured artifact (`OpportunityScore[]`), so it can be diffed, replayed, and pasted into a sales/ops deck. Darwin's budget is steered toward high-spend, high-verification work instead of whatever task happened to be wired up.

**What does not change.** The foundation model stays frozen. The mutation surfaces (ADR-071), the frozen scorer and promotion gate (ADR-072), and the archive/selection (ADR-073) are untouched — the scanner runs *before* them and feeds them a target, nothing more. The scanner mutates no policy and emits no prompt; it ranks structured candidates (ADR-156). Replay remains the proof: the ranker is pure, so a recorded `ScannerInputs` reproduces the exact ranking.

**What hurts.** The scanner is only as honest as its inputs. `estimatedMonthlyCost` / `expectedSaving` depend on the cost ledger (ADR-158) and cost memory (ADR-161) being populated and trustworthy; a cold repo with no history yields low-confidence estimates. `automationValue` and `modelComplexity` for never-run tasks must be *estimated* (heuristic priors), and a bad prior will mis-rank. Verification weighting is opinionated by design — it will rank a flashy, high-value, unverifiable task *below* a humble, oracle-backed one, which can be counter-intuitive to stakeholders until the rationale (the frozen scorer cannot trust self-report) is explained.

## Alternatives Considered

1. **No scanner — manual target selection (status quo).** Rejected: not reproducible, not auditable, and prone to optimizing cheap tasks. It cannot meet the "top-10 with money and risk" acceptance bar.
2. **Rank by raw model spend only.** Rejected: spend without verification strength steers budget into tasks Darwin's frozen scorer cannot grade, wasting generations on unverifiable "wins." Verification must be a first-class term.
3. **LLM-judged opportunity ranking (a model scores each candidate).** Rejected: violates ADR-156 ("structured policies, not prompts") and makes the ranking non-reproducible. The ranker stays a pure function; a model may *propose* candidates upstream, but it does not set the order.
4. **Fold opportunity scoring into the fitness function (`scoring.ts`).** Rejected: `fitness()` is a *frozen per-genome* score (ADR-072); opportunity ranking is a *cross-task* dispatch decision. Conflating them would let target selection leak into the promotion gate.

## Test Contract

Operationalizes the acceptance test ("the top-10 recommended automations must each include estimated monthly cost, expected saving, verification method, and risk score") and the ranking guarantee.

- **`opportunity.topTenCompleteness`** — Run `rankOpportunities` over a corpus of >=10 candidates; take the top 10 by `roi`. Assert every entry carries a finite `estimatedMonthlyCost >= 0`, an `expectedSaving` with `0 <= expectedSaving <= estimatedMonthlyCost`, a `verificationMethod` in the allowed union, and a `riskScore` in `[0,1]`. No field may be `undefined`/`NaN`. (Directly the acceptance test.)
- **`opportunity.rankingDeterminism`** — Call `rankOpportunities` twice on identical `ScannerInputs` (and once on a shuffled copy of `candidates`); assert byte-identical ordering of returned ids both times. Locks in the pure-function / stable-tie-break guarantee.
- **`opportunity.verificationDominates`** — Two candidates with identical `automationValue` and `costSavingPotential` but `verificationMethod` `'oracle-reproduced'` vs `'self-report'`: assert the oracle-backed one ranks strictly higher. Encodes "pick workflows where verification is strong."
- **`opportunity.lowValueNotFirst`** — A high-`automationValue` but low-`estimatedMonthlyCost` candidate must not outrank a high-spend, equally-verifiable candidate. Encodes "don't optimize low-value tasks first."
- **`opportunity.boundsAndClamps`** — Property test: for any candidates with terms in `[0,1]`, every emitted `roi` is finite and `riskScore` stays in `[0,1]`; out-of-range inputs are clamped, never propagated.

## Reference implementation

A dependency-free, deterministic reference of this ADR lives in `@metaharness/projects` (committed this session): `packages/projects/src/opportunity.ts` (with its test and `bench/opportunity.bench.mjs`). It implements `OpportunityScore` and `rankOpportunities`, where ROI is the expected saving discounted by risk. The package as a whole has 117 passing tests. The synthetic bench is a deterministic simulation; its receipt (`packages/projects/bench/results/opportunity.json`) shows a deterministic ROI ranking in which every top item carries an estimated monthly cost, an expected saving, a verification method, and a risk score.

## References

- CrewAI Discovery — automation-opportunity identification ranked by effort/value/readiness from observed runs (borrowed pattern; product not used). https://docs.crewai.com/
- ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection).
- ADR-074 (ruVector memory), ADR-078 (HGM clade metaproductivity), ADR-079 (SGM statistical gates + risk budget), ADR-082 (expected gains + effective-performance).
- ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield — `HarnessGenome`, `Finding`, `RunMetrics`, oracles), ADR-156 (umbrella — mutate structured policies, not prompts).
- ADR-158 (trace/cost ledger), ADR-161 (cost memory) — sources for `estimatedMonthlyCost` / `expectedSaving`.
- ADR-166 (human review gates) — consumes `riskScore` to route the uncertain edge.
- Real modules: `packages/darwin-mode/src/security/{scoring.ts, swarm.ts, semgrep-oracle.ts, fuzz-oracle.ts, types.ts, bench.ts, ablation.ts, real-evolve.ts}`.
