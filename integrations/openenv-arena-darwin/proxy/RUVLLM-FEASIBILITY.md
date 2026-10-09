# Local proxy feasibility: ruvllm and ollama on ruvultra (2026-10-08)

**Do not use a local proxy for Darwin fitness screening or difficulty ranking.**
`ruvllm` cannot serve any Qwen model on this machine. Ollama does serve Qwen 2.5
locally. However, both local Qwen 2.5 models scored **0/4 on the easiest cell**,
and Qwen3.8-27B scored **4/4** on those same seeded instances. Their failures were
schema and reasoning errors, never truncation. Truncation is the 27B's dominant
failure mode, so these proxies cannot measure the property the fitness function is
built on.

A local endpoint is still useful for plumbing tests (endpoint wiring, the JSONL
schema, the cache and accounting code paths) at about 1 s per episode.

## 1. ruvllm 2.1.0 (`~/.local/bin/ruvllm`) does not work for this

Each of these findings blocks it on its own. Logs are in the scratchpad under `proxy/ruvllm-*.log`.

| # | Finding | Evidence |
|---|---|---|
| 1 | **The build is CPU-only.** It has no CUDA or Metal backend. | `ldd` shows no libcuda. The binary embeds candle 0.8.4 `dummy_cuda_backend.rs` and `dummy_metal_backend.rs`. At runtime on Linux it logs `Metal requested but not available, falling back to CPU`. |
| 2 | **Qwen safetensors are unsupported.** | `serve Qwen/Qwen2.5-3B-Instruct` logs `Model loading failed: Configuration error: Architecture Qwen not yet supported for safetensors loading. Running in mock mode.` |
| 3 | **Qwen GGUF files are unreadable.** | The GGUF loader only reads `llama.*`, `mistral.*` and `phi.*` metadata keys. Test: the ollama `qwen2.5:0.5b-instruct` blob, which has valid `GGUF` magic, was symlinked into a scratch cache. It logs `Model config: hidden=4096, layers=32, heads=32, kv_heads=32, vocab=32000`, which are llama-7B defaults, and then `Failed to load GGUF weights: cannot find llama.attention.head_count in metadata. Running in mock mode.` The tokenizer special tokens are also wrong for Qwen (`bos=128245`). |
| 4 | **The known download bug is confirmed.** | `ruvllm download Qwen/Qwen2.5-0.5B-Instruct-GGUF` fetches `tokenizer.json` first. That file does not exist in GGUF repos, so it gets a 15-byte "entry not found" body and stops with `Error: Failed to download tokenizer.json` (exit 1). `ruvllm list` also reports `phi` as "Downloaded" when only a 15.5 MB tokenizer is cached and `info phi` says `Weights: Not found`. |

### Integration hazard: mock mode returns HTTP 200

After a failed load, `ruvllm serve` still binds the port:

- `/v1/models` lists the model.
- `/v1/chat/completions` returns `finish_reason: "stop"`, a plausible `usage` block,
  and the canned text `"I understand your request. To provide real responses, please
  ensure the model is properly loaded. Currently running in mock mode for development."`

Of the HTTP endpoints, only `/health` shows the problem (`"status":"degraded"`). The
server's own stdout also prints the mock-mode warning.

A screening loop pointed at this server would record every episode as a ValidationError
and score the canned text as model failures. If anyone wires ruvllm in later, they
must check `/health` == ok and fail closed.

## 2. Ollama 0.30.11 at `localhost:11434/v1` serves Qwen 2.5, but neither model tracks the 27B

Setup:

- The server runs with `OLLAMA_CONTEXT_LENGTH=16384`.
- Both models loaded 100% on the GPU: `qwen2.5:1.5b-instruct` used 1537 MiB and `qwen2.5-coder:7b` used 5212 MiB.
- Cold load plus the first call took 2.4 s and 6.2 s respectively.
- The 14b and 32b models do not fit in the ~7.6 GB that other processes leave free.

**Runner.** I used the v1 runner (`scratchpad/calibrate_longtimeout.py`, sha256
`aaa826e4…`) with a scratch copy of the v1 env (`proxy/v1env`, copied from
`metaharness-arena-383` @ `bada4f0c`). This is the same runner sha recorded in
`calib2/*.jsonl` receipts. The env copy reproduces the calib2 reset observation
byte for byte, so the seeds are paired with the 27B runs. The v2 env does not match.

```
ARENA_MODEL_API_KEY=local PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=$SCRATCH/proxy/v1env \
/tmp/arena383venv/bin/python $SCRATCH/calibrate_longtimeout.py --execute \
  --base-url http://localhost:11434/v1 --model <qwen2.5:1.5b-instruct|qwen2.5-coder:7b> \
  --model-revision ollama-0.30.11 --task-id math_route --difficulty 1 \
  --max-steps 8 --max-tokens 4096 --seed 400100 --output $SCRATCH/proxy/<file>.jsonl
```

**Results.** Cell: math_route, difficulty 1, seeds 400100–400103, 4 attempts.

