# GAIA adapter — MetaHarness / Darwin cost-Pareto leaderboard

Status: DESIGN + STUB. Not yet runnable end-to-end (HF gating + tool-using ReAct
loop are the integration work). Honest feasibility: **needs-adapter** (a real
adapter, not a thin wrapper) — see Blockers.

## 1. What GAIA actually is (researched, cited — not invented)

- **GAIA: a benchmark for General AI Assistants** (Mialon et al., 2023),
  arXiv:2311.12983. 466 real-world questions, single unambiguous answer each,
  graded over **3 levels** (L1 ≈ 1–2 steps, L2 ≈ 3–5 steps + tools, L3 long
  multi-step). Many questions ship an **attachment file** (PDF/xlsx/png/audio/…).
- **Dataset**: HuggingFace `gaia-benchmark/GAIA` (GATED — must accept terms +
  `HF_TOKEN`). Configs: `2023_all`, `2023_level1`, `2023_level2`, `2023_level3`,
  each with `validation` and `test` splits. Fields per row:
  `task_id`, `Question`, `Level`, `Final answer`, `file_name`, `file_path`,
  `Annotator Metadata`.
  - **validation** split: 165 questions, **answers public** → score locally.
  - **test** split: 300 questions, **answers PRIVATE** → only scorable by the
    official HF leaderboard Space (submit a JSONL, it scores server-side).
- **Official scorer**: `scorer.py` in the leaderboard Space
  `huggingface.co/spaces/gaia-benchmark/leaderboard` (file
  `scorer.py`). Single entry point:
  ```python
  def question_scorer(model_answer: str, ground_truth: str) -> bool
  ```
  Three normalization pathways: numeric (`normalize_number_str` strips `$ % ,`
  → float eq), comma/semicolon list (`split_string`, element-wise), and string
  (`normalize_str`: strip whitespace, drop punctuation, lowercase). **Exact-match
  after normalization** — NOT an LLM judge.
- **Submission/metric**: per-level accuracy + overall accuracy (% exactly
  correct). Leaderboard submission format is JSONL with one object per task:
  `{"task_id": "...", "model_answer": "...", "reasoning_trace": "..."}`.
- **Reference numbers**: humans ≈ 92%; GPT-4 + plugins ≈ 15% (paper). Modern
  tool-using agents (HAL/smolagents-class) reach 60–75% on subsets.

Sources:
- arXiv:2311.12983 — https://arxiv.org/abs/2311.12983
- Dataset (gated) — https://huggingface.co/datasets/gaia-benchmark/GAIA
- Official scorer — https://huggingface.co/spaces/gaia-benchmark/leaderboard/blob/main/scorer.py
- inspect_evals GAIA (alt harness) — https://github.com/UKGovernmentBEIS/inspect_evals/tree/main/src/inspect_evals/gaia

## 2. The honest gap vs. our SWE-bench stack

Our `bench/swebench/solve-agentic.mjs` ReAct loop is **code-shaped**: its tools
are `readFile / listDir / writeFile / gitDiff / grepRepo / applyEdit / runTests`,
and "gold eval" is the SWE-bench Docker oracle. **GAIA shares ZERO of that.**
GAIA needs **assistant tools**: `web_search`, `web_browse`, `file_read`
(attachment), `image_describe`/OCR, `python_exec` (calc/parse), `audio/video`.
The output is a single short `FINAL_ANSWER` string, scored by exact-match, not a
patch scored by tests. So the reusable parts are narrow but real:
the OpenRouter `llm()` client (model + `--base-url` + cost capture), the bounded
ReAct step loop skeleton, the JSONL streaming + per-task report + `--max-cost`
budget gate, and the GCE run pattern.

