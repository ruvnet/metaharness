# Pre-registration: sealed three-arm SIM evaluation (#523)

**ID:** `metaharness-523-sealed-sim-v1`
**Registered:** 2026-11-20, committed and pushed **before any paid model call** (the git timestamp of this file precedes every row in `results/`).
**Base commit:** `7b3b91d9` (`@metaharness/darwin` 0.15.0, ADR-325 SIM).
**Question:** Does opt-in SIM optimizer memory (ADR-325) improve the **sealed held-out** outcome of Darwin harness optimization, compared with Darwin without SIM, at equal budgets? Does memory built on one model or benchmark transfer negatively to another?

Deviations from this document are reported in `RESULTS.md`. This file is not edited after results exist.

## Substrate

- **Optimizer loop:** unmodified Darwin `evolve()` from `dist/` **rebuilt with `npx tsc` from the base commit's `src/`**. The tracked `dist/` at `7b3b91d9` predates the SIM wiring: its `evolve.js` never calls `sim.store`, so SIM arms run on it would silently equal `off`. The runner refuses to start on such a `dist/`. Run configuration: `sandboxMode: 'agent'` (ADR-106 Tier-2: each variant's real `planner`, `context_builder`, `retry_policy` and `tool_policy` code runs in an isolated child process). The proposer is the only paid component.
- **Grader (frozen):** `src/tier2-driver.ts` sha256 `53a861b47471c22e4af1bb626eca11e2a1c04d574f01c07629ee6549ab0277ff` (built `dist/tier2-driver.js` `5eb41d126cd32bf3a8543bce64aeb9b9b50ecaa78860dc66e341da5e508b0004`), `src/tier2-sandbox.ts` `8115ba184cf47442c92bc145acf31e2654bc2d22604e4402c4dc7a9104f60666`. A task is solved if and only if the driver reports `solved`. The grading is deterministic: the same variant graded twice gives identical results, which was checked on the baseline before registration.
- **Proposer:** `bench/sim-eval/proposer.mjs` `GuardedOpenRouterProposer`. It sends the same system and user prompt text as the stock `OpenRouterMutator`, uses temperature 0.4 and `max_tokens` 2500, and has no key-file fallback. It returns a deterministic diff-derived summary (up to 3 removed and 3 added code lines) instead of the stock `openrouter:<model> regenerated <surface>`. evolve() stores that summary as the SIM `rationale`. The stock string carries no edit content, so with it SIM could only report "surface X moved by Y". The summary is identical in form for all arms, including `off`.

## Benchmarks and frozen partitions

`bench/sim-eval/tasks.json` (`sim-eval-tasks-v1`, generator `tasks.mjs`, seed 523, sha256 `7ebe5ff750d78c05a4630b6edfdded30e6f3ce44f09a457040f4bea686037582`). The live runner refuses to start if the hash differs.

| benchmark | what it stresses | train (optimizer-visible) | sealed held-out |
|---|---|---|---|
| `loc` | context window and ranking: buggy file behind `before` tie distractors | 10 tasks, `before` 0–50 | 48 tasks, `before` 0–160 |
| `per` | retry persistence: `failAttempts` with transient, repairable and unknown classes | 9 tasks, `failAttempts` 0–2 | 48 tasks, `failAttempts` 0–6 |

The held-out vocabulary is disjoint from the train vocabulary. Held-out ranges extend past the train ranges, which is an extrapolation split. Measured before registration (baseline harness): `loc` train 60.0% and held-out 12.5%; `per` train 77.8% and held-out 31.3%. Hand-written edits move held-out, so the metric is not saturated or stuck:

| hand edit | held-out |
|---|---|
| window 60 | `loc` 37.5% |
| path-length tie-break | `loc` 100% |
| `maxAttempts` 4, retry unknown | `per` 54.2% |
| `maxAttempts` 8, retry unknown | `per` 100% |

**Sealing.** Only `partitions[bench].train` is passed to `evolve()` (`plan.evolveConfig`; tested). Held-out tasks are graded once per run, after `evolve()` returns, on `result.winner` (or the baseline if there is no winner) via `runVariantTasksAgent`. No held-out outcome is written to SIM, the archive, or any input of a later run.

## Arms

All arms use identical seeds, models, generations (6), children per generation (3), and `selectionPool: 'generation'`. That pool fixes at most 2 parents per generation, so every run makes exactly **33 proposals** and **34 variant evaluations** of the train set. All arms also share `promotionDelta` 0.01 and evaluator concurrency 2. Surface choice (`pickSurface(gen, index, seed)`) is therefore identical across arms for a given seed.

| arm | SIM | starting memory |
|---|---|---|
| `off` (harness-only) | none (`sim` omitted) | — |
| `full-in` (bounded full SIM) | `mode: 'full'`, `maxTokens` 800 | same model, same benchmark source store |
| `retr-in` (hybrid retrieval SIM) | `mode: 'retrieval'`, `maxTokens` 800, local feature-hashing embedder (256-d) and native RVF index, hybrid lexical rerank | same model, same benchmark source store |
| `full-xmodel`, `retr-xmodel` | as above | the **other** model's store on the same benchmark |
| `full-xbench`, `retr-xbench` | as above | the same model's store on the **other** benchmark |
| `retr-poison` (security probe) | as `retr-in`, plus 4 canary records telling the proposer to add `node:fs` reads | first model × `loc` only |

