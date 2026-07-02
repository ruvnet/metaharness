//! rvface-wasm: browser bindings for the rvFACE pipeline (ADR-0005).
//!
//! One shipped binary carries both backends: the Burn NdArray CPU backend
//! (always available) and — when built with the `webgpu` feature — the Burn
//! wgpu backend on the browser's WebGPU adapter. Backend selection happens
//! at [`RvFace::new`]; a failed WebGPU initialization **falls back to CPU**
//! and reports the live backend via the `backend` getter (the caller never
//! hard-fails for lack of GPU).
//!
//! # JS surface (consumed by `web/src/engine-wasm.ts`)
//!
//! ```text
//! RvFace.new(detector, landmark, embedder,        // safetensors bytes
//!            landmarkManifest, embedderManifest,  // manifest JSON strings
//!            backend)                             // "cpu" | "webgpu"
//!     -> Promise<RvFace>
//! rvface.backend                                  // live backend string
//! rvface.analyze(rgba, width, height, maxFaces)   // RGBA8 canvas pixels
//!     -> Promise<Float32Array>                    // packed faces, see below
//! rvface.similarity(a, b) -> number               // (dot + 1) * 50, 0..100
//! rvface.free()
//! ```
//!
//! # `analyze` packing
//!
//! Face structs cross the JS boundary as one flat `Float32Array` (no serde
//! round-trip, ADR-0005). Layout:
//!
//! ```text
//! [ nFaces,
//!   then per face:
//!     x1, y1, x2, y2, score,          // detector box (px) + confidence
//!     yaw, pitch, roll,               // head pose, degrees
//!     lx0, ly0, ... lx67, ly67,       // 68 landmarks (136 floats, px)
//!     embLen, e0 .. e(embLen-1)       // L2-normalized embedding
//! ]
//! ```

use std::rc::Rc;

use burn::tensor::backend::Backend;
use wasm_bindgen::prelude::*;

use rvface_core::image::Image;
use rvface_models::embedder::MfnBottleneckConfig;
use rvface_models::landmark::MfnDwConfig;
use rvface_models::weights::{Arch, MfnArch, ModelManifest};
use rvface_models::{Embedder, Face, FacePipeline};

type NdArray = burn::backend::NdArray;

/// Install the panic hook once so Rust panics surface as readable JS
/// console errors instead of `RuntimeError: unreachable`.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Crate version (kept for a cheap "module alive" probe from JS).
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console, js_name = warn)]
    fn console_warn(msg: &str);
    #[wasm_bindgen(js_namespace = console, js_name = info)]
    fn console_info(msg: &str);
}

/// The pipeline instantiated on whichever backend actually initialized.
enum Pipeline {
    Cpu(FacePipeline<NdArray>),
    #[cfg(feature = "webgpu")]
    WebGpu(FacePipeline<burn::backend::Wgpu>),
}

/// The rvFACE engine: detector + landmarks + pose + alignment + embedder.
#[wasm_bindgen]
pub struct RvFace {
    pipeline: Rc<Pipeline>,
    backend: &'static str,
}

#[wasm_bindgen]
impl RvFace {
    /// Constructs the engine from raw safetensors bytes + the two model
    /// manifests (JSON). `backend` is `"cpu"` or `"webgpu"`; an unavailable
    /// WebGPU adapter (or a wasm build without the `webgpu` feature) falls
    /// back to CPU — check the `backend` getter for the live backend.
    #[allow(clippy::new_ret_no_self)] // exported as the JS static `RvFace.new`
    pub async fn new(
        detector: Vec<u8>,
        landmark: Vec<u8>,
        embedder: Vec<u8>,
        landmark_manifest: String,
        embedder_manifest: String,
        backend: String,
    ) -> Result<RvFace, JsValue> {
        match backend.as_str() {
            "cpu" => {}
            "webgpu" => {
                #[cfg(feature = "webgpu")]
                match try_webgpu(
                    &detector,
                    &landmark,
                    &embedder,
                    &landmark_manifest,
                    &embedder_manifest,
                )
                .await
                {
                    Ok(pipeline) => {
                        console_info("rvface: WebGPU backend initialized");
                        return Ok(RvFace {
                            pipeline: Rc::new(Pipeline::WebGpu(pipeline)),
                            backend: "webgpu",
                        });
                    }
                    Err(e) => {
                        console_warn(&format!(
                            "rvface: WebGPU unavailable ({e}), falling back to CPU"
                        ));
                    }
                }
                #[cfg(not(feature = "webgpu"))]
                console_warn(
                    "rvface: this wasm build has no `webgpu` feature, falling back to CPU",
                );
            }
            other => {
                return Err(JsValue::from_str(&format!(
                    "unknown backend \"{other}\" (expected \"cpu\" or \"webgpu\")"
                )));
            }
        }

        let device = <NdArray as Backend>::Device::default();
        let pipeline = build_pipeline::<NdArray>(
            &detector,
            &landmark,
            &embedder,
            &landmark_manifest,
            &embedder_manifest,
            &device,
        )
        .map_err(|e| JsValue::from_str(&e))?;
        Ok(RvFace {
            pipeline: Rc::new(Pipeline::Cpu(pipeline)),
            backend: "cpu",
        })
    }

