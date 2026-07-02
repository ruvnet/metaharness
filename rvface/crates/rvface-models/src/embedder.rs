//! Face embedding networks (Burn ports).
//!
//! - [`MobileFaceNetEmbedder`]: bottleneck-style MobileFaceNet
//!   (Xiaoccer/MobileFaceNet_Pytorch `core/model.py`), 112x96 RGB input,
//!   128-d embedding.
//! - [`Irn50`]: upstream `face_feature/irn50_pytorch.py`, 128x128 RGB input,
//!   256-d embedding via a maxout over the two halves of a 512-d dense layer.
//!
//! Neither net L2-normalizes its output (upstream does not); normalization
//! happens downstream in `rvface_core::similarity`.

use burn::tensor::activation::relu;
use burn::tensor::backend::Backend;
use burn::tensor::module::{avg_pool2d, max_pool2d};
use burn::tensor::Tensor;

use crate::ops::{batch_norm1d, batch_norm2d, conv2d, linear_pt, prelu, TORCH_BN_EPS};
use crate::weights::{MfnBottleneckArch, Weights, WeightsError};

// ---------------------------------------------------------------------------
// Bottleneck-style MobileFaceNet (Xiaoccer)
// ---------------------------------------------------------------------------

/// Variant parameters of the bottleneck-style MobileFaceNet.
#[derive(Debug, Clone)]
pub struct MfnBottleneckConfig {
    /// `[expansion, channels, num_blocks, first_stride]` rows
    /// (`Mobilefacenet_bottleneck_setting`).
    pub bottleneck_setting: Vec<[usize; 4]>,
}

impl MfnBottleneckConfig {
    /// Xiaoccer's `MobileFacenet()` defaults (112x96 input, GDC 7x6, 128-d).
    pub fn xiaoccer() -> Self {
        Self {
            bottleneck_setting: vec![
                [2, 64, 5, 2],
                [4, 128, 1, 2],
                [2, 128, 6, 1],
                [4, 128, 1, 2],
                [2, 128, 2, 1],
            ],
        }
    }

    /// Builds the config from a manifest `arch` block.
    pub fn from_arch(arch: &MfnBottleneckArch) -> Self {
        Self {
            bottleneck_setting: arch.bottleneck_setting.clone(),
        }
    }
}

/// Bottleneck-style MobileFaceNet embedder (`core/model.py MobileFacenet`).
pub struct MobileFaceNetEmbedder<B: Backend> {
    weights: Weights<B>,
    config: MfnBottleneckConfig,
}

impl<B: Backend> MobileFaceNetEmbedder<B> {
    /// Wraps a loaded weight store with the variant config.
    pub fn new(weights: Weights<B>, config: MfnBottleneckConfig) -> Self {
        Self { weights, config }
    }

    /// `ConvBlock`: conv (no bias) + BN, then PReLU unless `linear`.
    /// Kernel size and (depthwise) groups come from the weight shape.
    fn conv_block(
        &self,
        x: Tensor<B, 4>,
        prefix: &str,
        stride: usize,
        padding: usize,
        linear: bool,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let w = &self.weights;
        let x = conv2d(
            x,
            w,
            &format!("{prefix}.conv.weight"),
            None,
            [stride, stride],
            [padding, padding],
        )?;
        let x = batch_norm2d(x, w, &format!("{prefix}.bn"), TORCH_BN_EPS)?;
        if linear {
            Ok(x)
        } else {
            prelu(x, w, &format!("{prefix}.prelu.weight"))
        }
    }

    /// `Bottleneck`: 1x1 expand + BN + PReLU, depthwise 3x3 (stride s) + BN +
    /// PReLU, 1x1 project + BN; identity shortcut when `stride == 1 && inp ==
    /// oup`. Keys follow the `nn.Sequential` layout `blocks.{i}.conv.{0..7}`.
    fn bottleneck(
        &self,
        x: Tensor<B, 4>,
        idx: usize,
        stride: usize,
        connect: bool,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let w = &self.weights;
        let p = format!("blocks.{idx}.conv");
        let short_cut = connect.then(|| x.clone());
        let y = conv2d(x, w, &format!("{p}.0.weight"), None, [1, 1], [0, 0])?;
        let y = batch_norm2d(y, w, &format!("{p}.1"), TORCH_BN_EPS)?;
        let y = prelu(y, w, &format!("{p}.2.weight"))?;
        let y = conv2d(
            y,
            w,
            &format!("{p}.3.weight"),
            None,
            [stride, stride],
            [1, 1],
        )?;
        let y = batch_norm2d(y, w, &format!("{p}.4"), TORCH_BN_EPS)?;
        let y = prelu(y, w, &format!("{p}.5.weight"))?;
        let y = conv2d(y, w, &format!("{p}.6.weight"), None, [1, 1], [0, 0])?;
        let y = batch_norm2d(y, w, &format!("{p}.7"), TORCH_BN_EPS)?;
        Ok(match short_cut {
            Some(s) => s + y,
            None => y,
        })
    }

