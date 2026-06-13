// SPDX-License-Identifier: MIT
//! Witness manifest shape and canonicaliser (stub).

use serde::{Deserialize, Serialize};

/// A single fix / artifact entry in the witness manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WitnessEntry {
    /// Stable id.
    pub id: String,
    /// What this entry describes.
    pub desc: String,
    /// File path or grep-marker that uniquely identifies the artifact.
    pub marker: String,
    /// sha256 of the marker target.
    pub sha256: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_serializes() {
        let e = WitnessEntry {
            id: "fix-x".into(),
            desc: "x".into(),
            marker: "src/x.rs".into(),
            sha256: "0".repeat(64),
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains("fix-x"));
    }
}
