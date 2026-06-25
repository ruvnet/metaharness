# ADR-188 — Chebyshev functional-schedule genome, lineage tracking, and a domain-agnostic hook

**Status:** Implemented (`crates/poker-darwin`, kind-5 genome + `optimize` module)
**Date:** 2026-06-24
**Related:** ADR-186 (poker-darwin), ADR-187 (non-stationary genome)

## Context

ADR-187's dynamic genome used simple start→end ramps. A start/end ramp can only express monotone
trajectories; it cannot represent warming, cyclic, or volatile schedules, and naive step-decay /
piecewise-constant alternatives make mutation produce discontinuous spikes. State-of-the-art
evolutionary schedule search parameterizes *continuous trajectories* with compact orthogonal basis
functions so that a one-coefficient mutation yields a smooth global-or-localized deformation of the curve.
Separately: if Darwin is really a *phase-aware optimization engine* rather than a poker-specific solver,
its per-iteration hook should accept arbitrary signals (e.g. gradients), not only counterfactual regrets.

## Decision

1. **Chebyshev functional schedules.** Replace the ramp `Schedule` with a shifted Chebyshev polynomial
   of the first kind over normalized time `t̂ = 2·progress − 1 ∈ [−1, 1]`, evaluated by **Clenshaw's
   recurrence** (numerically stable — avoids `xⁿ` catastrophic cancellation) and clamped to `[lo, hi]`
   so mutation can never produce explosive values. Storage is a fixed `[f64; 8]` array, keeping the
   schedule `Copy` and zero-allocation. `Schedule::{constant, linear, chebyshev}` cover the prior cases.
2. **Kind-5 genome (Chebyshev-dynamic).** The genome emits three trajectories — the value curve α(t), the
   momentum curve ω(t), and the pruning curve P(t) — each as order-4 Chebyshev coefficients, plus β and γ.
   Mutation jitters individual coefficients (higher orders get smaller steps to keep curves smooth).
3. **Lineage tracking.** Each population member carries a stable id + parent id; `evolve` records a
   `LineageNode` per evaluated genome and reconstructs the champion's ancestry seed→champion. This is the
   explicit, deterministic answer to "track parent-child trajectory lineages across generations."
4. **Domain-agnostic hook (`optimize`).** Extract the per-iteration physics (functional step-size,
   predictive momentum, magnitude pruning) into a `NonStationaryOptimizer` driven by the *same* `Schedule`
   type but fed arbitrary gradient/loss signals — demonstrating the engine is not coupled to
   regret-matching. CFR remains one consumer of the schedule machinery, not its definition.

## Consequences

- **Higher-order schedules push further.** On Leduc (eval 600 it), a Chebyshev champion (α curve
  `[3.13, 0.14, 0.56, 0.53]` — non-monotone, unrepresentable by a ramp) reached exploitability
  **0.002184**: best dynamic vs best static = **79.2%** lower (up from 68.8% with ramps), and **96%**
  below vanilla. The champion's lineage crossed three families: static DCFR → linear-dynamic → Chebyshev.
- **Determinism preserved.** Larger genomes change the RNG draw sequence (so receipts differ from
  ADR-187) but same-seed reproducibility and the monotone champion curve hold; tests pin both.
- **Decoupling is real.** Because `Schedule` and the optimizer hook take plain `f64` signals, the same
  Chebyshev trajectory engine that schedules CFR's α/ω/P can schedule a learning rate / momentum / sparsity
  mask for a gradient optimizer (Lottery-Ticket-style magnitude pruning, hyperparameter-schedule
  evolution). The poker solver is the first application of the engine, not its boundary.
- **Cost.** Evaluating Chebyshev curves is a handful of FMA per iteration (Clenshaw, order ≤ 8) — negligible
  next to a tree traversal.

## Reference implementation

- `Schedule` (Clenshaw recurrence, fixed `[f64; 8]`, `[lo,hi]` clamp) and the `omega_schedule` /
  `prune_schedule` config fields are in `cfr.rs`; the kind-5 genome (α/ω/P Chebyshev coefficient arrays)
  and `LineageNode` / `trace_ancestry` are in `darwin.rs`.
- `optimize.rs` (`NonStationaryOptimizer`, `minimize`) is the domain-agnostic hook: the same `Schedule`
  driving a gradient optimizer with magnitude pruning — no CFR/regret concepts, proving decoupling.
- The CLI `evolve` prints the champion's seed→champion lineage and `evaluated genomes` count.
- **Parallelism note:** per-generation scoring is embarrassingly parallel, but scoring stays sequential to
  preserve the deterministic receipt; a Rayon pass over the pure `score()` map (RNG/selection kept
  sequential) is the intended opt-in if eval cost grows. Tests pin same-seed reproducibility.
