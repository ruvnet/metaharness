# @metaharness/host-prime-agent

Prime Agent ([PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent))
host adapter — the 11th harness host, per
[ADR-242](../../docs/adrs/ADR-242-host-prime-agent.md).

## What it emits

Integration lands as project-scoped skills under `.prime/agent/skills/`:

- `spec.tools[]` → instruction-only `SKILL.md` contracts. `ToolSpec` does not
  contain an executable handler, so the adapter never fabricates one.
- Remote HTTP `spec.mcpServers[]` → `.prime/agent/settings.json` plus real
  Python-backed `rlm.McpIntegration` skill packages. Local stdio MCP remains
  explicitly unsupported by Prime Agent's current kernel integration.
- `spec.systemPrompt` → `.prime/agent/APPEND_SYSTEM.md`
- `spec.agents[]` → skills that delegate through Prime Agent's native `rlm`
  recursive-agent callable
- Always: `install-prime-agent.md` (install runbook, skill precedence notes,
  MCP availability, and the ADR-241 autonomous invocation snippet when present)

## Sandbox caveat

**Prime Agent is not sandboxed.** It executes model-written Python at user
permission level with no native allow/deny enforcement. When
`spec.permissions.deny` is non-empty, this adapter fails closed: it emits a
prominent `SANDBOX-REQUIRED.md` (and the same warning at the top of
`install-prime-agent.md`) enumerating the denied capabilities that require an
external sandbox (container, RVM per ADR-018, or equivalent). The deny-list is
never silently dropped (ADR-242 §2.2).
