// SPDX-License-Identifier: MIT
//
// Concrete poker games implementing `crate::game::Game`. These are the standard
// research testbeds for equilibrium solving: small enough that exact
// exploitability is computable (so correctness is *provable*, not merely
// plausible), yet structurally identical to full poker — private cards, betting
// rounds, bluffing, slow-playing.

pub mod kuhn;
pub mod leduc;

pub use kuhn::{KuhnAction, KuhnPoker, KuhnState};
pub use leduc::{LeducAction, LeducHoldem, LeducState};
