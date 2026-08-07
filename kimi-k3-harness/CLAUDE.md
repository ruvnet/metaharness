# kimi-k3-harness

Repo-aware coding agent harness for kimi-k3-in-c — Kimi K3 (2.78T-param) inference in portable C99: one CPU, 8 GB RAM, no BLAS, no framework, no GPU

> Advanced Coding harness · domain: `software-engineering`. Generated with [create-agent-harness](https://github.com/ruvnet/agent-harness-generator).

## Behavioral rules

- Use the harness's MCP tools (`mcp__kimi-k3-harness__*`) for orchestration
- Memory and routing are handled by the kernel — you don't need to learn them
- Defer destructive operations to the user

## Agents

| Agent | Tier | Role |
|---|---|---|
| `architect` | opus | Designs the change before code is written. |
| `implementer` | sonnet | Writes code that matches the surrounding style. |
| `reviewer` | opus | Hunts correctness bugs in the diff. |
| `test-writer` | sonnet | Adds the missing tests for the change. |
## Skills

- `/plan-change` — Turn a feature request into a minimal, file-level implementation plan before any code.

## Commands

- `doctor` — Health-check the harness: kernel load, MCP wiring, memory backend, host adapter.
- `review-diff` — Review the current working diff for correctness, security, and reuse.

## Architecture

This harness uses [@metaharness/kernel](https://www.npmjs.com/package/@metaharness/kernel) — a Rust-compiled WASM module with a NAPI-RS native fallback — so the same code runs identically on every platform.

## Project: kimi-k3-in-c

This harness targets **kimi-k3-in-c** — Kimi K3 (2.78 T parameters) inference in
portable C99. One CPU, 8 GB of RAM. No BLAS, no framework, no GPU.

| Fact | Value |
|---|---|
| Parameters | 2.78 T |
| Checkpoint on disk | 1.56 TB |
| Peak RSS, measured (`--preset laptop`) | 8.24 GB |
| Peak RSS, measured (`--preset server`) | 127.92 GB |
| Engine size | 176 KB |
| GPUs | 0 |
| Language / license / platform | C99 · Apache-2.0 · Linux x86-64 |

### Running the engine

```bash
./bin/k3 ~/k3model --trunk ~/k3trunk --preset laptop \
        --tok ~/k3model --prompt "The capital of France is" --gen 8 --incremental
```

- `--preset laptop` trades speed for memory (~32.7 s/token, 8.24 GB peak RSS);
  `--preset server` trades memory for speed (~10.7 s/token, 127.92 GB peak RSS).
  More memory changes only the clock, never the output.
- This is a **base model**: output is a continuation, not a reply. There is no
  chat template — do not treat generations as assistant answers.
- Generation is slow (minutes per short run). Never launch `./bin/k3` as a
  casual smoke test; prefer the project's unit tests and small fixtures.

### Rules for agents working on this repo

- **Portability is the product.** Changes must stay portable C99: no BLAS, no
  GPU/framework dependencies, no platform-specific intrinsics outside existing
  guarded paths.
- **Memory is the budget.** Peak RSS is a headline metric. Any change touching
  the trunk/streaming path must state its effect on peak RSS under
  `--preset laptop`.
- **Every performance figure must be measured, not asserted.** All numbers in
  docs come from the measurement output in `docs/data/` — update the data, then
  the docs, never the docs alone.
