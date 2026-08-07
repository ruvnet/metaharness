//! Kernel unit tests mirroring the C fixture CONTRACTS (the invariants k3.h
//! documents as "gets this wrong silently"), plus the MXFP4 agreement bound
//! from tests/unit/test_expert.c.

use crate::ops::*;
use crate::st::bf16f;

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn f(&mut self) -> f32 {
        ((self.next() % 2000) as f32 - 1000.0) / 1000.0
    }
}

#[test]
fn bf16_widen_is_a_pure_shift() {
    for h in [0u16, 0x3f80, 0xbf80, 0x7f80, 0x0001, 0xffff] {
        assert_eq!(bf16f(h).to_bits(), (h as u32) << 16);
    }
}

#[test]
fn e8m0_spec_points() {
    assert_eq!(e8m0(127), 1.0);
    assert_eq!(e8m0(128), 2.0);
    assert_eq!(e8m0(126), 0.5);
    assert_eq!(e8m0(255), 0.0); // NaN by spec -> zero, one bad byte cannot poison a row
    assert_eq!(e8m0(0), (2.0f64).powi(-127) as f32); // denormal, exact
}

/// The test_expert.c contract: MXFP4-direct matmul must agree with
/// dequantise-then-matmul to 1e-6 relative (the group-scale reassociation is
/// bounded at ~1e-16; the margin is enormous).
#[test]
fn mxfp4_direct_agrees_with_dequant_then_matmul() {
    let mut rng = Lcg(7);
    let (rows, inn, group) = (64usize, 128usize, 32usize);
    let packed: Vec<u8> = (0..rows * inn / 2).map(|_| (rng.next() & 0xFF) as u8).collect();
    let scales: Vec<u8> = (0..rows * inn / group).map(|_| (120 + rng.next() % 14) as u8).collect();
    let x: Vec<f32> = (0..inn).map(|_| rng.f()).collect();

    let mut direct = vec![0.0f32; rows];
    matmul_mxfp4(&mut direct, &x, &packed, &scales, inn, rows, group);

    // dequantise (low nibble = EVEN element), then plain f32 matmul
    let mut wf = vec![0.0f32; rows * inn];
    for r in 0..rows {
        for i in 0..inn {
            let byte = packed[r * inn / 2 + i / 2];
            let nib = if i & 1 == 1 { byte >> 4 } else { byte & 0x0F };
            wf[r * inn + i] = E2M1[nib as usize] * e8m0(scales[r * (inn / group) + i / group]);
        }
    }
    let m = Mat::F32(wf);
    let mut viaf = vec![0.0f32; rows];
    matmul(&mut viaf, &x, &m, inn, rows);

    for r in 0..rows {
        let denom = viaf[r].abs().max(1.0);
        assert!(
            (direct[r] - viaf[r]).abs() / denom < 1e-6,
            "row {r}: {} vs {}",
            direct[r],
            viaf[r]
        );
    }
}

/// Invariant 3 from k3.h: the routing bias steers SELECTION only; combining
/// weights come from the UNBIASED sigmoid scores.
#[test]
fn router_bias_steers_selection_not_weights() {
    let hidden = 8usize;
    let n_experts = 4usize;
    // gate rows chosen so raw scores rank expert 0 > 1 > 2 > 3
    let mut gate = vec![0.0f32; n_experts * hidden];
    for e in 0..n_experts {
        for i in 0..hidden {
            gate[e * hidden + i] = 1.0 - e as f32 * 0.3;
        }
    }
    let x = vec![0.5f32; hidden];
    // bias reorders selection to favor expert 3 hard
    let bias = vec![0.0, 0.0, 0.0, 100.0];
    let mut idx = vec![0usize; 2];
    let mut w = vec![0.0f32; 2];
    router(&mut idx, &mut w, &x, &gate, &bias, hidden, n_experts, 2, false, 1.0);
    assert_eq!(idx[0], 3, "bias must reorder the selection");
    assert_eq!(idx[1], 0);
    // but the weight for expert 3 must be its UNBIASED sigmoid score
    let mut acc = 0.0f64;
    for i in 0..hidden {
        acc += gate[3 * hidden + i] as f64 * x[i] as f64;
    }
    let unbiased = 1.0 / (1.0 + (-(acc as f32)).exp());
    assert!((w[0] - unbiased).abs() < 1e-7, "weight must come from the unbiased score");
    assert!(w[0] < 1.0, "a biased weight would be ~1.0 after sigmoid(100)");
}

/// ShortConv causality: y[t] must not depend on x[t'] for t' > t.
#[test]
fn shortconv_is_causal() {
    let mut rng = Lcg(11);
    let (ch, k, t_len) = (3usize, 4usize, 6usize);
    let w: Vec<f32> = (0..ch * k).map(|_| rng.f()).collect();
    let x: Vec<f32> = (0..t_len * ch).map(|_| rng.f()).collect();

    let mut a = x.clone();
    shortconv(&mut a, &w, None, ch, k, t_len);

    let mut xb = x.clone();
    for c in 0..ch {
        xb[(t_len - 1) * ch + c] = 99.0; // perturb ONLY the last position
    }
    shortconv(&mut xb, &w, None, ch, k, t_len);
    for t in 0..t_len - 1 {
        for c in 0..ch {
            assert_eq!(a[t * ch + c], xb[t * ch + c], "t={t} leaked future input");
        }
    }
}

