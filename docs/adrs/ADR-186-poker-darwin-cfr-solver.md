# ADR-186 — poker-darwin: a CFR poker solver with exact exploitability + ruvector/candle/rs_poker

**Status:** Implemented (`crates/poker-darwin`, 26 tests passing)
**Date:** 2026-06-24
**Related:** ADR-119 (Darwin multidomain evolution), ADR-161 (ruVector memory tiers), ADR-187 (non-stationary genome), ADR-188 (Chebyshev schedules)

## Context

Darwin Mode in this repo evolves *structured policies, not prompts* (ADR-119/137/165). To prove the
pattern transfers to a domain with a hard, non-gameable oracle, we need a problem where "better" is a
number that cannot be faked. Two-player zero-sum poker is ideal: a strategy's distance from a Nash
equilibrium — its **exploitability** — is exactly computable on small games, so progress is provable
rather than plausible. The request was a poker trainer/solver built on Darwin and `ruvnet/ruvector`,
using `candle` as needed, fully implemented, tested, and benchmarked on real games.

Constraints discovered while scoping:
- `ruvnet/ruvector` is a 100+ crate workspace; the git protocol to GitHub is egress-blocked here, but
  `ruvector-core` **0.1.31** is published on crates.io and compiles in ~30s with
  `default-features = false, features = ["hnsw","memory-only","parallel"]` (no native/C deps).
- `rs_poker` 3.x/4.x require nightly (`#![feature(assert_matches)]`); **5.0.0** builds on stable 1.88.
- `candle` is a ~290-crate tree; building it under the workspace LTO profile is slow.

## Decision

Add a workspace crate `crates/poker-darwin` with a **pure-Rust core** and **feature-gated** heavy
integrations, so default builds stay fast and wasm-safe:

- **Game abstraction** (`game::Game`): a perfect-recall, two-player zero-sum extensive-form trait with
  explicit chance nodes, so CFR and best-response integrate over the deal *exactly* (no sampling).
  Implemented games: **Kuhn Poker** (12 infosets, 55 histories) and **Leduc Hold'em** (288 infosets,
  3,780 decision nodes, 9,451 histories, depth 10) — the canonical CFR testbeds.
- **Solver** (`cfr`): one parameterized engine covering Vanilla CFR, CFR+, Linear CFR, and Discounted
  CFR, with the invariant that an information set's strategy is computed **once per iteration** (a
  per-history recompute silently breaks multi-round convergence — see Consequences).
- **Exact best response / exploitability** (`exploit`): a two-pass, deepest-first infoset resolution
  with memoized values — ground-truth ε, not an estimate.
- **Darwin trainer** (`darwin`): evolutionary search over the solver's configuration genome, fitness =
  −exploitability, with elitism, a monotone champion curve, and a deterministic FNV-1a receipt.
- **Feature `ruvector`** (`abstraction`): `ruvector-core` `VectorDB` (HNSW) for information-set state
  abstraction (nearest-neighbour retrieval + greedy bucketing) and episodic memory.
- **Feature `neural`** (`neural`): a `candle` MLP that distils the solved policy (Deep-CFR-style).
- **Feature `realgames`** (`realgames`): `rs_poker` real Texas Hold'em hand evaluation + Monte Carlo
  equity, for benchmarking the abstraction against full poker.

## Consequences

- **Provable correctness.** CFR+ drives Kuhn's game value to **−0.05556 = −1/18** (the known
  analytic value) and Leduc to **≈ −0.085**; tests assert exploitability → 0. This is the anti-slop
  property (ADR-009) made literal: the oracle runs, it isn't trusted.
- **A real bug was caught by the oracle.** An initial implementation recomputed each infoset's strategy
  per reaching history; it converged on Kuhn but made CFR+ *slower than vanilla* on Leduc. Pinning one
  strategy per infoset per iteration restored CFR+'s expected ~5× edge. A weaker metric than exact
  exploitability would have hidden this.
- **Cost discipline.** Default build is dependency-light; `ruvector`/`neural`/`realgames` are opt-in.
  The crate is native-only (candle + redb don't target wasm) and excluded from the wasm matrix.
- **Validated integrations.** AA vs 72o equity = 87.4% (rs_poker); ruvector stores all 288 Leduc
  infosets and reaches 86.8% bucket compression; the candle net fits the Kuhn policy (loss 0.26→0.02).

## Reference implementation

`crates/poker-darwin` — dependency-light core, native-only, excluded from the wasm matrix.

- `game.rs` (the `Game` trait + `tree_stats`), `games/{kuhn,leduc}.rs`, `cfr.rs` (solver),
  `exploit.rs` (exact best-response), `rng.rs` (deterministic SplitMix64/xoshiro256**).
- Feature modules: `abstraction.rs` (`ruvector`), `neural.rs` (`neural`), `realgames.rs` (`realgames`),
  with shared `features.rs`.
- CLI eval harness `src/bin/poker-darwin.rs`: `info | solve | exploit | evolve` (+ feature demos).
- Tests: 35 passing (29 unit + 5 `tests/convergence.rs` + 1 doc); criterion benches in `benches/cfr_bench.rs`.
- Environment sizes (`poker-darwin info --game all`): Kuhn 12 infosets / 55 histories / depth 4;
  Leduc 288 infosets / 3,780 decision nodes / 9,451 histories / depth 10. Utility unit: chips (1 ante).
