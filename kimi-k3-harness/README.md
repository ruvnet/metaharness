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

## License

MIT
