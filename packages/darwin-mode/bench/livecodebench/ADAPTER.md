# LiveCodeBench adapter — Darwin cost-Pareto leaderboard

Board: **LiveCodeBench** — contamination-free competitive-programming code generation.
Status: **BUILT + MEASURED (n=100)**. At a balanced n=100 (release_v5 ≥2024-11-01): single-shot deepseek-chat
(robust extractor) = **44/100 = 44%**; cost-cascade (escalate to deepseek-r1-0528 on empty/public-test-failure)
= **62/100 = 62%** (attributable cascade lift +8 on the 27 escalated problems; the rest of the raw +18 is temp-0
nondeterminism — see LEARNINGS §46b). The older easy-skewed n=25 single-shot was 64%; n=100 is balanced and harder.
The SWE-bench agentic harness does NOT transfer directly (see §1); the solver below is purpose-built.

Two arms (same instances, run via `solve-lcb.mjs`):
- (A) single-shot:  `--model deepseek/deepseek-chat`
- (B) cost-cascade: `--cascade --escalate-model deepseek/deepseek-r1-0528` (escalates ONLY on empty extraction or
  PUBLIC-example-test failure; hidden grading tests are NEVER run during solving — they stay with custom_evaluator).
  NOTE: the OpenRouter reasoner id is `deepseek/deepseek-r1-0528` (the DeepSeek-native `deepseek-reasoner` name does
  NOT route on OpenRouter).

## 7. Validated result (ADR-LCB, measured)

- **Solver**: `solve-lcb.mjs` (single-shot, mirrors the official `code_generation.py` prompt + `extract_code`).
- **Manifest**: `build-manifest.py` → `lcb-v5.json` (n=25, balanced subset of release_v5 ≥2024-12-01, post-cutoff).
- **Eval**: `eval-subset.py` — thin question_id-subset wrapper around `lcb_runner.runner.custom_evaluator`; the
  scorer (`codegen_metrics`) is the OFFICIAL one, untouched. (`custom_evaluator` asserts len(outputs)==len(benchmark),
  so we align the windowed benchmark to our 25 by question_id; this is problem-selection, not a reimplemented scorer.)
- **Eval validation (done first)**: known-correct (stdin+functional) → PASS (1.0); empty/wrong → FAIL (0.0). Trustworthy.
- **Result**: single-shot **16/25 = 64.0%**, Wilson 95% CI [44.5%, 79.8%], $0.00123/problem. By difficulty: easy 8/9,
  medium 6/8, hard 2/8. TDR-style public-test repair (`--repair`): **no lift** (overfits the visible sample).

