# ADR-162: DarwinBench Dataset Registry — curated, held-out, adversarial

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-BENCH`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: A provenance-tracked dataset registry with four splits and a pluggable evaluator registry, so a champion must beat baseline on train, held-out, regression, and adversarial splits before promotion.
**Related**: ADR-076 (parent-vs-child benchmark), ADR-079 (SGM statistical gates + risk budget), ADR-073 (archive + selection), ADR-072 (frozen scorer/promotion), ADR-077 (DGM), ADR-078 (HGM clade metaproductivity), ADR-082 (expected gains + effective-performance), ADR-155 (Darwin Shield), ADR-156 (umbrella — "mutate structured policies, not prompts")

> We borrow the **LangSmith evaluation workflow** — datasets, evaluators, experiments, and pairwise comparison, with examples sourced from curated cases, historical traces, synthetic data, and human review, graded by code rules, LLM judges, and pairwise comparison — and we copy the *pattern*, not the product. LangSmith proves that trustworthy self-improvement needs *governed datasets* and *pluggable evaluators*, not one in-repo toy corpus. Darwin Mode already has a deterministic benchmark corpus and a seeded bootstrap promotion gate; this ADR puts a provenance-tracked, four-split registry under them so a "winner" must win on data it has never optimized against. The thesis holds: **the foundation model stays frozen; the harness evolves; the proof is in replay**, and **Darwin Mode mutates structured policies, not prompts** — the registry is what makes "the proof is in replay" honest, by certifying the proof on held-out and adversarial data.

## Context

Darwin Mode evolves harness genomes and promotes a champion only when it is *statistically* superior. The promotion machinery is real and conservative: `decidePromotion` (`stats.ts`) runs a seeded, paired, per-repo bootstrap (`bootstrapDelta`, 5000 samples, mulberry32) and admits a child only when the lower-95% bound on the per-repo score delta is above zero **and** there is no unsafe-output regression. Ablation (`ablation.ts`) and the parent-vs-child benchmark (ADR-076) further guard against over-attribution.

The remaining weakness is the *data*, not the statistics. Today the substrate is `defaultCorpus()` in `corpus.ts`: five repos, mixed languages, three `kind`s — `seeded`, `real-cve`, `clean` — self-contained and deterministic so the pipeline runs in a sealed runner with no Docker/Semgrep/live repos. That is the right *starting point* and exactly why it is safe to run anywhere. But it is small and partly synthetic. A `kind: 'real-cve'` repo such as `corpus/py/data-pipe` is CVE-*like*, not a registry of real CVEs; the broader **real-CVE-corpus gap** (and any `cwe-bench`-style seed) remains open. A champion that wins on a tiny seeded corpus may be overfitting to toy tasks — a false winner the bootstrap cannot catch, because the bootstrap certifies generalization *across the repos it is given*, not across *data the champion never saw*.

The fix is the missing axis: split data into **train / held-out / regression / adversarial**, track **provenance** on every example, and require a champion to win on *all four* splits. Held-out catches overfitting; regression catches "fixed the new bug, broke the old one"; adversarial catches a harness that learned to game decoys. This is precisely the LangSmith discipline of curated datasets + multiple evaluators, applied to Darwin Mode's promotion gate.

**Expected impact (HYPOTHESIS to validate): 10–25% better solve-rate stability, lower risk of false winners, and a stronger public benchmark story.** These are hypotheses. The acceptance test makes them falsifiable: a winning variant must win on training tasks AND held-out tasks AND regression tasks AND adversarial tasks — a single split it cannot beat blocks promotion.

## Decision

Add a `Dataset` registry that wraps existing `Corpus`/`CorpusRepo`/`CorpusSite` shapes (no fork of `corpus.ts`), tags every example with a split and provenance, and a pluggable evaluator registry.

```typescript
// PROPOSED: packages/darwin-mode/src/security/datasets.ts

export type DatasetSplit = 'train' | 'heldout' | 'regression' | 'adversarial';

/** Where an example came from — required on EVERY example. */
export type ExampleSource =
  | 'github-issue'
  | 'ci-log'
  | 'accepted-pr'
  | 'advisory'
  | 'docs-drift'
  | 'agent-trace';

/** Provenance for one corpus site/example. Completeness is enforced. */
export interface Provenance {
  readonly source: ExampleSource;
  readonly ref: string;        // issue #, PR url, CVE/advisory id, trace id, ...
  readonly capturedAt: string; // ISO timestamp
}