**Hybrid RVF details.** RVF is used only if `@ruvector/rvf` resolves and passes an exact-match self check: a record's own vector must return its id first. Otherwise the run falls back to deterministic lexical retrieval and records `rvf.used=false`. Note: `@ruvector/rvf` 0.1.x maps string ids to `NaN`, collapsing every record onto one label, so vector retrieval silently returns nothing usable. Live runs use 0.4.12, which was verified before registration.

**Source memory.** For each model and benchmark, 3 source runs (seeds 101–103) run in `full` mode, sequentially, into one store per (model, benchmark). Each target run gets a private copy of its store and its own RVF index path, so runs are independent. Memory grows within a run as evolve() appends scored attempts. Because `eligible()` ignores `modelId` and `benchmarkId`, each transfer arm's store holds **only** the intended source records.

**Models** (OpenRouter, two providers and families):

| model | input $/M tokens | output $/M tokens |
|---|---|---|
| `google/gemini-2.5-flash-lite` | 0.10 | 0.40 |
| `openai/gpt-4.1-nano` | 0.10 | 0.40 |

**Seeds:** target 1–10 (10 per arm per model × benchmark cell). Source: 101–103. Smoke: 900.

## Phases

1. **Smoke** (excluded from analysis): `off`, `full-in` and `retr-in`, first model, `loc`, seed 900, with empty memory. It checks plumbing and that costs are reported. Its spend counts toward the cap.
2. **Source:** 12 runs.
3. **Target:** 290 runs, ordered seed-major so a cap-truncated run stays balanced.

## Budget and cap

Hard cap **$40.00** total real spend across all phases, enforced in code (`spend-guard.mjs`):

- Before each call, a worst-case reservation is made: (prompt chars × input price + `max_tokens` × output price) × 1.25.
- If spent + outstanding reservations + the new reservation would exceed $40, the call is refused.
- After the call, the provider-reported `usage.cost` is settled. A missing or non-finite cost, or a network error, is charged at the reservation, never $0.
- `spend-ledger.jsonl` is append-only and reloaded on restart.

Projected spend is about $5–10 (about 10k proposals at about $0.0006 each). If the cap stops the run, the completed seed-major prefix is analysed, and the result is labelled cap-truncated.

## Metrics

- **Primary:** held-out solve rate of the run's winner (fraction of the 48 sealed tasks solved).
- **Secondary:**
  - winner train solve rate;
  - proposer USD per run and USD per held-out solve (bootstrap CI);
  - prompt tokens per call and SIM context tokens/records;
  - p50/p95 proposer call latency;
  - proposer failures and truncations;
  - effective-surface edits per run;
  - SIM retrieval kind counts and RVF usage;
  - Jaccard overlap of `full-in` vs `retr-in` context selections (manipulation check).
- **Safety:**
  - validator rejections per proposal (`mutation rejected by validator`);
  - canary-matching rejections;
  - safety-disqualified traces (exit 99);
  - Tier-2 child errors.

## Statistical analysis

- **Unit and contrast.** The unit is one (model, benchmark, seed). A contrast is the per-seed paired difference arm − control within each model × benchmark cell. The estimate is the equal-weight mean of the 4 cell means.
- **CI and p-value.** The CI comes from a cell-stratified paired bootstrap, resampling seeds within each cell (10,000 reps, percentile). The p-value comes from a two-sided sign-flip permutation test on the same statistic (20,000 reps).
- **Primary contrasts:** `full-in − off` and `retr-in − off`. Multiplicity is handled with Holm-adjusted p-values and Bonferroni **97.5%** CIs for the decision.
- **Verdicts** (held-out points):
  - **gain** (promotion threshold): estimate ≥ +2.0pt and CI lower bound > 0;
  - **negative:** CI upper bound < 0;
  - **null:** CI entirely inside (−2pt, +2pt), i.e. practical equivalence;
  - **inconclusive / underpowered:** anything else.
- **Negative transfer** (cross-model and cross-benchmark). Memory built on model A or benchmark A and applied to B is assessed with these contrasts:
  - `{full,retr}-xmodel − off` and `{full,retr}-xbench − off`: negative transfer = verdict `negative`, 95% CI;
  - `{full,retr}-x* − {full,retr}-in`: transfer penalty relative to in-distribution memory, reported with 95% CI.
- **Security regression.** A security regression is a validator-rejection-rate contrast (SIM arm − `off`, paired, 95% CI) whose lower bound is > 0. The poison probe is `retr-poison − retr-in` on rejection rate, canary rejections and held-out.
- **Missing data.** Aborted runs (cap, crash) are excluded pairwise and listed. A Tier-2 `child error` trace counts as unsolved for that task, as in Darwin; child-error counts are reported per arm.

No model-uplift claim is made from the synthetic retrieval fixture (`bench/sim-continuation.mjs`) or from train scores.

## Reproduce

```bash
npm ci --ignore-scripts && (cd packages/darwin-mode && npx tsc)
node packages/darwin-mode/bench/sim-eval/run.mjs --dry                 # $0, mock proposer, tiny design
npx vitest run packages/darwin-mode/__tests__/sim-eval-runner.test.ts  # $0 CI coverage
# live (needs OPENROUTER_API_KEY in env; @ruvector/rvf >= 0.4 resolvable for the RVF arm):
node packages/darwin-mode/bench/sim-eval/run.mjs --live --phase smoke
node packages/darwin-mode/bench/sim-eval/run.mjs --live --phase source
node packages/darwin-mode/bench/sim-eval/run.mjs --live --phase target
node packages/darwin-mode/bench/sim-eval/analyze.mjs
```
