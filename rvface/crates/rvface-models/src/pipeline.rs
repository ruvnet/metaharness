//! The full rvFACE inference pipeline: upstream `run.py GetImageInfo`
//! assembled entirely in Rust.
//!
//! Flow per image (exact upstream order): detect faces (slim-320 SSD at
//! 320x240) -> truncate to `max_faces` (`boxes[:faceMaxCount]`) -> per face:
//! 68-point landmarks (cunjian MobileFaceNet on a 1.2x square crop) -> head
//! pose from the landmarks -> eyes-level 128x128 alignment -> embedding ->
//! L2 normalization. Comparison downstream uses
//! `rvface_core::similarity::similarity` (`(dot + 1) * 50`, threshold 75).
//!
//! Channel-order bookkeeping: upstream loads images with `cv2.imread` (BGR).
//! The detector converts to RGB before preprocessing; the landmark net and
//! the IRN-50 embedder consume BGR directly. [`FacePipeline::analyze`] takes
//! an **RGB8** [`Image`] and performs the equivalent swaps internally, so the
//! net effect is identical to the upstream BGR flow.
//!
//! Everything here works from in-memory buffers only (no `std::fs`), so the
//! module compiles unchanged for `wasm32-unknown-unknown`.

use burn::tensor::backend::Backend;
use burn::tensor::{Tensor, TensorData};

use rvface_core::align::{align_vertical, Landmarks};
use rvface_core::boxes::{postprocess, PostprocessParams};
use rvface_core::image::{
    resize_bilinear_f32, swap_rb, to_chw_f32, Image, DETECTOR_MEAN, DETECTOR_SCALE, EMBEDDER_SCALE,
    LANDMARK_SCALE,
};
use rvface_core::pose::estimate_pose;
use rvface_core::similarity::l2_normalize;
use rvface_core::{Detection, Pose};

use crate::detector::SsdSlim320;
use crate::embedder::{Irn50, MfnBottleneckConfig, MobileFaceNetEmbedder};
use crate::landmark::{MfnDwConfig, MobileFaceNetDw};
use crate::weights::{Weights, WeightsError};

/// Landmark-net input side (cunjian `MobileFaceNet([112, 112], 136)`).
const LANDMARK_INPUT: usize = 112;
/// Crop enlargement factor of the landmark square (`int(min(w, h) * 1.2)`).
const LANDMARK_CROP_SCALE: f32 = 1.2;
/// MobileFaceNet embedder input `[width, height]` (Xiaoccer, 112x96 crop).
const MFN_INPUT: [usize; 2] = [96, 112];
/// MobileFaceNet embedder normalization mean (`(x - 127.5) / 128`).
const MFN_MEAN: [f32; 3] = [127.5, 127.5, 127.5];
/// MobileFaceNet embedder normalization scale.
const MFN_SCALE: f32 = 1.0 / 128.0;

/// One fully analyzed face.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Face {
    /// Detector box (pixel coordinates in the source image) and score.
    pub detection: Detection,
    /// 68 landmarks, pixel coordinates in the source image.
    #[serde(serialize_with = "serialize_landmarks")]
    pub landmarks: Landmarks,
    /// Head pose estimated from the landmarks.
    pub pose: Pose,
    /// L2-normalized embedding (128-d MobileFaceNet / 256-d IRN-50).
    pub embedding: Vec<f32>,
}

/// Serde stops at 32-element arrays; serialize the 68 points as a sequence.
fn serialize_landmarks<S: serde::Serializer>(
    landmarks: &Landmarks,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.collect_seq(landmarks.iter())
}

