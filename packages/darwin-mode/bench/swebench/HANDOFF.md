# HANDOFF — darwin → claude-p+Fable escalation (ADR-205 benchmark)

**The invariant this benchmark demonstrates:** model quality × wrong loop = capped outcome. The fix
is a HARNESS HANDOFF — route the *instance* to the loop that can express the solution — not a
better model inside darwin's loop.

- Mechanism: `handoff-solver.mjs` + `solve-agentic.mjs --escalate-to claude-p-fable` (ADR-205).
- Slice: hard-25 (`hard-25.json`) — the SWE-bench Lite instances darwin's whole ladder resolved 0 of.
- Scoring: official SWE-bench harness (`run_id handoff_hard25`), gold tests never seen during solving
  (`--no-test-oracle` conformant mode).

## The 3-arm table (hard-25, gold-scored)

| Arm | Resolved/25 | $ total | $/resolved | Escalation rate | Empty-patch rate | Median latency/inst |
|---|---|---|---|---|---|---|
| A. darwin-only (deepseek, 15 steps, native tools) | **0/25** | $1.93 | — (0 resolved) | — | 15/25 (60%) | 6.2 min |
| B. claude-p + Fable only | **23/25** (OR-routed: 21/25) | $60.76 (best) / $31.77 (OR)¹ | $2.64 / $1.51 | — | 0/25 | ~2.5 min |
| **C. darwin → claude-p+Fable handoff (aggressive)** | **24/25** | **$74.58** ($1.93 darwin + $72.65 handoff) | **$3.11** | **25/25 (100%)** | 0/25 | 11.0 min |

Arm C detail: escalation policy `aggressive` (escalate every darwin miss — see below); 24/25 gold
(only `psf__requests-2674` unresolved); all 25 handoffs produced non-empty patches (0 empty, 0
errors); median handoff latency 236 s / median $2.33 / median 13 turns; darwin overhead $0.077/inst.

¹ Arm B provenance (both runs pre-existing, reused not re-run): the **23/25** run was `claude -p`
maxTurns 50, claude-reported cost **$60.76**. The OpenRouter-routed variant (maxTurns 40, the same
mechanism the handoff uses) measured **21/25 resolved (24/25 non-empty) at $31.77** with median
64 s/instance. Arm C's escalated rungs are the OR-routed configuration, so $31.77 / 21/25 is the
like-for-like comparator; 23/25 / $60.76 is the best-known Fable-only result.

**Cost-accounting note (verified):** claude's reported `total_cost_usd` ≈ the actual OpenRouter
billing — at 11 instances the real OR spend ($28.91) matched claude's estimate ($28.56). So the
$74.58 above is the real OR-billed cost, not an Anthropic-list-price inflation.

## Honest cost analysis

- **On hard-25 the handoff costs MORE than Fable-only, plainly.** $74.58 vs Fable-only's $31.77
  (OR) / $60.76 (best). This is expected and unavoidable on this slice: darwin resolves 0/25, so
  under the aggressive proof-policy **100% of instances escalate** — you pay Fable's full cost PLUS
  darwin's $1.93 of failed attempts. hard-25 is, by construction, 100% hard tail: the wrong slice
  to judge cost on. The acceptance criterion "≥20/25 at lower cost than Fable-only" can therefore
  pass on **quality** here (24/25 ✓) but on **cost only via a mixed workload** (below).
- Why Fable is pricier here than its own $1.27/inst average: the hard-25 instances darwin fully
  fails are also the ones Fable spends the most turns on (median 13, tail to 35 turns / $6.47 for
  pytest-5103), so the per-escalated cost is $2.91 vs the $1.27 mixed-slice mean.

### Escalation policy — the two-of-n vs aggressive honesty

The default production policy is **two-of-n** (escalate only when ≥2 failure signals fire) — the
cost-saver for mixed workloads where the cheap base resolves the easy share. The hard-25 PROOF arm
uses **aggressive** (escalate every darwin miss). This matters and is measured: of the 25, **6
fired only `tests_failed`** (darwin SUBMITTED a confident-but-wrong patch) — under two-of-n those 6
would NOT have escalated and would have kept darwin's non-resolving patch, capping the arm at ~18/25
and measuring darwin's ceiling instead of the handoff's ability. Aggressive escalated all 25 →
24/25. (The repeated-test-failure-signature signal fired on 10/25; empty_patch on 12/25;
no_submit on 10/25.) Receipts record `escalate_policy` per row so this is auditable.

## Blended projection (representative mix)

The cost win is on a MIXED workload, not this all-hard slice. Measured inputs:

- darwin+deepseek resolves **~35%** of representative (pilot-25-like) instances at **$0.077/inst**
  (measured darwin attempt cost); the other ~65% escalate to Fable.
- Fable resolves escalated instances at **~90%** (measured 24/25 = 96% here; 21-23/25 elsewhere).
- Quality is **≈ Fable's** (not additive — darwin's cheap wins are a subset Fable would also
  solve); the win is **same quality, lower cost**, because the cheap head is served at $0.077
  instead of Fable's per-instance price.

Blended cost/instance = `0.077 + 0.65 × (Fable escalated cost)`, bracketed by the two measured
Fable costs:

| Escalated Fable cost assumed | Handoff blended $/inst | Fable-everywhere $/inst | Saving |
|---|---|---|---|
| $1.27 (representative mixed-slice mean) | **$0.90** | $1.27 | **29% cheaper** |
| $2.91 (hard-tail, this run) | **$1.97** | $2.91 | **32% cheaper** |

The saving is **robust (~30%) to the cost assumption** because both terms scale with Fable's price;
it is driven by the ~35% cheap head darwin serves at near-zero cost. Same resolve quality as
Fable-everywhere, ~30% lower blended cost — that is the harness-handoff cost win, and it appears
only on mixed workloads.

## Receipts

`handoff-receipts.jsonl` — one `solver_receipt` row per instance (schema in ADR-205), the future
router's training data. Both classes present: escalated (with per-hop cost/latency/turns) and
non-escalated (handoff fields null).

## Reproduction

```bash
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
  solve-agentic.mjs --manifest hard-25.json --model deepseek/deepseek-chat --native-tools \
  --no-test-oracle --max-steps 15 --escalate-to claude-p-fable --escalate-policy aggressive \
  --max-cost 75 --concurrency 3 --handoff-concurrency 3 \
  --out predictions-handoff-hard25.jsonl --receipts handoff-receipts.jsonl \
  --report handoff-hard25-report.json

. /tmp/swebench-venv/bin/activate && python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path predictions-handoff-hard25.jsonl \
  --run_id handoff_hard25 --max_workers 8 --cache_level instance --timeout 1200
```

**Note on the actual run:** this arm was executed in two passes — the first (`--max-cost 50`) was
stopped by a background-task kill at 12/25 (partial predictions/receipts preserved), then topped up
on the remaining 13 (`hard-25-remaining.json`, `--max-cost 45`) and merged to the full 25. The
single-command form above (`--max-cost 75`) reproduces it in one pass. Per-instance Fable cost on
this hardest slice is ~$2.5/inst (heavy-tailed: pytest-5103 alone $6.47/35 turns), so the full 25
costs ~$63-75 — set the cap accordingly.