    /// Runs the network on a normalized `[N, 3, 112, 96]` crop
    /// (`(pixel - 127.5) / 128`, RGB). Returns the raw (not L2-normalized)
    /// `[N, 128]` embedding.
    pub fn forward(&self, x: Tensor<B, 4>) -> Result<Tensor<B, 2>, WeightsError> {
        let x = self.conv_block(x, "conv1", 2, 1, false)?;
        let mut x = self.conv_block(x, "dw_conv1", 1, 1, false)?;

        // `_make_layer`: expand the setting rows into a flat block sequence.
        let mut inplanes = 64usize;
        let mut idx = 0usize;
        for &[_expansion, channels, num_blocks, first_stride] in &self.config.bottleneck_setting {
            for i in 0..num_blocks {
                let stride = if i == 0 { first_stride } else { 1 };
                let connect = stride == 1 && inplanes == channels;
                x = self.bottleneck(x, idx, stride, connect)?;
                inplanes = channels;
                idx += 1;
            }
        }

        let x = self.conv_block(x, "conv2", 1, 0, false)?;
        // Global depthwise conv (kernel = feature-map size) + 1x1 linear.
        let x = self.conv_block(x, "linear7", 1, 0, true)?;
        let x = self.conv_block(x, "linear1", 1, 0, true)?;
        let [n, c, h, w] = x.dims();
        Ok(x.reshape([n, c * h * w]))
    }
}

// ---------------------------------------------------------------------------
// IRN-50
// ---------------------------------------------------------------------------

/// Upstream IRN-50 BatchNorm epsilon (`irn50_pytorch.py`).
pub const IRN50_BN_EPS: f64 = 9.999_999_747_378_752e-6;

/// IRN-50 embedder (`face_feature/irn50_pytorch.py irn50_pytorch`).
///
/// All convs are bias-free with padding built out of explicit asymmetric
/// `F.pad` calls in the original; those pads are reproduced verbatim with
/// `Tensor::pad`. The head is `avg_pool(4x4)` → `Linear(16384, 512)` → BN1d →
/// maxout over the two 256-wide halves.
pub struct Irn50<B: Backend> {
    weights: Weights<B>,
}

impl<B: Backend> Irn50<B> {
    /// Wraps a loaded weight store (canonical `Convolution1` / `conv2_res1_*`
    /// / `fc1_1` / `bn_fc1` keys).
    pub fn new(weights: Weights<B>) -> Self {
        Self { weights }
    }

    fn conv(
        &self,
        x: Tensor<B, 4>,
        name: &str,
        stride: usize,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        conv2d(
            x,
            &self.weights,
            &format!("{name}.weight"),
            None,
            [stride, stride],
            [0, 0],
        )
    }

    fn bn(&self, x: Tensor<B, 4>, name: &str) -> Result<Tensor<B, 4>, WeightsError> {
        batch_norm2d(x, &self.weights, name, IRN50_BN_EPS)
    }

    /// conv (with the original's explicit symmetric-1 `F.pad` when `pad`) +
    /// BN + ReLU.
    fn conv_bn_relu(
        &self,
        x: Tensor<B, 4>,
        conv: &str,
        bn: &str,
        stride: usize,
        pad: bool,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let x = if pad { x.pad((1, 1, 1, 1), 0.0) } else { x };
        let x = self.conv(x, conv, stride)?;
        Ok(relu(self.bn(x, bn)?))
    }

    /// The standard three-conv residual branch of block `name`
    /// (`{name}_conv1` 1x1 → `{name}_conv2` padded 3x3 → `{name}_conv3` 1x1),
    /// with `conv1_stride` 2 only in `conv3_res1`.
    fn branch(
        &self,
        x: Tensor<B, 4>,
        name: &str,
        conv1_stride: usize,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let x = self.conv_bn_relu(
            x,
            &format!("{name}_conv1"),
            &format!("{name}_conv1_bn"),
            conv1_stride,
            false,
        )?;
        let x = self.conv_bn_relu(
            x,
            &format!("{name}_conv2"),
            &format!("{name}_conv2_bn"),
            1,
            true,
        )?;
        self.conv(x, &format!("{name}_conv3"), 1)
    }