/// KDA step order: output must come from the ALREADY UPDATED state.
#[test]
fn kda_step_reads_updated_state() {
    let (dk, dv) = (2usize, 2usize);
    let mut s = vec![0.0f32; dk * dv]; // zero state
    let q = vec![1.0f32, 0.0];
    let k = vec![1.0f32, 0.0];
    let v = vec![2.0f32, 0.0];
    let alpha = vec![1.0f32, 1.0];
    let mut o = vec![0.0f32; dv];
    kda_step(&mut s, &mut o, &q, &k, &v, &alpha, 1.0, dk, dv);
    // from a zero state: u = 0, write S[0][:] += k0*beta*v = v, output o = S^T q = v.
    // Reading the PRE-update state would give o = 0.
    assert!((o[0] - 2.0).abs() < 1e-6, "output must read the updated state (got {})", o[0]);
}

/// rmsnorm: eps inside the rsqrt, mean (not sum) of squares.
#[test]
fn rmsnorm_semantics() {
    let x = vec![3.0f32, 4.0];
    let w = vec![1.0f32, 1.0];
    let mut y = vec![0.0f32; 2];
    rmsnorm(&mut y, &x, &w, 2, 0.0);
    // mean sq = 12.5, inv = 1/sqrt(12.5)
    assert!((y[0] - 3.0 / 12.5f32.sqrt()).abs() < 1e-6);
    // l2norm uses the SUM of squares (25), not the mean
    let mut v = vec![3.0f32, 4.0];
    l2norm(&mut v, 0.0);
    assert!((v[0] - 0.6).abs() < 1e-6 && (v[1] - 0.8).abs() < 1e-6);
}

/// SiTU-GLU: the sigmoid sees the UNCAPPED gate.
#[test]
fn situ_glu_uncapped_sigmoid() {
    let n = 1usize;
    let (b1, b2) = (4.0f32, 25.0f32);
    let g = 50.0f32; // far beyond the tanh cap
    let u = 1.0f32;
    let x = vec![g, u];
    let mut y = vec![0.0f32; n];
    situ_glu(&mut y, &x, n, b1, b2);
    let want = b1 * (g / b1).tanh() * (1.0 / (1.0 + (-g).exp())) * (b2 * (u / b2).tanh());
    assert!((y[0] - want).abs() < 1e-6);
    // capped-sigmoid would give sigmoid(4.0) != sigmoid(50) — check we differ from it
    let wrong = b1 * (g / b1).tanh() * (1.0 / (1.0 + (-b1).exp())) * (b2 * (u / b2).tanh());
    assert!((y[0] - wrong).abs() > 1e-3);
}

/// The AVX2 dispatch must be invisible in output bits: compare the intrinsic
/// paths against the portable dot16/group kernels on random data.
#[cfg(target_arch = "x86_64")]
#[test]
fn avx2_paths_match_portable_bitwise() {
    if !crate::avx2::usable() {
        return;
    }
    let mut rng = Lcg(23);
    for &inn in &[16usize, 64, 100, 7168] {
        let rowf: Vec<f32> = (0..inn).map(|_| rng.f()).collect();
        let rowb: Vec<u16> = rowf.iter().map(|v| (v.to_bits() >> 16) as u16).collect();
        let x: Vec<f32> = (0..inn).map(|_| rng.f()).collect();
        let xd = crate::avx2::precast(&x);
        let scalar_f = dot16(|i| rowf[i] as f64, &x, inn);
        let scalar_b = dot16(|i| bf16f(rowb[i]) as f64, &x, inn);
        let avx_f = unsafe { crate::avx2::dot_f32_pre(&rowf, &xd, &x, inn) };
        let avx_b = unsafe { crate::avx2::dot_bf16_pre(&rowb, &xd, &x, inn) };
        assert_eq!(scalar_f.to_bits(), avx_f.to_bits(), "f32 dot diverged at inn={inn}");
        assert_eq!(scalar_b.to_bits(), avx_b.to_bits(), "bf16 dot diverged at inn={inn}");
    }
    // whole-matrix mxfp4: the dispatching kernel vs a forced-portable rebuild
    let (rows, inn, group) = (64usize, 128usize, 32usize);
    let packed: Vec<u8> = (0..rows * inn / 2).map(|_| (rng.next() & 0xFF) as u8).collect();
    let scales: Vec<u8> = (0..rows * inn / group).map(|_| (118 + rng.next() % 20) as u8).collect();
    let x: Vec<f32> = (0..inn).map(|_| rng.f()).collect();
    let mut via_dispatch = vec![0.0f32; rows];
    matmul_mxfp4(&mut via_dispatch, &x, &packed, &scales, inn, rows, group);
    // portable reference: group expansion + 8-lane tree, exactly ops.rs's fallback
    for r in 0..rows {
        let mut acc = 0.0f64;
        for g in 0..inn / group {
            let sb = scales[r * (inn / group) + g];
            if sb == 255 {
                continue;
            }
            let pb = &packed[r * inn / 2 + g * group / 2..];
            let xg = &x[g * group..];
            let mut wf = [0.0f64; 64];
            for j in 0..group / 2 {
                wf[2 * j] = E2M1[(pb[j] & 0x0F) as usize] as f64;
                wf[2 * j + 1] = E2M1[(pb[j] >> 4) as usize] as f64;
            }
            let mut s = [0.0f64; 8];
            let mut i = 0;
            while i + 7 < group {
                for l in 0..8 {
                    s[l] = wf[i + l].mul_add(xg[i + l] as f64, s[l]);
                }
                i += 8;
            }
            let sub = ((s[0] + s[4]) + (s[1] + s[5])) + ((s[2] + s[6]) + (s[3] + s[7]));
            acc += sub * e8m0(sb) as f64;
        }
        assert_eq!(
            via_dispatch[r].to_bits(),
            (acc as f32).to_bits(),
            "mxfp4 row {r} diverged"
        );
    }
}
