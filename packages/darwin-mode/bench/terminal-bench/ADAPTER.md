# Terminal-Bench adapter — Darwin cost-Pareto board

Wiring our cheap-model ReAct terminal solver into the **official Terminal-Bench**
harness, scoring with the official tests, and capturing **$/task**.

> Status: design + stub. Not yet validated end-to-end on a GCE VM.

## 1. The REAL official harness (verified against source, not invented)

- **Repo (v1, leaderboard-stable):** `laude-institute/terminal-bench`
  (https://github.com/laude-institute/terminal-bench). PyPI package
  `terminal-bench`, CLI binary `tb`.
- **Repo (v2, newer):** `harbor-framework/terminal-bench-2` run via the **Harbor**
  harness (`harbor` PyPI, `harbor run -d terminal-bench/terminal-bench-2 ...`).
  HF dataset `harborframework/terminal-bench-2.0` (89 hard tasks).
- **Paper:** "Terminal-Bench: Benchmarking Agents on Hard, Realistic Tasks in
  Command Line Interfaces", arXiv:2601.11868.

We target the **v1 harness + Terminal-Bench-Core v0.1.1** dataset because that is
the version pinned to the public leaderboard (`--dataset-name terminal-bench-core
--dataset-version 0.1.1`, ~100 tasks). The same adapter class works on v2/Harbor
with a different `-d`/registry once we want the harder set.

### How a task is structured & scored (from the source)

- Tasks are **not** checked into `tasks/` on `main` anymore — they are pulled by
  the dataset registry client (`terminal_bench/dataset/`, `registry/client.py`)
  keyed by `--dataset-name` + `--dataset-version`, cached locally.
- Each task = a Docker environment (Dockerfile / docker-compose), an English
  `instruction`, a reference `solution`, and a `tests/` script. The harness:
  1. builds/starts the task container,
  2. opens a **tmux** session inside it (`terminal_bench/terminal/tmux_session.py`),
  3. hands your agent the `instruction` + that session (`perform_task`),
  4. after the agent finishes, runs the task's tests **in the container**,
  5. parses unit-test results → `UnitTestStatus`; a task **`_is_resolved`** iff
     *all* parsed tests are `PASSED` (`harness.py:_is_resolved`).
- Output: a run dir with per-task `results.json` and a top-level
  `BenchmarkResults` / `RunMetadata` carrying **`accuracy`** (resolved fraction),
  `dataset_size`, `pass_at_k`, and per-trial **`total_input_tokens` /
  `total_output_tokens`** (`harness/models.py`).
- The metric is **pass@1 accuracy** (resolved tasks / total). `pass_at_k` is
  available with `--n-attempts k`.

### The custom-agent contract (the integration seam)

`terminal_bench/agents/base_agent.py`:

```python
class BaseAgent(ABC):
    @staticmethod
    @abstractmethod
    def name() -> str: ...
    def perform_task(self, instruction: str, session: TmuxSession,
                     logging_dir: Path | None = None) -> AgentResult: ...
```

`AgentResult` carries `total_input_tokens`, `total_output_tokens`, `failure_mode`.
The harness drives the container **externally** — your agent runs commands with
`session.send_keys([cmd, "Enter"], block=True)` and reads the screen with
`session.capture_pane()` (verified in `agents/naive_agent.py`). This is a *pure
Python* agent: nothing of ours gets installed into the task container, so no extra
container deps (the `AbstractInstalledAgent` path is explicitly "last resort").

`tb run` loads a custom agent by **import path**:
`--agent-import-path "module:ClassName"` (`agents/agent_factory.py`
`get_agent_from_import_path` splits on `:`), and forwards `--model-name` plus any
`--agent-kwarg k=v` to the agent constructor as `**kwargs`.

## 2. Our stack → the seam

Our solver (`bench/swebench/solve-agentic.mjs` + `agentic-loop.mjs`) is a Node
ReAct loop over a JSON tool protocol (read/grep/ls/edit/run_tests/submit) hitting
OpenRouter (`--model deepseek/deepseek-chat`, GLM, Kimi). Terminal-Bench's seam is
Python and the only "tool" the env exposes is **a shell**. So the adapter is a
**thin Python `BaseAgent`** that re-implements the same ReAct loop but with a
single tool — "run a bash command" — against the tmux session.

This is a *faithful port*, not a rewrite of intelligence:
- same system-prompt shape (problem statement + ReAct "think then one action"),
- same bounded step budget (`--max-steps`, our default 20),
- same model + OpenRouter base-url/key knobs,
- the model edits files and runs tests **with ordinary shell commands**
  (`cat`, `sed`, `python -c`, `pytest`, here-docs for writes) — which is actually
  closer to what Terminal-Bench rewards than our structured edit tool.

### Cost-per-task capture (the important bit)

Terminal-Bench records **tokens, not dollars**. So:
1. The adapter sums OpenRouter usage per call. OpenRouter returns
   `usage.cost` (USD) and `usage.prompt_tokens`/`completion_tokens` when the
   request sets `usage: {include: true}` — we already rely on `usage.cost` in
   `solve-agentic.mjs`.
2. We return the token totals in `AgentResult` (so the official `results.json`
   stays correct), **and** we write our own sidecar `darwin-cost.jsonl`
   (one row per task: `task_id, model, input_tokens, output_tokens, usd, steps,
   resolved`).
3. `score.py` (this dir) joins the harness `results.json` (authoritative
   resolved/accuracy) with `darwin-cost.jsonl` (authoritative $) → the
   Pareto row: **accuracy, total $, mean $/task, $/resolved-task**.

`$/task` = `sum(usd)/n_tasks`; `$/resolved` = `sum(usd)/n_resolved`. The board
plots accuracy vs `$/resolved`.

## 3. Files in this dir

- `darwin_terminal_agent.py` — the `BaseAgent` ReAct adapter (the stub).
- `requirements.txt` — `terminal-bench` (pulls the harness + deps).
- `score.py` — join harness results.json + darwin-cost.jsonl → Pareto row. (TODO)
- `run.sh` — the GCE recipe (below, also as a script). (TODO)

## 4. Exact GCP run command

VM: `e2-standard-8` (Docker-in-VM needs the cores/RAM for task containers),
`pd-standard` 100 GB, Ubuntu 24.04, OpenRouter key in instance metadata
(`openrouter-key`), Docker preinstalled. Mirrors our SWE-bench GCE pattern.

```bash
# --- create the VM (once) ---
gcloud compute instances create tbench-darwin \
  --zone=us-central1-a --machine-type=e2-standard-8 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB --boot-disk-type=pd-standard \
  --metadata-from-file=startup-script=startup.sh \
  --metadata=openrouter-key="$OPENROUTER_API_KEY"

# --- on the VM (startup.sh, or via `gcloud compute ssh`) ---
# Docker + uv + the official harness
curl -fsSL https://get.docker.com | sh
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install terminal-bench           # provides `tb`
export OPENROUTER_API_KEY="$(curl -s -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/openrouter-key)"

# sanity: the official oracle agent must score ~100% (proves env + tasks build)
tb run --agent oracle \
  --dataset-name terminal-bench-core --dataset-version 0.1.1 \
  --n-concurrent 4 --task-id hello-world

# --- our cheap-model run (the actual measurement) ---
# point tb at OUR agent by import path; forward model + budget as agent-kwargs
cd /path/to/packages/darwin-mode/bench/terminal-bench
DARWIN_MAX_STEPS=25 \
tb run \
  --agent-import-path "darwin_terminal_agent:DarwinTerminalAgent" \
  --model-name deepseek/deepseek-chat \
  --dataset-name terminal-bench-core --dataset-version 0.1.1 \
  --n-concurrent 6 \
  --output-path ./runs/ds-v4flash

# --- score + Pareto row (joins official results.json with our $ sidecar) ---
uv run python score.py ./runs/ds-v4flash
```

Swap `--model-name` for `z-ai/glm-4.6` / `moonshotai/kimi-k2` to fill more
Pareto points. `--task-id` / `--n-tasks` for a cheap pilot before the full set.

## 5. Feasibility, blockers, effort

**Feasibility: needs-adapter.** The harness is a clean, documented pip package
with a first-class custom-agent seam, so we do *not* fork it. But our solver is
Node and the seam is Python — we cannot literally call `solve-agentic.mjs`; we
re-port the ReAct loop into a ~120-line Python `BaseAgent` (the stub). The loop
logic is simple and already proven, so this is a port, not a redesign.

**Blockers / risks:**
- **Cost is not native.** Terminal-Bench measures tokens; $/task is *our* layer
  (OpenRouter `usage.cost` + sidecar). If OpenRouter omits `usage.cost` for some
  model we fall back to tokens × static price table.
- **Docker-in-VM.** Each task is its own image; `e2-standard-8` + 100 GB is the
  floor. Some tasks pull large base images → slow first run; budget disk/time.
- **Tmux text protocol.** Reading command output via `capture_pane()` is screen-
  scraping (prompt detection, truncation, ANSI). The stub uses a sentinel-echo
  trick (`; echo __DONE_<n>__`) to delimit output reliably; needs hardening on
  long-running / interactive commands (the `block=True` + timeout knobs help).
- **Cheap models on hard tasks.** Terminal-Bench-Core is hard; DeepSeek/GLM/Kimi
  may score low. That is fine — the board is cost-Pareto, low-accuracy/low-cost
  is a legitimate point — but set expectations.
- **No oracle leakage.** Unlike our SWE-bench `--no-test-oracle` work, here the
  task tests live in the container and the harness runs them only *after*
  `perform_task` returns. The agent can run the repo's own commands but must not
  read the hidden `tests/` — keep the loop from `cat`-ing the test dir.

**Effort: multi-day.** ~half a day to finish + smoke-test the agent stub against
`oracle` and one real task locally with Docker; ~1 day to harden the tmux I/O and
the cost sidecar/score join; remaining time is the GCE full-set run + per-model
sweeps. The single biggest unknown is tmux output framing reliability.
