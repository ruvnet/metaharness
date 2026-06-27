# SOTA Horizon: Darwin Mode SWE-bench Campaign

**Initialized**: 2026-06-22
**Horizon key**: `horizons/horizon-darwin-sota` (ruflo memory)
**Owner**: ruvnet/agent-harness-generator, branch `claude/darwin-mode-evolve-polyglot`
**Purpose**: Durable cross-session tracker for the Darwin Mode SWE-bench SOTA campaign. Each session must check this file in and update it at check-out.

---

## Objective

Reach a legitimate, leaderboard-conformant top placement on SWE-bench Lite (300 instances), then Verified (500 instances), optimizing the cost-vs-performance Pareto frontier ("lowest cost at best intelligence").

**Conformance definition**: the solver NEVER touches the gold `FAIL_TO_PASS` or `PASS_TO_PASS` test suite during solving. Gold tests are used only for the final official scoring run. Any system that accesses gold tests in-loop is disqualified from the leaderboard — our own 68.3% number (oracle-ON, TDR mode) is a product metric, not a leaderboard entry.

**Authoritative numbers only**: batch-eval resolve rates with Wilson 95% CIs. No fabricated or extrapolated leaderboard claims.

---

## Milestone Status Table

| ID | Milestone | Target | Status | Measured State (2026-06-22) |
|----|-----------|--------|--------|----------------------------|
| M1 | Conformant Top-10 Lite | >=45% resolve | IN PROGRESS | DeepSeek-only floor: 5/25=20.0% [Wilson: 8.9%, 39.1%]. Reasoning deficit confirmed as primary wall. Combined pilot (line+repro-gap fix, k=5) result pending — this is the definitive DeepSeek ceiling. |
| M2 | Beat SOTA #1 Lite | >60.33% resolve | PENDING | Not started. Requires Opus-4.8 Sniper + SWE Conductor (ADR-176). |
| M3 | Verified Top-10 | >=55% resolve | PENDING | Not started. Lite M1 must complete first. |
| M4 | Pareto Crown | Lowest $/resolve in top-20 Lite | PENDING | Pareto thesis survives only as hybrid (cheap evidence + frontier sniper). Pure-cheap falsified. |

**Current milestone**: M1 — Conformant Top-10 Lite (>=45%)
**Current milestone completion criteria**: Gold-graded batch eval on full 300-instance Lite yields >=45% with conformant scaffold (no gold oracle in-loop). Wilson lower bound >=38%.

---

## Measured State as of 2026-06-22

All numbers are gold-graded 25-instance Lite pilots, conformant (no gold oracle in-loop).

| Config | Attempt Rate | Repro Validity | Branch Pass | Gold Resolve | Cost |
|--------|-------------|----------------|-------------|--------------|------|
| DeepSeek-V4-Flash, k=5 MCTS | 44% | 68% | ~8% | 5/25 = 20.0% | $0.587 |
| DeepSeek (critic) + MiniMax-M2.7 (patch) | 48% | 68% | ~16% | 5/25 = 20.0% | $1.29 (2.2x) |
| Line-number applicator (DeepSeek) | 80% | 64% | ~16% | 4/25 = 16.0% | ~$0.60 |
| Line + repro-gap fix (combined, k=5) | ~80% | ~91% | ~27% | PENDING | pending |

**Decisive finding**: The 91%-repro-valid → ~27%-branch-pass gap is a pure reasoning deficit in the cheap model. Tooling (attempt-rate, repro-validity) is maxed. Reasoning is the wall. A stronger, 2.2x-pricier patch model (MiniMax-M2.7) did not move the gold resolve rate.

**Approach pivot (recorded)**: Pareto thesis pivoted from pure-cheap to hybrid (cheap conductor/evidence + Opus-4.8 sniper on the tail, <10% of instances). ADR-176 (SWE Conductor) formalizes this.

---

## Architecture (Current — per ADRs 173-176)

