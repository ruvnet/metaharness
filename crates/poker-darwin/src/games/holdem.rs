// SPDX-License-Identifier: MIT
//
// Abstracted heads-up No-Limit Hold'em (NLHE).
//
// ⚠️  HONEST SCOPE — READ THIS FIRST.
// This is **NOT** full No-Limit Hold'em. Full NLHE has on the order of 10^160
// game states and is far beyond any exact solver. What this module implements
// is an *abstraction* of HU NLHE along three axes:
//
//   * STREETS    — pre-flop + flop only (2 streets) by default; the turn and
//                  river are dropped. Street count is a config knob
//                  (`HoldemConfig::streets`) so it can be extended later, but
//                  no real Hold'em hand is only two streets.
//   * CARDS      — each player's 1326-combo hole hand is collapsed into a small
//                  number of *strength buckets* per street (default 6). Two
//                  hands in the same bucket are treated as strategically
//                  identical. This is the standard "card abstraction" used by
//                  every practical poker solver, and it throws away card
//                  removal, suit texture, and intra-bucket strength differences.
//   * BETS       — the continuous NLHE bet-sizing space {any amount up to stack}
//                  is collapsed to a tiny discrete menu {fold, check/call,
//                  pot-sized bet, all-in}. Real solvers use a few more sizings;
//                  full NLHE allows any chip amount.
//
// Therefore the equilibrium CFR finds here, and the exploitability the oracle
// measures, are the equilibrium and exploitability **of this abstracted game**.
// Exploitability → 0 here means "Nash of the abstraction", NOT "unexploitable
// at a real table". A real opponent betting off-tree or holding a hand that
// straddles a bucket boundary is outside what this game can even express.
//
// What it *does* give: a tractable extensive-form game (target < ~100k
// infosets) that is structurally real poker — private information, multiple
// betting rounds, position, pot-odds, bluffing, slow-playing — on which exact
// CFR converges and exact best-response is computable. That is the gap this
// closes: the crate had the equity (`realgames`) and bucketing (`abstraction`)
// primitives but no NLHE *tree* to run the solver on.
//
// CHANCE MODEL (so the exact-exploitability oracle stays exact).
// The deal is modelled as an explicit, self-consistent generative process over
// buckets, with every transition carrying its probability as a chance outcome:
//   1. Pre-flop: each player independently draws a pre-flop bucket from the
//      marginal `PREFLOP_MARGINAL` (≈ equal-population strength tiers). The two
//      draws are independent (a standard abstraction simplification — it drops
//      card-removal correlation), so the joint is the product and the deal has
//      `B²` equiprobable-by-product outcomes.
//   2. Flop: each player's hand transitions pre→flop bucket via the row-
//      stochastic matrix `FLOP_TRANSITION[pre][flop]` (a hand can improve or
//      fade on the flop). Again independent across players, so `B²` outcomes.
// Because every chance edge carries an explicit probability summing to 1 at
// each node, `crate::exploit` integrates over the deal exactly — the
// exploitability numbers are ground-truth *for the abstraction*.
//
// The bucket marginals and transition matrix are baked-in constants derived to
// mirror real Hold'em strength dynamics (monotone strength ordering; weak hands
// rarely leap to the top bucket on one card, strong hands usually hold). With
// the `realgames` feature these can be cross-checked against rs_poker equity
// (see `realgames.rs`); the baked-in table keeps the default build pure-Rust
// and wasm-safe, exactly like the rest of the crate.

use crate::game::Game;

/// Number of strength buckets per street (higher index = stronger hand).
/// 6 keeps the 2-street tree well under the 100k-infoset exact-CFR budget.
pub const DEFAULT_BUCKETS: usize = 6;

/// Standard HU blind structure (small blind = button acts first pre-flop):
/// SB posts 1, BB posts 2. Stacks are in the same chip unit.
const SMALL_BLIND: f64 = 1.0;
const BIG_BLIND: f64 = 2.0;
/// Effective starting stack (per player) — small enough that pot-bet/all-in
/// terminate the tree quickly, large enough to allow a real bet-then-raise line.
const DEFAULT_STACK: f64 = 20.0;

