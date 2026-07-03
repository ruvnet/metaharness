# Packaged executor genomes

Promoted cheap-tier executor operating policies, shipped with the `metaharness` CLI so
`metaharness learn --seed cand6` can seed a learning run from the current promoted base
(ADR-235 — cheap-tier optimization is a managed learning service).

## genome-promoted-cand6-edit-by-midpoint.json

- **Id:** `cand-6` (parent `cand-5`, mutation class `test_policy`) — promoted **2026-07-02**
  as the cheap code-repair executor base (ADR-228; model `z-ai/glm-5.2`, SWE-bench code-repair).
- **Primary behavioral change (generalized):** *edit-by-midpoint* — make at least one real
  code edit by the midpoint of the step budget; never end with an empty patch.
- **Honest holdout evidence:** unseen-holdout gold **2/12 → 3/12** (strict superset, zero
  regressions); holdout empty-patch rate **0.583 → 0.333** (the load-bearing win).
- **Not claimed:** the secondary rerun-thrash suppression did NOT generalize (holdout
  thrash 2 → 4). Kept in the policy, not claimed as an out-of-sample win.
- **Scope honesty:** this is a **positive screening signal**, below the pre-registered
  ≥10/24 "useful" bar — it funds confirmatory runs, it is not a headline capability claim.

Canonical source + full promotion record: `packages/darwin-mode/bench/swebench/gepa/`
(`genome-promoted-cand6-edit-by-midpoint.json`, `PROMOTION.md`) in the metaharness repo.
The frozen seed baseline (`seed-genome.json`) is never modified; comparisons always run
against it.
