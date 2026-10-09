# OpenEnv Arena: Darwin search over environment settings

The Arena trains Qwen3.8-27B with GRPO on our environment. A task group whose 4 rewards are all equal gives
zero learning signal, and v2 calibration showed most cells always solve or always truncate. This directory
replaces hand-tuning of v2's difficulty settings with a measured search:

1. **Darwin** (`run-darwin.mjs`, ADR-272 `evolveNumeric`) changes **one** setting per child and scores each
   variant on the model through `evaluator.mjs`, which wraps the v2 `calibrate.py` runner.
2. **Confirmation**: when the search winner beats the baseline, both are re-measured on **fresh, disjoint
   seeds**. The search scorecards are selection data. In a null world where no setting matters, the search
   winner "beats" the baseline in 18–20 of 20 runs.
3. **The Flywheel gate** (`gate.mjs`) promotes only on that confirmation, with paired, anytime-valid evidence.
   The decision is signed with Ed25519 and re-verified against a pinned key.
4. **Failure clustering** (`cluster-failures.mjs`) embeds non-solved episodes and clusters them with ruvector.

Nothing here submits to the Arena or posts anywhere.

## Fitness (`lib/fitness.mjs`)

A **cell** is one family × difficulty × budget (× future knobs), played `attempts` times. Each runner call plays
one 4-seed block. Each episode is classified as follows. The rules are tested against real rows in
`test/fixtures/real-rows.jsonl`.

