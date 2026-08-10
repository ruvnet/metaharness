# signal-flywheel — compounding, replay-verified lift THROUGH the ADR-249 scorer seams

**Data source: `SYNTHETIC` — a mechanism proof of the signal plumbing and gate
discipline, NOT a benchmark claim and NOT model capability.** See
[Honest bounds](#honest-bounds).

## What this demonstrates

The ADR-234/235 flywheel (`runFlywheelGenerations`, the **default frozen
`meetsPromotionRule` gate** — no custom rule supplied — a holdout suite, a
never-optimized-against anchor suite, Ed25519-signed lineage,
`verifyReplayBundle`) can run its Evaluator **entirely through the new ADR-249
signal seams** of darwin-mode's frozen scorer:

1. **Trace-quality seam** — every simulated run's per-turn verifier-delta
   evidence is processed with ADR-248 `@metaharness/turn-credit`
   (`evidenceFromScorePairs` → `processTrajectory`, verifier-delta-proxy mode),
   and a `[0,1]` quality figure is derived from `creditByLabel` + the bounded
   multipliers (0.6 × outcome-aligned credit concentration + 0.4 × mean
   multiplier position in `[1−λb, 1+λb]`). That figure is injected as
   `signals.traceQuality` into `scoreVariant`.
2. **Cost seam** — deterministic abstract cost-units (tool-turns executed ×
   attempts, batching-discounted; **never wall-clock**) are injected as
   `signals.cost = { units, budgetUnits }`.

The seam-fed `ScoreCard` is projected onto the flywheel `Score` axes:
`primary = finalScore`, `noopRate` = fraction of runs that committed nothing,
`costPerWin` = units per successful run, `regressed` = safety zeroing.

The domain is a **seeded synthetic harness policy** — flywheel levers
`{retryLimit, toolOrder, contextDepth, batchMode}` driving a deterministic
simulator that emits darwin-mode `RunTrace`-shaped runs (fnv1a/mulberry32
seeded; no `Date.now()`/`Math.random()` anywhere in a measured path).

## Result (committed `bundle.json`)

- **Generations run:** 8 (32 candidates: 4 levers × 8 generations)
- **Promotions:** 2, **both anchor-surviving** → `milestone_reached: true`
- **Replay verification:** **PASS** (all six checks, including ADR-235 gate
  re-execution on the sealed scores through the library-default rule, and a
  gate-fingerprint match proving the DEFAULT gate decided every promotion)

Lift curve (holdout `primary` = seam-fed darwin `finalScore`; anchor = frozen
suite the wheel never optimizes against):

| gen | mutation                 | primary  | Δ         | anchor   | noopRate | costPerWin |
|-----|--------------------------|----------|-----------|----------|----------|------------|
| 0   | (root: 0/scatter/shallow/off) | 0.330911 | —    | 0.330580 | 1.000000 | — (0 wins) |
| 1   | `toolOrder → grounded`   | 0.330967 | +0.000056 | 0.332837 | 0.416667 | — (0 wins) |
| 2   | `contextDepth → deep`    | 0.897456 | +0.566489 | 0.627526 | 0.000000 | 7.636364   |

Root → final primary: **0.330911 → 0.897456 (×2.712077)**; final policy
`{retryLimit: 0, toolOrder: grounded, contextDepth: deep, batchMode: off}`.
The gen-2 win **compounds on** gen-1 (deep context only pays off because the
grounded tool order is already in place — `deep` under `scatter` was rejected
at gen-3 with all three score clauses failing).

The gate's rejections are the other half of the demonstration:

- **The cost seam produced a real rejection:** gen-1 `retryLimit → 1` doubled
  units (36 → 72, over the 66-unit budget) without buying a win, so the seam
  dropped `costEfficiency` to 0.916667 and `primary` **fell** below baseline →
  `primary_regressed`. Cost pressure flowed from the seam through the frozen
  gate, exactly as ADR-249 intends.
- **The no-op clause is load-bearing, both ways:** gen-1's promotion was earned
  almost entirely on `noopRate` (1.0 → 0.416667; the primary delta was
  +0.000056). And once `noopRate` hit 0, the default gate's *strict* improvement
  clause correctly refused **every** later candidate — including
  `retryLimit → 1` at primary 0.950695 (gens 3–8, `noop_rate_not_improved`).
  A higher score alone does not buy a promotion under this gate; that is the
  documented design ("a policy earns a promotion by making the executor COMMIT
  more"), reported here as-is rather than worked around with a custom rule.
- 30 of 32 candidates were rejected (rejection-reason counts:
  `noop_rate_not_improved` 28, `primary_regressed` 20, `cost_per_win_worsened`
  12; conjunctive, so one candidate can carry several; one rejected candidate —
  gen-2 `retryLimit → 2`, primary 0.667387 — actually passed every gate clause
  but lost winner selection to the higher-primary `contextDepth → deep`).
  `batchMode → on` never promoted: it cuts cost 28% but does not reduce
  no-ops — a cost-only win is not a promotion under this gate.

## Reproduce

```
node run.mjs        # runs the flywheel, rewrites bundle.json, prints measurements
node verify.mjs     # independent replay of the COMMITTED bundle; exit 0 ⇔ PASS
node run.mjs --check  # re-runs fresh and asserts byte-identity with bundle.json
```

**Determinism / byte-identity:** re-running `run.mjs` reproduces `bundle.json`
byte-for-byte **except two fields per receipt**: `receipt.signature` and
`receipt.publicKey` (the library's `makeSigner` mints a fresh per-process
Ed25519 keypair; receipts still verify against the embedded key). Nothing else
differs — `created_at`/`createdAt` are caller-supplied `SYNTHETIC#genN` labels,
not clock timestamps. `node run.mjs --check` proves this by re-running and
comparing against the committed bundle with only those two fields masked.
(`primaryDelta` values inside the bundle are raw library-computed differences;
all numbers *reported* by the runner are rounded to 6 decimals.)

## Honest bounds

- **Synthetic domain, favorable by construction.** The simulator was designed
  so that better levers genuinely produce better turn-level evidence, fewer
  no-ops, and cheaper wins. A rising lift curve here proves the **signal
  plumbing** (turn-credit → `scoreVariant` seams → flywheel `Score` axes →
  frozen default gate → signed, replayable lineage) and the **gate's
  discipline** — it is *not* evidence that any model, harness, or policy is
  better at any real task, and it reproduces no benchmark number.
- The bundle is stamped `data_source: 'SYNTHETIC'`, and `verify.mjs` fails if
  that stamp is missing. **The ADR-248 §6 LIVE acceptance gate is NOT
  satisfied by this experiment and nothing here should be read as claiming it
  is** — a live run is separate future work with its own measured evidence.
- Turn-credit ran in `verifier-delta-proxy` mode (ordinal proxy, `proxy: true`
  end to end), not AgentOPSD-proper log-prob gaps.
- The trace-quality mapping (0.6·concentration + 0.4·multiplier position) and
  the cost model (tool-turns, 5.5 units/task budget) are one defensible choice
  each, not measured optima. Per ADR-249, the injected signals are **trusted,
  not verified** by the scorer; here the producer is a seeded simulator, so
  they are reproducible by construction.
- The gen-1 primary delta (+0.000056) is within what landscape noise could
  plausibly move on a different seed set; the promotion's load-bearing clause
  was the no-op improvement, and the frozen gate — not the author — made the
  call. Equally, the post-gen-2 all-reject plateau is a *correct* outcome of
  the default gate's strict no-op clause, reported as such.
