# Pre-registration v2: sealed SIM evaluation with a qualified proposer (#523)

**ID:** `metaharness-523-sealed-sim-v2`
**Registered:** 2026-11-20. Committed and pushed **before any v2 paid call**: no v2 calibration, source or target run existed when this file was pushed.
**Relation to v1:** study v1 (`PREREGISTRATION.md`, plus `AMENDMENT-1.md` and `AMENDMENT-2.md`) closed at its calibration gate with **no source or target run**, so **no SIM contrast has been observed by anyone**. v2 is a new, separately registered study. It is not a third amendment. The v1 closure is reported first in `RESULTS.md`, regardless of how v2 turns out.

`PREREGISTRATION.md` applies unchanged except where this file says otherwise. Unchanged parts:

- substrate and grader, frozen partitions (sha256 `7ebe5ff7…7582`) and sealing;
- the 7 arms plus the poison probe, the source/target structure (3 source seeds per cell);
- the evaluation brief (`EVAL_BRIEF`, sha256 `22d2a472…7860`) and the failed-train-task details from amendment 2;
- evolve budgets: 6 generations × 3 children, `generation` pool, `promotionDelta` 0.01, 33 proposals per run;
- metrics, statistics, verdict rules, and the $40 hard cap.

## Why v2: the v1 proposers could not move the substrate

Across v1 smoke and two calibrations, the proposer could not improve the substrate. In calibration 2, 272 variants left the context window at 30 and `maxAttempts` at 3. v1 calibration measures the proposer, not SIM. A floor in `off` makes every SIM contrast a built-in null.

## Proposer selection: probe, then rule

`probe.mjs` was committed (commit `e43fdc2c`, pushed before the probe ran) with its selection rule in the file header, before it ran:

> For each family, take the cheapest configuration whose train-raise rate is ≥ 25% on BOTH surfaces (`contextBuilder` on `loc`, `retryPolicy` on `per`). Prefer `stock` over `behaviour` at the same model. v2 needs two qualifying families.

The probe made 240 single proposals on the baseline files, with no SIM context, $0.20, raw rows in `results/raw-probe.jsonl`. Values are train-raise rates out of 10 proposals per cell:

| model | system | `loc` | `per` | qualifies |
|---|---|---|---|---|
| gemini-2.5-flash-lite | stock / behaviour | 0.0 / 0.0 | 0.0 / 0.2 | no |
| **gemini-3.1-flash-lite** | **stock** | **1.0** | **1.0** | **yes (google)** |
| gpt-4.1-nano | stock / behaviour | 0.0 / 0.0 | 0.2 / 0.0 | no |
| gpt-4.1-mini | stock / behaviour | 0.0 / 0.0 | 0.6 / 1.0 | no (`loc` 0) |
| deepseek-chat-v3.1 | stock | 0.0 | 1.0 | no |
| **deepseek-chat-v3.1** | **behaviour** | **0.5** | **1.0** | **yes (deepseek)** |
| qwen3-coder | stock | 0.2 | 1.0 | no |
| qwen3-coder | behaviour | 0.5 | 0.3 | yes (qwen) |

**Tie-break, written after the probe, before any SIM contrast.** Three families qualified; the rule did not say which two to keep. Qwen is dropped on failure rate and price alone:

- 8 of its 20 qualifying calls aborted at the 90 s timeout (ledger outcome "The operation was aborted"; p50 latency 79 s on `contextBuilder`);
- an aborted call is charged at its reservation, which made it 2.5× the cost of the other two.

Held-out values from the probe were recorded only to detect a ceiling and played no part in this choice.

**Models:**

| model | system line | price in/out ($/M) |
|---|---|---|
| `google/gemini-3.1-flash-lite` | `stock` (verbatim `OpenRouterMutator` system prompt) | 0.25 / 1.50 |
| `deepseek/deepseek-chat-v3.1` | `behaviour` | 0.25 / 0.95 |

The `behaviour` system line is identical to `stock` except that "pure refactor/tuning only" becomes "behaviour changes inside this file are allowed", and "a small, plausibly score-improving change" becomes "the change most likely to raise the score" (`proposer.mjs` `SYSTEM_LINES`). Its safety rules are unchanged and the validator is unchanged. It is a deviation from the stock mutator, applied to deepseek because the rule selected it.

**Limitation (mixed system lines).** Within-cell paired contrasts compare arms that share the same model and the same system line, so they are unaffected. The `*-xmodel` arms read memory written by the other model, which also used the other system line, so cross-model transfer here means model plus system line. It is reported that way.

## Design changes

| setting | v1 | v2 |
|---|---|---|
| target seeds | 1–30 | **1–25** |
| calibration seeds | 950–951, 960–961 | **970–971** |
| run concurrency | 8 | 16 (wall clock only; deepseek p50 is about 10 s per call) |
| output | `results/` | `results/v2/` (one shared ledger, `results/spend-ledger.jsonl`) |

**Seed count.** The probe measured about $0.00095 per call for gemini and $0.00083 for deepseek. At 33 calls per run that is about $0.03 per run, or $0.85 per seed across the 29 target runs. Twenty-five seeds therefore cost about $21. Adding source (12 runs) and calibration (8 runs) gives about $22, against $39.64 remaining, roughly 2/3. The seed count is fixed now and is not extended after results are seen.

**Cap.** The cap still covers everything charged since the v1 smoke, because there is one shared ledger.

## Calibration gate (single, no revision)

**Runs.** `off` only, all 4 model × benchmark cells, seeds 970–971: 8 runs, excluded from analysis.

**Gate, same as amendment 1.** Both conditions must hold:

- in at least 5 of 8 runs the `off` winner beats the baseline on train;
- for each benchmark, the mean `off` held-out is above the baseline held-out (`loc` 12.5%, `per` 31.3%) and below 95%.

**If the gate fails,** v2 stops and the floor or ceiling is reported. There is **no** amendment of v2.

**Ceiling readout.** Reported for calibration and for every target `off` run:

- `firstTrainPerfectGeneration`: the first generation with a child at train 100%;
- the held-out spread among train-perfect winners.

If `off` usually reaches train 100% in generation 1, the lineage cannot climb further on train. In that case SIM can only act through which train-perfect edit is found first, and a `null` verdict is reported as "no train headroom for memory to act on", **not** as "SIM does not help".

## Reproduce

```bash
cd packages/darwin-mode && npx tsc                         # tracked dist lags src; the runner refuses a stale dist
OPENROUTER_API_KEY=... node bench/sim-eval/run.mjs --live --phase calib
OPENROUTER_API_KEY=... node bench/sim-eval/run.mjs --live --phase source
OPENROUTER_API_KEY=... node bench/sim-eval/run.mjs --live --phase target
node bench/sim-eval/analyze.mjs results/v2
```
