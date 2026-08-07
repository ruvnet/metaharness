//! The numeric core — a faithful Rust port of kimi-k3-in-c's k3_ops.c.
//!
//! Numerics mirror the C reference: f64 accumulators wherever the C uses double,
//! f32 arithmetic wherever it uses float, bf16 widened by an exact 16-bit shift,
//! MXFP4 summed per 32-element group with the E8M0 scale applied once per group.
//! The matmul kernels reproduce the C engine's EXACT accumulator partitions and
//! reduction trees (16 f64 lanes for the dense kernels, 8 inside an MXFP4
//! group), so the two engines agree bit for bit on identical inputs — verified
//! end-to-end: first-step logits on the tiny checkpoint are byte-identical to
//! ./bin/k3's --dump-logits output.

use crate::st::bf16f;

/// A trunk weight matrix: fp32 (widened) or the checkpoint's own bf16 bytes.
pub enum Mat {
    F32(Vec<f32>),
    Bf16(Vec<u16>),
}

impl Mat {
    #[inline]
    pub fn at(&self, i: usize) -> f32 {
        match self {
            Mat::F32(v) => v[i],
            Mat::Bf16(v) => bf16f(v[i]),
        }
    }
}

/// One output row: SIXTEEN f64 accumulators partitioned by i%16, reduced as
/// ((a0+a4)+(a8+a12)) … then (b0+b1)+(b2+b3), sequential fma tail — the EXACT
/// partition and reduction tree k3_matmul uses, so this port matches the C
/// engine bit for bit BY CONSTRUCTION (fma in f64 is the same IEEE operation as
/// C's fma()/_mm256_fmadd_pd per lane). It also breaks the add-latency chain a
/// single accumulator serialises on, which is worth ~10x on its own.
#[inline(always)]
pub(crate) fn dot16(row: impl Fn(usize) -> f64, x: &[f32], inn: usize) -> f32 {
    let mut a = [0.0f64; 16];
    let mut i = 0;
    while i + 15 < inn {
        for l in 0..16 {
            a[l] = row(i + l).mul_add(x[i + l] as f64, a[l]);
        }
        i += 16;
    }
    let b0 = (a[0] + a[4]) + (a[8] + a[12]);
    let b1 = (a[1] + a[5]) + (a[9] + a[13]);
    let b2 = (a[2] + a[6]) + (a[10] + a[14]);
    let b3 = (a[3] + a[7]) + (a[11] + a[15]);
    let mut acc = (b0 + b1) + (b2 + b3);
    while i < inn {
        acc = row(i).mul_add(x[i] as f64, acc);
        i += 1;
    }
    acc as f32
}

/// Row-parallel driver: rows are partitioned across threads (never reduced
/// across them), so thread count cannot change a single output bit — the same
/// contract as the C engine's OpenMP loops. Below the threshold everything
/// stays serial: a scoped-spawn costs tens of microseconds, which would swamp
/// the tiny-model row counts while being noise at real K3 dimensions.
const PAR_ROWS: usize = 1024;

fn par_rows(y: &mut [f32], body: impl Fn(usize, &mut [f32]) + Sync) {
    let out = y.len();
    let nt = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    if out < PAR_ROWS || nt < 2 {
        body(0, y);
        return;
    }
    let chunk = out.div_ceil(nt);
    std::thread::scope(|s| {
        for (ti, ys) in y.chunks_mut(chunk).enumerate() {
            let body = &body;
            s.spawn(move || body(ti * chunk, ys));
        }
    });
}

