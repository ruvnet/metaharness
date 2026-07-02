//! Safetensors weight store and model-manifest schema.
//!
//! Weights keep the original PyTorch `state_dict` keys verbatim (see
//! `tools/naming.md`); the store is the single name-mapping point for the
//! functional forward passes in [`crate::detector`], [`crate::landmark`] and
//! [`crate::embedder`]. Non-float tensors (`num_batches_tracked` BatchNorm
//! buffers) are ignored on load.

use std::collections::{BTreeMap, HashMap};

use burn::tensor::backend::Backend;
use burn::tensor::{Tensor, TensorData};

/// Errors raised while loading weights or resolving tensors by name.
#[derive(Debug, thiserror::Error)]
pub enum WeightsError {
    /// The safetensors buffer failed to parse.
    #[error("invalid safetensors buffer: {0}")]
    InvalidSafetensors(String),
    /// A tensor required by a forward pass is absent from the store.
    #[error("missing tensor key: {0}")]
    MissingKey(String),
    /// A tensor exists but its shape does not match what the caller expects.
    #[error("tensor `{key}`: expected rank {expected_rank}, got shape {actual:?}")]
    ShapeMismatch {
        /// State-dict key of the offending tensor.
        key: String,
        /// Rank the caller asked for.
        expected_rank: usize,
        /// Shape actually stored.
        actual: Vec<usize>,
    },
}

struct Entry<B: Backend> {
    /// Flattened f32 payload, already on the target device.
    flat: Tensor<B, 1>,
    shape: Vec<usize>,
}

/// A name → f32 tensor map loaded from a safetensors buffer.
///
/// Tensors are stored flattened on the device and reshaped on access, which
/// keeps the store rank-agnostic (state dicts mix 1-d BN vectors, 2-d linear
/// weights and 4-d conv kernels).
pub struct Weights<B: Backend> {
    tensors: HashMap<String, Entry<B>>,
}

impl<B: Backend> Weights<B> {
    /// Parses a safetensors buffer, uploading every f32 tensor to `device`.
    ///
    /// Integer tensors (`num_batches_tracked`) are skipped; safetensors
    /// payloads are little-endian by specification.
    pub fn from_safetensors(bytes: &[u8], device: &B::Device) -> Result<Self, WeightsError> {
        let parsed = safetensors::SafeTensors::deserialize(bytes)
            .map_err(|e| WeightsError::InvalidSafetensors(e.to_string()))?;
        let mut tensors = HashMap::new();
        for (name, view) in parsed.tensors() {
            if view.dtype() != safetensors::Dtype::F32 {
                continue;
            }
            // Flush near-zero weights to exact zero. Trained checkpoints can
            // carry huge numbers of denormal floats (the cunjian landmark
            // checkpoint has them in 75% of its weights), and denormal
            // arithmetic runs ~100x slower on x86 and in wasm, where FTZ
            // cannot be enabled. A 1e-30 weight contributes at most ~1e-27
            // to any activation — 23 orders of magnitude below the fp32
            // parity tolerance — so flushing is numerically free.
            const FLUSH_THRESHOLD: f32 = 1e-30;
            let values: Vec<f32> = view
                .data()
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .map(|v| if v.abs() < FLUSH_THRESHOLD { 0.0 } else { v })
                .collect();
            let shape = view.shape().to_vec();
            let len = values.len();
            let flat = Tensor::from_data(TensorData::new(values, [len]), device);
            tensors.insert(name, Entry { flat, shape });
        }
        Ok(Self { tensors })
    }

    /// Number of (float) tensors in the store.
    pub fn len(&self) -> usize {
        self.tensors.len()
    }

    /// True when the store holds no tensors.
    pub fn is_empty(&self) -> bool {
        self.tensors.is_empty()
    }

    /// Whether `key` is present in the store.
    pub fn contains(&self, key: &str) -> bool {
        self.tensors.contains_key(key)
    }

    fn entry(&self, key: &str) -> Result<&Entry<B>, WeightsError> {
        self.tensors
            .get(key)
            .ok_or_else(|| WeightsError::MissingKey(key.to_owned()))
    }