```
ADR-173: Conformant leaderboard path (no gold oracle in-loop)
ADR-174: Test-Critic + MCTS + Opus sniper 4-layer stack
ADR-175: Dual-mode (oracle-ON TDR vs oracle-OFF Conformant)
ADR-176: SWE Conductor (6-layer, role-specialized, asymmetric escalation)
```

**SWE Conductor layers**:
1. Conductor (state machine, DeepSeek-V4-Flash) — decomposes, routes, never patches
2. Context Builder (per-role visibility scoping)
3. Agent Pool: Test-Critic, Navigator, Coder, Sniper (strict schemas, scoped tools)
4. Tool Kernel (schema-validated, audited)
5. Verification Kernel (deterministic: py_compile, repro run, patch-quality — no LLM)
6. Trajectory Archive (replayable bundles)

**Already built**:
- `test-critic.mjs` (Test-Critic, 91% repro-validity)
- `solve-mcts.mjs` (Coder + MCTS, line-number applicator, 80% attempt-rate)
- `--sniper` flag hook (Opus-4.8 escalation)
- Conformance guard (no gold-test calls asserted during solving)

---

## Leaderboard Context (fetched from ADR-173, 2026-06-22)

These numbers come from ADR-173's fetched leaderboard data. They should be re-verified each research cycle.

**SWE-bench Lite (300 instances)**:
- #1: ExpeRepair + Claude-4-Sonnet — 60.33%
- Top-5 threshold: ~50%+
- Top-10 threshold: ~45% (EntroPO + Qwen3-Coder-30B at 45.0%)
- Board skews 2024-2025 models; ripe for 2026-model entry

**SWE-bench Verified (500 instances)**:
- Top: ~76.8% (Claude 4.5 Opus, via mini-SWE-agent v2)
- Top-10 threshold: ~70%
- All via mini-SWE-agent v2 with a single harness

**Cost-per-resolve champions (Verified)**:
- MiniMax M2.5: 75.8% @ ~$0.07/instance
- Kimi K2.5: 70.8% @ $0.15/instance
- DeepSeek V3.2: 70.0% @ $0.45/instance
- All ~10x cheaper than Claude Opus at $0.75/instance
- Available on OpenRouter: `minimax/minimax-m2.5`, `deepseek/deepseek-v3.2`, `moonshotai/kimi-k2.5`

**NOTE**: These leaderboard numbers were fetched 2026-06-22 and will move. Re-fetch at each research cycle.

---

## SOTA Research Pass — 2026-06-22

### Top System Methods (from public literature and ADR-173 leaderboard fetch)

