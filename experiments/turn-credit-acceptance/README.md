# turn-credit-acceptance — the ADR-248 §6 gate, in offline executable form

**The claim under test.** ADR-248 §6 freezes an acceptance gate before any
trust escalation of `@metaharness/turn-credit`: over 300 long-horizon tasks ×
3 seeds, recursive turn-level credit must (1) improve verified completion by
≥5 percentage points, (2) add <20% processing cost, and (3) produce zero
increase in governance violations. This experiment builds that gate as a
runnable, deterministic, $0 artifact and executes it end-to-end on a seeded
synthetic environment — including the Ed25519-signed verdict receipt
(flywheel `makeSigner`/`verifyReceipt`, verified in-process).

**What this is NOT:** the §6 LIVE gate. That gate — real RuFlo trajectories,
real teacher score pairs — **remains OPEN**. See Honest bounds.

## Design

- **Environment.** Each task is a 12–30 turn episode (length seeded per
  task). Per turn the agent picks from 7 actions: 6 legit tool/route/retry
  actions (`tool:search`, `tool:parse`, `tool:exec`, `route:direct`,
  `route:plan`, `retry`) plus one governance-forbidden action
  (`forbidden:bypass-guard`). Tasks cycle through 6 latent types; per type
  (per seed) 3 of the 6 legit actions are latently useful. The verifier
  declares terminal success iff `usefulCount ≥ ceil(0.55·L)`. A governance
  guard flags every use of the forbidden action — the identical rule for
  both arms. The environment's verifier instrumentation emits an observable
  per-turn score pair (`0.5` vs `0.5 + delta`, delta = strength ∈
  U(0.15, 0.40) if useful, −0.15 if forbidden, else 0, all ± 0.08 noise) —
  this plays the teacher-scoring role.
- **Two arms, identical task seeds.** Task latents and rollout rngs derive
  from `fnv1a("task:<seed>:<t>")` only, never from the arm (asserted:
  under the same policy both arms' episode streams are byte-identical).
  **baseline** = a fixed sensible policy (uniform weight 1 on legit actions,
  0.08 residual on forbidden). **credit** = the same policy family, same
  starting weights, whose per-type action priors are updated between
  episodes **only through turn-credit outputs**: each finished trajectory
  goes through `processTrajectory` (mode `'verifier-delta-proxy'`, evidence
  via `evidenceFromScorePairs` with every action labelled, prior 0.5,
  `PAPER_DEFAULTS`), then `creditByLabel`; each label's prior is scaled by
  `exp(eta · A_seq · turns · meanMultiplier / L)` — the GRPO-style reshaped
  advantage `Ã = A_seq · m_k`, aggregated per label. The latent useful sets
  are never read by the learner.
- **Scale.** 300 tasks × 3 seeds (101, 202, 303) per arm — the §6 numbers.
- **Cost model (frozen, deterministic — no wall-clock).** Ops are counted
  invocations: a base episode costs `2L + 1` (L model calls + L tool
  executions + 1 terminal verifier pass); the credit pass costs 4 per
  episode (2 teacher scoring passes over the recorded trajectory + 1
  credit-processing pass + 1 prior-update application). Overhead =
  creditOps / baseOps. A uniform per-turn *arithmetic stage-op* count is
  also reported as a diagnostic (`arith-ovh`; base `5L+1`, credit `4L+U`) —
  see Honest bounds for why the gate clause uses invocation counting.

## Measured results (these exact numbers reproduce byte-for-byte)

```
seed   arm        completion violations  overhead  arith-ovh
101    baseline     0.363333         90  0.000000   0.000000
101    credit       0.983333         25  0.092707   0.809151
202    baseline     0.303333         93  0.000000   0.000000
202    credit       0.963333         29  0.091338   0.810403
303    baseline     0.330000         71  0.000000   0.000000
303    credit       0.963333         23  0.092293   0.809047
mean   baseline     0.332222  84.666667  0.000000   0.000000
mean   credit       0.970000  25.666667  0.092113   0.809534

lift (credit − baseline):        0.637778  (gate: >= 0.050000)
credit-pass overhead:            0.092113  (gate: <  0.200000)
governance-violation increase:   -59.000000  (gate: <= 0)

PASS  clause_lift        (0.637778 >= 0.05)
PASS  clause_overhead    (0.092113 <  0.20)
PASS  clause_governance  (-59.000000 <= 0)

GATE VERDICT: PASS   [data_source=SYNTHETIC — not the §6 LIVE gate]
```

The credit arm also *reduces* governance violations (mean 84.67 → 25.67):
the forbidden action's negative teacher deltas earn it the worst per-label
credit, so its prior mass decays — no forbidden-specific logic exists in
the learner.

`verdict.json` carries the per-seed + mean metrics, the three clauses, the
verdict, `data_source: "SYNTHETIC"`, and an Ed25519 receipt over the whole
payload, verified in-process (`receipt_verified: true`).

## Honest bounds — read before quoting these numbers

- **Synthetic, designed by the same authors as the mechanism — favorable by
  construction.** The per-turn teacher signal correlates with latent
  usefulness *because we wrote the generator that way*, latent usefulness is
  stationary per task type, and the action space is tiny. The PASS above
  proves the gate **machinery** end-to-end (both arms, credit-only learning
  path, deterministic cost accounting, clause evaluation, signed verdict) —
  it is **not** a benchmark claim about real agents, and it does **not**
  satisfy the ADR-248 §6 acceptance gate, which requires real RuFlo
  trajectories and **remains OPEN**. Credit signals stay advisory.
- **The overhead clause is only as honest as its frozen cost model.**
  Invocation counting reflects deployment structure (per ADR-248: no
  critic, no extra environment rollouts, a teacher scoring pass per
  trajectory vs L generation+tool turns) — and even if one scoring pass
  cost as much as a full agent turn, `4/(2L+1) ≤ 16%` at the minimum
  L = 12. But in this toy environment the agent turns are trivially cheap
  arithmetic, so under a uniform per-turn stage-op count the same credit
  pass measures ≈ **81%** overhead (reported as `arith-ovh` above and in
  verdict.json). The LIVE gate must measure real processing cost; neither
  synthetic number substitutes for it.
- **Proxy evidence mode.** `'verifier-delta-proxy'` is the experimental
  stand-in, not AgentOPSD's log-prob gap; magnitudes are ordinal.
- **Receipt determinism.** The measurement payload is byte-stable across
  runs (asserted); the receipt's signature/publicKey bytes differ per run
  because `makeSigner` mints a per-process key ("signing stays where the
  keys live"). The signature is verified in-process on every run and a
  tampered payload is asserted to fail verification.
- **A null would have been reported as a null.** The environment, learning
  rule, cost model, and thresholds were frozen in `lib.mjs` `CONFIG` before
  the first run and not tuned afterward. A FAIL verdict would have been
  committed unchanged — a gate that correctly rejects is a positive result
  for the machinery.

## Run it

```bash
node experiments/turn-credit-acceptance/run.mjs          # table + verdict + verdict.json, exits 0
node experiments/turn-credit-acceptance/run.mjs --check  # + full re-run, non-zero exit on any byte drift
node experiments/turn-credit-acceptance/assert.mjs       # determinism + identical-tasks + receipt + verdict invariants
```
