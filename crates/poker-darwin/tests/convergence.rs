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
use poker_darwin::games::{AbstractHoldem, HoldemConfig, KuhnPoker, LeducHoldem};

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
fn holdem_abstraction_infosets_are_tractable() {
    // The 2-street, 6-bucket default must stay well under the exact-CFR budget
    // the task set (< ~100k infosets), and 1-street must be much smaller.
    let two = AbstractHoldem::new();
    let one = AbstractHoldem::with_config(HoldemConfig {
        streets: 1,
        ..Default::default()
    });
    let n2 = two.num_decision_infosets();
    let n1 = one.num_decision_infosets();
    assert!(
        (50..100_000).contains(&n2),
        "2-street abstraction has {n2} infosets — expected tractable (50..100k)"
    );
    assert!(
        n1 < n2,
        "1-street ({n1}) must be smaller than 2-street ({n2})"
    );
}

#[test]
fn holdem_cfr_converges_within_the_abstraction() {
    // CFR must drive exploitability of the abstracted Hold'em tree DOWN with more
    // iterations (the same property Kuhn/Leduc satisfy). This is convergence to
    // the equilibrium of the ABSTRACTION, not of full NLHE.
    let g = AbstractHoldem::new();
    let uniform_e = exploitability(&g, &std::collections::HashMap::new());
    let e_low = train_exploit(AbstractHoldem::new(), CfrVariant::CfrPlus, 200);
    let e_high = train_exploit(AbstractHoldem::new(), CfrVariant::CfrPlus, 5000);
    // 1. CFR beats uniform play.
    assert!(
        e_low < uniform_e,
        "even short CFR ({e_low}) should beat uniform ({uniform_e})"
    );
    // 2. More iterations => strictly lower exploitability (monotone-ish trend).
    assert!(
        e_high < e_low,
        "exploitability should fall with iterations on the Hold'em abstraction: \
         {e_low} (200 it) -> {e_high} (5000 it)"
    );
    // 3. The high-iteration strategy is near-equilibrium *of the abstraction*.
    assert!(
        e_high < 0.05,
        "5000-iter CFR+ should be near the abstraction's equilibrium, got {e_high}"
    );
}

#[test]
fn holdem_one_street_converges_fast() {
    // The 1-street (pre-flop-only) abstraction is tiny (36 infosets) and should
    // converge to near-zero exploitability quickly — a clean sanity check that
    // the betting/showdown logic is sound independent of the flop transition.
    let g = AbstractHoldem::with_config(HoldemConfig {
        streets: 1,
        ..Default::default()
    });
    let e = train_exploit(g, CfrVariant::CfrPlus, 5000);
    assert!(
        e < 0.01,
        "1-street Hold'em CFR+ exploitability {e} should be < 0.01"
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
