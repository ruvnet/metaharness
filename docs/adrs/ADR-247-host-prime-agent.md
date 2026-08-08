# ADR-247: host-prime-agent — Prime Agent (Prime Intellect) as the 11th harness host

**Status**: Implemented (corrected 2026-08-06)
**Date**: 2026-08-06
**Updated**: 2026-08-06 — replaced a nonexistent kernel CLI shim and stale
Prime Agent assumptions with instruction-only tool contracts, native prompt /
`rlm` surfaces, and executable remote HTTP MCP integrations.
**Project**: `ruvnet/agent-harness-generator`
**Deciders**: ruv
**Tags**: prime-agent, host-adapter, skills, python, sandboxing
**Extends**: ADR-004 (Host integration model)
**Related**: ADR-022 (MCP default-deny posture), ADR-036 (host-opencode — per-host ADR precedent), ADR-044 (host capability coverage), ADR-046 (real-install verification), ADR-246 (companion — continual-harness primitives; shipped as a pair)
**Prompted by**: the Prime Agent research pass in [`docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md`](../research/scaffolding/PRIME-AGENT-ANALYSIS.md); this ADR covers Prime Agent as an **emission target**, ADR-246 covers what we borrow from its design.

---

## Context

Prime Agent (<https://github.com/PrimeIntellect-ai/prime-agent>, MIT) is an open-source coding/autonomy harness with real adoption (2.5k stars at time of writing) and a **verified, adapter-friendly config surface** — documented in `packages/coding-agent/docs/skills.md` and confirmed in the research doc §3:

- Skills are discovered (highest precedence first) from user (`~/.prime/agent/skills/`, `~/.agents/skills/`) → project (`.prime/agent/skills/`, `.agents/skills/`) → package (`skills/` dirs, `pi.skills` in `package.json`) → CLI `--skill <path>` → built-in.
- A skill = a directory with `SKILL.md` (YAML frontmatter: `name` lowercase `a-z0-9-`; `description` ≤ 1024 chars; optional `license`, `compatibility`, `disable-model-invocation`), optionally Python-backed via `pyproject.toml` + `src/<pkg>/__init__.py`, importable in the persistent IPython kernel.
- Autonomous invocation: `--autonomous --autonomous-gate "<cmd>" --autonomous-max-turns <n>`; persistent goals use `--goal` and `--goal-token-budget`.

Prime Agent retains pi lineage but its current architecture is distinct: it supports remote HTTP MCP through Python-backed `McpIntegration` skills, native recursive subagents through `rlm`, and project prompt augmentation through `.prime/agent/APPEND_SYSTEM.md`. Local stdio MCP servers are not currently wired into the kernel.

The shared `ToolSpec` is metadata only (`name`, `description`, `inputSchema`). It contains no handler, command, or MCP binding. Therefore an adapter cannot honestly turn an arbitrary `ToolSpec` into executable code. The initial implementation violated this boundary by generating a Python shim that ran `npx --yes @metaharness/kernel invoke-tool`; `@metaharness/kernel` exposes neither that CLI binary nor an `invoke-tool` command. Syntax-only tests missed the runtime failure.

One property dominates the design: **Prime Agent is not sandboxed.** Its own security note says worker/kernel processes "aren't sandboxes" and that untrusted code needs external sandboxing. Our harnesses carry a default-deny permissions posture (ADR-022) that this host cannot enforce natively — ADR-046 taught us that silently dropping a harness's posture is exactly the bug class real-install verification exists to catch.

## Decision

Ship `@metaharness/host-prime-agent` (`packages/host-prime-agent/`), the **11th host adapter**, implementing the standard `HostAdapter` interface (`packages/kernel-js/src/types.ts`): `generateConfig(spec: HarnessSpec): Record<string, string>`.

### 2.1 Emission map

| HarnessSpec input | Emitted files |
|---|---|
| `spec.tools[]` | One project-scoped, instruction-only `SKILL.md` per tool. It documents the declared name/schema and requires a real host or MCP capability before claiming execution. No handler is fabricated. |
| `spec.systemPrompt` | `.prime/agent/APPEND_SYSTEM.md`, the current project-scoped append surface. |
| `spec.agents[]` | Reusable skills that delegate through Prime Agent's built-in `rlm` callable. |
| `spec.mcpServers[]` | Remote HTTP servers are emitted into `.prime/agent/settings.json` plus a Python-backed `McpIntegration` skill. Local stdio commands are listed as unsupported because Prime Agent does not currently wire them into its kernel. |
| ADR-246 §2.2 `autonomous` block | A documented invocation using `--autonomous-gate`, `--autonomous-max-turns`, `--goal`, and `--goal-token-budget`. Heartbeat metadata is preserved as workflow guidance because current Prime Agent has no `/heartbeat` surface. |
| `spec.permissions` | See §2.2 — the load-bearing rule. |

Also emitted: `install-prime-agent.md` (how to install Prime Agent, where the skills land, precedence notes, the sandbox warning below). The runbook name is host-qualified — host-opencode already owns `install.md`, and a multi-host scaffold merges every adapter's file map into one directory, so an unqualified name would collide (implementation note, 2026-08-06).

### 2.2 Fail-closed permissions posture

Prime Agent executes model-written Python at user permission level with no native allow/deny enforcement. Therefore:

- If `spec.permissions.deny` is **non-empty**, `generateConfig` MUST emit an explicit, prominent `SANDBOX-REQUIRED.md` (and the same warning at the top of `install-prime-agent.md`) stating that this harness's deny-list **cannot be enforced by Prime Agent itself** and enumerating the denied capabilities that require an external sandbox (container, RVM per ADR-018, or equivalent).
- The adapter MUST NOT silently drop the deny-list (the ADR-046 bug class). Emitting the harness *without* the warning artifacts is a contract-test failure.
- `spec.permissions.allow` entries are projected into each generated `SKILL.md` description so the model-facing surface documents intended scope, even though enforcement is external.

### 2.3 Scope

The adapter remains config emission only. Executable output is limited to remote HTTP MCP entries whose URL is present in `HarnessSpec`; arbitrary tools remain declarative until the shared schema gains an explicit execution binding. Propagation (HOSTS catalog, bench, web-UI, CI) follows the ADR-033 checklist.

## Consequences

- Generated harnesses become runnable on an open-source, MIT, self-hosted harness with strong published results — widening the "pick one or all" host menu to 11, at the cost of one more adapter to keep propagated (ADR-033 checklist) and verified (ADR-044/046 coverage matrix).
- Remote HTTP MCP integration introduces a Python codegen path whose runtime target is Prime Agent's documented `rlm.McpIntegration`, not a guessed MetaHarness command. Golden and import-contract tests keep it deterministic.
- The sandbox posture is honest but blunt: some harnesses will ship with a "requires external sandboxing" banner on this host. That is the correct trade — the alternative is a silently unenforced deny-list.
- pi-lineage compatibility (`pi.skills`) means a future consolidation with host-pi-dev is plausible; the two adapters stay separate until Prime Agent's surface diverges or converges enough to decide (revisit at implementation).

## Alternatives Considered

- **Emit into the user-global `~/.agents/skills/`** — rejected. Project-scoped `.prime/agent/skills/` wins precedence over package scope while remaining vendorable in the harness repo; global emission would leak one harness's tools into every project.
- **Reuse host-pi-dev output via `pi.skills` package entries** — considered; documented as a compatibility note rather than the mechanism. It would couple two hosts' emission paths and skip Prime Agent-native `SKILL.md` metadata (`disable-model-invocation`, compatibility fields).
- **Generate a kernel `invoke-tool` shim** — rejected after implementation testing. `ToolSpec` has no execution binding and `@metaharness/kernel` has no matching CLI; the generated code could only fail or fetch an unpinned registry package.
- **Treat Prime Agent as MCP-free because pi was MCP-free** — rejected. Current Prime Agent documents remote HTTP MCP integrations; pi lineage is not a substitute for checking the present host surface.
- **Refuse to support the host at all because it lacks sandboxing** — rejected. RVM (ADR-018) and containers exist precisely to supply external isolation; fail-closed warnings preserve the posture without denying users an open-source host.

## Test Contract

Contract tests, per the host-adapter convention (ADR-032/036/044):

1. **Frontmatter validity**: every generated `SKILL.md` has `name` matching `^[a-z0-9-]+$` and `description` ≤ 1024 chars; tool names that violate the charset are normalized deterministically.
2. **Completeness**: exactly one instruction-only skill per declarative `spec.tools` entry; no executable shim is emitted without an execution binding.
3. **Golden file**: `generateConfig(defaultSpec)` snapshot-matches a committed golden output byte-for-byte (determinism gate for the Python codegen path).
4. **Fail-closed**: with non-empty `permissions.deny`, the output map contains `SANDBOX-REQUIRED.md` naming every denied capability, and `install-prime-agent.md` opens with the warning; with an empty deny-list, neither warning artifact appears.
5. **No silent drops**: remote HTTP MCP becomes an importable `McpIntegration`; stdio MCP and unsupported fields are explicitly listed in `install-prime-agent.md`.
6. **Autonomous projection**: given an ADR-246 `autonomous` block, `install-prime-agent.md` contains the current `--autonomous-*` and `--goal*` flags; absent the block, no autonomous section is emitted.
7. **Negative runtime contract**: generated output contains no `invoke-tool` command or unpinned `npx --yes @metaharness/kernel` fallback.

## Implementation notes (2026-08-06)

- **Tests**: 19 contract tests, including adversarial regressions for skill-name collision suffixing, an explicit unsupported-section for `hooks`/`statusLine`, heartbeat projection, no fabricated CLI values in the install runbook, and surrogate-safe description truncation.
- **Propagation complete** (ADR-033 checklist): CLI `HOSTS`/host-config entries, web-ui parity byte-identical per ADR-027, a real-measured bench baseline row, `verify-all-hosts` PASS, healthcheck HEALTHY.
- **Count nuance, stated honestly**: this is the **10th IMPLEMENTED adapter**. The title's "11th host" counted host-eve (ADR-083), which remains unimplemented.

## References

- `PrimeIntellect-ai/prime-agent` — <https://github.com/PrimeIntellect-ai/prime-agent>; skills surface: `packages/coding-agent/docs/skills.md`; security note on non-sandboxed execution (repo README)
- [`docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md`](../research/scaffolding/PRIME-AGENT-ANALYSIS.md) §3–§4 (verified config surface), §8 (sandbox caveat)
- `packages/host-pi-dev/src/index.ts` — sibling adapter and design-note precedent for MCP-less hosts
- ADR-004, ADR-018, ADR-022, ADR-032/033/036, ADR-044/046, ADR-246
