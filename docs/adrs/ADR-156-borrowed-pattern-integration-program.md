# ADR-156: Borrowed-pattern integration program — Darwin Mode mutates structured policies, not prompts

**Status**: Proposed — reference implementation in `@metaharness/projects`
**Date**: 2026-06-20
**Project**: `ruvnet/agent-harness-generator`
**Codename**: `DARWIN-BORROW`
**Owner**: MetaHarness / Darwin Mode
**Deciders**: rUv
**Scope**: Cross-cutting program ADR governing ten borrowed-pattern integrations (ADR-157…166) into Darwin Mode / Darwin Shield
**Related**: ADR-070 (Darwin Mode head), ADR-071 (mutation surfaces + allowlist), ADR-072 (frozen scorer/promotion), ADR-073 (archive + selection), ADR-074 (ruVector memory fabric), ADR-076 (parent-vs-child benchmark), ADR-077 (DGM), ADR-078 (HGM clade metaproductivity), ADR-079 (SGM statistical gates + risk budget), ADR-082 (expected gains + effective-performance), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), and the ten it umbrellas: ADR-157…166

> The agent-tooling field has converged on a small set of load-bearing patterns — durable execution (LangGraph), evaluation datasets (LangSmith), tracing + handoffs (OpenAI Agents SDK), unified memory + opportunity discovery (CrewAI), explicit graph specs (AgentSPEX), bounded scheduling (structured-graph harness research), programmable guardrails (NeMo Guardrails), and human-gated deterministic verification (industrial-robotics agents). **The opportunity is to copy the pattern, not the product.** This ADR ratifies a program to absorb ten such patterns into Darwin Mode, governed by one thesis that ties them together and makes them measurable.

## Context

Darwin Shield (ADR-155) already evolves a **structured policy** — the `HarnessGenome` (planner, contextPolicy, reviewerCount, retryBudget, fuzzBudgetSeconds, tools, modelMix, validationPipeline, with an immutable `safetyProfile`) — scored by a frozen fitness function (`scoring.ts`) and promoted through a paired statistical gate (`stats.ts`). The Phase 2 work (ADR-155 Addenda) further proved the loop can be driven by **real tools** (`semgrep-oracle.ts`, `fuzz-oracle.ts`, `real-evolve.ts`): a generated detector is scored by real Semgrep over a labeled corpus and promoted only when the bootstrap certifies it.

The load-bearing thesis of the whole stack is unchanged: **the foundation model stays frozen; the harness evolves; the proof is in replay.** What the field's best harnesses add on top is *engineering discipline around that loop* — durability so long runs survive crashes, traces so every dollar is accounted, specs so mutation operates on typed structure, schedulers so loops are bounded, memory so frontier reasoning is not repeated, datasets so winners are real and not overfit, handoffs so transitions are contracted, rails so the optimizer cannot cheat, discovery so budget goes to high-ROI work, and human gates so people review only the uncertain edge.

None of these require touching the model. All of them sharpen the *structured policy* Darwin already mutates.

## Decision

Adopt the following thesis as the spine of the program, and the ten ADRs below as its implementation:

> **Darwin Mode mutates structured policies, not prompts.** Prompt mutation is noisy and unmeasurable; policy mutation is testable, explainable, governable, and sellable.

The canonical mutation surface is a typed policy object — not a prompt blob:

```jsonc
{
  "planner_model": "cheap",
  "coder_model": "cheap",
  "reviewer_model": "frontier_on_failure",
  "retrieval_top_k": 12,
  "max_retries": 2,
  "frontier_escalation_threshold": 0.78,
  "security_review_required": true,
  "batch_eval": true,
  "cache_repo_context": true
}
```

This object is the through-line of the program: HarnessSpec (ADR-159) is its declarative home, the Escalation Scheduler (ADR-160) reads its loop bounds, the Cost Ledger (ADR-158) attributes spend to its choices, Memory Tiers (ADR-161) supply `cache_repo_context`, Safety Rails (ADR-164) forbid mutations that weaken it, and the Dataset Registry (ADR-162) proves a mutated policy is a real winner.

### The ten borrowed patterns

| ADR | Capability | Pattern borrowed from | Priority |
|---|---|---|---|
| [ADR-157](./ADR-157-darwin-checkpoints-durable-execution.md) | Darwin Checkpoints (durable, resumable runs) | LangGraph durable execution | **1** |
| [ADR-158](./ADR-158-darwin-trace-format-cost-ledger.md) | Darwin Trace Format & Cost Ledger | OpenAI Agents SDK tracing | **1** |
| [ADR-159](./ADR-159-harnessspec-declarative-policy.md) | HarnessSpec (declarative mutatable policy) | AgentSPEX explicit graph specs | **1** |
| [ADR-160](./ADR-160-escalation-scheduler-bounded-loops.md) | Escalation Scheduler (bounded loops, fail-closed) | Structured-graph scheduling research | **1** |
| [ADR-161](./ADR-161-ruvector-memory-tiers.md) | ruVector Memory Tiers | CrewAI unified memory | **1** |
| [ADR-162](./ADR-162-darwinbench-dataset-registry.md) | DarwinBench Dataset Registry | LangSmith evaluation workflow | 2 |
| [ADR-163](./ADR-163-typed-handoffs.md) | Typed Handoffs (contracted transitions) | OpenAI Agents SDK handoffs | 2 |
| [ADR-164](./ADR-164-darwin-safety-rails-immutability.md) | Darwin Safety Rails (immutable guardrails) | NeMo Guardrails | 2 |
| [ADR-165](./ADR-165-darwin-opportunity-scanner.md) | Darwin Opportunity Scanner (ROI ranking) | CrewAI Discovery | 2 |
| [ADR-166](./ADR-166-human-review-gates.md) | Human Review Gates (review the uncertain edge) | Human-gated deterministic verification | 2 |