| class | rule |
|---|---|
| `solved` | reward === 1 |
| `partial` | no failure code, 0 < reward < 1 (a valid answer with partial credit) |
| `reasoning` | no failure code and reward 0 (a valid answer that is wrong) |
| `format` | `ValidationError`, `missing_action_content` or `invalid_json_action` from a reply that finished on its own (v1 rows: total tokens below the per-request cap). Learnable, but not reasoning |
| `truncation` | `completion_truncated`, `episode_{completion,context}_budget_{exhausted,exceeded}`, `step_budget_exhausted` (the runner's 8-step cap is an artefact; the env allows 16), or a format error from a length-limited reply |
| `infra` | timeouts and provider or harness failures. **Any unknown failure code also counts as infra** |

**Eligible** episodes are `solved`, `partial` and `reasoning`. Per cell:
- `signal = #{4-episode subsets that are all eligible AND whose rewards are not all equal} / C(n, 4)`. This is
  the exact, unbiased probability that a random arena group of 4 from this cell carries a gradient driven
  purely by reasoning outcomes. Any truncation, format or infra episode in a group voids that group.
  At n = 4 the signal is 0 or 1. Turning a truncation into any eligible outcome never lowers it.
- Secondary numbers, reported but not optimised:
  - `varSignal = clip(var(eligible rewards)/0.25) × eligible/n`
  - `deadGroupRate = Σ_v C(c_v, 4) / C(n, 4)`, the literal arena zero-gradient rate over all rewards, with
    truncation counted as 0
- `dead = signal === 0`
- `mixedFromReasoning = 0 < solved < n && signal > 0 && (partial + reasoning) >= truncation + format`

Per genome, as a NumericScoreCard:
- `primary = Σ signal`
- `noopRate = 1 − primary / cells`, the probability that a group carries no reasoning gradient. Because it is
  linear in `primary`, the gate's noop clause adds nothing independent of the primary clause.
- `costPerWin = generated tokens / max(1e-6, Σ signal)`, i.e. tokens per unit of reasoning signal
- `regressed` is true when any cell has fewer than 4 episodes, **any** infra episode, or a runner error
- NaN, infinite, negative or missing token accounting **fails closed**: an episode with provider calls but no
  token counts throws, and the card gets `primary: -1`, `regressed: true` and an `evaluatorError`

This measure follows the user's definition: mixed groups caused by reasoning count, mixed groups caused by
truncation do not. One consequence: at 4 attempts, `[1, .75, .75, .75]` and `[1, 1, 0, 0]` both score 1.
That matches GRPO with per-group std normalisation, which TRL applies by default. Whether the Arena does the same
is not verified.

## Tests and a dry run (no model, no GPU)

```sh
cd integrations/openenv-arena-darwin
node --experimental-strip-types --test test/*.test.mjs            # 80 tests: 79 pass, 1 skipped (ruvector IT)
RUVECTOR_IT=1 node --experimental-strip-types --test test/*.test.mjs   # also the live ruvector CLI round trip
```

- `test/runner-safety.test.mjs` runs the **real** `calibrate.py` against a loopback stub that returns 503. It is
  skipped when the v2 env, its venv or the pinned tokenizer is missing.
- Temporary gate keys go under `DARWIN_TEST_KEY_ROOT` (default `os.tmpdir()`) and are deleted afterwards.
- `--test test/` (a directory) does not work on Node 22.
- `run-darwin.mjs` needs `module.registerHooks` (Node 22.15 or later).

End-to-end dry run, using the real evaluator on deterministic fake rows:

```sh
D=<scratch dir outside the repo>
node --experimental-strip-types run-darwin.mjs --work-root $D/work --generations 2 --children 3 --seed 4 \
  --confirm-attempts 64 --max-total-new-cells 300 -- --dry-run --cache-dir $D/cache
DARWIN_GATE_KEY_DIR=<key dir outside any git tree> node --experimental-strip-types gate.mjs \
  --run $D/work/reports/darwin-run.json --out $D/receipt.json
node --experimental-strip-types gate.mjs --verify $D/receipt.json --key-dir <same key dir>
```

On that dry run the gate exits 1 at the default candidate budget (e = 86.5 < 20 × 10). Run with
`--candidate-budget 1` it exits 0 (see the gate section). Dry-run and `--mock` scores come from a toy landscape and
are not evidence about the model; every report says so in `evidence`. Mock runs have no seeds, so the gate never
admits them.

## Running against a live endpoint

```sh
export ARENA_MODEL_API_KEY=local      # any value works for a local vLLM; the evaluator refuses to run if it is unset
V2=/home/ruvultra/projects/metaharness-arena-v2/integrations/openenv-arena
node --experimental-strip-types run-darwin.mjs --work-root <run dir> --generations 2 --children 3 --concurrency 1 \
  --seed-base 700000 --attempts 8 --confirm-attempts 32 --max-total-new-cells 120 -- \
  --env-dir "$V2" --python /tmp/arena383venv/bin/python --tokenizer-json <tokenizer.json> \
  --base-url http://localhost:8100/v1 --model qwen38 --model-revision 1d4bf0f2 --cache-dir <cache dir per tier> --concurrency 2
```

- **The driver owns the seed plan.** It passes `--seed-base`, `--attempts` (default 8; 4 is screening only),
  `--max-new-cells` and `--deadline-ms` to the evaluator, and refuses them in the passthrough.
- **Confirmation** defaults to `--confirm-seed-base` = seed base + 100000 and `--confirm-attempts 16`. The two seed
  ranges must be disjoint. It re-measures only the baseline and the winner, and it is charged to the budget.
  `--confirm-attempts 0` skips it.
- **`--model` and `--model-revision` are required in real mode.** Before measuring, the evaluator queries
  `GET <base-url>/models`. It refuses if the endpoint is unreachable or does not serve `--model`. It applies
  calibrate.py's rule: HTTPS without credentials, or loopback HTTP.
- **Outputs** in `<work-root>/reports/`:
  - `darwin-run.json`: every child as `param from -> to`, `selection`, `confirmation`, the budget, and the gate command
  - `baseline-scorecard.json`, `winner-scorecard.json`: search data; the gate refuses these
  - `confirm-baseline-scorecard.json`, `confirm-winner-scorecard.json`, `confirm-paired.json`: what the gate uses
  - `winner-genome.json`. Ignore the engine's `winner.json`, which ignores `regressed`.
- **A regressed baseline aborts the run** with exit 3. Children are refused without spending GPU, and no winner
  files are written. Otherwise every child would "beat" a baseline that scored 0 on a broken cell.

### Budget, cache, timeouts

- **`--max-total-new-cells N` counts runner calls.** One runner call is one 4-seed block of one cell, so a cell at
  A attempts costs A/4. It is required unless you pass `--mock`.
  - Before a candidate starts, its new cells are reserved, and a candidate that would exceed the cap is refused.
  - Afterwards the charge is settled to the runner calls the evaluator reports: cache hits are refunded and
    retries are charged. One infra retry per failing block can overshoot the cap by that retry; later
    candidates are then refused.
  - A cell that failed is released. The next evaluation that needs it reserves it and pays for it again.
  - Evaluator-side refusals are counted in the report.
- **Cache identity.** Cells are keyed by `sha256(canon({cell, provenance}))`. Provenance covers:
  - the env source (tasks.py and environment.py) and the calibrate.py sha
  - `serverSha`: the normalized base URL plus what `/models` reports (id, root, max_model_len)
  - `runnerArgsSha`: max-total-tokens, tokenizer pin, max-steps, request timeout and max-tokens cap
  - the model label and revision, context tokens, seed base and attempts

  A ruvllm proxy and the A100 27B can therefore never share a key, even under the same `--model` label. Still use
  one `--cache-dir` per tier.
- **Nothing is cached unless a block is clean.** A block is accepted only if the runner exited 0, the
  orchestration receipt says `available: true`, and the block has no infra episode. A failing block is re-run once
  (`--infra-retries`, 0..2). If it still fails, the cell fails, and its raw outputs stay in `<cache>/runs/`.
- **Runner processes.** Each runner call is its own process group. The evaluator kills those groups:
  - on the per-call timeout (`--cell-timeout-s`). The default, 29,400 s, is the plan's worst case of 32
    requests × 900 s, plus 600 s for startup.
  - on SIGTERM or SIGINT
  - at `--deadline-ms`, which run-darwin sets to `--evaluator-timeout-ms` minus a margin. In that case the evaluator
    prints a fail-closed card and releases its locks.

  A SIGKILL of the evaluator itself still orphans its runners. That happens if it is run bare under a shorter
  ShellEvaluator timeout, or if the driver is SIGKILLed.
- **Parallel runner calls.** Driver `--concurrency` × evaluator `--concurrency` must be at most 16.
- **Locks.** A stale lock (from a dead pid) can be removed only by the holder of an atomic per-key reclaim
  mutex. In 8 trials of 24 simultaneous contenders, there was exactly one holder every time. The old code had
  2–5 holders in 6 of 8 trials.

## Submission gate (`gate.mjs --run <darwin-run.json>`)

All of the following must hold, or the decision is a refusal (exit 1, still signed):
- **Selection context** from the run, and it is not a mock run.
- **Valid scorecards.** Both are finite and in range with no `evaluatorError`, and **the baseline is not regressed**.
- **Same provenance** on both, with a seed range disjoint from the search seeds (`selection_seed_reused`
  otherwise).
- **Paired evidence, re-derived from the scorecards' episodes.**
  - An item is one (changed cell, 4-seed block). An arm wins a block when that block is a group with a pure
    reasoning gradient.
  - A `--paired` file must match the re-derived pairs exactly.
  - The evidence must be non-empty, able to reach the threshold at all, and significant under
    `withSequentialEvidence` at `alpha / candidate-budget`.
- **Candidate primary strictly greater** than baseline primary.
- **The frozen `meetsPromotionRule`.** Its independent clauses here are cost per unit of signal and `regressed`.

**Candidate budget.** It defaults to the number of candidates Darwin evaluated, which is the multiplicity
correction the reviews asked for. That correction is very conservative:
- With λ = 0.5, it needs `ceil(log(20·K)/log(1.5))` net winning blocks: 14 at K = 10–13.
- One changed cell at `--confirm-attempts 16` gives 4 blocks, so the gate refuses with
  `confirmation_underpowered(...)`. The run summary prints the attempts needed.

Because the confirmation seeds are independent of the selection, a single pre-specified fresh-holdout comparison
is valid at `--candidate-budget 1`. That choice is recorded in the signed receipt (`candidateBudgetSource: explicit`).

| measured with a null-world / real-effect evaluator harness through run-darwin + gate (20 worlds per row; harness listed in the integration report, not in this repo) | default K | K = 1 |
|---|---|---|
| null world (no setting matters), 6 configs, 116 confirmations | 0 promoted | 1 promoted |
| real effect (difficulty 3: P 0.97 → 0.7), confirm 64 | 14/20 | 17/20 |
| real effect, confirm 32 | 3/20 | 13/20 |

**Receipts and keys:**
- `--verify` requires a pinned key (`--expect-public-key`, `--key-dir` or `DARWIN_GATE_KEY_DIR`) and exits 2
  without one.
- The key directory must be outside this repo and outside **any** git work tree, and must already be 0700.
  The key file is 0600.

## Not supported yet / open decisions

- **Environment knobs** (instance size, distractors, fault positions, per-task token budget beyond the episode
  budget):
  - `RUNNER_KNOBS` in `lib/cells.mjs` is empty, and `<family>.<knob>` parameters are rejected explicitly.
  - See `KNOB-CHANGE-REQUEST.md`.
- **Search range.** The search covers per-family difficulty (1..3) and budget. The budget runs 6889..16384 on a
  log scale, so the one-param lattice is 6889, 8192, 9742, 11585, 13777, 16384. Below about 5.9k nearly every real
  v2 episode truncates.
- **Within-instance variance is not measured.** Each 4-seed block is 4 different instances. That matches the
  Arena only if its resets are unseeded, which is not verified. Instances the model can never solve also still
  count as reasoning failures. A `grade(task, expected) == 1` solvability check belongs to the env owner.
- **Unverified Arena assumptions:**
  - the per-episode `completion_tokens` budget is ours to set per task
  - resets are unseeded
  - GRPO normalises by the group's std
  - "first 4 valid" excludes infra failures rather than scoring them 0
- **Not run end to end on the real model.** The real runner's failure path has run against a loopback 503 stub.
  The success path (exit 0 with real episodes, then cached and scored) has not.
- **Local proxy (ruvllm).** It cannot be used yet; see `proxy/RUVLLM-FEASIBILITY.md`. Results from any second
  tier are keyed apart by `serverSha`.
- **Clustering (`cluster-failures.mjs`).** It uses ruvector 0.3.3 and falls back to exact cosine, saying so in its
  output. It uses the same 6 classes as the fitness. It needs ollama `all-minilm` on `localhost:11434`.

## Files

| file | role |
|---|---|
| `run-darwin.mjs` | driver: one-param mutation (`lib/one-param-mutator.mjs`), run budget (`lib/run-budget.mjs`), confirmation (`lib/confirm.mjs`), report (`lib/report.mjs`), `--mock` (`lib/mock-evaluator.mjs`) |
| `evaluator.mjs` | ShellEvaluator CLI. Uses `lib/provenance.mjs` (cell identity, server probe), `lib/runner.mjs` (process groups, block checks, retry), `lib/cache.mjs`, and `lib/fake-rows.mjs` for dry runs |
| `lib/cells.mjs`, `lib/fitness.mjs` | genome↔cell contract, cell keys, classifier and scoring |
| `gate.mjs` | Flywheel submission gate and signed receipts |
| `cluster-failures.mjs`, `lib/ruvector.mjs` | failure embedding and clustering (shares the fitness classifier) |
| `KNOB-CHANGE-REQUEST.md` | requested env knobs, with measurements |
