# ADR-022: MCP as a Modular, Gated, Security-First Primitive

**Status**: Accepted
**Date**: 2026-06-14
**Related**: ADR-004 (host integration model), ADR-005 (marketplace plugin), ADR-011 (witness + provenance), ADR-020 (web generator UI), ADR-023 (repo-to-harness importer)

## Context

MCP (the Model Context Protocol) is an open standard for connecting AI applications to external systems over JSON-RPC with stdio and Streamable HTTP transports. For this project it is not optional: it is the interop layer that lets a *generated* harness be driven by Claude Code, Codex, Hermes, OpenClaw, and other hosts without bespoke glue per host.

But MCP must not become the whole product. The meta-harness's claim is broader than "another MCP scaffold": the harness is the operating layer *around* the protocol — memory, routing, policy, validation, signing, release gates, multi-host execution. **MCP standardizes access; the harness governs execution.**

There is also a real safety problem to get ahead of. Measurement studies of open-source MCP servers report tool-poisoning, prompt-injection, supply-chain, and over-broad-permission risks; production agents need identity, budgeting, timeouts, and observability *around* the protocol, not just the protocol. A generator that emits ungoverned MCP servers would be shipping that risk at scale.

## Decision

Ship MCP as **one selectable primitive** alongside CLI, memory namespace, learning loop, witness signing, and release gates. It has three modes and is **default-deny** when on.

### Three modes

- `off` — no MCP surface emitted; host configs register no server; the `mcp` keyword and script are omitted.
- `local` — stdio transport (the default for Claude Code / desktop workflows).
- `remote` — Streamable HTTP transport for hosted / team / enterprise deployments, with an auth layer required.

### What gets emitted (when on)

```
src/mcp/server.ts      gated dispatch: tool → policy → (approval) → timeout-bounded run → audit
src/mcp/tools.ts       deterministic tool registry; example tool needs no privileged capability
src/mcp/resources.ts   read-only resource registry (manifest, capability manifest, memory views)
src/mcp/prompts.ts     branded prompt registry
src/mcp/policy.ts      the enforced gate (decide() + withTimeout())
src/mcp/audit.ts       append-only audit log, never allowed to crash a call
src/mcp/auth.ts        bearer auth — REMOTE ONLY
.harness/mcp-policy.json       the policy as inert, scannable data
.harness/mcp-capabilities.json a capability manifest hosts can inspect
```

### Security-first defaults

The policy ships with every capability set to its safe value; the author opts **into** capability, never out of safety:

```json
{ "defaultDeny": true, "allowNetwork": false, "allowShell": false, "allowFileWrite": false,
  "requireApprovalForDangerous": true, "toolTimeoutMs": 30000, "maxToolCallsPerTurn": 8, "auditLog": true }
```

`policy.ts` enforces this at runtime: a tool that declares `needs.shell` is denied unless `allowShell` is granted; a tool flagged `dangerous` requires explicit approval; every call is timeout-bounded and audited.

### Policy is data, so it can be governed

The policy is emitted **twice** — enforced TS and inert JSON. The JSON is what makes the rest of the supply chain work:

- **`harness mcp-scan [path]`** — "npm audit for agent tools." Static-only (never executes anything) inspection of the policy + host permissions + `package.json` that flags: no policy, not-default-deny, shell/network/file-write grants, missing approval gate, missing audit log, missing timeout, missing call budget, wildcard tool permissions, risky `Bash(rm|curl|sudo …)` allow-rules, unguarded secret reads, and unpinned dependency ranges. Exit 1 on any HIGH.
- **Witness (ADR-011)** — because the policy and capability manifest are files in the tree, they are fingerprinted into `.harness/manifest.json` and signed, so a release's tool surface + policy are provenance-bound.

### Per-host wiring follows the mode

`.claude/settings.json`, `.codex/config.toml`, `.openclaw/openclaw.json`, and Hermes `optional-mcps/<name>.json` register a stdio command server for `local` and an HTTP/url server for `remote`, and register **nothing** when `off` (and drop the `mcp__<name>__*` permission grant accordingly).

## Consequences

**What gets better**

- A generated harness is interoperable across every supported host through one standard, but ships *governed* by default — the opposite of the rough MCP servers the measurement studies flag.
- `mcp-scan` turns the security posture into a CI gate, not a hope.
- The capability manifest lets hosts (and a future registry) inspect exactly what a harness exposes before installing it.

**What this costs**

- More generated files and a second policy representation (TS + JSON). Mitigated: the JSON is the source the TS imports, and `mcp-scan`/witness consume the same JSON.
- The remote auth layer is a bearer-token starting point, not a full OAuth/mTLS stack. Documented as such in the generated `auth.ts`; production deployments harden it.

**What explicitly does not change**

- The kernel is untouched: MCP is content the generator emits, not a kernel concern (ADR-002).
- `off` is a first-class mode — the meta-harness is bigger than MCP, and a memory-only or CLI-only harness is valid.

## Alternatives Considered

- **MCP always-on.** Rejected: it conflates the protocol with the product and forces an attack surface on harnesses that do not need it.
- **Allow-by-default policy with opt-out hardening.** Rejected outright — the safe state must be the default state; security you have to remember to turn on is not security.
- **A runtime MCP-proxy that enforces policy out-of-process.** Heavier and host-specific; the in-harness `policy.ts` gate is portable and travels with the signed artifact.
- **No scanner; rely on review.** Rejected: the whole value is making the risk machine-checkable. A static scanner that never executes repo/harness code is the safe, CI-able form.

## Test Contract

- **Generator (UI).** `off` emits no `src/mcp/*` and no `mcpServers`; `local` emits the full surface minus `auth.ts`; `remote` adds `auth.ts` and an `http` transport in Claude + Codex configs; the policy JSON carries the safe defaults; the manifest records `primitives.mcp` and nulls the policy when off. (`apps/web-ui/src/generator/__tests__/mcp.test.ts`.)
- **Scanner (CLI).** A safe default-deny harness scans clean (`worst: info`, exit 0); a server with no policy is HIGH (exit 1); shell + not-default-deny + wildcard perms are all flagged; missing audit/timeout/secret-guard/unpinned-deps are flagged at their severities. (`packages/create-agent-harness/__tests__/mcp-scan.test.ts`.)

**Acceptance test (manual):** generate a harness with `mcp: local`, install it into Claude Code, call the `ping` tool, and verify the witness manifest records the tool schema, version, policy, and generated-file hashes.

## References

- MCP — open standard, JSON-RPC, stdio + Streamable HTTP transports (modelcontextprotocol.io)
- MCP authorization guidance for HTTP servers exposing sensitive resources
- Measurement studies on MCP server security (tool poisoning, supply-chain, over-broad permissions)
- ADR-004 — host integration model (the per-host config shapes this extends)
- ADR-011 — witness + provenance (binds the policy + capability manifest into the signed release)
