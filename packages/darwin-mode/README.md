# @metaharness/darwin

> Darwin Mode — **the model is frozen; the harness evolves.**

Bounded, empirical, population-based self-improvement of an agent harness
(ADR-070…075). "Self-improving agents" is widely misread as "the model trains
itself." Darwin Mode ships the practical version: an agent **modifies its own
harness**, runs benchmarks in a sandbox, keeps the variants that *measurably*
improve, and builds an **archive of successful descendants**. The foundation
model never changes — what evolves is the operating system around it (planner,
context builder, reviewer, retry/tool/memory/score policy). This follows the
**Darwin Gödel Machine** lineage: iteratively mutate the source of a coding
agent, then *empirically validate* each variant — no weight updates, just a
population, a benchmark, and an archive.

```
repo
  → profile      RepoProfile (pkg mgr, test cmd, source/risk files)
  → baseline     generate the seven mutation-surface files
  → mutate       pick ONE approved surface, perturb it (behind the gate)
  → sandbox      safety-inspect → run the test command (no shell, no net, no secrets)
  → score        weighted base score − hard penalty layer
  → archive      record parent→child as a TREE (not a single best branch)
  → select       sample the next generation from the WHOLE archive
  → repeat
```

Dependency-free: **Node ≥ 20 built-ins only**, no runtime dependencies.

## Quick start

Build (TypeScript → `dist/`):

```bash
npm run build      # tsc
```

Then evolve a repo with the CLI (one verb, `evolve`):

```bash
metaharness-darwin evolve <repo> [--generations N] [--children N] [--concurrency N] [--seed N] \
    [--bench <suite.json>] [--tie faster] \
    [--selection score|quality-diversity|behavioral-diversity|niche-steering|clade|pareto] \
    [--crossover] [--epistasis] [--risk-budget N] [--fdr Q] [--curriculum]
```

| Flag | Meaning | Default |
|------|---------|---------|
| `--generations N` | number of generations to run | `3` |
| `--children N`    | children produced per parent per generation | `4` |
| `--concurrency N` | max variants evaluated concurrently (bounded fan-out) | `4` |
| `--seed N`        | deterministic seed for mutation selection | `0` |
| `--bench <suite.json>` | route promotion through the statistical benchmark gate (ADR-087) | off |
| `--tie faster`    | break score ties by efficiency (ADR-086) | `insertion` |
| `--selection …`   | parent-selection strategy (see *Evolutionary stack*) | `score` |
| `--crossover`     | recombine two parents' surfaces (ADR-089) | off |
| `--epistasis`     | topology-aware crossover via learned linkage (ADR-093) | off |
| `--risk-budget N` | SGM cumulative risk cap on promotions (ADR-090) | off |
| `--fdr Q`         | Benjamini-Hochberg FDR control on promotion (ADR-096) | off |
| `--curriculum`    | difficulty-ladder over a graded suite (ADR-097) | off |

All flags are **opt-in and additive** over a frozen, reproducible core — every default-path run is byte-identical to the ADR-070…075 baseline.

The `<repo>` argument defaults to the current directory. Everything is written
under a self-describing `.metaharness/` work tree inside the repo:

```
<repo>/.metaharness/
├── archive.json          # the population TREE: ArchiveRecord[] (variant + score + children)
├── lineage.json          # serialized graph { nodes, edges } for rendering
├── variants/             # one directory per variant (its mutation-surface files)
│   ├── baseline/
│   ├── g1_v0/  …
├── runs/                 # one <variantId>.json per variant: { traces, score }
└── reports/
    └── winner.json       # the best scored ArchiveRecord
```

Sample run output (leaderboard + winner lineage, printed to stdout):

```
Darwin Mode — leaderboard
  0.842  g2_v1  [contextBuilder]  safety=1.00  pass=1.00 ◀ winner
  0.791  g1_v0  [reviewer]        safety=1.00  pass=1.00
  0.788  baseline  [planner]      safety=1.00  pass=1.00
  0.000  g1_v3  [toolPolicy]      safety=0.00  pass=0.00

Winner: g2_v1
Lineage: baseline → g1_v0 → g2_v1
Delta over baseline: +0.054

Artifacts: <repo>/.metaharness
```

## The seven mutation surfaces

A child variant may mutate **exactly one** surface per generation, and a variant
directory may contain **only** these seven files — nothing else (the allowlist is
enforced by `safety.ts`, see `FILE_BY_SURFACE` / `APPROVED_FILES`). Each surface
is pure, side-effect-free policy logic over injected data.