/// y[out] = W[out][inn] . x[inn]. Row-major, no bias anywhere in this model.
/// Dispatches to the AVX2 path when the CPU has avx2+fma; that path reproduces
/// the portable dot16 tree exactly (see avx2.rs), so the choice is invisible in
/// the output bits. x is precast to f64 ONCE per call (exact) and shared by
/// every row — the same trick the patched C kernel uses.
pub fn matmul(y: &mut [f32], x: &[f32], w: &Mat, inn: usize, out: usize) {
    debug_assert_eq!(y.len(), out);
    #[cfg(target_arch = "x86_64")]
    if crate::avx2::usable() {
        let xd = crate::avx2::precast(&x[..inn]);
        match w {
            Mat::F32(wv) => par_rows(y, |lo, ys| {
                for (r, yo) in ys.iter_mut().enumerate() {
                    let row = &wv[(lo + r) * inn..(lo + r + 1) * inn];
                    *yo = unsafe { crate::avx2::dot_f32_pre(row, &xd, x, inn) };
                }
            }),
            Mat::Bf16(wv) => par_rows(y, |lo, ys| {
                for (r, yo) in ys.iter_mut().enumerate() {
                    let row = &wv[(lo + r) * inn..(lo + r + 1) * inn];
                    *yo = unsafe { crate::avx2::dot_bf16_pre(row, &xd, x, inn) };
                }
            }),
        }
        return;
    }
    match w {
        Mat::F32(wv) => par_rows(y, |lo, ys| {
            for (r, yo) in ys.iter_mut().enumerate() {
                let row = &wv[(lo + r) * inn..(lo + r + 1) * inn];
                *yo = dot16(|i| row[i] as f64, x, inn);
            }
        }),
        Mat::Bf16(wv) => par_rows(y, |lo, ys| {
            for (r, yo) in ys.iter_mut().enumerate() {
                let row = &wv[(lo + r) * inn..(lo + r + 1) * inn];
                *yo = dot16(|i| bf16f(row[i]) as f64, x, inn);
            }
        }),
    }
}

