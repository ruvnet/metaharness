# @metaharness/host-prime-agent

Prime Agent ([PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent))
host adapter — the 11th harness host, per
[ADR-242](../../docs/adrs/ADR-242-host-prime-agent.md).

## What it emits

Prime Agent ships no MCP; integration lands as **project-scoped, Python-backed
skills** under `.prime/agent/skills/`:

- One skill directory per `spec.tools` entry: `SKILL.md` (YAML frontmatter,
  name normalized to `a-z0-9-`), `pyproject.toml`, and a
  `src/<pkg>/__init__.py` shim that dispatches to the harness kernel — the
  Python mirror of host-pi-dev's `pi.registerTool` extension pattern.
- `spec.systemPrompt` → `.prime/agent/skills/harness-prompt.md`
- `spec.agents[]` → `.prime/agent/agents/<name>.md`
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