| Surface (`MutationSurface`) | File | Governs |
|-----------------------------|------|---------|
| `planner`        | `planner.ts`         | task string → ordered plan steps (map → inspect → patch → verify) |
| `contextBuilder` | `context_builder.ts` | ranks candidate files by term overlap with the task |
| `reviewer`       | `reviewer.ts`        | flags changed files against an injected risk-file list + test outcome |
| `retryPolicy`    | `retry_policy.ts`    | whether/how to retry given a symbolic failure classification |
| `toolPolicy`     | `tool_policy.ts`     | allow-list + deterministic ordering over symbolic command kinds |
| `memoryPolicy`   | `memory_policy.ts`   | whether an outcome record is worth remembering |
| `scorePolicy`    | `score_policy.ts`    | the weight vector a variant *proposes* over the positive scoring terms |

A variant may *propose* score weights via `scorePolicy`, but it can never
re-grade itself: the verdict that decides promotion is computed by the frozen
kernel scorer (see below), not by the variant's own file.

## Scoring and the promotion gate

The scorer (`src/scorer.ts`, ADR-072) is a **pure function** — re-running it on
the same traces yields an identical verdict. It is a weighted base score over six
`[0,1]` terms (weights from `scoreWeights()`, summing to 1.0):

```
baseScore = 0.35·taskSuccess + 0.20·testPassRate + 0.15·traceQuality
          + 0.10·costEfficiency + 0.10·latencyEfficiency + 0.10·safetyScore
```

minus a hard **penalty layer** read out of the run traces (a single safety
violation can drive the final score negative — that is the point):

```
finalScore = baseScore − 0.30·secretExposure − 0.25·destructiveAction
                       − 0.20·hallucinatedFile − 0.15·toolLoop − 0.10·costOverrun
```

A child replaces its parent only when **all four** promotion clauses hold
against the parent:

```
1. beatsParent       finalScore > parentFinalScore + promotionDelta   (default delta 0.05)
2. safetyOk          safetyScore ≥ 0.95
3. noRegression      testPassRate ≥ parentTestPassRate
4. noBlockedActions  safetyScore == 1.0  (zero blocked actions in any trace)
```

Non-promoted variants are **retained**, not deleted — "did not clear the gate"
means "not chosen as a parent by the default policy," never "removed."

## The archive: evolve like species, not release like software

The archive (`src/archive.ts`, ADR-073) is a **tree** of variants keyed by id and
persisted as `archive.json`, not a single best branch. Selection
(`selectParents`) samples the **whole** archive — including older, non-promoted
branches — which is how evolution escapes hill-climbing: when a generation
stalls (no promotions), a weak-looking ancestor can still seed a strong branch.
Insertion order is preserved, so `best()`, tie-breaks, and `selectParents` are
all deterministic and reproducible from `archive.json` alone.

## Safety model

A self-modifying agent that can edit anything is a liability. Darwin Mode's bound
is enforced in `src/safety.ts` (ADR-071) as the **load-bearing security
boundary**, with two independent, defense-in-depth checks:

- **`inspectVariant(dir)`** runs *before any variant executes*. It disqualifies a
  variant directory containing anything other than the seven approved files, a
  blocked filename (`.env`, `secret`, `id_rsa`, `.git`, `package.json`, …), a
  symlink or nested directory, or blocked content (`process.env`,
  `child_process`, `eval`, `fetch`, restricted node builtins, shell strings, …).
- **`validateGeneratedCode(code)`** runs *before generated code is written to
  disk* (the LLM-mutator path). Independent pattern set; a violating generation
  is **discarded**, never repaired in place.

The gate runs **first**: a disqualified variant never has its test command run —
the sandbox seals the trace with the reserved exit code `99` and records the
findings as `blockedActions`, which zeroes `safetyScore` and makes promotion
impossible. When a variant *is* admitted, the sandbox (`src/sandbox.ts`) is
**shell-free** (the test command is split to argv and run via `execFile`, never a
shell — no command-injection surface) and runs under a **scrubbed environment**
(only `PATH` plus three identifying variables; nothing else from `process.env`
leaks, so secrets, tokens, and proxy settings never reach a variant).

See [`SECURITY.md`](../../SECURITY.md) for the full threat model.

## Programmatic API

```ts
import { evolve } from '@metaharness/darwin';

const result = await evolve({
  repoRoot: '/abs/path/to/repo',
  workRoot: '/abs/path/to/repo/.metaharness',
  generations: 3,
  childrenPerGeneration: 4,
  concurrency: 4,
  promotionDelta: 0.05,
  seed: 0,
  tasks: [
    'run repository test suite',
    'verify generated harness safety',
    'check trace quality',
  ],
});

result.winner;        // the best scored ArchiveRecord (or null)
result.winnerLineage; // ['baseline', 'g1_v0', 'g2_v1'] — root → winner
result.records;       // every ArchiveRecord, in insertion order
result.baseline;      // the baseline record
```

