// SPDX-License-Identifier: MIT
//
// Benchmark mcp::validate hot path. This runs on every harness generation
// and on every host adapter dispatch — needs to stay sub-microsecond.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use ruflo_kernel::mcp::{validate, McpServerSpec};

fn bench_stdio(c: &mut Criterion) {
    let spec = McpServerSpec {
        name: "demo".into(),
        command: Some(vec!["npx".into(), "-y".into(), "demo".into()]),
        url: None,
        env: vec![],
    };
    c.bench_function("mcp_validate stdio happy path", |b| {
        b.iter(|| {
            let _ = validate(black_box(&spec));
        })
    });
}

fn bench_url(c: &mut Criterion) {
    let spec = McpServerSpec {
        name: "remote".into(),
        command: None,
        url: Some("https://example.com/mcp".into()),
        env: vec![],
    };
    c.bench_function("mcp_validate url happy path", |b| {
        b.iter(|| {
            let _ = validate(black_box(&spec));
        })
    });
}

fn bench_rejection(c: &mut Criterion) {
    let spec = McpServerSpec {
        name: "".into(),
        command: Some(vec!["x".into()]),
        url: None,
        env: vec![],
    };
    c.bench_function("mcp_validate rejection (empty name)", |b| {
        b.iter(|| {
            let _ = validate(black_box(&spec));
        })
    });
}

criterion_group!(benches, bench_stdio, bench_url, bench_rejection);
criterion_main!(benches);
