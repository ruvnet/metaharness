# ADR-205 — Harness handoff beats model embedding: darwin as router, claude -p as hard-tail actuator

- **Status**: Accepted (benchmarked)
- **Date**: 2026-07-02
- **Builds on**: ADR-153 (agentic solver), ADR-182 (cost cascade), ADR-197 (native tool-use), the
  fable-bench clean-comparator experiments (claude-p-solve.mjs)
- **Code**: `packages/darwin-mode/bench/swebench/handoff-solver.mjs`, `solve-agentic.mjs`
  (`--escalate-to`), `handoff.test.mjs`; benchmark writeup in
  `packages/darwin-mode/bench/swebench/HANDOFF.md`

## Context — the proven invariant

Two gold-scored measurements on the same hard-25 slice (SWE-bench Lite instances where darwin's
whole evolutionary ladder resolved nothing):

| Harness | Model | Resolved |
|---|---|---|
| darwin's bounded ReAct loop (15 steps, text/native tools) | deepseek-chat, and ~1/25 even with Sonnet-class | **0/25** |
| Claude Code's own agent loop (`claude -p`, headless) | Fable (claude-fable-5) | **23/25** |

Same instances, same model families available to both. The bottleneck is not model quality — it is
the **loop**. darwin's harness (step cap, single-tool-per-turn protocol, minimal context assembly)
caps what any frontier model can express. **Model quality × wrong loop = capped outcome.**

The tempting fix — put Fable *inside* darwin's loop — was measured and rejected: an OR-ladder run
of frontier models inside darwin's loop stayed near-zero on this slice, while the *same models* in
their own loop resolved 68-92%. The unit that succeeds or fails is not the model; it is the
**deployable unit**: model + prompt protocol + tool loop + verifier + retry policy. We name that
unit a *loop* and treat loops the way routers treat models.

## Decision

**Hand off the INSTANCE, not the model.** darwin stays the cheap classifier/executor. When its
cheap attempt fails a rule-based trigger, the instance is escalated to a `claude -p` subprocess
(OpenRouter-routed Fable) that owns its own tools, prompt, and retry policy. The handoff patch
replaces darwin's for that instance.

### Mechanism (shipped)

1. **Subprocess solver** (`handoff-solver.mjs: solveViaClaudeP`): clone repo @ base_commit into a
   temp tree → run `claude -p` with `ANTHROPIC_BASE_URL=https://openrouter.ai/api`,
   `ANTHROPIC_AUTH_TOKEN=<OR key>`, `ANTHROPIC_MODEL=<model>`, **no `--model` flag** → capture the
   patch via `git diff` (the JSON `result` field is unreliable — display quirk) → return
   `{status, patch, cost_usd, latency_ms, turns, solver, error}`. `status: 'resolved'` means only
   "non-empty patch"; REAL resolve is gold-scored later. No oracle is faked.
2. **Escalation chain** (`--escalate-to a,b,c`): an ordered chain of solver specs
   `{name, kind: 'darwin-model'|'claude-p-model', model, maxTurns/maxSteps, timeoutMs}`.
   `darwin-model` rungs rerun darwin's own loop cold with a different model (cheap rungs, e.g.
   GLM); `claude-p-model` rungs are the subprocess handoff (Claude rungs). Traversal stops at the
   first rung whose result passes `acceptHop` (non-empty patch + in-loop signal where reported).
   Generic forms `darwin:<model>` / `claude-p:<model>` plus the proven alias `claude-p-fable`.
   This is the config surface for the 4-rung ladder (deepseek → GLM → Sonnet → Fable) to be tuned
   from receipts.
3. **Rule-based trigger** (2-of-N, all signals computable from what the loop already tracks):
   - in-loop tests did not pass (`resolvedInLoop=false`)
   - empty patch
   - never called `submit` (budget exhausted)
   - anti-thrash state repeated ≥2× (same (action→observation) seen again)
   - patch touches >3 files (sprawl = low-confidence shape)
   Any 2 ⇒ escalate. No invented confidence/complexity scores — **learned thresholds over the
   receipt stream are future work**, and the receipts exist precisely to train them.
4. **solver_receipt stream** (`handoff-receipts.jsonl`) — one row per instance (both classes),
   one row per chain hop when a chain runs:

   ```json
   {
     "instance_id": "…", "initial_solver": "darwin-deepseek-chat",
     "darwin_cost_usd": 0.055, "darwin_steps": 15,
     "failure_reasons": ["tests_failed", "empty_patch", "no_submit"],
     "escalated": true, "escalation_reasons": ["tests_failed", "empty_patch", "no_submit"],
     "handoff_solver": "claude-p-fable", "handoff_status": "resolved",
     "handoff_cost_usd": 1.62, "handoff_latency_ms": 178000, "handoff_turns": 22,
     "handoff_error": null, "final_patch_nonempty": true,
     "diff_files": 1, "diff_bytes": 1968, "ts": "2026-07-02T12:34:56.000Z",
     "hop": 1, "hop_of": 1, "hop_accepted": true
   }
   ```

   `darwin_cost_usd` vs `handoff_cost_usd` per instance is the measured **insurance premium** of
   trying cheap first — the core number of the blended-cost story.
