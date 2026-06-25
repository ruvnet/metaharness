// SPDX-License-Identifier: MIT
//
// Leduc Hold'em — the standard "next step up" from Kuhn and a real CFR
// benchmark. A 6-card deck (ranks J<Q<K, two suits each), one private card per
// player, a betting round, one public card, a second betting round, showdown.
// Fixed-limit: bet size 2 pre-board, 4 post-board, max two raises per round.
// A private card that matches the public card is a pair and beats any unpaired
// hand; otherwise the higher private card wins, equal ranks split.
//
// It has ~288 information sets and a few thousand histories — small enough for
// exact best-response, large enough that a buggy solver will visibly fail to
// converge. Suits are irrelevant to strategy, so information sets collapse over
// suit while `state_key` keeps physical-card identity for exact chance math.

use crate::game::Game;

const RANKS: [&str; 3] = ["J", "Q", "K"];
const BET_SIZE: [f64; 2] = [2.0, 4.0]; // round 0, round 1
const MAX_RAISES: u8 = 2;

#[inline]
fn rank_of(card: u8) -> u8 {
    card / 2
}

#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum LeducAction {
    /// Chance: deal (player-0 physical card, player-1 physical card).
    DealHole(u8, u8),
    /// Chance: deal the public physical card.
    DealBoard(u8),
    /// Fold (only legal when facing a bet).
    Fold,
    /// Call a bet, or check when nothing is owed.
    Call,
    /// Bet / raise.
    Raise,
}

#[derive(Copy, Clone, Eq, PartialEq, Debug)]
enum Phase {
    DealHole,
    Round0,
    DealBoard,
    Round1,
    Done,
}

#[derive(Clone, Debug)]
pub struct LeducState {
    p: [Option<u8>; 2],
    board: Option<u8>,
    phase: Phase,
    contrib: [f64; 2],
    to_act: usize,
    bets_this_round: u8,
    to_call: f64,
    last_was_check: bool,
    folded: Option<usize>,
    r0: String,
    r1: String,
}

#[derive(Default, Clone, Copy)]
pub struct LeducHoldem;

impl LeducHoldem {
    pub fn new() -> Self {
        LeducHoldem
    }

    fn round_idx(s: &LeducState) -> usize {
        matches!(s.phase, Phase::Round1) as usize
    }

    fn hist_mut(s: &mut LeducState) -> &mut String {
        if matches!(s.phase, Phase::Round1) {
            &mut s.r1
        } else {
            &mut s.r0
        }
    }

    /// Advance the state machine after a betting round closes.
    fn close_round(s: &mut LeducState) {
        match s.phase {
            Phase::Round0 => {
                s.phase = Phase::DealBoard;
            }
            Phase::Round1 => {
                s.phase = Phase::Done;
            }
            _ => unreachable!("close_round in non-betting phase"),
        }
    }

    fn reset_betting(s: &mut LeducState) {
        s.bets_this_round = 0;
        s.to_call = 0.0;
        s.last_was_check = false;
        s.to_act = 0;
    }
}

impl Game for LeducHoldem {
    type State = LeducState;
    type Action = LeducAction;