### Setup notes (official harness on a fresh box)
- `git clone --depth 1 https://github.com/LiveCodeBench/LiveCodeBench` + `uv venv --python 3.11`.
- Do NOT `uv pip install -e .` (pulls vllm+torch, GBs). Minimal eval deps: `attrs tqdm numpy pebble pandas anthropic`
  + **`datasets==3.2.0`** (datasets ≥4 dropped loading-script support that LCB's HF dataset needs).
- `parser.py` imports `torch` only for `cuda.device_count()` — a 5-line `torch` stub suffices for the eval path.
- Run eval with `cwd=~/LiveCodeBench` and `PYTHONPATH=~/LiveCodeBench` (lcb_runner is not installed as a package).

## 0. The official harness (verified, not invented)

- **Repo**: <https://github.com/LiveCodeBench/LiveCodeBench> — "Official repository for the
  paper *LiveCodeBench: Holistic and Contamination Free Evaluation of Large Language Models for Code*."
- **Runner package**: `lcb_runner` (Python 3.11, installed editable via `uv pip install -e .`).
- **Project page / leaderboard**: <https://livecodebench.github.io/>
- **HF leaderboard write-up**: <https://huggingface.co/blog/leaderboard-livecodebench>

### Datasets (HuggingFace)
| dataset | scenario |
|---|---|
| `livecodebench/code_generation_lite` | code generation (default; pruned hidden tests for speed) |
| `livecodebench/execution` | code execution prediction |
| `livecodebench/test_generation` | test output prediction |

Code-generation **release versions** (cumulative, date-windowed — this is the contamination-free knob):
- `release_v1` 400 problems (May 2023–Mar 2024)
- `release_v2` 511 (–May 2024)
- `release_v3` 612 (–Jul 2024)
- `release_v4` 713 (–Sep 2024)
- `release_v5` 880 (–Jan 2025)
- `release_v6` 1055 (–Apr 2025)

Selected with `--release_version release_v5`; sub-window with `--start_date YYYY-MM-DD`
(+ `--end_date`) in `compute_scores.py`. **To stay contamination-free for a model with a
known training cutoff, pick `--start_date` AFTER that cutoff** — this is the whole point of LCB.

### Problems
- **Language: Python only** (solutions are Python; LCB does not score other languages for codegen).
- Sourced from **LeetCode, AtCoder, Codeforces**.
- Each problem carries `question_id`, `question_content`, `starter_code`, `public_test_cases`,
  `private_test_cases` (base64+zlib for some versions), `platform`, `difficulty`, `contest_date`.
- **Two input modes**: *functional* (LeetCode — a `starter_code` class/method to complete) and
  *stdin/stdout* (AtCoder/Codeforces — read stdin, print stdout). The solver MUST detect which
  from the presence of `starter_code` and emit the matching shape. The official prompt builder
  (`lcb_runner/prompts/code_generation.py`) encodes this; mirror it.

### Scoring
- Metric: **pass@1** (and pass@5) = `total_correct / total_attempts`, computed by a modified
  APPS checker (`lcb_runner/evaluation/`). A submission is "correct" only if it passes **all**
  public+private test cases for that problem (all-or-nothing per problem).
- Execution isolation is **OS-level timeouts + process pool**, NOT Docker:
  `--num_process_evaluate N --timeout 6` (seconds per test). No container image to pull.
- Run: `python -m lcb_runner.runner.main --model M --scenario codegeneration --evaluate`.

### Custom outputs (the integration seam we use)
`lcb_runner` has a first-class path for externally-generated solutions:
```bash
python -m lcb_runner.runner.custom_evaluator --custom_output_file outputs.json
```
with `outputs.json`:
```json
[{"question_id": "id1", "code_list": ["code1", "code2"]}, ...]
```
`code_list` holds N candidate completions per problem (N=1 for pass@1; pass@k needs k samples).
This is the clean boundary: **our solver produces `code_list`, the official `custom_evaluator`
runs the hidden tests and emits pass@1.** We do not reimplement the checker.

## 1. Why our SWE-bench harness does NOT transfer 1:1 (honest gap)

`solve-agentic.mjs` is built around: clone a repo → ReAct loop that reads/greps/edits files +
calls a **Docker test oracle** → emit a unified diff (`model_patch`). LiveCodeBench has:
- **no repo, no diff, no Docker oracle** — the unit of work is "write a standalone Python program";
- **its own checker** (we must NOT substitute SWE-bench's `run_evaluation`);
- a **functional-vs-stdin** output contract our SWE-bench prompt never deals with.

So we keep our solver's *infrastructure* (OpenRouter client with retry/backoff, `--model`,
`--base-url`/`--api-key-env`, concurrency worker pool, `--max-cost` budget cap, per-call
`usage.cost` capture, JSONL streaming) and **swap the task loop** for LCB-shaped generation.

Two solver shapes, both supported by the stub:
1. **Single-shot generation** (true-to-LCB-leaderboard baseline): one prompt → one program.
   Matches how the official leaderboard scores most models. Cheapest, most comparable.
2. **Agentic self-repair (optional)**: reuse `agentic-loop.mjs`'s ReAct core but back `run_tests`
   with the problem's **public** test cases run in a throwaway local Python subprocess
   (`python3 -c` / temp file), never the private ones. Private tests stay with `custom_evaluator`
   for final scoring — this is the leakage-free analogue of our `--no-test-oracle` rule. LCB also
   ships a native `selfrepair` scenario; our agentic loop is a superset and stays comparable as
   long as private tests are gold-held.

## 2. Adapter design

```
HF dataset (code_generation_lite, release_vN)
        │  (lcb-export.mjs OR hf datasets in-runner)
        ▼
manifest.json  [{question_id, question_content, starter_code, public_test_cases, platform, difficulty}]
        │
        ▼
solve-lcb.mjs  ── per problem ──▶ build LCB prompt (functional vs stdin) ──▶ OpenRouter (--model)
        │                                                   │
        │                          (optional) public-test self-repair via agentic-loop.mjs
        ▼
outputs.json  [{question_id, code_list:[code]}]      + cost-report.json (per-problem usage.cost)
        │
        ▼
python -m lcb_runner.runner.custom_evaluator --custom_output_file outputs.json   ← OFFICIAL scorer
        │
        ▼
pass@1 + per-problem pass/fail  ──merge with cost-report──▶  $/problem + $/solved (Pareto point)
```

Steps:
1. **Export tasks → manifest.** Easiest is to let `lcb_runner` load the HF dataset and dump
   `question_id/question_content/starter_code/public_test_cases` to JSON (small Python one-liner
   using `lcb_runner.benchmarks` loaders), so our Node solver reads a static manifest and never
   needs `datasets` at solve time. `solve-lcb.mjs` reads `--manifest`.
2. **Generate.** `solve-lcb.mjs` mirrors `solve-agentic.mjs`'s OpenRouter client verbatim
   (retry/backoff, `usage.cost`, `--model`, `--base-url`, `--api-key-env`, `--concurrency`,
   `--max-cost`). For each problem: choose the functional or stdin prompt template, extract the
   final code block, write `{question_id, code_list:[code]}` to `outputs.json`, and append the
   per-problem cost to `cost-report.json`.
3. **Score with the official harness.** Run `custom_evaluator` in the LCB venv. It executes
   public+private tests under process-pool + timeout and reports pass@1. We parse its output JSON.
4. **Cost-per-task.** Sum `usage.cost` from OpenRouter per problem (already captured the same way
   as SWE-bench). Pareto point = pass@1 vs mean `$/problem`; also report `$/solved`.

### Cost capture
Identical mechanism to SWE-bench: OpenRouter returns `usage.cost` (USD) on each completion when
the request includes `usage:{include:true}` (or via the generation endpoint). `solve-lcb.mjs`
accumulates per-problem and globally, honoring `--max-cost` to stop pulling new problems.

## 3. Exact GCP run command

Provision an `e2-standard-4` (the checker is CPU + light; no GPU, no Docker image pull needed,
pd-standard is fine; bump to `e2-standard-8` if you raise `--num_process_evaluate`). OpenRouter
key via metadata (same as SWE-bench VMs).

```bash
# --- one-time VM setup ---
gcloud compute instances create lcb-cheap-1 \
  --project="$GCP_PROJECT" --zone=us-central1-a \
  --machine-type=e2-standard-4 --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-type=pd-standard --boot-disk-size=50GB \
  --metadata-from-file=startup-script=<(cat <<'EOF'
#!/bin/bash
set -e
apt-get update && apt-get install -y git python3.11 python3.11-venv curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
curl -LsSf https://astral.sh/uv/install.sh | sh
EOF
)

# --- on the VM ---
export OPENROUTER_API_KEY="$(curl -s -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/openrouter-key')"

# 1. official harness
git clone https://github.com/LiveCodeBench/LiveCodeBench.git ~/LiveCodeBench
cd ~/LiveCodeBench && ~/.local/bin/uv venv --python 3.11 && . .venv/bin/activate && uv pip install -e .

# 2. export the manifest from the official loader (release_v5, full set)
python - <<'PY'
import json
from lcb_runner.benchmarks.code_generation import load_code_generation_dataset
ds = load_code_generation_dataset(release_version="release_v5")
out = [{"question_id": p.question_id, "question_content": p.question_content,
        "starter_code": p.starter_code, "platform": str(p.platform),
        "difficulty": str(p.difficulty),
        "public_test_cases": [t.__dict__ if hasattr(t,'__dict__') else t for t in p.public_test_cases]}
       for p in ds]
json.dump({"release":"release_v5","instances":out}, open("/tmp/lcb-v5.json","w"))
print("manifest", len(out))
PY

# 3. generate with our cheap solver (DeepSeek-V4-Flash default; --max-cost caps spend)
cd ~/agent-harness-generator/packages/darwin-mode/bench/livecodebench
node --experimental-strip-types --no-warnings solve-lcb.mjs \
  --manifest /tmp/lcb-v5.json \
  --model deepseek/deepseek-chat \
  --concurrency 4 --max-cost 5.00 \
  --out /tmp/lcb-outputs.json --cost-report /tmp/lcb-cost.json

# 4. score with the OFFICIAL harness (private tests, never seen during generation)
cd ~/LiveCodeBench && . .venv/bin/activate
python -m lcb_runner.runner.custom_evaluator \
  --custom_output_file /tmp/lcb-outputs.json \
  --release_version release_v5 \
  --num_process_evaluate 4 --timeout 6

# 5. merge pass@1 (from custom_evaluator output) with /tmp/lcb-cost.json → $/problem, $/solved
```

For a fast smoke pilot before the full set: add `--limit 25` to `solve-lcb.mjs` and
`--start_date 2025-02-01` to keep only post-cutoff, contamination-free problems.

## 4. Cost-per-task estimate (DeepSeek-V3/V4-Flash class, single-shot)

LCB problems are small (prompt ~500–1500 tok incl. problem statement + examples; output a single
program ~300–900 tok). At DeepSeek-V3 OpenRouter rates (~$0.20/M in, ~$0.80/M out):
- per problem ≈ (1.2k×0.20 + 0.7k×0.80)/1e6 ≈ **$0.0008/problem** single-shot.
- release_v5 (880 problems) ≈ **$0.70** single-shot; **~$2–3** with 3-attempt self-repair.
- GLM-5.2 / Kimi-K2.6 land in the same order of magnitude; expect **<$0.005/problem** all-in.
- Pareto point reports both `$/problem` (denominator = all problems) and `$/solved`
  (denominator = pass@1×N).

This is far cheaper than SWE-bench (no repo clone, no Docker, tiny contexts) — LCB is a
low-cost, high-signal addition to the cost-Pareto board.

## 5. Blockers / risks (honest)

- **Not agentic by nature.** The leaderboard-comparable number is single-shot pass@1; our
  agentic self-repair is a separate, clearly-labeled track (public-tests-only feedback) so it
  stays leakage-free. Don't conflate the two on the board.
- **Functional vs stdin prompt contract** must match the official `code_generation.py` builder
  exactly, or solvable problems fail on formatting (wrong I/O shape), depressing pass@1
  artificially. Validate the stub's two templates against 3 known LeetCode + 3 AtCoder problems
  before trusting the number.
- **private_test_cases encoding**: some releases ship them base64+zlib-compressed and gated;
  we never touch them — `custom_evaluator` decodes them. Just don't try to self-repair against them.
- **No Docker sandbox** means the official checker runs arbitrary model-generated Python on the VM
  under a timeout. Run scoring on a disposable GCE VM (it already is), not a shared box.
- **Version/date hygiene**: to claim "contamination-free" for a given model, pin
  `--start_date` after that model's training cutoff. Mixing windows across models makes the
  board non-comparable.
- **pass@5** needs 5 samples/problem (temp>0) — 5× generation cost; default to pass@1.

## 6. Effort

- Wire `solve-lcb.mjs` (single-shot) + manifest export + scoring glue + cost-merge: **~1 day**.
- The OpenRouter client, worker pool, `--max-cost`, and cost capture are lifted verbatim from
  `solve-agentic.mjs`, so the only genuinely new code is the two LCB prompt templates, the
  code-block extractor, and the `custom_evaluator` invocation/parse.
- Optional agentic self-repair track (reuse `agentic-loop.mjs` with public-test feedback):
  **+0.5 day**.
