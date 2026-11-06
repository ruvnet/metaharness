# @metaharness/curriculum-lab

Experimental host harness for verifier-grounded curriculum learning. **Private draft, not published. No live LLM gain, Arena transfer or RSI is established.**

It connects a frozen experiment contract to Hugging Face proposal inference and an already-owned running Vast instance. It neither rents machines nor submits to Arena. The host retains authority and credentials; candidate proposals contain only one bounded numeric parameter.

## Run now without credentials

From this directory, on Node 24.19+ and Python 3:

```sh
npm test
npm run smoke
node src/cli.mjs plan examples/spec.json
```

The example spec has placeholder hashes, model revision and budget. It is illustrative and is **not permission or a live experiment registration**. Replace them with independently verified source/model/settings pins before preparing any live job. Production package runtime requires Node 20+; the repository-source Darwin integration test requires Node 24's TypeScript stripping. No dependency installation is needed for these tests.

The CPU smoke performs actual REINFORCE weight updates on a two-parameter logistic policy. For seeds 7, 19 and 31, fixed and hand-authored staged curricula both achieved 1000/1000 on fresh synthetic examples after 3600 updates per arm. There is **zero curriculum advantage**. This is a saturated numerical toy, not an LLM, autonomous task generation, genuinely different reasoning families or evidence of recursive improvement. A hand-authored oracle also gets 100%. The negative result is retained in `examples/local-learning-receipt.json`.

## Architecture and integration contract

1. `freezeSpec` validates and hashes source, verifier, trainer, model revision, settings, fixed cells, disjoint training/confirmation families and seeds, and resource ceilings. Register this digest durably before seeing outcomes. The returned object is a detached JSON snapshot; callers must not mutate it.
2. `proposeDarwin` uses the actual `@metaharness/darwin` numeric mutator, restricted to one knob and projected to one approved step. The optional peer is exactly 0.10.3. No shell evaluator is used, so its inherited environment cannot expose host credentials to candidate execution.
3. `proposeHF` is an alternative auxiliary proposer using an explicit model/provider. It sends only training families, knob and incumbent. It uses the Portfolio-compatible `json_object`, low reasoning effort and 2048 output ceiling. It does not replace the official target model. Support, license, price and data permission must be verified by the host before authorization.
4. `trainingManifest` renders a content-addressed job with no confirmation examples. `dispatchVast` checks that the authorized instance exists and is running, then sends a fixed hash-checked runner command through the official API. HTTP acknowledgement yields `QUEUED_UNVERIFIED`, never completion. Returned log URLs are not fetched or trusted.
5. `examples/runner.py` executes a preinstalled, hash-pinned trainer with a minimal environment. It retains immutable intent, private output and unsigned receipts, and refuses uncertain reruns. Install it as `/workspace/curriculum-lab/runner.py`, the reviewed trainer as `trainer.py`, and the exact manifest bytes at `manifests/<hash>.json`. Trainer contract: public training spec on stdin, `--output <path>`, one JSON result file. `local_learning.py` implements this contract for CPU smoke. A production Qwen/TRL trainer and evaluator are **not supplied or validated yet**; integrate the existing ruvultra driver after owner review.
6. `reviewComparison` checks fixed-cell discovery/confirmation improvement and paired transfer results, with complete trajectory hashes, source/settings binding and verified accounting. Every output has `promote:false` and `signed:false`. Passing numeric checks only queues independent review. Caller assertions and hashes are not trusted attestations, signatures or proof that trajectories exist.

```js
import {freezeSpec, proposeHF, trainingManifest, dispatchVast} from '@metaharness/curriculum-lab';
import {proposeDarwin} from '@metaharness/curriculum-lab/darwin';

const {spec, specHash} = freezeSpec(reviewedSpec);
const proposed = await proposeDarwin(spec, 7, 1);
const job = trainingManifest(spec, proposed.proposal, 600);
// Review/install pinned runner, trainer and job bytes on the owned executor.
// Host supplies a spec-bound authorization and loads only VAST_API_KEY in process.
// await dispatchVast({spec, directory, authorization, token, job: dispatchDescriptor});
```

