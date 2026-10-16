# Darwin 0.11.0: bounded contrastive development

Adds an opt-in API for invariant/domain edits, measured composition, deduplicated probes, admission budgets and scoped experimental memory. Existing evolve behavior is unchanged.

Validation: 731 tests passed, 19 existing skips; TypeScript build; 47 adversarial tests; zero reported production dependency vulnerabilities; clean tarball install and public API execution.

Synthetic benchmark: baseline 25/100, composed candidate 100/100, sampling mean 71.125/100 across 32 seeds. Equal logical operation budget, not matched model cost. Parser executions reduced 64 to 32. Live provider smoke: three editor calls, $0.000190773, generated holdout 23 to 100/100. These are mechanism/integration results, not general LLM performance claims.

Receipts, source hashes and limitations are in docs/evidence/contrastive-0.11.0. Package entrypoint: @metaharness/darwin/contrastive. No new runtime dependencies or automatic promotion.