### Phasing

- **Priority 1 (the cost-and-control spine):** ADR-157, ADR-158, ADR-159, ADR-160, ADR-161. These make runs cheap, accountable, structured, bounded, and memory-backed. They are mutually reinforcing and should land together.
- **Priority 2 (the trust-and-ROI layer):** ADR-162, ADR-163, ADR-164, ADR-165, ADR-166. These harden winners, contract transitions, forbid cheating, target budget, and gate humans.
- **Priority 3 (out of scope for this program, recorded for completeness):** visual graph editor, marketplace adapters, multi-tenant policy templates, compliance export packs. No ADR is opened for these yet.

## Consequences

**What changes.** Darwin's mutation operators (`genome.ts`) operate on an explicit, exportable policy (HarnessSpec) rather than implicit configuration; every run becomes durable, traced, bounded, and memory-aware; promotion requires a four-split win, not a single-corpus win.

**What does not change.** The model stays frozen (ADR-070). The scorer and policy remain non-self-editable (ADR-072/ADR-080). The `safetyProfile` and the `-∞` unsafe-output term are untouched — the program *strengthens* them (ADR-164). Determinism-under-replay (ADR-155) is preserved and, via checkpoints, extended across crashes.

**What hurts.** Ten new subsystems is real surface area and integration cost. The expected-impact percentages quoted by each source are **hypotheses**, not guarantees — each ADR's Test Contract exists to falsify them. There is a risk of over-engineering the control plane relative to the (still small) real-CVE corpus (ADR-162 names this gap explicitly).

## Alternatives Considered

- **Adopt one product wholesale (e.g. build on LangGraph).** Rejected: couples Darwin to an external runtime and licensing, and most of these products optimize the model-facing ergonomics, not evidence-driven *harness evolution*. We want the patterns, decoupled.
- **Keep mutating prompts.** Rejected: prompt deltas are not reproducibly testable or governable; this is the precise failure mode the thesis names.
- **Do nothing / ship Darwin Shield as-is.** Rejected: the loop works but leaks money (no ledger), restarts from scratch (no checkpoints), can in principle loop unboundedly (no scheduler), and can in principle reward-hack (no immutable rails). These are the cheapest, highest-leverage hardenings available.

## Test Contract

This program is considered shipped when the **integrated acceptance test** passes, on top of each child ADR's own Test Contract:

- **Integrated benchmark.** Implement the Priority 1 set (ADR-157…161), then run **100 repo tasks across 3 repos** and compare the evolved policy against a frontier-only baseline. Targets (each a pass/fail gate, measured from the Cost Ledger and Dataset Registry):
  1. **≥ 20% fewer retries** vs free-form baseline (attributable via ADR-163 / ADR-160).
  2. **≥ 30% fewer wasted tokens** (attributable via ADR-158 / ADR-161).
  3. **≥ 50% lower cost than frontier-only**, at **same-or-better solve rate**.
  4. **Zero critical guardrail bypasses** (ADR-164 rails hold under the full run).
- **Replay.** The entire 100-task run is replayable from checkpoints (ADR-157) with fixed seeds and fixed model outputs, byte-identical (ADR-159).
- **No false winners.** Any policy promoted during the run wins on all four dataset splits (ADR-162), bootstrap-certified (`stats.ts`).

Each child ADR (ADR-157…166) carries its own named Test Contract; this ADR does not duplicate them.

## Reference implementation & empirical update

All ten patterns are implemented in the dependency-free, deterministic `@metaharness/projects` package (117+ passing tests); each child ADR (ADR-157…166) now carries a `## Reference implementation` section pointing at its module + tests + bench receipt. The integrated acceptance scenario is a **deterministic synthetic simulation** (`bench/integrated.bench.mjs`, receipt `integrated.json`): retries −58.9%, wasted tokens −42.0% (memory + trace-leak pruning), cost −64%, solve rate held, 0 guardrail bypasses, 0 false rejections — all gates pass at the committed seed. These are simulation results, not field measurements.

Putting a **real model in the loop** (via OpenRouter) produced net-new decisions recorded in **ADR-167**: an execution-verified defensive discovery harness, an escalation router (cost-per-verified-finding), a self-learning loop backed by the ADR-161 `TieredMemory`, and empirical **open-frontier model selection** (Qwen3-235B / DeepSeek-v3.2 beat GLM-5.2 on verified-per-cost). Those results are real but single non-deterministic runs; production claims require multi-seed bootstrap gating.

## References

- LangGraph — durable execution, streaming, human-in-the-loop, long-running agents.
- LangSmith — datasets, evaluators, experiments, comparison.
- OpenAI Agents SDK — built-in tracing; orchestration, handoffs, guardrails, human-approval paths.
- CrewAI — unified memory system; Flows; Discovery (effort/value/readiness ranking).
- AgentSPEX — explicit graph specification (typed steps, branching, loops, parallelism, state, checkpointing, verification, logging).
- Structured-graph harness scheduling research — explicit plans, separated planning/recovery layers, strict escalation protocols.
- NeMo Guardrails — programmable, interpretable, model-independent runtime rails.
- Industrial-robotics agent work — LLM for contextual reasoning; deterministic verification/sequencing/execution; human inspection before execution.
- Internal: ADR-070…082 (Darwin Plus stack), ADR-153 (agentic-loop architecture), ADR-155 (Darwin Shield), ADR-157…166 (the ten integrations this ADR governs).