/// The embedding network of the pipeline.
///
/// - [`Embedder::Irn50`] is the **exact upstream path**
///   (`face_feature/GetFeature.py`): the aligned 128x128 crop is fed in the
///   source image's channel order — BGR upstream, since `cv2.imread` loads
///   BGR and `align_vertical` preserves channel order — scaled by 1/256
///   (upstream divides by 256, not 255), no mean subtraction. Use it when
///   converted `irn50_pytorch.npy` weights are available.
/// - [`Embedder::MobileFaceNet`] is a documented **adaptation**: the upstream
///   IRN-50 weights are unpublished, so the default embedder is the Xiaoccer
///   MobileFaceNet (112x96 RGB input, `(x - 127.5) / 128`). Its reference
///   pipeline crops SphereFace-style 112x96 MTCNN alignments; rvFACE instead
///   bilinear-resizes the pipeline's aligned 128x128 crop to 96x112. Scores
///   are therefore *not* bit-comparable with the upstream demo — the IRN-50
///   variant is the parity path.
pub enum Embedder<B: Backend> {
    /// Xiaoccer MobileFaceNet, 128-d (default; adaptation, see enum docs).
    MobileFaceNet(MobileFaceNetEmbedder<B>),
    /// Upstream IRN-50, 256-d (exact upstream architecture and preprocessing).
    Irn50(Irn50<B>),
}

impl<B: Backend> Embedder<B> {
    /// Loads the MobileFaceNet embedder from a safetensors buffer.
    pub fn mobilefacenet_from_safetensors(
        bytes: &[u8],
        config: MfnBottleneckConfig,
        device: &B::Device,
    ) -> Result<Self, WeightsError> {
        let weights = Weights::from_safetensors(bytes, device)?;
        Ok(Self::MobileFaceNet(MobileFaceNetEmbedder::new(
            weights, config,
        )))
    }

    /// Loads the IRN-50 embedder from a safetensors buffer.
    pub fn irn50_from_safetensors(bytes: &[u8], device: &B::Device) -> Result<Self, WeightsError> {
        let weights = Weights::from_safetensors(bytes, device)?;
        Ok(Self::Irn50(Irn50::new(weights)))
    }

    /// Embeds an aligned 128x128 **RGB** crop (as produced by
    /// `align_vertical` on an RGB source). Returns the raw, not yet
    /// L2-normalized embedding.
    fn embed(&self, mut aligned: Image, device: &B::Device) -> Result<Vec<f32>, WeightsError> {
        let raw = match self {
            // Adaptation (see enum docs): resize the aligned 128x128 RGB crop
            // to the net's 96x112 input, normalize (x - 127.5) / 128.
            Self::MobileFaceNet(net) => {
                let [w, h] = MFN_INPUT;
                let hwc = resize_bilinear_f32(&aligned, w, h);
                let chw = hwc_to_chw(&hwc, w, h, &MFN_MEAN, MFN_SCALE);
                let input = Tensor::from_data(TensorData::new(chw, [1, 3, h, w]), device);
                net.forward(input)?
            }
            // Exact upstream path: `GetFeature.py` feeds the aligned crop in
            // the cv2 (BGR) channel order, scaled by 1/256. Our source is
            // RGB, so swap to BGR before the CHW conversion.
            Self::Irn50(net) => {
                swap_rb(&mut aligned);
                let chw = to_chw_f32(&aligned, &[0.0; 3], EMBEDDER_SCALE);
                let (w, h) = (aligned.width, aligned.height);
                let input = Tensor::from_data(TensorData::new(chw, [1, 3, h, w]), device);
                net.forward(input)?
            }
        };
        Ok(raw.into_data().to_vec().expect("embedding to host"))
    }
}

/// The assembled detector + landmark + pose + alignment + embedding pipeline.
pub struct FacePipeline<B: Backend> {
    detector: SsdSlim320<B>,
    landmark: MobileFaceNetDw<B>,
    embedder: Embedder<B>,
    device: B::Device,
}

impl<B: Backend> FacePipeline<B> {
    /// Assembles a pipeline from already-constructed networks.
    pub fn new(
        detector: SsdSlim320<B>,
        landmark: MobileFaceNetDw<B>,
        embedder: Embedder<B>,
        device: B::Device,
    ) -> Self {
        Self {
            detector,
            landmark,
            embedder,
            device,
        }
    }

    /// Builds the pipeline from raw safetensors buffers: the slim-320
    /// detector, the cunjian-112 landmark net (config usually
    /// [`MfnDwConfig::cunjian_112`] or [`MfnDwConfig::from_arch`] on the
    /// model manifest) and a pre-built [`Embedder`]. Wasm-friendly: bytes in,
    /// no filesystem access.
    pub fn from_safetensors(
        detector_bytes: &[u8],
        landmark_bytes: &[u8],
        landmark_config: MfnDwConfig,
        embedder: Embedder<B>,
        device: &B::Device,
    ) -> Result<Self, WeightsError> {
        let detector = SsdSlim320::new(Weights::from_safetensors(detector_bytes, device)?);
        let landmark = MobileFaceNetDw::new(
            Weights::from_safetensors(landmark_bytes, device)?,
            landmark_config,
        );
        Ok(Self::new(detector, landmark, embedder, device.clone()))
    }

