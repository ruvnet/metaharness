//! Embedding normalization and the upstream similarity score.
//!
//! Exact port of the upstream comparison (`GetFeature.py` + demo glue,
//! ADR-0004): embeddings are L2-normalized, and the score maps the cosine
//! from `[-1, 1]` onto `[0, 100]`.

/// Faces match iff `similarity > MATCH_THRESHOLD` (strict, per upstream).
pub const MATCH_THRESHOLD: f32 = 75.0;

/// L2-normalizes `v` in place, matching `torch.nn.functional.normalize`:
/// `v / max(‖v‖, 1e-12)` (a zero vector stays zero instead of producing NaN).
pub fn l2_normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    let denom = norm.max(1e-12);
    for x in v.iter_mut() {
        *x /= denom;
    }
}

/// Similarity score of two L2-normalized embeddings:
/// `(Σ f1·f2 + 1) × 50`, i.e. 100 for identical, 50 for orthogonal, 0 for
/// opposite vectors.
pub fn similarity(f1: &[f32], f2: &[f32]) -> f32 {
    assert_eq!(f1.len(), f2.len(), "embedding length mismatch");
    let dot: f32 = f1.iter().zip(f2).map(|(a, b)| a * b).sum();
    (dot + 1.0) * 50.0
}

/// Upstream match verdict: strictly above [`MATCH_THRESHOLD`].
pub fn is_match(score: f32) -> bool {
    score > MATCH_THRESHOLD
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn similarity_endpoints() {
        let a = [1.0, 0.0, 0.0];
        let b = [-1.0, 0.0, 0.0];
        let c = [0.0, 1.0, 0.0];
        assert_eq!(similarity(&a, &a), 100.0); // dot 1 -> 100
        assert_eq!(similarity(&a, &b), 0.0); // dot -1 -> 0
        assert_eq!(similarity(&a, &c), 50.0); // orthogonal -> 50
    }

    #[test]
    fn l2_normalize_produces_unit_norm() {
        let mut v = [3.0, 4.0];
        l2_normalize(&mut v);
        assert!((v[0] - 0.6).abs() < 1e-6);
        assert!((v[1] - 0.8).abs() < 1e-6);
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-6);
    }

    #[test]
    fn l2_normalize_zero_vector_stays_finite() {
        let mut v = [0.0f32; 4];
        l2_normalize(&mut v);
        assert!(v.iter().all(|x| *x == 0.0));
    }

    #[test]
    fn match_threshold_is_strict() {
        assert!(!is_match(75.0));
        assert!(is_match(75.0 + 1e-3));
        assert!(!is_match(50.0));
        assert!(is_match(100.0));
    }

    #[test]
    fn normalized_similarity_stays_in_range() {
        let mut a = [0.3, -1.2, 0.5, 2.0];
        let mut b = [-0.7, 0.1, 1.5, -0.4];
        l2_normalize(&mut a);
        l2_normalize(&mut b);
        let s = similarity(&a, &b);
        assert!((0.0..=100.0).contains(&s), "score {s}");
    }
}
