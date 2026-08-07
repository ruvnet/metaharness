//! AVX2+FMA fast paths, ported intrinsic-for-intrinsic from the (patched)
//! C engine's k3_ops.c kernels. Each path reproduces the portable kernel's
//! accumulator partition and reduction tree EXACTLY — `_mm256_fmadd_pd` per
//! lane is the same IEEE operation as scalar `f64::mul_add` — so runtime
//! dispatch is invisible in the output bits (asserted by tests::avx2_*).
//!
//! Techniques carried over from the verified upstream patches:
//!   - x precast to f64 once per matmul call (exact; kills per-row cvt traffic)
//!   - batched bf16 widening: one 128-bit load + one 256-bit widen/shift per 8
//!   - register-only MXFP4 nibble decode: two pshufb lookups rebuild the exact
//!     f32 bit patterns (bytes 0-1 of every E2M1 pattern are zero), no wf[]
//!     stack round-trip, including -0.0 for code 8.
#![cfg(target_arch = "x86_64")]

use crate::ops::E2M1;
use std::arch::x86_64::*;
use std::sync::OnceLock;

pub fn usable() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma"))
}

/// Bytes 2 and 3 of each E2M1 code's f32 bit pattern, built from E2M1 itself so
/// they cannot drift from the scalar table.
fn luts() -> &'static ([u8; 16], [u8; 16]) {
    static L: OnceLock<([u8; 16], [u8; 16])> = OnceLock::new();
    L.get_or_init(|| {
        let mut b2 = [0u8; 16];
        let mut b3 = [0u8; 16];
        for c in 0..16 {
            let bits = E2M1[c].to_bits();
            b2[c] = (bits >> 16) as u8;
            b3[c] = (bits >> 24) as u8;
        }
        (b2, b3)
    })
}

/// f64 mirror of the byte -> (even, odd) E2M1 pair table for the scalar tail.
fn pair_d() -> &'static [[f64; 2]; 256] {
    static P: OnceLock<[[f64; 2]; 256]> = OnceLock::new();
    P.get_or_init(|| {
        let mut t = [[0.0f64; 2]; 256];
        for b in 0..256 {
            t[b][0] = E2M1[b & 0x0F] as f64;
            t[b][1] = E2M1[b >> 4] as f64;
        }
        t
    })
}

/// Exact f32 -> f64 precast of x, shared by every row of one matmul call.
pub fn precast(x: &[f32]) -> Vec<f64> {
    x.iter().map(|&v| v as f64).collect()
}

#[inline]
unsafe fn reduce4(v0: __m256d, v1: __m256d, v2: __m256d, v3: __m256d) -> f64 {
    // (v0+v1)+(v2+v3) lanewise, then (a0+a1)+(a2+a3): the identical tree the
    // portable dot16 uses ((a_l + a_{l+4}) + (a_{l+8} + a_{l+12}) per lane).
    let vt = _mm256_add_pd(_mm256_add_pd(v0, v1), _mm256_add_pd(v2, v3));
    let mut a = [0.0f64; 4];
    _mm256_storeu_pd(a.as_mut_ptr(), vt);
    (a[0] + a[1]) + (a[2] + a[3])
}

/// fp32-row dot, 16 elements per iteration into four f64 fma lanes.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn dot_f32_pre(row: &[f32], xd: &[f64], x: &[f32], inn: usize) -> f32 {
    let rp = row.as_ptr();
    let xp = xd.as_ptr();
    let mut v0 = _mm256_setzero_pd();
    let mut v1 = _mm256_setzero_pd();
    let mut v2 = _mm256_setzero_pd();
    let mut v3 = _mm256_setzero_pd();
    let mut i = 0usize;
    while i + 15 < inn {
        v0 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm_loadu_ps(rp.add(i))), _mm256_loadu_pd(xp.add(i)), v0);
        v1 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm_loadu_ps(rp.add(i + 4))), _mm256_loadu_pd(xp.add(i + 4)), v1);
        v2 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm_loadu_ps(rp.add(i + 8))), _mm256_loadu_pd(xp.add(i + 8)), v2);
        v3 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm_loadu_ps(rp.add(i + 12))), _mm256_loadu_pd(xp.add(i + 12)), v3);
        i += 16;
    }
    let mut acc = reduce4(v0, v1, v2, v3);
    while i < inn {
        acc = (row[i] as f64).mul_add(x[i] as f64, acc);
        i += 1;
    }
    acc as f32
}

