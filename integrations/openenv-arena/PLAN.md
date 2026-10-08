# OpenEnv Arena competitive curriculum plan

The objective is the highest observed official account average, with reproducible public artifacts and evidence that curriculum changes caused transferable improvement. First establish a working submission. Then compete by improving the training environment. The Arena trains its own fixed model; our orchestration is not the agent deployed inside its private evaluation.

This plan was grounded in the live Arena contract and leaderboard on 8 October 2026. Indexed PostTrain Arena instructions describe an older contract and must not drive implementation. See [the captured response](evidence/live-contract.json), the [official guide](https://openenvarena-arena.hf.space/AGENTS.md), and the [official leaderboard endpoint](https://openenvarena-arena.hf.space/api/leaderboard).

## Rules and measured starting position

| Constraint | Consequence |
| --- | --- |
| Arena trains Qwen/Qwen3.8-27B with GRPO on one H200 for at most 14,400 seconds | We optimize curriculum, useful reward variation and completed optimizer steps. We do not submit a different model, harness or ensemble. |
| One task per optimizer step; five independent episodes; first four valid terminal rewards train the policy | Make reset and verification cheap, observations compact, episodes bounded, and difficulty produce differing outcomes. Slow or invalid episodes waste the fixed budget. |
| 40 private tasks, five per domain, one attempt per task | Per-domain scores move in 20 percentage point increments. One additional solved task changes the equal average by 2.5 points. |
| Leaderboard keeps each account's best score in each domain across runs | Later daily runs can specialize. Report both the composite account score and each individual run; the composite need not correspond to any one checkpoint. |
| One accepted submission per rolling 24 hours | Admission mistakes burn scarce feedback. Validate the exact public digest before submitting. Do not use other accounts to evade this limit. |
| Public Docker Hub or GHCR amd64 image; public ungated HF dataset required for attributed rank | Source code alone is not an entry. Preserve source, dataset revision, native schema, image digest, request digest and official run ID. |
| 1 to 50 declared tasks, one shared action/observation schema | Start with eight families, expand to 24 and then at most 48 genuinely varied task IDs when measured throughput supports it. |
| Per episode sandbox: 2 vCPU, 16 GiB RAM, no GPU; arena passes no secrets or extra files | Ship an independent CPU environment. No provider credential, remote grader or runtime orchestration is required inside the image. |

At 22:59 UTC on 8 October, five accounts were ranked. The leader was NoeFlandre with 0.125. The untrained reference solved 4/40, or 0.10. Therefore the observed leading gap was one solved task. That is a target to exceed, not evidence of a robust effect. A binomial standard error near 5/40 is roughly 5.2 percentage points, and the real test is a fixed, heterogeneous set rather than a random IID sample. Repeated selection of the best result further biases the composite upward. Never claim statistical superiority from a one-task lead.

## Roles and boundaries

| Component | Input | Output | Current scope and assumption |
| --- | --- | --- | --- |
| MetaHarness | Frozen candidate manifests and measured paired evidence | Gate decision and Ed25519 receipt | Actual generic gate, paired evidence and receipt implementation are reused. A signature binds bytes; it does not prove execution provenance. |
| Autogenous | Candidate curriculum changes, safety evidence, authority, rollback artifact | Better AND Safe AND Authorized AND Reversible decision | Dedicated curriculum contract bridge. Upstream Autogenous radio/MoE evolution runtime is not being claimed as curriculum training. |
| rGi | Explicitly permitted local capabilities, action IDs, frozen plan | Durable journal, deduplicated local decisions, artifact reference | Actual pinned runtime; no registered submission or publishing capability. Source license must be resolved before redistributing rGi. |
| Ruflo | Research questions, review tasks and bounded coordination | Findings, task ownership and evidence references | Live Ruflo AI Team/run/task records coordinate the work; they do not constitute provider execution. Coordination belongs outside the image and alone cannot improve Arena's private score. |
| Native OpenEnv environment | Task ID, seed and typed read/list/submit actions | Observations and terminal reward in [0,1] | Original procedural tasks; independent deterministic verifiers; no shell, host file access or reward oracle exposed to the policy. |
| Submission client | Live /schema, real image digest, real dataset and reviewed JSON | Dry-run request, later an atomic submission receipt | No submission without explicit execution, matching request digest and the existing HF login (or HF_TOKEN). Unknown outcomes reconcile the same ID. |

## Phase 0: qualify the foundation

Inputs are the pinned OpenEnv revision `86a180ede21e044f7929b9a7783ad83aa67d83a3`, eight original task families, and typed actions. The initial families are software change impact, industrial scheduling, science calibration, office reconciliation, finance ledgers, math routing, security log triage and media timelines. These are narrow practice tasks representing eight domains, not coverage of the private task distribution.

Produce all of the following before consuming a slot:

1. Positive oracle controls, wrong answers, empty answers, malformed JSON and nonfinite number controls over deterministic seeds. The independent oracle is test code, not a policy, model evaluation or source of training answers.
2. Reset and terminal idempotence checks; invalid file names cannot leave the virtual workspace; bounded steps; oversized answers receive no credit.
3. The official `openenv validate --url` against the real native server, with all supported protocol checks passing. Replay the declared example actions for every declared task, confirming `done=true` and a finite reward in [0,1]. A zero-reward terminal example is deliberately valid admission evidence only.
4. An amd64 image from the final source revision, under 2 GiB compressed and 128 layers, nonroot, listening on `0.0.0.0`, exposing its one port and becoming healthy within 120 seconds.
5. A fresh anonymous pull and validation of the exact public digest; a public dataset card with task generation, reward definition, source/license, exclusions, split construction and reproducibility commands.

Gate: all protocol and control checks pass. This establishes eligibility and verifier behavior, not competitiveness. The public image and dataset are now verified; the [fresh anonymous replay](https://github.com/ruvnet/metaharness/actions/runs/37859352503) passed all six native protocol checks and 32 episodes. Actual model calibration and final request approval remain pending.

## Phase 1: establish actual learning signal

A verifier returning 1 for its own solution tells us almost nothing about trainability. Run the actual target checkpoint where available, or clearly label the exact proxy checkpoint, on four independent attempts per task difficulty. Freeze provider settings, record prompts/actions/observations or their retained artifact hashes, token counts, wall time, failures and completion reasons. Do not relabel a different model as Qwen3.8-27B evidence.

The first probe is 8 families × 4 attempts = 32 episodes. With the calibration runner defaults, its hard ceiling is 128 calls and 262,144 generated tokens; input tokens and provider pricing are separate. Dry-run first, record the provider price before enabling execution, and impose an external dollar limit if the provider supports one. No paid proxy budget is assumed approved by this implementation.

Retain initial difficulty settings with one to three full successes in four attempts and nonzero reward standard deviation. Treat all-zero groups as possible excessive difficulty, broken prompting or a verifier mismatch; all-one groups as potentially trivial. Four samples are a fast diagnostic, not a reliable success estimate. Add 16 to 32 fresh attempts before making a sensitive difficulty decision. Because Arena resets produce fresh instances, separate variability across generated instances from variability across policy attempts on the same instance.

Throughput levers are constrained and measurable:

| Lever | Measurement | Failure mode and fix |
| --- | --- | --- |
| One `read("*")` plus one structured submit | Calls per episode, observation bytes and tokens | Less tool practice; introduce additional steps only when transfer gains justify the cost. |
| Compact prompts and small virtual files | p50/p95 episode tokens and duration | Missing requirements; retain explicit answer schema and units. |
| Independent component rewards | Reward standard deviation and exact final success | Reward hacking through partly right answers; retain terminal verifier and audit every component's semantics. |
| Difficulty and family selection | Success distribution, pairwise holdout gains | Optimizing training reward alone; decide from heldout model performance. |
| Cheap reset and deterministic checks | Reset/verifier p95 and failure rates | Synthetic tasks become too narrow; expand structure without adding unnecessary runtime. |
| Fewer useful task IDs initially | Completed optimizer steps per family | Poor coverage; expand only when each family gets meaningful exposure. |

The theoretical maximum optimizer steps is approximately `floor((14,400 - setup_seconds) / observed_step_seconds)`. At 180 seconds per step this is at most 80 before setup; at 360 seconds at most 40. These are planning examples, not measured Arena throughput. With 48 tasks and 40 steps, a cyclic run cannot even visit every task once. Select family count using observed Trackio step time.

## Phase 2: preregister curriculum ablations

Freeze a bounded experiment manifest before seeing transfer outcomes. Use the same base checkpoint, model template, trainer recipe, training budget and evaluation harness in each arm. Any necessary recipe change is a new experiment. Record source and artifact digests. The local gate supports at most eight candidates with alpha split across the preregistered candidate budget; do not restart the journal to evade it.

| Arm | Controlled change | Decision it answers |
| --- | --- | --- |
| A | Baseline eight-family uniform medium curriculum | Does any more elaborate design help? |
| B | Calibrated difficulty with the same eight families | Does maintaining useful reward variation improve transfer per training minute? |
| C | 24 varied task families or structures, three per domain | Does broader practice offset fewer repeats per family? |
| D | Targeted domain mix chosen from prior official results, fixed before new holdout | Can a later daily run improve the account's weak domain scores? |

An eventual 48-task version should add distinct structures, ambiguity, distractors, edge cases, compositions, formats and domain constraints. Merely changing eight task names or adding difficulty suffixes creates 24 parameterizations, not 24 independent families. Never represent variant count as structural coverage.

Evaluate frozen baseline and candidate proxy checkpoints on matched instances. Require both fresh random seeds and structurally distinct heldout generators. Fresh seeds from an unchanged generator test interpolation and reduce memorization but do not establish broad transfer. Keep selection and anchor families outside training data and proposer prompts. The current eight generators alone do not supply this independent holdout; author and audit it before a transfer claim.

The executable gate requires at least 20 paired selection cases and 20 anchor cases spanning at least two structurally disjoint families in each split, a preregistered minimum lift, adjusted paired evidence, no measured family regression, explicit local selection authority and the hashed rollback manifest. Treat 40 pairs as a software gate minimum rather than adequate statistical power. Expand to at least 200 representative paired cases if differences are only a few percentage points. Report paired differences and intervals, not only aggregate reward.

Promotion cannot use oracle reward, random actions, test fixtures, dummy/simulated runs, invented trajectories or training reward as substitute model evidence. All such controls retain their actual labels.

## Phase 3: public qualification and first official run

1. Review the exact generated request with its SHA256. Supply a real HF dataset and immutable image digest; no placeholder credential, dataset or registry reference qualifies.
2. Confirm the account's rolling quota, exact image visibility, dataset visibility and complete native replay. Archive public artifact revisions and the request digest.
3. Explicitly execute one submission. The receipt records the intended ID and digest before the network mutation. On timeout, read that same account's status for that same ID before deciding anything. Never generate another ID automatically to escape an unknown outcome.
4. Preserve the image until the run ends. Follow the returned `run.dashboard`, not a guessed Trackio project/run. Query actual metric names and distinguish absent values from zero. Record optimizer steps, reward mean/std, completion lengths, step wall time and retries.
5. Archive official lifecycle and private evaluation. An admitted request, `completed` training, or positive training reward is not an evaluated leaderboard score. Exclude `simulated: true` and CPU dummy metrics from performance claims.

The ruvultra session published the dataset and board introduction (message 54) using its existing HF login, and owns calibration and subsequent board updates. Credentials remain on that host. Public milestone and blocker posts are authorized. No Arena submission has been sent. The user explicitly requires the exact final request to be shown and a go-ahead received before submission. That approval gate is mandatory; review the image digest, dataset, task list, limits and request hash together. The present [candidate request](evidence/submission-candidate.json) may change after calibration; it is not approved.

## Phase 4: compete across daily runs

After the first actual private evaluation, compare per-domain outcomes with the untrained reference and each previous run. Choose the next day's fixed curriculum using prior results and independent local transfer evidence. A focused run can improve a weak domain while the account retains prior domain bests, but publish the resulting composite honestly. Retain each run's full eight-domain vector to reveal regressions hidden by the official max aggregation.

Do not turn the 40 private tasks into a local training target. The task content is unavailable, and adaptive submission selection will overfit the benchmark if continued without independent validation. Stop curriculum changes that do not produce measurable local transfer or useful optimizer throughput. Maintain a frozen external holdout for final confirmation.

Proposed first campaign ceiling is three accepted official runs across at least 72 hours, not a schedule created by this plan. Reassess after each completed evaluation; do not promise rank. The Arena allocates at most 12 H200 hours across those runs. Provider billing, availability and proxy training expense are unverified and require an explicit budget before any external paid training is started.

Acceptance for an initial competitive result: a real completed private evaluation, attributed to our public dataset revision and pinned image, has a recorded official average above the contemporaneous leader. Acceptance for a credible superiority claim additionally requires independently measured heldout lift over the baseline curriculum, full per-run domain vectors, uncertainty reporting, and reproduction from public artifacts. The biggest failure mode is a curriculum that teaches narrow synthetic answers but not transferable task solving; the fix is structurally independent evaluation and controlled curriculum ablations before spending more daily slots.
