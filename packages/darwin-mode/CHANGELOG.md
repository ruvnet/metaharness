# Changelog — @metaharness/darwin

All notable changes to this package. Dates UTC.

## 0.10.1 — 2026-09-01

- **Fix: `ShellEvaluator` crashed the whole run instead of demoting one candidate when the
  evaluator exited without reading its stdin.** The genome is written to `child.stdin` after
  spawn, so a bad argv, an immediate `process.exit`, or a startup crash leaves the pipe closed
  and the write raises `EPIPE` — with no `error` listener on the stdin socket that is an
  unhandled error event. The race is platform-dependent (Linux usually completes the write
  first, macOS often does not), so it surfaced as an intermittent CI failure rather than a
  reliable one. `close`/`error` already resolve with a demoting `errorCard` carrying the
  child's real exit code, so the EPIPE is now swallowed. Regression test included.

## 0.10.0 — 2026-09-01

- **NEW numeric genome kind (ADR-272)** — a second, fully parallel genome representation
  alongside the seven-surface prompt kind (ADR-071), for evolving bounded **numeric**
  parameter vectors (e.g. ML training hyperparameters) against an external metric:
  - `numeric-types` — `NumericGenomeSpec` (`name -> {min, max, scale, type, default?}`),
    `NumericVariant`, `NumericScoreCard`, `NumericEvaluator`;
  - `numeric-mutator` — deterministic seeded Gaussian perturbation + uniform crossover in
    unit-genome space, so `log`-scale parameters perturb multiplicatively; `int`/`float`
    respected, always clamped to `[min, max]`, never a silent full no-op;
  - `numeric-archive` / `numeric-evolve` — the generation loop, reusing the genuinely
    generic `mapLimit`/`paretoFront` with an ADR-073-style stall fallback;
  - `numeric-evaluator` — `ShellEvaluator`: caller-supplied command (never a shell), genome
    JSON in on stdin, `NumericScoreCard` JSON out on stdout. Darwin never trains or scores
    anything itself for this kind — fitness is always external, one call per candidate;
    evaluator failure/timeout/non-JSON demotes the candidate instead of crashing the run.
- **NEW CLI verb** `metaharness-darwin evolve-numeric <repo> --genome <spec.json>
  --evaluator "<cmd> [args...]"` `[--generations N] [--children N] [--concurrency N]
  [--seed N] [--sigma F] [--crossover] [--evaluator-timeout-ms N]`.
- The existing prompt-kind path is **untouched** — no changes to `evolve.ts`, `mutator.ts`,
  `types.ts`, `archive.ts`, `scorer.ts` or `sandbox.ts`, so the ADR-071 mutation-surface
  safety allowlist is not widened to a domain it was never meant to bound.

## 0.8.2 — 2026-08-08

- **Clade selection 1.5–2.7× faster** (`bench:clade`: 443 → 1178 calls/s at n=3000 branching,
  3234 → 4896 at n=200 chain), with identical selections for a fixed seed — the rng draw
  sequence, ordering, and tie-breaks are unchanged:
  - `cladeOutcomesAll` now computes every subtree total in one reverse-insertion-order pass
    (insertion order is topological by construction), replacing memoized recursion; the
    cycle-guarded walk remains as a fallback for out-of-order archives loaded from
    hand-edited files.
  - The outcome table is cached per archive and invalidated by the new `Archive.revision`
    counter (bumped on `addVariant` / `setScore` / `load`), so repeated selections against an
    unchanged archive stop recomputing it.
  - `cladeThompsonSelect` keeps a running top-`limit` instead of fully sorting all scored
    records (limit is 2–8 in practice; ties still resolve toward earlier insertion).
- **NEW `Archive.revision`** — monotonic mutation counter for derived-view caching.

## 0.8.0 — 2026-07-03

- **NEW subpath export `@metaharness/darwin/gepa` — the GEPA prompt-policy learning engine
  (ADR-228, arXiv 2507.19457).** TypeScript port of the four portable modules from the in-repo
  bench implementation (`bench/swebench/gepa/`), behavior-preserving (the bench test suites were
  ported with assertions unchanged and pass against the TS port):
  - `genome` — genome load/validate/mutate/component algebra + the frozen `SEED_GENOME`
    (byte-equivalence to the bench prompt builders enforced by test);
  - `metric` — the pre-registered §5.1 per-instance score, §5.3 failure-class taxonomy, and
    §5.2 ASI feedback generation;
  - `loop` — the budgeted GEPA optimize loop (Pareto pool, sum-driven accept/reject,
    Pareto-add, reflective mutation, stall guard, metric-call/$ budgets) with the **evaluator
    as an injected async callback** — zero SWE-bench/Docker coupling;
  - `promotion` — the STRICT promote-on-holdout rule (`evaluatePromotion`), `summarizeEval`,
    `compositeKey`, `buildPromotionReport`.