## Provider authorization and accounting

`authorization` is a trusted host object, never a field accepted from model output. It binds `specHash`, `owner`, `operations`, expiry, and either exact HF `model` plus `maxRequestUsd`, or Vast `instanceId`, `runnerHash`, `manifestHash`, `maxJobUsd`. It is an explicit caller permission contract, **not** cryptographic authorization. The application must resolve ownership and user budget before constructing it.

Use one protected persistent directory per registered experiment. HF call/token/time/cost reservations and Vast job reservations are persisted before requests and never refunded after failure. Duplicate exact operations reuse immutable receipts. A process crash with intent but no result requires human reconciliation; there is no automatic retry. Locks fail closed and are never automatically broken. Scope the directory to one confidentiality context; do not share across users.

Reservations are conservative host estimates, not provider billing enforcement. Vast compute/storage can continue billing after a trainer stops. The owning executor must manage the existing instance's lifecycle and account-level limits. This package deliberately cannot stop or destroy another owner's instance. Actual billed cost stays `null` until independently obtained. `rounds <= 3` bounds the registration; the host scheduler must enforce generation sequencing and the learner's token/step limits.

`examples/ruos_secret.py` reads only HF_TOKEN or VAST_API_KEY from the protected binding, checks owner/mode and refuses symlinks/duplicates. It parses quoting as inert text, never sources a shell file. Do not print its return value, persist it, put it in argv, or pass it to the training instance. Provider response text, reasoning and raw transport errors are not written to receipts. The shared HF compatibility receipts remain authoritative; no paid compatibility retry is required.

## Trust and limitations

Host adapters, trainer, manifests, evidence directory and evaluator are trusted code/data. Candidate execution needs a separate isolated container without credentials or host mounts. The Python runner's empty environment and timeout are not a security sandbox. Its outer Vast timeout should exceed the manifest trainer timeout by at least 30 seconds; the operator must confirm whole-job termination remotely. OS/process constraints and independent result verification remain required before live use.

Training and confirmation data must be genuinely distinct. The checker cannot discover semantic leakage, attest hidden-set secrecy, verify a trajectory from its hash, or establish statistical significance. A mixed cell requires complete boolean outcomes; malformed actions, truncation and accounting/provider errors exclude the whole cell without shrinking its denominator. Full transfer evaluation must pair task identities and retain all failures. Do not tune on private Arena scores.

Flywheel/Autogenous signed promotion and existing rGi durable execution remain separate integration gates. This package does not claim to run either. It does not repair Arena issue384, merge policies, automatically publish a package, or enable submission. Vast/HF adapters are tested with contract fixtures; **live authentication and execution remain unverified**.

## Next experiment

After repairing the existing evidence gate and obtaining a budget, use a pinned small Qwen model and independently verified tasks. Compare equal-total-compute fixed curriculum, adaptive curriculum with frozen proposer, and adaptive curriculum with learning proposer. Run multiple training seeds and at most three generations. Freeze fresh confirmation families; count rejected proposals and evaluation costs. Accept an RSI-related result only if the learned proposer improves subsequent held-out learning over the frozen proposer, with uncertainty and regression checks. A successful transport or one better checkpoint is insufficient.

References checked 2026-10-11:

* https://arxiv.org/abs/2505.03335 (Absolute Zero)
* https://arxiv.org/abs/2605.14392 (EvoEnv, work in progress)
* https://arxiv.org/abs/2607.22529 (Skill Self-Play)
* https://docs.vast.ai/api-reference/instances/execute
* https://huggingface.co/docs/inference-providers/tasks/chat-completion
# Live HF integration check

## Measured local learning search

