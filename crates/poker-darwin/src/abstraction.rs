// SPDX-License-Identifier: MIT
//
// Information-set abstraction via ruvnet/ruvector (feature `ruvector`).
//
// Real poker has too many information sets to solve directly, so solvers group
// strategically-similar situations into "buckets" and solve the abstraction.
// This module featurizes each information set into a small vector and uses
// `ruvector-core`'s vector database (HNSW nearest-neighbour) to (a) retrieve the
// most similar information sets and (b) greedily cluster them into buckets,
// reporting the compression ratio. The same vector store doubles as an episodic
// memory of game situations (ruvector's stated use case).

use crate::cfr::{Solver, SolverConfig};
use crate::features::featurize;
use crate::games::LeducHoldem;
use ruvector_core::types::{DbOptions, DistanceMetric, SearchQuery, VectorEntry};
use ruvector_core::VectorDB;

/// A vector-DB-backed store of information sets for retrieval and clustering.
pub struct InfosetAbstractor {
    db: VectorDB,
    dim: usize,
    count: usize,
}

impl InfosetAbstractor {
    pub fn new(dim: usize) -> Result<Self, String> {
        let opts = DbOptions {
            dimensions: dim,
            distance_metric: DistanceMetric::Euclidean,
            ..Default::default()
        };
        let db = VectorDB::new(opts).map_err(|e| format!("ruvector init: {e:?}"))?;
        Ok(InfosetAbstractor { db, dim, count: 0 })
    }

    /// Store an information set under its key.
    pub fn insert(&mut self, key: &str, feat: &[f32]) -> Result<(), String> {
        assert_eq!(feat.len(), self.dim);
        self.db
            .insert(VectorEntry {
                id: Some(key.to_string()),
                vector: feat.to_vec(),
                metadata: None,
            })
            .map_err(|e| format!("ruvector insert: {e:?}"))?;
        self.count += 1;
        Ok(())
    }

    /// Return up to `k` nearest stored information sets as `(key, distance)`,
    /// nearest first (distance 0 = identical features).
    pub fn nearest(&self, feat: &[f32], k: usize) -> Result<Vec<(String, f32)>, String> {
        let res = self
            .db
            .search(SearchQuery {
                vector: feat.to_vec(),
                k,
                filter: None,
                ef_search: None,
            })
            .map_err(|e| format!("ruvector search: {e:?}"))?;
        Ok(res.into_iter().map(|r| (r.id, r.score)).collect())
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }
}

/// Greedily cluster `(key, feature)` pairs into buckets: a key joins the nearest
/// existing bucket centroid within `threshold`, else it starts a new bucket.
/// Returns `(num_buckets, assignments)`.
pub fn greedy_bucket(
    items: &[(String, Vec<f32>)],
    dim: usize,
    threshold: f32,
) -> Result<(usize, Vec<usize>), String> {
    let mut centroids = InfosetAbstractor::new(dim)?;
    let mut bucket_of: Vec<usize> = Vec::with_capacity(items.len());
    let mut next_bucket = 0usize;
    for (key, feat) in items {
        let nearest = centroids.nearest(feat, 1)?;
        match nearest.first() {
            Some((bkey, dist)) if *dist <= threshold => {
                // Bucket id is encoded in the centroid's stored key suffix.
                let id: usize = bkey
                    .rsplit('#')
                    .next()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                bucket_of.push(id);
            }
            _ => {
                centroids.insert(&format!("{key}#{next_bucket}"), feat)?;
                bucket_of.push(next_bucket);
                next_bucket += 1;
            }
        }
    }
    Ok((next_bucket, bucket_of))
}

/// CLI demo: solve Leduc, store every information set in ruvector, show a
/// nearest-neighbour retrieval, and report bucket compression.
pub fn demo(iters: u64, target_buckets: usize) {
    println!("== ruvector information-set abstraction (Leduc, {iters} CFR+ iters) ==");
    let mut solver = Solver::new(LeducHoldem::new(), SolverConfig::default());
    solver.train(iters);
    let avg = solver.average_strategy();

    let dim = 7;
    let mut items: Vec<(String, Vec<f32>)> =
        avg.keys().map(|k| (k.clone(), featurize(k))).collect();
    items.sort_by(|a, b| a.0.cmp(&b.0));

    // Build a retrieval index and demo a query.
    let mut abs = InfosetAbstractor::new(dim).expect("init");
    for (k, f) in &items {
        abs.insert(k, f).expect("insert");
    }
    println!(
        "stored {} information sets in ruvector (dim={dim})",
        abs.len()
    );

    if let Some((qk, qf)) = items
        .iter()
        .find(|(k, _)| k.starts_with("K|cr|"))
        .or_else(|| items.first())
    {
        println!("\nnearest neighbours of infoset {qk:?}:");
        for (k, d) in abs.nearest(qf, 5).expect("search") {
            println!("   dist {d:>7.3}  {k}");
        }
    }

    // Greedy bucketing: find the smallest threshold reaching <= target buckets.
    println!("\nbucket compression (target ~{target_buckets}):");
    for thr in [0.0_f32, 0.5, 1.0, 1.5, 2.0, 3.0] {
        let (n, _) = greedy_bucket(&items, dim, thr).expect("bucket");
        let ratio = 100.0 * (1.0 - n as f64 / items.len() as f64);
        println!("   threshold {thr:>4.1} -> {n:>3} buckets  ({ratio:>5.1}% compression)");
        if n <= target_buckets {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn featurize_distinguishes_card_and_board() {
        let a = featurize("J|cr|Q|c");
        let b = featurize("J|cr|K|c");
        assert_ne!(a, b, "different board ranks must differ");
        assert_eq!(a[0], 0.0); // card J
        assert_eq!(a[1], 1.0); // has board
    }

    #[test]
    fn abstractor_retrieves_identical_first() {
        let mut abs = InfosetAbstractor::new(7).unwrap();
        abs.insert("K|cr|Q|c", &featurize("K|cr|Q|c")).unwrap();
        abs.insert("J|c|-|", &featurize("J|c|-|")).unwrap();
        let q = featurize("K|cr|Q|c");
        let near = abs.nearest(&q, 1).unwrap();
        assert_eq!(near[0].0, "K|cr|Q|c");
        assert!(
            near[0].1 < 1e-3,
            "identical features should have ~0 distance"
        );
    }

    #[test]
    fn greedy_bucket_compresses() {
        let items: Vec<(String, Vec<f32>)> = ["J|c|-|", "J|cc|-|", "K|cr|Q|c", "K|cr|Q|cc"]
            .iter()
            .map(|k| (k.to_string(), featurize(k)))
            .collect();
        let (n, assign) = greedy_bucket(&items, 7, 2.0).unwrap();
        assert!(n <= items.len());
        assert_eq!(assign.len(), items.len());
    }
}