/// Maximum number of player bets/raises allowed in a single betting round, so
/// the (otherwise unbounded NLHE) raising war stays finite and the tree stays
/// tractable. With the {pot, all-in} menu this is rarely hit, but it bounds the
/// branching hard.
const MAX_RAISES_PER_ROUND: u8 = 3;

/// Pre-flop bucket marginal (each player drawn independently). Equal-population
/// tiers: every starting hand sorted by heads-up equity and split into `B`
/// equal-mass strength classes — so the marginal is uniform. Kept as an
/// explicit slice so it is obvious it sums to 1 and so a future `realgames`
/// pass can replace it with measured class masses.
fn preflop_marginal(buckets: usize) -> Vec<f64> {
    vec![1.0 / buckets as f64; buckets]
}

/// Flop transition `T[pre][flop]`: probability a hand in pre-flop bucket `pre`
/// lands in flop bucket `flop` after the flop. Each row sums to 1. The shape
/// encodes real Hold'em dynamics:
///
///   * hands mostly stay near their pre-flop strength (diagonal mass);
///   * weak hands occasionally hit big (small upward tail) but mostly stay weak;
///   * strong hands occasionally get counterfeited (small downward tail).
///
/// Derived analytically (a discretised "stay/improve/fade" kernel) rather than
/// hand-tuned per cell, so it scales to any bucket count.
fn flop_transition(buckets: usize) -> Vec<Vec<f64>> {
    let b = buckets;
    let mut t = vec![vec![0.0f64; b]; b];
    for (pre, row) in t.iter_mut().enumerate() {
        // Unnormalised kernel: peaked at the pre-flop bucket, light tails. A
        // slight upward bias for weak hands (they can only improve) and a slight
        // downward bias for strong hands (they can only fade) keeps the marginal
        // roughly stationary — the realistic behaviour.
        for (flop, cell) in row.iter_mut().enumerate() {
            let d = flop as f64 - pre as f64;
            // Gaussian-ish stay kernel (variance 1 bucket) ...
            let stay = (-(d * d) / 1.2).exp();
            // ... plus a small "draw hits / hand fades" tail so transitions are
            // never exactly zero (keeps every abstract deal reachable, which the
            // exact oracle needs for a fully-specified chance distribution).
            *cell = stay + 0.02;
        }
        let sum: f64 = row.iter().sum();
        for cell in row.iter_mut() {
            *cell /= sum;
        }
    }
    t
}

/// Discrete NLHE bet menu (the bet abstraction).
#[derive(Copy, Clone, Eq, PartialEq, Debug)]
pub enum HoldemAction {
    /// Chance: deal pre-flop buckets `(p0_bucket, p1_bucket)`.
    DealPreflop(u8, u8),
    /// Chance: transition to flop buckets `(p0_bucket, p1_bucket)`.
    DealFlop(u8, u8),
    /// Fold (only legal when facing a bet).
    Fold,
    /// Check (nothing owed) or call (matches the outstanding bet).
    Call,
    /// Bet/raise the size of the current pot (NLHE's canonical sizing).
    PotBet,
    /// Shove the remaining stack.
    AllIn,
}

#[derive(Copy, Clone, Eq, PartialEq, Debug)]
enum Phase {
    DealPreflop,
    Preflop,
    DealFlop,
    Flop,
    Done,
}

#[derive(Clone, Debug)]
pub struct HoldemState {
    /// Per-street bucket per player. `bucket[street][player]`.
    bucket: Vec<[Option<u8>; 2]>,
    phase: Phase,
    /// Chips each player has put in the pot so far (across all streets).
    contrib: [f64; 2],
    /// Player to act at a decision node (0 or 1).
    to_act: usize,
    /// Player bets/raises made this round (bounds the raising war).
    raises_this_round: u8,
    /// Chips the player-to-act must add to continue.
    to_call: f64,
    /// `true` once one player has checked this round (for check-check close).
    last_was_check: bool,
    /// Which player folded, if any.
    folded: Option<usize>,
    /// Per-street public betting history string (for the infoset key).
    hist: Vec<String>,
}

