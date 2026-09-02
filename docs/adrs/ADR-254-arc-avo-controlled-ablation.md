# ADR-254: ARC specific AVO loop and controlled ablation

**Status**: Implemented experimentally; synthetic mechanism gate passed; one actor-declared-clean live smoke favored AVO; full official gate pending
**Date**: 2026-08-22
**Project**: `ruvnet/metaharness`
**Related**: ADR-251, ADR-253

## Context

An undocumented preliminary paired ARC smoke did not show a score gain. The
existing harness sometimes used fewer environment actions but took longer and
committed neither semantic rules nor a supervisor directive. Because no compact
artifact was retained, those preliminary values are motivation rather than
benchmark evidence. The controller detected supervisor cases after actions, but
an actor could continue without resolving them. Memory and supervision
therefore existed as optional tools rather than enforced parts of the control
loop.

NVIDIA reports that AVO completed the 25 environment ARC public set with a
100.00 RHAE score using exact 64 by 64 text grids, persistent memory,
supervision, and a long horizon agent loop. NVIDIA explicitly describes this as
direct interaction rather than an ARC specific executable world model. ADR-253
incorrectly attributed an executable world model to the NVIDIA ARC result. This
ADR corrects that statement. Retrodiction remains a useful MetaHarness
extension, but it is a separate ablation arm and not part of the NVIDIA-reported
AVO profile.

The generic `@metaharness/avo` operator cannot directly own a live ARC session.
Its repository environment assumes forkable workspaces and rollback, while an
online ARC transition is irreversible. ARC therefore needs a domain specific
AVO loop over the existing authoritative controller and receipt chain.

## Decision

Add an ARC specific `ArcAvoLoop` that privately composes `ArcController`. The
planner proposes bounded candidate plans. The harness validates and snapshots
them, calculates utility from observed evidence, selects exactly one candidate,
executes only a selected action, evaluates the resulting transition receipt,
updates rule evidence, and advances an immutable lineage.

The controller remains authoritative for exact observations, compare and set
guards, action legality, budgets, idempotency, memory scope, supervisor
directives, receipt chaining, checkpoints, and environment ownership. Cognitive
features may be ablated. Governance and evidence integrity may not be ablated.

The named experimental arms are:

1. `DIRECT_ACTOR`
2. `AVO_LINEAGE`
3. `AVO_MEMORY`
4. `AVO_SUPERVISOR_MEMORY`
5. `AVO_FULL`
6. `AVO_FULL_RETRODICTION`
7. `CUSTOM`, allowed only for explicitly frozen research configurations

Named arms resolve to immutable feature profiles. Only `CUSTOM` accepts feature
overrides. Each resolved profile has a canonical configuration hash bound into
AVO selections, outcomes, checkpoints, and benchmark manifests.

## State machine

For every decision, the loop performs these transitions:

1. Read the exact current observation and bounded evidence context.
2. Resolve any open blocking supervisor case. An injected supervisor receives a
   deep copy. Without one, the external boss lane must commit a valid directive.
3. Give a deep copied context to the planner.
4. Validate candidate parentage, current observation hashes, cited rules,
   action legality, numeric bounds, and guarded postconditions.
5. Score every candidate deterministically. Model-supplied numeric utility is
   never accepted; submitted order is only a final ordinal tie-break.
6. Persist a selection binding the complete candidate set and configuration.
7. Dispatch only the selected first action unless all later steps have exact
   postconditions.
8. Bind the authoritative transition receipt to the selected candidate.
9. Optionally retrodict, then support or contradict cited rules using configured
   error thresholds.
10. Persist the outcome and advance the lineage head.

An unresolved blocking supervisor case returns `SUPERVISION_REQUIRED` before an
action intent is logged or an environment mutation is dispatched.

## Selection

The default deterministic utility is:

```text
U = 0.45 expectedProgress
  + 0.20 predictionFit
  + 0.20 novelty
  + 0.15 ruleConfidence
  - 0.20 noEffectRisk
  - 0.10 normalizedActionCost
```

Ties prefer fewer steps, then the planner's submitted order, then the lexical
candidate identifier. Candidate order cannot override an evidence-derived
utility difference. Candidate
objects are immutable and content addressed. Every non-root parent must already
exist. A selection binds the full candidate set, not only the winner. An outcome
binds the selection, controller receipt, and optional retrodiction receipt.

## Retrodiction extension

`AVO_FULL_RETRODICTION` compares the selected plan prediction with the observed
controller receipt. A prediction error at or below 0.20 supports cited rules. An
error at or above 0.60 contradicts them. Intermediate values are inconclusive.
Idempotent replay cannot create another retrodiction or rule version.

This arm is reported separately from `AVO_FULL`. It tests whether an explicit
evidence update adds value beyond the NVIDIA-inspired direct-interaction structure.

## Security and governance

The planner and supervisor are untrusted. They receive deep copied state and
cannot mutate controller authority, configuration, budgets, capabilities,
receipt history, rule evidence, or utility calculations. Hidden game identity
remains prohibited at every public boundary. Invalid candidates, foreign rules,
stale observations, unknown parents, injected scores, non-finite numbers, and
unselected actions fail before environment mutation.

The generic AVO runtime must also bind evaluation evidence to the exact branch
and workspace digest. A green evaluation cannot authorize a commit after an
edit or branch switch, and a promoted lineage node must refer to an immutable
snapshot.

## Benchmark contract

Mechanism tests use a deterministic fixture to prove that the bundled governed
candidate-selection mechanism changes behavior while all arms share one
environment, action budget, and base policy. The current three-arm test does not
isolate the individual causal contribution of lineage, memory, or blocking
supervision. These tests cannot support a public ARC score or an intelligence
claim.