The full repository `@metaharness/darwin@0.10.3` `evolveNumeric` engine now runs
bounded real softmax training experiments on the public scikit-learn digits and
wine datasets. This is optional research code requiring a repository checkout,
Node 24 and the scientific versions in `examples/learning-requirements.txt`.
It does not train an LLM, claim general RSI, or invoke providers.

```sh
python3 packages/curriculum-lab/examples/learning_checks.py
node --experimental-transform-types packages/curriculum-lab/examples/learning_search.mjs /absolute/new-evidence-directory learning_rate
```

The engine freezes dataset/split/source hashes, compares uniform and 50% hard
sampling controls, searches one parameter for three generations, and uses ten
fresh paired training seeds on untouched confirmation examples only after a
discovery win. Each fit gets 64 updates of 64 examples. Sampling uses cached
training loss; no held-out labels enter training. Checkpoints, predictions,
sampled training IDs, rejected variants and receipts are retained. Replays reuse
completed results. Supply `CURRICULUM_PYTHON` only to select a trusted interpreter.

The October 11 Toronto experiment rejected curriculum-only tuning. Learning-rate
search selected 0.4 with hard-sampling fraction fixed at 0.5. On confirmation,
digit balanced accuracy improved from 94.6079% for the stronger control to
96.0383%; wine remained 100%. Macro gain was 0.7152 percentage points. The paired
seed 95% lower bound was 0.5082 points, conditional on one fixed data split.
Sixty saved checkpoints and 11,880 predictions replayed independently.

These are small-data learning-efficiency results, not evidence that Darwin beats
equal-budget random/grid search, improves its own optimizer, or transfers to an
LLM. The winning value appeared in generation one. No such stronger claim is
earned by running more generations. Wall timings are retained but no latency
improvement is claimed. The result is unsigned experimental evidence; Autogenous
and signed Flywheel promotion are not invoked, and there is no deployment.

See `evidence/learning-summary-20261012.json` and the complete compressed evidence
bundle. The first reporting implementation replaced a timing field on replay;
the summary distinguishes observed original runtime from replay runtime. Reports
are now retained separately. An incomplete receipt still blocks execution.

## HF provider path

After explicit spending authorization, the reviewed ruOS host can run
`python3 examples/hf_e2e.py /absolute/private/evidence-directory`.
Pin and verify all source files first. This loads only HF_TOKEN from the protected
binding into the provider process; the evaluator gets only PATH. It freezes the
source/settings before one structured Groq proposal, trains paired synthetic CPU
policies, retains all 12,000 evaluation decisions, and checks receipt reuse.
Repeated identical execution makes zero extra provider calls. A changed source
must use a separately authorized experiment, not reset an existing receipt.

The example reserves $0.01 for one call, caps output at 2,048 tokens and retains
unknown billed cost explicitly. This is a local two-parameter learner driven by
an HF proposal, not HF model-weight training, an Arena evaluation, or an RSI claim.
The remote proposer revision and effective thinking configuration are unknown.
No promotion is possible. Do not mistake its width shift for distinct-domain
transfer. The $5 user ceiling in this particular example records the experiment's
authorization; it grants no permission to other users or subsequent experiments.


### Equal-budget optimizer comparison (2026-10-12)

Run from this repository with Node 24 and the pinned scientific dependencies:

```sh
npm run learning:compare --prefix packages/curriculum-lab -- /absolute/evidence/directory
python3 packages/curriculum-lab/examples/optimizer_checks.py /absolute/evidence/directory
```

The actual Darwin `evolveNumeric` engine now has a random-search comparator. Before
outcomes, the runner freezes eight fresh partition seeds, three public datasets
(digits, wine, breast cancer), independent discovery/confirmation fit seeds, and
one learning-rate search space. Both methods start at the stronger fixed rate
0.4. Random search receives exactly Darwin's realized number of unique discovery
evaluations, including that anchor, using a precomputed independent log-uniform
pool. Shared exact evaluations reuse receipts. Both use 64 gradient updates per
fit; confirmation evaluates only the selected winners and the anchor. This is
an equal training-work comparison, not an equal wall-time claim.