/** A registry example = an existing CorpusSite + its split + provenance. */
export interface DatasetExample {
  readonly site: CorpusSite;   // reuse the real shape from corpus.ts
  readonly repo: string;
  readonly commit: string;
  readonly split: DatasetSplit;
  readonly provenance: Provenance;
}

export interface Dataset {
  readonly id: string;
  readonly version: string;
  readonly examples: readonly DatasetExample[];
}
```

The evaluator registry mirrors LangSmith's evaluator kinds, all deterministic where possible so promotion stays replayable:

```typescript
// PROPOSED: pluggable evaluators over a genome's run on a split.
export type EvaluatorKind = 'code-rule' | 'llm-judge' | 'pairwise';

export interface Evaluator {
  readonly id: string;
  readonly kind: EvaluatorKind;
  /** Score a genome's findings on one split's examples (0..1, deterministic for code-rule). */
  evaluate(genome: HarnessGenome, examples: readonly DatasetExample[]): EvaluationResult;
}

export interface EvaluationResult {
  readonly score: number;          // folds into the same frozen fitness() scale
  readonly perSplit: Record<DatasetSplit, number>;
  readonly notes: string[];
}
```

The promotion gate gains a four-split wrapper over the existing bootstrap. It does **not** replace `decidePromotion`; it calls it once per split and ANDs the verdicts:

```typescript
// PROPOSED: four-split promotion gate over the existing stats.ts bootstrap.
export interface SplitGateResult {
  readonly promote: boolean;                       // AND across all four splits
  readonly bySplit: Record<DatasetSplit, PromotionDecision>; // PromotionDecision from stats.ts
  readonly blockedBy: DatasetSplit[];
}

