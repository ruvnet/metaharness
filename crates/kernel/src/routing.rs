// SPDX-License-Identifier: MIT
//! 3-tier routing decision (stub).

use serde::{Deserialize, Serialize};

/// Routing tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Tier {
    /// Deterministic codemod / inline.
    Codemod,
    /// Small model (Haiku-class).
    Small,
    /// Frontier model (Sonnet/Opus-class).
    Frontier,
}

/// Routing decision for a single task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingDecision {
    /// Chosen tier.
    pub tier: Tier,
    /// One-line rationale.
    pub rationale: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_round_trips() {
        let d = RoutingDecision {
            tier: Tier::Small,
            rationale: "trivial".into(),
        };
        let s = serde_json::to_string(&d).unwrap();
        let back: RoutingDecision = serde_json::from_str(&s).unwrap();
        assert_eq!(back.tier, Tier::Small);
    }
}
