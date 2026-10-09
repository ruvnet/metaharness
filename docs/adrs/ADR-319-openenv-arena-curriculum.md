# ADR 319: OpenEnv Arena curriculum laboratory

Status: implementation foundation; admission and transfer evidence pending
Date: 2026-10-08

## Decision

Add an isolated integration under `integrations/openenv-arena`. The submission is
an original OpenEnv environment container. MetaHarness and the RuV stack operate
outside the fixed official model, GRPO recipe and private evaluator. The live
arena guide takes precedence over obsolete indexed PostTrain documentation.

Use the arena's pinned OpenEnv revision
`86a180ede21e044f7929b9a7783ad83aa67d83a3`, typed virtual file reads and one terminal
submission. No model action invokes a shell, reads host paths, changes the grader
or sees an oracle. Each session owns its own task and state. Fresh default seeds
prevent every sandbox training on identical fixed answers; explicit seeds replay.

The first eight generators establish coverage and verifier contracts. They are
not evidence of competitive transfer. A public dataset accompanies the container
for leaderboard attribution. A submission pins an image digest; ambiguous remote
outcomes are reconciled under the same submission ID, never blindly duplicated.

MetaHarness supplies evidence and promotion primitives. A curriculum bridge
applies Autogenous's Better AND Safe AND Authorized AND Reversible principle;
the existing radio-moe-specific adapter is not relabeled as a curriculum engine.
rGi journals allowlisted local actions; Ruflo stores coordination. None alters
the arena recipe or runs unbounded submissions.

## Objective and competing choices

Optimize independently measured transfer and useful GRPO reward variance within
four H200 hours. Eight broad domains are the starting coverage. Additional task
families, difficulty mixtures and richer tools must earn inclusion by calibrated
model rollouts and matched fresh-family evaluations.

An unrestricted shell would more closely resemble some agentic evaluation tasks
but expands reward-tampering and isolation risks. The initial virtual-file model
is fast and reviewable; its narrower action distribution is a material transfer
risk. Add a separately sandboxed compute/repair track only after a matched ablation.
Inflating task count by seed duplicates is not a new capability. Local oracle
success and schema admission do not establish learning or leaderboard performance.

## Evidence gates

1. Oracle reward one; noop and wrong-answer controls zero across fresh seeds.
2. Strict type checks, bounded answers, isolated sessions and immutable grading.
3. Pinned OpenEnv validator against the running server; anonymous amd64 image pull
   and container replays before consuming the account's daily submission slot.
4. Model calibration with mixed within-group success. Detect constant reward,
   format failures, timeouts and context exhaustion before official training.
5. Predeclared candidate budget, separated train/selection/anchor families,
   no-regression and cost bounds before local promotion.
6. Official private-task evaluation and leaderboard receipt before claiming rank.

The arena has only five private tasks per domain. A one-task difference moves a
domain by 20 percentage points and the eight-domain mean by 2.5 percentage points.
Its best-per-domain cumulative rank is not the performance of one checkpoint.

See the integration PLAN.md for reproducible commands, uncertainties and owners.
Rollback removes the isolated integration; production packages are unchanged.
