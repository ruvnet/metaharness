# Agentic-board integration roadmap

From workflow w9811j59k (ADR-181). 6 boards scaffolded concurrently.

## Synthesized roadmap

I have all the data I need in the specs. Let me synthesize the roadmap directly.

# Integration Roadmap — 6 benchmark boards

## 1) Ranked implementation order

Ranked by effort vs. cost-Pareto-story strength. The first three are all `effort: day` and reuse the most existing code; they front-load the strongest cost-Pareto narratives.

1. **LiveCodeBench** (`day`) — **Do first.** Cheapest to run (~$0.70/run for v5's 880 problems, no Docker, tiny contexts), and the solver is the most direct reuse: lift the OpenRouter client + concurrency + `--max-cost` from `solve-agentic.mjs`, add two prompt templates and a code extractor. Single-shot pass@1 vs $/problem is an immediately comparable Pareto point and a clean contamination story (`--start_date` after cutoff). Stub already written. Fastest path to a credible second board after SWE-bench English.

2. **SWE-bench Multilingual** (`day`) — **Do second.** Highest narrative leverage: it's the *same* `swebench` pip harness and the *same* `resolved_ids` scorer we already shell out to, so the final scorer is a one-flag change (`--dataset_name SWE-bench/SWE-bench_Multilingual`). Extends our existing English cost-Pareto ladder to 9 languages on the same axes. Only 3 small deltas + a manifest builder; gold scoring is language-agnostic for free. Main cost is VM-hours, not API.

3. **Aider Polyglot** (`day`) — **Do third.** Adapter is a new io provider, not a new solver (our `agenticSolve` is already DI'd). Gives a "model alone (Mode B) vs model+our harness (Mode A)" lift story on the same cost axis — the cleanest demonstration of agentic value. Slight risk: Mode A scoring assumes `benchmark.py` accepts a pre-edited tree (needs a verify pass; fallback is running `TEST_COMMANDS` directly).

4. **GAIA** (`multi-day`) — Strong, recognizable board, but the tool surface (web_search / web_browse / multi-modal file_read / python_exec) is net-new and is the bulk of the work; loop reuse is trivial by comparison. Also gated (HF license + token) and the test split is only scorable via HF-Space submission. Headline from the 165-Q validation split.

5. **tau-bench** (`multi-day`) — Different integration surface: not a patch/predictions flow; our ReAct/Docker solver does *not* drop in. We contribute the model endpoint into tau-bench's own Python loop. Lower-code if we just route litellm at OpenRouter, but requires confirming native tool-calling on DeepSeek/GLM/Kimi slugs and computing $/task from tokens (litellm `response_cost` is null on OpenRouter). Pair with tau2 for a leaderboard-comparable number.

6. **Terminal-Bench** (`multi-day`) — **Do last.** Highest unknown: tmux `capture_pane` screen-scraping with sentinel-echo framing is the biggest un-validated risk, the ReAct loop must be re-ported to Python, and cheap models score low on a hard 100-task set (weak Pareto point for the cost). Not yet validated end-to-end against Docker.

## 2) Runner reuse vs. new runner

**Can share `gcp-swebench-runner.sh` (Docker-on-x86, `swebench` venv, OpenRouter key via metadata):**
- **SWE-bench Multilingual** — *same* harness, same e2-standard-8 + Docker pattern. Only delta: bump boot disk to **400 GB pd-standard** (9 langs × `cache_level=instance` can exceed 200 GB) and keep x86_64 (ARM can't pull prebuilt images). Effectively a parameterization, not a new runner.
- **Aider Polyglot** — same VM class (e2-standard-8, Docker), 100 GB disk. Needs the multi-language toolchain image (`docker_build.sh`) instead of swebench images, so it's a *variant* of the runner (swap the image-prep step), not a brand-new one.

**Need a new/forked runner script:**
- **LiveCodeBench** — no Docker; `uv`-based Python 3.11 env + `lcb_runner`, smaller VM (e2-standard-4, 50 GB). New `gcp-lcb-runner.sh` (small).
- **GAIA** — no per-instance Docker (only the python_exec sandbox), but adds **web egress + HF_TOKEN** secret and multi-modal deps. New `gcp-gaia-runner.sh`; e2-standard-4.
- **tau-bench** — **no Docker at all** (API-bound), e2-standard-4/30 GB; pure Python venv + litellm-at-OpenRouter env wiring. New tiny runner.
- **Terminal-Bench** — Docker, but `uv tool install terminal-bench` + the `tb` CLI and a Python agent, not the swebench venv/predictions flow. New `gcp-tbench-runner.sh`.

Net: 2 boards ride the existing runner (with parameter tweaks), 4 need their own — but the GAIA/tau/lcb runners are all the "small e2-standard-4 + venv + metadata key" shape and can share one template.

## 3) Total rough cost for first numbers (all 6 boards)

Per-board, single cheap model (DeepSeek-class), one pass:

| Board | Model/API | GCP VM | Notes |
|---|---|---|---|
| LiveCodeBench | ~$0.70 | ~$1–2 (few hrs, e2-std-4) | cheapest |
| SWE-bench MM | ~$6–15 | **~$10–25** (hours of multi-lang Docker pulls/builds, 400 GB) | VM-dominated |
| Aider Polyglot | ~$0.50–5 | ~$1–2 | heavy first `docker_build` |
| GAIA | ~$2–8 (capped `--max-cost 5`) | ~$1–3 | + web egress, negligible |
| tau-bench | ~$7–20 (165×4 trials, incl. user-sim) | ~$1–2 (e2-std-4, no Docker) | API-dominated |
| Terminal-Bench | ~$1–5 (token est, low resolve) | ~$2–4 (Docker, slow first pulls) | |

**Totals:** model/API ~**$17–53**; GCP compute ~**$16–38**. **All-in ≈ $35–90** for one cheap-model pass across all 6. SWE-bench Multilingual's VM-hours and tau-bench's API (4× trials including the paid user-simulator) are the two cost drivers. Running the 3 cheap models (DeepSeek/GLM/Kimi) on all boards roughly triples the API portion → order **$100–200 all-in**.

## 4) Single highest-value next action

**Stand up LiveCodeBench end-to-end on a single e2-standard-4 with DeepSeek, smoke-piloted at `--limit 25 --start_date 2025-02-01`.**

Concretely: finish `solve-lcb.mjs` (the OpenRouter client/concurrency/`--max-cost` is verbatim reuse; the only new code is the two LCB prompt templates — functional vs stdin/stdout — and the last-fenced-python extractor), export a v5 manifest via the `lcb_runner.benchmarks` loader, generate, then score with the **official** `custom_evaluator`. It is the cheapest run (~$1 all-in), lowest-risk reuse, validates the OpenRouter-cost-sidecar → official-scorer join pattern that every other board repeats, and produces a second comparable cost-Pareto point fastest. Validate the I/O-contract templates against 3 LeetCode + 3 AtCoder problems before the full sweep — that's the one thing that silently depresses pass@1 if wrong.

Relevant files: `/home/ruvultra/projects/agent-harness-generator/packages/darwin-mode/bench/livecodebench/solve-lcb.mjs`, reusing `/home/ruvultra/projects/agent-harness-generator/packages/darwin-mode/bench/swebench/solve-agentic.mjs` and `/home/ruvultra/projects/agent-harness-generator/packages/darwin-mode/bench/swebench/agentic-loop.mjs`.

## Per-board feasibility

| board | feasibility | effort | cost/task |
|---|---|---|---|
| SWE-bench Multilingual | needs-adapter | day | Solve-time LLM (DeepSeek-V4-Flash class, 20 steps) |
| Aider Polyglot benchmark (Exercism-based | needs-adapter | day | Cheap models (DeepSeek-V4-Flash/GLM-5.2/Kimi-K2.6) |
| Terminal-Bench (agentic terminal tasks) | needs-adapter | multi-day | Not measured yet (no run executed). Estimate only: |
| tau-bench / τ-bench (Sierra) — tool-agen | needs-adapter | multi-day | ~$0.01-0.03 per task-run with DeepSeek-V3/Chat on  |
| GAIA — General AI Assistants benchmark ( | needs-adapter | multi-day | ~$0.01-0.05/task on the cheap OpenRouter tier (Dee |
| LiveCodeBench | needs-adapter | day | ~$0.0008/problem single-shot at DeepSeek-V3 OpenRo |