# Aider Polyglot — MetaHarness/Darwin adapter plan

Status: scaffold (researched, not yet run). Owner: Darwin cost-Pareto board.

## 1. The REAL official harness (cited, not invented)

- **Harness repo**: `Aider-AI/aider` → `benchmark/benchmark.py` (the runner),
  `benchmark/docker_build.sh` + `benchmark/docker.sh` (build/enter the sandbox image),
  `benchmark/Dockerfile` (the polyglot toolchain image: python+pytest, rust+cargo,
  go, node/npm, jdk+gradle, g++/cmake). Per-language test launch is hard-coded in
  `benchmark.py`'s `TEST_COMMANDS` map:
  - `.py`  → `pytest`
  - `.rs`  → `cargo test -- --include-ignored`
  - `.go`  → `go test ./...`
  - `.js`  → `/aider/benchmark/npm-test.sh`
  - `.cpp` → `/aider/benchmark/cpp-test.sh`
  - `.java`→ `./gradlew test`
- **Dataset repo**: `Aider-AI/polyglot-benchmark` (Exercism practice exercises).
  Cloned to `tmp.benchmarks/polyglot-benchmark`. Verified locally:
  **225 exercises** = cpp 26, go 39, java 47, javascript 49, python 34, rust 30.
- **Per-exercise layout on disk** (verified by cloning):
  ```
  <lang>/exercises/practice/<slug>/
    .docs/instructions.md (+ instructions.append.md, hints.md)   # the prompt
    .meta/config.json                                            # files.{solution,test,example}
    .meta/example.<ext>                                          # reference gold solution
    .meta/tests.toml                                             # which test cases count
    <solution stub>            e.g. python: affine_cipher.py   / rust: src/lib.rs
    <test file(s)>             e.g. python: affine_cipher_test.py / rust: tests/<slug>.rs
    (lang scaffold: Cargo.toml, build files, etc.)
  ```
  `.meta/config.json` `files.solution` = the EDITABLE files handed to the model;
  `files.test` = the test files the harness runs and the model must NOT edit;
  `.meta/example.*` = the gold solution (used only to sanity-check the env, never shown).

## 2. Scoring (the metric + how cost-per-task is captured)

- The harness runs a **2-try** loop per exercise (`--tries 2`, default):
  1. Show the model the instructions + solution stub → model edits the solution file(s).
  2. Run the language's test command. If green → solved on try 1.
  3. If red → feed the **raw test failure output** back as the next instruction; model
     edits again; re-run tests. Green now → solved on try 2.
- **`pass_rate_1`** = % of exercises whose tests all pass after attempt 1.
  **`pass_rate_2`** = % passing after the (≤1) retry. `pass_rate_2` is the headline
  Aider leaderboard number. (`benchmark.py` computes
  `100 * passed_tests[i] / completed_tests` per try index.)
- Per-exercise `.aider.results.json` records: `tests_outcomes` (bool per try),
  `cost`, `duration`, `test_timeouts`, `num_error_outputs`,
  `num_malformed_responses`, `prompt_tokens`, `completion_tokens`,
  `edit_format`, plus syntax/indentation/lazy-comment counters.
- **Cost-per-task** comes from the aggregate report's `total_cost` (litellm token×price)
  and `seconds_per_case`. The Aider leaderboard plots pass_rate_2 vs total_cost — exactly
  the Darwin cost-Pareto axis. For OpenRouter cheap models, litellm cost is the proxy;
  we ALSO capture the authoritative spend from OpenRouter `usage.cost` (already wired in
  our solver, see §3) because litellm's price table lags on DeepSeek/GLM/Kimi.

## 3. Adapter design — wiring our solver to this board

Our SWE-bench solver `bench/swebench/agentic-loop.mjs` is fully dependency-injected
(`agenticSolve({ problem, io, llm, maxSteps })`). The `io` surface is
`ls/read/grep/edit/run_tests/submit` over a working tree. **Nothing in the loop is
SWE-bench-specific** — only the `io` wiring in `solve-agentic.mjs` is. So the adapter is
a new `io` provider, not a new solver.

Two integration modes (pick by goal):

### Mode A — our solver edits, OFFICIAL harness scores (recommended; leaderboard-conformant)
1. For each exercise, our adapter (`solve-polyglot.mjs`, stub here) builds an `io` whose
   `work` = the exercise dir, `problem` = `.docs/instructions.md (+ append)`,
   editable files = `config.json.files.solution`, `isTestPath` = anything in
   `files.test`, and `run_tests` = run that language's test command **locally in the
   official Docker image** (or skip in-loop tests for a conformant 1-shot, mirroring our
   `--no-test-oracle` flag).
2. The adapter writes the model's final edits into the exercise dir, then hands the
   **populated `tmp.benchmarks/polyglot-benchmark` tree** to the official
   `benchmark.py` with `--tries 1` (we already did the editing) to get the
   authoritative `pass_rate` + `total_cost` YAML. Alternatively run `benchmark.py` end
   to end and point its model call at our ReAct endpoint — but that needs an
   OpenAI-compatible shim, so Mode B is cleaner for the agentic loop.

