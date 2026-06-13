// SPDX-License-Identifier: MIT
//
// Benchmark witness entry serialization. The witness manifest is signed
// per release — canonicalization cost matters for CI throughput.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use ruflo_kernel::witness::WitnessEntry;

fn bench_serialize(c: &mut Criterion) {
    let entry = WitnessEntry {
        id: "fix-2364".into(),
        desc: "Federation plugin caps agentic-flow peer to <2.0.13".into(),
        marker: "v3/@claude-flow/plugin-agent-federation/package.json".into(),
        sha256: "0".repeat(64),
    };
    c.bench_function("witness_entry_serialize", |b| {
        b.iter(|| {
            let _ = serde_json::to_string(black_box(&entry)).unwrap();
        })
    });
}

fn bench_roundtrip(c: &mut Criterion) {
    let entry = WitnessEntry {
        id: "fix-x".into(),
        desc: "test".into(),
        marker: "src/x.rs".into(),
        sha256: "abc".repeat(21) + "a",
    };
    let s = serde_json::to_string(&entry).unwrap();
    c.bench_function("witness_entry_roundtrip", |b| {
        b.iter(|| {
            let back: WitnessEntry = serde_json::from_str(black_box(&s)).unwrap();
            black_box(back);
        })
    });
}

criterion_group!(benches, bench_serialize, bench_roundtrip);
criterion_main!(benches);