    fn rank_err(key: &str, expected_rank: usize, shape: &[usize]) -> WeightsError {
        WeightsError::ShapeMismatch {
            key: key.to_owned(),
            expected_rank,
            actual: shape.to_vec(),
        }
    }

    /// 1-d tensor (BN parameter, bias, PReLU slope) by state-dict key.
    pub fn t1(&self, key: &str) -> Result<Tensor<B, 1>, WeightsError> {
        let e = self.entry(key)?;
        if e.shape.len() != 1 {
            return Err(Self::rank_err(key, 1, &e.shape));
        }
        Ok(e.flat.clone())
    }

    /// 2-d tensor (linear weight, PyTorch `[out, in]` layout) by key.
    pub fn t2(&self, key: &str) -> Result<Tensor<B, 2>, WeightsError> {
        let e = self.entry(key)?;
        if e.shape.len() != 2 {
            return Err(Self::rank_err(key, 2, &e.shape));
        }
        Ok(e.flat.clone().reshape([e.shape[0], e.shape[1]]))
    }

    /// 4-d tensor (conv kernel, `[out, in/groups, kh, kw]`) by key.
    pub fn t4(&self, key: &str) -> Result<Tensor<B, 4>, WeightsError> {
        let e = self.entry(key)?;
        if e.shape.len() != 4 {
            return Err(Self::rank_err(key, 4, &e.shape));
        }
        Ok(e.flat
            .clone()
            .reshape([e.shape[0], e.shape[1], e.shape[2], e.shape[3]]))
    }
}

// ---------------------------------------------------------------------------
// Model manifest schema (models/<name>.manifest.json, tools/naming.md)
// ---------------------------------------------------------------------------

/// `models/<name>.manifest.json`: provenance, preprocessing contract, exact
/// architecture hyperparameters and the full tensor key/shape list.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ModelManifest {
    /// File stem, e.g. `detector-slim320`.
    pub name: String,
    /// Sibling safetensors file name.
    pub file: String,
    /// Exact download URL of the original checkpoint (null for IRN-50).
    pub source_url: Option<String>,
    /// SHA-256 pin of the original `.pth`/`.ckpt`/`.npy`.
    pub source_sha256: Option<String>,
    /// Provenance and license notes (ADR-0003).
    pub license: String,
    /// Preprocessing contract for the network input.
    pub input: InputSpec,
    /// Human-readable output contract.
    pub output: String,
    /// Exact architecture hyperparameters, dispatched on `family`.
    pub arch: Arch,
    /// State-dict keys with shapes/dtypes (state-dict order in the file).
    pub tensors: BTreeMap<String, TensorSpec>,
}

/// The `input` block of a model manifest.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct InputSpec {
    /// Input width in pixels.
    pub width: usize,
    /// Input height in pixels.
    pub height: usize,
    /// Input channel count.
    pub channels: usize,
    /// Channel order the net was trained on (`rgb` | `bgr`).
    pub colorspace: String,
    /// Per-channel mean, subtracted first.
    pub mean: Vec<f32>,
    /// Multiplied after mean subtraction.
    pub scale: f64,
    /// Tensor layout (always `nchw`).
    pub layout: String,
    /// Stage-specific cropping/quirks.
    #[serde(default)]
    pub note: Option<String>,
}

/// One entry of the manifest `tensors` map.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TensorSpec {
    /// Tensor shape (empty for 0-dim buffers).
    pub shape: Vec<usize>,
    /// Dtype string (`float32` | `int64`).
    pub dtype: String,
}

/// Architecture config, tagged by `family` (see `tools/naming.md`).
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "family")]
pub enum Arch {
    /// Ultra-Light-Fast-Generic-Face-Detector SSD.
    #[serde(rename = "ultraface-ssd")]
    UltrafaceSsd(SsdArch),
    /// MobileFaceNet (both flavors, tagged by `style`).
    #[serde(rename = "mobilefacenet")]
    MobileFaceNet(MfnArch),
    /// Inception-ResNet-50 embedder.
    #[serde(rename = "irn50")]
    Irn50(Irn50Arch),
}

