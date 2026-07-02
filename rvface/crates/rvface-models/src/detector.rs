//! UltraFace slim-320 SSD face detector (Burn port).
//!
//! Faithful port of upstream `face_detect/vision/nn/mb_tiny.py` +
//! `face_detect/vision/ssd/{mb_tiny_fd.py,ssd.py}` with `is_test=True`:
//! the Mb_Tiny base (13 `conv_bn`/`conv_dw` blocks, `base_channel` 16), four
//! detection heads tapping the base net after layers 8, 11 and 13 plus one
//! extras block, softmaxed class confidences and locations decoded to
//! corner-form boxes through `rvface_core::boxes` (center variance 0.1, size
//! variance 0.2, priors for a 320x240 input).

use burn::tensor::activation::{relu, softmax};
use burn::tensor::backend::Backend;
use burn::tensor::Tensor;
use rvface_core::boxes::{
    center_to_corner, decode_locations, generate_priors, CenterBox, CENTER_VARIANCE, SIZE_VARIANCE,
};
use rvface_core::BBox;

use crate::ops::{batch_norm2d, conv2d, conv2d_biased, TORCH_BN_EPS};
use crate::weights::{Weights, WeightsError};

/// Strides of the 13 Mb_Tiny base blocks (`mb_tiny.py` `self.model`).
const BASE_STRIDES: [usize; 13] = [2, 1, 2, 1, 2, 1, 1, 1, 2, 1, 1, 2, 1];

/// Base-net indexes after which the first three heads tap
/// (`mb_tiny_fd.py` `source_layer_indexes`).
const SOURCE_LAYER_INDEXES: [usize; 3] = [8, 11, 13];

/// Raw `is_test=True` detector output for one image, before thresholding and
/// NMS: softmaxed `[background, face]` rows and the matching corner-form
/// boxes in normalized image units. Feed into `rvface_core::boxes::postprocess`.
#[derive(Debug, Clone)]
pub struct DetectorOutput {
    /// Softmaxed class probabilities per prior.
    pub confidences: Vec<[f32; 2]>,
    /// Decoded corner-form boxes (relative coordinates) per prior.
    pub boxes: Vec<BBox>,
}

/// The slim-320 SSD detector; construct once, call [`Self::forward`] per frame.
pub struct SsdSlim320<B: Backend> {
    weights: Weights<B>,
    priors: Vec<CenterBox>,
}

impl<B: Backend> SsdSlim320<B> {
    /// Number of classes ({background, face}).
    pub const NUM_CLASSES: usize = 2;
    /// Input size `[width, height]` the priors are generated for.
    pub const IMAGE_SIZE: [usize; 2] = [320, 240];

    /// Wraps a loaded weight store (canonical `base_net.*` / `extras.*` /
    /// `*_headers.*` keys) and precomputes the 4420 priors.
    pub fn new(weights: Weights<B>) -> Self {
        Self {
            weights,
            priors: generate_priors(Self::IMAGE_SIZE),
        }
    }

    /// `conv_bn`: 3x3 conv (stride s, pad 1, no bias) + BN + ReLU.
    fn conv_bn(
        &self,
        x: Tensor<B, 4>,
        idx: usize,
        stride: usize,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let w = &self.weights;
        let x = conv2d(
            x,
            w,
            &format!("base_net.{idx}.0.weight"),
            None,
            [stride, stride],
            [1, 1],
        )?;
        let x = batch_norm2d(x, w, &format!("base_net.{idx}.1"), TORCH_BN_EPS)?;
        Ok(relu(x))
    }

    /// `conv_dw`: depthwise 3x3 + BN + ReLU, then pointwise 1x1 + BN + ReLU.
    fn conv_dw(
        &self,
        x: Tensor<B, 4>,
        idx: usize,
        stride: usize,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let w = &self.weights;
        let x = conv2d(
            x,
            w,
            &format!("base_net.{idx}.0.weight"),
            None,
            [stride, stride],
            [1, 1],
        )?;
        let x = batch_norm2d(x, w, &format!("base_net.{idx}.1"), TORCH_BN_EPS)?;
        let x = relu(x);
        let x = conv2d(
            x,
            w,
            &format!("base_net.{idx}.3.weight"),
            None,
            [1, 1],
            [0, 0],
        )?;
        let x = batch_norm2d(x, w, &format!("base_net.{idx}.4"), TORCH_BN_EPS)?;
        Ok(relu(x))
    }

