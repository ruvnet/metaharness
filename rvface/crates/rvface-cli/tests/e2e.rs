//! Tier-3 end-to-end tests (ADR-0006): the upstream demo images through the
//! full Rust pipeline with the real converted weights in `models/`.
//!
//! Native-only (needs `std::fs`); skips gracefully with an explanation on
//! stderr when the weights or the cached test images are absent (they are
//! fetched locally by `tools/fetch_and_convert.py`, never committed), the
//! same pattern as the tier-2 parity tests.

use std::path::{Path, PathBuf};
use std::process::Command;

use burn::backend::NdArray;
use rvface_core::align::{
    compute_alignment, eye_centers, ALIGN_EYE_CENTER_X, ALIGN_EYE_DIST, ALIGN_EYE_Y,
};
use rvface_core::similarity::{is_match, similarity};
use rvface_core::Image;
use rvface_models::embedder::MfnBottleneckConfig;
use rvface_models::landmark::MfnDwConfig;
use rvface_models::weights::{Arch, MfnArch, ModelManifest};
use rvface_models::{Embedder, Face, FacePipeline};

type B = NdArray;

/// The two upstream demo photos (`test/1.jpg`, `test/2.png`), cached by the
/// fetch tooling. Upstream's `run.py` prints "same person" for this pair.
const TEST_IMAGES: [&str; 2] = ["tools/.cache/test_1.jpg", "tools/.cache/test_2.png"];

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_optional(path: &Path) -> Option<Vec<u8>> {
    match std::fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(_) => {
            eprintln!("skipping: {} absent", path.display());
            None
        }
    }
}

fn manifest(name: &str) -> Option<ModelManifest> {
    let path = repo_root().join(format!("models/{name}.manifest.json"));
    let json = String::from_utf8(read_optional(&path)?).expect("manifest is utf-8");
    Some(serde_json::from_str(&json).expect("manifest parses"))
}

/// Builds the default (MobileFaceNet-embedder) pipeline from `models/`, or
/// `None` when any weight/manifest file is absent.
fn load_pipeline() -> Option<FacePipeline<B>> {
    let device = Default::default();
    let models = repo_root().join("models");
    let detector = read_optional(&models.join("detector-slim320.safetensors"))?;
    let landmark = read_optional(&models.join("landmark-mfn68.safetensors"))?;
    let embedder = read_optional(&models.join("embedder-mfn.safetensors"))?;

    let landmark_config = match manifest("landmark-mfn68")?.arch {
        Arch::MobileFaceNet(MfnArch::DepthwiseResidual(arch)) => MfnDwConfig::from_arch(&arch),
        other => panic!("unexpected landmark arch: {other:?}"),
    };
    let embedder_config = match manifest("embedder-mfn")?.arch {
        Arch::MobileFaceNet(MfnArch::Bottleneck(arch)) => MfnBottleneckConfig::from_arch(&arch),
        other => panic!("unexpected embedder arch: {other:?}"),
    };

    let embedder = Embedder::mobilefacenet_from_safetensors(&embedder, embedder_config, &device)
        .expect("embedder weights load");
    Some(
        FacePipeline::from_safetensors(&detector, &landmark, landmark_config, embedder, &device)
            .expect("pipeline weights load"),
    )
}

fn load_image(repo_relative: &str) -> Option<Image> {
    let path = repo_root().join(repo_relative);
    if !path.exists() {
        eprintln!("skipping: {} absent", path.display());
        return None;
    }
    let img = image::open(&path)
        .unwrap_or_else(|e| panic!("open {}: {e}", path.display()))
        .to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Some(Image::new(img.into_raw(), w, h, 3).expect("RGB8 buffer"))
}

fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// Per-image tier-3 property checks (ADR-0006).
fn check_faces(label: &str, faces: &[Face]) {
    assert!(!faces.is_empty(), "{label}: no face detected");
    let face = &faces[0];

    // Primary detection is confident.
    assert!(
        face.detection.score > 0.9,
        "{label}: primary score {} <= 0.9",
        face.detection.score
    );

    // All 68 landmarks lie within a modestly expanded detector box (jawline
    // and hairline points legitimately overshoot the tight box a little).
    let b = face.detection.bbox;
    let (mx, my) = (0.2 * (b.x2 - b.x1), 0.2 * (b.y2 - b.y1));
    for (i, p) in face.landmarks.iter().enumerate() {
        assert!(
            p[0] >= b.x1 - mx && p[0] <= b.x2 + mx && p[1] >= b.y1 - my && p[1] <= b.y2 + my,
            "{label}: landmark {i} at {p:?} outside expanded box {b:?} (margin {mx}x{my})"
        );
    }

    // Pose angles are plausible for a demo portrait.
    for (name, angle) in [
        ("yaw", face.pose.yaw),
        ("pitch", face.pose.pitch),
        ("roll", face.pose.roll),
    ] {
        assert!(angle.abs() < 45.0, "{label}: |{name}| = {angle} >= 45");
    }

    // Alignment property: pushing the landmarks through the computed
    // transform puts the eye centers at (44, 48) / (84, 48) within 1 px.
    let t = compute_alignment(
        &face.landmarks,
        ALIGN_EYE_Y,
        ALIGN_EYE_CENTER_X,
        ALIGN_EYE_DIST,
    )
    .expect("real-face landmarks are non-degenerate");
    let mut transformed = face.landmarks;
    for p in transformed.iter_mut() {
        *p = t.apply(*p);
    }
    let (left, right) = eye_centers(&transformed);
    assert!(
        (left[0] - 44.0).abs() <= 1.0 && (left[1] - 48.0).abs() <= 1.0,
        "{label}: aligned left eye at {left:?}, expected (44, 48) +-1"
    );
    assert!(
        (right[0] - 84.0).abs() <= 1.0 && (right[1] - 48.0).abs() <= 1.0,
        "{label}: aligned right eye at {right:?}, expected (84, 48) +-1"
    );

    // Embeddings come out L2-normalized.
    for (i, f) in faces.iter().enumerate() {
        let norm = l2_norm(&f.embedding);
        assert!(
            (norm - 1.0).abs() < 1e-4,
            "{label}: face {i} embedding norm {norm}"
        );
    }

    // Self-similarity of an embedding with itself is the score ceiling.
    let self_score = similarity(&face.embedding, &face.embedding);
    assert!(
        (self_score - 100.0).abs() <= 0.01,
        "{label}: self-similarity {self_score} != 100 +-0.01"
    );
}

#[test]
fn e2e_pipeline_on_upstream_test_images() {
    let Some(pipeline) = load_pipeline() else {
        return;
    };
    let (Some(img1), Some(img2)) = (load_image(TEST_IMAGES[0]), load_image(TEST_IMAGES[1])) else {
        return;
    };

    let faces1 = pipeline.analyze(&img1, 5).expect("analyze test_1");
    let faces2 = pipeline.analyze(&img2, 5).expect("analyze test_2");
    check_faces("test_1.jpg", &faces1);
    check_faces("test_2.png", &faces2);

    // Cross-image similarity, upstream run.py semantics (features[0] each).
    // The two demo photos are the same person and the upstream demo prints
    // "same person"; the substitute MobileFaceNet embedder agrees. Measured
    // 78.165 (NdArray f32, 2026-07) — asserted as a range around that value
    // so a legitimate rebuild of the weights doesn't false-alarm, while any
    // preprocessing regression (channel order, crop math, normalization)
    // still trips it.
    let score = similarity(&faces1[0].embedding, &faces2[0].embedding);
    println!("cross-image similarity (MFN embedder) = {score:.3}");
    assert!(
        is_match(score),
        "cross-image score {score} <= 75: verdict no longer matches upstream's 'same person'"
    );
    assert!(
        (76.0..81.0).contains(&score),
        "cross-image score {score} outside the empirical range [76, 81) (measured 78.165)"
    );
}

/// Drives the actual `rvface` binary end-to-end (ADR-0006: "CLI `rvface
/// compare` is the harness").
#[test]
fn e2e_cli_compare_verdict() {
    let root = repo_root();
    let models = root.join("models");
    for file in [
        "detector-slim320.safetensors",
        "landmark-mfn68.safetensors",
        "embedder-mfn.safetensors",
    ] {
        if !models.join(file).exists() {
            eprintln!("skipping: models/{file} absent");
            return;
        }
    }
    let (img1, img2) = (root.join(TEST_IMAGES[0]), root.join(TEST_IMAGES[1]));
    if !img1.exists() || !img2.exists() {
        eprintln!("skipping: cached test images absent");
        return;
    }

    let output = Command::new(env!("CARGO_BIN_EXE_rvface"))
        .arg("compare")
        .arg(&img1)
        .arg(&img2)
        .arg("--models-dir")
        .arg(&models)
        .output()
        .expect("spawn rvface");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "rvface compare failed: {stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("score = "), "missing score line: {stdout}");
    assert!(
        stdout.contains("same person"),
        "expected the upstream demo verdict 'same person': {stdout}"
    );
}
