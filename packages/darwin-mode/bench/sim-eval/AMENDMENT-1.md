# Amendment 1 to `metaharness-523-sealed-sim-v1` → `metaharness-523-sealed-sim-v1a1`

**Registered:** 2026-11-20. Committed and pushed **before any source, calibration or target run**. At that point only the three pre-declared, excluded smoke runs existed: seed 900, gemini × `loc`, total spend $0.0264.
`PREREGISTRATION.md` is unchanged. This file overrides it only where stated below.

## Why: the smoke phase found a floor

In all three smoke runs (`off`, `full-in`, `retr-in`), every one of the 33 children scored exactly the baseline (finalScore 0.765, train 60%), so every winner was the baseline. That included 6 `contextBuilder` and 5 `retryPolicy` edits. The proposer is told only "task X unsolved (N attempts)" and the stock rule "pure refactor/tuning only", so it made behaviour-preserving refactors: renamed sets, capped backoff, reweighted the unused `scorePolicy`.

Under v1 every arm would therefore sit at baseline, making the null **built in** rather than measured. The smoke rows are kept in `results/raw-smoke.jsonl` and reported as a finding.

The $0 pipeline check that should have preceded registration was run after smoke. A scripted proposer applying a known edit inside unmodified `evolve()` (seed 1, live design) gives:

| benchmark | edit | winner train | winner held-out |
|---|---|---|---|
| `loc` | window 60 | 100% | 37.5% |
| `loc` | path-length tie-break | 100% | 100% |
| `per` | `maxAttempts` 8 plus retrying unknown | 100% | 100% |

So the pipeline registers improvements, and the floor comes from the uninformed proposer.

## Changes

1. **A fixed evaluation brief for every arm, `off` included.** `proposer.mjs` `EVAL_BRIEF` (sha256 `22d2a472f138f133ff0bb300c05b57c0b0cb8897317c76f9d312c892a0f17860`) is prepended to the stock user prompt.
   - It describes the mechanism the grader checks: plan has `verify`; the buggy file must be among `buildContext` items; the loop continues while `decideRetry(...).retry` and `attempt + 1 < maxAttempts`; and score is mostly the fraction solved.
   - It does **not** state a remedy, a tie-break, a window size, an attempt count, or anything about the held-out ranges or vocabulary. The system prompt and safety rules are unchanged.
2. **Seeds:** target seeds 1–**30** (was 1–10), fixed now, before any contrast is seen.
   - Reason: held-out moves in large discrete steps, and smoke measured about $0.009 per run, so 30 seeds × 29 runs per seed (about 870 runs) is projected at about $10–12, within the $40 cap.
   - Seeds are not added after results are seen.
3. **Calibration gate (new phase `calib`, excluded from analysis).** Before source or target, `off` only, all 4 model × benchmark cells, seeds 950–951 (8 runs).
   - **Gate:** in at least 5 of 8 runs the `off` winner beats the baseline on train, and for each benchmark the mean `off` held-out is above the baseline's held-out (`loc` 12.5%, `per` 31.3%) and below 95%.
   - **If the gate fails,** at most **one** further amendment is allowed, followed by a recalibration on new seeds. If that also fails, no source or target runs are made, and the floor or ceiling is reported as the result.
4. **Surface-match logging.** For every proposer call the runner logs whether the SIM context contains a record for the surface being edited (`proposer.simSurfaceMatch`).
   - Reason: Darwin queries SIM with the *parent's* surface, but the child's surface is picked afterwards (`pickSurface`), so this cannot be reconstructed later. It is reported per arm.
5. **Source-store integrity.** If a source lane is only partly built, its store is deleted and the whole lane is rebuilt from empty. The earlier rows are marked superseded. A lane is never resumed on top of partial records.

Everything else in `PREREGISTRATION.md` is unchanged: arms, partitions, grader, models, budgets, cap, metrics, statistics and verdict rules.
