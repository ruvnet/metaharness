//! Depthwise-residual MobileFaceNet 68-point landmark network (Burn port).
//!
//! One parameterized implementation covers both published variants:
//!
//! - upstream `face_landmark/MobileFaceNet.py`: 64x64 gray input, ReLU,
//!   residual blocks 3/4/2, channels 32/64, GDC kernel 4x4,
//!   `Linear(512, 136, bias=True)`;
//! - cunjian/pytorch_face_landmark `models/mobilefacenet.py`: 112x112 BGR
//!   input, PReLU, residual blocks 4/6/2, channels 64/128, GDC kernel 7x7,
//!   `Linear(512, 136, bias=False)`.
//!
//! State-dict keys are identical between the two sources (`conv1.conv.weight`,
//! `conv_3.model.0.conv_dw.bn.running_mean`, `output_layer.linear.weight`,
//! ...), so the config only carries what actually differs; channel widths,
//! kernel sizes and conv groups are implied by the stored weight shapes.

use burn::tensor::activation::relu;
use burn::tensor::backend::Backend;
use burn::tensor::Tensor;

use crate::ops::{batch_norm1d, batch_norm2d, conv2d, linear_pt, prelu, TORCH_BN_EPS};
use crate::weights::{Activation, MfnDwArch, Weights, WeightsError};

/// Variant parameters of the depthwise-residual MobileFaceNet.
#[derive(Debug, Clone)]
pub struct MfnDwConfig {
    /// Non-linearity of every `Conv_block` (`relu` upstream, `prelu` cunjian).
    pub activation: Activation,
    /// `num_block` of the `conv_3` / `conv_4` / `conv_5` residual stages.
    pub residual_num_blocks: [usize; 3],
    /// GDC depthwise kernel `[kh, kw]` (input spatial size / 16).
    pub gdc_kernel: [usize; 2],
    /// Whether `output_layer.linear` has a bias.
    pub gdc_linear_bias: bool,
}

impl MfnDwConfig {
    /// Upstream `face_landmark/MobileFaceNet.py` `MobileFaceNet([64,64], 136)`.
    pub fn upstream_64() -> Self {
        Self {
            activation: Activation::Relu,
            residual_num_blocks: [3, 4, 2],
            gdc_kernel: [4, 4],
            gdc_linear_bias: true,
        }
    }

    /// cunjian/pytorch_face_landmark `MobileFaceNet([112,112], 136)`.
    pub fn cunjian_112() -> Self {
        Self {
            activation: Activation::Prelu,
            residual_num_blocks: [4, 6, 2],
            gdc_kernel: [7, 7],
            gdc_linear_bias: false,
        }
    }

    /// Builds the config from a manifest `arch` block.
    pub fn from_arch(arch: &MfnDwArch) -> Self {
        Self {
            activation: arch.activation,
            residual_num_blocks: [
                arch.residual_num_blocks.conv_3,
                arch.residual_num_blocks.conv_4,
                arch.residual_num_blocks.conv_5,
            ],
            gdc_kernel: arch.gdc_kernel,
            gdc_linear_bias: arch.gdc_linear_bias,
        }
    }
}

/// Depthwise-residual MobileFaceNet landmark regressor.
pub struct MobileFaceNetDw<B: Backend> {
    weights: Weights<B>,
    config: MfnDwConfig,
}

impl<B: Backend> MobileFaceNetDw<B> {
    /// Wraps a loaded weight store with the variant config.
    pub fn new(weights: Weights<B>, config: MfnDwConfig) -> Self {
        Self { weights, config }
    }

    fn activate(&self, x: Tensor<B, 4>, prefix: &str) -> Result<Tensor<B, 4>, WeightsError> {
        match self.config.activation {
            Activation::Relu => Ok(relu(x)),
            Activation::Prelu => prelu(x, &self.weights, &format!("{prefix}.prelu.weight")),
        }
    }

    /// `Conv_block`: conv (no bias) + BN + activation. Kernel size and groups
    /// come from the stored weight shape.
    fn conv_block(
        &self,
        x: Tensor<B, 4>,
        prefix: &str,
        stride: usize,
        padding: usize,
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
        self.activate(x, prefix)
    }

    /// `Linear_block`: conv (no bias) + BN, no activation.
    fn linear_block(
        &self,
        x: Tensor<B, 4>,
        prefix: &str,
        stride: usize,
        padding: usize,
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
        batch_norm2d(x, w, &format!("{prefix}.bn"), TORCH_BN_EPS)
    }

    /// `Depth_Wise`: 1x1 expand + depthwise 3x3 (stride s) + 1x1 project,
    /// with an identity shortcut when `residual`.
    fn depth_wise(
        &self,
        x: Tensor<B, 4>,
        prefix: &str,
        stride: usize,
        residual: bool,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let short_cut = residual.then(|| x.clone());
        let x = self.conv_block(x, &format!("{prefix}.conv"), 1, 0)?;
        let x = self.conv_block(x, &format!("{prefix}.conv_dw"), stride, 1)?;
        let x = self.linear_block(x, &format!("{prefix}.project"), 1, 0)?;
        Ok(match short_cut {
            Some(s) => s + x,
            None => x,
        })
    }

    /// `Residual`: `num_block` stride-1 residual `Depth_Wise` blocks.
    fn residual(
        &self,
        mut x: Tensor<B, 4>,
        prefix: &str,
        num_block: usize,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        for i in 0..num_block {
            x = self.depth_wise(x, &format!("{prefix}.model.{i}"), 1, true)?;
        }
        Ok(x)
    }

    /// Runs the network on a normalized NCHW crop (`pixel / 255`).
    ///
    /// Returns `(landmarks, conv_features)`: `[N, 136]` normalized `[0, 1]`
    /// crop coordinates (point-major `x0,y0,x1,y1,...`) and the `[N, 512,
    /// kh, kw]` feature map ahead of the GDC head (the second element of the
    /// cunjian forward tuple; upstream computes but discards it).
    pub fn forward(&self, x: Tensor<B, 4>) -> Result<(Tensor<B, 2>, Tensor<B, 4>), WeightsError> {
        let [blocks_3, blocks_4, blocks_5] = self.config.residual_num_blocks;
        let x = self.conv_block(x, "conv1", 2, 1)?;
        let x = self.conv_block(x, "conv2_dw", 1, 1)?;
        let x = self.depth_wise(x, "conv_23", 2, false)?;
        let x = self.residual(x, "conv_3", blocks_3)?;
        let x = self.depth_wise(x, "conv_34", 2, false)?;
        let x = self.residual(x, "conv_4", blocks_4)?;
        let x = self.depth_wise(x, "conv_45", 2, false)?;
        let x = self.residual(x, "conv_5", blocks_5)?;
        let conv_features = self.conv_block(x, "conv_6_sep", 1, 0)?;

        // GDC head: global depthwise conv + flatten + linear + BN1d.
        let x = self.linear_block(conv_features.clone(), "output_layer.conv_6_dw", 1, 0)?;
        let [n, c, h, w] = x.dims();
        debug_assert_eq!([h, w], [1, 1], "GDC kernel must consume the feature map");
        let x = x.reshape([n, c * h * w]);
        let bias = if self.config.gdc_linear_bias {
            Some(self.weights.t1("output_layer.linear.bias")?)
        } else {
            None
        };
        let x = linear_pt(x, &self.weights, "output_layer.linear.weight", bias)?;
        let landmarks = batch_norm1d(x, &self.weights, "output_layer.bn", TORCH_BN_EPS)?;
        Ok((landmarks, conv_features))
    }
}
