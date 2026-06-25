// SPDX-License-Identifier: MIT
//
// Kuhn Poker — the smallest non-trivial poker game and the classic CFR sanity
// check. Three cards {J<Q<K}, one each to two players, a single betting round.
// It has a *known closed-form* Nash equilibrium family and a known game value
// of -1/18 to the first player, so a correct solver must drive exploitability
// to ~0 and reproduce that value. That is exactly what the tests assert.
//
// Action encoding: `Pass` = check/fold, `Bet` = bet/call (the meaning depends
// on context, as in the standard formulation).

use crate::game::Game;

/// J=0, Q=1, K=2.
const RANKS: [&str; 3] = ["J", "Q", "K"];

#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum KuhnAction {
    /// Chance: deal (player-0 card, player-1 card).
    Deal(u8, u8),
    /// Check, or fold to a bet.
    Pass,
    /// Bet, or call a bet.
    Bet,
}

#[derive(Clone, Debug)]
pub struct KuhnState {
    /// `None` before the deal; `Some((c0, c1))` after.
    cards: Option<(u8, u8)>,
    /// Player-action history (Pass/Bet only).
    history: Vec<KuhnAction>,
}

fn hist_str(h: &[KuhnAction]) -> String {
    h.iter()
        .map(|a| match a {
            KuhnAction::Pass => 'p',
            KuhnAction::Bet => 'b',
            KuhnAction::Deal(..) => '?',
        })
        .collect()
}

/// `true` for the betting sequences that end the hand.
fn terminal_history(h: &[KuhnAction]) -> bool {
    use KuhnAction::{Bet, Pass};
    matches!(
        h,
        [Pass, Pass] | [Pass, Bet, Pass] | [Pass, Bet, Bet] | [Bet, Pass] | [Bet, Bet]
    )
}

#[derive(Default, Clone, Copy)]
pub struct KuhnPoker;

impl KuhnPoker {
    pub fn new() -> Self {
        KuhnPoker
    }
}

impl Game for KuhnPoker {
    type State = KuhnState;
    type Action = KuhnAction;

    fn name(&self) -> &'static str {
        "kuhn"
    }

    fn root(&self) -> KuhnState {
        KuhnState {
            cards: None,
            history: Vec::new(),
        }
    }

    fn is_terminal(&self, s: &KuhnState) -> bool {
        s.cards.is_some() && terminal_history(&s.history)
    }

    fn is_chance(&self, s: &KuhnState) -> bool {
        s.cards.is_none()
    }

    fn current_player(&self, s: &KuhnState) -> usize {
        s.history.len() % 2
    }

    fn chance_outcomes(&self, _s: &KuhnState) -> Vec<(KuhnAction, f64)> {
        // 6 equiprobable ordered deals of distinct cards.
        let mut out = Vec::with_capacity(6);
        for a in 0u8..3 {
            for b in 0u8..3 {
                if a != b {
                    out.push((KuhnAction::Deal(a, b), 1.0 / 6.0));
                }
            }
        }
        out
    }

    fn legal_actions(&self, _s: &KuhnState) -> Vec<KuhnAction> {
        vec![KuhnAction::Pass, KuhnAction::Bet]
    }

    fn apply(&self, s: &KuhnState, a: KuhnAction) -> KuhnState {
        match a {
            KuhnAction::Deal(c0, c1) => KuhnState {
                cards: Some((c0, c1)),
                history: Vec::new(),
            },
            other => {
                let mut h = s.history.clone();
                h.push(other);
                KuhnState {
                    cards: s.cards,
                    history: h,
                }
            }
        }
    }

    fn infoset_key(&self, s: &KuhnState) -> String {
        let (c0, c1) = s.cards.expect("infoset_key on chance node");
        let card = if self.current_player(s) == 0 { c0 } else { c1 };
        format!("{}:{}", RANKS[card as usize], hist_str(&s.history))
    }

    fn state_key(&self, s: &KuhnState) -> String {
        match s.cards {
            None => "root".to_string(),
            Some((c0, c1)) => format!("{c0}{c1}:{}", hist_str(&s.history)),
        }
    }

    fn payoff(&self, s: &KuhnState, player: usize) -> f64 {
        let (c0, c1) = s.cards.expect("payoff on undealt state");
        let p0_wins_showdown = c0 > c1;
        // Player-0 perspective, then flip for the requested player.
        let u0 = match s.history.as_slice() {
            // check-check: showdown for 1.
            [KuhnAction::Pass, KuhnAction::Pass] => {
                if p0_wins_showdown {
                    1.0
                } else {
                    -1.0
                }
            }
            // check, bet, fold: player 0 folds, loses ante.
            [KuhnAction::Pass, KuhnAction::Bet, KuhnAction::Pass] => -1.0,
            // check, bet, call: showdown for 2.
            [KuhnAction::Pass, KuhnAction::Bet, KuhnAction::Bet] => {
                if p0_wins_showdown {
                    2.0
                } else {
                    -2.0
                }
            }
            // bet, fold: player 1 folds, player 0 wins ante.
            [KuhnAction::Bet, KuhnAction::Pass] => 1.0,
            // bet, call: showdown for 2.
            [KuhnAction::Bet, KuhnAction::Bet] => {
                if p0_wins_showdown {
                    2.0
                } else {
                    -2.0
                }
            }
            other => panic!("payoff on non-terminal history {other:?}"),
        };
        if player == 0 {
            u0
        } else {
            -u0
        }
    }

    fn action_label(&self, a: KuhnAction) -> String {
        match a {
            KuhnAction::Pass => "pass".into(),
            KuhnAction::Bet => "bet".into(),
            KuhnAction::Deal(c0, c1) => {
                format!("deal({},{})", RANKS[c0 as usize], RANKS[c1 as usize])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_has_expected_terminals() {
        // Walk the whole tree and count terminals / decision infosets.
        let g = KuhnPoker::new();
        let mut terminals = 0usize;
        let mut infosets = std::collections::BTreeSet::new();
        let mut stack = vec![g.root()];
        while let Some(s) = stack.pop() {
            if g.is_terminal(&s) {
                terminals += 1;
                continue;
            }
            if g.is_chance(&s) {
                for (a, _) in g.chance_outcomes(&s) {
                    stack.push(g.apply(&s, a));
                }
            } else {
                infosets.insert(g.infoset_key(&s));
                for a in g.legal_actions(&s) {
                    stack.push(g.apply(&s, a));
                }
            }
        }
        // 6 deals × 5 terminal betting sequences = 30 terminal leaves.
        assert_eq!(terminals, 30);
        // 12 information sets (the textbook number for Kuhn).
        assert_eq!(infosets.len(), 12);
    }

    #[test]
    fn payoffs_are_zero_sum() {
        let g = KuhnPoker::new();
        let s = KuhnState {
            cards: Some((2, 0)),
            history: vec![KuhnAction::Bet, KuhnAction::Bet],
        };
        assert_eq!(g.payoff(&s, 0), 2.0);
        assert_eq!(g.payoff(&s, 1), -2.0);
    }
}
