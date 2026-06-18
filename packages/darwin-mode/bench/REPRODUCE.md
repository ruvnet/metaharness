# Reproduce every Darwin Mode result

Every claim in ADR-084…116 is backed by a committed experiment + result artifact.
This is the index: run the command, compare to `bench/results/<file>`. Build first:

```bash
npm run build        # tsc → dist/ (Tier-2 / agent experiments import dist/)
```

Conventions: **det** = deterministic & reproducible (same output every run, no
network). **agent** = runs child `node --experimental-strip-types` (Node ≥ 22, no
LLM, deterministic). **LLM** = one or more live OpenRouter calls (set
`OPENROUTER_API_KEY`); costs are pennies and are *not* bit-reproducible.

| # | Experiment | Command | Result file | Finding | Type |
|---|---|---|---|---|---|
| 085 | Polyglot model frontier | `node bench/polyglot/run-cell.mjs <model> <lang>` (+ swarm) | `results/polyglot-code-frontier.json` | DeepSeek-V3 tops quality/$ across 6 langs | LLM |
| 087 | evolve mutator parity | `node /tmp/darwin-bench.mjs <repo> <model>` | `results/evolve-mutator-parity.json` | det vs LLM mutator both hit 0.985 ceiling | LLM |
| 095 | Poincaré vs Euclidean niches | `node bench/ablation/poincare-vs-euclidean.mjs` | `results/poincare-vs-euclidean-ablation.json` | Poincaré better only on depth-structured data | det |
| 099 | System audit dashboard | `node bench/system-audit.mjs` | `results/system-audit.json` | determinism 0; FDR 0.049≤0.05; nicheEntropy 0 (real) | det |
| 102 | Manifold goes live | (inline, see ADR-102) | `results/manifold-live.json` | mock: entropy 0→0.69, scores flat→0.43–0.80 | agent |
| 103 | Self-improvement | (inline, see ADR-103) | `results/self-improvement-demo.json` | window 30→70, finalScore 0.765→0.985 | agent |
| 105 | Diversity beats greedy (mock) | (inline, see ADR-105) | `results/deception-experiment.json` | greedy 0/5, behavioral-diversity 5/5 | det/mock |
| 107 | Real-LLM eval PoC | `node bench/experiments/real-llm-eval-poc.mjs` | `results/real-llm-eval-poc.json` | real test FAIL→PASS via 1 call, $0.0005 | LLM |
| 109 | Surface gates real LLM | `node --experimental-strip-types bench/experiments/real-surface-llm-eval.mjs` | `results/real-surface-llm-eval.json` | wide window lets LLM fix; narrow can't | LLM |
| 110 | Evolution lifts real-LLM pass-rate | `node --experimental-strip-types bench/experiments/real-llm-evolution.mjs` | `results/real-llm-evolution.json` | 1/3→3/3, window 30→70, 1 cached call | LLM |
| 111 | Falsify: window not ranking | `node --experimental-strip-types bench/experiments/falsify-context-selection.mjs` | `results/falsify-context-selection.json` | first-N == real ctxb (flat distractors) | agent |
| 112 | FDR calibration at small n | `node bench/experiments/fdr-calibration.mjs` | `results/fdr-calibration.json` | BH fails at n=3 (0.33), OK at n≥5 | det |
| 113 | Ranking IS causal (varied relevance) | `node --experimental-strip-types bench/experiments/ranking-matters.mjs` | `results/ranking-matters.json` | real ctxb solves where first-N can't | agent |
| 114 | Diversity advantage substrate-dependent | `node --experimental-strip-types bench/experiments/real-substrate-deception.mjs` | `results/real-substrate-deception.json` | agent: greedy 3/3, diversity 2/3 (not replicated) | agent |
| 115 | Crossover ablation | `node --experimental-strip-types bench/experiments/crossover-ablation.mjs` | `results/crossover-ablation.json` | crossover-off crosses 2/2 → archive does the work | agent |
| 116 | Retention ablation | `node --experimental-strip-types bench/experiments/retention-ablation.mjs` | `results/retention-ablation.json` | retention helps (2/2 vs 1/2); inconclusive at n=2 | agent |
| 117 | Real multi-file SWE nucleus | `node --experimental-strip-types bench/experiments/swe-nucleus.mjs` | `results/swe-nucleus.json` | real ctxb selects → real LLM reasons over real code → real test FIXED | LLM |
| 118 | SWE suite generalizes | `node --experimental-strip-types bench/experiments/swe-suite.mjs` | `results/swe-suite.json` | 5/5 varied real bugs fixed, correct file chosen each, $0.001 | LLM |
| 119 | Multi-domain evolution | `node --experimental-strip-types bench/experiments/swe-evolution.mjs` | `results/swe-evolution.json` | evolution lifts real-test pass-rate 0/5→5/5 (window 30→50), 5 cached calls | LLM |
| 120 | SWE loop on THIS package's real code | `node --experimental-strip-types bench/experiments/swe-realcode.mjs` | `results/swe-realcode.json` | real ctxb picks pareto.ts of 21 real src files → real LLM fixes real TS → real test FIXED, $0.004 | LLM |
| 121 | …verified by the package's own vitest suite | `node --experimental-strip-types bench/experiments/swe-realtests.mjs` | `results/swe-realtests.json` | same loop, oracle = real committed `pareto.test.ts` (vitest) FAIL→PASS, $0.004 | LLM |
| 122 | Long-horizon validation harness (ADR-098 step 1) | `node --experimental-strip-types bench/experiments/validation-harness.mjs` | `results/validation-harness.json` | 50-step growing repo: relevance-ranked holds the thread 100%, naive recency 52% (lost at step 26) | det |
| 123 | SWE-bench runner adapter + real resolved criterion (ADR-098 step 2) | `node --experimental-strip-types bench/experiments/swe-bench-adapter.mjs` | `results/swe-bench-adapter.json` | auto-derived F2P=4/P2P=18; real LLM fix RESOLVED (4/4,18/18); test-gaming patch UNRESOLVED (1/4) | LLM |
| 124 | `git apply` patch primitive (ADR-098 step-3 prep) | `node --experimental-strip-types bench/experiments/swe-bench-gitapply.mjs` | `results/swe-bench-gitapply.json` | gold unified diff applies+RESOLVES (4/4,18/18); raw LLM diff corrupt → whole-file primitive preferred | LLM |
| 125 | Consolidated `runSweBenchTask()` corpus-ready runner | `node --experimental-strip-types bench/experiments/swe-bench-run.mjs` | `results/swe-bench-run.json` | one entry point: materialize→derive F2P/P2P→select→whole-file fix→git-diff→criterion; RESOLVED 4/4,18/18 | LLM |
| 126 | Repair loop + regression-aware feedback + robust parsing | `node --experimental-strip-types bench/experiments/swe-bench-repair.mjs` | `results/swe-bench-repair.json` | single-fault RESOLVED (2 attempts); two-fault whole-file repair regresses P2P (honest limitation → step 3 needs surgical patching) | LLM |
| 127 | Search/replace patch primitive (fixes ADR-126) | `node --experimental-strip-types bench/experiments/swe-bench-searchreplace.mjs` | `results/swe-bench-searchreplace.json` | two-fault (small+LARGE file) RESOLVED 5/5 F2P, 17/17 P2P NO regression, 1 attempt, 875B surgical diff, $0.004 | LLM |
| 128 | contextBuilder camelCase tokenization | `node --experimental-strip-types bench/experiments/camelcase-selection.mjs` | `results/camelcase-selection.json` | camelCase split lifts pareto.ts rank 12→1; symbol≠filename (poincareDistance∈phenotype.ts) still unmatched → needs content indexing | det |
| 129 | Symbol-index file selection (closes ADR-127/128) | `node --experimental-strip-types bench/experiments/symbol-index-selection.mjs` | `results/symbol-index-selection.json` | symbol indexing selects phenotype.ts (via poincareDistance def) that path-only missed; camelCase bug report resolves e2e | det |
| 130 | SWE resolve-rate as a fitness function | `node --experimental-strip-types bench/experiments/swe-fitness-selection.mjs` | `results/swe-fitness-selection.json` | runSweBenchTask scores a config population; fitness selects searchreplace/3 (2/2 resolve, ~35% cheaper) — evolve()'s scorer | LLM |
| 131 | SWE runner generalizes to an external package | `node --experimental-strip-types bench/experiments/swe-external-kernel.mjs` | `results/swe-external-kernel.json` | resolves a real bug in kernel-js (not darwin-mode) — 2/2 F2P, 2/2 P2P, 1 attempt, $0.003 | LLM |
| 132 | Multi-package self-hosted SWE corpus | `node --experimental-strip-types bench/experiments/swe-monorepo-corpus.mjs` | `results/swe-monorepo-corpus.json` | cross-package resolve-rate **4/4** (kernel-js, create-agent-harness, vertical-base, darwin-mode), $0.017, one runner | LLM |

DRACO (`results/draco-quality-cost-frontier.json`, ADR-037–040 lineage) and the
human-readable summary (`results/RESULTS.md`) accompany these.

Honest notes: `LLM` rows are not bit-reproducible (model nondeterminism) and the
corrected/tempered claims are 111 (window not ranking), 112 (FDR n≥5), 114
(diversity not universal), 115 (crossover not load-bearing). The full self-correcting
narrative is ADR-108 (synthesis) → ADR-111…116.
