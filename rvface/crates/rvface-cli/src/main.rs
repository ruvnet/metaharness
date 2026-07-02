//! rvFACE native CLI: the tier-3 harness for the full inference pipeline
//! (ADR-0006). `detect` prints boxes/landmarks/pose for one image; `compare`
//! reproduces the upstream `run.py` demo semantics: similarity of the two
//! images' primary faces (`features[0]`), verdict at threshold 75.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Context;
use burn::tensor::backend::Backend;
use clap::{Parser, Subcommand, ValueEnum};
use rvface_core::similarity::{is_match, similarity};
use rvface_core::{Detection, Image, Pose};
use rvface_models::embedder::MfnBottleneckConfig;
use rvface_models::landmark::MfnDwConfig;
use rvface_models::weights::{Arch, MfnArch, ModelManifest};
use rvface_models::{Embedder, Face, FacePipeline};

#[derive(Parser)]
#[command(
    name = "rvface",
    version,
    about = "rvFACE: Rust face recognition (port of Faceplugin Open-Source-Face-Recognition-SDK)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,

    /// Directory holding the converted weights + manifests
    /// (detector-slim320 / landmark-mfn68 / embedder-mfn)
    #[arg(long, global = true, value_name = "DIR", default_value = "models")]
    models_dir: PathBuf,

    /// Swap the default MobileFaceNet embedder for the exact upstream IRN-50
    /// (a converted irn50 safetensors file)
    #[arg(long, global = true, value_name = "FILE")]
    irn50: Option<PathBuf>,

    /// Inference backend
    #[arg(long, global = true, value_enum, default_value_t = BackendChoice::Cpu)]
    backend: BackendChoice,
}

#[derive(Clone, Copy, ValueEnum)]
enum BackendChoice {
    /// Burn NdArray backend (always available)
    Cpu,
    /// Burn wgpu backend (requires building with `--features webgpu`)
    Webgpu,
}

#[derive(Subcommand)]
enum Command {
    /// Detect faces in an image; print boxes, scores, landmarks and pose
    Detect {
        /// Input image (jpeg/png/bmp/tiff)
        image: PathBuf,
        /// Analyze at most this many faces (upstream faceMaxCount)
        #[arg(long, default_value_t = 5)]
        max_faces: usize,
        /// Emit JSON instead of human-readable text
        #[arg(long)]
        json: bool,
    },
    /// Compare the primary face of two images; prints the 0-100 similarity
    /// score and the same-person verdict at threshold 75
    Compare {
        /// First image
        image_a: PathBuf,
        /// Second image
        image_b: PathBuf,
        /// Analyze at most this many faces per image
        #[arg(long, default_value_t = 5)]
        max_faces: usize,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    match cli.backend {
        BackendChoice::Cpu => run::<burn::backend::NdArray>(&cli),
        #[cfg(feature = "webgpu")]
        BackendChoice::Webgpu => run::<burn::backend::Wgpu>(&cli),
        #[cfg(not(feature = "webgpu"))]
        BackendChoice::Webgpu => anyhow::bail!(
            "this rvface binary was built without the `webgpu` feature; \
             rebuild with `cargo build -p rvface-cli --features webgpu` or use --backend cpu"
        ),
    }
}

fn run<B: Backend>(cli: &Cli) -> anyhow::Result<()>
where
    B::Device: Default,
{
    let pipeline = load_pipeline::<B>(&cli.models_dir, cli.irn50.as_deref())?;
    match &cli.command {
        Command::Detect {
            image,
            max_faces,
            json,
        } => {
            let faces = analyze(&pipeline, image, *max_faces)?;
            if *json {
                let report: Vec<DetectedFace> = faces.iter().map(DetectedFace::from).collect();
                println!("{}", serde_json::to_string_pretty(&report)?);
            } else {
                print_faces(&image.display().to_string(), &faces, true);
            }
        }
        Command::Compare {
            image_a,
            image_b,
            max_faces,
        } => {
            let faces_a = analyze(&pipeline, image_a, *max_faces)?;
            let faces_b = analyze(&pipeline, image_b, *max_faces)?;
            print_faces(&image_a.display().to_string(), &faces_a, false);
            print_faces(&image_b.display().to_string(), &faces_b, false);
            fn first<'a>(faces: &'a [Face], path: &Path) -> anyhow::Result<&'a Face> {
                faces
                    .first()
                    .with_context(|| format!("no face detected in {}", path.display()))
            }
            let fa = first(&faces_a, image_a)?;
            let fb = first(&faces_b, image_b)?;
            // Upstream run.py: score = (sum(f1 * f2) + 1) * 50 on features[0]
            // of each image, "same person" iff score > 75.
            let score = similarity(&fa.embedding, &fb.embedding);
            println!("score = {score:.3}");
            println!(
                "{}",
                if is_match(score) {
                    "same person"
                } else {
                    "different person"
                }
            );
        }
    }
    Ok(())
}