- **Ships cand-6** (`genomes/genome-promoted-cand6-edit-by-midpoint.json` + provenance note) —
  the first holdout-confirmed cheap-tier policy promotion (holdout gold 2/12 → 3/12, zero
  regressions, empty-patch 0.583 → 0.333). Exported as `CAND6_GENOME_PATH` / `loadCand6Genome()`.
- **Non-goal:** the SWE-bench/Docker evaluator does not ship — `bench/swebench/gepa/` remains
  the in-repo reference wiring (unchanged; the .mjs originals keep running as-is).
- Root export unchanged (non-breaking).

## 0.7.1 — 2026-06-26

- **SWE-bench Verified (500) — conformant GLM→Opus empty-patch cascade: 55.6% (278/500),
  Wilson 95% CI [51.2, 59.9].** Official `swebench` gold eval; solver never sees gold tests
  in-loop (conformant). Cost ~$0.15/instance (**ESTIMATED** — per-instance cost not captured
  in predictions; GLM-5.2 base on 500 + Opus-4.8 escalation on the empty-patch tail). This
  **beats the Lite cascade (51.3%)** — the same cheap→frontier empty-patch cascade now confirmed
  on **both** splits (Lite n=300, Verified n=500), conformant, at ~56× cheaper than frontier-only
  systems. Still below frontier leaders (70–79%) on raw resolve; the cheapest path to the ~55% tier.
  (LEARNINGS §47; artifacts in `submissions/swe-bench-verified/`.)
- **LiveCodeBench (n=100, release_v5 ≥2024-12-01) — single-shot 44% / cost-cascade 62%.**
  Eval-validated against the official `lcb_runner` (known-correct → PASS, empty → FAIL).
  Honest caveats: contamination-resistant window by construction, but the deepseek snapshot's
  exact cutoff is **unpinned**; the cascade lift is **partly run-to-run (temp-0) variance** —
  the clean attributable lift is **+8** on the escalated hard tail. n=100 is **directional, not
  1:1** with the official whole-release figure (~34%). (LEARNINGS §46b.) The honest number is the
  balanced n=100; an easy-skewed n=25 had read higher and is not used.
- Docs only (package.json/README/CHANGELOG/RESULTS); shipped library unchanged. No new features —
  only these two measured-this-session results were added; research-stage work (config-evolution,
  crack-the-tail, RuVector) is intentionally **not** shipped.

## 0.7.0 — 2026-06-23

