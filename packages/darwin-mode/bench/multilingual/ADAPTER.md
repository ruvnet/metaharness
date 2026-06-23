# SWE-bench Multilingual — Cost-Pareto Adapter Plan

Status: DESIGN (not yet wired). Author: darwin-mode bench. Date: 2026-06-23.

## 1. What the board actually is (verified, not invented)

- **Dataset**: `SWE-bench/SWE-bench_Multilingual` on HuggingFace, split `test`,
  **300 instances**, **42 repos**, **9 languages**: C, C++, Go, Java, JavaScript,
  TypeScript, PHP, Ruby, Rust. (https://www.swebench.com/multilingual.html)
- **Fields** (per HF dataset card): `instance_id`, `repo`, `base_commit`,
  `patch`, `test_patch`, `problem_statement`, `hints_text`, `created_at`,
  `version`, `FAIL_TO_PASS`, `PASS_TO_PASS`. **There is NO `language` field** —
  language is implied by `repo` and the harness's per-repo test spec. We can map
  language from `repo` for routing/reporting if we want, but the harness does not
  need us to.
- **Official harness**: the SAME `swebench` pip package we already use —
  `python -m swebench.harness.run_evaluation`. Multilingual support is *integrated
  into the main SWE-bench repo* (`swe-bench/SWE-bench`); there is **no separate
  harness**. Per-language test specs live in
  `swebench/harness/test_spec/{javascript,golang,...}.py` and are selected by
  `repo`+`version` automatically. (https://www.swebench.com/SWE-bench/guides/evaluation/)
- **Docker**: same three-layer (base/env/instance) prebuilt-image model. Default
  `--namespace swebench`; images are `swebench/sweb.eval.x86_64.<instance_id>:latest`
  where `__` in the instance_id maps to `_1776_`
  (e.g. `swebench/sweb.eval.x86_64.django_1776_django-12325`). For x86_64 GCE
  these pull from DockerHub; on ARM add `--namespace ''` to build locally.
  (https://hub.docker.com/r/swebench/sweb.eval.x86_64.django_1776_django-12325)

### CLI we already match (run_evaluation argparse, verified)
`-d/--dataset_name` (default `SWE-bench/SWE-bench_Lite`), `-s/--split` (default
`test`), `-p/--predictions_path`, `-id/--run_id` (required), `--max_workers`
(default 4), `-i/--instance_ids`, `-n/--namespace` (default `swebench`),
`--instance_image_tag` (default `latest`), `--cache_level`
(none|base|env|instance, default `env`), `-t/--timeout` (default 1800),
`--report_dir`, `--modal`. Prediction JSONL row = `{instance_id,
model_name_or_path, model_patch}` — exactly what `solve-agentic.mjs` already emits.

## 2. Feasibility verdict: NEEDS-ADAPTER (small)

**Final scoring is a drop-in.** Our `evalOne()` in `solve-agentic.mjs` already
shells out to `python -m swebench.harness.run_evaluation`. The only scoring
change is `--dataset_name SWE-bench/SWE-bench_Multilingual --split test`. Nothing
else about gold eval changes — the prebuilt instance image bakes in the correct
per-language toolchain (node/go/cargo/mvn/php/ruby) and test command.

**The real work is the in-loop (`--no-test-oracle`) conformant test gate**, which
is currently Python-only and breaks on the other 8 languages:

1. `conformant-tests.mjs` hardcodes `source /opt/miniconda3/bin/activate testbed`
   and judges by exit code of an arbitrary `testCmd`. Non-Python multilingual
   images have **no conda env** — the JS spec runs `./node_modules/.bin/jest`,
   Go runs `go test`, Rust `cargo test`, etc., directly in `/testbed`. The
   `source .../activate testbed &&` prefix will fail on those images.
2. `solve-agentic.mjs::existingTestTargets()` only matches `\.py$` files and
   builds `tests/test_<mod>.py` paths — meaningless for `.go`/`.rs`/`.ts`.
3. `isTestPath` and `grepRepo` default glob `*.py` — Python-centric but harmless
   (the agent can override globs), still worth widening for retrieval quality.

None of this blocks gold scoring; it only blocks an *honest in-loop signal* for
non-Python tasks. With `--no-test-oracle` OFF (oracle-in-loop A/B mode) even the
in-loop path uses `run_evaluation` and is already language-agnostic — but that
mode is non-leaderboard-conformant by design, so we keep it for ablation only.

## 3. Adapter design

### 3.1 Manifest builder (`build-manifest.mjs`, ~40 LOC)
Download the HF dataset and emit `multilingual-300.json` in our manifest shape
(`{instances:[{instance_id, repo, base_commit, problem_statement, version,
FAIL_TO_PASS, PASS_TO_PASS}]}`), identical to `full-300.json`. Add a derived
`language` field by mapping `repo` → language (static table over the 42 repos)
purely for reporting/routing; the solver and harness ignore it.

Fetch via the HF `datasets-server` rows API (no Python dep, matches our
node-only stack):
`https://datasets-server.huggingface.co/rows?dataset=SWE-bench/SWE-bench_Multilingual&config=default&split=test&offset=0&length=100`
(paginate 3×100). Falls back to `datasets.load_dataset` inside the venv if the
rows API is rate-limited.

### 3.2 Language-agnostic conformant gate (`conformant-tests-poly.mjs`, ~30 LOC delta)
Generalize `runConformantTests` so the in-Docker script is language-aware:
- Detect env: if `/opt/miniconda3/bin/activate` exists → Python path (current
  behavior, `source ... activate testbed`); else skip the conda source and run
  `testCmd` directly in `/testbed`.
- Keep the existing base64-stage + `git apply` + `set -o pipefail` exit-code
  judgement (already language-neutral — it judges the *exit code* of whatever
  `testCmd` is, which is correct for jest/go test/cargo test/phpunit/rspec).
- Replace the conda line with a probe:
  `if [ -f /opt/miniconda3/bin/activate ]; then source /opt/miniconda3/bin/activate testbed; fi`.

### 3.3 Language-aware test-target inference (`solve-agentic.mjs` delta)
Generalize `existingTestTargets(diff)` to dispatch on file extension of changed
files, producing both a `testCmd` and (where relevant) target paths:

| ext | in-loop testCmd (run in /testbed) |
|---|---|
| `.py` | `python -m pytest -q -x <test_<mod>.py>` (current) |
| `.js/.ts/.jsx/.tsx` | `./node_modules/.bin/jest --silent <pattern>` then fallback `npm test` |
| `.go` | `go test ./<pkg>/...` |
| `.rs` | `cargo test --no-fail-fast -q` |
| `.java` | `mvn -q -pl <module> test` or `./gradlew test` (detect by build file) |
| `.php` | `./vendor/bin/phpunit <path>` |
| `.rb` | `bundle exec rspec <path>` or `ruby -Itest <file>` |
| `.c/.cpp` | repo build+test (`make check` / `ctest`) — most brittle, see blockers |

Cleanest implementation: a `LANG_TEST` table keyed by extension, returning a
`(cmd, targetsFromDiff)` builder. Unknown/empty → return "write a fix first".
The agent can always override via its own `run_tests` with an explicit command
(the ReAct loop already lets it choose), so this table is a *default*, not a cage.

### 3.4 Final scorer (`score.mjs` or reuse `evalOne`)
Single change vs Python flow:
```
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Multilingual --split test \
  --predictions_path predictions-mm-300.jsonl \
  --run_id mm-<tag> --max_workers <N> --cache_level instance \
  --namespace swebench --timeout 1800
```
Report JSON is `darwin-agentic.mm-<tag>.json` with `resolved_ids` — same parser
we already have. Per-language resolve-rate breakdown comes from joining
`resolved_ids` against the derived `language` map from §3.1.

### 3.5 Cost-per-task capture (unchanged mechanism)
We already sum `j.usage.cost` from each OpenRouter response into `totalCost` and
write `totalCost_usd` to the report. For the Pareto board we emit per-instance
cost too: add `row.cost = res.cost` in `runInstance` (currently only the running
total is kept). Cost-per-task = `totalCost_usd / n`; cost-per-RESOLVED =
`totalCost_usd / resolved`. Both go in the report alongside `resolvedInLoop` and
the final harness `resolved`. This is the same accounting the SWE-bench English
ladder uses, so the Multilingual numbers drop onto the existing cost-Pareto axes
directly.

## 4. Exact GCP run command (e2-standard GCE VM)

Provision a Docker-capable x86_64 VM (Multilingual instance images are large;
budget ~200-400 GB pd-standard for the full 300 with `cache_level instance`).
OpenRouter key arrives via instance metadata (matches our existing recipe).

```bash
# --- one-time VM create (run from workstation) ---
gcloud compute instances create swebench-mm-1 \
  --project="$GCP_PROJECT" --zone=us-central1-a \
  --machine-type=e2-standard-8 \
  --boot-disk-size=400GB --boot-disk-type=pd-standard \
  --image-family=ubuntu-2204-lts --image-project=ubuntu-os-cloud \
  --metadata=openrouter-key="$(cat /tmp/.orkey)"

# --- on the VM (gcloud compute ssh swebench-mm-1) ---
# 1. deps
sudo apt-get update && sudo apt-get install -y docker.io git python3-venv nodejs npm
sudo usermod -aG docker "$USER"   # re-login for group to take effect
python3 -m venv /tmp/swebench-venv
. /tmp/swebench-venv/bin/activate && pip install -U swebench
# Node 20+ for --experimental-strip-types
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs

# 2. fetch key from metadata
export OPENROUTER_API_KEY="$(curl -s -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/openrouter-key)"

# 3. clone our repo + build the manifest
git clone <repo-url> ah && cd ah/packages/darwin-mode/bench
node --experimental-strip-types multilingual/build-manifest.mjs \
  --out multilingual/multilingual-300.json

# 4. SOLVE (leaderboard-conformant: in-loop signal = repo's own tests, never gold)
OPENROUTER_API_KEY="$OPENROUTER_API_KEY" node --experimental-strip-types --no-warnings \
  swebench/solve-agentic.mjs \
  --manifest multilingual/multilingual-300.json \
  --model deepseek/deepseek-chat \
  --no-test-oracle --max-steps 20 --concurrency 4 \
  --max-cost 40 \
  --out multilingual/predictions-mm-ds.jsonl \
  --report multilingual/solve-mm-ds-report.json

# 5. SCORE with the official harness (gold, language-agnostic via prebuilt images)
. /tmp/swebench-venv/bin/activate && python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Multilingual --split test \
  --predictions_path multilingual/predictions-mm-ds.jsonl \
  --run_id mm-ds --max_workers 4 --cache_level instance \
  --namespace swebench --timeout 1800

# 6. report lands at ./darwin-agentic.mm-ds.json (resolved_ids[])
```

Cheap-model variants: swap `--model` for `z-ai/glm-4.6` (GLM-5.2 routing tag) or
`moonshotai/kimi-k2` (Kimi-K2.6) — the OpenRouter slugs our other tracks use.

## 5. Cost-per-task estimate (honest, order-of-magnitude)

From our English SWE-bench agentic ladder: DeepSeek-class models at 20 max-steps
ran ~$0.01–0.03 per instance (problem statements + repo context dominate input
tokens). Multilingual problem statements/diffs are similar in size, BUT:
- multilingual repos (JS/Java) often have **larger context** (more files to grep),
  pushing toward the high end / above — call it **$0.02–0.05/instance** for
  DeepSeek-V4-Flash-class, i.e. **~$6–15 for the full 300** at solve time.
- GLM-5.2 / Kimi-K2.6 are in the same cheap band; Kimi's larger context window
  may raise per-task input cost slightly.

**Inference cost ≈ $6–15/run; this is a solve-time-LLM estimate only** — the
Docker eval (gold scoring) is $0 LLM but is the real wall-clock/$ cost on GCE:
image pulls + builds for 9 languages over 42 repos is tens of GB and hours of
CPU. Budget the VM-hours, not the API, as the dominant cost.

## 6. Blockers / risks (honest)

1. **C/C++ in-loop gate is brittle.** No standard single test command; depends on
   the repo's `make`/`cmake`/`ctest`. The §3.3 table will often fall back to "no
   default" for C/C++, so those instances get a weaker in-loop signal (agent flies
   blind, relies on reasoning). Gold scoring is unaffected — only the in-loop
   feedback degrades. ~? of 300 are C/C++ (small slice).
2. **Image size / disk.** Full-300 with `cache_level instance` can exceed a
   200 GB disk across 9 languages. 400 GB pd-standard recommended; or run in
   language batches with `--instance_ids` and `cache_level env` + `--clean`.
3. **First-run pull latency.** Many large prebuilt images pull from DockerHub on
   first eval; expect a slow first scoring pass and possible DockerHub rate-limits
   (consider `docker login`).
4. **No `language` field in the dataset** — we derive it from `repo`. If a repo
   appears that's not in our static map, the per-language report bucket is
   "unknown" (cosmetic only; scoring unaffected).
5. **ARM mismatch.** If the GCE VM were ARM (t2a), prebuilt x86_64 images won't
   pull and you'd need `--namespace ''` to build locally (much slower). Stick to
   x86_64 `e2-standard`.
6. **jest/npm flakiness.** JS in-loop runs can be flaky (watch mode, port use);
   the §3.2 exit-code judgement handles failures but flaky greens are possible —
   the gold harness is the source of truth, so this only adds in-loop noise.

## 7. Effort

- §3.1 manifest builder: ~1 hr (mirror of existing select-sample.mjs + HF rows API).
- §3.2 conda probe + §3.3 lang-test table: ~2–3 hrs (mechanical, table-driven).
- §3.4 scorer: ~15 min (one flag change to evalOne / a thin score.mjs).
- §3.5 per-instance cost field: ~15 min.
- Validation pilot (10–25 mixed-language instances end-to-end on GCE): ~half a day
  incl. image pulls.

**Total: ~1 day** to a validated conformant Multilingual track. The harness reuse
is genuine — gold scoring is a one-flag change; the only real code is making the
in-loop signal speak more than Python.
