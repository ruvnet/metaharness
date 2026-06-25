// SPDX-License-Identifier: MIT
//
// The extensive-form game abstraction. Everything in the crate — the CFR
// solver, the exact best-response / exploitability oracle, the Darwin fitness
// function — is generic over this trait, so a new poker variant only has to
// describe its tree once.
//
// Conventions (two-player zero-sum, perfect recall):
//   * Players are `0` and `1`. Utilities satisfy `payoff(s,0) == -payoff(s,1)`.
//   * Chance (the deal) is its own node kind with an explicit outcome
//     distribution, so CFR and best-response can integrate over it *exactly*
//     rather than sampling — that is what makes the exploitability numbers
//     ground-truth instead of estimates.
//   * `infoset_key` is what a player can observe (their card + public history);
//     all states sharing a key share a strategy. `state_key` is the full,
//     globally-unique node id (both private cards + history) used for
//     memoization in the best-response pass.

/// A perfect-recall, two-player zero-sum extensive-form game.
pub trait Game {
    /// A node in the game tree (public history + both players' private state).
    type State: Clone;
    /// A move: a player action or a chance outcome.
    type Action: Copy + Clone + Eq + std::fmt::Debug;

    /// Human-readable game name (used in reports / benchmarks).
    fn name(&self) -> &'static str;

    /// The root node, *before* the chance deal.
    fn root(&self) -> Self::State;

    /// Is this a terminal (showdown / fold) node?
    fn is_terminal(&self, s: &Self::State) -> bool;

    /// Is this a chance node (a deal)?
    fn is_chance(&self, s: &Self::State) -> bool;

    /// The player (0 or 1) to act at a decision node.
    /// Only meaningful when the node is neither terminal nor chance.
    fn current_player(&self, s: &Self::State) -> usize;

    /// Chance outcomes `(action, probability)` at a chance node.
    /// Probabilities must sum to 1.
    fn chance_outcomes(&self, s: &Self::State) -> Vec<(Self::Action, f64)>;

    /// Legal actions at a decision node, in a **stable order** that is
    /// identical for every state sharing an information set.
    fn legal_actions(&self, s: &Self::State) -> Vec<Self::Action>;

    /// Apply an action (player or chance) and return the child node.
    fn apply(&self, s: &Self::State, a: Self::Action) -> Self::State;

    /// The acting player's information-set key (perfect recall).
    fn infoset_key(&self, s: &Self::State) -> String;

    /// A globally-unique key for the full node (used for best-response memo).
    fn state_key(&self, s: &Self::State) -> String;

    /// Terminal utility for `player`. Zero-sum: `payoff(s,0) == -payoff(s,1)`.
    fn payoff(&self, s: &Self::State, player: usize) -> f64;

    /// Render an action for display (defaults to `Debug`).
    fn action_label(&self, a: Self::Action) -> String {
        format!("{a:?}")
    }
}

/// Size statistics for a game tree (the "environment" a solver is run on).
#[derive(Default, Clone, Copy, Debug, PartialEq)]
pub struct TreeStats {
    /// Player decision nodes (histories where someone acts).
    pub decision_nodes: usize,
    /// Terminal (showdown / fold) leaves.
    pub terminal_nodes: usize,
    /// Chance (deal) nodes.
    pub chance_nodes: usize,
    /// Distinct information sets (the size of the strategy table).
    pub infosets: usize,
    /// Maximum tree depth (actions from root to a leaf).
    pub max_depth: usize,
}

/// Walk a game's full tree and tally its size — used to characterize the exact
/// environment exploitability is measured on (tree size matters: a `1e-3`
/// exploitability means different things on a 12-infoset vs a 288-infoset game).
pub fn tree_stats<G: Game>(game: &G) -> TreeStats {
    use std::collections::BTreeSet;
    let mut st = TreeStats::default();
    let mut infosets = BTreeSet::new();
    let mut stack = vec![(game.root(), 0usize)];
    while let Some((s, depth)) = stack.pop() {
        st.max_depth = st.max_depth.max(depth);
        if game.is_terminal(&s) {
            st.terminal_nodes += 1;
            continue;
        }
        if game.is_chance(&s) {
            st.chance_nodes += 1;
            for (a, _) in game.chance_outcomes(&s) {
                stack.push((game.apply(&s, a), depth + 1));
            }
        } else {
            st.decision_nodes += 1;
            infosets.insert(game.infoset_key(&s));
            for a in game.legal_actions(&s) {
                stack.push((game.apply(&s, a), depth + 1));
            }
        }
    }
    st.infosets = infosets.len();
    st
}

/// Regret-matching: turn a regret vector into a strategy (probability
/// distribution). Positive regrets are normalised; an all-non-positive vector
/// falls back to the uniform strategy. This is the shared kernel of vanilla
/// CFR and CFR+ (which additionally floors regrets at zero on update).
pub fn regret_matching(regrets: &[f64], out: &mut [f64]) {
    debug_assert_eq!(regrets.len(), out.len());
    let mut sum = 0.0;
    for (o, &r) in out.iter_mut().zip(regrets) {
        let pos = if r > 0.0 { r } else { 0.0 };
        *o = pos;
        sum += pos;
    }
    if sum > 0.0 {
        for o in out.iter_mut() {
            *o /= sum;
        }
    } else {
        let u = 1.0 / out.len() as f64;
        for o in out.iter_mut() {
            *o = u;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::regret_matching;

    #[test]
    fn positive_regrets_normalised() {
        let mut out = [0.0; 3];
        regret_matching(&[3.0, 1.0, 0.0], &mut out);
        assert!((out[0] - 0.75).abs() < 1e-12);
        assert!((out[1] - 0.25).abs() < 1e-12);
        assert_eq!(out[2], 0.0);
        assert!((out.iter().sum::<f64>() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn nonpositive_falls_back_to_uniform() {
        let mut out = [0.0; 4];
        regret_matching(&[-1.0, 0.0, -5.0, 0.0], &mut out);
        for o in out {
            assert!((o - 0.25).abs() < 1e-12);
        }
    }
}
