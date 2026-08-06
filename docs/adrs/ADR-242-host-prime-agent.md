# ADR-242: host-prime-agent — Prime Agent (Prime Intellect) as the 11th harness host

**Status**: Proposed
**Date**: 2026-08-06
**Project**: `ruvnet/agent-harness-generator`
**Deciders**: ruv
**Tags**: prime-agent, host-adapter, skills, python, sandboxing
**Extends**: ADR-004 (Host integration model)
**Related**: ADR-022 (MCP default-deny posture), ADR-036 (host-opencode — per-host ADR precedent), ADR-044 (host capability coverage), ADR-046 (real-install verification), ADR-241 (companion — continual-harness primitives; shipped as a pair)
**Prompted by**: the Prime Agent research pass in [`docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md`](../research/scaffolding/PRIME-AGENT-ANALYSIS.md); this ADR covers Prime Agent as an **emission target**, ADR-241 covers what we borrow from its design.

---

## Context

Prime Agent (<https://github.com/PrimeIntellect-ai/prime-agent>, MIT) is an open-source coding/autonomy harness with real adoption (2.5k stars at time of writing) and a **verified, adapter-friendly config surface** — documented in `packages/coding-agent/docs/skills.md` and confirmed in the research doc §3:

- Skills are discovered (highest precedence first) from user (`~/.prime/agent/skills/`, `~/.agents/skills/`) → project (`.prime/agent/skills/`, `.agents/skills/`) → package (`skills/` dirs, `pi.skills` in `package.json`) → CLI `--skill <path>` → built-in.
- A skill = a directory with `SKILL.md` (YAML frontmatter: `name` lowercase `a-z0-9-`; `description` ≤ 1024 chars; optional `license`, `compatibility`, `disable-model-invocation`), optionally Python-backed via `pyproject.toml` + `src/<pkg>/__init__.py`, importable in the persistent IPython kernel.
- Autonomous invocation: `--autonomous --autonomous-gate "<cmd>" --autonomous-max-turns <n>`, plus `/goal`, `/heartbeat`, `prime-agent schedule`.

Prime Agent is built atop the `pi` framework (badlogic `pi-mono`) — the direct sibling of our existing `packages/host-pi-dev` adapter, and it even honors `pi.skills` package entries. Like pi, it ships **no MCP**; tools must land as skills, the same design problem host-pi-dev solved with generated `pi.registerTool` extensions (see the design notes at the top of `packages/host-pi-dev/src/index.ts`).

One property dominates the design: **Prime Agent is not sandboxed.** Its own security note says worker/kernel processes "aren't sandboxes" and that untrusted code needs external sandboxing. Our harnesses carry a default-deny permissions posture (ADR-022) that this host cannot enforce natively — ADR-046 taught us that silently dropping a harness's posture is exactly the bug class real-install verification exists to catch.

## Decision

Ship `@metaharness/host-prime-agent` (`packages/host-prime-agent/`), the **11th host adapter**, implementing the standard `HostAdapter` interface (`packages/kernel-js/src/types.ts`): `generateConfig(spec: HarnessSpec): Record<string, string>`.

### 2.1 Emission map

| HarnessSpec input | Emitted files |
|---|---|
| `spec.tools[]` | One **project-scoped, Python-backed skill per tool** at `.prime/agent/skills/<tool-name>/`: `SKILL.md` (frontmatter from the tool name/description, name normalized to `a-z0-9-`), `pyproject.toml`, and `src/<pkg>/__init__.py` — a shim that dispatches to the kernel (`kernel.invokeTool(name, args)`), the Python mirror of host-pi-dev's `extensionSource` TypeScript pattern. |
| `spec.systemPrompt` | A supplemental prompt file in the project skill/prompt surface (continual-harness durable state), not an attempt to replace Prime Agent's base prompt. |
| `spec.agents[]` | Reusable sub-agent spec files alongside the skills, one per agent. |
| `spec.mcpServers[]` | **Not emitted as MCP** (host has none). Each MCP-backed tool is wrapped behind the same skill shim; servers that can't be wrapped are listed in `install-prime-agent.md` as unavailable on this host. |
| ADR-241 §2.2 `autonomous` block | A documented invocation snippet in `install-prime-agent.md`: `prime-agent --autonomous --autonomous-gate "<gateCommand>" --autonomous-max-turns <maxTurns> "<goal.text>"`, plus `/goal --budget <tokenBudget>` and `/heartbeat` guidance. No autonomous fields are silently dropped. |
| `spec.permissions` | See §2.2 — the load-bearing rule. |

Also emitted: `install-prime-agent.md` (how to install Prime Agent, where the skills land, precedence notes, the sandbox warning below). The runbook name is host-qualified — host-opencode already owns `install.md`, and a multi-host scaffold merges every adapter's file map into one directory, so an unqualified name would collide (implementation note, 2026-08-06).

### 2.2 Fail-closed permissions posture

Prime Agent executes model-written Python at user permission level with no native allow/deny enforcement. Therefore:

- If `spec.permissions.deny` is **non-empty**, `generateConfig` MUST emit an explicit, prominent `SANDBOX-REQUIRED.md` (and the same warning at the top of `install-prime-agent.md`) stating that this harness's deny-list **cannot be enforced by Prime Agent itself** and enumerating the denied capabilities that require an external sandbox (container, RVM per ADR-018, or equivalent).
- The adapter MUST NOT silently drop the deny-list (the ADR-046 bug class). Emitting the harness *without* the warning artifacts is a contract-test failure.
- `spec.permissions.allow` entries are projected into each generated `SKILL.md` description so the model-facing surface documents intended scope, even though enforcement is external.

### 2.3 Scope

Estimated effort: 4–6 engineering days (adapter + tests), following the ADR-032/036 pattern: config emission only — no protocol bridge, no runtime component. Propagation (HOSTS catalog, bench, web-UI, CI) follows the ADR-033 checklist. Real-install verification (`prime-agent` headless run against a generated harness) joins `verify-all-hosts.mjs` per ADR-046.

## Consequences

- Generated harnesses become runnable on an open-source, MIT, self-hosted harness with strong published results — widening the "pick one or all" host menu to 11, at the cost of one more adapter to keep propagated (ADR-033 checklist) and verified (ADR-044/046 coverage matrix).
- The Python skill shim introduces the first **Python** codegen path in a host adapter (all prior emitters produce JSON/YAML/TS/MD). Golden-file tests carry the burden of keeping it deterministic.
- The sandbox posture is honest but blunt: some harnesses will ship with a "requires external sandboxing" banner on this host. That is the correct trade — the alternative is a silently unenforced deny-list.
- pi-lineage compatibility (`pi.skills`) means a future consolidation with host-pi-dev is plausible; the two adapters stay separate until Prime Agent's surface diverges or converges enough to decide (revisit at implementation).

## Alternatives Considered

- **Emit into the user-global `~/.agents/skills/`** — rejected. Project-scoped `.prime/agent/skills/` wins precedence over package scope while remaining vendorable in the harness repo; global emission would leak one harness's tools into every project.
- **Reuse host-pi-dev output via `pi.skills` package entries** — considered; documented as a compatibility note rather than the mechanism. It would couple two hosts' emission paths and skip Prime Agent-native `SKILL.md` metadata (`disable-model-invocation`, compatibility fields).
- **Wait for Prime Agent to add MCP** — rejected. pi's lineage explicitly rejects MCP by design ("no MCP" is a stated non-goal upstream); the skill-shim path is the supported integration, exactly as it was for host-pi-dev.
- **Refuse to support the host at all because it lacks sandboxing** — rejected. RVM (ADR-018) and containers exist precisely to supply external isolation; fail-closed warnings preserve the posture without denying users an open-source host.

## Test Contract

Contract tests, per the host-adapter convention (ADR-032/036/044):

1. **Frontmatter validity**: every generated `SKILL.md` has `name` matching `^[a-z0-9-]+$` and `description` ≤ 1024 chars; tool names that violate the charset are normalized deterministically.
2. **Completeness**: exactly one skill directory per `spec.tools` entry, each with parseable `pyproject.toml` and an importable shim module path.
3. **Golden file**: `generateConfig(defaultSpec)` snapshot-matches a committed golden output byte-for-byte (determinism gate for the Python codegen path).
4. **Fail-closed**: with non-empty `permissions.deny`, the output map contains `SANDBOX-REQUIRED.md` naming every denied capability, and `install-prime-agent.md` opens with the warning; with an empty deny-list, neither warning artifact appears.
5. **No silent drops**: every `HarnessSpec` field consumed by the emission map in §2.1 either appears in the output or is explicitly listed in `install-prime-agent.md` as unsupported on this host (ADR-044 capability-coverage discipline).
6. **Autonomous projection**: given an ADR-241 `autonomous` block, `install-prime-agent.md` contains the exact `--autonomous-gate`/`--autonomous-max-turns` invocation; absent the block, no autonomous section is emitted.

## References

- `PrimeIntellect-ai/prime-agent` — <https://github.com/PrimeIntellect-ai/prime-agent>; skills surface: `packages/coding-agent/docs/skills.md`; security note on non-sandboxed execution (repo README)
- [`docs/research/scaffolding/PRIME-AGENT-ANALYSIS.md`](../research/scaffolding/PRIME-AGENT-ANALYSIS.md) §3–§4 (verified config surface), §8 (sandbox caveat)
- `packages/host-pi-dev/src/index.ts` — sibling adapter and design-note precedent for MCP-less hosts
- ADR-004, ADR-018, ADR-022, ADR-032/033/036, ADR-044/046, ADR-241