    /// Identity residual block: pre-BN + ReLU, then branch, added to the
    /// block input (`convN_resM` for M >= 2 without a projection).
    fn identity_block(&self, x: Tensor<B, 4>, name: &str) -> Result<Tensor<B, 4>, WeightsError> {
        let pre = relu(self.bn(x.clone(), &format!("{name}_pre_bn"))?);
        Ok(x + self.branch(pre, name, 1)?)
    }

    /// Runs the network on a normalized `[N, 3, 128, 128]` input
    /// (`pixel / 256`, the upstream quirk). Returns the raw (not
    /// L2-normalized) `[N, 256]` maxout embedding.
    pub fn forward(&self, x: Tensor<B, 4>) -> Result<Tensor<B, 2>, WeightsError> {
        let w = &self.weights;

        // Stem: three 3x3 convs (first strided, third with explicit pad), a
        // -inf-padded 3x3/2 max pool, then 1x1 + 3x3 + padded strided 3x3.
        let x = self.conv_bn_relu(x, "Convolution1", "BatchNorm1", 2, false)?;
        let x = self.conv_bn_relu(x, "Convolution2", "BatchNorm2", 1, false)?;
        let x = self.conv_bn_relu(x, "Convolution3", "BatchNorm3", 1, true)?;
        // Pooling1: F.pad(x, (0, 1, 0, 1), -inf) then max_pool2d(3, stride 2).
        let x = x.pad((0, 1, 0, 1), f32::NEG_INFINITY);
        let x = max_pool2d(x, [3, 3], [2, 2], [0, 0], [1, 1]);
        let x = self.conv_bn_relu(x, "Convolution4", "BatchNorm4", 1, false)?;
        let x = self.conv_bn_relu(x, "Convolution5", "BatchNorm5", 1, false)?;
        let x = self.conv_bn_relu(x, "Convolution6", "BatchNorm6", 2, true)?;

        // conv2_res1: projection block without a pre-BN (input is post-ReLU).
        let x = self.conv(x.clone(), "conv2_res1_proj", 1)? + self.branch(x, "conv2_res1", 1)?;
        let x = self.identity_block(x, "conv2_res2")?;
        let x = self.identity_block(x, "conv2_res3")?;

        // conv3_res1: pre-BN, then strided projection and strided conv1.
        let pre = relu(self.bn(x, "conv3_res1_pre_bn")?);
        let x =
            self.conv(pre.clone(), "conv3_res1_proj", 2)? + self.branch(pre, "conv3_res1", 2)?;
        let x = self.identity_block(x, "conv3_res2")?;
        let x = self.identity_block(x, "conv3_res3")?;
        let x = self.identity_block(x, "conv3_res4")?;

        // conv4_res1: two-conv branch (padded 3x3 reduce + 1x1 expand).
        let pre = relu(self.bn(x, "conv4_res1_pre_bn")?);
        let proj = self.conv(pre.clone(), "conv4_res1_proj", 1)?;
        let y = self.conv_bn_relu(pre, "conv4_res1_conv1", "conv4_res1_conv1_bn", 1, true)?;
        let x = proj + self.conv(y, "conv4_res1_conv2", 1)?;

        // conv4_res2: projection block (1024 channels out) with pre-BN.
        let pre = relu(self.bn(x, "conv4_res2_pre_bn")?);
        let x = self.conv(pre.clone(), "conv4_res2_conv1_proj", 1)?
            + self.branch(pre, "conv4_res2", 1)?;
        let x = self.identity_block(x, "conv4_res3")?;

        // Head: BN + ReLU, 4x4 average pool, dense 512, BN1d, maxout halves.
        let x = relu(self.bn(x, "conv5_bn")?);
        let x = avg_pool2d(x, [4, 4], [1, 1], [0, 0], false);
        let [n, c, h, wd] = x.dims();
        let x = x.reshape([n, c * h * wd]);
        let x = linear_pt(x, w, "fc1_1.weight", None)?;
        let x = batch_norm1d(x, w, "bn_fc1", IRN50_BN_EPS)?;
        let half = x.dims()[1] / 2;
        let lo = x.clone().slice([0..n, 0..half]);
        let hi = x.slice([0..n, half..half * 2]);
        Ok(lo.max_pair(hi))
    }
}
