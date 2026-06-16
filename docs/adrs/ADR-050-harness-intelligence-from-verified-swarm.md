# ADR-050: Harness intelligence learned from the verified-swarm push (cross-host)

**Status**: Proposed
**Date**: 2026-06-16
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-044 (capability coverage), ADR-046 (real-install verification), ADR-047 (control plane), ADR-048 (ruvnet algo stack), ADR-049 (non-trivial targets)

---

## Context

Driving a real, ungameable benchmark (`agenticsnz/unsorry` — Lean-kernel-verified proofs)
with the ruvnet stack surfaced concrete, transferable lessons about what makes an agent
*harness* — independent of model or host — produce **trustworthy, compounding** output. The
swarm proved 40/40 attempted goals, contributed 32, and opened real PRs (e.g. #1278). The
patterns that made that work are not specific to Lean; they are harness-level intelligence we
should bake into metaharness so every generated harness — Claude Code, Codex, OpenCode,
Copilot, GitHub Actions, Hermes, OpenClaw, pi-dev, RVM — inherits them.

## Decision

Promote five patterns to first-class, host-agnostic metaharness capabilities. Each maps to a
concrete artifact a generated harness can ship.

### 1. Verification-gated output (the load-bearing one)

`unsorry`'s whole safety argument: *trust is free because an exact verifier re-checks
everything.* Generalised: **a harness should never present agent output as done until a
cheap, exact-as-possible verifier passes** — and the verifier is repo-shaped:

| repo signal | the harness's verify gate |
|---|---|
| has tests | run the affected tests |
| typed (ts/rust/lean) | typecheck / `lake build` / `cargo build` |
| lint/CI config | run the linter / the CI gate locally |
| MCP policy (ADR-022) | default-deny tool gate (already shipped) |

**Artifact:** a `verify` skill + a `verify-before-submit` hook the scaffolder wires from the
repo profile (`analyze-repo` already detects tests/lang/CI). This is the single biggest
intelligence upgrade — it turns "the model says it's done" into "the gate says it's done."

### 2. Decompose-on-failure

When an attempt fails within budget, **split the task into sub-tasks with explicit
`Post ⊆ Pre` edges** and re-queue, rather than retrying the whole thing. **Artifact:** a
`decompose` skill (already partially present as `plan-change`; generalise it to emit a
sub-task DAG and recurse). Maps to the ADR-047 control plane.

### 3. Reuse / compounding memory

Retrieve the k-nearest prior solutions (vector memory) to **seed** a new task; feed
success/failure back so retrieval self-tunes. The kernel already has a memory namespace;
this ADR makes "retrieve-to-seed + learn-from-outcome" the default loop (ruvector/SONA).

### 4. Value × tractability admission + selection

Before spending an agent on a task, score it: **is it worth it (non-trivial / high
compounding) and is it tractable?** Cheap pre-filters (does one tool/citation already solve
it? is it over the J-budget?) gate admission; a diffusion-style score ranks what's left
(sublinear-time-solver). **Artifact:** a router/admission step — reusable as ruflo's
task-router. Prevents the harness from burning budget on trivial or hopeless work.

### 5. Claim-with-TTL coordination (multi-agent harnesses)

For harnesses that fan out, **lock-free first-push-wins claims with TTLs** (git-as-queue or
the kernel's claims) keep N agents off each other's work. **Artifact:** a swarm-coordination
primitive surfaced when the harness selects >1 agent.

## Implementation (incremental, low-risk)

- **Now (this ADR):** record the patterns; they already shipped *partially* (MCP default-deny
  gate, memory namespace, `plan-change`). No behaviour change yet — this is the design of
  record for the upgrades.
- **Next:** add the `verify` + `decompose` skills to the catalog (CLI `registry.ts` +
  web-UI `catalog.ts`, kept in lockstep per ADR-029), wired by `analyze-repo` from the repo's
  detected test/lang/CI signals; surface the admission/selection step in the router; gate it
  all behind the existing primitive toggles (ADR-022) so a minimal harness stays minimal.
- Each addition ships with a unit test and propagates through the ADR-030 discovery loop.

## Consequences

- **Positive**: generated harnesses get measurably "smarter" in the way that actually matters
  — verified-not-just-claimed output, decomposition of hard work, memory-seeded reuse, and
  budget discipline — uniformly across all 9 hosts. These are the same primitives ruflo /
  ruv-drone / rulake want, so the work compounds across ruvnet.
- **Cost/risk**: more catalog surface; mitigated by the primitive toggles (opt-in) and the
  lockstep CLI↔web-UI tests (ADR-027/029).
- **Provenance**: distilled from a live, kernel-gated benchmark, not speculation — the verify
  gate is exactly why the unsorry contributions are trustworthy.
