# Overnight GEPA Training Loop (`overnight-train.mjs`)

A **resumable, budget-governed** training loop over the GEPA learning system (ADR-228). It is built to
run autonomously across the night and across session restarts: each invocation runs **one** pending
training job, records durable state, and exits. A new session picks up mid-queue by reading the state
file — no re-bootstrapping, no duplicate spend.

> **Arming:** BUILD + `$0` mock-tested. The parent arms the live run **after** the acceptance rounds
> in the `a636763` worktree finish (they own the deepseek + glm-from-seed jobs — those are marked
> `in_progress_elsewhere` here so this loop skips them). Do not point this at a live API key until then.

---

## What one iteration does

1. **Load (or seed) the state file** — `gepa/runs/overnight-train-state.json` (queue + per-job status
   /result + cumulative spend + caps).
2. **Pick the next `pending` job.** Every other status is skipped (see *Resume*).
3. **Budget gate.** Reserve `min(job.max_cost, per-job cap)` against the global cap. If
   `cumulativeSpend + reserve > max-total-cost`, the job **and all remaining pending jobs** are marked
   `deferred` and the loop stops cleanly. Reserving *before* the run is what guarantees the cap is
   **never exceeded**, even on a worst-case job.
4. **Run `metaharness learn`** (`learn.mjs`) for the job — one GEPA optimization on the train slice +
   an honest eval on the **unseen holdout** slice.
5. **Apply the STRICT promote-on-holdout rule.** `learn.mjs` computes the verdict in its promotion
   report; promote **only if all three hold on the holdout**:
   - `gold-no-regress` — no instance the seed resolved is lost by the candidate;
   - `holdout-empty-patch-improves` — strictly fewer class-3 (empty-patch / exploration-loop) failures;
   - `cost/resolved-not-worse` — candidate `$/resolved ≤` seed `$/resolved`.
6. **On PROMOTE →** register the winner in the **genome registry** (`gepa/runs/genome-registry.json`)
   as a `SHADOW` entry and keep the promotion report. (SHADOW = promoted screening winner, not yet the
   live base — matches PROMOTION.md's "positive screening signal, funds a confirmatory run" framing.)
7. **Mark the job `done`** with its result, add its actual cost to cumulative spend, persist state +
   registry, and **emit one summary line** for a Monitor.

## The queue (seeded)

| id | model | workflow | status | why |
|---|---|---|---|---|
| `glm52-cand6-code-repair` | z-ai/glm-5.2 | code-repair | **pending** | push the promoted cand-6 base past 5/12 train (seed = `genome-promoted-cand6-edit-by-midpoint.json`) |
| `deepseek-v4-flash-code-repair` | deepseek/deepseek-v4-flash | code-repair | `in_progress_elsewhere` | the live acceptance run owns it — skip, no dup-spend |
| `glm52-seed-code-repair` | z-ai/glm-5.2 | code-repair | `in_progress_elsewhere` | the live acceptance run owns the glm-from-seed run — skip |
| `triage-vertical-placeholder` | z-ai/glm-5.2 | business-triage | `placeholder` | wire a manifest + seed genome to activate |
| `rli-mini-vertical-placeholder` | z-ai/glm-5.2 | business-rli-mini | `placeholder` | wire a manifest + seed genome to activate |

**Job schema:** `{ id, model, workflow, seed_genome, manifest, train_first, max_cost, status, note, result }`.
`status ∈ { pending, in_progress_elsewhere, placeholder, done, deferred, failed }`.

To wire a business vertical: flip its `status` to `pending` and set a real `manifest` + `seed_genome`.

## Budget governance

- `--max-total-cost` (default **$100**) — global cap for the whole overnight run.
- `--max-cost` (default **$12**) — per-job cap (also passed to `learn.mjs --max-cost`).
- The reserve-before-run gate means the loop **never exceeds** `--max-total-cost`. When the cap is
  reached, the current + remaining pending jobs become `deferred` (recorded, not lost) and the loop
  exits `budget_stop`.

## Resume mechanism (the state file)

`gepa/runs/overnight-train-state.json` holds `{ version, createdAt, updatedAt, maxTotalCost,
perJobMaxCost, cumulativeSpend, queue[], log[] }`. State is persisted **after every iteration**, so a
crash mid-queue is still resumable. On restart the loop **skips every job whose status is not
`pending`** — i.e. `done`, `in_progress_elsewhere`, `deferred`, `placeholder`, `failed` are all left
untouched. A new session therefore continues exactly where the last stopped, with zero re-spend. The
`genome-registry.json` SHADOW list is keyed by the `learn.mjs` composite key
(`host+model+vertical+language+task_class+genome_version`) and updated **in place** — re-running a job
for the same key never stacks duplicate winners.

## Abort conditions

- **Budget cap hit** → `budget_stop`, remaining pending jobs `deferred`, clean exit.
- **No pending jobs** → `empty`, clean exit (nothing to do).
- **Job subprocess failure** → job marked `failed` (not `done`), state persisted, batch stops; a human
  can inspect and re-flip it to `pending` to retry.
- **No `OPENROUTER_API_KEY`** → the real learn runner refuses to start (no silent $0 no-op that looks
  like success).

## How the parent arms & paces it overnight

Run **one job per wake** and let a Monitor watch the summary line:

```
# arm: one iteration per wake, Monitor the [overnight] summary line
Monitor({ command: "node gepa/overnight-train.mjs 2>&1 | grep '^\\[overnight\\]'",
          description: "overnight GEPA training — one job" })
ScheduleWakeup({ delaySeconds: 1800, prompt: "/loop run one overnight-train iteration + re-arm" })
```

Cadence: a code-repair GEPA job at `--max-cost 12` runs well inside a **30-minute** wake. Re-arm the
Monitor + ScheduleWakeup after each wake until `--status` shows no `pending` jobs (or `budget_stop`).
At $100 total / $12 per job the loop self-limits to ≲8 jobs before deferring — safe to leave unattended.

## Commands

```bash
# Run ONE iteration (default; the pacing primitive the parent re-invokes each wake)
OPENROUTER_API_KEY=… node packages/darwin-mode/bench/swebench/gepa/overnight-train.mjs

# Inspect state / queue / spend / SHADOW winners — NO spend, NO mutation
node packages/darwin-mode/bench/swebench/gepa/overnight-train.mjs --status

# Plan the next pending job without spending
node packages/darwin-mode/bench/swebench/gepa/overnight-train.mjs --dry-run

# Run several jobs with pacing between them (optional; default is one)
OPENROUTER_API_KEY=… node …/gepa/overnight-train.mjs --max-jobs 3 --sleep 60

# Re-seed a fresh state file (wipes progress) with custom caps
node …/gepa/overnight-train.mjs --reset --max-total-cost 100 --max-cost 12

# $0 unit tests (mocked learn runner — never calls GEPA/LLM)
node --test packages/darwin-mode/bench/swebench/gepa/overnight-train.test.mjs
```

Flags: `--state <file>` `--registry <file>` `--max-total-cost <$>` `--max-cost <$>` `--max-jobs <n>`
`--sleep <sec>` `--dry-run` `--status` `--reset`.
