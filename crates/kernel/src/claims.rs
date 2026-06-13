// SPDX-License-Identifier: MIT
//! Claims-based authorization (stub).

use serde::{Deserialize, Serialize};

/// A single capability claim.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claim {
    /// Capability name (e.g. `memory.read`).
    pub capability: String,
    /// Optional resource scope.
    pub resource: Option<String>,
    /// Unix-timestamp expiry.
    pub expires_at: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_serializes() {
        let c = Claim {
            capability: "memory.read".into(),
            resource: Some("ns/x".into()),
            expires_at: 0,
        };
        let s = serde_json::to_string(&c).unwrap();
        assert!(s.contains("memory.read"));
    }
}