export function decidePromotionAcrossSplits(
  prevGenome: HarnessGenome,
  newGenome: HarnessGenome,
  dataset: Dataset,
  baselineFalsePositiveRate: number,
  opts?: { samples?: number; seed?: number; minDelta?: number },
): SplitGateResult;
```

For each split we project the `Dataset` back into a `Corpus` (group examples by `repo`/`commit` into `CorpusRepo`s) and reuse `decidePromotion`, so every split is certified by the same seeded, paired, per-repo `bootstrapDelta` already in `stats.ts`. Promotion requires `promote === true` on **all four** splits and zero unsafe-output regression on each. This directly hardens the false-winner problem that `stats.ts` and `ablation.ts` already attack: the bootstrap proves "not one lucky repo"; the four-split gate proves "not one lucky *dataset*."

Provenance is mandatory: the registry constructor rejects any `DatasetExample` missing `source` or `split`. Real-data ingestion (GitHub issues, failed CI logs, accepted PRs, security advisories, docs drift, historical agent traces) populates the splits over time; `defaultCorpus()` is registered as the seed `train` split so nothing regresses on day one, and the real-CVE corpus closes the documented gap.

## Consequences

**What changes.**
- Promotion is gated on four splits, not one corpus. A champion must generalize (held-out), not regress (regression), and not be gameable (adversarial) before it is admitted.
- Every example carries provenance, making the benchmark auditable and the public benchmark story defensible.
- The corpus grows from real sources (issues, CI logs, PRs, advisories, traces) instead of staying hand-seeded.

**What does not change.**
- The frozen scorer (`fitness()`, `findingScore()`, `COST_BUDGET`, `TIME_BUDGET`) and the seeded paired bootstrap (`bootstrapDelta`, `decidePromotion`) are reused verbatim — the new gate composes them, it does not re-grade.
- The foundation model stays frozen; only the harness evolves. Datasets and evaluators are structured artifacts, not prompts.
- `CorpusSite`/`CorpusRepo`/`Corpus` shapes are reused; `corpus.ts` is not forked.
- `safetyProfile: 'strict-defensive'` and `exploitCodeAllowed: false` invariants are untouched; the safety regression check runs per split.

**What hurts.**
- Four splits multiply benchmark cost roughly 4× per promotion decision; the registry must support split-level caching of seeded runs.
- Real-data ingestion introduces label noise and licensing/scope obligations; advisory- and PR-sourced examples need scope assertions consistent with ADR-155's authorization model.
- An `llm-judge` evaluator is non-deterministic by nature; it must be quarantined from the replay-critical gate (code-rule + bootstrap decide promotion; LLM-judge and pairwise are advisory/diagnostic) so "the proof is in replay" stays true.
- Adversarial examples can themselves overfit if authored carelessly; they need provenance and periodic rotation.

## Alternatives Considered

1. **Keep the single `defaultCorpus()` and trust the bootstrap.** Rejected: the bootstrap certifies across the repos given, not across unseen data; a champion can overfit the seed corpus and still pass. The false-winner risk is a *data* gap, not a statistics gap.
2. **Train/test split only (two splits).** Rejected: a two-way split catches overfitting but not regression (old-bug breakage) or adversarial gaming. The acceptance test names four classes deliberately.
3. **Hold the registry outside the repo (external benchmark service).** Rejected for the replay-critical path: external data breaks deterministic, sealed-runner replay. The registry is in-repo and versioned; external sources are *ingested* into versioned snapshots, not queried live at gate time.
4. **Make LLM-judge a promotion-deciding evaluator.** Rejected: non-deterministic grading cannot anchor a replayable promotion. LLM-judge and pairwise stay advisory; code-rule + the seeded bootstrap decide.
5. **One big undifferentiated dataset with provenance but no splits.** Rejected: provenance without splits gives auditability but not the generalization guarantee the acceptance test demands.

## Test Contract

These operationalize the acceptance test ("a winning variant must win on training AND held-out AND regression AND adversarial tasks") as named, deterministic tests under `packages/darwin-mode/src/security/`.

- **`darwinbench_four_split_gate_requires_all`** — A champion is promoted only when `decidePromotionAcrossSplits` returns `promote === true` with every split's `PromotionDecision.promote === true`. Construct a genome that wins on `train` but loses on `heldout`; assert `promote === false` and `blockedBy` contains `'heldout'`.
- **`darwinbench_each_split_bootstrap_certified`** — Assert each split's verdict comes from the existing seeded `bootstrapDelta`/`decidePromotion` (same `seed`, paired per-repo, lower-95% > 0). Re-running with the same seed yields byte-identical `bySplit` results.
- **`darwinbench_regression_split_blocks_old_bug_breakage`** — A genome that improves on new tasks but regresses on a `regression`-split example (a previously fixed weakness) is blocked, with `blockedBy` containing `'regression'`.
- **`darwinbench_adversarial_split_blocks_gaming`** — A genome that wins by over-flagging decoy-style adversarial examples is blocked on the `adversarial` split (false-positive reduction term in `fitness()` drives the failure).
- **`darwinbench_provenance_completeness`** — Constructing a `Dataset` with any `DatasetExample` missing `source` or `split` throws; every accepted example carries a `Provenance{ source, ref, capturedAt }` and a `DatasetSplit`.
- **`darwinbench_unsafe_regression_per_split`** — The per-split safety check rejects any split on which the new genome emits a non-zero `unsafeOutputs`, matching `decidePromotion`'s `unsafeRegression` semantics.
- **`darwinbench_llm_judge_excluded_from_replay_gate`** — Assert the promotion decision is identical whether or not an `llm-judge`/`pairwise` evaluator is attached (advisory-only; never decides).

## Reference implementation

A dependency-free, deterministic reference of this ADR lives in `@metaharness/projects` (committed this session): `packages/projects/src/datasets.ts` (with its test and `bench/datasets.bench.mjs`). It implements `DatasetRegistry`, the four splits (train/heldout/regression/adversarial), per-example provenance, and `fourSplitGate` (bootstrap-certified). The package as a whole has 117 passing tests. The synthetic bench is a deterministic simulation; its receipt (`packages/projects/bench/results/datasets.json`) shows a true winner promoted and a train-overfit *false* winner REJECTED because it loses on the adversarial split — the false-winner guard works as designed.

## References

- LangSmith — evaluation workflow: datasets, evaluators, experiments, pairwise comparison; examples from curated cases, historical traces, synthetic data, and human review; graded by code rules, LLM judges, and pairwise comparison. Pattern borrowed; product not used. (https://docs.smith.langchain.com/evaluation)
- ADR-076 — parent-vs-child benchmark (the comparison this gate generalizes to four splits).
- ADR-079 — SGM statistical gates + risk budget (the bootstrap discipline reused per split).
- ADR-072 — frozen scorer/promotion (reused verbatim; the gate composes it).
- ADR-073 — archive + selection (where multi-split winners are archived).
- ADR-077 / ADR-078 — DGM / HGM clade metaproductivity (selection that consumes split-certified fitness).
- ADR-082 — expected gains + effective-performance (impact percentages are hypotheses).
- ADR-155 — Darwin Shield (`Corpus`/`CorpusSite`/`defaultCorpus`, `stats.ts` bootstrap, `ablation.ts`).
- ADR-156 — umbrella thesis: mutate structured policies, not prompts.
