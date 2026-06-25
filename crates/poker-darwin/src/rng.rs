// SPDX-License-Identifier: MIT
//
// A tiny, dependency-free, fully-deterministic PRNG (SplitMix64 seeding a
// xoshiro256** stream). The whole crate's stochastic behaviour — Darwin
// mutation, neural mini-batch sampling, Monte Carlo rollouts — funnels through
// this so every run is byte-reproducible from a single u64 seed. That property
// is what lets the tests assert exact champion receipts and lets benchmarks
// compare like-for-like across commits.

/// Deterministic xoshiro256** PRNG, seeded via SplitMix64.
#[derive(Clone, Debug)]
pub struct Rng {
    s: [u64; 4],
}

impl Rng {
    /// Construct from a 64-bit seed. Distinct seeds give independent streams.
    pub fn new(seed: u64) -> Self {
        // SplitMix64 to expand the seed into the 256-bit state.
        let mut z = seed;
        let mut next = || {
            z = z.wrapping_add(0x9E3779B97F4A7C15);
            let mut x = z;
            x = (x ^ (x >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
            x = (x ^ (x >> 27)).wrapping_mul(0x94D049BB133111EB);
            x ^ (x >> 31)
        };
        Rng {
            s: [next(), next(), next(), next()],
        }
    }

    #[inline]
    fn rotl(x: u64, k: u32) -> u64 {
        (x << k) | (x >> (64 - k))
    }

    /// Next raw u64 in the stream.
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = Self::rotl(self.s[1].wrapping_mul(5), 7).wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = Self::rotl(self.s[3], 45);
        result
    }

    /// Uniform f64 in [0, 1).
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        // 53 high bits → uniform in [0,1).
        (self.next_u64() >> 11) as f64 * (1.0 / (1u64 << 53) as f64)
    }

    /// Uniform usize in `[0, n)`. Panics if `n == 0`.
    #[inline]
    pub fn below(&mut self, n: usize) -> usize {
        assert!(n > 0, "Rng::below(0)");
        (self.next_f64() * n as f64) as usize % n
    }

    /// Return `true` with probability `p`.
    #[inline]
    pub fn chance(&mut self, p: f64) -> bool {
        self.next_f64() < p
    }

    /// Uniform f64 in `[lo, hi)`.
    #[inline]
    pub fn range_f64(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::Rng;

    #[test]
    fn deterministic_from_seed() {
        let a: Vec<u64> = (0..8)
            .map(|_| 0)
            .scan(Rng::new(42), |r, _| Some(r.next_u64()))
            .collect();
        let b: Vec<u64> = (0..8)
            .map(|_| 0)
            .scan(Rng::new(42), |r, _| Some(r.next_u64()))
            .collect();
        assert_eq!(a, b);
        let c: Vec<u64> = (0..8)
            .map(|_| 0)
            .scan(Rng::new(43), |r, _| Some(r.next_u64()))
            .collect();
        assert_ne!(a, c);
    }

    #[test]
    fn uniform_in_range() {
        let mut r = Rng::new(7);
        for _ in 0..10_000 {
            let x = r.next_f64();
            assert!((0.0..1.0).contains(&x));
            assert!(r.below(5) < 5);
        }
    }

    #[test]
    fn below_roughly_uniform() {
        let mut r = Rng::new(123);
        let mut counts = [0u32; 6];
        for _ in 0..60_000 {
            counts[r.below(6)] += 1;
        }
        // Each bucket should be near 10_000; allow generous slack.
        for c in counts {
            assert!((8_500..11_500).contains(&c), "bucket skew: {counts:?}");
        }
    }
}