    fn base_layer(&self, x: Tensor<B, 4>, idx: usize) -> Result<Tensor<B, 4>, WeightsError> {
        if idx == 0 {
            self.conv_bn(x, 0, BASE_STRIDES[0])
        } else {
            self.conv_dw(x, idx, BASE_STRIDES[idx])
        }
    }

    /// `SeperableConv2d`: depthwise kxk (biased) + ReLU + pointwise 1x1 (biased).
    fn seperable_conv(
        &self,
        x: Tensor<B, 4>,
        prefix: &str,
        stride: usize,
        padding: usize,
    ) -> Result<Tensor<B, 4>, WeightsError> {
        let x = conv2d_biased(
            x,
            &self.weights,
            &format!("{prefix}.0"),
            [stride, stride],
            [padding, padding],
        )?;
        let x = relu(x);
        conv2d_biased(x, &self.weights, &format!("{prefix}.2"), [1, 1], [0, 0])
    }

    /// One detection head: heads 0-2 are `SeperableConv2d(k3, p1)`, head 3 a
    /// plain 3x3 conv. Returns `(confidence, location)` in
    /// `[N, H*W*anchors, {num_classes,4}]` layout (`SSD.compute_header`).
    fn compute_header(
        &self,
        idx: usize,
        x: &Tensor<B, 4>,
    ) -> Result<(Tensor<B, 3>, Tensor<B, 3>), WeightsError> {
        let mut out = Vec::with_capacity(2);
        for (kind, last) in [
            ("classification_headers", Self::NUM_CLASSES),
            ("regression_headers", 4),
        ] {
            let y = if idx < 3 {
                self.seperable_conv(x.clone(), &format!("{kind}.{idx}"), 1, 1)?
            } else {
                conv2d_biased(
                    x.clone(),
                    &self.weights,
                    &format!("{kind}.{idx}"),
                    [1, 1],
                    [1, 1],
                )?
            };
            let [n, _, _, _] = y.dims();
            let y = y.permute([0, 2, 3, 1]);
            let numel = y.dims().iter().product::<usize>();
            out.push(y.reshape([n, numel / (n * last), last]));
        }
        let location = out.pop().expect("regression output");
        let confidence = out.pop().expect("classification output");
        Ok((confidence, location))
    }

    /// Runs the `is_test=True` graph on a normalized `[1, 3, 240, 320]`
    /// input (`(pixel - 127) / 128`, RGB, NCHW).
    pub fn forward(&self, x: Tensor<B, 4>) -> Result<DetectorOutput, WeightsError> {
        assert_eq!(x.dims()[0], 1, "detector forward expects batch size 1");

        let mut confidences: Vec<Tensor<B, 3>> = Vec::with_capacity(4);
        let mut locations: Vec<Tensor<B, 3>> = Vec::with_capacity(4);

        let mut x = x;
        let mut start = 0usize;
        let mut header = 0usize;
        for end in SOURCE_LAYER_INDEXES {
            for idx in start..end {
                x = self.base_layer(x, idx)?;
            }
            start = end;
            let (confidence, location) = self.compute_header(header, &x)?;
            header += 1;
            confidences.push(confidence);
            locations.push(location);
        }

        // extras[0]: 1x1 conv + ReLU + SeperableConv2d(k3, s2, p1) + ReLU.
        x = conv2d_biased(x, &self.weights, "extras.0.0", [1, 1], [0, 0])?;
        x = relu(x);
        x = self.seperable_conv(x, "extras.0.2", 2, 1)?;
        x = relu(x);
        let (confidence, location) = self.compute_header(header, &x)?;
        confidences.push(confidence);
        locations.push(location);

        let confidences = Tensor::cat(confidences, 1);
        let locations = Tensor::cat(locations, 1);

        // is_test=True path: softmax over classes, decode to corner form.
        let confidences = softmax(confidences, 2);
        let conf: Vec<f32> = confidences
            .into_data()
            .to_vec()
            .expect("confidences to host");
        let locs: Vec<f32> = locations.into_data().to_vec().expect("locations to host");

        let confidences: Vec<[f32; 2]> = conf.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let raw_locations: Vec<[f32; 4]> = locs
            .chunks_exact(4)
            .map(|c| [c[0], c[1], c[2], c[3]])
            .collect();
        let boxes = decode_locations(&raw_locations, &self.priors, CENTER_VARIANCE, SIZE_VARIANCE)
            .into_iter()
            .map(center_to_corner)
            .collect();

        Ok(DetectorOutput { confidences, boxes })
    }
}
