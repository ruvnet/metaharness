// SPDX-License-Identifier: MIT
//
// Real Texas Hold'em via `rs_poker` (feature `realgames`). The CFR solver in
// this crate targets the standard *research* poker games (Kuhn, Leduc) where
// exact equilibria are computable. This module connects to *full* poker: real
// 52-card hand evaluation and Monte Carlo equity, so the harness can be
// benchmarked against the actual game it abstracts. It also provides a real
// hand-strength feature that a Hold'em abstraction or value net would consume.

use rs_poker::core::{Hand, Rankable};
use rs_poker::holdem::MonteCarloGame;

/// Estimate each player's all-in equity (probability of winning, ties split) by
/// Monte Carlo rollout of the remaining board. `hands` are hole cards like
/// "AsKs". Returns one equity per hand, summing to ~1.0.
pub fn equity(hands: &[String], iters: usize) -> Result<Vec<f32>, String> {
    let parsed: Result<Vec<Hand>, _> = hands
        .iter()
        .map(|h| Hand::new_from_str(h).map_err(|e| format!("bad hand {h:?}: {e:?}")))
        .collect();
    let parsed = parsed?;
    if parsed.len() < 2 {
        return Err("need at least two hands".into());
    }
    let mut game =
        MonteCarloGame::new(parsed).map_err(|e| format!("monte carlo init failed: {e:?}"))?;
    let mut wins = vec![0.0f64; hands.len()];
    for _ in 0..iters {
        let (winners, _rank) = game.simulate();
        let n = winners.count() as f64;
        if n > 0.0 {
            for idx in winners.ones() {
                wins[idx] += 1.0 / n;
            }
        }
        game.reset();
    }
    Ok(wins
        .into_iter()
        .map(|w| (w / iters as f64) as f32)
        .collect())
}

/// Rank a concrete 5–7 card hand (e.g. "2h2d8d8sKd6sTh") with the real
/// evaluator. Higher `Rank` is a stronger hand.
pub fn hand_rank(cards: &str) -> Result<rs_poker::core::Rank, String> {
    let hand = Hand::new_from_str(cards).map_err(|e| format!("bad hand {cards:?}: {e:?}"))?;
    Ok(hand.rank())
}

/// A normalized [0,1] hand-strength feature for a hole pair against a single
/// random opponent — exactly the kind of signal a Hold'em information-set
/// abstraction or candle value net would use as input.
pub fn hand_strength(hole: &str, iters: usize) -> Result<f32, String> {
    let hero = Hand::new_from_str(hole).map_err(|e| format!("bad hand {hole:?}: {e:?}"))?;
    // Villain hole cards are unknown; rs_poker fills them randomly each rollout.
    let villain = Hand::new_from_str("").map_err(|e| format!("villain init: {e:?}"))?;
    let mut game = MonteCarloGame::new(vec![hero, villain])
        .map_err(|e| format!("monte carlo init failed: {e:?}"))?;
    let mut hero_eq = 0.0f64;
    for _ in 0..iters {
        let (winners, _) = game.simulate();
        let n = winners.count() as f64;
        if winners.ones().any(|i| i == 0) && n > 0.0 {
            hero_eq += 1.0 / n;
        }
        game.reset();
    }
    Ok((hero_eq / iters as f64) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rs_poker::core::CoreRank;

    #[test]
    fn royal_flush_outranks_pair() {
        let royal = hand_rank("AsKsQsJsTs").unwrap();
        let pair = hand_rank("AhAd2c3d4s").unwrap();
        assert!(royal > pair, "royal flush should outrank a pair");
        assert_eq!(royal.category(), CoreRank::StraightFlush);
    }

    #[test]
    fn aces_beat_offsuit_rag_heads_up() {
        // Pocket aces should crush 7-2 offsuit; equities sum to ~1.
        let eq = equity(&["AsAc".into(), "7d2h".into()], 20_000).unwrap();
        assert!(
            (eq.iter().sum::<f32>() - 1.0).abs() < 1e-3,
            "equities should sum to 1: {eq:?}"
        );
        assert!(eq[0] > 0.8, "AA equity {} should be > 0.8 vs 72o", eq[0]);
    }
}
