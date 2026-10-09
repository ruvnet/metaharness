# Submission readiness evidence review

This is a review contract for the external Darwin/Flywheel implementation, not a
second gate. `arena.diagnose_calibration` remains descriptive and posthoc;
`arena.review` remains the separate trained-transfer gate. Neither grants Arena
submission authority. A readiness result may only authorize presenting a concrete
request for user review: `eligible_for_user_review`, never an automatic POST.

## Freeze before new outcomes

- Register the actual incumbent and applied candidate identities and source-bound
  manifests in a durable journal before either comparison block starts. Bind the
  native task IDs and named SHA256 components for `arena_env/tasks.py` and
  `arena_env/environment.py`; task IDs alone do not distinguish generator versions.
- Record exactly one implemented, allowlisted parameter change, its parent,
  proposal digest, applied source digest and rollback reference. Freeze verifier,
  reward semantics and protocol. A whole-file digest binds bytes but does not prove
  that only the generator changed: inspect the change and replay controls.
  Unsupported generator parameters and `applied:false` proposals cannot qualify.
- Avoid a digest cycle: a proposal can bind a preproposal experiment-context digest
  (incumbent, cells, execution settings and candidate budget). The later registration
  digest binds the full applied candidate, including that proposal digest.
- Freeze one equal denominator of task cells, at least four attempts per cell,
  identical incumbent/candidate seeds, and a disjoint fresh confirmation seed block.
  Candidate identity and both seed blocks precede outcomes. Do not retroactively
  call a completed run preregistered or select confirmation seeds after seeing it.
- Pin the full target checkpoint revision, tokenizer bytes, chat template or the
  explicitly labeled local serialization, thinking mode, sampling settings, runner
  digest, hardware declaration and all resource limits. Report unverified hardware
  as declared, not attested; changed or unknown comparison settings cannot silently
  become matched evidence. Local accounting does not establish parity with Arena's
  unknown production wrapper or wall budget.
  An alternate or unidentified model supplies proxy diagnostics, not target-model
  readiness; a served alias alone is insufficient checkpoint provenance.
- Freeze candidate count and total call/token/time ceilings, reserving confirmation
  capacity before exploration. The permitted budget mutation may change exactly
  one task's completion limit; retain every other setting and report the resulting
  resource difference. This is a budget ablation, not an equal-budget improvement.

## Validate retained evidence

For every registered arm, cell, seed and block, require the original retained
trajectory, its recomputed digest, source-bound manifest digest, execution settings
and prospective registration identity. Verify chronology against the journal;
timestamps added to old artifacts are insufficient. Journal signatures bind
records, not independent provider execution. Disclose that attestation boundary.

Require unique episode identities and trajectory hashes across the comparison;
reject duplicated or missing attempts instead of reducing the denominator. Verify
reset inputs, exact JSON actions, terminal observations and reward by replaying the
registered source. Preserve failed attempts and their classifications. A replay of
actions verifies task behavior, not which model produced the actions.

Each counted cell must have **all** its registered attempts complete successfully
as protocol executions, with explicit provider finish reasons and prompt/completion
usage. Exclude the entire cell from the mixed-cell numerator if any attempt has
truncation, exhausted context/generation/time budget, provider failure, malformed
action, environment error or missing terminal answer. Retain the cell in the frozen
denominator. Missing provenance, usage or finish evidence yields **HOLD**; do not
reinterpret an old `ValidationError` as a known reasoning or truncation outcome.
Do not add reasoning-token counts to provider `completion_tokens`, which generally
already includes them. Retain both supported reasoning field spellings faithfully.

The operational metric is **valid mixed-success cells**: one to three full successes
among four valid terminal attempts, with nonzero reward variance (or the analogous
interior count if a larger attempt count was frozen). A valid but non-full-reward
terminal answer is a task error. It is not proof of a particular internal reasoning
cause. Report observed reasoning text/token evidence separately, without treating a
thinking-mode flag, wrong answer or parsing failure as proof of genuine reasoning.

Review the observable answer errors before labeling mixed success as reasoning
difficulty. In the retained v2 probe, five science partials omit exactly quarantined
samples from the medians map while returning correct remaining medians and weighted
means. Clarify ambiguous completeness requirements and remeasure before accepting
such a cell as reasoning signal. A specification clarification changes the source
baseline and is not itself a measured fitness win. Keep completeness, arithmetic
and constraint errors separate; do not optimize ambiguity to increase the metric.

## Review decision

- Require strictly more valid mixed-success cells than the same incumbent on
  **both** discovery and confirmation, over the same fixed denominator. Report
  valid mixed, saturated, unsolved and excluded cells, rewards, usage and latency
  separately for both arms and blocks. No denominator pruning or cross-run bests.
- Reuse the actual Flywheel rule with a frozen, explicit mapping of these metrics;
  do not present token counts as monetary cost or invent no-op observations. Pin
  the applied rule and adapter bytes. Require passing controls and a source-matched
  artifact replay. A local metric gain does not establish trained transfer or rank.
- Four attempts per cell are a diagnostic screen, not a precise success-probability
  estimate. Retain all candidates and rejected outcomes; honor the frozen candidate
  budget and fresh confirmation rather than making unsupported significance claims.
- Return **HOLD** for absent, legacy, incompatible, unauditable or incomplete
  evidence. Report why, preserve the incumbent and keep publication/submission
  capabilities absent. A passing receipt only permits the separate user review.

The retained v1 receipts lack source binding, finish reasons and prospective
registration. Their honest use is the existing posthoc diagnostic. The current v2
run likewise cannot acquire missing preregistration retrospectively. Neither is a
favorable readiness precedent; qualifying evidence must be collected prospectively.
