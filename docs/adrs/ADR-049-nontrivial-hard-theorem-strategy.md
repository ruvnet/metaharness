# ADR-049: Sourcing & proving non-trivial (harder) theorems for `unsorry`

**Status**: Proposed
**Date**: 2026-06-16
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-048 (formal-proof swarm / ruvnet algo stack), ADR-047 (Algorithmic Agent Harness)
**External**: `agenticsnz/unsorry` issue **#387** ("Enforce non-trivial theorems", closed), issue **#400** ("Next batch of theorems", open)

---

## Context

The first swarm pass (ADR-048) proved 40 open goals and contributed 32 — but they were
**d1–d2**: the `dvd-k-pow-a-sub-pow-b` divisibility family (mechanical `ZMod k` + `decide`),
cyclotomic factorings (one-line `ring` witnesses), and small inequalities. `unsorry`'s
maintainers have explicitly flagged this as the wrong target:

> **#387:** *"The existing list of proven theorems are mostly trivial. I'd … insist that any
> new conjectures cannot already exist in this library [mathlib]. We need some way to enforce
> non-triviality."* — and **#400** is the test of the next *non-trivial* batch.

So the leaderboard value is **mathlib-absent, non-trivial** results, and the cheap band is
both exhausting and low-credit. The open harder queue today: **d3** (alternating
binomial-square sums, AM-GM-3, Catalan/Cassini Fibonacci shifts), **d4**
(`abstract-regular-polyhedron-realizable-iff`, `alternating-sum-k-mul-choose-eq-zero`,
`cassini-nat-fib-int`, `consecutive-fib-product-diff`, `dvd-5040-seven-consecutive-product`,
`dvd-fortyeight-coprime-…`), **d5** (`realization-determines-counts`).

The cheap tactics that cleared d1–d2 do **not** scale here: `decide` blows up past small
moduli, `nlinarith` stalls on cyclic/degree-high inequalities, and the d4/d5 goals need
genuine structure (induction schemes, combinatorial identities, case analysis, geometry).

## Decision

Shift the swarm from *coverage of the cheap band* to *depth on non-trivial targets*, with a
**non-triviality gate** in front and the ADR-048 algorithm stack doing the lifting.

### 1. Non-triviality gate (implements the spirit of #387)

Before a goal is worth a swarm slot, pre-filter it:

- **Library-closable check** — run `exact?` / `simp?` / `omega` / `decide` / `apply?` on the
  bare statement with a tight timeout. If a single mathlib lemma or one decision procedure
  closes it, the goal is **trivial** (already in, or one citation from, the library) → deprioritise.
- **mathlib-presence probe** — `exact?`-search the statement head; record the mathlib revision
  (per #387, absence is a *pre-filter*, not a proof, but it is the gate).
- Surface a **triviality score** so goal-selection (below) ranks genuinely novel goals first.

This is the same gate `unsorry` wants centrally; we run it client-side to spend effort well.

### 2. Decomposition-first proving (the lever for d4/d5)

Hard goals rarely fall to one tactic. Per the AISP loop, a failed attempt **decomposes into
sub-lemmas**; we make that the *primary* strategy for d4/d5, not the fallback:

- An attempt budget per goal; on exhaustion, emit a **decomposition record** (sub-lemma
  statements + `Post ⊆ Pre` edges) so the queue reshapes toward provable pieces.
- Examples: `cassini-nat-fib-int` → the integer Cassini identity + the nat→int bridge;
  `dvd-5040-seven-consecutive-product` → `5040 = 7!` factor lemmas via CRT over its prime
  powers; `abstract-regular-polyhedron-realizable-iff` → the finite case enumeration + a
  realizability witness per Schläfli symbol.

### 3. Dependency-reuse / compounding (ruvector)

Retrieve the k nearest **already-proved** lemmas (vector index over statements) to seed each
attempt — import + invoke them. The harder the goal, the more a partial library compounds
(a proved Cassini feeds the consecutive-fib-product diff; a proved triangular form feeds the
tetrahedral). SONA feedback tunes which seeds actually helped.

### 4. Goal-selection as value × tractability (sublinear-time-solver)

Rank open goals by **expected compounding** (graph diffusion toward the merged library, ADR-048)
**weighted by the non-triviality score** and **discounted by estimated difficulty** — a
sublinear-time computation over the dependency graph. Pick the highest value/effort frontier,
not the easiest.

### 5. Stronger proving tier

For d4/d5, escalate the model/effort ladder (lean-agentic orchestration + a frontier model;
`polyrith`, `nlinarith` with curated hint sets, `Finset.induction`, `Nat.strong_induction`,
`Decidable.decide` only where the search space is genuinely finite). Attestation (Ed25519) and
the kernel gate remain unchanged — the model proposes, the kernel decides.

## Reuse for ruvnet projects

| Mechanism | ruvnet reuse |
|---|---|
| Non-triviality gate (cheap-solver pre-filter before spending budget) | ruflo task-router "is this worth an agent?" admission control; ruv-drone planning feasibility check |
| Decomposition-first (hard task → sub-task DAG with Post⊆Pre) | ruflo GOAP/SPARC hierarchical planning; ruv-drone task allocation |
| Value × tractability selection (diffusion-weighted) | ruflo router scoring; cost-aware scheduling |
| Reuse/compounding via vector retrieval | ruflo memory / rulake seeding; reasoningbank |

## Consequences

- **Positive**: targets the credit (#387/#400 non-trivial band); the decomposition + reuse
  algorithms are exactly the ruvnet planning/memory primitives, now stress-tested on hard math.
- **Honest ceiling**: d4/d5 are research-frontier — some will only yield *decompositions*
  (still useful: they reshape the queue), not full proofs, within budget. We report decomposed
  vs proved honestly (the board already tracks both).
- **Cost**: harder proofs burn more model budget per goal and more `lake build` time; the
  non-triviality gate is what keeps that spend on goals that actually score.

## Next steps

1. Implement the non-triviality gate (`exact?`/`simp?`/`decide` probe) as a pre-selection filter.
2. Run a decomposition-first swarm over the open **d3→d4** queue (Cassini / consecutive-fib /
   7-consecutive-product / AM-GM-3 / alternating-choose-sum), reuse-seeded.
3. Contribute proved sub-lemmas + decompositions via the (now push-enabled) PR flow, solver≜ruvnet.
