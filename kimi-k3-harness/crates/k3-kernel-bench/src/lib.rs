//! Block-quantized int8 matvec — the memory-bound inner loop that dominates
//! kimi-k3-in-c's s/token. Weights are q8 in blocks of 32 with an f32 scale per
//! (row, block); activations are q8 with an f32 scale per block. The integer
//! dot inside a block is exact; only the f32 scale-accumulation order differs
//! between kernel variants, so cross-variant correctness is checked against a
//! f64 golden reference with a relative tolerance.
//!
//! Levers (each monomorphized so codegen really differs):
//!   kernel: 0 = scalar, 1 = simd128
//!   unroll: blocks per inner iteration (1 | 2 | 4)
//!   accs:   independent accumulator chains (1 | 2 | 4)

const BLOCK: usize = 32;

static mut ROWS: usize = 0;
static mut COLS: usize = 0;
static mut W: Vec<i8> = Vec::new();
static mut WSCALE: Vec<f32> = Vec::new();
static mut X: Vec<i8> = Vec::new();
static mut XSCALE: Vec<f32> = Vec::new();
static mut Y: Vec<f32> = Vec::new();

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }
    fn i8(&mut self) -> i8 {
        (self.next() % 255) as i16 as i8
    }
    fn scale(&mut self) -> f32 {
        ((self.next() % 900) + 100) as f32 * 1e-4
    }
}

/// Fill the static buffers with deterministic data for a rows×cols matvec.
#[no_mangle]
pub extern "C" fn setup(rows: u32, cols: u32, seed: u32) {
    let (rows, cols) = (rows as usize, cols as usize);
    assert!(cols % BLOCK == 0, "cols must be a multiple of {BLOCK}");
    let nblocks = cols / BLOCK;
    let mut rng = Lcg(seed as u64 | 0x9e3779b97f4a7c15);
    unsafe {
        ROWS = rows;
        COLS = cols;
        W = (0..rows * cols).map(|_| rng.i8()).collect();
        WSCALE = (0..rows * nblocks).map(|_| rng.scale()).collect();
        X = (0..cols).map(|_| rng.i8()).collect();
        XSCALE = (0..nblocks).map(|_| rng.scale()).collect();
        Y = vec![0.0; rows];
    }
}

#[inline(always)]
fn block_dot_scalar(w: &[i8], x: &[i8]) -> i32 {
    let mut acc = 0i32;
    for i in 0..BLOCK {
        acc += w[i] as i32 * x[i] as i32;
    }
    acc
}

fn row_scalar<const UNROLL: usize, const ACCS: usize>(
    w: &[i8],
    ws: &[f32],
    x: &[i8],
    xs: &[f32],
) -> f32 {
    let nblocks = ws.len();
    let mut parts = [0.0f32; ACCS];
    let mut b = 0;
    while b + UNROLL <= nblocks {
        // UNROLL independent block dots per iteration; the compiler sees the
        // constant trip count and flattens it.
        for u in 0..UNROLL {
            let blk = b + u;
            let d = block_dot_scalar(&w[blk * BLOCK..], &x[blk * BLOCK..]);
            parts[blk % ACCS] += d as f32 * ws[blk] * xs[blk];
        }
        b += UNROLL;
    }
    while b < nblocks {
        let d = block_dot_scalar(&w[b * BLOCK..], &x[b * BLOCK..]);
        parts[b % ACCS] += d as f32 * ws[b] * xs[b];
        b += 1;
    }
    parts.iter().sum()
}

#[cfg(target_arch = "wasm32")]
mod simd {
    use super::BLOCK;
    use core::arch::wasm32::*;

    /// Exact i32 dot of one 32-element q8 block using i16x8 widening dots.
    #[inline]
    #[target_feature(enable = "simd128")]
    unsafe fn block_dot(w: *const i8, x: *const i8) -> i32 {
        let mut acc = i32x4_splat(0);
        let mut off = 0;
        while off < BLOCK {
            let wv = v128_load(w.add(off) as *const v128);
            let xv = v128_load(x.add(off) as *const v128);
            let wl = i16x8_extend_low_i8x16(wv);
            let wh = i16x8_extend_high_i8x16(wv);
            let xl = i16x8_extend_low_i8x16(xv);
            let xh = i16x8_extend_high_i8x16(xv);
            acc = i32x4_add(acc, i32x4_dot_i16x8(wl, xl));
            acc = i32x4_add(acc, i32x4_dot_i16x8(wh, xh));
            off += 16;
        }
        i32x4_extract_lane::<0>(acc)
            + i32x4_extract_lane::<1>(acc)
            + i32x4_extract_lane::<2>(acc)
            + i32x4_extract_lane::<3>(acc)
    }

