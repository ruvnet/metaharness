// SPDX-License-Identifier: MIT
//
// Criterion benchmarks: CFR iteration throughput (the inner loop that
// dominates training cost) and one-shot exploitability evaluation (the cost the
// Darwin fitness function pays per candidate). Run with `cargo bench -p
// poker-darwin`.

use criterion::{criterion_group, criterion_main, BatchSize, Criterion};
use poker_darwin::cfr::{CfrVariant, Solver, SolverConfig};
use poker_darwin::exploit::exploitability;
use poker_darwin::games::{KuhnPoker, LeducHoldem};

fn bench_cfr_iterations(c: &mut Criterion) {
    let mut group = c.benchmark_group("cfr_iterations");
    for &(name, variant) in &[
        ("vanilla", CfrVariant::Vanilla),
        ("cfr+", CfrVariant::CfrPlus),
        (
            "dcfr",
            CfrVariant::Dcfr {
                alpha: 1.5,
                beta: 0.0,
                gamma: 2.0,
            },
        ),
    ] {
        group.bench_function(format!("kuhn/{name}/100it"), |b| {
            b.iter_batched(
                || Solver::new(KuhnPoker::new(), SolverConfig::new(variant)),
                |mut s| s.train(100),
                BatchSize::SmallInput,
            )
        });
        group.bench_function(format!("leduc/{name}/20it"), |b| {
            b.iter_batched(
                || Solver::new(LeducHoldem::new(), SolverConfig::new(variant)),
                |mut s| s.train(20),
                BatchSize::SmallInput,
            )
        });
    }
    group.finish();
}

fn bench_exploitability(c: &mut Criterion) {
    let mut group = c.benchmark_group("exploitability");

    let mut kuhn = Solver::new(KuhnPoker::new(), SolverConfig::default());
    kuhn.train(500);
    let kuhn_avg = kuhn.average_strategy();
    group.bench_function("kuhn", |b| {
        b.iter(|| exploitability(&KuhnPoker::new(), &kuhn_avg))
    });

    let mut leduc = Solver::new(LeducHoldem::new(), SolverConfig::default());
    leduc.train(100);
    let leduc_avg = leduc.average_strategy();
    group.bench_function("leduc", |b| {
        b.iter(|| exploitability(&LeducHoldem::new(), &leduc_avg))
    });

    group.finish();
}

criterion_group!(benches, bench_cfr_iterations, bench_exploitability);
criterion_main!(benches);
