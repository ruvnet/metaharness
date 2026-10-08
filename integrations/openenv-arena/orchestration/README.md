# Bounded curriculum workflow

This is an executable local evidence workflow, not an Arena trainer or a claim of model improvement. Arena alone trains its fixed model and publishes private evaluation results. The workflow selects a local curriculum artifact only after real proxy model evidence passes its gate. It never builds, publishes or submits an image.

## Actual integrations and pins

| Component | Source used | Revision |
| --- | --- | --- |
| MetaHarness | `packages/flywheel/src/gate.ts`, `sequential.ts`, `receipts.ts` | `ea287d6ef7548b0b32fa3e20956fa548cfe51edb` |
| Autogenous | Dedicated curriculum bridge of the documented `Better AND Safe AND Authorized AND Reversible` contract in `packages/autogenous/src/gate.ts` | same MetaHarness revision |
| rGi | `src/runtime.ts` and `src/adapters/metaharness.ts` | `2dd6adb526a7ca1d27b1c4d6cf98c828b390c421` |
| OpenEnv | Arena pinned dependency, used by the environment outside this directory | `86a180ede21e044f7929b9a7783ad83aa67d83a3` |

The existing MetaHarness Autogenous adapter evolves radio MoE weights and quorum parameters. Calling that adapter for curriculum optimization would be a false integration. This bridge instead implements an explicit curriculum domain gate, calls the actual generic MetaHarness gate and paired evidence function, and produces actual MetaHarness Ed25519 receipts. It does not invoke the upstream Autogenous runtime, learned proposer, or `runFlywheelGenerations` loop. Candidate manifests are preregistered by a human or a separately reviewed proposer.

The rGi checkout is trusted executable code. Its exact Git revision and clean `src` directory and root `package.json` are checked before importing it, including untracked and ignored source files. Node 24 executes these TypeScript sources directly. No npm dependencies, model credentials, containers, or network access are needed for local receipt review. rGi currently has no selected project license; do not redistribute its source as part of a release without resolving that separately. This integration imports an operator supplied checkout rather than vendoring it.

## Workflow

1. Define a baseline environment manifest and at most eight candidate manifests. Change only environment curriculum, task set or task difficulty. Use the environment's real task identifiers and its supported difficulty range. Keep the official model, optimizer, training duration and private evaluator outside the mutation surface.
2. Hash each manifest using exported `hash()`, which uses MetaHarness sorted canonical JSON. Hashes bind the full artifact, not a filename. Include its 1 to 50 unique task IDs in the plan. Set `maxCandidates`, `alpha` no greater than 0.05, and `minLift` at least 0.01 before seeing transfer results.
3. Preregister three disjoint structural family sets: `train`, `selection`, `anchor`, with at least two families each. New random seeds alone do not create a new family. Hold evaluation families outside published training data and any prompt seen by the proposer. The current training generators do not by themselves establish independent held-out generators.
4. Run four actual proxy model attempts per training task. Retain difficulty with 1 to 3 successes and nonzero reward variance. All-zero or all-one reward groups trigger a difficulty/reward repair diagnostic. Oracle answers and random controls establish verifier behavior only.
5. Separately train baseline and candidate proxy checkpoints using the same base model and training recipe, then evaluate them on identical task/seed pairs. Supply at least 20 selection and 20 anchor pairs spanning all preregistered families. Record checkpoint hashes, manifest hashes, training recipe hash, trajectory hashes, outcomes and measured costs. This directory consumes those receipts; it does not fabricate, train or collect them.
6. Compare via MetaHarness's generic gate plus minimum lift, paired evidence, no family regressions, explicit local selection authority and an available hashed rollback manifest. Alpha is divided by the preregistered candidate budget. Distinct candidates must use fresh audit cases. One candidate gets one review per journal.
7. rGi stores the selected local artifact reference and its rollback reference only. Human review, container qualification, public dataset/image publication and official submission remain separate actions. Official leaderboard results remain separate evidence.

