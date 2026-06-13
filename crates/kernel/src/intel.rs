// SPDX-License-Identifier: MIT
//! Intelligence pipeline (stub).

use serde::{Deserialize, Serialize};

/// One phase of the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    /// Retrieve k=1 (per ReasoningBank finding).
    Retrieve,
    /// LLM-as-judge.
    Judge,
    /// Extract strategies.
    Distill,
    /// EWC++-style consolidation.
    Consolidate,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_serializes() {
        assert_eq!(
            serde_json::to_string(&Phase::Distill).unwrap(),
            "\"Distill\""
        );
    }
}