    /// Runs the full upstream `GetImageInfo` flow on an **RGB8** image and
    /// returns at most `max_faces` analyzed faces, in detector pick order
    /// (score-descending).
    ///
    /// Errors only on missing/misshaped weight tensors; an image without
    /// detectable faces yields an empty vector.
    pub fn analyze(&self, image: &Image, max_faces: usize) -> Result<Vec<Face>, WeightsError> {
        assert_eq!(image.channels, 3, "analyze expects an RGB8 image");
        let detections = self.detect(image, max_faces)?;
        let mut faces = Vec::with_capacity(detections.len());
        for detection in detections {
            // Degenerate boxes (sub-pixel landmark crops) cannot be analyzed;
            // upstream would crash here, we skip the face instead.
            let Some(landmarks) = self.landmarks(image, &detection)? else {
                continue;
            };
            let pose = estimate_pose(&landmarks);
            let aligned = align_vertical(image, &landmarks);
            let mut embedding = self.embedder.embed(aligned, &self.device)?;
            l2_normalize(&mut embedding);
            faces.push(Face {
                detection,
                landmarks,
                pose,
                embedding,
            });
        }
        Ok(faces)
    }

    /// Detection stage: resize to 320x240 (kept in f32 — see note), normalize
    /// `(x - 127) / 128`, forward, then the exact upstream postprocessing
    /// chain (`Predictor.predict` + `get_face_boundingbox`) truncated to
    /// `max_faces` (`boxes[:faceMaxCount]`).
    ///
    /// Note: upstream `cv2.resize`s the u8 image (fixed-point, quantized back
    /// to u8) before the float normalization. rvFACE keeps the bilinear
    /// result in f32 (`resize_bilinear_f32`) because our float resampler can
    /// differ from OpenCV's fixed-point u8 rounding by +-1 (see
    /// `rvface_core::image::resize_bilinear`); skipping the quantization
    /// avoids compounding that rounding, at the cost of sub-1/255-per-pixel
    /// input deltas versus Python.
    pub fn detect(&self, image: &Image, max_faces: usize) -> Result<Vec<Detection>, WeightsError> {
        let [w, h] = SsdSlim320::<B>::IMAGE_SIZE;
        let hwc = resize_bilinear_f32(image, w, h);
        let chw = hwc_to_chw(&hwc, w, h, &DETECTOR_MEAN, DETECTOR_SCALE);
        let input = Tensor::from_data(TensorData::new(chw, [1, 3, h, w]), &self.device);
        let out = self.detector.forward(input)?;
        let mut detections = postprocess(
            &out.confidences,
            &out.boxes,
            image.width,
            image.height,
            &PostprocessParams::default(),
        );
        detections.truncate(max_faces);
        Ok(detections)
    }

    /// Landmark stage, exactly per `tools/fixtures/landmark-cunjian.notes.md`:
    /// 1.2x min-side square crop about the (floor-divided) box center, zero
    /// padding where the square leaves the image, 112x112 bilinear resize,
    /// BGR, `/255`; the [0, 1] outputs are mapped back through the padded
    /// square's frame into source-image pixels.
    fn landmarks(
        &self,
        image: &Image,
        detection: &Detection,
    ) -> Result<Option<Landmarks>, WeightsError> {
        let Some(crop) = LandmarkCrop::compute(image, detection) else {
            return Ok(None);
        };
        let side = LANDMARK_INPUT;
        let hwc = resize_bilinear_f32(&crop.square, side, side);
        let chw = hwc_to_chw(&hwc, side, side, &[0.0; 3], LANDMARK_SCALE);
        let input = Tensor::from_data(TensorData::new(chw, [1, 3, side, side]), &self.device);
        let (out, _conv_features) = self.landmark.forward(input)?;
        let raw: Vec<f32> = out.into_data().to_vec().expect("landmarks to host");

        // Reproject [0, 1] square coordinates into source-image pixels
        // (`BBox.reprojectLandmark`), using the padded square's true frame.
        let mut landmarks: Landmarks = [[0.0; 2]; 68];
        for (i, p) in landmarks.iter_mut().enumerate() {
            *p = [
                raw[2 * i] * crop.square.width as f32 + crop.origin_x as f32,
                raw[2 * i + 1] * crop.square.height as f32 + crop.origin_y as f32,
            ];
        }
        Ok(Some(landmarks))
    }
}