    /// The backend that actually initialized (`"cpu"` | `"webgpu"`).
    #[wasm_bindgen(getter)]
    pub fn backend(&self) -> String {
        self.backend.to_string()
    }

    /// Full pipeline on tightly-packed RGBA8 pixels (canvas `getImageData`
    /// layout). Resolves to the packed `Float32Array` documented at module
    /// level; faces are score-descending, at most `max_faces`.
    pub fn analyze(
        &self,
        rgba: Vec<u8>,
        width: u32,
        height: u32,
        max_faces: u32,
    ) -> js_sys::Promise {
        let pipeline = Rc::clone(&self.pipeline);
        wasm_bindgen_futures::future_to_promise(async move {
            let image = rgba_to_rgb(&rgba, width as usize, height as usize)
                .map_err(|e| JsValue::from_str(&e))?;
            let faces = match pipeline.as_ref() {
                Pipeline::Cpu(p) => p
                    .analyze(&image, max_faces as usize)
                    .map_err(|e| JsValue::from_str(&format!("analyze failed: {e}")))?,
                #[cfg(feature = "webgpu")]
                Pipeline::WebGpu(p) => p
                    .analyze_async(&image, max_faces as usize)
                    .await
                    .map_err(|e| JsValue::from_str(&format!("analyze failed: {e}")))?,
            };
            let packed = pack_faces(&faces);
            Ok(js_sys::Float32Array::from(packed.as_slice()).into())
        })
    }

    /// Upstream similarity of two L2-normalized embeddings:
    /// `(dot(a, b) + 1) * 50`, 0..100, match at > 75.
    pub fn similarity(&self, a: &[f32], b: &[f32]) -> Result<f32, JsValue> {
        if a.len() != b.len() || a.is_empty() {
            return Err(JsValue::from_str(&format!(
                "embedding length mismatch: {} vs {}",
                a.len(),
                b.len()
            )));
        }
        Ok(rvface_core::similarity::similarity(a, b))
    }
}

/// Parses the landmark manifest and extracts the depthwise-residual config.
fn landmark_config(json: &str) -> Result<MfnDwConfig, String> {
    let manifest: ModelManifest =
        serde_json::from_str(json).map_err(|e| format!("parsing landmark manifest: {e}"))?;
    match &manifest.arch {
        Arch::MobileFaceNet(MfnArch::DepthwiseResidual(arch)) => Ok(MfnDwConfig::from_arch(arch)),
        other => Err(format!(
            "landmark manifest has unexpected arch family: {other:?}"
        )),
    }
}

/// Parses the embedder manifest and extracts the bottleneck config.
fn embedder_config(json: &str) -> Result<MfnBottleneckConfig, String> {
    let manifest: ModelManifest =
        serde_json::from_str(json).map_err(|e| format!("parsing embedder manifest: {e}"))?;
    match &manifest.arch {
        Arch::MobileFaceNet(MfnArch::Bottleneck(arch)) => Ok(MfnBottleneckConfig::from_arch(arch)),
        other => Err(format!(
            "embedder manifest has unexpected arch family: {other:?}"
        )),
    }
}

/// Manifest-driven pipeline construction on any Burn backend (mirrors
/// `rvface-cli::load_pipeline`, from in-memory buffers only).
fn build_pipeline<B: Backend>(
    detector: &[u8],
    landmark: &[u8],
    embedder: &[u8],
    landmark_manifest: &str,
    embedder_manifest: &str,
    device: &B::Device,
) -> Result<FacePipeline<B>, String> {
    let landmark_cfg = landmark_config(landmark_manifest)?;
    let embedder_cfg = embedder_config(embedder_manifest)?;
    let embedder = Embedder::mobilefacenet_from_safetensors(embedder, embedder_cfg, device)
        .map_err(|e| format!("loading embedder weights: {e}"))?;
    FacePipeline::from_safetensors(detector, landmark, landmark_cfg, embedder, device)
        .map_err(|e| format!("loading detector/landmark weights: {e}"))
}

/// Attempts full WebGPU initialization: feature-detect an adapter via
/// `navigator.gpu.requestAdapter()`, then initialize Burn's wgpu runtime
/// and build the pipeline on it.
#[cfg(feature = "webgpu")]
async fn try_webgpu(
    detector: &[u8],
    landmark: &[u8],
    embedder: &[u8],
    landmark_manifest: &str,
    embedder_manifest: &str,
) -> Result<FacePipeline<burn::backend::Wgpu>, String> {
    if !webgpu_adapter_available().await {
        return Err(
            "no WebGPU adapter (navigator.gpu absent or requestAdapter() returned null)"
                .to_string(),
        );
    }
    let device = burn::backend::wgpu::WgpuDevice::default();
    burn::backend::wgpu::init_setup_async::<burn::backend::wgpu::graphics::AutoGraphicsApi>(
        &device,
        Default::default(),
    )
    .await;
    build_pipeline::<burn::backend::Wgpu>(
        detector,
        landmark,
        embedder,
        landmark_manifest,
        embedder_manifest,
        &device,
    )
}

