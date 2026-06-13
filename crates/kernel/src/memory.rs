// SPDX-License-Identifier: MIT
//! Memory bridge: store, search, decay-weight HNSW retrieval (stub).

use serde::{Deserialize, Serialize};

/// A search hit returned from the memory bridge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryHit {
    /// Memory entry id.
    pub id: String,
    /// Cosine similarity (0..1).
    pub score: f32,
    /// Decay-weighted score (per ADR-006 §AgenticClock).
    pub decayed_score: f32,
    /// Namespace the hit lives in.
    pub namespace: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hit_serializes() {
        let h = MemoryHit {
            id: "x".into(),
            score: 0.9,
            decayed_score: 0.85,
            namespace: "ns".into(),
        };
        let s = serde_json::to_string(&h).unwrap();
        assert!(s.contains("\"id\":\"x\""));
    }
}
