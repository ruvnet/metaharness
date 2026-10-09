# MetaHarness OpenEnv Arena

An original procedural training environment and bounded curriculum review workflow for [OpenEnv Arena](https://openenvarena-arena.hf.space/). It prepares a competitive entry; it does not establish an Arena rank or model improvement. Read [PLAN.md](PLAN.md) for the measured strategy, budgets and gates.

Arena trains **its fixed Qwen3.8-27B** with GRPO on one H200 for up to four hours, then evaluates 40 private tasks across eight domains. We supply the environment that teaches the model. MetaHarness, Autogenous, rGi and Ruflo belong around curriculum development, evaluation and governance. They are not an ensemble installed into the Arena evaluator.

**Release hold:** the first real Qwen3.8 probe from the ruvultra executor reports that several v1 families are saturated while some failures come from reasoning truncation. Public v1 trajectories are available in the [calibration artifact](https://gist.github.com/ruvnet/00fb40aeabb35a893f140597e2695c1d); independent replay confirms all 77 retained rewards ([review](evidence/calibration-v1-review.json)); the cause of the 11 invalid replies is unproven. Generator, verifier, calibration and dependency revisions are implemented; the v1 image and request below are historical qualified artifacts, not the final candidate. No Arena submission is approved.

## What is implemented

| Part | Behavior | Limit |
| --- | --- | --- |
| `arena_env` | Native OpenEnv server; eight generated task families; typed `list`, `read`, `submit`; independent terminal rewards | Initial practice coverage, not proven task transfer |
| Difficulty variants | Each family supports `-d1`, `-d2`, `-d3`; fresh instance on every unseeded reset | 24 variants are still eight generator families |
| Local checks | Correct, incorrect and malformed answers; deterministic reset; bounded episodes and virtual files | Oracle controls are verifier tests, not model scores |
| `scripts/calibrate.py` | Explicitly invoked four-attempt model probe, bounded calls, dry-run default | Requires a real endpoint and credential; does not train or establish official scores |
| `orchestration` | Actual MetaHarness gates/receipts and pinned rGi journal; explicit Autogenous curriculum gate contract | No upstream Autogenous training runtime or Arena submission capability |
| `submission.py` | Live schema request rendering; immutable image requirement; reviewed digest; atomic receipt and status reconciliation | Public image/dataset and an existing Hugging Face login or HF_TOKEN must be available; no automatic retry |

The implementation makes no host filesystem, shell, network or verifier endpoint available through the policy's actions. Reading `*` returns only the generated virtual files. Submission ends the episode once; later actions cannot amend the answer. The container does not need model credentials or rGi.

## Local run

From this directory, with Python 3.12:

```sh
python -m venv .venv
.venv/bin/pip install -r requirements.lock
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m uvicorn arena_env.app:app --host 127.0.0.1 --port 8000
```

In another terminal:

```sh
.venv/bin/openenv validate --url http://127.0.0.1:8000
curl --fail http://127.0.0.1:8000/schema
```

The dependency uses Arena's required OpenEnv commit `86a180ede21e044f7929b9a7783ad83aa67d83a3`. Native `/schema` is the source of the submitted action and observation schemas. Do not substitute a handwritten HTTP imitation or a stale indexed Arena format.

`example-actions.json` reads the virtual files then submits an empty answer. It deliberately ends with zero reward for every task, satisfying admission's terminal protocol without leaking solutions. Correct answers are tested separately with the independent local oracle. Protocol validation, model capability and leaderboard scores are separate evidence.

The eight task IDs are:

| Arena domain | Task ID |
| --- | --- |
| Software engineering | `software_change` |
| Industrial and physical systems | `industrial_schedule` |
| Natural science | `science_calibration` |
| Office work | `office_reconciliation` |
| Finance and economics | `finance_ledger` |
| Math and formal reasoning | `math_route` |
| Cybersecurity | `security_triage` |
| Media and content production | `media_timeline` |

For each, `-d1`, `-d2` or `-d3` selects its difficulty; without a suffix the environment uses medium difficulty. Seeds are passed to local reset calls, never as unsupported fields in an Arena task contract.

## Model calibration and local review

Inspect a bounded calibration plan without provider calls:

```sh
PYTHONPATH=. .venv/bin/python scripts/calibrate.py \
  --base-url https://YOUR_PROVIDER/v1 \
  --model YOUR_MODEL --model-revision YOUR_CHECKPOINT_REVISION \
  --output .arena/calibration.jsonl
```

Use real provider values and review the dry-run caps before execution. `--request-timeout` is configurable from 30 to 900 seconds (default 300), and `--max-tokens` from 128 to 32,768. Execution requires an explicit `--max-total-tokens` ceiling reserving prompt plus output units before each call; unused reservations are not refunded. This is not a provider dollar or billing guarantee. Four attempts identify obvious difficulty problems; they do not prove improvement.

For local aggregate accounting use `--accounting arena`, a locally available `--tokenizer-json` plus its exact `--tokenizer-sha256`, and explicit `--episode-completion-tokens` and `--episode-context-tokens`, or `--task-budgets-json` in the native task-list format. The optional local `tokenizers` helper is not installed in the image. Generated completion includes reasoning once, and every observation after reset is charged. The runner retains separate reasoning, action text, finish reasons, reported token counts and failures. Context is counted using documented local JSON serialization; Arena's production chat wrapper and wall timing remain unverified, so `arena_budget_matched` and `arena_wall_matched` stay false. No provider call or tokenizer download happens in dry-run.

An offline [observation token measurement](evidence/observation-tokens.json) uses the pinned Qwen tokenizer on the 32 calibration instances. Read-all plus terminal observations range up to 1,485 tokens for a family, leaving as few as 2,611 of the candidate 4,096 completion tokens for generation. This excludes chat-template overhead and does not establish the production serializer or model performance.

See [orchestration/README.md](orchestration/README.md) for the separate evidence contract, actual rGi runtime, frozen plan, transfer requirements, authority and rollback. Its tests use synthetic fixtures explicitly marked as tests. The calibration runner emits a native calibration receipt bound to its manifest and runner revision. Retain the episode trajectories and bind their manifest and structural family names into the frozen plan. This diagnostic receipt alone cannot promote a curriculum; independently trained baseline and candidate transfer evidence is still required.

## Container and public assets

Build on an amd64 capable Docker host:

```sh
export DOCKER_DEFAULT_PLATFORM=linux/amd64
docker build -t ghcr.io/YOUR_LOWERCASE_ACCOUNT/metaharness-arena:v1 .
```

The placeholders in documentation are not publishable references. Publish the built image under an account you control, make it public, then record its actual amd64 SHA256 digest. Pull it anonymously and rerun native validation plus every task's example replay. Publish the exported tasks, generator/verifier source and dataset card as a real public, ungated Hugging Face dataset. Do not claim completion before both public artifacts are readable.

Arena uses the image, not the dataset contents, to run training. The dataset establishes public attribution and provenance. Bundle source and task assets in the image, and pin any optional asset revision. Keep image size below 2 GiB compressed and 128 layers. The Dockerfile runs as a nonroot user and exposes one port.

Export the selected native variants from the same source as the selected image:

```sh
PYTHONPATH=. python scripts/export_dataset.py .arena/selected-dataset \
  --tasks-json .arena/selected-tasks.json --seeds 32
```

The destination must be new. The task list accepts 1 to 50 canonical IDs or native task objects, including bounded knob suffixes. Validation rejects aliases, duplicates and unsupported values before creating output. Each row preserves the exact ID, family, parameters and virtual files; answer keys are excluded. `manifest.json` records declared IDs, actual generator/environment source hashes and the JSONL hash and row count. Upload all three exported files, record the public dataset revision and verify its bytes. The export does not infer an image digest or prove a source commit. Omitting `--tasks-json` retains the full 768-row legacy layout.

## Reviewable submission

Render only after the server is running and the public assets exist. Environment variables below hold nonsecret identifiers, except HF_TOKEN which must be supplied securely in the environment only.

```sh
python submission.py render \
  --submission-id metaharness-arena-v1 \
  --name 'MetaHarness Procedural Reasoning' \
  --image "$ARENA_IMAGE_DIGEST" \
  --dataset "$ARENA_DATASET" \
  --schema-url http://127.0.0.1:8000/schema \
  --tasks-json tasks.json \
  --example-actions-json example-actions.json \
  --finish-action-json finish-action.json \
  --source https://github.com/ruvnet/metaharness \
  --out .arena/submission.json
```

`ARENA_IMAGE_DIGEST` must be a real `ghcr.io/owner/image@sha256:...` or `docker.io/owner/image@sha256:...` reference with all 64 hex characters. `ARENA_DATASET` is the real HF `owner/name`. The command reads live `/schema`, enforces task limits, writes the request and prints its canonical request SHA256. It never sends a submission and does not need an HF token. The local checks cover contract shape and numeric bounds; official native validation checks full action schema semantics and replay behavior.

Show the user the exact request and wait for their explicit go-ahead before any submission. This is the user's required final gate. Check the digest without submitting:

```sh
python submission.py submit \
  --request .arena/submission.json \
  --approve-sha256 "$REVIEWED_REQUEST_SHA256" \
  --receipt .arena/submission-receipt.json
```

Only the explicit addition of `--execute`, with existing HF authentication available, sends a POST. HF_TOKEN takes priority; otherwise the official Hugging Face cache lookup is used in memory without saving or exporting a token. It first checks the caller's own submission ID, durably records intent, then records the resulting ID/status. An altered request fails the digest check. A preexisting receipt only triggers reconciliation and never a second POST. The client refuses authenticated redirects and never logs tokens or raw error bodies.

```sh
python submission.py status --receipt .arena/submission-receipt.json
```

A timeout or uncertain answer is not permission to create another ID. This client performs a status read and leaves an atomic `unknown` or `unconfirmed` receipt if unresolved. Reconcile with the official own-submission endpoint before explicitly deciding how to proceed. A leftover lock after process interruption likewise requires checking the original process and receipt. Do not delete evidence to make an uncertain request appear new.

## Evidence and release state

[evidence/live-contract.json](evidence/live-contract.json) records the official contract, a timestamped leaderboard response and read-only connection status. On 8 October 2026 at 22:59 UTC, the leading account average was 12.5%, versus an untrained 10% reference. That one-task gap is not a statistically established advantage. The latest official leaderboard remains authoritative.

Verification completed locally on 8 October 2026:

| Check | Observed result |
| --- | --- |
| Current v2 Python suite | 88/88 passed plus 782 subtests; v2 container build, tests, publication and native validator passed |
| Original generator/oracle coverage | 768 deterministic cases: 8 families × 3 difficulties × 32 seeds |
| Pinned native OpenEnv validator against a real local server process | 6/6 criteria passed; [report](evidence/openenv-runtime.json) and [native schema](evidence/schema.json) |
| Submission safety tests | 22/22 passed |
| MetaHarness/rGi workflow tests | 16/16 passed, zero skipped |
| Linux amd64 container build, isolated controls and native runtime | Passed in [GitHub Actions](https://github.com/ruvnet/metaharness/actions/runs/37858042127): 61 tests and 6/6 protocol criteria |
| GHCR push, anonymous pull and 61 container controls | Passed in [publication CI](https://github.com/ruvnet/metaharness/actions/runs/37858361136) |
| Native WebSocket controls | 32/32 episodes passed from the anonymously pulled release on a [fresh runner](https://github.com/ruvnet/metaharness/actions/runs/37859352503); reports archived |
| Actual model calibration or transfer | 77 v1 rewards independently replayed; v2 model probe pending; no transfer result |
| Arena submission and private evaluation | Not run |

The native validator report uses the SDK label `mode: simulation` for its local protocol check. It contacted the running localhost HTTP/WebSocket server; it is not a GPU training or model performance result. These checks establish a local foundation. A built and anonymously verified public image, attributed public dataset, accepted submission and private evaluation must each be reported separately. No Arena submission or public board message is sent by the implementation tests.

Acceptance: run the native validator and full local suite, replay every declared task from the exact anonymous image digest, then obtain an actual private evaluation whose public attributed score exceeds the contemporaneous leader. Until the final step, competitive performance remains unmeasured.

Released image: `ghcr.io/ruvnet/metaharness-arena@sha256:730f64d25ff21431a0af9c5d4fea8da2d74257569e1d53a2295d90c2c9721252`. This is the v1 baseline built from source commit `90a793a9f4f1a06a5b6422164951e9192c909daa`. Publication and anonymous registry access passed. The public HF dataset is [ruv/metaharness-arena-tasks](https://huggingface.co/datasets/ruv/metaharness-arena-tasks), revision `8323b7b221ea977d8fce4409973678a80e50fb77`, verified anonymously as 768 rows. Model evidence and final user approval remain separate gates.


V2 image is public: `ghcr.io/ruvnet/metaharness-arena@sha256:228329c4928eef054d6e1d3021c9867df416539d4d5e656cc760f97c17c9e35a`, built from `4657e5b82e124917b01d79ee5e9de41badb48fda`. [Publication CI](https://github.com/ruvnet/metaharness/actions/runs/37861943028) passed 88 tests plus 782 subtests, all six native protocol checks, runtime absence of test packages, and anonymous digest pull. It contains stronger regression coverage, drift calibration, partial reversals, time windows and mixed frame rates. [V2 observation measurements](evidence/observation-tokens-v2.json) remain below 1,500 post-reset tokens for the sampled two-action episodes. The [fresh runner replay](https://github.com/ruvnet/metaharness/actions/runs/37862215898) passed all 32 WebSocket controls and six native checks on the exact public digest. Final task/budget selection remains pending. The public HF dataset now matches v2 at revision `c359366240115bfb24d2edae807c8e52ed5b39f0`: 768 rows, SHA256 `ffa57cbf04758156b15d61662a8faa7f4129f938bdc21c023dc897330e771ed3`, verified anonymously. Do not submit the superseded v1 candidate JSON.

The [optimization plan](PLAN.md#phase-1b-evolve-the-environment-with-measured-evidence) now requires bounded Darwin proposals and a comparative Flywheel submission readiness gate. Count only valid mixed success cells with complete evidence, exclude truncation and infrastructure failures, and confirm a strict gain on fresh seeds. Proxy screening and failure clustering remain conditional on feasibility. Neither this metric nor a signed local decision establishes learned transfer or an official Arena score. The exact request still requires explicit user approval.

V3 adds two bounded [generator controls](KNOBS.md) for the external Darwin lane: regression suite count and science sample count. Existing v2 default instances are unchanged. Image `ghcr.io/ruvnet/metaharness-arena@sha256:2f3f12b986574ac99ecae451f47408ea5c8cc12c4fa27bf1c5cafa6880676b37` was built from `0af81c55269be029dd64ccdc79e23654aa9dcaa4`; [publication CI](https://github.com/ruvnet/metaharness/actions/runs/37863855948) passed 140 container tests, 782 subtests and six native checks. Local native replay passed all 16 knob boundary episodes. [Fresh anonymous replay](https://github.com/ruvnet/metaharness/actions/runs/37864151455) of this digest passed 32 base episodes, 16 knob boundary episodes and all six protocol checks. No measured knob improvement is claimed; the final selected variants and matching public dataset revision remain pending. The [proxy feasibility review](evidence/proxy-feasibility.json) defers ruvllm Qwen screening and semantic failure clustering until their concrete blockers are resolved.

[Complete v2 calibration review](evidence/calibration-v2-review.json) independently replayed all 64 episodes and 128 request accounting checks without mismatches: 43 full successes, 10 partial rewards and 11 observed truncations. Five of 16 cells are valid mixed, six saturated and five excluded for truncation. The same review verifies the completed v1 capture of 96 episodes, retaining unknown causes for its 21 validation failures. V1/v2 settings differ, and v2 omitted modern reasoning history, so these results do not establish a matched improvement or pass the submission gate.

The [answer failure audit](evidence/calibration-v2-failure-facets.json) found that five science partials omitted precisely the quarantined samples from `medians` while computing the remaining medians and accepted mean correctly. The current source explicitly requires every sample in that map. This is a prompt clarification, with unchanged inputs, answers, verifier and knobs. All 140 tests and 782 subtests pass, including the frozen task comparison with only that documented clause permitted. A new image and new model calibration are required for this clarified source; the already qualified evolution image above remains the prior version. These completeness failures must not be represented as measured arithmetic difficulty.

The clarified science image is public at `ghcr.io/ruvnet/metaharness-arena@sha256:77b83bb41f4e968fee5ba54a0c57c5e70cb90ecafda7dde1f18e7280943ed941`, built from `9dcd7ab5fc45a61be599770c0fb89c3d68772f60`. [Publication CI](https://github.com/ruvnet/metaharness/actions/runs/37865671261) passed 140 tests, 782 subtests, six protocol checks and anonymous container controls. Fresh full native replay and model recalibration are pending. The variant exporter supports exact selected native IDs and records their source and dataset hashes. This image is a clarified baseline, with no measured fitness win claimed.
