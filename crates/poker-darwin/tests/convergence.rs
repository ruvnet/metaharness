// SPDX-License-Identifier: MIT
//
// Integration tests that pin the solver's *ground-truth* behaviour:
//   * Kuhn Poker converges to its known game value of -1/18 to the first player.
//   * CFR drives exploitability toward zero (a proof of Nash convergence).
//   * CFR+ converges strictly faster than vanilla CFR on Leduc (the property the
//     "one strategy per infoset per iteration" fix restored).
//   * Darwin's evolved champion is no worse than the vanilla baseline.

use poker_darwin::cfr::{CfrVariant, Solver, SolverConfig};
use poker_darwin::darwin::{evolve, DarwinConfig};
use poker_darwin::exploit::{exploitability, profile_value};
use poker_darwin::games::{KuhnPoker, LeducHoldem};

fn train_exploit<G: poker_darwin::game::Game + Clone>(
    game: G,
    variant: CfrVariant,
    iters: u64,
) -> f64 {
    let mut s = Solver::new(game.clone(), SolverConfig::new(variant));
    s.train(iters);
    exploitability(&game, &s.average_strategy())
}

#[test]
fn kuhn_converges_to_known_game_value() {
    // Kuhn Poker's game value to player 0 at equilibrium is exactly -1/18.
    let mut s = Solver::new(KuhnPoker::new(), SolverConfig::default());
    s.train(3000);
    let v = profile_value(s.game(), &s.average_strategy());
    assert!(
        (v - (-1.0 / 18.0)).abs() < 5e-3,
        "Kuhn value {v} should be ~ -1/18 = {}",
        -1.0 / 18.0
    );
}

#[test]
fn kuhn_exploitability_drops_to_near_zero() {
    let e = train_exploit(KuhnPoker::new(), CfrVariant::CfrPlus, 3000);
    assert!(e < 0.01, "Kuhn CFR+ exploitability {e} should be < 0.01");
}

#[test]
fn cfr_plus_beats_vanilla_on_leduc() {
    // The defining property of CFR+: at an equal iteration budget it is far
    // less exploitable than vanilla CFR on a multi-round game.
    let iters = 400;
    let vanilla = train_exploit(LeducHoldem::new(), CfrVariant::Vanilla, iters);
    let cfr_plus = train_exploit(LeducHoldem::new(), CfrVariant::CfrPlus, iters);
    assert!(
        cfr_plus < vanilla * 0.5,
        "CFR+ ({cfr_plus}) should be <50% of vanilla ({vanilla}) exploitability on Leduc"
    );
}

#[test]
fn leduc_exploitability_monotone_trend() {
    // More iterations => lower exploitability (allowing CFR+ oscillation slack).
    let e_short = train_exploit(LeducHoldem::new(), CfrVariant::CfrPlus, 200);
    let e_long = train_exploit(LeducHoldem::new(), CfrVariant::CfrPlus, 1000);
    assert!(
        e_long < e_short,
        "exploitability should fall with iterations: {e_short} -> {e_long}"
    );
}

#[test]
fn darwin_champion_beats_vanilla_baseline_on_leduc() {
    let report = evolve(
        &LeducHoldem::new(),
        &DarwinConfig {
            population: 10,
            generations: 6,
            eval_iterations: 300,
            seed: 1,
            elite: 3,
        },
    );
    assert!(
        report.improved_over_baseline,
        "Darwin should beat the vanilla baseline"
    );
    assert!(
        report.champion_exploitability < report.baseline_exploitability,
        "champion {} should be < baseline {}",
        report.champion_exploitability,
        report.baseline_exploitability
    );
}
