# ADR-155: Darwin Shield — evolving a defensive zero-day discovery harness

**Status**: Proposed (reference implementation landed — see §Reference implementation)
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-SHIELD`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Defensive vulnerability discovery and remediation on **owned or authorized** repositories
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer), ADR-073 (archive), ADR-074 (Darwin ↔ ruVector memory fabric), ADR-076 (parent-vs-child benchmark), ADR-077–081 (DGM/HGM/SGM/Hyperagents → Darwin Plus synthesis), ADR-082 (expected gains + effective-performance metric), ADR-153 (agentic-loop architecture)

> This is the security application of the Darwin Plus stack (ADR-077…081). It changes the *task* — defensive vulnerability discovery instead of SWE-bench repair — and the *fitness function*, but keeps the load-bearing thesis intact: **the foundation model stays frozen; the harness evolves; the proof is in replay.** The spec this ADR ratifies was drafted internally as "ADR-301"; it is recorded here under the repo's sequential numbering (ADR-NNN, never renumber) per the INDEX conventions.

## Context

Current AI security tooling falls into three buckets, each optimizing the model while treating orchestration as fixed:

1. **Static analyzers** (Semgrep, CodeQL, `cargo audit`, OSV) — precise but high false-positive, no remediation.
2. **LLM security assistants** — single-pass review of ranked files; capability-bound, not loop-bound.
3. **Autonomous security agents** — fixed multi-agent workflows; no empirical self-improvement.

The evidence from the Darwin Gödel Machine (ADR-077, arXiv:2505.22954) and AISLE-style vulnerability research is that most of the gain comes from **orchestration, not the foundation model**: workflow decomposition, retrieval quality, validation loops, tool selection, context engineering, and iterative review. DGM showed SWE-bench 20→50% and Polyglot 14.2→30.7% from *harness* changes alone (editing tools, long context, peer review) — the model was never trained.

The opportunity: apply the same population → mutate → score → select → archive loop to **defensive** software security. The model remains frozen. The harness evolves. Findings are validated by tests, fuzzers, and sanitizers, stored in ruVector (ADR-074) so the system compounds across runs, and every output passes a hard safety gate before it leaves the sandbox.

**This is a defensive system.** The "zero-day" in the title is the *defender's* zero-day: surfacing an unknown weakness in your own code before an attacker does, and shipping a tested patch. It is not an exploit generator.

## Decision

Build **Darwin Shield**: a Darwin-Mode-based defensive security harness, coordinated by RuFlo as an evolving agent swarm, that continuously evolves vulnerability-discovery workflows through empirical, reproducible evaluation. It shall:

- **mutate** harness configurations (planner, retrieval, reviewer count, retry budget, toolset, model mix, fuzz budget);
- **evaluate** each variant on a curated security corpus + authorized OSS;
- **select** superior descendants by clade metaproductivity (ADR-078), not just best-of-run;
- **archive** genomes, findings, patches, and benchmark receipts in SQLite + ruVector (ADR-073/074);
- **reject** unsafe outputs unconditionally (the only `-∞` term in the fitness function).

Hard invariants:

```
model_frozen      = true     # no model training; only orchestration evolves
harness_evolves   = true
scope             = owned_or_authorized_repos
unsafe_output     = rejected # immediate, before and after every model call
exploit_payloads  = forbidden
```

### Non-goals

The system shall not generate weaponized exploit chains, attack external systems, perform autonomous offensive actions, bypass authorization controls, or create malware/persistence/evasion tooling. `Finding.exploitCodeAllowed` is hard-coded `false`. Output is patches, advisory drafts, failing repro tests, and risk reports — never working exploits.

### Architecture

```
                  ┌───────────────┐
                  │ Darwin Engine │   mutate · evaluate · select · archive
                  └───────┬───────┘
                          ▼
              ┌─────────────────────┐
              │ Harness Population  │   (16 genomes × 50 cycles, default)
              └─────────┬───────────┘
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
     Planner     Context Builder     Reviewer
        └───────────────┼───────────────┘
                        ▼
                Security Agents (RuFlo swarm)
                        ▼
          Static + Dynamic Analysis (Semgrep/CodeQL/audit · fuzz/sanitizers)
                        ▼
                Findings + Patches
                        ▼
                  Safety Filter      ← reject unsafe; redact exploit code
                        ▼
              Archive / Receipts (SQLite + ruVector)