/// The zero-padded square landmark crop and its position in the source image.
struct LandmarkCrop {
    /// BGR square crop, image content copied in, borders zero-padded.
    square: Image,
    /// Source-image x of the square's left edge (may be negative).
    origin_x: i64,
    /// Source-image y of the square's top edge (may be negative).
    origin_y: i64,
}

impl LandmarkCrop {
    /// Ports the cunjian `test_batch_detections.py` crop math verbatim
    /// (Python `int()` truncation, `//` floor division, `cv2.copyMakeBorder`
    /// zero padding). Returns `None` for degenerate (sub-pixel) squares.
    fn compute(image: &Image, detection: &Detection) -> Option<Self> {
        let b = detection.bbox;
        let w = b.x2 - b.x1 + 1.0;
        let h = b.y2 - b.y1 + 1.0;
        // `size = int(min(w, h) * 1.2)`.
        let size = (w.min(h) * LANDMARK_CROP_SCALE) as i64;
        if size <= 0 {
            return None;
        }
        // `cx = x1 + w // 2` (floor division on the float box), square corner
        // offset by the integer `size // 2`.
        let cx = b.x1 + (w / 2.0).floor();
        let cy = b.y1 + (h / 2.0).floor();
        let half = (size / 2) as f32;
        let fx1 = cx - half;
        let fy1 = cy - half;
        let fx2 = fx1 + size as f32;
        let fy2 = fy1 + size as f32;

        // Clip to the image; the clipped-off amounts become zero padding
        // (`dx, dy, edx, edy`, each truncated like Python `int()`).
        let (iw, ih) = (image.width as f32, image.height as f32);
        let pad_l = (-fx1).max(0.0) as usize;
        let pad_t = (-fy1).max(0.0) as usize;
        let pad_r = (fx2 - iw).max(0.0) as usize;
        let pad_b = (fy2 - ih).max(0.0) as usize;
        let ix1 = fx1.max(0.0) as usize;
        let iy1 = fy1.max(0.0) as usize;
        let ix2 = fx2.min(iw) as usize;
        let iy2 = fy2.min(ih) as usize;
        if ix2 <= ix1 || iy2 <= iy1 {
            return None;
        }
        let (crop_w, crop_h) = (ix2 - ix1, iy2 - iy1);

        // Assemble crop + padding in one buffer; the landmark net was trained
        // on cv2 (BGR) crops, so swap channels while copying from RGB.
        let mut square = Image::zeros(crop_w + pad_l + pad_r, crop_h + pad_t + pad_b, 3);
        for y in 0..crop_h {
            for x in 0..crop_w {
                for c in 0..3 {
                    square.set(x + pad_l, y + pad_t, c, image.get(ix1 + x, iy1 + y, 2 - c));
                }
            }
        }
        Some(Self {
            square,
            origin_x: ix1 as i64 - pad_l as i64,
            origin_y: iy1 as i64 - pad_t as i64,
        })
    }
}

/// Interleaved HWC f32 -> normalized CHW f32: `out = (v - mean[c]) * scale`
/// (the f32 sibling of `rvface_core::image::to_chw_f32`).
fn hwc_to_chw(hwc: &[f32], w: usize, h: usize, mean: &[f32; 3], scale: f32) -> Vec<f32> {
    debug_assert_eq!(hwc.len(), w * h * 3);
    let mut out = vec![0.0f32; 3 * h * w];
    for y in 0..h {
        for x in 0..w {
            for (c, m) in mean.iter().enumerate() {
                out[c * h * w + y * w + x] = (hwc[(y * w + x) * 3 + c] - m) * scale;
            }
        }
    }
    out
}
