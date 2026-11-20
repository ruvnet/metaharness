# Amendment 2 (final permitted revision) → `metaharness-523-sealed-sim-v1a2`

**Registered:** 2026-11-20, committed and pushed **before any source or target run** and before the recalibration. `PREREGISTRATION.md` and `AMENDMENT-1.md` are unchanged; this file overrides them only where stated.

## Why: the amendment-1 calibration gate failed

Calibration ran `off` only, on seeds 950–951, across all 4 cells: 8 runs, $0.061. Rows are in `results/raw-calib.jsonl`, excluded from analysis.

| criterion | gate | result |
|---|---|---|
| runs where the winner beat baseline on train | at least 5 of 8 | 1 of 8 (`gpt-4.1-nano` × `per`, seed 951: retried `unknown`; train 100%, held-out 37.5%) |
| `loc` held-out | above baseline | 12.5% in every run, equal to baseline |

With the brief, proposals now change behaviour: they rewrite scoring, retry branches and plan steps. They do not touch the actual bottleneck, because Darwin's failure line per task (`summarizeFailedTraces`, last line of stderr) is only `task X unsolved (N attempts)`. The proposer cannot see why a task failed: whether the file was out of the context window, or the loop stopped retrying.

## Change

**Failed train task details.** For each failure line Darwin passes to the proposer (at most 5), the proposer appends the definition of that **train** task:

- its prompt and the number of candidate files;
- the buggy file's input position;
- how many attempts it fails first, and its classification.

Implementation: `proposer.mjs` `failedTaskDetails`, given only `partitions[bench].train`.

- **Sealing.** Ids outside the train partition are ignored, so a held-out task can never be described (tested). This is optimizer-visible information by construction, since train tasks are the tasks `evolve()` scores. It corresponds to an optimizer reading its own failing test.
- **Equal treatment.** It is identical for every arm, `off` included.
- **What it omits.** It states no remedy and nothing about held-out ranges or vocabulary.

## Recalibration

- **Seeds:** new seeds 960–961, `off` only, all 4 cells. The amendment-1 gate is unchanged.
- **If it fails:** per amendment 1, no further revision is allowed. No source or target runs are made, and the result is reported as a floor or ceiling of this substrate with this proposer.
- **If it passes:** source, then target, run exactly as registered, with 30 target seeds.
