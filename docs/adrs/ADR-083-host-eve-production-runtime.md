# ADR-083: Eve as a production-runtime host (agent-as-a-directory) + the convention alignment

**Status**: Proposed
**Date**: 2026-06-18
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-004 (host integration model), ADR-022 (MCP primitive), ADR-011 (witness + provenance), ADR-006 (memory + learning), ADR-036 (host-opencode pattern), ADR-076 (benchmark), ADR-070 (Darwin Mode)

---

## Context

### What is Eve?

[Eve](https://vercel.com/blog/introducing-eve) is an open-source agent framework from Vercel that aims to do "for agents" what Next.js did for the web: standardise the production plumbing so teams ship agent *logic*, not infrastructure. Its defining choices:

- **Filesystem-first, convention-over-configuration.** An agent **is a directory**. A minimal agent is two files (`agent.ts` for model config, `instructions.md` for the system prompt); capabilities are added one file at a time (progressive disclosure):

  ```
  agent/
  ├── agent.ts          # model + provider fallback (via AI Gateway)
  ├── instructions.md   # system prompt / persona
  ├── tools/            # defineTool() + Zod schemas
  ├── skills/           # Markdown domain knowledge, loaded contextually
  ├── subagents/        # delegation targets (clean context, scoped tools)
  ├── connections/      # MCP servers + OpenAPI APIs (OAuth brokered)
  ├── channels/         # Slack/Discord/Teams/HTTP… interface adapters
  └── schedules/        # cron triggers for autonomous work
  ```

  Eve discovers and wires these at build time — no manual registration.

- **Production primitives built in, not bolted on.** Durable execution (per-step checkpointing on the Workflow SDK — pause/crash-recover/resume with zero idle compute); sandboxed compute (agent-written code runs isolated — Docker/bash locally, Vercel Sandbox in prod); **human-in-the-loop approvals** (`needsApproval` pauses indefinitely, resumes from the checkpoint); connections that **broker auth and hide credentials/URLs from the model**; scored **evals** (TypeScript suites that send prompts, assert tool calls + outputs, run locally or against a deployment); **OpenTelemetry** traces (every model call + tool call a span); git-native, deploys as an ordinary Vercel project.

### Why this matters for MetaHarness

MetaHarness *generates and evolves* harnesses; it does not *run them in production*. Eve is the missing production-runtime end of that pipeline, and the alignment is unusually tight — many Eve primitives already exist as MetaHarness concepts under different names:

| Eve primitive | MetaHarness construct it maps to |
|---|---|
| agent-as-a-directory, convention-driven | the generator's convention-driven scaffold (ADR-003) — same philosophy |
| `connections/` (MCP + OpenAPI), credential brokering, model can't see secrets | the **MCP default-deny primitive** (ADR-022) + `mcp-policy.json` |
| `tools/` (`defineTool` + Zod) | gated tool surface (`src/mcp/tools.ts`, ADR-022) |
| `skills/` (Markdown domain knowledge) | harness skills (ADR-003) |
| `subagents/` (scoped delegation) | agents / swarm |
| `channels/` (Slack/HTTP/… adapters) | a *runtime* sibling of **hosts** (ADR-004) — a different axis |
| scored `evals` | the **benchmark layer** (ADR-076) + TDD contracts (ADR-010) |
| OpenTelemetry traces | the trace/**witness** substrate (ADR-011) |
| `needsApproval` human-in-the-loop | *new* — MetaHarness has default-deny but no approval-pause primitive |
| durable execution / checkpointing | *new* — no durable workflow runtime today |
| `schedules/` (cron) | the GitHub Actions host's non-interactive trigger (ADR-033) |

So Eve is simultaneously (a) a new **host** target the generator can emit to, and (b) a source of three production primitives MetaHarness lacks, and (c) the runtime that **closes the Darwin Mode loop** — its evals and traces are exactly the evaluation signal evolution needs (ADR-076).

Eve is also a *new category* of host. Every existing host (claude-code, codex, copilot, opencode, hermes, openclaw, pi-dev, rvm, github-actions) is a coding-agent CLI/IDE or CI surface. Eve is the first **production-application-runtime** host — the analogue of "github-actions was the first non-interactive host" (ADR-033).

## Decision

Adopt Eve along three lines.

### 1. Add `@metaharness/host-eve` — the 10th host (an agent-directory emitter)

Following the ADR-036 (opencode) pattern, but emitting a *directory tree* instead of one config file. Per `adapter.generateConfig(spec)` over the `HarnessSpec`:

| Emitted path | Source in the HarnessSpec | Notes |
|---|---|---|
| `eve/<name>/agent.ts` | model + provider | `defineAgent({ model })`; provider fallback advisory |
| `eve/<name>/instructions.md` | system prompt / persona | the harness identity |
| `eve/<name>/tools/*.ts` | gated MCP tools (ADR-022) | `defineTool()` + Zod; **`needsApproval: true` for any tool the policy marks high-risk** |
| `eve/<name>/skills/*.md` | harness skills | verbatim Markdown |
| `eve/<name>/subagents/*` | sub-agents | scoped tool lists |
| `eve/<name>/connections/*` | `src/mcp/server.ts` registrations | MCP + OpenAPI; **deny rules from `mcp-policy.json` copied verbatim** |
| `eve/<name>/schedules/*` | scheduled triggers (if any) | cron |
| `install.md` | — | runbook: `eve dev`, `vercel deploy`, channel wiring |

Package shape mirrors host-opencode (`packages/host-eve/{package.json,tsconfig.json,LICENSE,README.md,src/index.ts,__tests__/index.test.ts}`), additive to the `HOSTS` catalog (9 → 10) and the multi-host test loop.

### 2. Default-deny + approval composition (the safety posture wins)

MetaHarness's default-deny MCP posture (ADR-022) is not weakened by Eve's convenience:

- The adapter copies `mcp-policy.json` deny rules **verbatim** into each `connections/` file, so the harness's posture wins via Eve's own enforcement (same rule as the opencode adapter, ADR-036).
- Every tool the policy classes high-risk (writes, shell, network egress, money movement) is emitted with **`needsApproval: true`** — the human-in-the-loop gate becomes a *generated default*, not a thing teams remember to add.
- Eve already hides credentials/URLs from the model; this composes with the witness model (ADR-011) — the manifest attests the connection set, not the secrets.

### 3. Close the Darwin Mode loop with Eve evals + traces

This is the highest-value part. Darwin Mode (ADR-070…082) needs an evaluator and a trace substrate; Eve provides production-grade versions of both:

- **Eve evals → ADR-076 benchmark tasks.** An Eve eval file (prompt + tool-call assertions + output checks) is a `BenchmarkTask` in production clothing. `bench create` (ADR-076) can import an agent's `evals/` directory as a hash-pinned suite; the five gates and statistical promotion run unchanged.
- **Eve OpenTelemetry traces → the scoring/replay substrate.** Each run's spans (model + tool calls) are the trace quality + cost + latency signal the scorer reads, and the durable checkpoints give a literal **replay** for the Repro gate (ADR-076) and witness provenance (ADR-011).
- **Eve sandbox + `needsApproval` → the runtime analogue of the ADR-071 boundary.** Evolution proposes harness changes offline behind the allowlist; Eve enforces the same posture at run time (isolated sandbox, approval pauses). The model proposes, the harness decides, the algorithms verify — now in production.

So the full pipeline becomes: **MetaHarness generates → Darwin Mode evolves (offline, gated) → Eve runs in production → Eve evals + traces feed the next evolution.** ruVector (ADR-074) stores the cross-run memory; RuFlo orchestrates.

### What stays out of scope (for this ADR)

Implementing Eve's durable-execution runtime ourselves is **not** proposed — we target Eve's Workflow SDK as a dependency of the *generated* agent, not as a kernel feature. The kernel stays host-agnostic (ADR-002); durability is an Eve-host concern.

## Consequences

### What gets easier
- A clean production-runtime story: the generator/evolver finally has a first-class deploy target with durability, approvals, channels, and tracing — without MetaHarness building any of it.
- The Darwin Mode evaluation loop gains a **production** evaluator (Eve evals) and **replayable** traces, closing the gap between "benchmark in a sandbox" and "evaluated in production."
- `needsApproval` gives MetaHarness a real human-in-the-loop primitive it lacked, generated by default for high-risk tools.

### What gets harder
- Eve is a *directory tree* emitter, not a one-file config — the adapter is larger than the opencode/copilot adapters (more files, a `tools/` codegen path with Zod). Bounded, but not ~100 LoC.
- Vendor coupling: Eve's production runtime is Vercel-centric (Vercel Sandbox, Cron, Connect). The adapter emits a portable directory, but the *production* primitives assume Vercel unless custom adapters are supplied. We document this; the generated agent runs locally (Docker/bash) regardless.
- Schema drift: Eve is new (2026); `defineAgent`/`defineTool` signatures may move. Mitigated by pinning a snapshot + a `harness diag --eve-version-check` flag (same pattern as ADR-036).

### What does not change
- The kernel stays host-agnostic (ADR-002); Eve is an additive host, not a kernel dependency.
- Default-deny MCP (ADR-022) and the witness model (ADR-011) are the floor; Eve composes with them, it does not replace them.

## Alternatives Considered

1. **Adopt Eve's conventions as MetaHarness's *own* canonical layout (replace the generator's scaffold).** Rejected — MetaHarness is deliberately multi-host (ADR-004); making one vendor's directory shape canonical would couple the generator to Eve/Vercel. Eve is a *target*, not the spec.
2. **Build our own durable-execution + approvals runtime in the kernel.** Rejected — large, and it re-implements what Eve (and the Workflow SDK) already ship; the kernel-boundary ADR (ADR-002) says runtime infra that a host provides stays out of the kernel.
3. **Treat Eve `channels` as new "hosts."** Rejected — channels are a *runtime interface* axis (Slack/HTTP for one running agent), orthogonal to hosts (which agentic platform runs the harness). Conflating them breaks the ADR-004 model. Channels are emitted *within* the Eve host, not as separate hosts.
4. **Skip the Darwin-loop integration; ship only the host adapter.** Rejected as under-selling — the evals+traces→evolution loop is the differentiated value; the host adapter alone is a commodity emitter.

## Test Contract

| # | File | Assertion |
|---|---|---|
| 1 | `packages/host-eve/__tests__/index.test.ts` | `generateConfig(spec)` emits `eve/<name>/agent.ts` + `instructions.md` for a minimal spec |
| 2 | same | each gated tool emits a `tools/<tool>.ts` with a `defineTool()` + Zod schema; high-risk tools carry `needsApproval: true` |
| 3 | same | `mcp-policy.json` deny rules appear verbatim in the emitted `connections/*` |
| 4 | same | byte-determinism: same spec twice → identical tree (witness-stable, ADR-011) |
| 5 | same | credentials/URLs never appear in `agent.ts`/`tools/` (secret-isolation invariant) |
| 6 | `__tests__/integration/multi-host.test.ts` | the cross-host scaffold loop includes `eve` automatically (9 → 10 hosts) |
| 7 | `packages/darwin-mode` (ADR-076) | an Eve `evals/` directory imports into a hash-pinned `BenchSuite` and runs the five gates unchanged |
| 8 | CI smoke | `--host eve` scaffolds and `harness doctor` passes; (where feasible) `eve dev` boots the emitted agent |

## References

- [Introducing Eve — Vercel](https://vercel.com/blog/introducing-eve) — the source approach (2026).
- In-repo: [ADR-004 host integration model](./ADR-004-host-integration-model.md), [ADR-022 MCP primitive](./ADR-022-mcp-primitive.md), [ADR-011 witness](./ADR-011-witness-and-provenance.md), [ADR-006 memory](./ADR-006-memory-and-learning-integration.md), [ADR-036 host-opencode](./ADR-036-host-opencode.md) (the host-adapter template), [ADR-076 benchmark](./ADR-076-darwin-parent-vs-child-benchmark.md), [ADR-070 Darwin Mode](./ADR-070-darwin-mode-self-improving-harness.md).
