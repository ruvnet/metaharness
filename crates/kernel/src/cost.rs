// SPDX-License-Identifier: MIT
//
// Cost tracking subsystem.
//
// Records per-call cost into per-tier rolling totals and provides a
// budget-check predicate so harnesses can guardrail spend. The kernel
// only stores the totals; persistence (writing to disk, syncing to
// telemetry, etc.) is the host's job.

//! Per-call cost tracking + budget guardrails.

use crate::routing::Tier;
use serde::{Deserialize, Serialize};

/// One cost event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CostEvent {
    /// Routing tier the call ran on.
    pub tier: Tier,
    /// Cost in USD.
    pub cost_usd: f64,
    /// Latency in milliseconds.
    pub latency_ms: u32,
    /// Did the call succeed?
    pub success: bool,
    /// Unix-second timestamp.
    pub timestamp: i64,
}

/// Rolling totals.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CostTotals {
    pub total_usd: f64,
    pub call_count: u64,
    pub success_count: u64,
    pub fail_count: u64,
    /// Per-tier breakdown.
    pub codemod_usd: f64,
    pub small_usd: f64,
    pub frontier_usd: f64,
}

impl CostTotals {
    pub fn record(&mut self, event: &CostEvent) {
        self.total_usd += event.cost_usd;
        self.call_count += 1;
        if event.success {
            self.success_count += 1;
        } else {
            self.fail_count += 1;
        }
        match event.tier {
            Tier::Codemod => self.codemod_usd += event.cost_usd,
            Tier::Small => self.small_usd += event.cost_usd,
            Tier::Frontier => self.frontier_usd += event.cost_usd,
        }
    }

    pub fn success_rate(&self) -> f64 {
        if self.call_count == 0 { return 0.0; }
        self.success_count as f64 / self.call_count as f64
    }

    pub fn avg_cost(&self) -> f64 {
        if self.call_count == 0 { return 0.0; }
        self.total_usd / self.call_count as f64
    }
}

/// Budget guardrail. Returns Ok(()) when under budget; Err with remaining
/// budget when over.
pub fn check_budget(totals: &CostTotals, budget_usd: f64) -> Result<f64, f64> {
    let remaining = budget_usd - totals.total_usd;
    if remaining >= 0.0 { Ok(remaining) } else { Err(remaining) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(tier: Tier, usd: f64, success: bool) -> CostEvent {
        CostEvent { tier, cost_usd: usd, latency_ms: 100, success, timestamp: 0 }
    }

    #[test]
    fn record_accumulates_per_tier() {
        let mut t = CostTotals::default();
        t.record(&ev(Tier::Codemod, 0.0, true));
        t.record(&ev(Tier::Small, 0.0002, true));
        t.record(&ev(Tier::Frontier, 0.01, true));
        assert!((t.total_usd - 0.0102).abs() < 1e-9);
        assert_eq!(t.codemod_usd, 0.0);
        assert!((t.small_usd - 0.0002).abs() < 1e-9);
        assert!((t.frontier_usd - 0.01).abs() < 1e-9);
        assert_eq!(t.call_count, 3);
        assert_eq!(t.success_count, 3);
    }

    #[test]
    fn success_rate_zero_calls() {
        assert_eq!(CostTotals::default().success_rate(), 0.0);
    }

    #[test]
    fn success_rate_after_calls() {
        let mut t = CostTotals::default();
        t.record(&ev(Tier::Small, 0.0001, true));
        t.record(&ev(Tier::Small, 0.0001, false));
        assert!((t.success_rate() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn check_budget_ok() {
        let mut t = CostTotals::default();
        t.record(&ev(Tier::Frontier, 0.50, true));
        assert!(matches!(check_budget(&t, 1.0), Ok(rem) if (rem - 0.5).abs() < 1e-9));
    }

    #[test]
    fn check_budget_over() {
        let mut t = CostTotals::default();
        t.record(&ev(Tier::Frontier, 1.50, true));
        assert!(matches!(check_budget(&t, 1.0), Err(rem) if (rem + 0.5).abs() < 1e-9));
    }

    #[test]
    fn avg_cost_correct() {
        let mut t = CostTotals::default();
        t.record(&ev(Tier::Small, 0.001, true));
        t.record(&ev(Tier::Small, 0.003, true));
        assert!((t.avg_cost() - 0.002).abs() < 1e-9);
    }
}
