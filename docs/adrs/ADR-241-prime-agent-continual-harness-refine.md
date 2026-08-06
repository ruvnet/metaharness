# ADR-241: Prime Agent-inspired continual-harness primitives — refine operator, autonomous spec, recoverable sessions

**Status**: Proposed
**Date**: 2026-08-06
**Project**: `ruvnet/agent-harness-generator`
**Deciders**: ruv
**Tags**: prime-agent, refine, continual-harness, darwin-mode, flywheel, autonomous, sessions, ptc
**Extends**: ADR-014 (Self-evolution + federation), ADR-071/072 (Mutation surfaces + frozen promotion gate), ADR-159 (HarnessSpec declarative policy), ADR-226 (Advisor-loop null: standing policy transfers, advice doesn't), ADR-228 (GEPA distilled executor genome), ADR-234 (ruvllm microloop honest nulls)
**Related**: ADR-004 (Host integration model), ADR-047 (Algorithmic agent harness), ADR-240 (AGNTCY identity/A2A), ADR-242 (host-prime-agent — companion, shipped as a pair)
**Prompted by**: a research pass over Prime Intellect's Prime Agent harness (blog + MIT repo), written up with verified mechanics and a full gap map in
[`docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md`](../research/scaffolding/PRIME-AGENT-ANALYSIS.md) — read that first; this ADR only decides.

---

## Context

Prime Agent ([blog](https://www.primeintellect.ai/blog/prime-agent), [repo](https://github.com/PrimeIntellect-ai/prime-agent), MIT, built atop the same `pi` framework as our `host-pi-dev` target) reports beating the human-expert baseline on ARC-AGI-3 (95.5% vs 95.4% Best@1, Opus 5) **at lower token cost** than Claude Code/Codex. Its design rests on a "Continual Harness" — prompts, memories, skills, and sub-agent specs as durable state refined by evidence-backed `/refine` edits — plus recoverable JSONL sessions, autonomous mode with quality gates, and RLM-style programmatic tool calling (PTC).

Why act now, and why *these* pieces: two of our own measured results point exactly where `/refine` operates.

- **ADR-226 (null)**: a read-only strong advisor produced **zero marginal lift at 5.4× cost**. Advice does not transfer; edits to the executor's *standing policy* do.
- **ADR-234/237 (nulls)**: blind random-perturbation compounding produced honest nulls — the population search is only as good as its proposer.

Prime Agent's `/refine` is a proposer that edits standing state, minimally, with trajectory evidence and rollback. That is the intersection of both findings.

What already exists here and must not be duplicated:

- **Darwin Mode** (ADR-070…081): population-based evolution behind a frozen conjunctive promotion gate. The mutator is **already pluggable** — `CodeGenerator` in `packages/darwin-mode/src/mutator.ts` receives `parentCode`, `surface`, `parentScore`, `failedTraces`, and a sibling-diversity `nonce` (ADR-104), and its output must pass `validateGeneratedCode` before touching disk. The `MutationContext` docstring already anticipates "an LLM-backed `CodeGenerator` [that] uses it to target the parent's actual failures". This ADR fills that slot.
- **Flywheel** (`packages/flywheel`): signed lineage, receipts, replay — the rollback/audit substrate a refine history needs.
- **GEPA** (ADR-228): reflective offline genome evolution. Refine differs by being *incremental, per-edit evidenced, CRUD-on-standing-state with per-edit rollback* — a proposer inside the existing loop, not a new loop.
- **HarnessSpec** (ADR-159): already carries `budgets`, `guards`, `rollback`; its thesis — "mutate structured policies, not prompts" — bounds what refine may touch.
- **`docs/LOOP_WORKER.md`**: our autonomous-loop practice (directives, cadence, budget caps) done by hand in one doc, not shipped as a primitive of generated harnesses.
- **ADR-240 / ruflo ADR-380**: agent identity and A2A coordination — already an owned, live decision.

## Decision

Four numbered decisions, one deferral, one decline. The companion ADR-242 covers Prime Agent as an emission target (11th host adapter).

### 2.1 `RefineMutator` — an evidence-backed CRUD proposer for Darwin/flywheel

Add a `RefineMutator` implementing the existing `CodeGenerator` interface (`packages/darwin-mode/src/mutator.ts`), as the ADR-071-anticipated LLM-backed generator, with refine-specific contracts:

- **One minimal edit, one surface, per child.** Given `failedTraces` + `parentScore`, it proposes exactly one CRUD edit (create/update/delete of a bounded region) on exactly one approved `MutationSurface` — never a wholesale rewrite. This is the ADR-159 thesis applied to mutation: structured, targeted policy edits.
- **Evidence or no-op.** The returned `summary` MUST cite the trace IDs (or trace-line references) that motivated the edit. No citable evidence → return the parent unchanged (the established safe no-op path). This is the anti-ADR-226 guard: the mutation is grounded in observed failure, not free-floating advice.
- **Same gate, unchanged.** Output passes `validateGeneratedCode` before touching disk, children still pass `inspectVariant`, and promotion still requires the frozen conjunctive `meetsPromotionRule` (ADR-072). Refine changes the **proposer only**; the gate is the product and does not move.
- **Rollback by construction.** Every applied edit is recorded to flywheel lineage with its inverse (parent bytes for the touched surface), so any refine step reverts byte-identically — matching Prime Agent's recorded-history/rollback property but on our signed-receipt substrate.
- **Complementary, not replacing.** `DeterministicMutator` (and any population proposer) remains; refine children and perturbation children feed the same archive and compete under the same scorer. Sibling diversity (ADR-104 nonce) is preserved: same-surface refine siblings must propose distinct edits.

Estimated effort: 5–8 engineering days (mutator + lineage inverse records + fixtures).

### 2.2 Autonomous fields on HarnessSpec

Extend HarnessSpec — both the generator-facing spec (`packages/kernel-js/src/types.ts`) and the evolvable policy spec (`packages/projects/src/harness-spec.ts`) — with an optional `autonomous` block:

```ts
autonomous?: {
  goal?: { text: string; tokenBudget?: number };   // persistent objective (+ budget)
  heartbeat?: { cadence: string; instruction: string }; // periodic re-entry
  gateCommand?: string;    // quality gate a turn must pass, e.g. "npm run check"
  maxTurns?: number;       // hard turn ceiling
}
```

- Semantics follow the existing `budgets`/`guards` discipline (ADR-159): hitting a budget or failing a gate halts deterministically; reaching a limit is **not** success.
- Host adapters project the block per host: Claude Code → hooks/loop config; host-prime-agent (ADR-242) → a documented `--autonomous --autonomous-gate <cmd> --autonomous-max-turns <n>` invocation; hosts with no autonomous surface emit a documented no-op note rather than silently dropping fields.
- This codifies `docs/LOOP_WORKER.md` practice (directive + cadence + budget caps) into generated harnesses instead of leaving it as maintainer folklore.

Estimated effort: 3–5 days (schema in both specs, genome round-trip, adapter projections for 2 hosts first).

### 2.3 Recoverable-session scaffold primitive

Generated harnesses gain an optional session-persistence primitive, scoped narrowly to the piece nothing here provides — a **crash-recoverable, forkable session log**:

- **Append-only JSONL** event log per session under the harness state directory; every event carries a monotonic index and parent-branch ID.
- **Resume**: replaying the log reconstructs session state deterministically; a state hash over the replay verifies integrity.
- **Fork**: a new branch ID referencing a parent event index; branches replay independently (Prime Agent's `/tree` capability, minus the daemon).
- Deliberately **out of scope**: a daemon, socket attach/detach, and kernel snapshots. Flywheel replay/receipts stay the loop-level audit layer; ADR-202's jujutsu dual-state stays the workspace-level branching layer. This primitive is the *session*-level layer between them, and the ADR-202 bridge may later back it.

Estimated effort: 4–6 days (log writer/replayer + scaffold template + toggle).

### 2.4 PTC/RLM — deferred, experiment-gated

Prime Agent's strongest claim — kernel-as-only-tool is more token-efficient than JSON tool schemas — would invert our kernel boundary (ADR-002), MCP gating (ADR-022), and the ADR-047 control plane. We do **not** adopt it on third-party evidence. Instead we pre-register an A/B on `packages/evals-toolcall`:

- **Arms**: (a) current JSON-schema tool dispatch; (b) a REPL arm where the same kernel tools are exposed as callable functions inside a persistent interpreter.
- **Metrics**: tokens/task and task success rate, same task set, same model, fixed seeds.
- **Promotion criterion (pre-registered)**: adopt PTC as an optional harness primitive only if the REPL arm shows ≥20% token reduction at non-inferior success (one-sided, α = 0.05); otherwise record the null honestly (ADR-235 discipline).
- The experiment manifest lives at `packages/evals-toolcall/experiments/ptc-ab.json`; its existence is part of this ADR's test contract so the deferral is executable, not vaporware.

### 2.5 A2A and persistent sub-agent identity — declined here

Prime Agent's `agent_message` skill (delivery modes `auto`/`steer`/`follow_up`) and persistent sub-agent IDs are real capabilities, but agent identity and cross-agent coordination are already owned by ADR-240 (AGNTCY DIDs, directory, observability) and its runtime companion ruflo ADR-380. The only integration this ADR records: a persistent Prime Agent sub-agent ID is a natural **subject** for an ADR-240 identity block, and any future A2A wiring for generated harnesses goes through that pair, not a second mechanism.

## Consequences

- Darwin gains a failure-targeted proposer where ADR-234 showed the blind one compounding at ~zero — the highest-leverage lift available without touching the gate. **Cost**: refine calls an LLM per child; per-generation cost rises, bounded by existing budget caps and the fact that refine is one proposer among several.
- HarnessSpec grows an `autonomous` block — one more surface Darwin may legally mutate (e.g. heartbeat cadence, gate strictness), and one more thing adapters must project or explicitly no-op. Genome round-trip must stay lossless.
- Generated harnesses that enable sessions carry disk state; docs must say where it lives and how to prune it.
- PTC stays unshipped absent a measured win; if the A/B nulls, we keep the JSON-schema model and say so.
- What does **not** change: the frozen promotion gate (ADR-072), the default-deny MCP posture (ADR-022), the kernel boundary (ADR-002), ADR-240's ownership of identity/A2A.

## Alternatives Considered

- **Wholesale prompt rewrites as the refine operation** — rejected. Both the ADR-159 thesis ("structured policies, not prompts") and Prime Agent's own design (small targeted CRUD, not rewrites) argue for minimal evidenced edits; big rewrites also defeat byte-identical rollback.
- **Replace population-based mutation with refine-only** — rejected. The archive's diversity guarantees (ADR-073) and sibling-diversity exploration (ADR-104) come from the population; refine is a proposer *within* that machinery. Prime Agent itself pairs refine with human steering, not with a search loop — we keep the loop.
- **Adopt PTC/RLM now** — rejected. Architectural inversion on third-party benchmarks, plus Prime Agent's own caveats (no sandbox; observed reward hacking on Factorio) — exactly the class of claim our honest-null discipline (ADR-235) exists to test first.
- **A daemon + attach/detach for generated harnesses** — rejected for now. High operational surface for a scaffold output; the JSONL log + resume contract captures most recovery value with none of the daemon's footprint.
- **Do nothing** — rejected. ADR-226/234 already told us the current proposer is the weak link; a proven design for exactly that slot, MIT-licensed and documented, is the cheapest credible fix to evaluate.

## Test Contract

Per the house taxonomy (London-school unit for kernel/darwin units; integration for loop behavior; contract for adapters/specs):

1. **RefineMutator unit**: given fixture `failedTraces`, emits a change to exactly one surface file; the `summary` contains ≥1 evidence trace ID present in the fixtures; output passes `validateGeneratedCode`; with empty/uncitable evidence it returns the parent unchanged (safe no-op). Deterministic under fixed seed; same-surface siblings with distinct nonces produce distinct edits (ADR-104 preserved).
2. **Rollback unit**: apply-then-rollback restores the parent surface **byte-identically**; flywheel lineage records both the edit and its inverse.
3. **Promotion integration**: a refine child failing the frozen scorer is NOT promoted; the gate fingerprint before/after a refine generation is identical (ADR-072 unchanged).
4. **Spec contract**: the `autonomous` block round-trips genome ⇄ spec losslessly; `validateSpec` rejects malformed budgets/gates (negative tokenBudget, empty gateCommand, maxTurns < 1); replay halts deterministically at budget exhaustion and reports halt-reason ≠ success.
5. **Session integration**: write N events, kill mid-run, resume → reconstructed state hash equals the pre-kill hash; forking at event k yields a divergent branch ID whose independent replay differs from the parent's after k.
6. **PTC deferral contract**: `packages/evals-toolcall/experiments/ptc-ab.json` exists, parses, and pre-registers arms, metrics, seeds, and the promotion criterion above.

## References

- Prime Intellect, "Prime Agent: A self-improving RLM agent" — <https://www.primeintellect.ai/blog/prime-agent>
- `PrimeIntellect-ai/prime-agent` (MIT) — <https://github.com/PrimeIntellect-ai/prime-agent>, docs at `packages/coding-agent/docs/` (`skills.md`, `architecture.md`, `long-running-agents.md`, `rlm.md`)
- `PrimeIntellect-ai/rlm-harness` — <https://github.com/PrimeIntellect-ai/rlm-harness>
- [`docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md`](../research/scaffolding/PRIME-AGENT-ANALYSIS.md) — verified mechanics + gap map (the evidence base for every verdict above)
- ADR-226 (advisor null), ADR-234/237 (compounding nulls), ADR-235 (re-executing verifiers + honest null replay), ADR-071/072/073/104 (Darwin machinery), ADR-159 (HarnessSpec), ADR-202 (jujutsu dual-state), ADR-240 (AGNTCY), ADR-242 (companion host adapter)