/// `family: "ultraface-ssd"` hyperparameters.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SsdArch {
    /// Variant name (`slim320`).
    pub variant: String,
    /// Number of classes ({background, face} = 2).
    pub num_classes: usize,
    /// Total prior count (4420 for slim-320).
    pub num_priors: usize,
    /// Mb_Tiny base channel (16).
    pub base_channel: usize,
    /// Feature-map sizes, `[widths, heights]` per head.
    pub feature_maps: Vec<Vec<usize>>,
    /// Anchor side lengths (px) per feature map.
    pub min_boxes: Vec<Vec<f32>>,
    /// SSD decode center variance.
    pub center_variance: f32,
    /// SSD decode size variance.
    pub size_variance: f32,
    /// Base-net indexes after which detection heads tap.
    pub source_layer_indexes: Vec<usize>,
}

/// `family: "mobilefacenet"`, dispatched on `style`.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "style")]
pub enum MfnArch {
    /// insightface/cunjian flavor (`Conv_block`/`Depth_Wise`/`Residual`).
    #[serde(rename = "depthwise-residual")]
    DepthwiseResidual(MfnDwArch),
    /// paper/Xiaoccer flavor (inverted-bottleneck blocks).
    #[serde(rename = "bottleneck")]
    Bottleneck(MfnBottleneckArch),
}

/// Non-linearity used by a MobileFaceNet variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Activation {
    /// `nn.ReLU`.
    Relu,
    /// `nn.PReLU` with per-channel slopes.
    Prelu,
}

/// Depthwise-residual MobileFaceNet hyperparameters.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MfnDwArch {
    /// Input channel count (1 gray / 3 color).
    pub in_channels: usize,
    /// Input spatial size `[height, width]`.
    pub input_size: [usize; 2],
    /// Block non-linearity.
    pub activation: Activation,
    /// Output channels per named stage.
    pub channels: MfnDwChannels,
    /// Hidden (expansion) widths of the `Depth_Wise` stages.
    pub groups: MfnDwGroups,
    /// `num_block` of each `Residual` stage.
    pub residual_num_blocks: MfnDwResidualBlocks,
    /// GDC depthwise kernel `[kh, kw]`.
    pub gdc_kernel: [usize; 2],
    /// Whether the GDC `Linear` has a bias.
    pub gdc_linear_bias: bool,
    /// GDC linear output width.
    pub embedding_size: usize,
    /// Network output dimension.
    pub output_dim: usize,
}

/// `channels` block of [`MfnDwArch`].
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(missing_docs)]
pub struct MfnDwChannels {
    pub conv1: usize,
    pub conv2_dw: usize,
    pub conv_23: usize,
    pub conv_3: usize,
    pub conv_34: usize,
    pub conv_4: usize,
    pub conv_45: usize,
    pub conv_5: usize,
    pub conv_6_sep: usize,
}

/// `groups` block of [`MfnDwArch`] (hidden widths of the bottlenecks).
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(missing_docs)]
pub struct MfnDwGroups {
    pub conv_23: usize,
    pub conv_3: usize,
    pub conv_34: usize,
    pub conv_4: usize,
    pub conv_45: usize,
    pub conv_5: usize,
}

/// `residual_num_blocks` block of [`MfnDwArch`].
#[derive(Debug, Clone, serde::Deserialize)]
#[allow(missing_docs)]
pub struct MfnDwResidualBlocks {
    pub conv_3: usize,
    pub conv_4: usize,
    pub conv_5: usize,
}

/// Bottleneck-style MobileFaceNet hyperparameters (Xiaoccer flavor).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MfnBottleneckArch {
    /// Input channel count.
    pub in_channels: usize,
    /// Input spatial size `[height, width]`.
    pub input_size: [usize; 2],
    /// Block non-linearity.
    pub activation: Activation,
    /// Stem convolution.
    pub conv1: ConvSpec,
    /// Depthwise convolution after the stem.
    pub dw_conv1: ConvSpec,
    /// `[expansion, channels, num_blocks, first_stride]` rows.
    pub bottleneck_setting: Vec<[usize; 4]>,
    /// Column names of `bottleneck_setting` (documentation only).
    #[serde(default)]
    pub bottleneck_setting_columns: Option<Vec<String>>,
    /// 1x1 expansion before the global depthwise conv.
    pub conv2: ConvSpec,
    /// GDC depthwise kernel `[kh, kw]`.
    pub gdc_kernel: [usize; 2],
    /// Whether the GDC linear stage has a bias.
    pub gdc_linear_bias: bool,
    /// Embedding width.
    pub embedding_size: usize,
    /// Network output dimension.
    pub output_dim: usize,
}

