# ADR-187 — Non-stationary Darwin: time-variant schedules, predictive momentum, regret pruning

**Status:** Implemented (`crates/poker-darwin`, kind-4 genome + dynamic solver)
**Date:** 2026-06-24
**Related:** ADR-186 (poker-darwin), ADR-188 (Chebyshev schedules)

## Context

ADR-186's Darwin trainer found the best *static* solver configuration: on Leduc it evolved a Discounted-CFR
setting (α≈2.75, β≈−0.48, γ≈2.08) that cut exploitability ~83% vs vanilla. But a static configuration
assumes the optimal "hyperparameter physics" is constant for the whole solve, which is false: the game
tree's volatility early (iteration ~10) differs sharply from late (iteration ~1000). Early you want
aggressive exploration and large regret updates; near equilibrium you want stability and micro-adjustment.
Beating the absolute ceiling requires giving Darwin the architectural levers to build a *non-stationary*
solver, not just to tune constants.

## Decision

Generalize the genome from scalars to a non-stationary solver across three orthogonal levers, all bolted
onto one per-iteration hook in the CFR loop:

1. **Time-variant DCFR schedules.** α and β become functions of iteration `t` over a known horizon
   (`alpha_schedule`/`beta_schedule`). The hypothesis: start α aggressive (~4) to blast through the early
   tree and anneal toward CFR+ levels (~1) near equilibrium.
2. **Predictive (optimistic) regret matching.** A momentum weight ω extrapolates each information set's
   regret trend before choosing the next strategy: the strategy is computed from
   `regret + ω · last_iteration_instantaneous_regret`, "skating to where the puck is going."
3. **Regret-based pruning.** A threshold P skips zero-probability actions whose cumulative regret is
   below P (they re-enter automatically as DCFR's negative-regret discount lifts them), trading a little
   exploitability-per-iteration for exploitability-per-**wall-clock-second**. A `SolveStats` counter
   reports the prune rate.

The genome carries `kind` (0 Vanilla … 4 linear-dynamic DCFR), the static DCFR exponents, the dynamic
α/β schedule endpoints + decay, ω, and P. Mutation flips family or jitters one gene; `evolve` seeds the
population across the static/dynamic spectrum and tracks the **best static vs best dynamic** genome so the
non-stationary edge is reported explicitly. Fitness remains exact exploitability; runs stay deterministic.

## Consequences

- **The dynamic family wins, and rediscovers the hypothesis.** On Leduc (eval 500 it), Darwin's champion
  is dynamic with α annealing **3.81 → 1.79** — exactly "aggressive early, stabilize late," found
  autonomously. Best dynamic **0.003372** vs best static **0.010801**: a **68.8%** reduction *on top of*
  the static gain, and **94%** below vanilla.
- **A new reporting axis.** `DarwinReport` exposes `best_static_exploitability` and
  `best_dynamic_exploitability`; the CLI `evolve` prints the "dynamic edge". This is the experiment that
  proves the lever, not a claim.
- **Generality.** Momentum and pruning are independent of the DCFR discount and compose with any variant;
  the per-iteration hook is the single place all three levers apply, which sets up ADR-188's functional
  schedules and a domain-agnostic optimizer.
- **Risk.** Pruning can, in principle, prune an action that later matters; the re-entry mechanism (regret
  discount lifting it back above P) plus the `sigma == 0` guard keeps best-response convergence intact —
  asserted by tests (dynamic ≤ best static on Leduc; exploitability still falls).

## Reference implementation

- The three levers live on one per-iteration hook in `cfr.rs`: `Schedule`-typed `alpha_schedule` /
  `beta_schedule` on `SolverConfig`, predictive momentum in `prepare_node` (`regret + ω · last_instant`),
  and regret pruning in `cfr_rec` (with a `SolveStats` prune-rate counter).
- The kind-4 genome and the static/dynamic-aware `evolve` are in `darwin.rs`; `DarwinReport` exposes
  `best_static_exploitability` / `best_dynamic_exploitability`, surfaced by the CLI `evolve` "dynamic edge".
- Reproduce: `poker-darwin evolve --game leduc --generations 12 --population 18 --eval-iters 500`
  (deterministic for a fixed seed).
