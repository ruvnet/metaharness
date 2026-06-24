// SPDX-License-Identifier: MIT
//
// A domain-agnostic, non-stationary optimizer driven by the *same* Chebyshev
// `Schedule` engine that schedules the CFR solver's α / ω / P. Its existence is
// the answer to "is Darwin coupled to regret-matching?": no — the per-iteration
// hook takes arbitrary gradient signals. CFR is one consumer of the schedule
// machinery (it maps the schedules onto counterfactual-regret physics); this
// optimizer is another (it maps them onto gradient descent with momentum and
// magnitude pruning, à la the Lottery Ticket Hypothesis).
//
// The genome that Darwin evolves (Chebyshev coefficient vectors, ADR-188) is
// equally applicable here: swap the fitness function from "−exploitability of a
// solved game" to "−validation loss of a trained network" and the same
// evolutionary loop tunes a bespoke optimizer schedule for any dataset.

use crate::cfr::Schedule;

/// Per-iteration physics shared across domains: a functional step-size, a
/// functional momentum coefficient, and a functional magnitude-pruning
/// threshold — each a [`Schedule`]. Fed arbitrary gradients via [`Self::step`].
#[derive(Clone, Debug)]
pub struct NonStationaryOptimizer {
    step_size: Schedule,
    momentum: Schedule,
    pruning: Schedule,
    weights: Vec<f64>,
    velocity: Vec<f64>,
    active: Vec<bool>,
    t: u64,
    horizon: u64,
}

impl NonStationaryOptimizer {
    pub fn new(
        initial_weights: Vec<f64>,
        horizon: u64,
        step_size: Schedule,
        momentum: Schedule,
        pruning: Schedule,
    ) -> Self {
        let n = initial_weights.len();
        NonStationaryOptimizer {
            step_size,
            momentum,
            pruning,
            weights: initial_weights,
            velocity: vec![0.0; n],
            active: vec![true; n],
            t: 0,
            horizon,
        }
    }

    /// The unified per-iteration hook. `gradients` are arbitrary — they need not
    /// come from regret matching. Applies functional momentum, the weight
    /// update, and non-stationary magnitude pruning (pruned weights freeze at 0
    /// and stop accumulating momentum, isolating live weights from dead noise).
    pub fn step(&mut self, gradients: &[f64]) {
        assert_eq!(gradients.len(), self.weights.len());
        let lr = self.step_size.at(self.t, self.horizon);
        let mom = self.momentum.at(self.t, self.horizon);
        let thr = self.pruning.at(self.t, self.horizon);
        // Zip the parallel tracks so the compiler can elide bounds checks and
        // auto-vectorize the fused update (the user's "unified hook" layout).
        let iter = self
            .weights
            .iter_mut()
            .zip(self.velocity.iter_mut())
            .zip(self.active.iter_mut())
            .zip(gradients.iter());
        for (((weight, velocity), active), &grad) in iter {
            if !*active {
                continue;
            }
            *velocity = mom * *velocity + lr * grad;
            *weight -= *velocity;
            if weight.abs() < thr {
                *weight = 0.0;
                *velocity = 0.0;
                *active = false;
            }
        }
        self.t += 1;
    }

    pub fn weights(&self) -> &[f64] {
        &self.weights
    }

    /// Number of weights not yet structurally pruned.
    pub fn active_count(&self) -> usize {
        self.active.iter().filter(|&&a| a).count()
    }
}

/// Convenience driver: run `steps` iterations minimizing `loss_grad` (which maps
/// the current weights to a gradient). Returns the final weights and the loss
/// trajectory from `loss`.
pub fn minimize<G, L>(
    initial: Vec<f64>,
    steps: u64,
    step_size: Schedule,
    momentum: Schedule,
    pruning: Schedule,
    mut loss_grad: G,
    mut loss: L,
) -> (Vec<f64>, Vec<f64>)
where
    G: FnMut(&[f64]) -> Vec<f64>,
    L: FnMut(&[f64]) -> f64,
{
    let mut opt = NonStationaryOptimizer::new(initial, steps, step_size, momentum, pruning);
    let mut curve = Vec::with_capacity(steps as usize);
    for _ in 0..steps {
        let g = loss_grad(opt.weights());
        opt.step(&g);
        curve.push(loss(opt.weights()));
    }
    (opt.weights().to_vec(), curve)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimizes_a_quadratic_with_gradient_signal() {
        // f(w) = Σ wᵢ²  →  ∇ = 2w. No pruning (threshold below any value reached).
        let init = vec![3.0, -4.0, 1.5];
        let (w, curve) = minimize(
            init,
            200,
            Schedule::constant(0.1),  // step size
            Schedule::constant(0.8),  // momentum
            Schedule::constant(-1.0), // pruning effectively off (|w| never < -1)
            |w| w.iter().map(|x| 2.0 * x).collect(),
            |w| w.iter().map(|x| x * x).sum(),
        );
        assert!(
            curve.last().unwrap() < &1e-3,
            "should converge to ~0: {}",
            curve.last().unwrap()
        );
        assert!(w.iter().all(|x| x.abs() < 0.05));
    }

    #[test]
    fn magnitude_pruning_sparsifies() {
        // Annealing pruning threshold should cull the small weight and freeze it.
        let init = vec![5.0, 0.02, -5.0];
        let (w, _) = minimize(
            init,
            50,
            Schedule::constant(0.01),
            Schedule::constant(0.0),
            Schedule::linear(0.0, 0.1), // threshold grows toward 0.1
            |w| w.iter().map(|x| 0.001 * x).collect(),
            |w| w.iter().map(|x| x * x).sum(),
        );
        assert_eq!(w[1], 0.0, "small weight should be pruned to exactly 0");
        assert!(
            w[0].abs() > 1.0 && w[2].abs() > 1.0,
            "large weights survive"
        );
    }

    #[test]
    fn chebyshev_schedule_drives_a_nonpoker_optimizer() {
        // Proof of decoupling: a Chebyshev (non-monotone) step-size curve drives a
        // plain gradient optimizer with no CFR/regret concepts in sight.
        let lr = Schedule::chebyshev(&[0.05, -0.03, 0.01], 0.001, 0.1);
        let (_w, curve) = minimize(
            vec![10.0],
            300,
            lr,
            Schedule::constant(0.9),
            Schedule::constant(-1.0),
            |w| vec![2.0 * w[0]],
            |w| w[0] * w[0],
        );
        assert!(
            curve.last().unwrap() < &curve[0],
            "loss must fall under a Chebyshev LR schedule"
        );
    }
}