### Mode B — official harness drives, our model as the editor (simplest, single-shot)
Aider IS the agent here. Run `benchmark.py --model openrouter/deepseek/deepseek-chat
--edit-format whole` (or `diff`) directly. OpenRouter is litellm-native
(`openrouter/<model>` prefix), so DeepSeek-V4-Flash / GLM-5.2 / Kimi-K2.6 work with
zero code. This measures the model on the board but NOT our ReAct harness — use it as
the baseline row; use Mode A to show the Darwin agentic lift.

For the Darwin board we want **both**: Mode B = "model alone", Mode A = "model + our
harness", same cost axis.

### Cost capture
- Primary: official report `total_cost` (comparable to leaderboard).
- Authoritative: our `llm()` already reads OpenRouter `usage.cost`; sum it per exercise
  and emit a sidecar `cost-per-task.jsonl` ({slug, lang, usd, tokens, tries, passed}).
  Cost-per-task = total_usd / 225 (or / n_solved for cost-per-solve).

## 4. Exact GCP run command

One e2-standard-8 GCE VM (8 vCPU / 32 GB; polyglot toolchains + Docker fit; pd-standard
100 GB). OpenRouter key via instance metadata (matches our convention).

```bash
# --- provision (from a workstation with gcloud) ---
gcloud compute instances create darwin-polyglot \
  --project="$GCP_PROJECT" --zone=us-central1-a \
  --machine-type=e2-standard-8 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=100GB --boot-disk-type=pd-standard \
  --metadata=openrouter-key="$OPENROUTER_API_KEY"

# --- on the VM (ssh in) ---
sudo apt-get update && sudo apt-get install -y docker.io git python3-pip nodejs npm
curl -s "http://metadata.google.internal/computeMetadata/v1/instance/attributes/openrouter-key" \
  -H "Metadata-Flavor: Google" > /tmp/.orkey

# clone harness + dataset (official)
git clone https://github.com/Aider-AI/aider /opt/aider
git clone https://github.com/Aider-AI/polyglot-benchmark /opt/aider/tmp.benchmarks/polyglot-benchmark
( cd /opt/aider && ./benchmark/docker_build.sh )

# clone our repo for the adapter
git clone <this-repo> /opt/darwin

# === Mode B (baseline: model alone, official harness drives) ===
( cd /opt/aider && OPENROUTER_API_KEY=$(cat /tmp/.orkey) ./benchmark/docker.sh \
  ./benchmark/benchmark.py darwin-deepseek-b \
    --model openrouter/deepseek/deepseek-chat \
    --edit-format whole --tries 2 --threads 8 \
    --exercises-dir polyglot-benchmark --new )

# === Mode A (Darwin lift: our ReAct harness edits, then official scorer) ===
( cd /opt/darwin/packages/darwin-mode/bench/aider-polyglot && \
  OPENROUTER_API_KEY=$(cat /tmp/.orkey) node --experimental-strip-types --no-warnings \
    solve-polyglot.mjs \
      --exercises-dir /opt/aider/tmp.benchmarks/polyglot-benchmark \
      --model deepseek/deepseek-chat --max-steps 20 --concurrency 4 \
      --out cost-per-task.jsonl )
# then score the edited tree with the official harness at --tries 1:
( cd /opt/aider && ./benchmark/docker.sh \
  ./benchmark/benchmark.py darwin-deepseek-a \
    --model openrouter/deepseek/deepseek-chat --tries 1 --threads 8 \
    --exercises-dir polyglot-benchmark )
```

## 5. Feasibility, blockers, effort

- **Feasibility: needs-adapter.** The ReAct loop reuses 1:1; only the `io` provider and
  the per-language test runner + result parsing are new. Mode B is near-zero-code.
- **Blockers / honesty:**
  - Mode A "edit then score at --tries 1" depends on `benchmark.py` accepting an
    already-edited tree without re-prompting — needs a verify pass; the clean fallback is
    to bypass `benchmark.py` and run the `TEST_COMMANDS` directly + parse exit codes
    (loses the official YAML but keeps the metric).
  - Multi-language Docker image is heavy (jdk+gradle+rust+go+node+cpp); first
    `docker_build.sh` is slow and the gradle/cargo toolchains pull a lot — budget disk +
    first-run time.
  - litellm `total_cost` lags for DeepSeek-V4-Flash/GLM-5.2/Kimi-K2.6 pricing; trust the
    OpenRouter `usage.cost` sidecar as authoritative.
  - Java/cpp test harness flakiness (gradle daemon, cmake) is a known source of false
    failures — mirror our `KNOWN_FLAKY.md` discipline.
- **Effort: ~1 day.** Half a day to flesh out `solve-polyglot.mjs` (instructions reader,
  config.json editable/test mapping, per-language `run_tests`) reusing `agenticSolve`;
  half a day to provision the VM, build the Docker image, and validate on a 5-exercise
  smoke (one per language) before the full 225.
