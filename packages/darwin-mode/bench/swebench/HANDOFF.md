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
| A. darwin-only (deepseek, 15 steps, native tools) | **0/25** | $1.98 | — (0 resolved) | — | 15/25 (60%) | 6.2 min |
| B. claude-p + Fable only | **23/25** | $60.76 (Anthropic est.)¹ | $2.64 | — | 0/25 | ~2.5 min |
| C. darwin → claude-p+Fable handoff | **TBD/25** | $TBD | $TBD | TBD% | TBD | TBD |

¹ Arm B provenance (both runs pre-existing, reused not re-run): the 23/25 run was `claude -p`
maxTurns 50 with claude-reported cost $60.76 (Anthropic price table). The OpenRouter-routed
variant (maxTurns 40, same mechanism the handoff uses) measured **21/25 resolved (24/25 non-empty)
at $31.77 OR-billed** with median 64 s/instance. The handoff's escalated rungs are the OR-routed
configuration, so $31.77 / 21/25 is the like-for-like comparator; 23/25 / $60.76 is the
best-known Fable-only result.

## Honest cost analysis

TBD after gold scoring. The expectations to check against:

- On hard-25 darwin resolves ~0, so escalated instances pay **darwin's failed attempt + the full
  Fable cost**. If the handoff costs more than Fable-only on this slice — say so plainly (it
  should, by roughly darwin's ~$0.08/inst overhead). The acceptance criterion "≥20/25 at lower
  cost than Fable-only" can only pass on cost via a mixed workload.
- Escalation-rate honesty: the 2-of-N rules are v1. Pre-run analysis of the prior darwin hard-25
  report predicted ~16/25 escalation from the four report-computable signals (darwin often SUBMITS
  a confident-but-wrong patch = only `tests_failed` fires); the repeated-test-failure-signature
  signal (implemented from the trajectory) was expected to add more. The measured rate is reported
  above, and every non-escalated darwin-kept miss is charged against the quality bar.

## Blended projection (representative mix)

TBD — computed from measured values:

- darwin+deepseek resolves ~35% of representative (pilot-25-like) instances at ~$0.03-0.08/inst.
- Escalated fraction pays the measured mean handoff cost/instance from arm C.
- Compare blended $/resolved vs Fable-everywhere $/resolved.

## Receipts

`handoff-receipts.jsonl` — one `solver_receipt` row per instance (schema in ADR-205), the future
router's training data. Both classes present: escalated (with per-hop cost/latency/turns) and
non-escalated (handoff fields null).

## Reproduction

```bash
OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
  solve-agentic.mjs --manifest hard-25.json --model deepseek/deepseek-chat --native-tools \
  --no-test-oracle --max-steps 15 --escalate-to claude-p-fable --max-cost 45 \
  --concurrency 3 --handoff-concurrency 3 \
  --out predictions-handoff-hard25.jsonl --receipts handoff-receipts.jsonl \
  --report handoff-hard25-report.json

. /tmp/swebench-venv/bin/activate && python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path predictions-handoff-hard25.jsonl \
  --run_id handoff_hard25 --max_workers 8 --cache_level instance --timeout 1200
```