- **Conformant (leaderboard-legal) SWE-bench Lite results — the interactive arc.** The stateful interactive
  ReAct loop (repo's own tests as the regression gate, no gold in-loop) measured on the full 300, official
  harness: **single-trajectory 34.0%** [28.9, 39.5] @ ~\$0.005/inst; **Best-of-3 + LLM-judge 39.7%**
  [34.3, 45.3] @ ~\$0.015/inst; union-of-3 ceiling 45.0%. Replaces the MCTS conformant ceiling (16–33%).
  LEARNINGS §13–18.
- **Cost–Performance Pareto leaderboard (live):** https://ruvnet.github.io/agent-harness-generator/cost-pareto.html
  — ranks Darwin vs real SWE-bench Lite/Verified/Pro + Draco entries by a tunable Value Score; real resolve %,
  cost estimated from disclosed models, Darwin measured. Workbook explainer + run-total economics.
- **Honest negatives banked** (the discipline): cost cascade refuted (repo tests are a regression guard, not a
  resolution proxy — fire 3.7% vs 34% gold, §19); judge-validated repro-gate moderate (67%/44%, §20). Parallel
  Best-of-3 + LLM-judge remains the conformant champion.
- Docs only (README/LEARNINGS/CHANGELOG); shipped library unchanged.

## 0.6.0 — 2026-06-23

- **Product pivot (ADR-177): Test-Driven Repair (TDR) is the hero.** README now leads with the CI-Autofixer
  workflow — hand Darwin a failing test, get a verified-fix PR for pennies; **68.3%** on SWE-bench Lite
  *with the acceptance test* (official harness, Wilson CI).
- **New research appendix — "where no-test autonomous repair tops out" (ADR-177).** Publishes the full
  leaderboard-conformant ablation: the coder binds (not the oracle); every cheap lever is null; the
  MCTS+self-repro scaffold caps even frontier at ~33%. "SOTA at pennies" via a no-test cheap pipeline is
  falsified by our own clean data — banked transparently rather than buried. Conformant (no-test) repair
  reframed as a real but bounded (~16–33%) capability, not a leaderboard entry.
- No code change to the shipped library; documentation + positioning.

## 0.3.1 — 2026-06-21

- Docs: README now covers the full SWE-bench ladder (incl. **58.3%** 3-tier + agentic 31.3%) and a **Darwin Shield** section (the v0.3.0 defensive security application); npm description updated to the dual-application story. No code change.

## 0.3.0 — 2026-06-21

- **Darwin Shield (ADR-155): defensive zero-day discovery harness** (`src/security/`,
  exported as `security`). The security application of the Darwin Plus stack —
  same thesis (model frozen, harness evolves, proof in the replayable receipt),
  changed task (defensive vulnerability discovery) and fitness function.
  - Genome (planner/contextPolicy/reviewerCount/retryBudget/fuzzBudget/tools),
    bounded mutation + crossover (`safetyProfile` immutable), three fixed
    baselines (static / LLM single-pass / fixed agent).
  - Safety layer: scope gate, exploit redactor, unsafe-output gate
    (`exploitCodeAllowed` is a hard `false`; unsafe outputs are an immediate
    −1.00 fitness term).
  - ruVector security memory: 7 collections, hybrid + negative-memory ranking,
    patch/genome reuse so runs compound.
  - DARWIN-SHIELD-BENCH on a seeded corpus passes every ADR-155 gate at the
    documented config (pop 16 × 50 cycles): TPR +150% vs fixed harness, FPR −100%,
    patch-pass 100%, repro 100%, **0 unsafe outputs**, cost ≤ 2×. Fully
    deterministic (byte-identical receipts). Run: `npm run bench:shield` or
    `metaharness-darwin security bench`.

## 0.2.8 — 2026-06-21

- **Agentic loop measured at scale (ADR-153)**: the ReAct loop (read/grep/ls/edit/run_tests/submit) on deepseek-v4-pro = **94/300 = 31.3%** [26.3,36.8] (275 attempted, official batch). Competitive with single-shot+repair (29.3%) and CHEAPER (~$0.04/inst vs $0.11) — conservative lower bound (budget-truncated). RESULTS §20.

## 0.2.7 — 2026-06-20

- LEARNINGS.md brought current with the full batch-verified arc: §5 N-tier ladder (29.3→40.3→**58.3%**), §6 capability floor now the rigorous local-14b full-300 number (4.7→6.7%), verdict updated (paradigm reaches 58.3%, both frontiers exhausted). Agentic loop (ADR-153) now implemented + unit-tested (`bench/swebench/agentic-loop.mjs` + `solve-agentic.mjs`) — the next-arc architecture, shipped as code.

## 0.2.6 — 2026-06-19

- **3-tier hybrid = 175/300 = 58.3%** [52.7,63.8] on full SWE-bench Lite (ADR-154), VERIFIED (55/55 sage-added reproduced). v4-pro(88)->sonnet Scholar(+33)->opus Sage(+54). 7.6x the 7.7% baseline; conservative lower bound (Sage partial). Blended ~$0.74/instance.

## 0.2.5 — 2026-06-19

- New ceiling (ADR-152): **v4-pro + Scholar hybrid = 121/300 = 40.3%** [34.9,46.0] on full SWE-bench Lite — 5.2x the 7.7% baseline. Two levers stack: stronger cheap base (v4-pro, 88/300) + frontier-tail escalation (sonnet-4 recovers 33/212). Blended ~$0.39/instance.

## 0.2.4 — 2026-06-19

- New result (ADR-151): swapping the cheap base deepseek-V3 -> deepseek-v4-pro nearly doubles the repair floor **15.3% -> 29.3%** [24.5,34.7] on full SWE-bench Lite (same harness). Falsifies "paradigm exhausted regardless of model IQ."

## 0.2.3 — 2026-06-19

- Add `LEARNINGS.md` — the measured findings distilled into harness defaults (repair=2x lever, cost-routing, Barbarian&Scholar tiering, format-contract, batch-eval discipline, capability floor).

## 0.2.2 — 2026-06-19

- **Docs: full SWE-bench Lite (300) evidence ladder** now in the description + README, all official `swebench` Docker harness, batch-verified:
  - open-loop **7.7%** [5.2, 11.2] (ADR-144)
  - + localization **8.0%** [5.4, 11.6] (ADR-146)
  - + closed-loop repair **15.3%** [11.7, 19.8] (ADR-149)
  - + Barbarian&Scholar hybrid (cheap base + frontier-tail escalation) **33.3%** [28.2, 38.8] (ADR-148)
- Blended cost ~$0.01/instance (cheap) → ~$0.34/instance (hybrid) vs $1–20/instance for frontier agents.
- README now links `bench/results/RESULTS.md` (the full reproducible evidence) for npm-only readers.
- `RuvllmMutator` (local/$0 air-gapped mutator, ADR-259) ships in `dist/`.
- Added `bench/swebench/KNOWN_FLAKY.md` (standing `psf__requests-2317` Docker-hang exclusion note).

## 0.2.1 — 2026-06-19

- Metadata: repositioned as "an LLM supercharger and cost optimizer"; keywords/description.

## 0.2.0 — 2026-06-18

- Integrated into the `metaharness` scaffolder (`npm run evolve`, ADR-147).
- Evolutionary stack (mutation + crossover + diverse selection + graded promotion) over a frozen core.

## 0.1.x — 2026-06

- Initial release: frozen-model / evolving-harness over 7 mutation surfaces; deterministic mutator default; `validateGeneratedCode` safety gate; pluggable `CodeGenerator`.
