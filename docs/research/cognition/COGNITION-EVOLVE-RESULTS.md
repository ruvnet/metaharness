# Memory-as-Cognition: does harness-evolve + agenticow branchable memory lift a cheap model?

**An empirical A/B/C test on FRAMES (GAIA-class multi-hop QA).**
Date: 2026-06-28 · Branch: `claude/cve-bench-era-pin-image-reuse`

---

## TL;DR — the honest verdict

> **No. Neither parallel-selves over branched memory (B) nor Darwin-evolved memory/context-shaping
> genomes (C) measurably lifts a cheap model on FRAMES. Both are NULL-to-backfire.**
>
> - **A — baseline** (single cold agentic solve): **52.5%** (21/40)
> - **B — parallel-selves** (K=4 agenticow memory branches, verifier-judge): **47.5%** → **−5.0pp** (backfire), at **4.2× the cost**. Majority-vote view: 50.0% → −2.5pp.
> - **C — memory-evolution** (Darwin, P=6 × G=3, 18 unique genomes): **gen0 best 52.5% → gen3 best 52.5% = +0.0pp**. The *maximum resolve any of the 18 evolved genomes ever reached is 52.5% — exactly the baseline.* The evolved "best" genome **is literally the plain baseline** (single cold solve, no memory). Population mean fell (50.0% → 48.3%).
>
> This corroborates the standing thesis on this repo: **cognition comes from the model, not the substrate.**
> RAG came back null; scaffolding self-consistency/verifier-BoN *backfired* (−4/−6pp) in the prior FRAMES
> ablation; and now **branchable memory + evolution over it is null too.** The substrate (agenticow
> COW branching, leave-one-out experience replay, Darwin search) all *worked mechanically* — it just
> bought **zero** extra correctness for deepseek-v4-pro on this everyday-agentic task.

All confidence intervals overlap heavily (Wilson 95% width ≈ ±15pp at n=40), so even the −5pp B backfire
is not statistically separable from baseline. The defensible claim is **"no measurable lift,"** not
"a proven loss." But there is decisively **no lift**, and the costlier conditions trend *worse*.

---

## Setup (state it plainly)

| Knob | Value |
|---|---|
| Model | `deepseek/deepseek-v4-pro` (a cheap CN frontier model) |
| Dataset | FRAMES (`google/frames-benchmark`), the open GAIA-class multi-hop QA proxy |
| Sample | **n = 40, seed = 42** (the same deterministic subset across all conditions) |
| Reasoning setting | **OFF** — no OpenRouter `reasoning` API param; *all* of B/C is prompt/orchestration-level only, consistent with the prior FRAMES runs this is compared against |
| Tool surface | keyless Wikipedia `search`/`open`/`submit` ReAct loop, max 12 steps |
| Scorer | GAIA-style normalized exact-match (numeric/list/string pathways), Wilson 95% CI |
| Memory substrate | **agenticow@0.2** — COW vector branching (`fork`/`query`/`lineage`), native ANN |
| Evolution | reuse of the Darwin `evolve-config.mjs` population→mutate/crossover→elitism pattern |

**Conformance firewall (audited):** the gold `Answer` is **never** placed in any prompt or memory. The
object handed to every solve path carries only `{task_id, question, _idx}` — gold is dropped by
construction. Gold touches **only** the scorer / the evolutionary fitness, **after** each episode
finishes. The episodic memory holds the model's **own** prior attempts (gold-free), recalled
**leave-one-out** (a question never recalls itself).

**Empty-response audit** (the known FRAMES artifact): A 10.0% empty · B 2.5% empty (the parallel
selves + salvage fill more answers, but filling them did not make them *correct*).

---

## What was built (the three pieces, wired)

`packages/darwin-mode/bench/cognition/` — a new harness that does **not** touch the product agents:

- **`cognition-harness.mjs`** — the substrate: a $0 deterministic lexical embedder, an agenticow
  episodic store (one vector per FRAMES question; payload = the model's own prior attempt), a
  fork-and-query leave-one-out recall path, the four context-shaping **branch kinds**
  (`cold` / `mem` / `decomp` / `memdecomp`), majority- and verifier-selectors over K selves, and an
  on-disk **episode cache** keyed by `(model, maxSteps, question, branch-shaping-signature)`.
- **`run-cognition.mjs`** — the A/B/C driver: a bounded worker pool, the authoritative absolute-USD
  account meter gate, and the Darwin loop (seed population → evaluate → elitism + mutate/crossover).
- **`aggregate.mjs`** — turns the result JSONs into the table + chart below.

The episode cache is what made C affordable and reproducible: because the episodic store is **pre-built
and static** during B/C (leave-one-out), every episode is a deterministic function of its shaping
signature, so the evolutionary search reuses building blocks across generations (cold selves are shared
with A; later generations are mostly cache hits). Cache over the whole run: **840 hits / 1000 misses.**

---

## Results

| Condition | n | correct | resolve | Wilson 95% CI | empty | $/task | lift vs A |
|---|---|---|---|---|---|---|---|
| **A — baseline** (cold single) | 40 | 21/40 | **52.5%** | [37.5, 67.1] | 10.0% | $0.0156 | — (reference) |
| **B — parallel-selves K=4** (verifier-judge) | 40 | 19/40 | **47.5%** | [32.9, 62.5] | 2.5% | $0.0659 | **−5.0pp** |
| **B — parallel-selves K=4** (majority-vote) | 40 | 20/40 | **50.0%** | [35.2, 64.8] | 2.5% | $0.0659 | **−2.5pp** |
| **C — evolved gen0 best** | 40 | 21/40 | **52.5%** | [37.5, 67.1] | — | $0.0156* | +0.0pp |
| **C — evolved gen3 best** | 40 | 21/40 | **52.5%** | [37.5, 67.1] | — | $0.0156* | **+0.0pp** |

\* The C "best" genome **is** the baseline genome (`sv1·ek0·t0·majority·cold` = single cold solve), so
its true per-task cost equals A's $0.0156; the search re-emits it at $0 because the episode is cached.

```
FRAMES resolve (deepseek-v4-pro, n=40, seed 42, reasoning OFF)
A baseline                │████████████████████████████████                             52.5%
B selves (verifier)       │█████████████████████████████                                47.5%
B selves (majority)       │██████████████████████████████                               50.0%
C evolved gen0            │████████████████████████████████                             52.5%
C evolved gen3            │████████████████████████████████                             52.5%
                          └────────────────────────────────────────────────────────────> 100%
```

### Condition C — the per-generation curve (the genuinely open question)

| gen | genomes evaluated | best resolve | best CI | population mean | best genome |
|---|---|---|---|---|---|
| 0 | 6 | 52.5% | [37.5, 67.1] | 50.0% | `sv1·ek0·t0·majority·cold` (baseline) |
| 1 | 6 | 52.5% | [37.5, 67.1] | 48.3% | `sv1·ek0·t0·majority·cold` (baseline) |
| 2 | 6 | 52.5% | [37.5, 67.1] | 50.0% | `sv1·ek0·t0·majority·cold` (baseline) |
| 3 | 6 | 52.5% | [37.5, 67.1] | 48.3% | `sv1·ek0·t0·majority·cold` (baseline) |

**gen3 − gen0 best = +0.0pp.** Across **all 18 unique genomes** evaluated over the 4 generations, the
full set of resolve values observed was **{42.5, 45.0, 47.5, 50.0, 52.5}%** — the **maximum is 52.5%,
the baseline.** No memory-shaped, multi-branch, or verifier-gated genome ever exceeded a single cold
solve. The baseline survives at the top of every generation **only because of elitism**; selection had
nothing better to promote. The population *mean* drifts down, i.e. most shaping is mildly harmful.

---

## Interpretation

1. **Parallel-selves (B) backfires, same as the scaffolding ablation.** Verifier-gated Best-of-N over
   memory branches lands at 47.5% (−5.0pp); the cheaper majority view at 50.0% (−2.5pp). This matches
   the prior FRAMES finding that the verifier-judge *under*-selects for a cheap model (it cannot
   reliably tell its own good answer from a bad one), so adding a selection layer over diverse branches
   **adds variance, not skill.** Diversifying the *memory/context* of the branches (vs. just the
   temperature) did not rescue it.

2. **Evolving the memory/context-shaping policy (C) is null.** Given a search space that includes
   episodic-replay depth, decomposition memos, branch count, temperature, selector, and seed-spread,
   the fittest policy the evolution can find is **"don't shape anything — just solve once, cold."**
   The substrate is real (agenticow branched and recalled correctly; the leave-one-out neighbors were
   genuine), but the *content* it surfaces — the model's own prior attempts on lexically-similar FRAMES
   questions — is not useful cognition for the next, entity-distinct question. There is no transferable
   "experience" to replay because each FRAMES item turns on its own specific multi-hop fact chain.

3. **This is the expected, honest result.** Cognition lives in the model's weights. A memory substrate
   can *store and route* what the model produces; it cannot manufacture reasoning the model doesn't
   already have. RAG was null here; scaffolding self-consistency/verifier-BoN backfired here;
   branchable-memory + evolution-over-it is null here. Three different "external cognition" substrates,
   same verdict on everyday-agentic QA for a cheap model.

### Equal-dollar framing

B costs **4.2× per task** ($0.0659 vs $0.0156) and resolves **worse**. At an equal dollar budget you
could instead run the plain baseline on **~4.2× more questions** — strictly the better spend. The
Condition-C *search itself* cost **$15.81** of metered inference to discover that the best policy is the
free one (do nothing). Under any equal-dollar accounting, **the baseline dominates.**

---

## Honesty, limitations, threats to validity

- **n = 40 is small.** Wilson CIs are ~±15pp wide and all overlap. The strong claim "B loses" is *not*
  statistically supported; the supported claim is **"no measurable lift from B or C, and they trend
  worse / flat."** The C result is the cleaner signal: the *ceiling over 18 genomes* equals baseline.
- **Lexical embedder.** agenticow recall used a deterministic $0 hashing-TF embedding, not a neural one.
  This tests the **branching substrate + experience-replay mechanism**, not embedding quality. But a
  prior real-embedding RAG attempt on this stack also returned null, so a better embedder is unlikely
  to flip the verdict — and if anything, FRAMES neighbors are semantically unrelated regardless of
  embedder, so there is little useful signal to recall.
- **Reasoning OFF.** Held constant across all conditions and consistent with the comparison runs. A
  reasoning-ON model is a different (and much more expensive) regime; not tested here.
- **Single cheap model.** deepseek-v4-pro only. A weaker model *might* benefit more from scaffolding
  (more headroom), but the thesis under test was specifically about lifting a *cheap* model cheaply.
- **Conformance:** verified gold-free in every solve path; gold used only for scoring/fitness.

## Spend

- Experiment-metered inference (sum of OpenRouter `usage.cost`): **A $0.62 + B $2.64 + C $15.81 ≈ $19.1.**
- Authoritative account meter moved **+$45.88** over the ~2.2h window ($2668.79 → $2714.67); the
  difference vs. the $19.1 metered figure is attributable to concurrent activity on the shared
  OpenRouter key during the window (other sessions), not this experiment alone.
- Budget **+$70** respected; the absolute-usage abort gate ($2738) was **never** tripped (`halted=false`).

## Reproduce

```bash
# wiring test ($0, offline):
node packages/darwin-mode/bench/cognition/run-cognition.mjs --phase all --mock --n 8 \
  --manifest "$PWD/packages/darwin-mode/bench/ruvector/data/manifest-frames-n40.json" --out /tmp/cog-mock

# full experiment (paid):
node packages/darwin-mode/bench/cognition/run-cognition.mjs \
  --phase all --model deepseek/deepseek-v4-pro --n 40 --seed 42 --K 4 --pop 6 --gens 3 \
  --concurrency 8 --meter --abort-usage 2738 --max-cost 65 \
  --manifest "$PWD/packages/darwin-mode/bench/ruvector/data/manifest-frames-n40.json" \
  --out "$PWD/packages/darwin-mode/bench/cognition/runs"

# aggregate:
node packages/darwin-mode/bench/cognition/aggregate.mjs packages/darwin-mode/bench/cognition/runs
```

## Artifacts

- Harness: `packages/darwin-mode/bench/cognition/{cognition-harness,run-cognition,aggregate}.mjs`
- Raw results: `packages/darwin-mode/bench/cognition/runs/results-{A,B,C,ABC}.json`,
  `preds-{A-baseline,B-selves}.jsonl`, `episode-cache.json`, `episodic.rvf` (agenticow store)
- This report: `docs/research/cognition/COGNITION-EVOLVE-RESULTS.md`