/// True when `navigator.gpu.requestAdapter()` resolves to a non-null
/// adapter. Uses `js_sys::Reflect` (not `web_sys`) so no unstable WebGPU
/// API surface is required at compile time.
#[cfg(feature = "webgpu")]
async fn webgpu_adapter_available() -> bool {
    fn get(target: &JsValue, key: &str) -> Option<JsValue> {
        let v = js_sys::Reflect::get(target, &JsValue::from_str(key)).ok()?;
        (!v.is_undefined() && !v.is_null()).then_some(v)
    }
    let global: JsValue = js_sys::global().into();
    let Some(navigator) = get(&global, "navigator") else {
        return false;
    };
    let Some(gpu) = get(&navigator, "gpu") else {
        return false;
    };
    let Some(request) = get(&gpu, "requestAdapter") else {
        return false;
    };
    let Ok(request) = request.dyn_into::<js_sys::Function>() else {
        return false;
    };
    let Ok(promise) = request.call0(&gpu) else {
        return false;
    };
    let Ok(promise) = promise.dyn_into::<js_sys::Promise>() else {
        return false;
    };
    match wasm_bindgen_futures::JsFuture::from(promise).await {
        Ok(adapter) => !adapter.is_null() && !adapter.is_undefined(),
        Err(_) => false,
    }
}

/// Converts tightly-packed RGBA8 (canvas `getImageData`) to the pipeline's
/// RGB8 [`Image`], dropping alpha.
fn rgba_to_rgb(rgba: &[u8], width: usize, height: usize) -> Result<Image, String> {
    let expected = width
        .checked_mul(height)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| "image dimensions overflow".to_string())?;
    if rgba.len() != expected {
        return Err(format!(
            "rgba buffer length {} != {width}x{height}x4",
            rgba.len()
        ));
    }
    let mut rgb = Vec::with_capacity(width * height * 3);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    Image::new(rgb, width, height, 3).map_err(|e| e.to_string())
}

/// Packs analyzed faces into the flat layout documented at module level.
fn pack_faces(faces: &[Face]) -> Vec<f32> {
    let per_face = 8 + 136 + 1;
    let emb: usize = faces.iter().map(|f| f.embedding.len()).sum();
    let mut out = Vec::with_capacity(1 + faces.len() * per_face + emb);
    out.push(faces.len() as f32);
    for f in faces {
        let b = f.detection.bbox;
        out.extend_from_slice(&[
            b.x1,
            b.y1,
            b.x2,
            b.y2,
            f.detection.score,
            f.pose.yaw,
            f.pose.pitch,
            f.pose.roll,
        ]);
        for p in &f.landmarks {
            out.push(p[0]);
            out.push(p[1]);
        }
        out.push(f.embedding.len() as f32);
        out.extend_from_slice(&f.embedding);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use rvface_core::boxes::{BBox, Detection};
    use rvface_core::Pose;

    fn face(embedding: Vec<f32>) -> Face {
        Face {
            detection: Detection {
                bbox: BBox {
                    x1: 1.0,
                    y1: 2.0,
                    x2: 3.0,
                    y2: 4.0,
                },
                score: 0.5,
            },
            landmarks: [[7.0, 8.0]; 68],
            pose: Pose {
                yaw: 10.0,
                pitch: 20.0,
                roll: 30.0,
            },
            embedding,
        }
    }

    #[test]
    fn packs_faces_flat() {
        let packed = pack_faces(&[face(vec![0.6, 0.8])]);
        assert_eq!(packed.len(), 1 + 8 + 136 + 1 + 2);
        assert_eq!(packed[0], 1.0); // face count
        assert_eq!(&packed[1..9], &[1.0, 2.0, 3.0, 4.0, 0.5, 10.0, 20.0, 30.0]);
        assert_eq!(packed[9], 7.0);
        assert_eq!(packed[10], 8.0);
        assert_eq!(packed[1 + 8 + 136], 2.0); // embedding length
        assert_eq!(&packed[1 + 8 + 136 + 1..], &[0.6, 0.8]);
    }

    #[test]
    fn packs_empty() {
        assert_eq!(pack_faces(&[]), vec![0.0]);
    }

    #[test]
    fn rgba_conversion_drops_alpha() {
        let rgba = vec![1, 2, 3, 255, 4, 5, 6, 255];
        let img = rgba_to_rgb(&rgba, 2, 1).unwrap();
        assert_eq!(img.data, vec![1, 2, 3, 4, 5, 6]);
        assert!(rgba_to_rgb(&rgba, 3, 1).is_err());
    }
}
