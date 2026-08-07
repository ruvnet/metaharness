//! `k3rs --bench`: the two dominant kernels at REAL Kimi K3 dimensions, the same
//! shapes benchmarks/bench_kernels.c measures, with row-parallel threading
//! (row-partitioned like the C engine's OpenMP loops: no shared accumulator, so
//! thread count cannot change a single output bit).

use crate::ops::{matmul_mxfp4, Mat};

use crate::st::bf16f;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
}

fn threads() -> usize {
    std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1)
}

/// Row-parallel bf16 matmul: each thread owns a disjoint slice of output rows.
fn matmul_bf16_par(y: &mut [f32], x: &[f32], w: &[u16], inn: usize, out: usize) {
    let nt = threads().min(out);
    let chunk = out.div_ceil(nt);
    std::thread::scope(|s| {
        for (ti, ys) in y.chunks_mut(chunk).enumerate() {
            let lo = ti * chunk;
            let rows = &w[lo * inn..(lo + ys.len()) * inn];
            s.spawn(move || {
                for (r, yo) in ys.iter_mut().enumerate() {
                    let row = &rows[r * inn..(r + 1) * inn];
                    *yo = crate::ops::dot16(|i| bf16f(row[i]) as f64, x, inn);
                }
            });
        }
    });
}

fn matmul_mxfp4_par(
    y: &mut [f32],
    x: &[f32],
    packed: &[u8],
    scales: &[u8],
    inn: usize,
    rows: usize,
    group: usize,
) {
    let nt = threads().min(rows);
    let chunk = rows.div_ceil(nt);
    let pcols = inn / 2;
    let ngrp = (inn + group - 1) / group;
    std::thread::scope(|s| {
        for (ti, ys) in y.chunks_mut(chunk).enumerate() {
            let lo = ti * chunk;
            let p = &packed[lo * pcols..(lo + ys.len()) * pcols];
            let sc = &scales[lo * ngrp..(lo + ys.len()) * ngrp];
            s.spawn(move || {
                matmul_mxfp4(ys, x, p, sc, inn, ys.len(), group);
            });
        }
    });
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h = 0xcbf29ce484222325u64;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

pub fn run() {
    println!("k3rs kernel benchmark at REAL Kimi K3 dimensions ({} threads)", threads());
    let mut rng = Lcg(0x9e3779b97f4a7c15);

    // bf16 trunk matmul, 12288 x 7168 — the KDA q/k/v/g projection shape.
    {
        let (out, inn) = (12288usize, 7168usize);
        let w: Vec<u16> = (0..out * inn)
            .map(|_| {
                // plausible bf16 magnitudes: reuse the f32 pattern trick
                let f = ((rng.next() % 2000) as f32 - 1000.0) / 1000.0;
                (f.to_bits() >> 16) as u16
            })
            .collect();
        let x: Vec<f32> = (0..inn).map(|_| ((rng.next() % 2000) as f32 - 1000.0) / 1000.0).collect();
        let mut y = vec![0.0f32; out];
        matmul_bf16_par(&mut y, &x, &w, inn, out); // warmup
        let reps = 5;
        let mut best = f64::INFINITY;
        for _ in 0..reps {
            let t0 = std::time::Instant::now();
            matmul_bf16_par(&mut y, &x, &w, inn, out);
            best = best.min(t0.elapsed().as_secs_f64());
        }
        let gf = (2.0 * out as f64 * inn as f64) / best / 1e9;
        let hash = fnv1a(&y.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        println!("bf16 matmul  {out} x {inn}   {:8.2} ms   {gf:6.1} GFLOP/s", best * 1e3);
        println!("             bf16  OUTPUT FNV1a = {hash:016x}");
        println!("             trunk is 56.74 G params/token -> {:.2} s/token at this rate",
                 56.74e9 / (gf * 1e9 / 2.0));
    }

    // MXFP4 expert matmul, 3072 x 3584 — one routed-expert w1/w3 shape.
    {
        let (rows, inn) = (3072usize, 3584usize);
        let group = 32usize;
        let packed: Vec<u8> = (0..rows * inn / 2).map(|_| (rng.next() & 0xFF) as u8).collect();
        let scales: Vec<u8> = (0..rows * inn / group).map(|_| (120 + rng.next() % 14) as u8).collect();
        let x: Vec<f32> = (0..inn).map(|_| ((rng.next() % 2000) as f32 - 1000.0) / 1000.0).collect();
        let mut y = vec![0.0f32; rows];
        matmul_mxfp4_par(&mut y, &x, &packed, &scales, inn, rows, group);
        let reps = 5;
        let mut best = f64::INFINITY;
        for _ in 0..reps {
            let t0 = std::time::Instant::now();
            matmul_mxfp4_par(&mut y, &x, &packed, &scales, inn, rows, group);
            best = best.min(t0.elapsed().as_secs_f64());
        }
        let gf = (2.0 * rows as f64 * inn as f64) / best / 1e9;
        let hash = fnv1a(&y.iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        println!("MXFP4 matmul  {rows} x {inn}   {:7.2} ms   {gf:6.1} GFLOP/s", best * 1e3);
        println!("             mxfp4 OUTPUT FNV1a = {hash:016x}");
        println!("             16 experts x 3 mats x 92 layers -> {:.2} s/token",
                 16.0 * 3.0 * 92.0 * 2.0 * 3072.0 * 3584.0 / (gf * 1e9));
    }

    // Single-thread reference of the engine's own kernel (what forward() uses).
    {
        let (out, inn) = (12288usize, 7168usize);
        let w: Vec<u16> = (0..out * inn).map(|_| (rng.next() & 0x3FFF) as u16).collect();
        let x: Vec<f32> = (0..inn).map(|_| ((rng.next() % 2000) as f32 - 1000.0) / 1000.0).collect();
        let m = Mat::Bf16(w);
        let mut y = vec![0.0f32; out];
        let t0 = std::time::Instant::now();
        crate::ops::matmul(&mut y, &x, &m, inn, out);
        let dt = t0.elapsed().as_secs_f64();
        println!("single-thread engine bf16 matmul: {:8.2} ms   {:6.1} GFLOP/s",
                 dt * 1e3, (2.0 * out as f64 * inn as f64) / dt / 1e9);
    }
}