The package also re-exports the building blocks behind `evolve`: `profileRepo`,
`generateBaselineHarness`, `createChildVariant`, `DeterministicMutator` /
`CodeGenerator`, `runVariantTask` / `runVariantTasks`, `scoreVariant` /
`scoreWeights`, `Archive`, `inspectVariant` / `validateGeneratedCode`, plus the
`SURFACES`, `FILE_BY_SURFACE`, and `APPROVED_FILES` constants.

## Evolutionary stack (ADR-084–105)

The baseline above is the frozen core. On top of it, a set of **opt-in, additive,
reproducible** mechanisms turn the loop from a single-best search into a real
evolutionary algorithm. Every one is off by default (so the core stays
byte-identical) and individually toggled:

| Capability | ADR | How to enable |
|---|---|---|
| **Failure-driven mutation** — feed a parent's failing traces into the mutator | 084 | always (the deterministic mutator ignores it) |
| **LLM mutator** — `OpenRouterMutator` as a `CodeGenerator`, behind the same safety gate; model chosen by a 15-model execution benchmark | 085 | `config.generator` |
| **Efficiency tie-break** — break score ties by speed | 086 | `--tie faster` |
| **Graded statistical promotion** — public∧hidden∧regression∧safety + seeded bootstrap CI over a hash-pinned suite | 087 | `--bench s.json` |
| **MAP-Elites** — keep the elite per behaviour niche | 088 | `--selection quality-diversity` |
| **Genetic crossover** — recombine two parents' surfaces | 089 | `--crossover` |
| **SGM risk budget** — bound cumulative self-modification | 090 | `--risk-budget N` |
| **Hyperbolic phenotyping** — Poincaré-ball behavioural niche from traces | 091 | `--selection behavioral-diversity` |
| **Active niche steering** — drive toward under-explored regions | 092 | `--selection niche-steering` |
| **Epistatic linkage** — topology-aware crossover of co-adapted surfaces | 093 | `--crossover --epistasis` |
| **Clade metaproductivity** — select parents by descendant potential (Huxley-Gödel) | 094 | `--selection clade` |
| **Benjamini-Hochberg FDR control** — correct promotion for multiple testing | 096 | `--fdr Q` |
| **Self-directed curriculum** — difficulty ladder over a graded suite | 097 | `--curriculum` |
| **Multi-objective Pareto** — non-dominated (capability × parsimony) front | 100 | `--selection pareto` |

### The evaluation substrate (ADR-101/102)

By default the sandbox runs the **repo's test command**, which is independent of
the harness surfaces — so the behavioural manifold is degenerate (measured:
`nicheEntropy = 0`, ADR-099). `sandboxMode: 'mock'` (ADR-102) instead runs a
**deterministic surface-driven agent loop**, so a variant's traces depend on its
surface content and the manifold comes alive. The full real-agent substrate
(surfaces driving an LLM on real coding tasks → SWE-bench) is **ADR-101/098,
deferred**.

### Validated results (real, reproducible — see `bench/results/`)

- **Manifold goes live** (ADR-102): real `nicheEntropy 0 → 0.69`, finalScores
  `flat 0.985 → spread 0.435–0.802` under mock mode.
- **Self-improvement** (ADR-103): the loop evolves `contextBuilder` (window
  30 → 70) and climbs `finalScore 0.765 → 0.985` by generation 3.
- **Diversity beats greedy on deception** (ADR-105): on a deceptive epistatic
  landscape across 5 seeds, greedy `score` selection crosses it **0/5**,
  `behavioral-diversity` **5/5**, `clade` **4/5** — empirically justifying the
  diversity machinery.
- **Polyglot model frontier** (ADR-085): 15 models × 6 languages, execution-scored;
  DeepSeek-V3 ($0.4/Mtok) tops quality-per-dollar — cheap beats frontier for code.

## Status

**Working prototype, empirically validated (mock substrate).** The
`DeterministicMutator` is seeded and signature-preserving; the `OpenRouterMutator`
(ADR-085) is the production LLM `CodeGenerator`, behind the *same*
`validateGeneratedCode` gate. The safety boundary, scorer, archive, and bench
layer are kernel code. The frontier is **Tier-2 real-agent execution**
(ADR-101/098): surfaces driving a real LLM on real tasks, which turns the
validated mock instrument into real-world SWE results.

## License

MIT © rUv. See ADRs
[070](../../docs/adrs/ADR-070-darwin-mode-self-improving-harness.md) ·
[071](../../docs/adrs/ADR-071-darwin-mutation-surfaces-safety-allowlist.md) ·
[072](../../docs/adrs/ADR-072-darwin-scoring-and-promotion.md) ·
[073](../../docs/adrs/ADR-073-darwin-archive-and-selection.md) ·
[074](../../docs/adrs/ADR-074-darwin-ruvector-memory-ruflo-fabric.md) ·
[075](../../docs/adrs/ADR-075-darwin-prototype-roadmap-and-acceptance.md),
and the [repository](https://github.com/ruvnet/agent-harness-generator).