    #[target_feature(enable = "simd128")]
    pub unsafe fn row<const UNROLL: usize, const ACCS: usize>(
        w: &[i8],
        ws: &[f32],
        x: &[i8],
        xs: &[f32],
    ) -> f32 {
        let nblocks = ws.len();
        let mut parts = [0.0f32; ACCS];
        let mut b = 0;
        while b + UNROLL <= nblocks {
            for u in 0..UNROLL {
                let blk = b + u;
                let d = block_dot(w.as_ptr().add(blk * BLOCK), x.as_ptr().add(blk * BLOCK));
                parts[blk % ACCS] += d as f32 * ws[blk] * xs[blk];
            }
            b += UNROLL;
        }
        while b < nblocks {
            let d = block_dot(w.as_ptr().add(b * BLOCK), x.as_ptr().add(b * BLOCK));
            parts[b % ACCS] += d as f32 * ws[b] * xs[b];
            b += 1;
        }
        parts.iter().sum()
    }
}

fn dispatch(kernel: u32, unroll: u32, accs: u32) -> f64 {
    let (rows, cols) = unsafe { (ROWS, COLS) };
    let nblocks = cols / BLOCK;
    let (w, ws, x, xs, y) = unsafe {
        (
            &W[..],
            &WSCALE[..],
            &X[..],
            &XSCALE[..],
            &mut Y[..],
        )
    };
    let mut checksum = 0.0f64;
    for r in 0..rows {
        let wrow = &w[r * cols..(r + 1) * cols];
        let wsrow = &ws[r * nblocks..(r + 1) * nblocks];
        let v = match (kernel, unroll, accs) {
            (0, 1, 1) => row_scalar::<1, 1>(wrow, wsrow, x, xs),
            (0, 1, 2) => row_scalar::<1, 2>(wrow, wsrow, x, xs),
            (0, 1, 4) => row_scalar::<1, 4>(wrow, wsrow, x, xs),
            (0, 2, 1) => row_scalar::<2, 1>(wrow, wsrow, x, xs),
            (0, 2, 2) => row_scalar::<2, 2>(wrow, wsrow, x, xs),
            (0, 2, 4) => row_scalar::<2, 4>(wrow, wsrow, x, xs),
            (0, 4, 1) => row_scalar::<4, 1>(wrow, wsrow, x, xs),
            (0, 4, 2) => row_scalar::<4, 2>(wrow, wsrow, x, xs),
            (0, 4, 4) => row_scalar::<4, 4>(wrow, wsrow, x, xs),
            #[cfg(target_arch = "wasm32")]
            (1, 1, 1) => unsafe { simd::row::<1, 1>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 1, 2) => unsafe { simd::row::<1, 2>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 1, 4) => unsafe { simd::row::<1, 4>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 2, 1) => unsafe { simd::row::<2, 1>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 2, 2) => unsafe { simd::row::<2, 2>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 2, 4) => unsafe { simd::row::<2, 4>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 4, 1) => unsafe { simd::row::<4, 1>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 4, 2) => unsafe { simd::row::<4, 2>(wrow, wsrow, x, xs) },
            #[cfg(target_arch = "wasm32")]
            (1, 4, 4) => unsafe { simd::row::<4, 4>(wrow, wsrow, x, xs) },
            _ => panic!("unsupported lever combination"),
        };
        y[r] = v;
        checksum += v as f64;
    }
    checksum
}

/// One full matvec pass with the given levers. Returns the y checksum.
#[no_mangle]
pub extern "C" fn matvec(kernel: u32, unroll: u32, accs: u32) -> f64 {
    dispatch(kernel, unroll, accs)
}

/// f64 golden reference in canonical order — exact integer block dots,
/// f64 scale accumulation. Variant checksums must match this within reltol.
#[no_mangle]
pub extern "C" fn golden() -> f64 {
    let (rows, cols) = unsafe { (ROWS, COLS) };
    let nblocks = cols / BLOCK;
    let (w, ws, x, xs) = unsafe { (&W[..], &WSCALE[..], &X[..], &XSCALE[..]) };
    let mut checksum = 0.0f64;
    for r in 0..rows {
        let mut acc = 0.0f64;
        for b in 0..nblocks {
            let d = block_dot_scalar(&w[r * cols + b * BLOCK..], &x[b * BLOCK..]);
            acc += d as f64 * ws[r * nblocks + b] as f64 * xs[b] as f64;
        }
        checksum += acc;
    }
    checksum
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variants_agree_with_golden() {
        setup(64, 512, 7);
        let gold = golden();
        for unroll in [1u32, 2, 4] {
            for accs in [1u32, 2, 4] {
                let c = matvec(0, unroll, accs);
                let rel = ((c - gold) / gold).abs();
                assert!(rel < 1e-3, "scalar u{unroll} a{accs}: rel err {rel}");
            }
        }
    }
}
