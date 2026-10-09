# Arena flywheel: ops runbook

The flywheel runs once a day on ruvultra as a systemd **user** timer. It searches for a better OpenEnv Arena environment
configuration and tests the result on fresh seeds. It renders and checks a submission request, and submits only when every
policy condition holds and the mode is `auto`.

The default mode is **dry-run**, which never POSTs. No LLM takes part in the submit decision: `decide.mjs` is a pure
function. Slack messages and comments on the board are never approval.

## What one tick does

| # | Phase | Notes |
|---|---|---|
| 1 | Preflight | Destroys GPUs left by crashed runs: journal orphans by id (their ledger run is settled at its real duration), plus spend-ledger runs still open past their planned hours (by label). Then it reconciles any pending submission, reads the arena status and the leaderboard (public), reads the 24 h slot and the account's own submissions (token) and pre-checks spend. |
| 2 | Incumbent | The last `validated` submission (`incumbent.json`). On day 1 it is `lib/cells.mjs` `baselineGenome()`. The public leaderboard and the account's own `GET /submissions` must agree: on day 1 `ruv` is absent and no own submission was ever validated; otherwise `ruv` is present and the newest validated own submission IS `incumbent.json`'s. |
| 3 | GPU up | Vast.ai with a pinned vLLM digest. It writes a spend-ledger row, installs its signal traps and arms an independent **label-mode** watchdog BEFORE create (so no instance ever exists without one), creates, then opens an SSH tunnel and polls `/v1/models`. |
| 4 | Search | `run-darwin.mjs` starts from the incumbent. Its own confirmation is turned off (`--confirm-attempts 0`). |
| 5 | Confirmation | Preregistered: the plan sha256 is journaled before any rollout. Both genomes are scored on one fresh seed block derived from the date. Pairs are built by Darwin's `lib/confirm.mjs`. |
| 6 | GPU down | Also runs in `finally` on every path. |
| 7 | Render and check | Renders the request with the env lane's `submission.py`, then pulls the exact digest anonymously, hashes the env source INSIDE that image (`arena_env/{tasks,environment}.py`, the `lib/provenance.mjs` formula) and runs `openenv validate`, a `/schema` equality check, the arena limits and an example-action replay of every task ID. The env lane's scripts run with an empty `HOME`/`HF_HOME` and the hub offline. |
| 8 | Gate | `gate.mjs` v2 takes `--run`, the confirmation cards and the pairs, at the PREREGISTERED `alpha`, `lambda` and `candidateBudget` (from the plan, never today's config). Its receipt is verified against the pinned key. |
| 9 | Decide | Every fact is re-derived from the files on disk and the current config (`recheck.mjs`; the receipt is verified again against today's pin). `decideSubmit`: 31 named conditions must each be exactly `true`, including `candidateMatchesPlan`, `gateConfigMatchesPlan`, `envLaneCommitPinned`, `imageEnvSourceMatchesPlan` and `runDateIsToday`. |
| 10 | Submit | Auto mode only: one POST of the approved bytes, behind a receipt and a pending record. Then the result is polled. The incumbent moves only on `validated`. |
| 11 | Report | Writes `reports/<date>/status.json` and `report.md`. |

On day 1, if the gate does not promote, the tick renders a **needs-human** request for the v2 defaults
(8 × `<family>-d2`) and does not submit it.

## Install

```sh
~/metaharness/integrations/openenv-arena-darwin/flywheel/install.sh            # verify units, seed config (dry-run), enable both timers
loginctl enable-linger ruvultra                                                # the timers only fire while logged in otherwise
~/metaharness/integrations/openenv-arena-darwin/flywheel/install.sh --verify   # units only
~/metaharness/integrations/openenv-arena-darwin/flywheel/install.sh --uninstall # disable the timers; config and state are kept
```

- The timer fires at `10:17 America/Toronto` with 10 min of jitter. It has `Persistent=true`, but the first enable does not trigger a catch-up run.
- `arena-flywheel-recover.timer` runs `recover.mjs` 5 min after boot and then hourly: the orphan and stale-ledger GPU sweep of the preflight, nothing else (it never rents or submits). It shares `tick.flock` with the tick: it skips while a tick runs, and a tick that starts during a sweep waits up to 15 min (`ARENA_FLYWHEEL_FLOCK_WAIT_S`).
- The service is a oneshot that is never restarted. `TimeoutStartSec=8h`, `KillMode=mixed` and `TimeoutStopSec=10min`.
- The installer never starts a tick. To run one by hand: `systemctl --user start arena-flywheel.service`.
- Before starting the orchestrator, `systemd/run-tick.sh` fails closed if the HF token file is missing or empty, or the network is offline.

## Config: `~/.config/arena-flywheel/config.json`

`flywheel-config.mjs` deep-merges this file over its defaults and validates it. Required for real (non-dry-run evaluator) ticks:

```json
{
  "mode": "dry-run",
  "evaluator": {
    "envDir": "/home/ruvultra/projects/metaharness-arena-v3/integrations/openenv-arena",
    "python": "/path/to/the/python/that/runs/calibrate.py",
    "tokenizerJson": "/path/to/Qwen3.8-27B/tokenizer.json"
  },
  "checks": {
    "python": "/home/ruvultra/.local/share/arena-flywheel/venv/bin/python",
    "openenv": "/home/ruvultra/.local/share/arena-flywheel/venv/bin/openenv",
    "expectEnvCommit": "<full sha of the checks envDir commit>"
  },
  "gate": { "expectPublicKey": "<base64 SPKI of ~/.config/arena-flywheel/gate-key, see below>" }
}
```

- **`evaluator.envDir`** must be an env lane worktree whose `scripts/calibrate.py` accepts `--thinking`, which means commit 36db9a71 or later.
  - The Darwin evaluator has passed `--thinking off` since commit 763bd802. `metaharness-arena-v3` is at 36db9a71, which contains the knob commit 0af81c55. `metaharness-arena-knobs` (0af81c55) does **not** accept `--thinking`.
- **`checks.envDir`** defaults to the knob worktree, 0af81c55. That is the env lane's renderer, example actions and replay for the pinned image.
- **`checks.python` / `checks.openenv`** must point at a persistent venv with OpenEnv `86a180ede21e044f7929b9a7783ad83aa67d83a3` and websockets 17.2.
  - The built-in default, `packages/openenv-arena/.venv`, no longer exists. The only copy left is `/tmp/arena383venv`, and `/tmp` is not persistent.
  - The tick refuses before renting a GPU if these files are missing.
  - One way to build the venv (not verified here): `uv venv --python 3.13 ~/.local/share/arena-flywheel/venv && uv pip install --python ~/.local/share/arena-flywheel/venv/bin/python "openenv @ git+https://github.com/meta-pytorch/OpenEnv.git@86a180ede21e044f7929b9a7783ad83aa67d83a3" websockets==17.2`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `dry-run` | `auto` is the only mode that can POST |
| `darwin.generations` / `children` / `maxTotalNewCells` | 2 / 3 / 14 | Search size. `maxTotalNewCells` counts runner calls, at `searchAttempts/4` per cell |
| `darwin.searchAttempts` | 4 | Episodes per cell in the search (run-darwin's `--attempts`) |
| `confirmation.attempts` | 8 | Episodes per cell in the confirmation. Decides whether the gate can ever promote (see below) |
| `gate.candidateBudget` | `null` | Alpha is split over this. `null` uses gate.mjs v2's default, the number of search candidates evaluated |
| `gate.keyDir` | `~/.config/arena-flywheel/gate-key` | Ed25519 signing key, mode 0700. Must be outside any git work tree |
| `gate.expectPublicKey` | `null` | Operator pin. Without it `gatePublicKeyPinned` is false and nothing submits. Rotating it revokes every receipt not yet submitted |
| `checks.expectEnvCommit` | none | Full 40-hex commit of `checks.envDir`. **Required by `mode: "auto"`** (config refused otherwise); the worktree must be clean (`envLaneCommitPinned`) |
| `caps.dailyUsd` / `totalUsd` | 12 / 200 | Spend caps. "Daily" is the America/Toronto calendar date of each rental. The ledger is seeded with 5.00 USD of prior manual spend, and never re-seeded once a rental is journaled (a deleted `spend.jsonl` refuses all renting) |
| `gpu.*` | `gpu.mjs` `GPU_DEFAULTS` | Offer query, `maxDphUsd` 3.5, `maxGpuHours` 3 (watchdog deadline), `localPort` 8100 |
| `submission.taskLimits` | arena defaults | `rollout_wall_s` 1800 has **not** been measured for 8–16k budgets. Review it |
| `slot.proceedIfFreeWithinS` | 21600 | Rent anyway if the slot frees within this many seconds |
| `arena.user` | `ruv` | Leaderboard user for the day-1 check |
| `evaluator.dryRun` | false | Fake rows and no model. Can never submit |
| `evaluator.rentGpuInDryRun` | false | Rehearses the GPU lifecycle with fake rows. Spends money and can never submit |
| `notify.postEnabled` / `slackChannel` | false / "" | Used only by `post-report.sh --post`, which you run by hand |

Get the public key to pin. This works after the first gate run, or create the key now:

```sh
node --experimental-strip-types -e "import('./integrations/openenv-arena-darwin/gate.mjs').then(m => console.log(m.fileSigner(process.env.HOME + '/.config/arena-flywheel/gate-key').publicKey()))"
```

Secrets are never put in the config:

- **HF token:** `${HF_TOKEN_PATH:-$HOME/.cache/huggingface/token}`. It is read only by `arena-token.mjs` and sent only as an in-process `Authorization` header to the arena base.
- **Vast key:** fetched from Secret Manager (`VAST_API_KEY`, project `cognitum-20260110`) at use time. It is passed only in the environment of `vastai`.

## Modes and switching to auto

Dry-run ticks do everything except the POST. `status.json` records `wouldSubmitInAuto` and the full flag table.

Switch to auto only after reviewing at least one dry-run tick in which **every flag except `modeAuto`** is true:

1. **Gate binding.** The Darwin lane must ship the `--request-sha256` binding in `gate.mjs`. Until it does, `requestDigestBoundInGateReceipt` is false and auto never submits.
2. **Statistical power.** The gate needs `ceil(ln(candidateBudget/0.05)/ln 1.5)` paired blocks. Today that is 13 when 7 candidates are evaluated, or 8 with `candidateBudget: 1`. A one-family change at 8 attempts gives 2. `report.md` prints the attempts that would be needed. Raise `confirmation.attempts` or accept needs-human days.
3. **Pin and limits.** Set `gate.expectPublicKey` and `checks.expectEnvCommit`. Review `submission.taskLimits.rollout_wall_s` and the spend caps.
4. **One environment.** `imageEnvSourceMatchesPlan` requires the env source inside `image` to equal the one the confirmation measured (`evaluator.envDir`). Measured: image `2f3f12b9` and the knobs worktree 0af81c55 hash to `a60e9dfb…`; image `77b83bb4` and the v3 worktree 36db9a71 (needed for `--thinking off`) hash to `8b503376…`. Pair them accordingly (`image`, `checks.envDir`, `checks.expectEnvCommit`, `evaluator.envDir`).
5. **Flip it.** Set `"mode": "auto"` in the config. The next tick uses it. `--mode` can only downgrade: `--mode auto` with a dry-run config stays dry-run, and `runDateIsToday` refuses any `--date` that is not the Toronto date of `--now`. For a single manual auto tick (config already auto):
   `node --experimental-strip-types flywheel.mjs --date $(TZ=America/Toronto date +%F) --now $(date -u +%FT%TZ)`

To go back, set `"mode": "dry-run"` (or pass `--mode dry-run`). A tick already running keeps the mode it started with.

## Reading the output

State lives in `~/.local/state/arena-flywheel/`. Every write is append-only or atomic.

| Path | What |
|---|---|
| `reports/<date>/report.md`, `status.json` | The day's long report and machine status: decision, flags, candidate, confirmation, gate, requests, GPU, slot, notes |
| `journal.jsonl` | Every phase event of every run, with timestamps, plan hashes, digests and decisions |
| `runs/<date>/` | Phase results (for resume), the Darwin work root, confirmation cards and pairs, gate receipts, and rendered requests with check reports (`candidate/`, `needs-human/`) |
| `spend.jsonl` | GPU spend ledger: `seed`, `planned`, `cancelled` and `settled` rows |
| `pending-submission.json`, `incumbent.json`, `quota.json` | Submission state. Never edit these while a tick is running |

Short summary: `node flywheel/report.mjs` (add `--format slack` for the Slack text). Unit log: `journalctl --user -u arena-flywheel`.

| Outcome | Meaning |
|---|---|
| `skipped` | There was a candidate, but at least one flag was false. The reasons are listed |
| `needs-human` | Day 1 and the gate did not promote. `runs/<date>/needs-human/.../request.json` is the v2-defaults request for a human to review |
| `no-candidate` | Darwin did not beat the incumbent (day N) |
| `slot-busy` | The 24 h slot is held or unreadable (fail closed), or the arena returned 429. No GPU was rented |
| `budget-refused` | A cap, Vast credit or offer check refused to rent |
| `incumbent-mismatch` | Local `incumbent.json` disagrees with the public leaderboard. A human must reconcile it. No GPU was rented |
| `incumbent-changed` | A pending submission was validated after this date first ran. The date is skipped |
| `submitted-validated`, `submitted-pending`, `submitted-rejected` | A POST happened. Pending submissions are reconciled by the next tick and never re-POSTed |
| `submit-unknown`, `submit-refused` | The outcome of a POST is unknown (reconciled later, never re-sent), or it was refused at once |
| `error` | See `error` in the report. The GPU was still torn down |

## Stopping it

- **Pause:** `systemctl --user disable --now arena-flywheel.timer`, or run `install.sh --uninstall`. Both keep config and state.
- **Stop a running tick:** `systemctl --user stop arena-flywheel.service`. The orchestrator's trap destroys the Vast instance (about 210 s) and leaves no report for that tick.
- **Never submit:** set `"mode": "dry-run"`.
- **Orphaned GPU:**
  - Each rental has a watchdog unit, `systemctl --user list-units 'arena-flywheel-wd-*'` (named after the run, armed before create), which looks the rental up by its label at the deadline and destroys it. It retries for 25 min (per-call timeouts, best-effort logging), then exits 1 and systemd restarts it (`Restart=on-failure`) until it confirms or the deadline is 24 h old. The hourly recovery unit and the next tick also sweep orphans by ID and label.
  - To destroy one by hand: `node -e "import('./flywheel/gpu.mjs').then(async m => console.log(await m.destroyInstance(<ID>)))"`.
  - Watchdog failures (`unconfirmed`, `terminated_after_fire`, `label_mismatch`) are written to `watchdog-failed.jsonl`.

## Tests

```sh
node --test integrations/openenv-arena-darwin/flywheel/test/*.test.mjs
```

The tests use fakes for vastai, gcloud, ssh, docker, the arena and the model endpoint. `e2e-dry-run.test.mjs` runs the real wiring and the real Darwin, gate and check modules.

Two tests are opt-in: `VASTAI_IT=1` runs the real vastai CLI against a local fake API, and `SYSTEMD_IT=1` creates a transient user unit.
