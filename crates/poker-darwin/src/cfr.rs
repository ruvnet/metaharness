// SPDX-License-Identifier: MIT
//
// Counterfactual Regret Minimization — the engine that actually *solves* poker.
// Repeatedly traversing the game tree and minimizing per-information-set regret
// drives the time-averaged strategy to a Nash equilibrium of a two-player
// zero-sum game.
//
// This solver is deliberately *non-stationary*: its hyperparameters can vary
// over the course of a solve, which is the lever Darwin uses to push past the
// best static configuration (see ADR-187). It covers:
//
//   * Vanilla CFR / CFR+ / Linear CFR / static Discounted-CFR — the classics.
//   * Time-variant DCFR schedules — α and β anneal from a `start` to an `end`
//     exponent over the run, so the solver can blast through the early tree
//     aggressively and stabilize near equilibrium.
//   * Predictive (optimistic) regret matching — a momentum term ω extrapolates
//     each information set's regret trend before choosing the next strategy,
//     "skating to where the puck is going."
//   * Regret-based pruning — actions whose cumulative regret falls below a
//     threshold P (and carry zero probability) are skipped, trading a little
//     exploitability-per-iteration for a lot of exploitability-per-second.
//
// IMPORTANT invariant: the strategy of an information set is computed **once per
// iteration** and reused for every history that reaches it that iteration.
// Recomputing it per-history silently corrupts convergence (it wrecks Leduc and
// CFR+'s flooring amplifies it). The `cur_iter` cache enforces this.
//
// Chance and opponent reach are integrated *exactly* (no sampling), so the
// average strategy this produces can be scored by the exact exploitability
// oracle in `crate::exploit` — the convergence the tests assert is real.

use crate::game::{regret_matching, Game};
use std::collections::HashMap;

/// Which regret/averaging scheme to run.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CfrVariant {
    Vanilla,
    CfrPlus,
    Linear,
    /// Discounted CFR with regret exponents (α, β) and strategy exponent γ.
    Dcfr {
        alpha: f64,
        beta: f64,
        gamma: f64,
    },
}

impl CfrVariant {
    /// A short tag for reports / receipts.
    pub fn tag(&self) -> String {
        match self {
            CfrVariant::Vanilla => "vanilla".into(),
            CfrVariant::CfrPlus => "cfr+".into(),
            CfrVariant::Linear => "linear".into(),
            CfrVariant::Dcfr { alpha, beta, gamma } => {
                format!("dcfr(a={alpha:.2},b={beta:.2},g={gamma:.2})")
            }
        }
    }
}

/// Maximum Chebyshev order a schedule can carry (≤ 8 is plenty for smooth,
/// non-stationary trajectories — cyclic, warming, decaying, or volatile).
pub const MAX_CHEB: usize = 8;

/// A functional hyperparameter trajectory over the solve, represented as a
/// shifted Chebyshev polynomial of the first kind. Normalized time
/// `t̂ = 2·progress − 1 ∈ [−1, 1]` is fed to `Σ cᵢ·Tᵢ(t̂)`, evaluated with
/// **Clenshaw's recurrence** (numerically stable — no `xⁿ` catastrophic
/// cancellation) and clamped to `[lo, hi]` so mutation can never produce
/// explosive values. Fixed-array storage keeps it `Copy` and zero-alloc.
///
/// Why Chebyshev over step-decay / piecewise-constant: a mutation of one
/// coefficient yields a *smooth, global-or-localized* deformation of the curve
/// rather than a discontinuous spike, so the evolutionary search moves through a
/// well-behaved trajectory space.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Schedule {
    coeffs: [f64; MAX_CHEB],
    n: usize,
    lo: f64,
    hi: f64,
}

impl Schedule {
    /// A constant trajectory (unbounded).
    pub fn constant(v: f64) -> Self {
        let mut coeffs = [0.0; MAX_CHEB];
        coeffs[0] = v;
        Schedule {
            coeffs,
            n: 1,
            lo: f64::NEG_INFINITY,
            hi: f64::INFINITY,
        }
    }

    /// A linear ramp from `start` (t=0) to `end` (t=horizon), as the order-1
    /// Chebyshev `a₀ + a₁·t̂`.
    pub fn linear(start: f64, end: f64) -> Self {
        let mut coeffs = [0.0; MAX_CHEB];
        coeffs[0] = 0.5 * (start + end);
        coeffs[1] = 0.5 * (end - start);
        Schedule {
            coeffs,
            n: 2,
            lo: start.min(end),
            hi: start.max(end),
        }
    }

