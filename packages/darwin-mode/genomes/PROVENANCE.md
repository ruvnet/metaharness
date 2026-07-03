# Shipped genomes — provenance

## `genome-promoted-cand6-edit-by-midpoint.json` (cand-6)

- **What**: the first holdout-confirmed GEPA promotion of the cheap code-repair executor's
  operating policy (ADR-228). Byte-identical copy of
  `bench/swebench/gepa/genome-promoted-cand6-edit-by-midpoint.json`
  (sha256 `75f62961601c81ec7e3583966109d7244602c8bdcfa1ce0c2c200ccfab65fe5b`).
- **Promoted**: 2026-07-02 · parent `cand-5` · mutation class `test_policy` · cheap model `z-ai/glm-5.2`.
- **Evidence** (STRICT holdout rule — gold-no-regress AND empty-patch-improves AND cost/resolved-not-worse):
  unseen holdout gold 2/12 → 3/12 (strict superset, zero regressions); empty-patch rate 0.583 → 0.333.
- **Load-bearing mechanism**: *edit-by-midpoint* — if half the step budget is spent with no real
  source edit, make a best-guess edit anyway; empty patches are worse than imperfect patches.
- **Scope**: cheap-executor operating policy, NOT a model-capability claim.
- **Full record**: `bench/swebench/gepa/PROMOTION.md` in the repository
  (https://github.com/ruvnet/metaharness, `packages/darwin-mode/bench/swebench/gepa/`).
- **Use**: `import { loadCand6Genome, CAND6_GENOME_PATH } from '@metaharness/darwin/gepa'`.
