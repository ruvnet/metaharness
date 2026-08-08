# kimi-k3-harness

Repo-aware coding agent harness for kimi-k3-in-c — Kimi K3 (2.78T-param) inference in portable C99: one CPU, 8 GB RAM, no BLAS, no framework, no GPU

> **Advanced Coding** — Architect → implement → review → test, with a code-index MCP and push-guarded git perms.
>
> Generated with [`create-agent-harness`](https://github.com/ruvnet/agent-harness-generator). Multi-host scaffolding with a kernel that resolves native → wasm → js (js backend in the published beta; see `harness doctor`).

## Install

```bash
npm install -g kimi-k3-harness
kimi-k3-harness init
kimi-k3-harness doctor
```

## Agents

| Agent | Role |
|---|---|
| `architect` | Designs the change before code is written. |
| `implementer` | Writes code that matches the surrounding style. |
| `reviewer` | Hunts correctness bugs in the diff. |
| `test-writer` | Adds the missing tests for the change. |

This harness ships with the **claude-code** adapter.

## Evolution & kernel benchmarks (Darwin + Flywheel + Rust/WASM)

The harness carries a measured self-improvement loop — frozen model, evolving
harness — plus a Rust→WASM replica of the kimi-k3-in-c trunk inner loop
(block-quantized int8 matvec, blocks of 32, per-block f32 scales) as its
optimization target:

```bash
npm run build:wasm     # cargo build crates/k3-kernel-bench → wasm32 (+simd128)
npm run flywheel       # @metaharness/flywheel: run→measure→mutate→verify→promote
npm run bench:kernel   # root policy vs flywheel-tuned policy, both shapes
npm run evolve         # @metaharness/darwin: real-sandbox harness evolution
```

Measured on the reference container (results in `.harness/flywheel/`):

| Policy | holdout 1024×4096 | anchor 512×8192 |
|---|---|---|
| root `scalar/u1/a1` (naive C99-style loop) | 1.96 GOPS | 5.11 GOPS |
| tuned `simd/u1/a4` (flywheel gen-2) | 9.95 GOPS (**5.07×**) | 10.83 GOPS (**2.12×**) |

Every promotion cleared a frozen conjunctive gate (≥2% lift, no cost
regression, correctness vs an f64 golden reference, anchor shape must not
regress) and is Ed25519-signed; `verifyReplayBundle` re-verifies the full
lineage from `.harness/flywheel/replay-bundle.json` with no trust in the
machine that produced it. The Darwin real-sandbox run record lives in
`.harness/darwin/` (baseline retained — no mutation beat the gate).

## License

MIT
