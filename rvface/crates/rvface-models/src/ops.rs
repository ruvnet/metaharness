//! Shared functional building blocks for the three networks.
//!
//! The models are implemented with Burn's functional tensor ops instead of
//! `burn::nn` modules + the Record system: weights stay in the [`Weights`]
//! store under their original PyTorch `state_dict` keys, and every forward
//! pass is explicit calls into `burn::tensor::module` plus the hand-written
//! batch-norm below. This keeps the state-dict keys the single naming source
//! of truth and works identically on the NdArray and Wgpu backends.

use burn::tensor::backend::Backend;
use burn::tensor::module as tm;
use burn::tensor::ops::ConvOptions;
use burn::tensor::{activation, Tensor};

use crate::weights::{Weights, WeightsError};

/// PyTorch's default BatchNorm epsilon (used by every net except IRN-50).
pub(crate) const TORCH_BN_EPS: f64 = 1e-5;

/// 2-d convolution with the kernel taken from the store at `weight_key`.
///
/// Groups are derived from the shapes exactly like PyTorch stores them:
/// `groups = C_in / weight.shape[1]` (1 for dense convs, `C` for depthwise).
pub(crate) fn conv2d<B: Backend>(
    x: Tensor<B, 4>,
    w: &Weights<B>,
    weight_key: &str,
    bias: Option<Tensor<B, 1>>,
    stride: [usize; 2],
    padding: [usize; 2],
) -> Result<Tensor<B, 4>, WeightsError> {
    let weight = w.t4(weight_key)?;
    let groups = x.dims()[1] / weight.dims()[1];
    Ok(tm::conv2d(
        x,
        weight,
        bias,
        ConvOptions::new(stride, padding, [1, 1], groups),
    ))
}

/// Convolution with a bias tensor stored next to the weight
/// (`<prefix>.weight` / `<prefix>.bias`).
pub(crate) fn conv2d_biased<B: Backend>(
    x: Tensor<B, 4>,
    w: &Weights<B>,
    prefix: &str,
    stride: [usize; 2],
    padding: [usize; 2],
) -> Result<Tensor<B, 4>, WeightsError> {
    let bias = w.t1(&format!("{prefix}.bias"))?;
    conv2d(
        x,
        w,
        &format!("{prefix}.weight"),
        Some(bias),
        stride,
        padding,
    )
}

/// Inference-mode 2-d batch norm:
/// `(x - running_mean) / sqrt(running_var + eps) * weight + bias`,
/// with parameters at `<prefix>.{weight,bias,running_mean,running_var}`.
pub(crate) fn batch_norm2d<B: Backend>(
    x: Tensor<B, 4>,
    w: &Weights<B>,
    prefix: &str,
    eps: f64,
) -> Result<Tensor<B, 4>, WeightsError> {
    let c = x.dims()[1];
    let shape = [1, c, 1, 1];
    let gamma = w.t1(&format!("{prefix}.weight"))?.reshape(shape);
    let beta = w.t1(&format!("{prefix}.bias"))?.reshape(shape);
    let mean = w.t1(&format!("{prefix}.running_mean"))?.reshape(shape);
    let var = w.t1(&format!("{prefix}.running_var"))?.reshape(shape);
    Ok((x - mean) / (var.add_scalar(eps).sqrt()) * gamma + beta)
}

/// Inference-mode 1-d batch norm over `[N, C]` activations.
pub(crate) fn batch_norm1d<B: Backend>(
    x: Tensor<B, 2>,
    w: &Weights<B>,
    prefix: &str,
    eps: f64,
) -> Result<Tensor<B, 2>, WeightsError> {
    let c = x.dims()[1];
    let shape = [1, c];
    let gamma = w.t1(&format!("{prefix}.weight"))?.reshape(shape);
    let beta = w.t1(&format!("{prefix}.bias"))?.reshape(shape);
    let mean = w.t1(&format!("{prefix}.running_mean"))?.reshape(shape);
    let var = w.t1(&format!("{prefix}.running_var"))?.reshape(shape);
    Ok((x - mean) / (var.add_scalar(eps).sqrt()) * gamma + beta)
}

/// PReLU with the per-channel slope tensor at `weight_key` (broadcast over
/// dim 1, matching `nn.PReLU(num_channels)`).
pub(crate) fn prelu<B: Backend, const D: usize>(
    x: Tensor<B, D>,
    w: &Weights<B>,
    weight_key: &str,
) -> Result<Tensor<B, D>, WeightsError> {
    let alpha = w.t1(weight_key)?;
    Ok(activation::prelu(x, alpha))
}

/// Linear layer with a PyTorch-layout weight (`[out, in]`) at `weight_key`:
/// `y = x @ W^T + b`.
pub(crate) fn linear_pt<B: Backend>(
    x: Tensor<B, 2>,
    w: &Weights<B>,
    weight_key: &str,
    bias: Option<Tensor<B, 1>>,
) -> Result<Tensor<B, 2>, WeightsError> {
    let weight = w.t2(weight_key)?;
    let out = x.matmul(weight.transpose());
    Ok(match bias {
        Some(b) => out + b.unsqueeze::<2>(),
        None => out,
    })
}
