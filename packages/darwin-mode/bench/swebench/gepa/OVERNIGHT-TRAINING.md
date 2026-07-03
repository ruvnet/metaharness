# Overnight GEPA Training Loop (`overnight-train.mjs`)

A **resumable, concurrent, budget-governed** training loop over the GEPA learning system (ADR-228). It
runs autonomously across the night and across session restarts: each wake drains as many pending
training jobs as the budget allows — running up to `--concurrency N` at once — records durable state,
and exits. A new session picks up mid-queue by reading the state file — no re-bootstrapping, no
duplicate spend. Rollouts can run **direct against OpenRouter** (default) or **through the cognitum
meta-llm Completions API gateway** (`--via-gateway`) for host-normalization, a shared cache, and
central metering with a server-side budget backstop.

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

## Concurrency (`--concurrency N`, default 4)

Instead of one job per wake, a **bounded pool** runs up to `N` queue jobs at once (each job's own
rollouts are *already* concurrent inside `evaluate-genome`, so this is concurrency-of-concurrency). The
pool:

- **Claims** the next `pending` job only if it fits the **shared reservation budget gate**:
  `cumulativeSpend + reservedSpend(in-flight) + this-job-reserve ≤ max-total-cost`. This is what stops
  `N` concurrent jobs from *collectively* overspending the client-side cap — reservations are held for
  every in-flight job, not just committed spend.
- **Commits** actual cost when a job finishes (reconciling the reservation), then claims the next.
- On a **429 / budget-reject** (a *deferrable* error) the job is marked `deferred` with an exponential
  backoff (capped 60 s) — **not** `failed` — so a later wake retries it.
- On a **hard error** the job is `failed` but the other in-flight jobs still complete (they're
  independent).
- `--max-jobs N` caps how many jobs launch **this wake** (default `0` = drain the affordable queue).
- A crash mid-pool leaves jobs `in_progress`; on the next load `reclaimInProgress` flips them back to
  `pending` so they're retried, never orphaned.

## Gateway backend (`--via-gateway`)

By default rollouts + the reflection call go **direct to OpenRouter** (`OPENROUTER_API_KEY`).
`--via-gateway` routes them through the **cognitum meta-llm Completions API** (ADR-203/204) instead:

- Base URL `https://apicompletions-63rzcdswba-uc.a.run.app/v1`, key from **`COGNITUM_DEV_KEY`** (env
  only — **never logged or persisted**; fetch it from the `COGNITUM_TEST_API_KEY` GCP secret), model
  **`cognitum-low`** (routes server-side to the governed cheap tier, glm-5.2).
- The flags flow down the whole chain: `overnight-train → learn.mjs → run-gepa.mjs →
  evaluate-genome.mjs → solve-advisor.mjs`, all via `--base-url` + `--api-key-env` (+ `--model`).
- **Benefits:** host-normalization; a shared response/prompt cache on the common genome prefix; central
  metering in the `usage_ledger` (`GET /v1/usage`); and a **server-side Reserve-and-Commit budget +
  rate-limits** that govern the *aggregate* — so even many concurrent training jobs can't collectively
  overspend, on top of the client-side gate.
- Override any piece with `--base-url` / `--api-key-env` / `--model` (e.g. `--model cognitum-mid`).

### API vs MCP

Use the **HTTP Completions API** (`--via-gateway`) for **bulk, unattended rollouts** like this loop —
it's the metered, rate-limited, cacheable path with a server-side budget backstop. Use the **MCP
tools** (`ToolSearch` → `metaharness_*`, `memory_*`, etc.) for **interactive development** inside a
Claude Code session, where you want tool-call ergonomics and shared conversational state, not a
high-throughput firehose.

## Budget governance

- `--max-total-cost` (default **$100**) — global cap for the whole overnight run (**client-side**).
- `--max-cost` (default **$12**) — per-job cap (also passed to `learn.mjs --max-cost`).
- The reserve-before-run gate means the loop **never exceeds** `--max-total-cost`, even with
  `--concurrency > 1` (reservations cover every in-flight job). When the cap is reached, the current +
  remaining pending jobs become `deferred` (recorded, not lost) and the loop stops.
