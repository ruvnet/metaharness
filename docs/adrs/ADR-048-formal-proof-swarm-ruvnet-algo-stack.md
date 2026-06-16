# ADR-048: A Formal-Proof Swarm for `unsorry` — orchestrating the ruvnet algo stack

**Status**: Proposed
**Date**: 2026-06-16
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-044 (host capability + live verify), ADR-045 (CLI host wiring), ADR-046 (real-install verification), ADR-047 (Algorithmic Agent Harness control plane), ADR-011 (witness/provenance), ADR-040/043 (router)
**External**: [`agenticsnz/unsorry`](https://github.com/agenticsnz/unsorry) · [`agenticsorg/lean-agentic`](https://github.com/agenticsorg/lean-agentic) · [`ruvnet/sublinear-time-solver`](https://github.com/ruvnet/sublinear-time-solver) · [`ruvnet/ruvector`](https://github.com/ruvnet/RuVector)

---

## Context

[`unsorry`](https://github.com/agenticsnz/unsorry) is a distributed swarm that turns Lean 4
`sorry`s into **kernel-verified** proofs. It is deliberately **ungameable**: the Lean 4.30.0
kernel (via `lake build` against `mathlib v4.30.0`) is the *only* truth oracle, the git repo
is the *only* infrastructure, and coordination artifacts are written in the formal **AISP**
notation and machine-linted in CI. The leaderboard ranks contributors by merged,
kernel-verified lemmas; the targets that matter are **mathlib-absent, non-trivial** results.

Queue state observed 2026-06-16 (`/tmp/unsorry`, depth-1 clone):

| status | count |   | open difficulty | count |
|--------|------:|---|----------------:|------:|
| open   | 348  |   | d1 | 13 |
| proved | 261  |   | d2 | 149 |
| archived | 138 |  | d3 | 161 |
| translated | 10 | | d4 | 24 |
| blocked | 5   |   | d5 | 1 |

The AISP swarm contract (`swarm/protocol.aisp`): claims push to a `claims` branch
(first-push-wins, TTL 7200s, ≤1 live claim per prove-goal); a failed attempt is **split into
sub-lemmas** (decomposition record) and the claim released; proved lemmas land in a
**content-addressed index** (`library/index/<sha>.aisp`) and the swarm **prefers goals
closest to the already-merged library** so each merge makes the next cheaper.

**The opportunity (why this is worth an ADR).** `unsorry`'s loop is, structurally, the same
class of problem ruvnet already builds for — distributed claims, best-first scheduling on a
dependency graph, memory-backed reuse, and a verification gate. Attacking it with ruvnet's
own tools yields **reusable algorithms**, not just a leaderboard entry. The leaderboard is the
proving ground; the algorithms are the product.

## Decision

Build a **metaharness `unsorry` participation harness** that orchestrates three ruvnet
libraries into the AISP loop, and extract the load-bearing algorithms as a reusable stack.

```
        ┌──────────────────────── metaharness unsorry harness ────────────────────────┐
        │  AISP loop:  pull → SELECT → CLAIM → PROVE → VERIFY(lake build) → CHECK-IN    │
        │                      │           │        │           │                       │
        │                      ▼           ▼        ▼           ▼                        │
        │   sublinear-time-solver    claims/TTL   lean-agentic   Lean 4 kernel           │
        │   (goal selection)         (git, AISP)  (proof memory  (the ONLY oracle)       │
        │            │                            + attestation)                         │
        │            ▼                                  ▲                                │
        │        ruvector (lemma-reuse vector index, SONA self-learning) ───────────────┘
        └───────────────────────────────────────────────────────────────────────────────┘
```

### Layer responsibilities

1. **sublinear-time-solver — goal selection as graph diffusion.** "Prefer goals closest to
   the merged library" + "compounding reuse" is a stationary-distribution / influence
   computation over the goal-dependency graph. Model the graph as an asymmetric
   diagonally-dominant system and use the solver's **forward-push / random-walk** methods to
   rank open goals by expected compounding *in sublinear time* — without materialising the
   full graph each tick. Its `x-complexity` MCP annotations let the loop refuse over-budget
   queries at tool-list time.

2. **ruvector — lemma reuse / compounding.** Replace `unsorry`'s flat content-addressed
   index with a **self-learning vector index**: embed every proved lemma statement, and for a
   new goal retrieve the k nearest proved lemmas to seed the proof (import + invoke). SONA
   feedback (proof succeeded/failed with this seed) tunes retrieval over time — the
   "compounding" the README aspires to, made adaptive.

3. **lean-agentic — proof memory + attestation.** AgentDB **self-learning theorems** store
   `(statement → strategy → proof)` triples retrievable by embedding; **Ed25519 proof
   attestation** + multi-agent consensus add a provenance/chain-of-custody layer over each
   contribution. *Boundary (see Non-goals):* lean-agentic is the orchestration/memory/trust
   layer — it does **not** replace `unsorry`'s `lake build` kernel gate; the submitted
   artifact is always a real Lean 4 `.lean` re-checked by the Lean kernel.

4. **metaharness — the harness.** Wires the above into the chosen host(s) (Claude Code /
   Codex drive; Gemini/OpenAI local-mode) with the AISP claim protocol, a `lake build`
   verify-before-PR gate, and the `decompose-on-failure` fallback.

## The reusable algorithm stack (the actual deliverable)

Each algorithm is extracted as a documented, dependency-light module and mapped to where it
already wants to live in ruvnet:

| # | Algorithm (from `unsorry`) | ruvnet tool that implements it | Reuse target |
|---|---|---|---|
| 1 | **Best-first goal selection** — rank work by graph-diffusion "closeness to done" | sublinear-time-solver (forward-push / random-walk) | ruflo router (ADR-040/043), ruv-drone task **allocation**, swarm scheduling |
| 2 | **Reuse / compounding** — retrieve nearest prior result to seed the next | ruvector (HNSW + SONA self-learning) | ruflo memory, rulake cache, RAG seeding |
| 3 | **Proof/result memory + attestation** — store `(problem→strategy→solution)`, sign it | lean-agentic (AgentDB + Ed25519) | ruflo witness (ADR-011), reasoningbank |
| 4 | **Decompose-on-failure** — split an unsolved goal into claimable sub-goals | metaharness control plane (ADR-047) + GOAP | ruflo goal-planner/SPARC, ruv-drone planning |
| 5 | **Claim-with-TTL, first-push-wins** — lock-free distributed work claiming | git-as-queue (AISP) | ruflo claims board, hive-mind coordination |
| 6 | **Verification-gated merge** — an exact oracle re-checks every contribution | Lean kernel here; generalises to any cheap exact verifier | metaharness verify gates, ruflo witness, ruv-drone failsafe |

> The general principle `unsorry` proves out — *trust is free because an exact verifier
> re-checks everything* — is the same one behind metaharness's witness/provenance and
> ruflo's verification gates. Algorithm #6 is the thesis; #1–#5 make it scale.

## Honest assessment & non-goals

- **No guarantee of the #1 spot.** It is earned by kernel-verified, ideally mathlib-absent
  proofs — frontier work. This ADR commits to the **algorithm stack + the harness + genuine
  verified contributions**, not a rank.
- **No spamming a friend's repo.** `unsorry` is red-team-hardened against careless/adversarial
  agents. Contributions go through the real AISP claim protocol; PRs to `agenticsnz/unsorry`
  are **human-gated**, not autonomous. Low-value/elementary lemmas that don't move the
  research needle are not the target.
- **lean-agentic ≠ the Lean kernel.** lean-agentic has its own fast proof terms / Ed25519
  layer; `unsorry`'s oracle is standard Lean 4.30.0 + mathlib via `lake build`. We use
  lean-agentic for orchestration/memory/attestation and verify the *actual* `.lean` with
  `lake build`. (To be confirmed empirically in implementation — flagged, not assumed.)
- **Difficulty honesty.** We start at d1→d2 to validate the loop end-to-end, then push toward
  d3+ where the leaderboard value is — explicitly tracking which proofs are mathlib-absent.

## Implementation plan / status (2026-06-16)

1. ☑ Reconnaissance — queue state, AISP protocol, difficulty distribution, d1 statements read.
2. ◧ Toolchain — Lean 4.30.0 installed; mathlib cache fetching (the `lake build` kernel gate).
3. ☐ Harness scaffold — `unsorry` metaharness harness (hosts + AISP loop + verify gate).
4. ☐ Algorithm stack — modules #1–#6 above, with the ruvnet-project mappings, as a library.
5. ☐ Verified contributions — claim → prove → `lake build` the d1→d2 open goals; human-gated PRs.

## Consequences

- **Positive**: ruvnet gets a reusable scheduling/reuse/attestation stack validated against a
  hard, ungameable benchmark; `unsorry` gets a legitimate, well-coordinated contributor; the
  "exact-verifier ⇒ free trust" thesis is demonstrated across domains (proofs ↔ harnesses).
- **Risk**: the heavy mathlib toolchain + slow per-proof `lake build` cap throughput; the
  hardest (highest-value) goals may exceed current autonomous proving ability — mitigated by
  decomposition (#4) and reuse (#2), and bounded honestly.
- **Negative**: three external npm/MCP dependencies (lean-agentic, ruvector,
  sublinear-time-solver) enter the harness's surface; each is pinned + gated like any dep.