    /// An arbitrary Chebyshev trajectory with output clamped to `[lo, hi]`.
    pub fn chebyshev(coeffs: &[f64], lo: f64, hi: f64) -> Self {
        let mut c = [0.0; MAX_CHEB];
        let n = coeffs.len().min(MAX_CHEB);
        c[..n].copy_from_slice(&coeffs[..n]);
        Schedule {
            coeffs: c,
            n: n.max(1),
            lo,
            hi,
        }
    }

    /// Clenshaw's recurrence for `Σ cᵢ·Tᵢ(x)`.
    #[inline]
    fn clenshaw(&self, x: f64) -> f64 {
        let c = &self.coeffs[..self.n];
        if c.len() == 1 {
            return c[0];
        }
        let x2 = 2.0 * x;
        let (mut b2, mut b1) = (0.0, 0.0);
        for &ci in c.iter().skip(1).rev() {
            let b = ci + x2 * b1 - b2;
            b2 = b1;
            b1 = b;
        }
        c[0] + x * b1 - b2
    }

    /// Value at iteration `t` of `horizon` total, clamped to `[lo, hi]`.
    /// `horizon == 0` ⇒ value at the start of the trajectory.
    #[inline]
    pub fn at(&self, t: u64, horizon: u64) -> f64 {
        let progress = if horizon == 0 {
            0.0
        } else {
            (t as f64 / horizon as f64).min(1.0)
        };
        let x = 2.0 * progress - 1.0;
        self.clenshaw(x).clamp(self.lo, self.hi)
    }
}

/// Solver configuration — the tunable surface Darwin mutates. The classic
/// variants leave the dynamic levers off; the non-stationary "dynamic DCFR"
/// genome turns them on.
#[derive(Clone, Copy, Debug)]
pub struct SolverConfig {
    pub variant: CfrVariant,
    /// Time-variant schedule for the DCFR α exponent (overrides the static α
    /// in `variant` when `Some` and `variant` is `Dcfr`).
    pub alpha_schedule: Option<Schedule>,
    /// Time-variant schedule for the DCFR β exponent.
    pub beta_schedule: Option<Schedule>,
    /// Predictive-regret momentum (0 = off): strategy uses
    /// `regret + omega * last_instant_regret`. Scalar fallback for `omega_schedule`.
    pub omega: f64,
    /// Time-variant momentum trajectory (overrides `omega` when `Some`).
    pub omega_schedule: Option<Schedule>,
    /// Regret-pruning threshold (NEG_INFINITY = off): zero-probability actions
    /// with cumulative regret below this are skipped. Scalar fallback for
    /// `prune_schedule`.
    pub prune: f64,
    /// Time-variant pruning-threshold trajectory (overrides `prune` when `Some`).
    pub prune_schedule: Option<Schedule>,
    /// Planned total iterations, used to position the schedules.
    pub horizon: u64,
}

impl SolverConfig {
    pub fn new(variant: CfrVariant) -> Self {
        SolverConfig {
            variant,
            alpha_schedule: None,
            beta_schedule: None,
            omega: 0.0,
            omega_schedule: None,
            prune: f64::NEG_INFINITY,
            prune_schedule: None,
            horizon: 0,
        }
    }

    /// Effective momentum weight at iteration `t`.
    #[inline]
    pub fn omega_at(&self, t: u64) -> f64 {
        self.omega_schedule
            .map(|s| s.at(t, self.horizon))
            .unwrap_or(self.omega)
    }

    /// Effective pruning threshold at iteration `t`.
    #[inline]
    pub fn prune_at(&self, t: u64) -> f64 {
        self.prune_schedule
            .map(|s| s.at(t, self.horizon))
            .unwrap_or(self.prune)
    }

    /// Whether this config ever uses predictive momentum.
    #[inline]
    pub fn uses_momentum(&self) -> bool {
        self.omega != 0.0 || self.omega_schedule.is_some()
    }

    /// True if any non-stationary lever is engaged.
    pub fn is_dynamic(&self) -> bool {
        self.alpha_schedule.is_some()
            || self.beta_schedule.is_some()
            || self.uses_momentum()
            || self.prune.is_finite()
            || self.prune_schedule.is_some()
    }
}

