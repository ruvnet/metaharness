# ADR-108: Darwin Mode evolution series — synthesis, evidence, and status

**Status**: Accepted (synthesis / index)
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Indexes**: ADR-084 … ADR-139 (the evolution stack + the SWE-bench arc, built on the ADR-070…083 baseline)

> One document a reviewer can read to understand the whole contribution. Darwin Mode's differentiator is not a model — it is an **auditable, statistically-gated, recursive lineage**: a self-improving agent harness where every claim is a committed, reproducible number and every limitation is recorded. This ADR is the provenance.

## The arc (what was built, in order)

1. **Engine** (ADR-070…083, prior): frozen model + evolving harness over 7 mutation surfaces; sandbox; immutable scorer; archive-as-tree; safety gate.
2. **Variation** — failure-driven mutation (084), LLM mutator + 15-model polyglot model frontier (085), sibling-diversity nonce fixing one-directional mutation (104), genetic crossover (089), epistatic linkage / topology-aware crossover (093).
3. **Selection** — efficiency tie-break (086), MAP-Elites (088), hyperbolic Poincaré phenotyping (091) + niche steering (092), clade metaproductivity / Huxley-Gödel (094), multi-objective Pareto (100).
4. **Acceptance** — graded statistical promotion over a hash-pinned suite (087), SGM cumulative risk budget (090), Benjamini-Hochberg FDR control (096), self-directed curriculum (097).
5. **Substrate** — the keystone: `real` (repo test, surface-independent) → `mock` (deterministic surface-param simulation, 102) → `agent` (real surface **code** execution via child strip-types process, 106) → real-LLM eval PoC (107).
6. **Validation** — system-audit dashboard (099), Poincaré-vs-Euclidean ablation (095), self-improvement demonstrated (103), diversity-beats-greedy-on-deception (105).
7. **Real-substrate proofs** — Tier-2 real surface-code execution (106), real-LLM fixes a real test (107), surface gates the real LLM (109), evolution lifts a real LLM's real-test pass-rate (110).
8. **Adversarial self-correction** (after a critical external review) — falsified "ranking determines outcomes" → it's window size for flat distractors (111), but ranking IS causal when relevance varies (113); falsified FDR control at n=3 → guarded at n≥5 (112). Claims trued-up, not defended. Also: diversity-beats-greedy did NOT replicate on the real substrate (114); crossover is not load-bearing — archive retention is (115); retention inconclusive at n=2 (116).
9. **The SWE-bench arc (117–139)** — from real multi-file reasoning to a self-optimizing harness:
   - **Real reasoning**: real contextBuilder selects → real LLM fixes real code → real test (117); generalizes 5/5 across domains (118); evolution lifts real-test pass-rate 0/5→5/5 (119).
   - **On the project's own code**: fixes a bug in this package's real `pareto.ts` (120), verified by the package's own committed vitest suite (121).
   - **ADR-098 execution**: the long-horizon **validation harness** (122, step 1); the **runner adapter + real resolved criterion** `FAIL_TO_PASS ∧ PASS_TO_PASS` (123, step 2); the **patch-primitive decision** — `git apply` validated, raw LLM diffs corrupt → whole-file (124); the **consolidated `runSweBenchTask()`** entry point (125).
   - **Hardening**: repair loop + regression-aware feedback + robust sentinel parsing — and the honest finding that whole-file repair regresses large files (126); the **search/replace primitive** that fixes it (127); **camelCase tokenization** (128) and **symbol-index selection** (129) closing the file-selection gap; and finally **`runSweBenchTask` as a fitness function** that selects the better harness config (130) — the signal `evolve()` optimizes.
   - **Honest finding**: a self-hosted historical-bug corpus is NOT viable here (this repo's fixes are behavioral, not revertable-unit-bug pairs) — the ADR-098 corpus must be external (recorded in ADR-098).
   - **External generalization + the evolve capstone (131–133)**: the runner resolves a real bug in a *different* package (131, kernel-js); a **multi-package corpus** gives a **4/4 cross-package resolve-rate** (132); and a `(1+λ)` **evolutionary loop optimizes the harness genome against that real cross-package SWE fitness** (133) — engine + runner + corpus + fitness composed into a self-optimizing loop. Honest: small-file corpora saturate resolve-rate, so evolution converges on *cost*; capability-gene discrimination needs harder tasks — shown in 134, where a discriminating multi-fault corpus makes evolution select search/replace by capability, not cost (full external scale = step 3).

## The evidence (real, reproducible — `packages/darwin-mode/bench/results/`)

| Finding | ADR | Number |
|---|---|---|
| Cheap beats frontier for code | 085 | DeepSeek-V3 ($0.4/Mtok) tops 15-model × 6-language execution frontier on quality/$ |
| Determinism | 099 | archive divergence **0** across same-seed runs |
| FDR control works (n≥5 only) | 099/112 | empirical FDR **0.049 ≤ 0.05** on uniforms; on real bootstrap p-values BH controls FDR at **n≥5** task-scores, NOT n=3 (33%, ADR-112) |
| Hyperbolic niches help (conditionally) | 095 | depth-structured: Poincaré sep **1.000** vs Euclidean 0.929; uniform: Euclidean wins (honest) |
| Manifold goes live | 102 | nicheEntropy **0 → 0.69**, finalScore **flat 0.985 → 0.435–0.802** under `mock` |
| Self-improvement | 103 | evolves contextBuilder window 30→70, finalScore **0.765 → 0.985** |
| Diversity > greedy on deception (MOCK only) | 105/114 | mock: greedy 0/5, diversity 5/5 — but did NOT replicate on the real-surface substrate (greedy 3/3, diversity 2/3, ADR-114): advantage is substrate-dependent; crossover is the load-bearing piece |
| Real surface code drives outcome | 106 | window 30/50/80 → solves **1/2/3** tasks (Tier-2); self-improves 0.618→0.985 |
| Surface gates real LLM (window, not ranking — corrected) | 109/111 | wide window lets a real LLM fix a real test a narrow one can't; **ranking untested** (ADR-111 falsification) |
| Real-LLM eval path | 107 | real failing test → 1 model call → real test PASSES, **$0.0005** |
| Real multi-file SWE, generalizes | 117/118 | real ctxb→real LLM→real test FIXED; **5/5** varied real bugs, correct file each, ~$0.001 |
| Evolution lifts real-LLM pass-rate (multi-domain) | 119 | **0/5 → 5/5** across 5 domains, window 30→50, 5 cached calls |
| Fixes THIS package's real code | 120/121 | real `pareto.ts` bug FIXED, verified by the package's **own vitest suite**, $0.004 |
| Long-horizon context (ADR-098 step 1) | 122 | 50-step growing repo: relevance-ranked **100%** thread-retention vs naive recency **52%** |
| Real resolved criterion (ADR-098 step 2) | 123 | auto-derived F2P=4/P2P=18; real LLM **RESOLVED 4/4,18/18**; test-gaming patch UNRESOLVED |
| Search/replace fixes large-file repair | 126/127 | whole-file regresses a large file; search/replace **RESOLVES 5/5 F2P, 17/17 P2P**, 875B diff, $0.004 |
| Symbol-aware selection | 128/129 | camelCase split lifts `pareto.ts` 12→1; symbol index finds `phenotype.ts` path-only missed |
| SWE resolve-rate as a fitness function | 130 | scores a config population; fitness selects `searchreplace/3` (2/2 resolve, ~35% cheaper) |
| Runner generalizes to an external package | 131 | resolves a real bug in `kernel-js` (not darwin-mode), 2/2 F2P, 1 attempt, $0.003 |
| Multi-package cross-package resolve-rate | 132 | **4/4** across kernel-js, create-agent-harness, vertical-base, darwin-mode, $0.017, one runner |
| Evolve the harness vs real SWE fitness | 133 | `(1+λ)` loop over 3 external pkgs; elite improves gen0→gen1 (3/3 at lower cost); converges to cheapest-sufficient |
| Capability-driven evolution | 134 | discriminating corpus (multi-fault): `searchreplace/a1` resolves 2/2, `wholefile/a1` only 1/2 → evolution selects search/replace by **capability** (completes 133's cost-driven regime) |
| SWE-fix model frontier | 135 | `deepseek-chat` tops (3/3, $0.006, 484 res/$); the default `gemini-flash` is suboptimal (2/3, fails kernel-js) — cheap-beats-frontier for bug-fixing |
| Greedy evolve → local optimum | 136 | naive `(1+λ)` single-gene hill-climb traps at `gemini/wholefile` (3/3 $0.014), misses the cheaper `deepseek/searchreplace` ($0.006) — re-motivates diversity/crossover (105) |
| Micro-evolve noise floor + epistasis | 137 | per-cell variance dominates at n=1 (deepseek/wholefile 0/3 vs 2/3); model×patchMode epistasis → naive crossover fails → averaged runs + linkage-aware crossover (093) needed |
| Micro-evolve noise floor, quantified | 138 | per-genome resolve **sd≈0.4-0.5/3**; means ~0.5 apart → need **~4-5 averaged runs** to distinguish (n=1 micro-evolve was under-sampled; justifies 137 stop) |
| Default validated under averaging | 139 | new default `deepseek/searchreplace` **3.0/3 sd0** (every run) vs old `gemini/searchreplace` 2.25/3 sd0.43 (n=4) — optimum is also most stable |

## Honest open problems (recorded, not hidden)

- **Real-world fidelity**: largely addressed by the SWE arc (117–130) — real LLM fixes real code (incl. this package's own, verified by its own vitest suite, 120/121) under the real resolved criterion (123). What is *not* yet done is running it **in-loop at corpus scale** (per-variant LLM cost) and on an **external** benchmark — ADR-098 step 3, user-gated. No benchmark/leaderboard number is claimed until a real external run exists.
- **Clade < behavioral-diversity** (4/5 vs 5/5): clade explores but doesn't pair complementary stepping-stones; a trace-niche-diversity fix was net-neutral and reverted (105 follow-up). Closing it needs a *parameter-aware* (genotypic) diversity signal — future.
- **Strong deception** (needs two surfaces far past baseline) is crossed by *none* of the strategies (105) — an honest capability ceiling.
- **Mutator scope**: deterministic edits are bounded perturbations; the rich path is the LLM mutator (085).

## The frontier: ADR-098 (now built end-to-end; only the corpus remains)

Real LLM solving real SWE-bench-style tasks. The SWE arc (117–130) **built and validated every link**: real file selection (symbol-aware, 128/129), surgical patching (search/replace, 127), the real resolved criterion (123), a `git apply` primitive (124), a consolidated `runSweBenchTask()` runner (125) with a repair loop (126), and that runner as a **fitness function** for harness selection (130). Roadmap status: **step 1 (validation harness) ✅ 122, step 2 (runner adapter) ✅ 123, patch primitive ✅ 124** — and the runner is now shown to **generalize across packages** (131/132) and to be **driveable by an evolutionary loop** (133). Only **step 3 remains: a real external multi-file corpus at scale + a token budget**, genuinely user-gated (a self-hosted historical corpus was found non-viable, so the dataset must be external; ADR-098). No new mechanism is required — `score(genome) = resolveRate(corpus)` with a cost tie-break (130) is already exercised by an actual mutate→evaluate→select loop (133); step 3 is that loop on a capability-discriminating external corpus.

## Status

A **working, empirically-validated, fully-documented, and adversarially self-corrected** self-improving evolutionary harness: 60 ADRs (084–139), 350 tests, 39 reproducible experiments, every selection/variation/acceptance mechanism opt-in over a frozen reproducible core. The manifold is demonstrably live; self-improvement and diversity-superiority are measured (mock substrate); the real substrate is proven end-to-end (real surface code → real LLM → real test, surface causally gating capability); a critical external review's three findings were addressed with reproducible experiments (two corrections + one completion); and the **SWE-bench arc (117–130)** built the real-task pipeline to completion — real file selection, surgical patching, the real resolved criterion, a consolidated runner, and that runner as a **fitness function** the engine can optimize. What remains is **scale + data**: the real external SWE corpus + token budget (ADR-098 step 3) — user-gated, no new mechanism. The scientific product is the provenance: this series, including the parts that falsified and corrected its own claims (111/112/114/115) and the limitations surfaced rather than hidden (116/126/128).