**ExpeRepair** (current Lite #1, 60.33%):
- Combines experience replay with multi-attempt repair
- Uses Claude-4-Sonnet as the reasoning backbone
- Key technique: accumulates repair "experience" across attempts, learns from failed patches within the same run
- Scaffold: structured retry with failure pattern memory — closer to MCTS-with-history than pure beam search

**mini-SWE-agent v2** (dominant on Verified, single harness at 76.8%):
- The reference scaffold for the leaderboard — nearly all top-10 Verified entries use it
- Key components: file-system navigation tools, `str_replace_editor`, `bash` tool, iterative loop
- Works with multiple backbone models (Claude Opus most powerful; MiniMax for cost)
- Simpler than our current stack but more battle-hardened on the Verified distribution

**Agentless** (strong Lite performer):
- Two-phase: (1) fault localization (file+function level) before generating patches; (2) patch generation with multiple candidates
- Key differentiator: explicit localization step BEFORE patching — reduces context noise, improves patch quality
- Does NOT use an agentic loop; generates a ranked set of patches, picks best by test vote
- Cost-efficient because it avoids tool-call overhead in the patch phase
- Transferable technique: our Navigator role in SWE Conductor maps to Agentless localization

**AutoCodeRover**:
- Uses program analysis (AST, call graph) for localization rather than pure LLM search
- Key technique: spectrum-based fault localization (SBFL) — runs existing tests, identifies lines that fail tests more than passing tests
- Transferable: our Test-Critic already validates repros; adding SBFL on the existing test suite (pre-gold) is conformant

**SWE-search / Monte Carlo Tree Search variants**:
- Multiple top systems use MCTS or beam search over repair trajectories
- Key finding from our own data: MCTS selection is sharp (45% conditional resolve); the bottleneck is candidate quality, not selection
- Transferable: our MCTS is already built; the lever is reasoning quality of the Coder, not more branches

### Techniques We Have NOT Yet Tried (prioritized by expected lift)

See the Prioritized Lever List section below.

---

## Prioritized Lever List

Ordered by: (expected resolve-rate lift) / (dollar cost + implementation effort). Lift projections are HYPOTHESES — none are measured. They become facts only after a conformant batch + Wilson CI.

### Tier 1 — High Expected Lift, Low Cost/Effort

**L1. Opus-4.8 Sniper (asymmetric escalation)**
- Technique: route repro-valid-but-unsolved instances to Opus-4.8 with compressed evidence package (failing repro + Navigator's implicated lines + DeepSeek's failed-attempt traces)
- Expected lift: +15–25pp over DeepSeek-only floor (if sniper fires on ~30/300 instances)
- Cost delta: ~$0.50/sniper-instance x 30 = +$15 on a $25 base run → $40 total
- Effort: `--sniper` flag already exists; needs compressed-package formatter + threshold tuning
- ADR: extends ADR-174/ADR-176 (SWE Conductor Sniper role)
- Status: designed, not yet measured
- Why it's #1: it directly targets the diagnosed reasoning deficit with the model that addresses it

**L2. Spec/Plan-then-Edit (structured decomposition before patching)**
- Technique: before any file edit, Conductor forces Coder to output (a) root-cause hypothesis, (b) specific files+lines to change, (c) test-failure explanation — all verified against Navigator context before the first edit
- Expected lift: +5–10pp (reduces incoherent patches; improves conditional-resolve rate)
- Cost delta: +$0.01-0.02/instance (one extra reasoning step per instance)
- Effort: medium — add structured output schema to Coder role in Conductor
- ADR: extends ADR-176 (Coder Agent Pool spec)
- Analogy: Agentless does this implicitly with its two-phase localize-then-generate approach

**L3. SBFL-informed Localization (spectrum-based fault localization on existing tests)**
- Technique: run the instance's existing test suite (pre-gold, conformant) with coverage; lines that fail more than pass are ranked as likely fault loci; feed this ranked list to Navigator as a localization prior
- Expected lift: +5–8pp on localization-hard instances (multi-file, cross-module bugs)
- Cost delta: $0 model cost; +$0.01-0.05 compute per instance (test run)
- Effort: medium — add a coverage-based localization pass before Navigator in the Conductor state machine
- ADR: new ADR or extends ADR-176; analogous to AutoCodeRover's technique, applied conformantly

### Tier 2 — Moderate Lift, Moderate Cost/Effort

**L4. MiniMax-M2.5 as Coder (not DeepSeek)**
- Technique: use `minimax/minimax-m2.5` for patch generation rather than DeepSeek-V4-Flash — MiniMax-M2.5 is the current Verified cost-per-resolve champion at $0.07/instance
- Expected lift: +5–15pp on Lite (MiniMax is measurably stronger on Verified; Lite distribution is harder)
- Cost delta: MiniMax M2.5 is $0.15/$0.90 per M vs DeepSeek $0.09/$0.18 — roughly 3x per patch token; net ~+$0.10/instance
- Effort: low — model swap in Conductor config
- ADR: test before L3; model-swap-only pilot is quick to run
- NOTE: MiniMax-M2.7 swap on patch generation was FALSIFIED (no lift vs DeepSeek). M2.5 is a different model (the Verified champion) and untested on Lite — do not assume the M2.7 result generalizes.

**L5. Best-of-N with Self-Consistency Voting (ensemble)**
- Technique: generate k=5-10 candidate patches with different temperatures/seeds; vote on which patch is most consistent with the repro test outcome AND with static checks (py_compile, no test deletion)
- Expected lift: +5–10pp on instances where DeepSeek occasionally gets the right answer (increases probability of a good candidate appearing in the k samples)
- Cost delta: k× the per-instance model cost; expensive if k is large
- Effort: medium — already have MCTS; voting is a different selection criterion
- ADR: extends ADR-174/ADR-176

**L6. Regression-Test Selection (run related existing tests, not just repro)**
- Technique: after generating a patch candidate, run not just the agent's repro but also the test files the patch touches (found by `git grep` of the changed function names) — extra conformant signal without the gold harness
- Expected lift: +3–7pp (catches patches that fix the repro but break adjacent functionality — a common failure mode in harder instances)
- Cost delta: $0 model; +$0.02-0.10 compute per instance
- Effort: low-medium — extend Verification Kernel in ADR-176

### Tier 3 — Speculative / Longer Horizon

**L7. Fine-tuned cheap model on SWE-bench repair trajectories**
- Technique: train a LoRA adapter on public SWE-bench trajectories (princeton-nlp/SWE-bench has community-contributed trajectories); use fine-tuned cheap model as Coder
- Expected lift: unknown — fine-tuning on public trajectories may help Lite distribution significantly
- Cost delta: one-time training cost; ongoing serving is cheap
- Effort: high — requires training infrastructure, eval loop, conformance verification of training data
- ADR: new ADR; long-horizon (weeks)
- Risk: SWE-bench conformance rules may restrict training on the Lite test distribution; verify before investing

**L8. Cross-file/Lifecycle Context Expansion**
- Technique: for instances where Navigator identifies cross-module changes (the "harder half" the reasoning-deficit finding isolates), automatically expand context to include callers, callees, and test files of changed modules
- Expected lift: +3–8pp on the hard tail
- Cost delta: +$0.05-0.15/instance (larger context windows)
- Effort: medium — Context Builder in ADR-176 needs richer graph traversal

---

## Drift Detection

Drift is assessed each session. Flag if observed.

| Dimension | Status | Signal |
|-----------|--------|--------|
| Timeline drift | NONE YET | No target date set for M1 — waiting for combined pilot result |
| Scope drift | NONE YET | SWE Conductor (ADR-176) is a refactor of validated pieces, not scope expansion |
| Approach drift | PIVOTED (recorded) | Pure-cheap Pareto falsified 2026-06-22; hybrid confirmed as the path |
| Dependency drift | MONITOR | MiniMax-M2.5 Verified dominance is new data — may change model choices |
| Priority drift | NONE YET | No competing work consuming capacity |

---

## Periodic Research Cadence

These checks must be run at the start of each significant work session (at minimum weekly):

### Weekly checks
1. **Leaderboard re-fetch**: visit swebench.com or the princeton-nlp/SWE-bench leaderboard; note any new #1, any new top-10 entries, any movement in the top-10 cutoff threshold for Lite and Verified
2. **New model availability**: check OpenRouter for new cheap reasoning models (search for DeepSeek, Kimi, MiniMax, Qwen updates); note $/M pricing changes
3. **New public scaffolds**: scan arxiv (cs.AI, cs.SE) and GitHub for new SWE-bench agent papers; focus on techniques that address localization, multi-file reasoning, or cost efficiency

### Per-session checks
1. **Recall horizon state**: `mcp__claude-flow__memory_retrieve` key `horizon-darwin-sota` namespace `horizons`
2. **Review milestone**: is M1 still the active milestone? What did the combined pilot return?
3. **Assess drift**: has the leaderboard top-10 cutoff moved? Has a new model changed the cost-per-resolve frontier?
4. **Plan session contribution**: what specific pilot or implementation task closes the gap to M1?

### Research trigger conditions (run a full SOTA pass when these occur)
- Any new entry appears in top-5 of Lite or Verified
- A new cheap model (<$0.30/M) claims >50% on Lite or >65% on Verified
- A new public scaffold paper lands that claims a technique not in our stack
- Our conformant batch eval on the full 300 Lite instances completes (re-baseline everything)

### What to fetch each cycle
```
WebSearch: "SWE-bench leaderboard 2026" site:swebench.com
WebSearch: "SWE-bench Lite top results" latest
WebSearch: "SWE-bench Verified leaderboard"
WebFetch: https://www.swebench.com/ (parse table)
WebSearch: "SWE-bench agent scaffold arxiv 2025 2026"
WebSearch: site:openrouter.ai new models pricing
```

---

## Session Log

| Session | Date | Milestone Active | Accomplished | Next Action |
|---------|------|-----------------|--------------|-------------|
| 1 — Init | 2026-06-22 | M1 | Horizon initialized. SOTA research pass. ADRs 173-176 loaded. Lever list drafted. SOTA_HORIZON.md written. Ruflo memory persisted. | Await combined pilot (line+repro-gap fix, k=5) gold result; implement Opus-4.8 Sniper per ADR-176; begin SWE Conductor state machine |
| 2 — Per-instance diagnosis | 2026-06-26 | M1/M2 | Built per-instance config-evolution (ADR-194): `evolve-perinstance.mjs` + `gcp-perinstance-runner.sh`, k-sample conformant per-instance fitness via new Firestore `darwin_inst_runs`, conformance firewall (diagnosis-only). FINAL coverage map (real numbers): **0/25 cracked** — cheap-single + cheap→Opus cold-cascade both crack 0/25 of the Opus-give-ups (cascade routes to Opus, still 0/15). Direct-Opus/bo3/xbo genomes queued-not-measured (wound down early). LEARNINGS §51. ~$107 incremental. | Config-only cannot close the hard tail → execute ADR-195 Phase-2 capability stack: (1) **trace-localize n=300 validation** (the §56 lever that cracked a give-up — highest value), (2) reproduction/repro-script generation, (3) self-review pass. |

---

## Known Risks (active)

1. **Reasoning deficit is structural**: 91% repro-valid → ~27% branch-pass — even with optimal tooling, the cheap model fails on cross-file/lifecycle bugs. Sniper is the only confirmed mitigation.
2. **Opus sniper cost creep**: if sniper fires on >15% of instances, cost-per-resolve rises above Pareto-competitive threshold. Gate: `--max-cost` cap per run.
3. **Conformance**: any accidental gold-test contact during solving disqualifies the run for leaderboard purposes. The conformance guard must be asserted on every batch.
4. **Combined pilot result unknown**: the definitive DeepSeek-only ceiling (line+repro-gap fix, k=5) is still pending as of horizon initialization. This number gates whether M1 is within reach of cheap-model-only or requires the Sniper immediately.
5. **MiniMax-M2.5 vs M2.7 distinction**: M2.7 swap was falsified. M2.5 is the Verified champion and is a different model — do not conflate. Test M2.5 before discarding MiniMax entirely.
6. **SOTA moves**: the top-10 Lite cutoff (~45%) and #1 (~60.33%) will advance. If ExpeRepair or another system reaches 65%+, M2 target rises.

---

## Memory Persistence

This horizon is stored in ruflo memory for cross-session recall:
- **Key**: `horizon-darwin-sota`, **Namespace**: `horizons`
- **Session summaries**: namespace `horizon-sessions`, key pattern `darwin-sota-[YYYY-MM-DD]`
- **Learnings**: namespace `horizon-learnings`, key pattern `darwin-sota-learning-[N]`

To recall at session start:
```
mcp__claude-flow__memory_retrieve(key="horizon-darwin-sota", namespace="horizons")
```

To search for related context:
```
mcp__claude-flow__memory_search(query="darwin SWE-bench SOTA milestone", namespace="horizons")
```