/// bf16-row dot: 8 bf16 widened per 128-bit load (u16 -> u32 -> <<16), halves
/// split back to the same four f64 fma lanes as the scalar tree.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn dot_bf16_pre(row: &[u16], xd: &[f64], x: &[f32], inn: usize) -> f32 {
    let rp = row.as_ptr();
    let xp = xd.as_ptr();
    let mut v0 = _mm256_setzero_pd();
    let mut v1 = _mm256_setzero_pd();
    let mut v2 = _mm256_setzero_pd();
    let mut v3 = _mm256_setzero_pd();
    let mut i = 0usize;
    while i + 15 < inn {
        let h01 = _mm_loadu_si128(rp.add(i) as *const __m128i);
        let h23 = _mm_loadu_si128(rp.add(i + 8) as *const __m128i);
        let w01 = _mm256_castsi256_ps(_mm256_slli_epi32(_mm256_cvtepu16_epi32(h01), 16));
        let w23 = _mm256_castsi256_ps(_mm256_slli_epi32(_mm256_cvtepu16_epi32(h23), 16));
        v0 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm256_castps256_ps128(w01)), _mm256_loadu_pd(xp.add(i)), v0);
        v1 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm256_extractf128_ps(w01, 1)), _mm256_loadu_pd(xp.add(i + 4)), v1);
        v2 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm256_castps256_ps128(w23)), _mm256_loadu_pd(xp.add(i + 8)), v2);
        v3 = _mm256_fmadd_pd(_mm256_cvtps_pd(_mm256_extractf128_ps(w23, 1)), _mm256_loadu_pd(xp.add(i + 12)), v3);
        i += 16;
    }
    let mut acc = reduce4(v0, v1, v2, v3);
    while i < inn {
        acc = (crate::st::bf16f(row[i]) as f64).mul_add(x[i] as f64, acc);
        i += 1;
    }
    acc as f32
}


/// One whole MXFP4 row: LUTs loaded ONCE, groups looped inside the
/// target_feature region, per-group scale from the shared E8M0 table. The
/// arithmetic per group is identical to `mxfp4_group` (same lanes, same tree),
/// so output bits are unchanged — this exists purely to hoist the invariant
/// loads out of the 100+ group iterations a real row makes.
#[target_feature(enable = "avx2,fma")]
pub unsafe fn mxfp4_row(
    pr: &[u8],
    sr: &[u8],
    xd: &[f64],
    x: &[f32],
    inn: usize,
    group: usize,
) -> f32 {
    let (b2, b3) = luts();
    let m0f = _mm_set1_epi8(0x0F);
    let lut2 = _mm256_broadcastsi128_si256(_mm_loadu_si128(b2.as_ptr() as *const __m128i));
    let lut3 = _mm256_broadcastsi128_si256(_mm_loadu_si128(b3.as_ptr() as *const __m128i));
    let pd = pair_d();
    let ngrp = (inn + group - 1) / group;
    let gbyte = group / 2;
    let pp = pr.as_ptr();
    let xp = xd.as_ptr();
    let mut acc = 0.0f64;
    for g in 0..ngrp {
        let sb = sr[g];
        if sb == 255 {
            continue;
        }
        let base = g * group;
        let n = (inn - base).min(group);
        let pb = pp.add(g * gbyte);
        let mut v0 = _mm256_setzero_pd();
        let mut v1 = _mm256_setzero_pd();
        let mut i = 0usize;
        while i + 7 < n {
            let pk = (pb.add(i >> 1) as *const u32).read_unaligned();
            let by = _mm_cvtsi32_si128(pk as i32);
            let lo_n = _mm_and_si128(by, m0f);
            let hi_n = _mm_and_si128(_mm_srli_epi16::<4>(by), m0f);
            let idx = _mm256_cvtepu8_epi32(_mm_unpacklo_epi8(lo_n, hi_n));
            let w32 = _mm256_or_si256(
                _mm256_slli_epi32::<24>(_mm256_shuffle_epi8(lut3, idx)),
                _mm256_slli_epi32::<16>(_mm256_shuffle_epi8(lut2, idx)),
            );
            let wps = _mm256_castsi256_ps(w32);
            v0 = _mm256_fmadd_pd(
                _mm256_cvtps_pd(_mm256_castps256_ps128(wps)),
                _mm256_loadu_pd(xp.add(base + i)),
                v0,
            );
            v1 = _mm256_fmadd_pd(
                _mm256_cvtps_pd(_mm256_extractf128_ps(wps, 1)),
                _mm256_loadu_pd(xp.add(base + i + 4)),
                v1,
            );
            i += 8;
        }
        let vt = _mm256_add_pd(v0, v1);
        let mut a = [0.0f64; 4];
        _mm256_storeu_pd(a.as_mut_ptr(), vt);
        let mut sub = (a[0] + a[1]) + (a[2] + a[3]);
        while i < n {
            let byte = *pb.add(i >> 1);
            sub = pd[byte as usize][i & 1].mul_add(x[base + i] as f64, sub);
            i += 1;
        }
        acc += sub * crate::ops::e8m0(sb) as f64;
    }
    acc as f32
}

