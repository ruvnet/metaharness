// SPDX-License-Identifier: MIT
#![doc = include_str!("../README.md")]

pub mod cfr;
pub mod darwin;
pub mod exploit;
pub mod features;
pub mod game;
pub mod games;
pub mod optimize;
pub mod rng;

#[cfg(feature = "ruvector")]
pub mod abstraction;
#[cfg(feature = "neural")]
pub mod neural;
#[cfg(feature = "realgames")]
pub mod realgames;

pub use cfr::{CfrVariant, Solver, SolverConfig};
pub use darwin::{DarwinConfig, DarwinReport, Genome};
pub use exploit::{best_response_value, exploitability, profile_value};
pub use game::Game;
pub use games::{KuhnPoker, LeducHoldem};
