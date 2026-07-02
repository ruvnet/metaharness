//! Criterion benchmarks for the rvFACE pipeline (ADR-0006), NdArray backend.
//!
//! Requires the converted weights in `models/` and the cached upstream test
//! image (`tools/.cache/test_1.jpg`); benches that lack inputs are skipped.
//! Run from the workspace root: `cargo bench -p rvface-cli`.

use std::fs;
use std::path::{Path, PathBuf};

use criterion::{criterion_group, criterion_main, Criterion};
use rvface_core::similarity::similarity;
use rvface_core::Image;
use rvface_models::embedder::MfnBottleneckConfig;
use rvface_models::landmark::MfnDwConfig;
use rvface_models::weights::{Arch, MfnArch, ModelManifest};
use rvface_models::{Embedder, FacePipeline};

type B = burn::backend::NdArray;

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("workspace root")
}

fn load_manifest(dir: &Path, name: &str) -> ModelManifest {
    let text = fs::read_to_string(dir.join(format!("{name}.manifest.json"))).unwrap();
    serde_json::from_str(&text).unwrap()
}

fn load_pipeline(root: &Path) -> Option<FacePipeline<B>> {
    let models = root.join("models");
    if !models.join("detector-slim320.safetensors").exists() {
        eprintln!("bench skipped: run tools/fetch_and_convert.py first");
        return None;
    }
    let device = Default::default();
    let landmark_config = match load_manifest(&models, "landmark-mfn68").arch {
        Arch::MobileFaceNet(MfnArch::DepthwiseResidual(a)) => MfnDwConfig::from_arch(&a),
        other => panic!("unexpected landmark arch {other:?}"),
    };
    let embedder_config = match load_manifest(&models, "embedder-mfn").arch {
        Arch::MobileFaceNet(MfnArch::Bottleneck(a)) => MfnBottleneckConfig::from_arch(&a),
        other => panic!("unexpected embedder arch {other:?}"),
    };
    let embedder = Embedder::mobilefacenet_from_safetensors(
        &fs::read(models.join("embedder-mfn.safetensors")).unwrap(),
        embedder_config,
        &device,
    )
    .unwrap();
    Some(
        FacePipeline::from_safetensors(
            &fs::read(models.join("detector-slim320.safetensors")).unwrap(),
            &fs::read(models.join("landmark-mfn68.safetensors")).unwrap(),
            landmark_config,
            embedder,
            &device,
        )
        .unwrap(),
    )
}

fn load_test_image(root: &Path) -> Option<Image> {
    let path = root.join("tools/.cache/test_1.jpg");
    if !path.exists() {
        eprintln!("bench skipped: {} missing", path.display());
        return None;
    }
    let img = image::open(path).unwrap().to_rgb8();
    let (w, h) = (img.width() as usize, img.height() as usize);
    Some(Image::new(img.into_raw(), w, h, 3).unwrap())
}

fn bench_pipeline(c: &mut Criterion) {
    let root = workspace_root();
    let (Some(pipeline), Some(img)) = (load_pipeline(&root), load_test_image(&root)) else {
        return;
    };

    let mut group = c.benchmark_group("pipeline-cpu");
    group.sample_size(10);

    group.bench_function("detect", |b| {
        b.iter(|| pipeline.detect(&img, 5).unwrap());
    });
    group.bench_function("analyze-1-face", |b| {
        b.iter(|| pipeline.analyze(&img, 5).unwrap());
    });

    let faces = pipeline.analyze(&img, 5).unwrap();
    let emb = &faces[0].embedding;
    group.bench_function("similarity", |b| {
        b.iter(|| similarity(emb, emb));
    });
    group.finish();
}

criterion_group!(benches, bench_pipeline);
criterion_main!(benches);