/// `detect --json` payload: everything except the embedding.
#[derive(serde::Serialize)]
struct DetectedFace<'a> {
    detection: &'a Detection,
    /// Slice view of the 68 [`Landmarks`] points (serde caps arrays at 32).
    landmarks: &'a [[f32; 2]],
    pose: &'a Pose,
}

impl<'a> From<&'a Face> for DetectedFace<'a> {
    fn from(face: &'a Face) -> Self {
        Self {
            detection: &face.detection,
            landmarks: &face.landmarks,
            pose: &face.pose,
        }
    }
}

/// Loads the three model files (+ manifests for the architecture blocks)
/// from `models_dir`, swapping in IRN-50 weights when supplied.
fn load_pipeline<B: Backend>(
    models_dir: &Path,
    irn50: Option<&Path>,
) -> anyhow::Result<FacePipeline<B>>
where
    B::Device: Default,
{
    let device = B::Device::default();
    let read = |name: &str| -> anyhow::Result<Vec<u8>> {
        let path = models_dir.join(name);
        fs::read(&path).with_context(|| {
            format!(
                "reading {} (run tools/fetch_and_convert.py or pass --models-dir)",
                path.display()
            )
        })
    };

    let landmark_manifest = manifest(models_dir, "landmark-mfn68")?;
    let landmark_config = match &landmark_manifest.arch {
        Arch::MobileFaceNet(MfnArch::DepthwiseResidual(arch)) => MfnDwConfig::from_arch(arch),
        other => anyhow::bail!("landmark-mfn68 manifest has unexpected arch family: {other:?}"),
    };

    let embedder = match irn50 {
        Some(path) => {
            let bytes = fs::read(path)
                .with_context(|| format!("reading IRN-50 weights {}", path.display()))?;
            Embedder::irn50_from_safetensors(&bytes, &device)?
        }
        None => {
            let embedder_manifest = manifest(models_dir, "embedder-mfn")?;
            let config = match &embedder_manifest.arch {
                Arch::MobileFaceNet(MfnArch::Bottleneck(arch)) => {
                    MfnBottleneckConfig::from_arch(arch)
                }
                other => {
                    anyhow::bail!("embedder-mfn manifest has unexpected arch family: {other:?}")
                }
            };
            Embedder::mobilefacenet_from_safetensors(
                &read("embedder-mfn.safetensors")?,
                config,
                &device,
            )?
        }
    };

    Ok(FacePipeline::from_safetensors(
        &read("detector-slim320.safetensors")?,
        &read("landmark-mfn68.safetensors")?,
        landmark_config,
        embedder,
        &device,
    )?)
}

fn manifest(models_dir: &Path, name: &str) -> anyhow::Result<ModelManifest> {
    let path = models_dir.join(format!("{name}.manifest.json"));
    let json = fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&json).with_context(|| format!("parsing {}", path.display()))
}

/// Loads an image with the `image` crate as RGB8. Upstream reads BGR with
/// cv2 and converts to RGB inside the detector transform; loading RGB
/// directly has the identical net effect (the pipeline handles the
/// BGR-consuming stages internally).
fn load_image(path: &Path) -> anyhow::Result<Image> {
    let img = image::open(path)
        .with_context(|| format!("opening image {}", path.display()))?
        .to_rgb8();
    let (width, height) = (img.width() as usize, img.height() as usize);
    Ok(Image::new(img.into_raw(), width, height, 3).expect("RGB8 buffer length matches"))
}

fn analyze<B: Backend>(
    pipeline: &FacePipeline<B>,
    path: &Path,
    max_faces: usize,
) -> anyhow::Result<Vec<Face>> {
    let image = load_image(path)?;
    Ok(pipeline.analyze(&image, max_faces)?)
}

fn print_faces(label: &str, faces: &[Face], with_landmarks: bool) {
    println!("{label}: {} face(s)", faces.len());
    for (i, face) in faces.iter().enumerate() {
        let b = face.detection.bbox;
        println!(
            "  face {i}: score {:.4}  box [{:.1}, {:.1}, {:.1}, {:.1}]",
            face.detection.score, b.x1, b.y1, b.x2, b.y2
        );
        println!(
            "    pose: yaw {:+.1} deg  pitch {:+.1} deg  roll {:+.1} deg",
            face.pose.yaw, face.pose.pitch, face.pose.roll
        );
        if with_landmarks {
            println!("    landmarks (68, source-image px):");
            for row in face.landmarks.chunks(8) {
                let line: Vec<String> = row
                    .iter()
                    .map(|p| format!("({:.0},{:.0})", p[0], p[1]))
                    .collect();
                println!("      {}", line.join(" "));
            }
        }
    }
}
