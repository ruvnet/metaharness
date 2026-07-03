# GEPA Promotion Record — cand-6 (ADR-228)

**Genome:** `genome-promoted-cand6-edit-by-midpoint.json` (base name: `cheap-code-repair-base-cand6-edit-by-midpoint`)
**Date:** 2026-07-02 · **Parent:** cand-5 · **Mutation class:** `test_policy` · **Cheap model:** `z-ai/glm-5.2`
**Verdict:** **PROMOTE** (holdout delta > 0, zero regressions) — *positive screening signal, not a headline win (see §Scope).*

The frozen seed (`seed-genome.json`, `seed-agentic-v1`) is **NOT modified** — it stays the immutable baseline for all future comparisons. cand-6 becomes the promoted *production base* for the cheap code-repair executor.

---

## The precise record (per the promotion spec)

1. **cand-6 promoted** as the cheap code-repair executor base.
2. **Effect size:** **+1/12 on the unseen holdout** (2/12 → 3/12); +2/12 on train (3/12 → 5/12); +3/24 on the combined medium-24 view (5/24 → 8/24).
3. **Zero regressions** — cand-6 solved a **strict superset** of the seed's resolved set on both train and holdout.
4. **Mutation class is `test_policy`.**
5. **Primary behavioral change: forced edit by midpoint** — confirmed generalized (holdout empty-patch rate **0.583 → 0.333**).
6. **Secondary behavioral change: rerun-thrash suppression** — **did NOT generalize** (holdout thrash 2 → 4; the aggregate 8→6 was entirely the train half). Kept in the policy (net effect positive) but **not claimed** as an out-of-sample win; remains a separate optimization target.
7. **Promotion scope = cheap-executor operating policy, NOT a model-capability claim.** The model is unchanged (glm-5.2); only its standing operating contract changed.

---

## Why this is the right abstraction layer (ADR-226 → ADR-228)

ADR-226 proved a read-only strong advisor does **not** lift the cheap executor — the weak actor still has to convert advice into action, and it can't (D-advisor 3/24 = solo baseline; only the cascade where the frontier *acts* lifted it to 9/24). GEPA changes the **layer of intervention**: it rewrites the executor's operating policy *before* the run, so there is no advice-to-action conversion step. cand-6 is the first proof that this transfers on unseen data.

---

## Reusable executor-policy primitives (extracted from the mutation)

### Edit-by-midpoint rule  *(the load-bearing, generalized mechanism)*
```text
If the task budget is half consumed and no real source edit has been made,
choose the best supported source file from traceback, failing test, or recent
reads, then make a minimal best-guess code edit. Empty patches are worse than
imperfect patches.
```

### No-rerun-thrash rule  *(train-only; unproven on holdout — do not over-claim)*
```text
After two identical failing test runs, do not run the same test again until code
logic has changed. Re-read the traceback, inspect the touched function, change
the suspected logic, then test.
```

---

## Acceptance test — medium-24 (computed $0 from persisted gold-scored artifacts)

| Criterion | Result | Verdict |
|---|---|---|
| Zero / near-zero regressions | 0 regressions (strict superset) | ✅ |
| Beat seed by ≥ 2/24 | +3/24 (5→8); clean holdout +1/12 | ✅ |
| Reduce empty-patch rate | **holdout 0.583 → 0.333** (clean); aggregate 0.375 → 0.208 | ✅ (generalized) |
| Reduce repeated test reruns | holdout **2 → 4** (did NOT generalize); aggregate 8→6 was train-only | ❌ (not claimed) |
| Cost/resolved below cascade | $0.121 < $0.324 | ✅ |

**Honest framing:** the medium-24 aggregate mixes the in-sample train half (where cand-6 was *selected*) with the clean out-of-sample holdout. The load-bearing claim rests on the **holdout** column only.

---

## Corroboration & non-promotions

- **Replicated:** a second, independent `test_policy` mutation (**cand-12**) also reached 5/12 on train — the lift is attributable to the `test_policy` axis, not a single lucky draw. cand-6 stays mean-best (sum 57.7 vs 52.7).
- **cand-14 (6/12 train) NOT promoted:** it mutated `retrieval_policy` — a component that regressed in all 6 other candidates that touched it — is unreplicated, unverified on holdout, and likely partly GLM provider-side noise. Train-leader ≠ promotable.

## Scope / caveat

cand-6's holdout gold **3/12 (~6/24-equiv) is BELOW the pre-registered ≥10/24 "useful" bar.** This is a **positive screening signal** — a GEPA-evolved genome component beats the frozen seed on unseen data — that **funds a confirmatory run**, not a headline capability claim. The promoted claim is deliberately narrow: *reduces empty patches on holdout*.

## Provenance
- Seed (frozen): `seed-genome.json` · Promoted genome: `genome-promoted-cand6-edit-by-midpoint.json` (= `runs/genome-07-cand-6.json`)
- Evidence: `runs/eval-01-seed-agentic-v1.json`, `runs/eval-07-cand-6.json`, `runs/holdout-01-seed.json`, `runs/holdout-02-cand6.json`, `runs/holdout-report.json`, `runs/medium24-report.json`
- All rollouts glm-5.2, maxSteps 12, gold-scored via the real SWE-bench Docker harness.