/// A convolution hyperparameter row inside a manifest arch block.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ConvSpec {
    /// Output channels.
    pub out: usize,
    /// Square kernel size.
    pub kernel: usize,
    /// Stride (defaults to 1).
    #[serde(default = "one")]
    pub stride: usize,
    /// Padding (defaults to 0).
    #[serde(default)]
    pub pad: usize,
}

fn one() -> usize {
    1
}

/// `family: "irn50"` hyperparameters.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Irn50Arch {
    /// Input spatial size `[height, width]`.
    pub input_size: [usize; 2],
    /// BatchNorm epsilon (upstream 9.999999747378752e-06).
    pub bn_eps: f64,
    /// Width of the final dense layer before maxout.
    pub fc_dim: usize,
    /// Output dimension after maxout.
    pub output_dim: usize,
    /// Whether the maxout head is present (always true upstream).
    pub maxout: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn models_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models")
    }

    fn load_manifest(name: &str) -> Option<ModelManifest> {
        let path = models_dir().join(format!("{name}.manifest.json"));
        let json = std::fs::read_to_string(&path).ok()?;
        Some(serde_json::from_str(&json).expect("manifest parses"))
    }

    #[test]
    fn detector_manifest_parses() {
        let Some(m) = load_manifest("detector-slim320") else {
            eprintln!("skipping: models/detector-slim320.manifest.json absent");
            return;
        };
        let Arch::UltrafaceSsd(arch) = &m.arch else {
            panic!("wrong family: {:?}", m.arch);
        };
        assert_eq!(arch.num_priors, 4420);
        assert_eq!(arch.base_channel, 16);
        assert_eq!(arch.source_layer_indexes, vec![8, 11, 13]);
        assert_eq!(m.tensors.len(), 184);
    }

    #[test]
    fn landmark_manifest_parses() {
        let Some(m) = load_manifest("landmark-mfn68") else {
            eprintln!("skipping: models/landmark-mfn68.manifest.json absent");
            return;
        };
        let Arch::MobileFaceNet(MfnArch::DepthwiseResidual(arch)) = &m.arch else {
            panic!("wrong family/style: {:?}", m.arch);
        };
        assert_eq!(arch.activation, Activation::Prelu);
        assert_eq!(arch.residual_num_blocks.conv_3, 4);
        assert_eq!(arch.residual_num_blocks.conv_4, 6);
        assert_eq!(arch.residual_num_blocks.conv_5, 2);
        assert_eq!(arch.gdc_kernel, [7, 7]);
        assert!(!arch.gdc_linear_bias);
        assert_eq!(arch.embedding_size, 136);
    }

    #[test]
    fn embedder_manifest_parses() {
        let Some(m) = load_manifest("embedder-mfn") else {
            eprintln!("skipping: models/embedder-mfn.manifest.json absent");
            return;
        };
        let Arch::MobileFaceNet(MfnArch::Bottleneck(arch)) = &m.arch else {
            panic!("wrong family/style: {:?}", m.arch);
        };
        assert_eq!(
            arch.bottleneck_setting,
            vec![
                [2, 64, 5, 2],
                [4, 128, 1, 2],
                [2, 128, 6, 1],
                [4, 128, 1, 2],
                [2, 128, 2, 1]
            ]
        );
        assert_eq!(arch.gdc_kernel, [7, 6]);
        assert_eq!(arch.embedding_size, 128);
        assert_eq!(arch.conv1.stride, 2);
        assert_eq!(arch.conv2.stride, 1);
    }
}