- With `--via-gateway` the gateway's **server-side** Reserve-and-Commit budget is a second, independent
  backstop: a 429/budget-reject there surfaces as a `deferred` job (retried later), never an overspend.

## Resume mechanism (the state file)

`gepa/runs/overnight-train-state.json` holds `{ version, createdAt, updatedAt, maxTotalCost,
perJobMaxCost, cumulativeSpend, queue[], log[] }`. State is persisted **after every iteration**, so a
crash mid-queue is still resumable (the pool persists after **every** job commit). On restart the loop
**skips every job whose status is not `pending`** — i.e. `done`, `in_progress_elsewhere`, `deferred`,
`placeholder`, `failed` are all left untouched — and **reclaims** any `in_progress` job a crashed pool
left behind (flipping it back to `pending`). A new session therefore continues exactly where the last
stopped, with zero re-spend. The
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

Each wake **drains the affordable queue concurrently**, then a Monitor watches the summary lines:

```
# arm: gateway-governed, up to 4 jobs at once, Monitor the [overnight] summary lines
Monitor({ command: "COGNITUM_DEV_KEY=$(gcloud secrets versions access latest --secret=COGNITUM_TEST_API_KEY --project=cognitum-20260110) \
                    node gepa/overnight-train.mjs --via-gateway --concurrency 4 2>&1 | grep '^\\[overnight\\]'",
          description: "overnight GEPA training — concurrent, gateway-governed" })
ScheduleWakeup({ delaySeconds: 1800, prompt: "/loop run one overnight-train wake + re-arm" })
```

Cadence: a code-repair GEPA job at `--max-cost 12` runs well inside a **30-minute** wake; with
`--concurrency 4` a wake retires up to four in parallel. Re-arm the Monitor + ScheduleWakeup after each
wake until `--status` shows no `pending` jobs. At $100 total / $12 per job the loop self-limits to ≲8
jobs before deferring — and with `--via-gateway` the server-side budget is a second backstop — so it's
safe to leave unattended.

## Commands

```bash
# ONE WAKE, direct OpenRouter, concurrency 4 (drains the affordable queue)
OPENROUTER_API_KEY=… node packages/darwin-mode/bench/swebench/gepa/overnight-train.mjs --concurrency 4

# ONE WAKE, gateway-governed + concurrent (key from env, NEVER logged)
COGNITUM_DEV_KEY=$(gcloud secrets versions access latest --secret=COGNITUM_TEST_API_KEY --project=cognitum-20260110) \
  node …/gepa/overnight-train.mjs --via-gateway --concurrency 4

# Inspect state / queue / spend / SHADOW winners — NO spend, NO mutation
node …/gepa/overnight-train.mjs --status

# Plan the affordable pending jobs without spending
node …/gepa/overnight-train.mjs --dry-run

# Cap how many jobs launch this wake (e.g. 2), still up to --concurrency in parallel
OPENROUTER_API_KEY=… node …/gepa/overnight-train.mjs --max-jobs 2 --concurrency 2

# Re-seed a fresh state file (wipes progress) with custom caps
node …/gepa/overnight-train.mjs --reset --max-total-cost 100 --max-cost 12

# Gateway WIRING smoke — 2 trivial jobs, proves routing + metering (≤$0.001, no GEPA/Docker)
COGNITUM_DEV_KEY=… node …/gepa/overnight-train.mjs --via-gateway --smoke --reset \
  --state gepa/runs/smoke-state.json --max-total-cost 0.20
COGNITUM_DEV_KEY=… node …/gepa/overnight-train.mjs --via-gateway --smoke --concurrency 2 \
  --state gepa/runs/smoke-state.json --max-total-cost 0.20

# $0 unit tests (mocked learn runner — never calls GEPA/LLM)
node --test packages/darwin-mode/bench/swebench/gepa/overnight-train.test.mjs
```

Flags: `--state <file>` `--registry <file>` `--max-total-cost <$>` `--max-cost <$>` `--concurrency <n>`
`--max-jobs <n>` `--via-gateway` `--base-url <url>` `--api-key-env <ENV>` `--model <name>` `--smoke`
`--dry-run` `--status` `--reset`.