impl Default for SolverConfig {
    fn default() -> Self {
        // CFR+ is the sensible, fast default.
        SolverConfig::new(CfrVariant::CfrPlus)
    }
}

/// Per-solve compute accounting (for exploitability-per-second comparisons).
#[derive(Default, Clone, Copy, Debug)]
pub struct SolveStats {
    pub action_visits: u64,
    pub pruned_visits: u64,
}

impl SolveStats {
    pub fn prune_rate(&self) -> f64 {
        if self.action_visits == 0 {
            0.0
        } else {
            self.pruned_visits as f64 / self.action_visits as f64
        }
    }
}

#[derive(Clone, Debug)]
struct Node {
    regret_sum: Vec<f64>,
    strategy_sum: Vec<f64>,
    /// Strategy for the current iteration (computed once, reused per history).
    cur_strategy: Vec<f64>,
    /// This iteration's accumulated instantaneous regret (momentum source).
    this_instant: Vec<f64>,
    /// Previous iteration's instantaneous regret (the prediction).
    last_instant: Vec<f64>,
    /// Iteration `cur_strategy` was computed for; gates per-iteration work.
    cur_iter: u64,
}

impl Node {
    fn new(n: usize) -> Self {
        Node {
            regret_sum: vec![0.0; n],
            strategy_sum: vec![0.0; n],
            cur_strategy: vec![1.0 / n as f64; n],
            this_instant: vec![0.0; n],
            last_instant: vec![0.0; n],
            cur_iter: 0,
        }
    }
}

/// A trained (or in-training) CFR solver over a specific game.
pub struct Solver<G: Game> {
    game: G,
    config: SolverConfig,
    table: HashMap<String, Node>,
    iterations: u64,
    stats: SolveStats,
}

impl<G: Game> Solver<G> {
    pub fn new(game: G, config: SolverConfig) -> Self {
        Solver {
            game,
            config,
            table: HashMap::new(),
            iterations: 0,
            stats: SolveStats::default(),
        }
    }

    pub fn game(&self) -> &G {
        &self.game
    }

    pub fn iterations(&self) -> u64 {
        self.iterations
    }

    pub fn stats(&self) -> SolveStats {
        self.stats
    }

    /// Run `iters` CFR iterations (each iteration traverses the tree once per
    /// player — alternating updates). Can be called repeatedly to continue.
    pub fn train(&mut self, iters: u64) {
        let root = self.game.root();
        for _ in 0..iters {
            self.iterations += 1;
            let t = self.iterations;
            for traverser in 0..2usize {
                cfr_rec(
                    &self.game,
                    &mut self.table,
                    &self.config,
                    &mut self.stats,
                    &root,
                    [1.0, 1.0, 1.0],
                    traverser,
                    t,
                );
            }
        }
    }

    /// The time-averaged strategy (the object that converges to Nash):
    /// `infoset_key -> probability per legal action`.
    pub fn average_strategy(&self) -> HashMap<String, Vec<f64>> {
        let mut out = HashMap::with_capacity(self.table.len());
        for (k, node) in &self.table {
            let sum: f64 = node.strategy_sum.iter().sum();
            let probs = if sum > 0.0 {
                node.strategy_sum.iter().map(|x| x / sum).collect()
            } else {
                vec![1.0 / node.strategy_sum.len() as f64; node.strategy_sum.len()]
            };
            out.insert(k.clone(), probs);
        }
        out
    }

    /// Number of information sets discovered.
    pub fn num_infosets(&self) -> usize {
        self.table.len()
    }
}

