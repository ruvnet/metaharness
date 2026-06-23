# tau-bench / τ-bench adapter — MetaHarness/Darwin cost-Pareto board

Status: SCAFFOLD / design. Not yet wired. Feasibility: **needs-adapter** (different
shape from our SWE-bench harness — the agent IS the model, not our external ReAct
solver). Effort: **multi-day**.

---

## 1. What the official harness actually is (cited, not invented)

- **Repo (classic):** https://github.com/sierra-research/tau-bench — "Code and Data for Tau-Bench".
- **Repo (current/recommended):** https://github.com/sierra-research/tau2-bench — "τ²-Bench:
  A Benchmark for Tool-Agent-User Interaction in Real-World Domains". The maintainers
  recommend τ²-bench for new evaluation; the public leaderboard runs on it.
- **Paper:** https://arxiv.org/pdf/2406.12045 (τ-bench, Sierra 2024).

### Domains & task counts (verified)
| Domain  | Tasks | Notes |
|---------|-------|-------|
| retail  | 115   | 500 users, 50 product types, 1000 orders |
| airline | 50    | 500 users, 300 flights, 2000 reservations |
| telecom | (tau2 only) | tau2-bench adds telecom + banking_knowledge |

### Architecture (the load-bearing fact for our adapter)
tau-bench is a **multi-turn tool-agent-user simulation**, NOT a code-edit/test benchmark
like SWE-bench. Each task = a `Env` (retail/airline) with a fixed tool API + DB, a
**simulated user** (an LLM driven by `--user-model`), and a ground-truth target DB state.

The agent loop is **internal to tau-bench**. From `tau_bench/agents/tool_calling_agent.py`:

```python
res = completion(messages=messages, model=self.model,
                 custom_llm_provider=self.provider,
                 tools=self.tools_info, temperature=self.temperature)
action = message_to_action(res.choices[0].message...)
env_response = env.step(action)   # tool executes against the env DB
```

It calls **`litellm.completion`** directly with the model's **native tool-calling**.
`env.step()` runs the tool against the in-memory DB. The user simulator
(`tau_bench/envs/user.py`) is also `litellm.completion`. There is no Docker, no repo,
no patch — the "world" is the env's Python DB object.

### Reward / metric (verified from `tau_bench/envs/base.py` + `run.py`)
- Per task, reward ∈ {0.0, 1.0}. `calculate_reward()`:
  1. **DB-state check**: SHA-256 hash of the env DB after the run vs the ground-truth
     hash. `r_actions = (data_hash == gt_data_hash)`. Mismatch → reward 0.
  2. **Output check**: required info strings the task says the agent must convey are
     checked against the agent's responses. Missing → reward 0.
- **pass^k** (the headline metric), exactly as in `run.py::display_metrics`:
  ```python
  # c = number of the num_trials trials that passed this task
  pass_hat_k[k] = mean_over_tasks( comb(c, k) / comb(num_trials, k) )
  ```
  i.e. the probability that a random size-k subset of the trials is all-pass, averaged
  over tasks. Leaderboard wants **num_trials ≥ 4** so pass^1..pass^4 are reportable.
  tau2 submission via `tau2 submit prepare` (finds `results.json`, computes pass^k,
  emits `submission.json` + `trajectories/`).

### CLI surface (verified from `run.py`)
classic tau-bench:
```
python run.py --agent-strategy tool-calling --env retail \
  --model <agent-model> --model-provider <prov> \
  --user-model <user-model> --user-model-provider <prov> \
  --user-strategy llm --max-concurrency 10 --num-trials 4 \
  --task-split test --log-dir results
```
tau2-bench:
```
tau2 run --domain retail --agent-llm <agent> --user-llm <user> \
  --num-trials 4 --num-tasks <n> --save-to <name>
```

### Cost capture (verified)
The agent loop sums `res._hidden_params["response_cost"]` and stores it in the
`SolveResult` (`total_cost`, surfaced into `EnvRunResult.info`). litellm computes
`response_cost` from its per-model price table. **Caveat:** for OpenRouter-routed
models litellm's `response_cost` is frequently `None` (no price entry under the
`openrouter/deepseek/...` key) → cost shows 0. We must derive $/task from token
usage instead (see §3, cost capture).

---

## 2. Why our existing harness does NOT drop in