Live evaluation uses paired games and seeds with the same frozen model,
reasoning setting, prompts, tool schema, action budget, model turn budget, and
wall time. Order is randomized between A then B and B then A. Replicates use
separate scorecards because a scorecard can retain a best run and bias repeated
measurements.

The primary statistic is paired per game RHAE difference. Confidence intervals
use a game clustered bootstrap, and the null test uses a seeded paired sign flip
permutation. Levels are not treated as independent samples.

## Claim gate

The implementation may claim improved ARC system performance only when all of
these conditions hold:

1. Mean official RHAE improves by at least 10 points over `DIRECT_ACTOR`.
2. The lower bound of the game clustered 95 percent confidence interval is
   greater than zero.
3. Every official episode reconciles its scorecard, action counts, receipt
   chain, session log, and independent evidence anchor.
4. Score per model turn degrades by no more than 25 percent.
5. The frozen controller and prompts run across all 25 public games without
   game specific edits.

Until this gate passes, results must be labelled as mechanism tests or paired
smoke tests. Better action efficiency alone is not evidence that the underlying
model became intrinsically more intelligent.

## Implemented mechanism evidence

The frozen `causal-escape-v1` mechanism benchmark ran 18 paired replicates
across six fixture-task clusters. AVO won 18 of 18 episodes with a mean 2.333
actions. `DIRECT_ACTOR` and the compute-matched direct-reflection control each
won 0 of 18 and used a mean 8 actions. Against direct reflection, mean paired
score improved by 100 points, the fixture-task-clustered 95 percent interval was
[100, 100], and the exact one-sided cluster sign-flip p-value was 0.015625.

All receipt, paired-observation, complete-usage, zero-failed-call,
compute-protocol, bounded-compute, and no-error checks passed. Two independent runs produced
the same deterministic evidence hash:
`854514a34bd1ed9679d8ef37b5c16005daa0c19738a96ef35a30589099db91e4`.
The complete report is stored at
`packages/arc-agi-3-bench/results/mechanism-v1.json`.

This passes the synthetic mechanism gate only. The fixture intentionally makes
diversification, receipted novelty, and blocking supervision causally useful;
it is not an official ARC score and does not establish an increase in the base
model's intrinsic intelligence. The 25-game official claim gate above remains
unchanged.

## Paired live smoke evidence: failed gate

A later single-game, seed-zero online smoke compared `DIRECT_ACTOR` with
`AVO_FULL` under the same 80-action cap. Both arms ended `NOT_FINISHED`,
completed one of seven levels, scored 3.5714285714, used 80 actions across 80
decisions, and retained valid 80-receipt chains. AVO committed five supervisor
directives and 80 candidate rules; neither produced a score gain. Concurrent
interactive wall times were 1,182,362 milliseconds for direct and 1,438,739
milliseconds for AVO, about 21.7 percent slower for AVO, but those noisy values
include actor latency and are not a harness-only timing comparison.

This unreplicated, non-competition-mode pair failed the frozen live claim gate
and is not an intelligence or performance win. Its redacted compact record is
`packages/arc-agi-3-bench/results/live-smoke-v2-paired.json`.

A subsequent actor-declared-clean rerun used separate actors that declared no web search,
repository/source inspection, other-run inspection, prior trajectory knowledge,
or subagents. Both received only the same strict protocol schema after
validation errors at zero environment actions. `AVO_FULL` scored 3.267620848
versus 0.396825397 for `DIRECT_ACTOR`, an absolute +2.870795451 difference.
Both still completed only one of seven levels and exhausted all 80 actions, but
AVO reached level one in 23 actions versus 66, a 43-action (65.15 percent)
reduction. Both 80-receipt chains verified; AVO retained four reusable rules and
committed no supervisor directive.

This is encouraging online evidence that the governed search condition changed
effective behavior, but it still fails the official claim gate: one game has no
clustered confidence interval or permutation test, model usage was unavailable,
competition mode was disabled, and the score delta was below the required ten
points. The hashed compact record is
`packages/arc-agi-3-bench/results/live-smoke-v3b-clean-paired.json`.

The separate long-horizon infrastructure probe completed and restored 6,624
`AVO_FULL` actions with complete receipt/candidate/selection/outcome coverage
and an exact checkpoint-hash match. The checked descriptor remained below its
64 MiB bound. The checked current-tree durability probe records phase timings
for one local run; it validates completion and scaling only and is not a causal
before/after performance estimate or a planning-quality/model-intelligence
result. Two fresh runs produced the same deterministic infrastructure evidence
hash, `332d1cfd8633ae69e0b5c32663ee4c4eef4cef3f162f4c80761f017108765d09`,
while their identity-bound checkpoint and timing fields differed as expected.
The checked current-tree result is stored at
`packages/arc-agi-3-bench/results/long-horizon-v1.json`.

## Rollback

The existing `ArcController` remains available for legacy callers. The new loop
is selected explicitly through a frozen configuration. Rolling back removes the
AVO adapter and returns the ChatGPT MCP factory to the legacy controller without
changing the official Python bridge or receipt format.

## References

1. NVIDIA, “AVO: Agentic Variation Operators for Autonomous Evolutionary
   Search,” arXiv:2603.24517.
2. NVIDIA, “NVIDIA AVO Reaches 100% on ARC-AGI-3,” 2026-08-21.
3. ARC Prize, “ARC-AGI-3 Scoring Methodology.”
4. OpenAI, “ChatGPT Developer mode” and “Working with evals.”