Result: **HOLD_NO_CONFIRMED_SEARCH_ADVANTAGE**. Darwin's mean confirmation gain
versus random was 0.0669 percentage points, with descriptive 95% lower bound
-0.1604 points. Against fixed rate 0.4, the gain was 0.0413 points, with lower
bound -0.2187 points and a small breast-cancer regression. Both fail the frozen
0.5-point, positive-lower-bound, no-family-regression gate. No promotion occurred.

All 138 unique evaluations, 948 real softmax fits, 160,924 predictions and 60,672
training trace steps were retained and independently replay-checked. Repeating
the command reused all evidence with zero new fits. Thirty focused tests pass
(20 Node, five host Python, five scientific checks). This cycle used no provider
calls and $0 external inference spend; existing infrastructure cost is unknown.

`evidence/optimizer-summary-20261012.json` records the result and archive digest;
`evidence/optimizer-evidence-20261012.tar.gz` contains the frozen plan, complete
traces/checkpoints, actual Darwin archives, immutable receipts and cached replay.
Repeated partitions overlap and are not independent population samples. The
previous small-model tuning gain remains a limited result; this comparison does
not establish an adaptive-search advantage, transfer learning, or recursive
self-improvement. Further work should test a changed optimizer policy on training
workloads before opening newly frozen, genuinely distinct confirmation workloads.
These exposed confirmation partitions must not become fresh holdouts again.

### Search-policy transfer check (2026-10-12 UTC)

```sh
npm run learning:policy --prefix packages/curriculum-lab -- /absolute/policy/evidence
python3 packages/curriculum-lab/examples/policy_checks.py /absolute/policy/evidence
```

A single hand-proposed change reduces Darwin mutation sigma from 0.35 to 0.12,
following boundary-clamping failures in the exposed earlier benchmark. The new
frozen evaluation uses two synthetic classification configurations and eight
independently seeded populations. Actual `evolveNumeric` runs with seven unique
candidate evaluations per policy, compared with seven random-search candidates
and fixed learning rate 0.4. All methods retain identical training semantics,
64 updates per fit, and separate selection/confirmation fit seeds. The engine
stops before an eighth unique evaluation; complete callback receipts retain the
partial final generation even if its archive scores are not yet saved.

**Rejected: HOLD_NO_CONFIRMED_POLICY_GAIN.** Smaller sigma loses 1.5315 percentage
points against incumbent Darwin and 0.7625 points against random search on mean
confirmation accuracy. Its 0.6250-point advantage over the fixed anchor has a
negative 95% lower bound and also fails the gate. Do not change the incumbent
policy. Narrowing around a previously successful anchor did not transfer well.

All 180 unique evaluations, 836 real softmax fits, 200,640 predictions and 53,504
training trace steps are retained and independently checked. Repeat execution
reuses all receipts with zero training fits. Thirty-two focused tests pass. No
provider calls, rentals or additional inference spend occurred. Full evidence
and archive SHA256 are in `evidence/policy-summary-20261012.json` and the adjacent
`policy-evidence-20261012.tar.gz`. All decisions remain unsigned and unpromoted.

This is a controlled policy hypothesis test, not autonomous recursive improvement
or LLM training. Both new families use the same synthetic generator, which limits
transfer claims. The next meaningful direction is a learned search prior trained
across task families, evaluated on genuinely unseen families against the same
strong controls; these exposed results cannot serve as fresh confirmation again.

### Learned search prior: resource ablation (2026-10-12 UTC)

```sh
npm run learning:prior --prefix packages/curriculum-lab -- /absolute/prior-evidence /absolute/optimizer-comparison-v1 /absolute/policy-search-v1
python3 packages/curriculum-lab/examples/prior_checks.py /absolute/prior-evidence
```