/// Configuration for the abstracted Hold'em tree.
#[derive(Clone, Copy, Debug)]
pub struct HoldemConfig {
    /// Number of betting streets to play: 1 = pre-flop only, 2 = pre-flop+flop.
    pub streets: usize,
    /// Strength buckets per street.
    pub buckets: usize,
    /// Effective starting stack per player (chips).
    pub stack: f64,
}

impl Default for HoldemConfig {
    fn default() -> Self {
        HoldemConfig {
            streets: 2,
            buckets: DEFAULT_BUCKETS,
            stack: DEFAULT_STACK,
        }
    }
}

/// Heads-up abstracted No-Limit Hold'em over the `Game` trait.
#[derive(Clone)]
pub struct AbstractHoldem {
    cfg: HoldemConfig,
    preflop_marginal: Vec<f64>,
    flop_transition: Vec<Vec<f64>>,
}

impl AbstractHoldem {
    pub fn new() -> Self {
        Self::with_config(HoldemConfig::default())
    }

    pub fn with_config(cfg: HoldemConfig) -> Self {
        assert!(
            (1..=2).contains(&cfg.streets),
            "only 1 (pre-flop) or 2 (pre-flop+flop) streets are wired"
        );
        assert!(cfg.buckets >= 2, "need at least 2 strength buckets");
        AbstractHoldem {
            preflop_marginal: preflop_marginal(cfg.buckets),
            flop_transition: flop_transition(cfg.buckets),
            cfg,
        }
    }

    pub fn config(&self) -> HoldemConfig {
        self.cfg
    }

    /// The street index a state is currently betting on (0 = pre-flop, 1 = flop).
    fn street_idx(s: &HoldemState) -> usize {
        match s.phase {
            Phase::DealFlop | Phase::Flop => 1,
            _ => 0,
        }
    }

    /// The bucket the showdown is decided on: the deepest dealt street.
    fn showdown_bucket(s: &HoldemState, player: usize) -> u8 {
        s.bucket
            .iter()
            .rev()
            .find_map(|b| b[player])
            .expect("showdown before any deal")
    }

    fn reset_betting(&self, s: &mut HoldemState, first_to_act: usize) {
        s.raises_this_round = 0;
        s.to_call = 0.0;
        s.last_was_check = false;
        s.to_act = first_to_act;
    }

    /// Advance phase after a betting round closes (call/check-check).
    fn close_round(&self, s: &mut HoldemState) {
        match s.phase {
            Phase::Preflop => {
                if self.cfg.streets >= 2 {
                    s.phase = Phase::DealFlop;
                } else {
                    s.phase = Phase::Done;
                }
            }
            Phase::Flop => s.phase = Phase::Done,
            _ => unreachable!("close_round in non-betting phase"),
        }
    }

    /// Chips still behind for the player to act (stack minus what they've put in).
    fn remaining_stack(&self, s: &HoldemState, player: usize) -> f64 {
        (self.cfg.stack - s.contrib[player]).max(0.0)
    }

    /// Count the distinct decision information sets by walking the full tree.
    /// This is the size of the strategy table exact CFR must learn — the number
    /// the tractability budget (< ~100k) is about.
    pub fn num_decision_infosets(&self) -> usize {
        use std::collections::BTreeSet;
        let mut infosets = BTreeSet::new();
        let mut stack = vec![self.root()];
        while let Some(s) = stack.pop() {
            if self.is_terminal(&s) {
                continue;
            }
            if self.is_chance(&s) {
                for (a, _) in self.chance_outcomes(&s) {
                    stack.push(self.apply(&s, a));
                }
            } else {
                infosets.insert(self.infoset_key(&s));
                for a in self.legal_actions(&s) {
                    stack.push(self.apply(&s, a));
                }
            }
        }
        infosets.len()
    }
}

impl Default for AbstractHoldem {
    fn default() -> Self {
        Self::new()
    }
}

impl Game for AbstractHoldem {
    type State = HoldemState;
    type Action = HoldemAction;

