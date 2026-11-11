# 0.1.15 — 2026-11-10

Add an explicit production promotion mode: fresh independent paired suites, a fixed comparison-family alpha, and INCONCLUSIVE on missing or malformed evidence. Add durable pre-call hard budgets (`FileBudgetLimiter`, `InMemoryBudgetLimiter`) that charge failed and uncertain calls. Bind gate configuration, evaluator, corpora and budget history into signed receipts and replay. Fix sequential e-value overflow and underflow by working in log space, and give `withSequentialEvidence` a configuration-bearing fingerprint, so different alpha/lambda no longer share one gate identity.

Behaviour change: `metaharness flywheel run` now defaults to production mode. Existing CLI configs must set `promotionMode: 'research'` to keep the old behaviour. Library calls keep the research default.

# 0.1.13 — 2026-10-21

Bound canonicalization, reject non-finite signed numbers, clear failed proof claims, and reduce canonicalization allocations.

# Changelog