There is ALSO an existing, separate GAIA harness in the `ruflo-workflows` plugin
(`gaia-benchmark-runner` agent, `/gaia run`, `gaia-bench.ts`/`gaia-agent.ts`/
`gaia-judge.ts`/`gaia-loader.ts`/`gaia-tools/`). **Caveats for the Pareto board:**
(a) it lives under `v3/@claude-flow/cli/` which is **not present in THIS repo**;
(b) it scores with an **LLM-as-judge** (`gaia-judge.ts`), **not** the official
`question_scorer` — its numbers are NOT leaderboard-comparable; (c) it is
Anthropic-keyed by default (haiku/sonnet), not our cheap-OpenRouter models.

**Decision for the cost-Pareto board: build a thin adapter that REUSES our
OpenRouter loop + cost capture, gives it GAIA assistant-tools, and scores with
the OFFICIAL `question_scorer` on the public `validation` split.** Drop the
LLM-judge entirely for headline numbers (use validation, where answers are
public + exact-match is authoritative). Reserve `test`-split for an optional,
manual HF leaderboard submission.

## 3. Adapter design

### 3a. Dataset → manifest (`gaia-loader.mjs`, stub here)
```
python3 -c '... snapshot_download(gaia-benchmark/GAIA) ; load_dataset(dir,"2023_all",split="validation")'
  → emit manifest.json: [{task_id, question, level, file_name, file_path, answer}]
  → copy any attachment files into ./attachments/<task_id>/<file_name>
```
Requires `HF_TOKEN` (gated) + `pip install datasets huggingface_hub`. We keep the
gold `answer` only for local scoring; never feed it to the solver.

### 3b. Solver: `solve-gaia.mjs` (the adapter — stub written here)
- Reuse VERBATIM from `solve-agentic.mjs`: arg parsing, `--model`, `--base-url`,
  `--api-key-env`, `--concurrency`, `--max-cost` budget gate, `llm()` (cost via
  `j.usage.cost`), JSONL streaming, per-task report, worker pool.