Our `solve-agentic.mjs` is a Node ReAct loop that clones a repo, edits files, runs
pytest in Docker, and emits a `model_patch` scored by the SWE-bench gold harness.
**None of those primitives exist in tau-bench**: no repo, no patch, no Docker, no
file edits. The "agent" here is a single chat model doing native tool-calls inside
tau-bench's own Python loop, and the user is another LLM. So we cannot feed tasks to
`solve-agentic.mjs` and score with the tau-bench scorer — the integration point is
the **model endpoint**, not a predictions file.

The clean integration is therefore: **run the official Python harness, point its
`litellm.completion` at OpenRouter (our cheap models) for BOTH the agent and the
user simulator.** Our "solver" contribution is the model choice + (optionally) a
custom `--agent-strategy`, not the loop.

---

## 3. Adapter design

### A. Model routing → OpenRouter (the real work)
tau-bench passes `custom_llm_provider=<provider>` to litellm. Two viable paths:

1. **`--model-provider openai` + OpenAI-compatible base_url (preferred).**
   litellm honours `OPENAI_BASE_URL`/`OPENAI_API_KEY` for the `openai` provider.
   Set:
   ```
   export OPENAI_API_KEY=$OPENROUTER_API_KEY
   export OPENAI_BASE_URL=https://openrouter.ai/api/v1
   ```
   and run with `--model deepseek/deepseek-chat --model-provider openai`
   (`--user-model ... --user-model-provider openai`). OpenRouter is OpenAI-compatible
   so tool-calls pass through. **Hard requirement:** the chosen model must support
   native tool-calling on OpenRouter (DeepSeek-V3/Chat, GLM, Kimi-K2 do; verify the
   exact OpenRouter slug supports `tools`).
2. **litellm openrouter provider:** `--model openrouter/deepseek/deepseek-chat
   --model-provider openrouter` with `OPENROUTER_API_KEY` set. Cleaner slug but
   `response_cost` is more often null.

A tiny adapter shim (`provider_shim.py`, stub below) sets the env and validates the
slug supports tools before launching, so a bad model fails fast instead of mid-run.

### B. Cost capture ($/task) — the board's Pareto axis
Because litellm `response_cost` is unreliable on OpenRouter, the adapter post-processes
`results.json`:
- Re-walk each `traj` (the saved message list per task) and sum tokens, **or**
- preferred: enable OpenRouter usage accounting (`usage: {include: true}` in the
  request body) and read `response.usage.cost` (OpenRouter returns real $), then
  patch litellm to surface it, **or** simplest: sum `prompt_tokens`/`completion_tokens`
  from each completion and multiply by the OpenRouter price for that slug (pulled once
  from `https://openrouter.ai/api/v1/models`).
- `cost_per_task = total_cost_over_all_trials / (num_tasks * num_trials)`.
The adapter writes a `pareto.json` row: `{board, domain, model, pass^1, pass^4,
avg_reward, total_cost_usd, cost_per_task_usd, num_tasks, num_trials}` in the same
shape the Darwin cost-Pareto leaderboard ingests (mirror `swebench/*-report.json`).

### C. Scoring
Use the **official scorer unchanged** — `display_metrics` already prints pass^k and
writes the per-task `results.json`. The adapter only reads that file; it never
re-implements reward. (For tau2: `tau2 submit prepare` does it.) This keeps us
gold-conformant: no test-oracle-leakage concern here (there are no hidden tests —
the env DB hash is the oracle and is applied only at scoring inside `env.step`).

### D. Files this adapter will add
- `provider_shim.py`  — env setup + tool-support preflight (STUB written, see below).
- `run_tau.sh`        — GCP-ready launcher wrapping the official `run.py`.
- `score_cost.py`     — post-process `results/*.json` → `pareto.json` with $/task.
- (no change to `solve-agentic.mjs` — it is not used for this board.)

---

## 4. Exact GCP run command (GCE VM, e2-standard, pd-standard, key via metadata)

