//! rvface-models: Burn implementations of the three rvFACE networks.
//!
//! All modules are generic over `B: burn::tensor::backend::Backend`; pick
//! `burn::backend::NdArray` (CPU) or `burn::backend::Wgpu` (WebGPU) at the
//! host layer. Weights load from safetensors buffers with canonical names
//! produced by `tools/convert_weights.py` (see docs/adrs/0003).

pub mod weights;
pub mod detector;
pub mod landmark;
pub mod embedder;