    fn name(&self) -> &'static str {
        "holdem"
    }

    fn root(&self) -> HoldemState {
        HoldemState {
            bucket: vec![[None, None]; self.cfg.streets],
            phase: Phase::DealPreflop,
            // Blinds posted: player 0 = small blind (button), player 1 = big blind.
            contrib: [SMALL_BLIND, BIG_BLIND],
            to_act: 0,
            raises_this_round: 0,
            to_call: BIG_BLIND - SMALL_BLIND, // SB owes the blind difference
            last_was_check: false,
            folded: None,
            hist: vec![String::new(); self.cfg.streets],
        }
    }

    fn is_terminal(&self, s: &HoldemState) -> bool {
        matches!(s.phase, Phase::Done)
    }

    fn is_chance(&self, s: &HoldemState) -> bool {
        matches!(s.phase, Phase::DealPreflop | Phase::DealFlop)
    }

    fn current_player(&self, s: &HoldemState) -> usize {
        s.to_act
    }

    fn chance_outcomes(&self, s: &HoldemState) -> Vec<(HoldemAction, f64)> {
        let b = self.cfg.buckets;
        match s.phase {
            Phase::DealPreflop => {
                // Independent draws: joint probability is the product of marginals.
                let m = &self.preflop_marginal;
                let mut out = Vec::with_capacity(b * b);
                for i in 0..b {
                    for j in 0..b {
                        out.push((HoldemAction::DealPreflop(i as u8, j as u8), m[i] * m[j]));
                    }
                }
                out
            }
            Phase::DealFlop => {
                let pre0 = s.bucket[0][0].expect("flop before preflop") as usize;
                let pre1 = s.bucket[0][1].expect("flop before preflop") as usize;
                let t = &self.flop_transition;
                let mut out = Vec::with_capacity(b * b);
                for i in 0..b {
                    for j in 0..b {
                        // Each player's flop bucket transitions independently.
                        out.push((
                            HoldemAction::DealFlop(i as u8, j as u8),
                            t[pre0][i] * t[pre1][j],
                        ));
                    }
                }
                out
            }
            _ => Vec::new(),
        }
    }

    fn legal_actions(&self, s: &HoldemState) -> Vec<HoldemAction> {
        let mut acts = Vec::with_capacity(4);
        let me = s.to_act;
        let stack_left = self.remaining_stack(s, me);
        // Fold is only meaningful when facing a bet (you never fold a free check).
        if s.to_call > 0.0 {
            acts.push(HoldemAction::Fold);
        }
        // Check/call: always legal at a decision node (call may be a partial
        // all-in call if the bet exceeds the stack, but contribution is capped).
        acts.push(HoldemAction::Call);
        // Aggressive actions require chips behind and an open raise slot. They
        // are only offered when they are *distinct* from a plain call/all-in, so
        // the abstraction never carries a duplicate (zero-width) action.
        let call_cost = s.to_call.min(stack_left);
        let can_raise = s.raises_this_round < MAX_RAISES_PER_ROUND;
        if can_raise && stack_left > call_cost {
            // Pot-sized bet: the amount that makes the pot double after the call.
            let pot = s.contrib[0] + s.contrib[1];
            let pot_bet = s.to_call + pot; // standard pot-raise increment
                                           // Only offer a pot-bet if it is strictly between a call and all-in.
            if pot_bet + s.to_call < stack_left {
                acts.push(HoldemAction::PotBet);
            }
            acts.push(HoldemAction::AllIn);
        }
        acts
    }

    fn apply(&self, s: &HoldemState, a: HoldemAction) -> HoldemState {
        let mut t = s.clone();
        match a {
            HoldemAction::DealPreflop(i, j) => {
                t.bucket[0] = [Some(i), Some(j)];
                t.phase = Phase::Preflop;
                // Pre-flop: small blind (player 0) acts first, blinds already posted.
                self.reset_betting(&mut t, 0);
                t.to_call = BIG_BLIND - SMALL_BLIND;
            }
            HoldemAction::DealFlop(i, j) => {
                t.bucket[1] = [Some(i), Some(j)];
                t.phase = Phase::Flop;
                // Post-flop: big blind (player 1) acts first (out of position).
                self.reset_betting(&mut t, 1);
            }
            HoldemAction::Fold => {
                t.hist[Self::street_idx(s)].push('f');
                t.folded = Some(s.to_act);
                t.phase = Phase::Done;
            }
            HoldemAction::Call => {
                t.hist[Self::street_idx(s)].push('c');
                let facing_bet = t.to_call > 0.0;
                let me = t.to_act;
                let pay = t.to_call.min(self.remaining_stack(&t, me));
                t.contrib[me] += pay;
                t.to_call = 0.0;
                if facing_bet {
                    // Calling a bet closes the round (both have acted, amounts level).
                    self.close_round(&mut t);
                } else if t.last_was_check {
                    self.close_round(&mut t); // check-check closes the round
                } else {
                    t.last_was_check = true;
                    t.to_act ^= 1;
                }
            }
            HoldemAction::PotBet | HoldemAction::AllIn => {
                t.hist[Self::street_idx(s)].push(if matches!(a, HoldemAction::AllIn) {
                    'A'
                } else {
                    'r'
                });
                let me = t.to_act;
                let stack_left = self.remaining_stack(&t, me);
                let raise_amount = match a {
                    HoldemAction::AllIn => stack_left,
                    HoldemAction::PotBet => {
                        let pot = t.contrib[0] + t.contrib[1];
                        (t.to_call + pot).min(stack_left)
                    }
                    _ => unreachable!(),
                };
                t.contrib[me] += raise_amount;
                // The opponent now owes the part of our raise above what they'd
                // already have to call.
                t.to_call = raise_amount - t.to_call;
                if t.to_call < 0.0 {
                    t.to_call = 0.0;
                }
                t.raises_this_round += 1;
                t.last_was_check = false;
                t.to_act ^= 1;
            }
        }
        t
    }

    fn infoset_key(&self, s: &HoldemState) -> String {
        // A player sees their own bucket on each dealt street + the full public
        // betting history. Perfect recall: the key includes every street so far.
        let me = s.to_act;
        let mut k = String::new();
        for (street, b) in s.bucket.iter().enumerate() {
            if let Some(my_b) = b[me] {
                if street > 0 {
                    k.push('/');
                }
                k.push_str(&format!("b{my_b}"));
            }
        }
        k.push('|');
        // Public history per street, separated.
        for (street, h) in s.hist.iter().enumerate() {
            if street > 0 {
                k.push('/');
            }
            k.push_str(h);
        }
        k
    }

    fn state_key(&self, s: &HoldemState) -> String {
        // Globally unique: both players' buckets on every street + phase + the
        // full public history (used only for best-response memoization).
        let mut k = String::new();
        for b in &s.bucket {
            let f = |o: Option<u8>| o.map(|x| x.to_string()).unwrap_or_else(|| "_".into());
            k.push_str(&format!("{}-{};", f(b[0]), f(b[1])));
        }
        k.push_str(&format!("{:?}|", s.phase));
        k.push_str(&s.hist.join("/"));
        // Pot / to_call disambiguate states the history string alone might alias
        // under the capped-call rule.
        k.push_str(&format!(
            "|{:.1}/{:.1}/{:.1}",
            s.contrib[0], s.contrib[1], s.to_call
        ));
        k
    }

    fn payoff(&self, s: &HoldemState, player: usize) -> f64 {
        debug_assert!(matches!(s.phase, Phase::Done));
        // Net to player 0, then flip.
        let u0 = if let Some(folder) = s.folded {
            // Folder forfeits whatever they put in; winner gains exactly that.
            let amount = s.contrib[folder];
            if folder == 0 {
                -amount
            } else {
                amount
            }
        } else {
            // Showdown: compare strength buckets on the deepest dealt street.
            let b0 = Self::showdown_bucket(s, 0);
            let b1 = Self::showdown_bucket(s, 1);
            // Each player wins the *opponent's* contribution on a win (zero-sum:
            // their own contribution is returned). Pots are square because the
            // betting always levels contributions before a non-fold showdown.
            match b0.cmp(&b1) {
                std::cmp::Ordering::Greater => s.contrib[1],
                std::cmp::Ordering::Less => -s.contrib[0],
                std::cmp::Ordering::Equal => 0.0, // chop: net zero
            }
        };
        if player == 0 {
            u0
        } else {
            -u0
        }
    }

    fn action_label(&self, a: HoldemAction) -> String {
        match a {
            HoldemAction::Fold => "fold".into(),
            HoldemAction::Call => "call".into(),
            HoldemAction::PotBet => "pot".into(),
            HoldemAction::AllIn => "allin".into(),
            HoldemAction::DealPreflop(i, j) => format!("pre({i},{j})"),
            HoldemAction::DealFlop(i, j) => format!("flop({i},{j})"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// DFS the whole tree: returns (terminals, infosets, total leaf chance-mass).
    /// At a decision node every action is weighted uniformly (1/num_actions), so
    /// the accumulated leaf mass is exactly the integral of the chance measure
    /// against a (uniform) behavioural strategy — and that integral is 1.0
    /// **iff** the chance distribution is a proper, fully-specified probability
    /// measure at every chance node. That properness is what makes the
    /// exact-exploitability oracle exact over the abstraction.
    fn walk(g: &AbstractHoldem) -> (usize, usize, f64) {
        let mut terminals = 0usize;
        let mut infosets = BTreeSet::new();
        let mut leaf_mass = 0.0f64;
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
                assert!(
                    !acts.is_empty(),
                    "no legal actions at {}",
                    g.infoset_key(&s)
                );
                let w = 1.0 / acts.len() as f64;
                for a in acts {
                    stack.push((g.apply(&s, a), m * w));
                }
            }
        }
        (terminals, infosets.len(), leaf_mass)
    }

    #[test]
    fn preflop_chance_sums_to_one() {
        let g = AbstractHoldem::new();
        let mass: f64 = g.chance_outcomes(&g.root()).iter().map(|(_, p)| p).sum();
        assert!((mass - 1.0).abs() < 1e-9, "preflop chance mass {mass} != 1");
    }

    #[test]
    fn flop_transition_rows_are_stochastic() {
        let g = AbstractHoldem::new();
        for row in &g.flop_transition {
            let s: f64 = row.iter().sum();
            assert!((s - 1.0).abs() < 1e-9, "transition row sums to {s}");
            assert!(row.iter().all(|&p| p > 0.0), "every transition reachable");
        }
    }

    #[test]
    fn tree_is_well_formed_and_chance_is_proper() {
        let g = AbstractHoldem::new();
        let (terminals, infosets, mass) = walk(&g);
        assert!(terminals > 0);
        assert!(infosets > 0);
        // Total probability over all terminal leaves must be exactly 1.
        assert!(
            (mass - 1.0).abs() < 1e-6,
            "leaf chance-mass {mass} must be ~1 for exact exploitability"
        );
    }

    #[test]
    fn one_street_is_smaller_than_two() {
        let one = AbstractHoldem::with_config(HoldemConfig {
            streets: 1,
            ..Default::default()
        });
        let two = AbstractHoldem::with_config(HoldemConfig {
            streets: 2,
            ..Default::default()
        });
        let (_, i1, _) = walk(&one);
        let (_, i2, _) = walk(&two);
        assert!(i2 > i1, "2-street tree ({i2}) must dwarf 1-street ({i1})");
    }

    #[test]
    fn infosets_in_tractable_range() {
        // Default (6 buckets, 2 streets) must stay well under the exact-CFR
        // budget the task set (< ~100k infosets).
        let g = AbstractHoldem::new();
        let n = g.num_decision_infosets();
        assert!(
            n < 100_000,
            "default Hold'em abstraction has {n} infosets — over the exact-CFR budget"
        );
        assert!(n > 50, "abstraction should be richer than a toy game");
    }

    #[test]
    fn higher_bucket_wins_showdown() {
        let g = AbstractHoldem::new();
        let mut s = g.root();
        s.bucket = vec![[Some(5), Some(1)], [Some(5), Some(1)]];
        s.contrib = [6.0, 6.0];
        s.phase = Phase::Done;
        assert!(g.payoff(&s, 0) > 0.0, "stronger bucket should win");
        assert_eq!(g.payoff(&s, 0), -g.payoff(&s, 1), "zero-sum");
    }

    #[test]
    fn fold_forfeits_contribution() {
        let g = AbstractHoldem::new();
        let mut s = g.root();
        s.contrib = [3.0, 8.0];
        s.folded = Some(1); // player 1 folds; player 0 wins player 1's chips
        s.phase = Phase::Done;
        assert_eq!(g.payoff(&s, 0), 8.0);
        assert_eq!(g.payoff(&s, 1), -8.0);
    }
}