    fn name(&self) -> &'static str {
        "leduc"
    }

    fn root(&self) -> LeducState {
        LeducState {
            p: [None, None],
            board: None,
            phase: Phase::DealHole,
            contrib: [1.0, 1.0], // antes
            to_act: 0,
            bets_this_round: 0,
            to_call: 0.0,
            last_was_check: false,
            folded: None,
            r0: String::new(),
            r1: String::new(),
        }
    }

    fn is_terminal(&self, s: &LeducState) -> bool {
        matches!(s.phase, Phase::Done)
    }

    fn is_chance(&self, s: &LeducState) -> bool {
        matches!(s.phase, Phase::DealHole | Phase::DealBoard)
    }

    fn current_player(&self, s: &LeducState) -> usize {
        s.to_act
    }

    fn chance_outcomes(&self, s: &LeducState) -> Vec<(LeducAction, f64)> {
        match s.phase {
            Phase::DealHole => {
                let mut out = Vec::with_capacity(30);
                for i in 0u8..6 {
                    for j in 0u8..6 {
                        if i != j {
                            out.push((LeducAction::DealHole(i, j), 1.0 / 30.0));
                        }
                    }
                }
                out
            }
            Phase::DealBoard => {
                let p0 = s.p[0].unwrap();
                let p1 = s.p[1].unwrap();
                let remaining: Vec<u8> = (0u8..6).filter(|&c| c != p0 && c != p1).collect();
                let prob = 1.0 / remaining.len() as f64;
                remaining
                    .into_iter()
                    .map(|c| (LeducAction::DealBoard(c), prob))
                    .collect()
            }
            _ => Vec::new(),
        }
    }

    fn legal_actions(&self, s: &LeducState) -> Vec<LeducAction> {
        let mut acts = Vec::with_capacity(3);
        // Call/check is always available at a decision node.
        acts.push(LeducAction::Call);
        if s.bets_this_round < MAX_RAISES {
            acts.push(LeducAction::Raise);
        }
        if s.to_call > 0.0 {
            acts.push(LeducAction::Fold);
        }
        acts
    }

    fn apply(&self, s: &LeducState, a: LeducAction) -> LeducState {
        let mut t = s.clone();
        match a {
            LeducAction::DealHole(i, j) => {
                t.p = [Some(i), Some(j)];
                t.phase = Phase::Round0;
                Self::reset_betting(&mut t);
            }
            LeducAction::DealBoard(c) => {
                t.board = Some(c);
                t.phase = Phase::Round1;
                Self::reset_betting(&mut t);
            }
            LeducAction::Fold => {
                Self::hist_mut(&mut t).push('f');
                t.folded = Some(t.to_act);
                t.phase = Phase::Done;
            }
            LeducAction::Call => {
                Self::hist_mut(&mut t).push('c');
                let facing_bet = t.to_call > 0.0;
                t.contrib[t.to_act] += t.to_call;
                t.to_call = 0.0;
                if facing_bet {
                    // Calling a bet closes the round.
                    Self::close_round(&mut t);
                } else if t.last_was_check {
                    // Check-check closes the round.
                    Self::close_round(&mut t);
                } else {
                    // First check; pass the turn.
                    t.last_was_check = true;
                    t.to_act ^= 1;
                }
            }
            LeducAction::Raise => {
                Self::hist_mut(&mut t).push('r');
                let size = BET_SIZE[Self::round_idx(s)];
                // Pay any outstanding call, then add the raise increment.
                t.contrib[t.to_act] += t.to_call + size;
                t.to_call = size;
                t.bets_this_round += 1;
                t.last_was_check = false;
                t.to_act ^= 1;
            }
        }
        t
    }

    fn infoset_key(&self, s: &LeducState) -> String {
        let me = s.to_act;
        let card = RANKS[rank_of(s.p[me].expect("infoset on undealt")) as usize];
        let board = match s.board {
            Some(b) => RANKS[rank_of(b) as usize],
            None => "-",
        };
        format!("{card}|{}|{board}|{}", s.r0, s.r1)
    }

    fn state_key(&self, s: &LeducState) -> String {
        let f = |o: Option<u8>| o.map(|c| c.to_string()).unwrap_or_else(|| "_".into());
        format!(
            "{}/{}/{}|{:?}|{}|{}",
            f(s.p[0]),
            f(s.p[1]),
            f(s.board),
            s.phase,
            s.r0,
            s.r1
        )
    }

    fn payoff(&self, s: &LeducState, player: usize) -> f64 {
        debug_assert!(matches!(s.phase, Phase::Done));
        // Net to player 0, then flip.
        let u0 = if let Some(folder) = s.folded {
            // Winner gains the folder's contribution.
            let winner = folder ^ 1;
            let amount = s.contrib[folder];
            if winner == 0 {
                amount
            } else {
                -amount
            }
        } else {
            // Showdown.
            let p0 = rank_of(s.p[0].unwrap());
            let p1 = rank_of(s.p[1].unwrap());
            let b = rank_of(s.board.unwrap());
            let pair0 = p0 == b;
            let pair1 = p1 == b;
            let result = if pair0 && !pair1 {
                1
            } else if pair1 && !pair0 {
                -1
            } else {
                // Neither pairs (can't both pair: only one card of the board
                // rank remains in the deck). Compare ranks.
                p0.cmp(&p1) as i32
            };
            match result.signum() {
                1 => s.contrib[1],
                -1 => -s.contrib[0],
                _ => 0.0,
            }
        };
        if player == 0 {
            u0
        } else {
            -u0
        }
    }

    fn action_label(&self, a: LeducAction) -> String {
        match a {
            LeducAction::Fold => "fold".into(),
            LeducAction::Call => "call".into(),
            LeducAction::Raise => "raise".into(),
            LeducAction::DealHole(i, j) => format!("deal({i},{j})"),
            LeducAction::DealBoard(c) => format!("board({c})"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn walk(g: &LeducHoldem) -> (usize, usize, f64) {
        // Returns (terminals, infosets, sum of leaf chance-mass) via DFS.
        let mut terminals = 0usize;
        let mut infosets = BTreeSet::new();
        let mut leaf_mass = 0.0;
        let mut stack = vec![(g.root(), 1.0f64)];
        while let Some((s, m)) = stack.pop() {
            if g.is_terminal(&s) {
                terminals += 1;
                leaf_mass += m;
                continue;
            }
            if g.is_chance(&s) {
                for (a, p) in g.chance_outcomes(&s) {
                    stack.push((g.apply(&s, a), m * p));
                }
            } else {
                infosets.insert(g.infoset_key(&s));
                let acts = g.legal_actions(&s);
                assert!(!acts.is_empty());
                for a in acts {
                    stack.push((g.apply(&s, a), m));
                }
            }
        }
        (terminals, infosets.len(), leaf_mass)
    }

    #[test]
    fn tree_well_formed() {
        let g = LeducHoldem::new();
        let (terminals, infosets, _) = walk(&g);
        assert!(terminals > 0);
        // Standard Leduc has 288 information sets.
        assert_eq!(infosets, 288, "expected 288 infosets, got {infosets}");
    }

    #[test]
    fn pair_beats_high_card() {
        let g = LeducHoldem::new();
        // p0 = J(card0), p1 = K(card4), board = J(card1) -> p0 pairs Js, wins.
        let s = LeducState {
            p: [Some(0), Some(4)],
            board: Some(1),
            phase: Phase::Done,
            contrib: [3.0, 3.0],
            ..g.root()
        };
        assert!(g.payoff(&s, 0) > 0.0);
        assert_eq!(g.payoff(&s, 0), -g.payoff(&s, 1));
    }

    #[test]
    fn fold_pays_contribution() {
        let g = LeducHoldem::new();
        let mut s = g.root();
        s.contrib = [3.0, 1.0];
        s.folded = Some(1); // player 1 folded
        s.phase = Phase::Done;
        // Player 0 wins player 1's contribution (1.0).
        assert_eq!(g.payoff(&s, 0), 1.0);
    }
}
