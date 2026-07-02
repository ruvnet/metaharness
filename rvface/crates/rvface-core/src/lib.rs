//! rvface-core: the exactness-critical, framework-free half of rvFACE.
//!
//! Everything here is a direct port of the upstream Python pipeline math
//! (see docs/adrs/0004-pipeline-parity-semantics.md). No ML framework, no
//! OpenCV; `rvface-models` supplies the neural nets.

pub mod boxes;
pub mod image;
pub mod align;
pub mod pose;
pub mod similarity;

pub use boxes::{BBox, Detection};
