// SPDX-License-Identifier: MIT
//
// Deep-CFR-style policy network via candle (feature `neural`).
//
// Tabular CFR stores a strategy per information set, which doesn't scale to full
// poker. Deep CFR replaces the table with a neural network that *generalizes*
// across information sets from their features. This module demonstrates the core
// mechanism end-to-end: solve Kuhn with CFR+, then train a candle MLP to predict
// the equilibrium action distribution from the same interpretable infoset
// features used by the ruvector abstraction. The training loss falling and the
// network reproducing the solved strategy is the proof the integration works.

use crate::cfr::{Solver, SolverConfig};
use crate::features::featurize;
use crate::games::KuhnPoker;
use candle_core::{DType, Device, Result as CResult, Tensor};
use candle_nn::{linear, AdamW, Linear, Module, Optimizer, ParamsAdamW, VarBuilder, VarMap};

/// A small two-layer perceptron mapping infoset features → action logits.
pub struct PolicyNet {
    l1: Linear,
    l2: Linear,
}

impl PolicyNet {
    pub fn new(vb: VarBuilder, in_dim: usize, hidden: usize, actions: usize) -> CResult<Self> {
        Ok(PolicyNet {
            l1: linear(in_dim, hidden, vb.pp("l1"))?,
            l2: linear(hidden, actions, vb.pp("l2"))?,
        })
    }

    /// Forward to raw logits (apply softmax for probabilities).
    pub fn logits(&self, x: &Tensor) -> CResult<Tensor> {
        let h = self.l1.forward(x)?.relu()?;
        self.l2.forward(&h)
    }

    /// Action-probability predictions.
    pub fn probs(&self, x: &Tensor) -> CResult<Tensor> {
        candle_nn::ops::softmax(&self.logits(x)?, 1)
    }
}

/// Train a policy net to reproduce `targets` (rows of action distributions) from
/// `features`. Returns the per-epoch loss curve and the trained net + varmap.
pub fn train_policy_net(
    features: &[Vec<f32>],
    targets: &[Vec<f32>],
    hidden: usize,
    epochs: usize,
    lr: f64,
) -> CResult<(Vec<f32>, PolicyNet, VarMap)> {
    let device = Device::Cpu;
    let n = features.len();
    assert!(n > 0 && n == targets.len());
    let in_dim = features[0].len();
    let actions = targets[0].len();

    let x = Tensor::from_vec(features.concat(), (n, in_dim), &device)?;
    let y = Tensor::from_vec(targets.concat(), (n, actions), &device)?;

    let varmap = VarMap::new();
    let vb = VarBuilder::from_varmap(&varmap, DType::F32, &device);
    let net = PolicyNet::new(vb, in_dim, hidden, actions)?;
    let mut opt = AdamW::new(
        varmap.all_vars(),
        ParamsAdamW {
            lr,
            ..Default::default()
        },
    )?;

    let mut losses = Vec::with_capacity(epochs);
    for _ in 0..epochs {
        let pred = net.probs(&x)?;
        let loss = candle_nn::loss::mse(&pred, &y)?;
        opt.backward_step(&loss)?;
        losses.push(loss.to_scalar::<f32>()?);
    }
    Ok((losses, net, varmap))
}

/// CLI demo: solve Kuhn, distil the equilibrium policy into a candle MLP, print
/// the loss curve and predicted-vs-solved strategies.
pub fn demo(epochs: usize) {
    println!("== candle Deep-CFR policy distillation (Kuhn) ==");
    let mut solver = Solver::new(KuhnPoker::new(), SolverConfig::default());
    solver.train(5000);
    let avg = solver.average_strategy();

    // Build a supervised dataset: infoset features -> equilibrium action probs.
    let mut keys: Vec<String> = avg.keys().cloned().collect();
    keys.sort();
    let features: Vec<Vec<f32>> = keys.iter().map(|k| featurize(k)).collect();
    let targets: Vec<Vec<f32>> = keys
        .iter()
        .map(|k| avg[k].iter().map(|&p| p as f32).collect())
        .collect();

    let (losses, net, _vm) = match train_policy_net(&features, &targets, 32, epochs, 0.05) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("training failed: {e}");
            return;
        }
    };

    println!("samples: {}  (Kuhn infosets)", features.len());
    let step = (losses.len() / 8).max(1);
    println!("\n{:>6}  {:>10}", "epoch", "mse_loss");
    for (i, l) in losses.iter().enumerate().step_by(step) {
        println!("{i:>6}  {l:>10.6}");
    }
    println!(
        "final loss: {:.6}",
        losses.last().copied().unwrap_or(f32::NAN)
    );

    // Show a few predicted vs solved strategies.
    println!("\ninfoset            solved[pass,bet]     net[pass,bet]");
    let device = Device::Cpu;
    for (k, f) in keys.iter().zip(&features).take(6) {
        let x = Tensor::from_vec(f.clone(), (1, f.len()), &device).unwrap();
        let p = net.probs(&x).unwrap().to_vec2::<f32>().unwrap();
        let s = &avg[k];
        println!(
            "{k:<16}  [{:.3}, {:.3}]        [{:.3}, {:.3}]",
            s[0], s[1], p[0][0], p[0][1]
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn net_learns_a_simple_mapping() {
        // Two well-separated feature clusters -> two opposite distributions.
        let features = vec![
            vec![0.0, 0.0, 0.0],
            vec![1.0, 1.0, 1.0],
            vec![0.0, 0.1, 0.0],
            vec![1.0, 0.9, 1.0],
        ];
        let targets = vec![
            vec![0.9, 0.1],
            vec![0.1, 0.9],
            vec![0.9, 0.1],
            vec![0.1, 0.9],
        ];
        let (losses, _net, _vm) = train_policy_net(&features, &targets, 16, 400, 0.05).unwrap();
        assert!(losses[0].is_finite());
        assert!(
            *losses.last().unwrap() < losses[0] * 0.5,
            "loss should drop substantially: {} -> {}",
            losses[0],
            losses.last().unwrap()
        );
    }

    #[test]
    fn distils_kuhn_policy() {
        let mut solver = Solver::new(KuhnPoker::new(), SolverConfig::default());
        solver.train(2000);
        let avg = solver.average_strategy();
        let mut keys: Vec<String> = avg.keys().cloned().collect();
        keys.sort();
        let features: Vec<Vec<f32>> = keys.iter().map(|k| featurize(k)).collect();
        let targets: Vec<Vec<f32>> = keys
            .iter()
            .map(|k| avg[k].iter().map(|&p| p as f32).collect())
            .collect();
        let (losses, _net, _vm) = train_policy_net(&features, &targets, 32, 600, 0.05).unwrap();
        assert!(
            *losses.last().unwrap() < 0.05,
            "should fit Kuhn policy: final {}",
            losses.last().unwrap()
        );
    }
}