| Model | Solved | Per-episode failures | Calls | Total tokens | Latency per episode |
|---|---|---|---|---|---|
| Qwen3.8-27B (`calib2/math_route_d1.jsonl`) | **4/4** | none | 2,2,2,2 | 2113, 2000, 2362, 2450 | 42.3, 26.5, 39.3, 54.5 s |
| qwen2.5:1.5b-instruct | 0/4 | ValidationError, ValidationError, wrong answer, wrong answer | 1,1,2,2 | 472, 456, 1549, 1487 | 0.21–0.56 s |
| qwen2.5-coder:7b | 0/4 | wrong answer ×2, empty `answer:{}`, step_budget_exhausted (8× `read *`) | 2,2,2,8 | 1449, 1418, 1512, 18811 | 0.62–2.61 s |

### How the proxies fail

The runner does not record content for ValidationError episodes or the
`finish_reason`. I therefore replayed the first step 7 times with `proxy/probe_first_step.py`
(1.5b, seeds 400100 and 400101). Six of the seven replies failed validation. All had
`finish_reason=stop` and 14–47 completion tokens. The errors were:

- the `"op"` field was missing;
- a bare `{"route":…}` object was submitted without reading the files;
- node IDs were made up, such as `[2,5,10]` or `["A","B","C","D"]`.

These are capability errors, not env-protocol bugs and not truncation.

The 7b always produced valid actions, but it answered in about 40 completion tokens
without reasoning. For seed 400100 its route had exposure 11 against `max_exposure`
9, so it was infeasible. In one episode it looped on `read *` until it ran out of steps.

The 27B solved every instance. Its visible content was also a short JSON action. On
the same prompts its episodes used 2000–2450 tokens, while the proxies' 2-call
episodes used about 1450–1550 tokens (prompt ≈ 1400–1500). That means the 27B spent
roughly 500–1000 extra completion tokens per episode on reasoning. vLLM strips that
reasoning from `content` but counts it in `usage`.

### Why proxy outcomes cannot rank variants like the 27B

1. **The floor is wrong.** The proxies score 0 on the easiest cell, where the 27B saturates. Every genome would score 0 signal and the search has no gradient. I did not run the planned second cell (security_triage d2, seed 400200, where the 27B scores 2/4). With a zero floor it could only return 0/4, which tells us nothing.
2. **The failure mode is wrong.** Qwen 2.5 does not reason before answering. Across 8 episodes and 7 probes, its largest
completion was about 50 tokens against a 4096 cap, so a mutation of `<family>.budget` would have no effect on the proxy, while for the 27B budget is the main driver of truncation versus success. The fitness signal (P(a group of 4 is all-eligible and mixed), see lib/fitness.mjs) would be measured on a different failure distribution.
3. **Its format errors mean something different.** A proxy ValidationError reflects the model's capability, so it is not evidence of an env or schema defect. Even "format sanity" screening would mostly measure the proxy.

## 3. Recommendation

- **Darwin fitness screening and difficulty ranking: do not use.** Keep the 27B on the rented A100 as the only fitness oracle. Use the cache and `--max-new-cells` guards to keep that affordable.
- **Pipeline smoke tests: use ollama, not ruvllm.** Ollama can stand in for the endpoint to test runner wiring, JSONL rows and cache keys, and to check that the evaluator fails closed on an all-zero cell. That runs at about 1 s per episode and $0. Never mix proxy rows into a real cache: put `model` and `modelRevision` into `cellKey` provenance.
- **ruvllm: do not use** until it (a) is built with CUDA, (b) can load qwen2/qwen3 GGUF files, (c) has the download bug fixed, and (d) either refuses to start or returns 5xx instead of serving mock completions.

## 4. Not verified

- **Qwen3 small thinking models** (for example `qwen3:1.7b` or `qwen3:4b`; I estimate about 1.4 GB and 2.5 GB at Q4, which would fit in the free VRAM, but I did not check) are not installed locally, and I did not pull them into the shared ollama store. A thinking model is the only kind that could reproduce budget truncation. Whether its truncation and success profile ranks cells like the 27B is an open question that would need a paired multi-cell test. It is the only proxy candidate worth testing next.
- **Only one cell (math_route d1) was run per proxy.** I did not test the v2 runner (`calibrate.py --accounting arena`, which needs a tokenizer) against ollama.
- **I did not test ruvllm with Phi-4-mini or Llama**, the architectures it does support. Those are not Qwen and the build is CPU-only, so they are out of scope.

## Evidence

All files are in `/home/ruvultra/.cache/claude-code/tmp/claude-1000/-home-ruvultra-metaharness/fdc9c3bf-0e2e-4419-9363-e2abdaffd1c5/scratchpad/proxy/`.

- `math_route_d1_qwen2.5-1.5b.jsonl`: sha256 `df3b2ea922759a1caa538b9ac38e713ede8db1e18eac8fb5cfc74872b1234c0c`
- `math_route_d1_qwen2.5-coder-7b.jsonl`: sha256 `caedadc8e21c5b94cfb10d8b489eedbbb8c8a36c305a111d2556a1169b27e833`
- `ruvllm-serve-qwen3b.log`, `ruvllm-serve-qwen05-gguf.log`, `ruvllm-download.log`
- `probe_first_step.py`, `show_rows.py`: scratch diagnostics only

**Cleanup.** Both ruvllm servers (ports 18181 and 18182) were stopped, and both ollama
models I loaded were unloaded with `keep_alive:0`. GPU memory used was
8115 MiB before the tests and 8475 MiB after them. The 360 MiB difference is not
from this test: another agent's `all-minilm` (26 MiB) is loaded in ollama, and other
processes' usage drifted. I did not stop or modify any other process.