```

### Rust workspace (crates)

| Crate | Responsibility |
|---|---|
| `darwin-core` | mutation, crossover, evaluation, lineage, population management |
| `darwin-swarm` | RuFlo-coordinated agent topology + message contracts |
| `darwin-security` | repo analysis, weakness detection, patch proposals, remediation validation |
| `darwin-eval` | scoring, benchmark execution, fitness calculation |
| `darwin-archive` | genomes, findings, patches, benchmarks, receipts (SQLite) |
| `darwin-sandbox` | sandboxed tool/fuzz/test execution (Docker via `bollard`, WASM via `wasmtime`) |
| `darwin-policy` | scope validation, exploit redaction, disclosure policy, safety gates |
| `darwin-ruvector` | semantic + structural code memory (collections below) |
| `darwin-cli` | `darwin-security scan|bench|swarm` entrypoint |

Companion TypeScript packages: `ruflo_swarm`, `security_agents`, `benchmark_runner`, `policy_guard` (RuFlo workflow, agent implementations, bench harness, MCP-exposed policy guard).

### Genome

```ts
type HarnessGenome = {
  id: string
  parentId?: string
  planner: "file-first" | "sink-first" | "diff-first" | "callgraph-first" | "risk-first" | "memory-first"
  contextPolicy: "minimal" | "semantic" | "callgraph" | "hybrid"
  reviewerCount: number          // clamp 1..5
  retryBudget: number            // clamp 1..6
  fuzzBudgetSeconds: number      // clamp 10..600
  tools: string[]
  modelMix: string[]
  validationPipeline: string[]
  safetyProfile: "strict-defensive"   // never mutated
}
```

Mutation operators (bounded; `safetyProfile` is immutable and the policy/scorer are never self-editable per ADR-071/080): planner family swaps; retrieval `semantic → semantic+graph → hybrid`; reviewer count ±1; retry budget ±1; fuzz budget ×{0.5,1,2}; tool enable/disable over the allowlisted set (Semgrep, CodeQL, `cargo-audit`, Trivy, `cargo-fuzz`, …).

### Agent topology (RuFlo swarm)

`SwarmCoordinator` → `repo-profiler` · `file-ranker`/`risk-ranker` · `context-builder` · `hypothesis-generator` · `static-analysis-runner` · `fuzz-runner` · `patch-writer` · `reviewer` (adversarial: tries to *disprove* findings to kill hallucinations) · `safety-redactor` · `disclosure-writer` · `archive-curator`.

The reviewer's job is falsification, not confirmation; reviewer disagreement is itself a quality signal fed back to ranking.

### Findings + scoring

```ts
type Finding = {
  repo: string; commit: string; file: string; symbol?: string
  weakness: string; confidence: number
  evidence: string[]; patch?: string; test?: string
  verdict: "confirmed" | "false_positive" | "needs_review"
  exploitCodeAllowed: false      // hard invariant
}
```

Operational scoring (per-finding promotion):

```
score = 0.35·confirmed_repro
      + 0.25·patch_passes_tests
      + 0.20·static_tool_agreement
      + 0.10·novelty
      + 0.10·maintainer_acceptance
      - 0.30·false_positive
      - 1.00·unsafe_output          # immediate rejection
```

Benchmark fitness (genome selection — `DARWIN-SHIELD-BENCH`):

```
fitness = 0.30·true_positive_rate
        + 0.20·patch_test_pass_rate
        + 0.15·reproduction_success
        + 0.15·false_positive_reduction
        + 0.10·time_to_finding
        + 0.10·cost_efficiency
        - 1.00·unsafe_output