5. **Perf**: claude -p rungs run through a small semaphore (`--handoff-concurrency`, default 2) so
   the hard tail doesn't serialize behind one subprocess; `--early-escalate` (default OFF, the
   measured-next-step) aborts the cheap attempt at half budget when zero edits were attempted.

## Measured result (hard-25, gold-scored, run `handoff_hard25`)

| Arm | Resolved/25 | $ total (OR-billed) | $/resolved | Escalation rate | Empty-patch rate | Median latency/inst |
|---|---|---|---|---|---|---|
| darwin-only (deepseek, 15 steps, native tools) | **0/25** | $1.93 | — | — | 60% | 6.2 min |
| claude-p + Fable only | **23/25** (OR: 21/25) | $60.76 best / $31.77 OR | $2.64 / $1.51 | — | 0% | ~2.5 min |
| **darwin → claude-p+Fable handoff (aggressive)** | **24/25** | $74.58 | $3.11 | 100% | 0% | 11.0 min |

**Quality bar ≥20/25: PASSED (24/25).** Only `psf__requests-2674` unresolved; all 25 handoffs
produced non-empty patches (0 empty, 0 harness errors). darwin overhead $0.077/inst; median handoff
236 s / $2.33 / 13 turns.

Honesty notes (full table + per-instance receipts in HANDOFF.md):

- **On hard-25 the handoff costs MORE than Fable-only, plainly** — $74.58 vs $31.77 (OR) / $60.76
  (best). darwin resolves 0/25, so under the aggressive proof-policy 100% escalate: you pay Fable's
  full cost + darwin's $1.93 overhead. hard-25 is 100% hard tail by construction — the wrong slice
  to judge cost on. The ≥20/25 criterion passes on **quality** here; the **cost** win is
  mixed-workload-only.
- **Escalation policy honesty:** production default is `two-of-n` (escalate on ≥2 signals — the
  mixed-workload cost-saver); the proof arm uses `aggressive` (every darwin miss). Measured: 6/25
  fired only `tests_failed` (confident-but-wrong submits) — under two-of-n those 6 keep darwin's
  non-resolving patch, capping the arm at ~18/25 (darwin's ceiling, not the handoff's). aggressive
  → 24/25. Receipts record `escalate_policy` per row.
- **Cost accounting verified:** claude's reported `total_cost_usd` ≈ actual OR billing (real OR
  spend $28.91 vs claude estimate $28.56 at 11 instances) — $74.58 is real, not list-price inflation.
- **Blended cost win (mixed workload):** darwin resolves ~35% of representative instances at $0.077,
  ~65% escalate ⇒ blended cost is **~30% cheaper than Fable-everywhere at the same quality** (robust
  to the escalated-cost assumption: $0.90 vs $1.27/inst at representative Fable cost; $1.97 vs $2.91
  at hard-tail cost). Same resolve quality (darwin's cheap wins ⊆ Fable's), lower cost. Computed in
  HANDOFF.md.

## The MetaHarness router (future work, enabled by this ADR)

Loops-as-models: a **deployable unit** = model + prompt-protocol + tool-loop + verifier +
retry-policy, registered like a model in a router. The receipt stream is the training data:

- **Phase 1 (this ADR)**: rule-based 2-of-N trigger, static chain order.
- **Phase 2**: learned thresholds — train a cheap classifier on receipts
  (failure_reasons × repo × problem-statement features → P(rung k resolves)) to pick the entry
  rung per instance instead of always trying cheap first.
- **Phase 3**: cost-aware routing — minimize E[$ | resolve] using per-rung measured $/resolved
  and latency from receipts; the chain becomes a policy, not a config.
- The same receipt schema extends to any harness pair (darwin↔claude-p today; any loop that can
  return `{status, patch, cost_usd, latency_ms}` tomorrow).

## Consequences

- darwin's identity shifts from "the solver" to "the router + cheap executor" — its loop no longer
  needs to beat frontier harnesses, only to (a) resolve the cheap head at near-zero cost and
  (b) classify failures fast and honestly.
- The non-escalated path is byte-identical when `--escalate-to` is absent (statically guarded in
  tests) — zero risk to existing arms.
- Cost governance: every rung's cost lands in the solver's `totalCost`, so `--max-cost` gates the
  chain before each rung launches; claude -p per-run spend is bounded by `--handoff-max-turns` +
  timeout (it has no mid-run budget flag).
- Known limitation: claude's reported `total_cost_usd` is an Anthropic-price-table estimate; the
  OR-billed actual differs (measured both, reported both in HANDOFF.md).