- Replace the SWE-bench `io` tool surface with a **GAIA tool surface**:
  - `web_search(query)`    — DuckDuckGo HTML (no key) or Google CSE if keyed.
  - `web_browse(url)`      — fetch + readability-to-text, truncate to MAX_OUT.
  - `file_read(task_id)`   — read the attachment (xlsx→csv, pdf→text via local
                              libs; image/audio → describe via a vision model).
  - `python_exec(code)`    — run in the SAME Docker we already use, `--network
                              none`, for arithmetic/parsing (matches "edits code
                              + runs tests in Docker" capability).
  - `submit(final_answer)` — terminal action; capture string.
- Loop ends on `submit` or `--max-steps` (GAIA default 12–20 turns).
- Output JSONL row: `{task_id, model, model_answer, level, cost_usd, steps}`.

### 3c. Scorer: `score-gaia.mjs` → official `question_scorer` (NO reimplementation)
- Vendor the official `scorer.py` ONCE into `bench/gaia/scorer.py` (it is the
  ground truth for normalization edge cases — do not reimplement in JS).
- `score-gaia.mjs` shells: for each prediction, call
  `python3 -c "from scorer import question_scorer; print(question_scorer(ma, gt))"`
  (batch via a tiny driver to avoid per-row process spawn).
- Report: overall accuracy, per-level accuracy, total cost, **cost-per-task**,
  cost-per-correct — the Pareto axes.

### 3d. Cost-per-task capture (the leaderboard axis)
OpenRouter returns `usage.cost` per call (already summed in `solve-agentic.mjs`
as `totalCost`). The adapter sums per-task LLM cost into the prediction row;
`score-gaia.mjs` divides total cost by N tasks → **`$/task`**, and by #correct →
`$/correct`. This is the same cost path our SWE-bench Pareto board already uses.

## 4. Exact GCP run command (GCE VM, same pattern as SWE-bench)

```bash
# On a GCE e2-standard-4 VM, pd-standard, with docker + node20 + python3 + the
# OpenRouter key delivered via instance metadata (key=openrouter-api-key) and
# HF_TOKEN via metadata (key=hf-token). Mirrors the SWE-bench VM recipe.

# 0. fetch secrets from metadata (no key in image/repo)
export OPENROUTER_API_KEY=$(curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/openrouter-api-key")
export HF_TOKEN=$(curl -s -H "Metadata-Flavor: Google" \
  "http://metadata.google.internal/computeMetadata/v1/instance/attributes/hf-token")

# 1. one-time: deps + gated dataset → manifest (validation, all levels, 165 Q)
pip install --quiet datasets huggingface_hub
node --experimental-strip-types packages/darwin-mode/bench/gaia/gaia-loader.mjs \
  --config 2023_all --split validation --out manifest-val.json --attach-dir ./attachments

# 2. solve with a cheap OpenRouter model, budget-capped (the Pareto candidate)
node --experimental-strip-types --no-warnings \
  packages/darwin-mode/bench/gaia/solve-gaia.mjs \
  --manifest manifest-val.json --attach-dir ./attachments \
  --model deepseek/deepseek-chat --max-steps 16 --concurrency 3 \
  --max-cost 5 --out predictions-gaia-val.jsonl --report solve-gaia-report.json

# 3. score with the OFFICIAL scorer (vendored scorer.py) → Pareto point
node --experimental-strip-types packages/darwin-mode/bench/gaia/score-gaia.mjs \
  --manifest manifest-val.json --predictions predictions-gaia-val.jsonl \
  --report gaia-score.json
# gaia-score.json: {overall_acc, per_level_acc, n, total_cost_usd, cost_per_task, cost_per_correct}
```

VM provisioning is identical to the SWE-bench board (gcloud compute instances
create e2-standard-4, pd-standard, startup-script installs node/python/docker,
secrets via `--metadata`). GAIA needs NO large per-instance Docker images
(SWE-bench's heaviest cost) — only the small `python_exec` sandbox — so a
**smaller/cheaper VM than SWE-bench works**; network egress (web_search/browse)
is the main difference.

## 5. Cost-per-task estimate

Cheap OpenRouter models (DeepSeek-V4-Flash / GLM-5.2 / Kimi-K2.6) at ~12–16
tool turns/task, ~3–8k tokens/turn including fetched web text. Rough order:
**~$0.01–0.05 / task** on the cheap tier (vs. Sonnet-class ~$0.10–0.30/task).
165-Q validation full run ≈ **$2–8**. The `--max-cost 5` gate bounds it. Exact
number is captured empirically by `score-gaia.json.cost_per_task` after run 1.

## 6. Blockers (honest)

1. **HF gating**: dataset needs accepted terms + `HF_TOKEN`. Must accept the
   GAIA license on the HF account tied to the token before any load works.
2. **Tool surface is net-new**: web_search/browse/file_read/image_describe do
   NOT exist in our SWE-bench `io`. This is the bulk of the work (multi-modal:
   xlsx/pdf/image/audio readers). Reusing the loop skeleton is easy; the tools
   are the integration.
3. **Test split unscorable locally**: headline numbers must come from the
   **validation** split (165 Q, public answers). `test` (300 Q) requires a
   manual HF-leaderboard-Space submission — not automatable in-VM at $/task.
4. **Vendoring scorer.py**: must copy the official file (re-fetch on update);
   do NOT reimplement — its normalization edge cases define comparability.
5. **The plugin's `gaia-judge.ts` numbers are NOT comparable** (LLM judge ≠
   official exact-match) and its source isn't in this repo — treat as a separate
   prior-art system, not the scorer for the Pareto board.

## 7. Effort

- Loop + cost + JSONL + GCP recipe (reuse from solve-agentic.mjs): hours.
- GAIA tool surface (web_search/browse/file_read + image/pdf/xlsx + python_exec
  Docker sandbox): **multi-day** (this dominates).
- Loader + official scorer wiring: hours.
- Net: **multi-day** to a credible first validation-split Pareto point.