```

### ruVector memory (ADR-074 fabric, security collections)

Seven collections — `code_chunks`, `callgraph_nodes`, `confirmed_findings`, `false_positives`, `patches`, `genomes`, `benchmark_receipts` — with the `SecurityVectorMeta` schema (repo/commit/language/path/symbol/chunk_type/risk_tags/callgraph_degree/taint_role/finding_id/genome_id/benchmark_id/verdict).

Hybrid retrieval rank:

```
rank = 0.45·vector_similarity
     + 0.20·callgraph_centrality
     + 0.15·taint_sink_proximity
     + 0.10·historical_finding_similarity
     + 0.10·recent_change_weight
     - 0.25·false_positive_similarity   # negative memory: don't repeat dead hypotheses
```

Memory is what makes Darwin Shield *compound*: cycle 1 of a new repo seeds its population from nearest prior winning genomes (`seed_population`), retrieves accepted patches for similar historical issues as patch-agent context, and down-ranks hypotheses similar to past false positives. Without memory each run starts from zero; with it, the next repo starts smarter.

Key API (`darwin-ruvector`):

```rust
impl RuvSecurityMemory {
    pub async fn index_repo(&self, repo: RepoRef) -> Result<IndexReport>;
    pub async fn retrieve_context(&self, q: SecurityQuery, p: RetrievalPolicy) -> Result<SecurityContext>;
    pub async fn write_receipt(&self, r: BenchmarkReceipt) -> Result<()>;
    pub async fn seed_population(&self, profile: RepoProfile, k: usize) -> Result<Vec<HarnessGenome>>;
}
```

### Safety controls (mandatory gates)

Scope gate · repo-ownership gate · secret-scanning gate · unsafe-output gate · exploit-redaction gate · network-isolation gate · human-approval gate · audit-receipt gate. The policy filter runs **before and after every model call** (ADR-071 gate-first). Human approval is required before any patch merge, disclosure publication, or production deployment.

Sandbox (`darwin-sandbox`): no external network by default, read-only repo mount, write only to workspace, time-boxed execution, memory limits, tool allowlist, full trace logging. Reject any output containing credential theft, persistence, evasion, live exploitation, weaponized payloads, or third-party targeting.

### CLI (MVP)

```bash
darwin-security scan ./repo \
  --scope owned \
  --baseline semgrep,codeql,cargo-audit \
  --population 16 --cycles 50 \
  --policy strict-defensive \
  --output ./receipts

darwin-security swarm ./repo \
  --scope owned --cycles 50 --population 16 \
  --policy strict-defensive --memory ruvector --receipts ./receipts

darwin-security bench \
  --corpus ./bench/corpus \
  --baselines static,llm,fixed-agent,darwin \
  --cycles 50 --population 16 \
  --policy strict-defensive --out ./bench/results