/// Once-per-iteration node preparation: roll the momentum window, apply the
/// (possibly time-variant) DCFR discount, then compute this iteration's
/// strategy with predictive momentum. Idempotent within an iteration.
fn prepare_node(node: &mut Node, cfg: &SolverConfig, t: u64) {
    if node.cur_iter == t {
        return;
    }
    let momentum = cfg.uses_momentum();
    // Roll momentum: last iteration's instantaneous regret becomes the prediction.
    if momentum {
        node.last_instant.copy_from_slice(&node.this_instant);
    }
    for v in &mut node.this_instant {
        *v = 0.0;
    }

    if let CfrVariant::Dcfr { alpha, beta, gamma } = cfg.variant {
        let tf = t as f64;
        // Effective exponents: scheduled if present, else the static value.
        let a = cfg
            .alpha_schedule
            .map(|s| s.at(t, cfg.horizon))
            .unwrap_or(alpha);
        let b = cfg
            .beta_schedule
            .map(|s| s.at(t, cfg.horizon))
            .unwrap_or(beta);
        let pos = tf.powf(a) / (tf.powf(a) + 1.0);
        let neg = tf.powf(b) / (tf.powf(b) + 1.0);
        for r in &mut node.regret_sum {
            *r *= if *r > 0.0 { pos } else { neg };
        }
        if t > 1 {
            let sfac = ((tf - 1.0) / tf).powf(gamma);
            for s in &mut node.strategy_sum {
                *s *= sfac;
            }
        }
    }

    // Predictive (optimistic) regret matching: extrapolate the regret trend.
    if momentum {
        let omega = cfg.omega_at(t);
        let predicted: Vec<f64> = node
            .regret_sum
            .iter()
            .zip(&node.last_instant)
            .map(|(r, d)| r + omega * d)
            .collect();
        regret_matching(&predicted, &mut node.cur_strategy);
    } else {
        regret_matching(&node.regret_sum, &mut node.cur_strategy);
    }
    node.cur_iter = t;
}

#[inline]
fn regret_contrib_weight(cfg: &SolverConfig, t: u64) -> f64 {
    match cfg.variant {
        CfrVariant::Linear => t as f64,
        _ => 1.0,
    }
}

#[inline]
fn strategy_contrib_weight(cfg: &SolverConfig, t: u64) -> f64 {
    match cfg.variant {
        CfrVariant::CfrPlus | CfrVariant::Linear => t as f64,
        _ => 1.0,
    }
}

