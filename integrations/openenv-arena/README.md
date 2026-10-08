# MetaHarness OpenEnv Arena

An original procedural training environment and bounded curriculum review workflow for [OpenEnv Arena](https://openenvarena-arena.hf.space/). It prepares a competitive entry; it does not establish an Arena rank or model improvement. Read [PLAN.md](PLAN.md) for the measured strategy, budgets and gates.

Arena trains **its fixed Qwen3.8-27B** with GRPO on one H200 for up to four hours, then evaluates 40 private tasks across eight domains. We supply the environment that teaches the model. MetaHarness, Autogenous, rGi and Ruflo belong around curriculum development, evaluation and governance. They are not an ensemble installed into the Arena evaluator.

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

Use real provider values, configure the named API key environment variable, review its cost ceiling and add `--execute` only to run it. Defaults allow 32 episodes, at most 128 requests and 262,144 generated tokens; actual input token use and dollar cost depend on the provider. Four attempts identify obvious difficulty problems; they do not prove improvement.

See [orchestration/README.md](orchestration/README.md) for the separate evidence contract, actual rGi runtime, frozen plan, transfer requirements, authority and rollback. Its tests use synthetic fixtures explicitly marked as tests. The calibration runner emits a native calibration receipt bound to its manifest and runner revision. Retain the episode trajectories and bind their manifest and structural family names into the frozen plan. This diagnostic receipt alone cannot promote a curriculum; independently trained baseline and candidate transfer evidence is still required.

## Container and public assets

Build on an amd64 capable Docker host:

```sh
export DOCKER_DEFAULT_PLATFORM=linux/amd64
docker build -t ghcr.io/YOUR_LOWERCASE_ACCOUNT/metaharness-arena:v1 .
```

The placeholders in documentation are not publishable references. Publish the built image under an account you control, make it public, then record its actual amd64 SHA256 digest. Pull it anonymously and rerun native validation plus every task's example replay. Publish the exported tasks, generator/verifier source and dataset card as a real public, ungated Hugging Face dataset. Do not claim completion before both public artifacts are readable.

Arena uses the image, not the dataset contents, to run training. The dataset establishes public attribution and provenance. Bundle source and task assets in the image, and pin any optional asset revision. Keep image size below 2 GiB compressed and 128 layers. The Dockerfile runs as a nonroot user and exposes one port.

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
| Full Python suite | 61/61 passed |
| Original generator/oracle coverage | 768 deterministic cases: 8 families × 3 difficulties × 32 seeds |
| Pinned native OpenEnv validator against a real local server process | 6/6 criteria passed; [report](evidence/openenv-runtime.json) and [native schema](evidence/schema.json) |
| Submission safety tests | 22/22 passed |
| MetaHarness/rGi workflow tests | 16/16 passed, zero skipped |
| Linux amd64 container build, isolated controls and native runtime | Passed in [GitHub Actions](https://github.com/ruvnet/metaharness/actions/runs/37858042127): 61 tests and 6/6 protocol criteria |
| GHCR push, anonymous pull and 61 container controls | Passed in [publication CI](https://github.com/ruvnet/metaharness/actions/runs/37858361136) |
| Native WebSocket controls | 32/32 local episodes passed across every declared task; fresh runner release replay pending |
| Actual model calibration or transfer | Not run |
| Arena submission and private evaluation | Not run |

The native validator report uses the SDK label `mode: simulation` for its local protocol check. It contacted the running localhost HTTP/WebSocket server; it is not a GPU training or model performance result. These checks establish a local foundation. A built and anonymously verified public image, attributed public dataset, accepted submission and private evaluation must each be reported separately. No Arena submission or public board message is sent by the implementation tests.

Acceptance: run the native validator and full local suite, replay every declared task from the exact anonymous image digest, then obtain an actual private evaluation whose public attributed score exceeds the contemporaneous leader. Until the final step, competitive performance remains unmeasured.

Released image: `ghcr.io/ruvnet/metaharness-arena@sha256:730f64d25ff21431a0af9c5d4fea8da2d74257569e1d53a2295d90c2c9721252`. This is the candidate built from source commit `90a793a9f4f1a06a5b6422164951e9192c909daa`. Publication and anonymous registry access passed. The public HF dataset is [ruv/metaharness-arena-tasks](https://huggingface.co/datasets/ruv/metaharness-arena-tasks), revision `8323b7b221ea977d8fce4409973678a80e50fb77`, verified anonymously as 768 rows. Model evidence and final user approval remain separate gates.