```

## Consequences

**Positive**: continuously improving, model-agnostic security workflows; full auditability via receipts; a compounding security-intelligence archive (ruVector); differentiation that lives in the *evolving harness + empirical loop + lineage archive*, not the model. **Negative**: higher compute (population × cycles × fuzzing); benchmark-maintenance burden; requires curated evaluation datasets; gains are capped by corpus quality. **Strategic**: positions Darwin Mode as a practical self-improving agent for *defensive* security — the moat is the loop, not the weights.

## Alternatives considered

1. **Buy/wrap a single static analyzer or LLM assistant** — rejected: that is baseline `B0`/`B1`; no compounding, no remediation loop, and the FP rate is the core pain point.
2. **Fixed multi-agent harness, no evolution** (`B2`) — rejected as the *product*, kept as the mandatory benchmark baseline: Darwin Mode is not accepted as "self-improving" unless it beats `B2` on confirmed defensive findings without raising unsafe-output risk.
3. **Fine-tune a security model** — rejected: violates `model_frozen`; the DGM/AISLE evidence says orchestration dominates; training adds cost, opacity, and contamination risk for a smaller marginal gain.
4. **Reuse ADR-076's SWE fitness directly** — rejected: SWE solve-rate is the wrong target; security needs TPR/FPR/repro/safety terms and a hard `unsafe_output` rejection, hence a dedicated fitness function and corpus.
5. **Offensive/red-team variant** — out of scope by invariant; see Non-goals. The platform is strictly defensive and `exploitCodeAllowed` is hard-coded `false`.

## Test Contract

The decision is "shipped" only when the four-layer test set passes and the benchmark gates are met.

- **Unit** (`darwin-core`/`darwin-policy`): genome mutation stays inside bounds; policy rejects unsafe output (and exploit payloads) deterministically; ranker order is deterministic; archive receipts are reproducible.
- **Integration**: a small repo scan completes end-to-end; Semgrep/CodeQL output parses; ruVector retrieval returns expected chunks; patch agent emits a patch **and** a test; safety agent strips unsafe content.
- **Regression**: a seeded bug is found; a known false positive is rejected; a known patch passes its tests; the same input reproduces the same receipt byte-for-byte.
- **Swarm**: all agents complete; a failed agent retries within budget; a bad genome is eliminated; the champion beats all baselines (`static`, `llm`, `fixed-agent`).

**`DARWIN-SHIELD-BENCH` corpus** (`bench/corpus/{rust,typescript,python,go}`): seeded vulns, real-CVE pre-fix snapshots, and clean repos (FP measurement), with `bench/results/{RESULTS.md,scores.json,lineage.json,findings.json,patches/,receipts/}`.

**Acceptance / Definition of Done** — PASS only when:

| Gate | Target |
|---|---|
| Evolution cycles complete | 50, champion selected, baseline comparison generated |
| Confirmed-finding / TPR improvement vs fixed harness | **≥ +25%** |
| False-positive reduction | **≥ 40%** |
| Patch test-pass rate | **≥ 80%** (all accepted patches include tests) |
| Reproducible findings | **≥ 90%**; every finding has a receipt |
| Unsafe outputs emitted | **0** (hard gate) |
| Cost increase vs fixed harness | **≤ 2×** |
| ruVector: context recall@20 | **≥ 0.85** |
| ruVector: FP repeat-rate drop | **≥ 35%** |
| ruVector: patch-reuse success | **≥ +20%** |
| ruVector: seeded vs random genomes | **≥ +15%** |
| ruVector: retrieval latency p95 | **≤ 150 ms** |

Champion-promotion rule (inherits ADR-076/079): the champion genome must beat the previous champion **and** all baselines on confirmed defensive findings, with statistical certification and **zero** increase in unsafe-output risk.

## Reference implementation

A working, dependency-free reference implementation landed in
`packages/darwin-mode/src/security/` (exported as the `security` namespace from
`@metaharness/darwin`). It models the **orchestration layer** — the actual thesis
— against a deterministic, seeded substrate, so the whole pipeline is reproducible
without the external toolchain (Semgrep/CodeQL/Docker/fuzzers) the production
system would shell out to. The crate layout in this ADR is the production target;
the TypeScript module is the validated prototype that proves the loop.

| Concern | Module |
|---|---|
| Genome, bounded mutation, crossover, baselines | `genome.ts` |
| Safety layer (scope gate, exploit redactor, unsafe-output gate) | `policy.ts` |
| ruVector security memory (7 collections, hybrid + negative memory) | `memory.ts` |
| Swarm agents + capability model (genome → detection / FP power) | `agents.ts` |
| RuFlo-coordinated pipeline + receipts | `swarm.ts` |
| Frozen per-finding score + genome fitness | `scoring.ts` |
| Darwin loop (mutate / evaluate / select / archive) | `evolve.ts` |
| DARWIN-SHIELD-BENCH + acceptance gates | `bench.ts` |

**Status of the acceptance gates** (run: `npm run bench:shield`, or
`metaharness-darwin security bench`; default config pop 16 × 50 cycles, seeded):

| Gate | Target | Measured |
|---|---|---|
| TPR improvement vs fixed harness | ≥ +25% | **+150%** (0.4 → 1.0) |
| FPR reduction | ≥ 40% | **−100%** (0.89 → 0.0) |
| Patch-test pass rate | ≥ 80% | **100%** |
| Reproduction success | ≥ 90% | **100%** |
| Unsafe outputs | 0 | **0** |
| Cost increase vs fixed harness | ≤ 2× | **~1.76×** |
| Reproducible from receipts | 100% | **byte-identical re-run** |
| Champion beats every baseline | yes | **yes** |
| **Beyond SOTA**: champion *statistically* beats the previous champion | lower-95% Δ > 0 | **+0.20 (p=0)**, paired seeded bootstrap, zero unsafe regression |
| Compounding: false-positive repeat-rate drop | ≥ 35% | **100%** (negative memory) |
| Compounding: patch-reuse improvement | ≥ 20% | **100%** (patch memory) |
| Compounding: seeded genomes beat random | ≥ 15% | **+47%** (genome memory) |
| Retrieval recall@20 / latency p95 | ≥ 0.85 / ≤ 150 ms | **met** |

Coverage: 4 baselines (static / LLM single-pass / fixed agent / Darwin), ~100
unit/integration/regression/swarm/perf tests, all deterministic. What is
**mocked vs real**: the evolutionary loop, genome/mutation, safety gate, scoring,
fitness, statistical promotion, and ruVector ranking are real and exercised; the
static-analyzer / fuzzer / sandbox *adapters* are modeled by a seeded corpus
(`corpus.ts`) so the gradient is reproducible — wiring the real tools behind those
adapters is the production follow-up, not a change to the loop.

**Why this is "beyond SOTA", honestly** (`stats.ts`, `ablation.ts`):

- *Statistical*, not point-estimate: a paired seeded bootstrap certifies the
  champion beats the **previous champion** (the pre-evolution fixed harness) with
  the lower-95% per-repo delta > 0 (p = 0) and zero unsafe-output regression —
  the repo's own bar for "self-improving" (ADR addendum, grounded in ADR-079).
- *The harness is the lever*: ablating the champion shows the gain comes from
  **context depth (−0.17), tool breadth (−0.08), and reviewer count (−0.08)** —
  not the frozen model. Honestly, model/memory ablate to ≈0 *within a single run*
  (detection already saturates via static+review); memory's value is **cross-run**
  and is shown separately by the compounding metrics.
- *Unsaturated frontier*: on a deliberately hard corpus (subtle vulns + adversarial
  decoys, `hardCorpus()`) the champion lands at **TPR ≈ 0.6 / FPR ≈ 0.67** — real
  headroom — yet still dominates the fixed harness (fitness ≈ 0.72 vs 0.13). The
  easy-corpus TPR = 1.0 is a property of that corpus, not a ceiling of the method.

## References

- ADR-070–073 — Darwin Mode head, mutation surfaces + allowlist, frozen scorer, archive.
- ADR-074 — Darwin ↔ ruVector memory/RuFlo fabric (the substrate this ADR's seven security collections extend).
- ADR-076 — parent-vs-child benchmark (the five-gate evaluation pattern reused with a security fitness function).
- ADR-077–082 — DGM (arXiv:2505.22954), HGM (arXiv:2510.21614), SGM (arXiv:2510.10232), Hyperagents (arXiv:2603.19461), Darwin Plus synthesis, expected-gains/effective-performance metric.
- ADR-153 — agentic-loop architecture (the bounded ReAct tool surface the security agents run inside).
- Prior art: Darwin Gödel Machine; AISLE-style AI-assisted vulnerability research (orchestration > foundation model); Semgrep, CodeQL, OSV, `cargo audit`/`cargo deny`, Trivy/Grype/Syft, AFL++/libFuzzer/honggfuzz/`cargo-fuzz`.

---

## Addendum A — Bounded self-writing extension for Darwin Shield

**Status**: Proposed (Phase 1 landed — `src/security/selfwrite.ts`)

### Context

Darwin Shield currently evolves a *configuration* genome (planner, context policy,
reviewer count, fuzz budget, retrieval depth, scoring weights). This preserves
deterministic replay and an auditable benchmark, but limits the system to surfaces
that already exist. The Darwin Mode kernel already supports source generation
through a `CodeGenerator` hook whose output is validated before it touches disk and
only on approved surfaces. This addendum extends that pattern to Darwin Shield with
**stricter** security boundaries. The goal is not arbitrary self-modification — it
is bounded generation of *defensive detection logic* judged by a real oracle and
promoted only when it improves validated outcomes with zero unsafe regression.

### Decision

Darwin Shield may add an **opt-in** `ShieldCodeGenerator` path for bounded
detection-surface synthesis. The initial editable surface is **detection-rule
synthesis only**.

- **Allowed generated artifacts**: Semgrep rules, CodeQL query snippets, taint
  heuristics, reviewer prompts, detector configuration modules, adapter
  normalization helpers.
- **Forbidden generated artifacts**: policy-enforcement code, safety-gate code,
  grader code, paired-bootstrap statistics code, corpus manifest code,
  receipt-verifier code, promotion logic, sandbox-isolation code, network-access
  logic, credential-handling logic.

The deterministic config mutator **remains the default**; self-writing is opt-in
and must be explicitly enabled. The safety layer is the referee and stays outside
the evolutionary surface — **the model proposes, the harness disposes.**

### Determinism contract

A generated candidate is eligible only when its receipt stores all of: generation
prompt, model id, seed, generated artifact, formatter output, validator output,
test output, corpus version, tool versions, receipt hash. Promotion must be
reproducible from receipts; a candidate that cannot be replayed cannot become
champion.

### Promotion gate (all ten must pass)

1. paired seeded-bootstrap lower-95% delta > 0; 2. unsafe-output regression = 0;
3. false-positive regression below threshold; 4. true-positive improvement on ≥1
hard-corpus segment; 5. easy-corpus performance does not mask hard-corpus
degradation; 6. receipt replay byte-identical; 7. artifact passes static
validation; 8. artifact stays inside the allowlisted surface; 9. no forbidden file
modified; 10. runtime budget respected.

### Phases

- **Phase 1 (landed)** — interface + deterministic mock generator + mock oracle +
  full receipts + the ten-gate decision: `ShieldCodeGenerator`,
  `GeneratedDetectorCandidate`, `validateGeneratedShieldCode`, `ShieldGenReceipt`,
  `MockDetectorOracle`, `evaluateCandidate`, `synthesizeAndEvaluate`
  (`src/security/selfwrite.ts`, 19 tests).
- **Phase 2 (landed — first real oracle)** — `SemgrepDetectorOracle`
  (`src/security/semgrep-oracle.ts`) runs real `semgrep --json` over a labeled
  on-disk target and scores findings against ground-truth labels. **Optional by
  design**: absent semgrep ⇒ `available:false` and callers skip, so the
  deterministic suite is green everywhere; present semgrep ⇒ real evidence.
  Verified live (semgrep 1.167.0) on `bench/security/fixtures/semgrep`: a generated
  CWE-94 `eval()` rule scored **TP 1, FP 0, precision 1.0, recall 1.0** — caught
  the real `eval(user_input)` and correctly ignored the `evaluate` decoy + clean
  file (receipt: `bench/results/semgrep-oracle-receipt.json`). This is the
  mock→real crossing for the detector path; the fuzzer (`FuzzOracle`) is the next.
  - **In-loop judge (landed)** — `real-loop.ts` makes real Semgrep the JUDGE inside
    the promotion gate, not just a standalone check: a generated rule is scored
    per-file by real `semgrep --json` over a multi-file labeled corpus and promoted
    over the incumbent only when the paired bootstrap certifies it (lower-95% > 0),
    with no FP regression and a byte-identical replay. Verified live (semgrep
    1.167.0): a broad candidate beat an eval-only incumbent, per-file mean
    0.5 → 1.0, **lower95 0.125 (p 0.004), FP 0** — flagged `yaml.load`, ignored
    `yaml.safe_load` (receipt: `bench/results/semgrep-inloop-receipt.json`).
  - **Capstone — real oracle DRIVES the evolution (landed)** — `real-evolve.ts`
    runs the ADR thesis end-to-end with a real tool: a detector population is
    mutated and SCORED BY REAL semgrep over the labeled corpus, selected by
    elitism, and evolved for N generations; the champion is certified vs the
    baseline by the paired bootstrap. Verified live (semgrep 1.167.0, seed 5): a
    weak eval-only baseline (mean 0.5) evolved to the full 5-weakness detector
    (mean 1.0, FP 0) along a climbing learning curve **0.5 → 0.625 → 0.75 → 0.75
    → 0.875 → 1.0** over a 5-step lineage, **lower95 0.125 (p 0.003)** — with a
    fitness cache (36 evaluations, 15 real semgrep calls). This is "real oracle
    judges a candidate" → "real oracle drives the evolutionary search" (receipt:
    `bench/results/semgrep-evolve-receipt.json`).
- **Phase 3** — add CodeQL only after Semgrep + fuzzing are stable.

### Non-goals

No arbitrary source generation; no exploit generation; no autonomous changes to the
safety layer; **no claim of production zero-day discovery until real analyzers, real
repositories, and real validation oracles are wired.**

### Security posture

Generated security code is treated as **untrusted until validated** — candidates,
not authority. The policy, grader, statistics engine, receipt verifier, and
promotion gate remain frozen.

---

## Addendum B — Invariant Genome + metaproductivity (the frontier)

**Status**: Proposed (architecture landed with deterministic mock oracles —
`src/security/invariant.ts`, `LineageMemory` in `src/security/memory.ts`)

### Context

The SOTA frontier for self-improving security is four layers: (1) DGM-style
self-modifying harnesses validated empirically (arXiv:2505.22954); (2) the
Huxley–Gödel Machine (arXiv:2510.21614) — select the parent whose *descendants*
improve fastest, not the best current scorer; (3) agentic security with validation
+ remediation loops (e.g. Microsoft MDASH); (4) **specification-first** discovery
(Code Augur): the agent writes explicit security assertions, then guided fuzzing
tries to *falsify* them. Rule synthesis (Addendum A) is necessary but not
sufficient — the higher-leverage step is evolving the *invariants* themselves.

### Decision

1. **Invariant Genome** (`invariant.ts`). Evolve explicit security assertions —
   `input-constraint`, `memory-safety`, `auth-boundary`, `serialization`,
   `path-traversal`, `taint-flow`, `race-condition` — and score each candidate by
   whether a fuzzer can *falsify* it:

   > agent proposes invariant → fuzzer tries to break it → a violated invariant
   > becomes a finding → the fixed finding becomes a durable detector + memory.

   **Trust property**: a finding requires an actual counterexample, so clean code
   and decoys produce **zero false positives** (verified in tests). A falsified
   invariant is promoted into a durable detector (`falsificationToDetector`) that
   re-enters the Addendum-A self-writing gate and ruVector memory.

2. **Metaproductivity ranking** (`LineageMemory`). ruVector cross-run seeding
   selects by **descendant productivity**, not raw score — a low-scoring node with
   a productive lineage beats a high-scoring dead end (HGM). Don't just retrieve
   prior winners; retrieve lineages that produced useful descendants.

### Benchmark stack (status)

| # | Component | Status |
|---|---|---|
| 1 | seeded corpus (deterministic regression) | ✅ landed |
| 2 | real CVE corpus (realism) | ⛳ gap (needs real repos) |
| 3 | fuzzable harness corpus (discovery) | ◑ real fuzzer landed (`RealFuzzOracle`, python property fuzzer); corpus still small |
| 4 | hard false-positive corpus (trust) | ◑ partial (`hardCorpus`, tricky decoys) |
| 5 | replay receipts (auditability) | ✅ landed |
| 6 | paired bootstrap (promotion) | ✅ landed |
| 7 | lineage / metaproductivity score | ✅ landed (`LineageMemory`) |

### Honest SOTA claim (what we can defend today)

> Darwin Shield is a **deterministic, self-improving security harness**. It does
> not retrain the model. It evolves the security workflow around the model,
> promotes only statistically superior candidates, preserves byte-replayable
> receipts, and is now positioned to move from seeded validation to real analyzer
> and fuzzer oracles.

We **do not** claim full autonomous zero-day SOTA until real Semgrep, CodeQL, and
fuzzing are wired. The invariant-falsification and rule-synthesis loops currently
run against **deterministic mock oracles** (`MockFuzzOracle`, `MockDetectorOracle`)
so the architecture, gates, statistics, and receipts are real and tested; the
oracle *adapters* are the Phase-2/3 production work.

### Acceptance test (the bar for "beyond SOTA, validated")

Darwin Shield beats the fixed harness **on a real CVE corpus** with: paired
bootstrap lower-95% delta > 0; zero unsafe regression; replayable receipts; and
**at least one fuzzer-falsified invariant promoted into a durable detector.** The
mock-oracle analogue of this test passes today (`invariant.test.ts`); swapping in
the real CVE corpus + fuzzer behind the identical interfaces is the remaining step.

### SOTA upgrade path

1. Semgrep as the first real oracle (Addendum A Phase 2 — landed; now the in-loop
judge). 2. fuzzer-backed invariant falsification — **landed** (`RealFuzzOracle`,
a real seeded property fuzzer that executes code and falsifies the totality
invariant; TP 2 / FP 0 on the fixture, receipt `bench/results/fuzz-oracle-receipt.json`). 3. generated
detection-rule synthesis (landed, mock). 4. generated invariant synthesis (landed,
mock). 5. metaproductivity ranking in ruVector (landed). 6. CodeQL after Semgrep +
fuzzing are stable. 7. publish DARWIN-SHIELD-BENCH as a reproducibility artifact.

---

## Addendum C — Bounded security agentic loop (the architectural frontier)

**Status**: Proposed (architecture landed with deterministic mock oracles —
`src/security/agentic.ts`)

### Context

Issue #39 established, on the coding side, that the single-shot paradigm
(localize → emit → repair, plus model/tiering escalation) tops out (SWE-bench Lite
7.7% → 58.3%) and the gap to the 65–88% tier is **architectural, not tuning**: it
needs a multi-step autonomous loop that *discovers* context (ADR-153). Darwin
Shield hits the identical wall — a single-shot analyzer is structurally blind to a
weakness whose evidence spans multiple files / call edges.

### Decision

Add a **bounded security agentic loop** — the security analog of ADR-153's
`--sandbox agentic`. A deterministic, step-budgeted ReAct-style loop over a
RESTRICTED, gated tool surface: `list_sites`, `read_site`, `grep`, `run_analyzer`,
`run_fuzzer`, `assert_invariant`, `submit_finding` — every tool read-only or
oracle-only (no write / network / shell; `FORBIDDEN_TOOLS` is asserted in tests).
The loop pays the `discoveryDepth` navigation cost to *surface* a multi-step bug,
then confirms it via invariant falsification (Addendum B) — a real counterexample,
so clean code and decoys never produce false positives. Every submitted finding
passes the safety gate; the step trace is the audit receipt.

Per ADR-153, the loop's **policy is the evolvable surface** (`AgenticPolicy`: step
budget, tool order, planner, whether it fuzzes) — Darwin's mutation surfaces become
the loop's policy.

### Result (deterministic, mock oracles)

On a discovery corpus where most vulns require multi-step navigation:

| harness | TPR | FP | bounded | deterministic |
|---|---|---|---|---|
| single-shot (exhausted paradigm) | **0.25** (only shallow bugs) | 0 | — | yes |
| agentic loop, budget 10 | 0.75 | 0 | ✅ | yes |
| agentic loop, budget 40 | **1.0** | 0 | ✅ | yes |

Step budget is the lever: more budget discovers monotonically more, never exceeds
the bound, never emits unsafe output, and replays byte-identically. This is the
"architectural, not tuning" win #39 names — crossing the discovery wall a
single-shot harness structurally cannot.

### Non-goals / honesty

The tool surface runs against deterministic mock oracles (`MockFuzzOracle`); a real
agentic loop would drive real `read`/`grep`/`run_tests`/`run_fuzzer` inside the
existing safety gate. The architecture, bound, gating, determinism, and receipts
are real and tested; wiring the real tool surface + real corpora is the remaining
production step (Addendum A Phase 2 / Addendum B fuzzer). No claim of autonomous
zero-day SOTA until those land.