#[inline(always)]
pub fn sigmoidf(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// y = w * x / sqrt(mean(x^2) + eps). Double accumulator; eps INSIDE the rsqrt.
pub fn rmsnorm(y: &mut [f32], x: &[f32], w: &[f32], n: usize, eps: f32) {
    let mut ss = 0.0f64;
    for i in 0..n {
        ss += x[i] as f64 * x[i] as f64;
    }
    let inv = (1.0 / (ss / n as f64 + eps as f64).sqrt()) as f32;
    for i in 0..n {
        y[i] = w[i] * x[i] * inv;
    }
}

/// In-place rmsnorm (C callers alias y == x freely; Rust needs the copy).
pub fn rmsnorm_inplace(v: &mut [f32], w: &[f32], n: usize, eps: f32) {
    let mut ss = 0.0f64;
    for i in 0..n {
        ss += v[i] as f64 * v[i] as f64;
    }
    let inv = (1.0 / (ss / n as f64 + eps as f64).sqrt()) as f32;
    for i in 0..n {
        v[i] = w[i] * v[i] * inv;
    }
}

/// L2 norm over the last dim: SUM of squares (not mean), eps inside the rsqrt.
pub fn l2norm(v: &mut [f32], eps: f32) {
    let mut ss = 0.0f64;
    for &e in v.iter() {
        ss += e as f64 * e as f64;
    }
    let inv = (1.0 / (ss + eps as f64).sqrt()) as f32;
    for e in v.iter_mut() {
        *e *= inv;
    }
}

/// SiTU-GLU over a 2n input laid out [gate | up]. Sigmoid sees the UNCAPPED gate.
pub fn situ_glu(y: &mut [f32], x: &[f32], n: usize, b1: f32, b2: f32) {
    for i in 0..n {
        let g = x[i];
        let a = b1 * (g / b1).tanh() * sigmoidf(g);
        let u = b2 * (x[n + i] / b2).tanh();
        y[i] = a * u;
    }
}

/// Causal depthwise conv, SiLU fused. state[c*(k-1)+j] = previous inputs, oldest
/// first, updated in place. x/y are [T][channels]; w is [channels][k] with
/// w[k-1] on the CURRENT input. y may alias x (the C caller does exactly that),
/// so the input value is read before the output store.
pub fn shortconv(
    xy: &mut [f32],
    w: &[f32],
    mut state: Option<&mut [f32]>,
    channels: usize,
    k: usize,
    t_len: usize,
) {
    let hist = k - 1;
    let mut buf = vec![0.0f32; hist];
    for c in 0..channels {
        if hist > 0 {
            match &state {
                Some(s) => buf.copy_from_slice(&s[c * hist..(c + 1) * hist]),
                None => buf.iter_mut().for_each(|b| *b = 0.0),
            }
        }
        for t in 0..t_len {
            let cur = xy[t * channels + c];
            let mut acc = w[c * k + hist] * cur;
            for j in 0..hist {
                acc += w[c * k + j] * buf[j];
            }
            for j in 0..hist.saturating_sub(1) {
                buf[j] = buf[j + 1];
            }
            if hist > 0 {
                buf[hist - 1] = cur;
            }
            xy[t * channels + c] = acc * sigmoidf(acc);
        }
        if hist > 0 {
            if let Some(s) = state.as_deref_mut() {
                s[c * hist..(c + 1) * hist].copy_from_slice(&buf);
            }
        }
    }
}

/// Decay chain. A_log is indexed PER HEAD; alpha = exp(lb * sigmoid(exp(A_log[h]) * (z + dt_bias))).
pub fn kda_decay(
    g: &mut [f32],
    alpha: &mut [f32],
    z: &[f32],
    a_log: &[f32],
    dt_bias: &[f32],
    h_n: usize,
    d: usize,
    lb: f32,
) {
    for h in 0..h_n {
        let a = a_log[h].exp();
        for j in 0..d {
            let i = h * d + j;
            let u = a * (z[i] + dt_bias[i]);
            let gi = lb * sigmoidf(u);
            g[i] = gi;
            alpha[i] = gi.exp();
        }
    }
}

/// One KDA recurrence step for one head. S is [dk][dv] row-major.
/// Order is load bearing: decay, read, delta write, output from UPDATED state.
pub fn kda_step(
    s: &mut [f32],
    o: &mut [f32],
    q: &[f32],
    k: &[f32],
    v: &[f32],
    alpha: &[f32],
    beta: f32,
    dk: usize,
    dv: usize,
) {
    for i in 0..dk {
        let a = alpha[i];
        for j in 0..dv {
            s[i * dv + j] *= a;
        }
    }
    let mut u = vec![0.0f32; dv];
    for i in 0..dk {
        let ki = k[i];
        if ki == 0.0 {
            continue;
        }
        for j in 0..dv {
            u[j] += ki * s[i * dv + j];
        }
    }
    for i in 0..dk {
        let ki = k[i];
        if ki == 0.0 {
            continue;
        }
        for j in 0..dv {
            s[i * dv + j] += ki * beta * (v[j] - u[j]);
        }
    }
    o.iter_mut().for_each(|e| *e = 0.0);
    for i in 0..dk {
        let qi = q[i];
        if qi == 0.0 {
            continue;
        }
        for j in 0..dv {
            o[j] += qi * s[i * dv + j];
        }
    }
}

/// MoE routing, one token: sigmoid scores; SELECTION on scores+bias; combining
/// weights from the UNBIASED scores; optional renorm; then routed_scale.
pub fn router(
    idx: &mut [usize],
    w: &mut [f32],
    x: &[f32],
    gate: &[f32],
    bias: &[f32],
    hidden: usize,
    n_experts: usize,
    topk: usize,
    renorm: bool,
    routed_scale: f32,
) {
    let mut score = vec![0.0f32; n_experts];
    let mut choice = vec![0.0f32; n_experts];
    for e in 0..n_experts {
        let row = &gate[e * hidden..(e + 1) * hidden];
        let mut acc = 0.0f64;
        for i in 0..hidden {
            acc += row[i] as f64 * x[i] as f64;
        }
        score[e] = 1.0 / (1.0 + (-(acc as f32)).exp());
        choice[e] = score[e] + bias[e];
    }
    for j in 0..topk {
        let mut best: isize = -1;
        let mut bv = f32::NEG_INFINITY;
        for e in 0..n_experts {
            if choice[e] > bv {
                bv = choice[e];
                best = e as isize;
            }
        }
        if best < 0 {
            idx[j] = 0;
            w[j] = 0.0;
            continue;
        }
        idx[j] = best as usize;
        w[j] = score[best as usize];
        choice[best as usize] = f32::NEG_INFINITY;
    }
    if renorm && topk > 1 {
        let mut s = 0.0f64;
        for j in 0..topk {
            s += w[j] as f64;
        }
        let inv = (1.0 / (s + 1e-20)) as f32;
        for j in 0..topk {
            w[j] *= inv;
        }
    }
    for j in 0..topk {
        w[j] *= routed_scale;
    }
}

/// AttnRes aggregation: keys are the RMS-normalised sources scored against the
/// folded norm*proj vector; the softmax mixes the RAW sources.
pub fn attn_res(out: &mut [f32], src: &[f32], fold: &[f32], nsrc: usize, n: usize, eps: f32) {
    let mut score = vec![0.0f32; nsrc];
    for s in 0..nsrc {
        let v = &src[s * n..(s + 1) * n];
        let mut ss = 0.0f64;
        for i in 0..n {
            ss += v[i] as f64 * v[i] as f64;
        }
        let inv = (1.0 / (ss / n as f64 + eps as f64).sqrt()) as f32;
        let mut acc = 0.0f64;
        for i in 0..n {
            acc += (v[i] * inv) as f64 * fold[i] as f64;
        }
        score[s] = acc as f32;
    }
    let mut m = score[0];
    for s in 1..nsrc {
        if score[s] > m {
            m = score[s];
        }
    }
    let mut z = 0.0f64;
    for s in 0..nsrc {
        score[s] = (score[s] - m).exp();
        z += score[s] as f64;
    }
    out.iter_mut().for_each(|e| *e = 0.0);
    for s in 0..nsrc {
        let p = (score[s] as f64 / z) as f32;
        let v = &src[s * n..(s + 1) * n];
        for i in 0..n {
            out[i] += p * v[i];
        }
    }
}

// ---------------------------------------------------------------- MXFP4 ----

/// OCP MX E2M1: index by the 4-bit code; bit 3 is the sign.
pub const E2M1: [f32; 16] = [
    0.0, 0.5, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0, -0.0, -0.5, -1.0, -1.5, -2.0, -3.0, -4.0, -6.0,
];

/// E8M0 byte -> power of two; 255 is NaN by spec and maps to zero. Precomputed
/// once (the C engine's K3_E8M0 table): a powi in the group loop costs more
/// than the group's arithmetic.
pub fn e8m0(b: u8) -> f32 {
    static T: std::sync::OnceLock<[f32; 256]> = std::sync::OnceLock::new();
    T.get_or_init(|| {
        let mut t = [0.0f32; 256];
        for (b, v) in t.iter_mut().enumerate() {
            // 2^(b-127), exact including the denormal 2^-127 (b == 0).
            *v = if b == 255 { 0.0 } else { (2.0f64).powi(b as i32 - 127) as f32 };
        }
        t
    })[b as usize]
}

/// y[rows] = W[rows][inn] . x[inn], W read straight out of packed MXFP4.
/// Per 32-element group: exact products summed in double, then the group's
/// E8M0 scale applied once. Low nibble = EVEN element (the load-bearing
/// convention, gated upstream by fixtures/mxfp4.json).
pub fn matmul_mxfp4(
    y: &mut [f32],
    x: &[f32],
    packed: &[u8],
    scales: &[u8],
    inn: usize,
    rows: usize,
    group: usize,
) {
    let pcols = inn / 2;
    let ngrp = (inn + group - 1) / group;
    let gbyte = group / 2;
    #[cfg(target_arch = "x86_64")]
    if crate::avx2::usable() {
        let xd = crate::avx2::precast(&x[..inn]);
        par_rows(y, |lo, ys| {
            for (ri, yo) in ys.iter_mut().enumerate() {
                let r = lo + ri;
                let pr = &packed[r * pcols..(r + 1) * pcols];
                let sr = &scales[r * ngrp..(r + 1) * ngrp];
                *yo = unsafe { crate::avx2::mxfp4_row(pr, sr, &xd, x, inn, group) };
            }
        });
        return;
    }
    for r in 0..rows {
        let pr = &packed[r * pcols..(r + 1) * pcols];
        let sr = &scales[r * ngrp..(r + 1) * ngrp];
        let mut acc = 0.0f64;
        for g in 0..ngrp {
            let sb = sr[g];
            if sb == 255 {
                continue;
            }
            let pb = &pr[g * gbyte..];
            let xg = &x[g * group..];
            let n = (inn - g * group).min(group);
            // Expand the group, then EIGHT f64 lanes partitioned by i%8, reduced
            // as (s0+s4)+(s1+s5)… — the same partition and tree as the C kernel's
            // group loop, so the two engines agree bit for bit here too.
            let mut wf = [0.0f64; 64];
            let half = n >> 1;
            for j in 0..half {
                let byte = pb[j];
                wf[2 * j] = E2M1[(byte & 0x0F) as usize] as f64;
                wf[2 * j + 1] = E2M1[(byte >> 4) as usize] as f64;
            }
            if n & 1 == 1 {
                wf[n - 1] = E2M1[(pb[half] & 0x0F) as usize] as f64;
            }
            let mut s = [0.0f64; 8];
            let mut i = 0;
            while i + 7 < n {
                for l in 0..8 {
                    s[l] = wf[i + l].mul_add(xg[i + l] as f64, s[l]);
                }
                i += 8;
            }
            let b0 = s[0] + s[4];
            let b1 = s[1] + s[5];
            let b2 = s[2] + s[6];
            let b3 = s[3] + s[7];
            let mut sub = (b0 + b1) + (b2 + b3);
            while i < n {
                sub = wf[i].mul_add(xg[i] as f64, sub);
                i += 1;
            }
            acc += sub * e8m0(sb) as f64;
        }
        y[r] = acc as f32;
    }
}