The two history directories are the extracted earlier evidence archives. Only
**discovery** observations enter the prior. An ExtraTrees regression model learns
relative learning-rate performance from 656 historical observations across 40
task instances (five families, eight instances each), using training-partition
statistics and log learning rate. It ranks seven fixed rates and proposes two
for validation on each new task. Frozen confirmation covers noisy moons with
nuisance features and anisotropic blobs, eight new populations each. Controls
are full seven-rate grid/random searches and equal-budget fixed/random pairs.
The trained forest is retained as JSON, independently replayable without pickle.

**HOLD_NO_CONFIRMED_PRIOR_GAIN.** The learned arm uses eight training fits per
task including confirmation versus 18 for full search, a nominal 55.56% reduction.
That is an allocation difference, not an accepted efficiency gain: confirmation
loses 0.1487 percentage points to grid, 0.2702 to full random, and 0.2983 to the
random pair. Its 0.1042-point improvement over the fixed pair is insufficient.
Both the frozen noninferiority and attribution gates fail. Retain the prior as
experimental evidence; do not install it as the default search strategy.

All 680 fits, 163,200 predictions, 43,520 trace steps, and 112 prior predictions
are independently replay checked. Exact rerun executes zero new fits. The nine
scientific tests pass alongside the previously verified 25 unchanged core/host
tests. No provider requests or new inference charges. Historical learning work
and infrastructure billing are not included in a claimed net cost saving; no
such saving is established.

Full evidence: `evidence/prior-summary-20261012.json` and its adjacent tar archive.
This is actual regression-model fitting and cross-family testing inside the
experimental package, not a Darwin-engine run, LLM weight training, or RSI.
Further rounds should justify a materially different workload or model before
spending more effort on this low-dimensional learning-rate search. Preserve all
failed priors and exposed holdouts; do not weaken acceptance thresholds.

### Concurrent HF agent pilot (2026-10-12 UTC)

`examples/agent_experiment.py` implements four concurrent lanes: two-round prompt
reflection, a matched independent-proposal control, bounded strategy configuration,
and its matched control. The host renders allowlisted strategy values; it never
executes model-generated code. These are inspired experiments, not implementations
of GEPA or DGM. Six training and twelve confirmation scheduling/atomic-ledger tasks
use deterministic verifiers, independently checked by `agent_task_checks.py`.
They test new instances of the same families, not unseen-family transfer.

All selected candidates are saved before confirmation. Two HTTP requests may be
in flight, sharing serialized durable reservations. Maximum128 calls,2048 output
tokens/request,24000 request bytes,240-second launch window, and $1.28 reserved
within the user's existing $5 task ceiling. Incomplete requests stop the pilot;
unchanged completed runs reuse receipts, and partial intents do not auto-retry.
The reviewed ruOS loader reads only HF_TOKEN inside the provider process. Secret
values never enter prompts, files, command arguments, or receipts. Redirects are
refused; strict JSON and token-accounting checks fail closed.

Live attempt at source `442a23e458a4340339079e063f73cd13f75b9bc0`:
**INCONCLUSIVE_PROVIDER_403**. The first baseline POST to HF's explicit
`openai/gpt-oss-120b:groq` route returned403. No task was evaluated, no lane completed,
and confirmation remained untouched. Independent read-only whoami/model-list
requests both returned200; these establish account access, not inference access.
Executor reported statusok,exitCode0,completionVersion1,completionVerifiedtrue.
One $0.01 request reservation; known task reservations now total$0.03. Billed cost
and failed-request token usage are unknown. No token rotation or paid retry.

`evidence/agent-hf-pilot-20261012.json` preserves the sanitized result and host
receipt hashes. Full request/receipts remain in the private ruOS evidence path.
Eight new focused tests pass (four independent task-verifier checks and four
provider/candidate boundary tests). The original runner reported zero recorded
usage; the evidence explicitly corrects this to unknown cost, not free inference.
Subsequent runner reporting includes completed-task counts and null cost estimates
when usage is missing. No learning, RSI, promotion, or Arena result is claimed.