The local gate measures proxy transfer. Its statistical interpretation assumes independent audit units and conditionally balanced discordant outcomes under the null. Correlated task variants or biased selection break those assumptions. Use independently generated instances, report family results, and obtain an untouched external holdout before claiming broad transfer. A four-attempt difficulty probe is a diagnostic, not a statistically precise success estimate.

## Evidence contract

`evidence.schema.json` is the structural interchange schema. Runtime checks additionally enforce matching manifests, disjoint families, unique seeds and trajectories, complete calibration coverage, paired rows, bounds and persistent audit consumption.

| `kind` | What it establishes | Can it establish promotion alone? |
| --- | --- | --- |
| `local_controls` | All cited local verifier tests passed | No |
| `proxy_calibration` | Observed difficulty on a declared model, four attempts per task | No |
| `proxy_transfer` | Paired results of separately trained proxy checkpoints | Only alongside controls, calibration, authority and rollback |
| `official_private_eval` | Raw archived Arena API response with run identity and retrieval time | Not consumed by this local gate; inspect actual Arena lifecycle and leaderboard |

Receipts must be produced by reviewed runners and accompanied by retrievable raw trajectories and model artifacts. Digests and schema validation cannot prove that model executions occurred. A signed local decision proves the signed bytes were not changed relative to the embedded public key; it does not authenticate an upstream model provider or the Arena. Each decision uses a process generated signing key. Production identity continuity needs an externally trusted persistent signer.

## Run

From `integrations/openenv-arena`, set a trusted pinned rGi checkout:

```sh
export RGI_ROOT=/absolute/path/to/rGi
export ARENA_CAPABILITIES=arena.validate_plan,arena.calibrate,arena.review
node orchestration/cli.mjs validate plan-input.json .arena/workflow.db
node orchestration/cli.mjs calibrate calibration-input.json .arena/workflow.db
```

`plan-input.json` contains `{ "plan": PLAN }`. A calibration input contains `{ "plan": PLAN, "calibration": RECEIPT }`. A review input contains exactly `plan`, `candidateId`, `calibration`, `controls`, and `transfer`. Inspect the test fixture for a complete **synthetic, test-only** data shape; do not relabel its contents as measured evidence.

For local artifact selection, explicitly enable that authority and provide the actual baseline manifest:

```sh
export ARENA_ENABLE_LOCAL_SELECTION=1
export ARENA_ROLLBACK_MANIFEST=/absolute/path/to/baseline-manifest.json
node orchestration/cli.mjs review review-input.json .arena/workflow.db
```

`ARENA_CAPABILITIES` defaults to empty. Unknown capabilities, including `arena.submit`, are denied. A successful rGi action means the review handler ran; inspect the result's `promote` and `reasons` to learn the gate decision. Invalid evidence returns `rejected_local_input`. Local operations charge zero accounting micros because they call no paid service; this is not a GPU cost estimate. No task here bypasses a provider budget.

Keep the journal to preserve the frozen plan, candidate budget and consumed audits. Do not create a fresh journal to recycle holdouts or evade a rejection. Restarting reuses completed action IDs without execution. Denied IDs are terminal too; enable capabilities before enqueueing intended work. Uncertain actions stop the runtime and require explicit operator reconciliation through rGi; they are never retried automatically.

## Verification

From the MetaHarness repository root:

```sh
RGI_ROOT=/absolute/path/to/rGi node --test integrations/openenv-arena/orchestration/workflow.test.mjs
```

The tests verify structural leakage rejection, insufficient/misclassified evidence, calibration variance, paired gate behavior, authority, rollback, signature tampering, actual rGi default denial, persistence and deduplication. rGi tests are explicitly skipped if `RGI_ROOT` is absent. A full run must report zero skips.

Acceptance: local control results alone cannot produce a promotion; a restart cannot spend the same audit twice; no registered capability can submit anything to Arena. These tests establish workflow behavior, not Arena admission or competitive performance.
