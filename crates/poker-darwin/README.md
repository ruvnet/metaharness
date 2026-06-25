# poker-darwin

A poker **trainer/solver** built on three pillars:

1. **CFR / CFR+ / Linear / Discounted-CFR solver** — counterfactual regret
   minimization that converges to a Nash equilibrium of two-player zero-sum
   poker, measured by **exact exploitability** (the real game-theoretic
   benchmark, not a sampled estimate).
2. **Darwin Mode** — an evolutionary search over the solver's *policy genome*
   (which regret/averaging variant, DCFR discount exponents), scored by
   measured exploitability. The CFR algorithm stays frozen; the harness around
   it **learns** the fastest-converging configuration from its own results.
   This mirrors the `@metaharness/projects` `discovery-evolve` pattern —
   *mutate structured policies, not prompts.*
3. **Optional integrations** (feature-gated, off by default):
   - `ruvector` — [`ruvnet/ruvector`](https://github.com/ruvnet/ruvector)
     (`ruvector-core`) vector DB for information-set **state abstraction** and
     episodic **experience memory**.
   - `neural` — a [candle](https://github.com/huggingface/candle) MLP
     **Deep-CFR advantage network**.
   - `realgames` — [`rs_poker`](https://crates.io/crates/rs_poker) **real Texas
     Hold'em** hand evaluation + Monte Carlo equity, for benchmarking against
     full poker.

## Games

| Game | Info sets | Why |
|------|-----------|-----|
| Kuhn Poker | 12 | Known closed-form Nash; game value −1/18. Correctness proof. |
| Leduc Hold'em | 288 | Two betting rounds, a public card, raises. Real convergence test. |

## Quick start

```bash
# Solve Kuhn/Leduc and print the exploitability convergence curve (eval harness):
cargo run -p poker-darwin -- solve --game leduc --iters 1000

# Run Darwin self-learning: evolve the solver policy, show the learning curve:
cargo run -p poker-darwin -- evolve --game leduc --generations 8

# Real Texas Hold'em equity via rs_poker:
cargo run -p poker-darwin --features realgames -- equity "AsKs" "QdQh"
```

## Library

```rust
use poker_darwin::{Solver, SolverConfig, KuhnPoker, exploitability};

let mut s = Solver::new(KuhnPoker::new(), SolverConfig::default()); // CFR+
s.train(1000);
let avg = s.average_strategy();
println!("exploitability = {:.5}", exploitability(s.game(), &avg));
```

## Tests & benchmarks

- `cargo test -p poker-darwin` — Nash value of Kuhn (−1/18), exploitability
  convergence, Darwin monotone learning + deterministic receipt.
- `cargo bench -p poker-darwin` — CFR iteration throughput and exploitability
  vs. iterations for Kuhn and Leduc.

See the ADRs: `docs/adrs/ADR-186…188`.

> Default build is pure Rust (no heavy/native deps) so it stays fast and
> wasm-safe. The `ruvector` / `neural` / `realgames` integrations are opt-in.