```bash
# --- on the VM (Ubuntu 22.04, e2-standard-4 is plenty: this is API-bound, no Docker) ---
sudo apt-get update -y && sudo apt-get install -y python3.11 python3.11-venv git
git clone https://github.com/sierra-research/tau-bench.git
cd tau-bench
python3.11 -m venv .venv && . .venv/bin/activate
pip install -e .

# OpenRouter key from GCE metadata (set at instance create via --metadata or secret)
export OPENROUTER_API_KEY="$(curl -s -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/attributes/openrouter-key')"
export OPENAI_API_KEY="$OPENROUTER_API_KEY"
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"

# Retail, 4 trials (leaderboard-conformant), DeepSeek as BOTH agent and user sim.
python run.py \
  --agent-strategy tool-calling \
  --env retail \
  --model deepseek/deepseek-chat --model-provider openai \
  --user-model deepseek/deepseek-chat --user-model-provider openai \
  --user-strategy llm \
  --num-trials 4 --task-split test \
  --max-concurrency 8 \
  --log-dir results

# Airline (50 tasks)
python run.py --agent-strategy tool-calling --env airline \
  --model deepseek/deepseek-chat --model-provider openai \
  --user-model deepseek/deepseek-chat --user-model-provider openai \
  --user-strategy llm --num-trials 4 --task-split test \
  --max-concurrency 8 --log-dir results

# pass^k prints to stdout; per-task results land in results/*.json
# then derive $/task for the Pareto board:
python /path/to/score_cost.py results/ --model deepseek/deepseek-chat --out pareto.json
```

GCE create (key as metadata attribute):
```bash
gcloud compute instances create tau-bench-1 \
  --machine-type e2-standard-4 --boot-disk-type pd-standard --boot-disk-size 30GB \
  --image-family ubuntu-2204-lts --image-project ubuntu-os-cloud \
  --metadata openrouter-key="$OPENROUTER_API_KEY"
```

---

## 5. Cost-per-task estimate

retail (115) + airline (50) = 165 tasks. At num_trials=4 → 660 task-runs. Each task is
a multi-turn dialogue: ~15-30 agent turns + matching user-sim turns, ~8-20k tokens
agent + ~5-10k user per task. With DeepSeek-V3 on OpenRouter (~$0.27/M in, ~$1.10/M out
ballpark — **verify live prices**), agent+user ≈ $0.01-0.03 per task-run. Full
4-trial sweep of both domains ≈ **$7-$20** total, i.e. **~$0.01-0.03 / task**.
GLM/Kimi similar order. Verify against the live OpenRouter price table at run time;
do a `--num-tasks 5 --num-trials 1` smoke first to read actual token counts.

---

## 6. Blockers & honesty

1. **Our ReAct solver is not the integration point.** The agent is a single
   native-tool-calling model inside tau-bench's loop. We contribute model choice +
   strategy, not our Node loop. A custom strategy (e.g. our ReAct prompt) would mean
   subclassing `tau_bench.agents.base.Agent` in Python — a real port, not a wrapping.
2. **Native tool-calling required.** The cheap model's OpenRouter slug must support
   the `tools` field. Confirm DeepSeek-V4-Flash / GLM-5.2 / Kimi-K2.6 expose tool-calling
   on OpenRouter; a model that only does text will hard-fail `message_to_action`.
3. **litellm `response_cost` unreliable on OpenRouter** → we must compute $/task from
   token usage (see §3.B). Without this the Pareto axis is wrong (shows $0).
4. **User-simulator cost is real and counts.** Both the agent AND user are LLM calls;
   $/task must include user-sim tokens. Easy to undercount.
5. **Python, not Rust/Node.** tau-bench is Python; per project rule we don't rewrite it
   in Rust — we run the official harness as-is and only add thin Python shims. The
   board entry is the result, the harness stays upstream.
6. **tau2 vs tau1 decision.** The live leaderboard is **tau2-bench** (`tau2 run`,
   adds telecom/banking, `uv sync`). If we want a leaderboard-comparable number we
   should target tau2; tau1 is simpler to stand up first. This stub documents both;
   recommend a tau1 smoke run to validate routing, then move to tau2 for the headline.
7. **Determinism / flakiness.** User-sim is an LLM → runs are noisy; that's *why*
   pass^k over ≥4 trials exists. Budget for the variance, don't read a single trial.

---

## 7. Effort

- Routing shim + smoke run (5 tasks, 1 trial): **~half a day**.
- Cost-capture post-processor + Pareto row: **~half a day**.
- Full 4-trial retail+airline sweep + tau2 port for leaderboard parity: **multi-day**
  (mostly wall-clock for the runs + verifying tool-calling on each cheap model).