/// The CFR recursion. `reach = [reach_p0, reach_p1, reach_chance]`. Returns the
/// expected utility of the subtree to `traverser`.
#[allow(clippy::too_many_arguments)]
fn cfr_rec<G: Game>(
    game: &G,
    table: &mut HashMap<String, Node>,
    cfg: &SolverConfig,
    stats: &mut SolveStats,
    s: &G::State,
    reach: [f64; 3],
    traverser: usize,
    t: u64,
) -> f64 {
    if game.is_terminal(s) {
        return game.payoff(s, traverser);
    }
    if game.is_chance(s) {
        let mut v = 0.0;
        for (a, p) in game.chance_outcomes(s) {
            let child = game.apply(s, a);
            let mut r = reach;
            r[2] *= p;
            v += p * cfr_rec(game, table, cfg, stats, &child, r, traverser, t);
        }
        return v;
    }

    let player = game.current_player(s);
    let actions = game.legal_actions(s);
    let n = actions.len();
    let key = game.infoset_key(s);

    // Fetch/prepare the node: exactly one strategy per infoset per iteration.
    let (sigma, regret_snapshot) = {
        let node = table.entry(key.clone()).or_insert_with(|| Node::new(n));
        debug_assert_eq!(node.regret_sum.len(), n, "infoset {key} action-count drift");
        prepare_node(node, cfg, t);
        (node.cur_strategy.clone(), node.regret_sum.clone())
    };

    if player == traverser {
        let prune_thresh = cfg.prune_at(t);
        let prune_on = prune_thresh.is_finite();
        let mut util = vec![0.0; n];
        let mut pruned = vec![false; n];
        let mut node_util = 0.0;
        for (i, &a) in actions.iter().enumerate() {
            stats.action_visits += 1;
            // Regret-based pruning: skip zero-probability, deeply-negative actions.
            if prune_on && sigma[i] == 0.0 && regret_snapshot[i] < prune_thresh {
                pruned[i] = true;
                stats.pruned_visits += 1;
                continue;
            }
            let child = game.apply(s, a);
            let mut r = reach;
            r[player] *= sigma[i];
            util[i] = cfr_rec(game, table, cfg, stats, &child, r, traverser, t);
            node_util += sigma[i] * util[i];
        }
        // Counterfactual reach = everyone *but* the traverser (opponent × chance).
        let cf = reach[1 - player] * reach[2];
        let rc = regret_contrib_weight(cfg, t);
        let sc = strategy_contrib_weight(cfg, t);
        let own_reach = reach[player];
        let floor = matches!(cfg.variant, CfrVariant::CfrPlus);
        let momentum = cfg.uses_momentum();

        let node = table.get_mut(&key).expect("node present");
        for i in 0..n {
            if pruned[i] {
                continue; // leave regret unchanged so it can re-enter later
            }
            let inc = rc * cf * (util[i] - node_util);
            node.regret_sum[i] += inc;
            if floor && node.regret_sum[i] < 0.0 {
                node.regret_sum[i] = 0.0; // regret-matching+ : floor on every update
            }
            if momentum {
                node.this_instant[i] += inc;
            }
            node.strategy_sum[i] += sc * own_reach * sigma[i];
        }
        node_util
    } else {
        // Opponent node: weight children by the opponent's current strategy.
        let mut node_util = 0.0;
        for (i, &a) in actions.iter().enumerate() {
            let child = game.apply(s, a);
            let mut r = reach;
            r[player] *= sigma[i];
            node_util += sigma[i] * cfr_rec(game, table, cfg, stats, &child, r, traverser, t);
        }
        node_util
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::KuhnPoker;

    #[test]
    fn average_strategy_rows_are_distributions() {
        let mut solver = Solver::new(KuhnPoker::new(), SolverConfig::default());
        solver.train(200);
        let avg = solver.average_strategy();
        assert_eq!(avg.len(), 12); // Kuhn has 12 infosets
        for (k, probs) in avg {
            let s: f64 = probs.iter().sum();
            assert!((s - 1.0).abs() < 1e-9, "{k} not normalised: {probs:?}");
            assert!(probs.iter().all(|&p| p >= 0.0));
        }
    }

    #[test]
    fn linear_schedule_anneals_start_to_end() {
        let s = Schedule::linear(4.0, 1.0);
        assert!((s.at(0, 100) - 4.0).abs() < 1e-9);
        assert!((s.at(100, 100) - 1.0).abs() < 1e-9);
        let mid = s.at(50, 100);
        assert!(
            (mid - 2.5).abs() < 1e-9,
            "linear midpoint should be 2.5, got {mid}"
        );
    }

    #[test]
    fn clenshaw_matches_explicit_chebyshev() {
        // T0=1, T1=x, T2=2x²−1, T3=4x³−3x. Check Σ cᵢTᵢ at a few points.
        let c = [0.3, -0.5, 0.2, 0.1];
        let s = Schedule::chebyshev(&c, f64::NEG_INFINITY, f64::INFINITY);
        for &x in &[-1.0, -0.4, 0.0, 0.7, 1.0] {
            let t0 = 1.0;
            let t1 = x;
            let t2 = 2.0 * x * x - 1.0;
            let t3 = 4.0 * x * x * x - 3.0 * x;
            let expected = c[0] * t0 + c[1] * t1 + c[2] * t2 + c[3] * t3;
            // map x back into at(): x = 2p-1 => p=(x+1)/2 => t = p*horizon
            let horizon = 1000u64;
            let t = (((x + 1.0) / 2.0) * horizon as f64).round() as u64;
            let got = s.at(t, horizon);
            assert!(
                (got - expected).abs() < 1e-6,
                "x={x}: clenshaw {got} vs explicit {expected}"
            );
        }
    }

    #[test]
    fn schedule_clamps_to_bounds() {
        let s = Schedule::chebyshev(&[0.0, 100.0], 1.0, 4.0); // huge slope, tight bounds
        assert_eq!(s.at(1000, 1000), 4.0);
        assert_eq!(s.at(0, 1000), 1.0);
    }

    #[test]
    fn momentum_and_pruning_schedules_keep_convergence() {
        // A fully dynamic config (scheduled α/ω/P) must still reduce exploitability.
        let mut cfg = SolverConfig::new(CfrVariant::Dcfr {
            alpha: 2.0,
            beta: 0.0,
            gamma: 2.0,
        });
        cfg.alpha_schedule = Some(Schedule::chebyshev(&[2.5, -1.0], 1.0, 4.0));
        cfg.omega_schedule = Some(Schedule::chebyshev(&[0.5], 0.0, 2.0));
        cfg.prune_schedule = Some(Schedule::chebyshev(&[-10.0], -30.0, -1.0));
        cfg.horizon = 500;
        let mut solver = Solver::new(KuhnPoker::new(), cfg);
        solver.train(500);
        let e = crate::exploit::exploitability(solver.game(), &solver.average_strategy());
        assert!(
            e < 0.02,
            "dynamic (Chebyshev) solver should converge on Kuhn: {e}"
        );
    }
}
