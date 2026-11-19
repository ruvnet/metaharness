# ADR-004: Host Integration Model

**Status**: Proposed
**Date**: 2026-06-13
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-002 (Kernel boundary), ADR-003 (Generator architecture)

## Context

A generated harness must run in any host the user picks. Today the user prompt names four: Claude Code, OpenAI Codex CLI, pi.dev, and Hermes / hermes-agent. The four differ in fundamental ways — what an "MCP server" means to each, where configuration lives, what hooks fire, what model-routing knob exists.

If we let each host's idiosyncrasies bleed into the kernel, the kernel cannot stay small. If we let each host's idiosyncrasies bleed into the templates, the template tree explodes combinatorially. The right answer is an **adapter layer**: each host is a small, separately-versioned package that implements a common contract. The kernel ships the contract; the adapter ships the implementation; the template overlays (per ADR-003) wire the adapter in.

This ADR pins down the contract.

## Decision

### The host-adapter contract

`@metaharness/kernel/hosts` exports a base class and an interface:

```ts
// Simplified for the ADR. Full schema in @metaharness/kernel/hosts/contract.ts.
export interface HostAdapter {
  // Identity
  readonly hostId: 'claude-code' | 'codex' | 'pi-dev' | 'hermes' | string;
  readonly capabilities: HostCapabilities;

  // Configuration
  generateConfig(harness: HarnessConfig): HostConfigFiles;
  // Returns the files the host needs in the harness tree (e.g. .claude/settings.json
  // for Claude Code, .codex/config.toml for Codex). The generator (ADR-003) writes them.

  // Registration
  registerMcp(server: McpServerEntry): RegistrationInstructions;
  // Tells the user (and CI) how to register the MCP server with this host. Some hosts
  // expect a CLI subcommand (claude mcp add), others expect a config file mutation.

  // Hook bridging
  bridgeHooks(hooks: HookRegistry): HostHookFiles | null;
  // Translates the kernel's hooks into the host's hook convention, if any. Returns
  // null if the host has no hook system (in which case the kernel runs hooks itself
  // out-of-band, see "Fallback: kernel-side hooks" below).

  // Model invocation
  invokeModel(req: ModelRequest): Promise<ModelResponse>;
  // The kernel's 3-tier router decides which tier; the host adapter actually calls
  // the model in whatever the host's provider conventions are.

  // Output post-processing
  postProcessAgentOutput(text: string): string;
  // Host-specific cleanup (e.g. Hermes's <think>...</think> scrubbing, the
  // scrubReasoningBlocks function we already ship).

  // Smoke contract
  smokeTest(harness: HarnessConfig): Promise<SmokeResult>;
  // Asserts that, in this host, the harness can spawn one agent that lists tools.
  // Run as part of the generator's post-generation smoke check (ADR-003 §Smoke).
}
```

`HostCapabilities` is a discriminated record:

```ts
interface HostCapabilities {
  supportsMcp: 'stdio' | 'http' | 'both' | 'none';
  supportsHooks: 'native' | 'kernel-side-only';
  supportsThinkingBlocks: boolean;  // emits <think>...</think>?
  supportsBackgroundAgents: boolean;
  supportsToolCallApi: 'native' | 'mcp-bridged' | 'function-calling';
  defaultProviderModels: { tier1?: string; tier2: string; tier3: string };
  configFileFormat: 'json' | 'toml' | 'yaml';
  configFileLocation: string;  // e.g. ".claude/settings.json", "~/.codex/config.toml"
  hostInstructionsFile: string;  // e.g. "CLAUDE.md", "AGENTS.md", "HERMES.md"
}
```

The capabilities object is the kernel's window into what the host can do. The generator (ADR-003 composer) uses it to grey out features the host does not support (a host with `supportsBackgroundAgents: false` cannot offer the federation feature, for example).

### Adapter packages

| Adapter | Package | Version | Notes |
|---|---|---|---|
| Claude Code | `@metaharness/host-claude-code` | tracks `claude-code` CLI minor versions | Reference adapter. The implementation today is essentially the ruflo `init/` directory factored out. |
| Codex | `@metaharness/host-codex` | tracks `@openai/codex` minor versions | Builds on the existing `@claude-flow/codex` package. |
| pi.dev (badlogic Pi) | `@metaharness/host-pi-dev` | tracks Pi `packages/coding-agent` minor versions | Ships as a Pi extension (TypeScript module), bypassing MCP per Pi's design. See §pi.dev below. |
| Hermes / hermes-agent | `@metaharness/host-hermes` | tracks the NousResearch/Hermes-Function-Calling repo | Smaller integration; mostly tool-call + thinking-block conventions. |

Each adapter is an npm package, peer-dep on `@metaharness/kernel`, versioned independently. A generated harness installs only the adapters its user picked, keeping install size proportional to choice.

### Per-host integration details

#### Claude Code (`@metaharness/host-claude-code`)

This is the reference adapter. It is the integration surface ruflo ships today, generalised. Details verified against the canonical Claude Code documentation (note: `docs.claude.com/en/docs/claude-code/...` URLs 301-redirect to the canonical `code.claude.com/docs/en/...` paths).

- **MCP registration.** `claude mcp add <name> -- <command> <args...>` (the CLI form) and writing `.mcp.json` directly. The adapter generates both, so users can `claude mcp add` themselves or commit `.mcp.json` for repo-shared config. Reference: https://code.claude.com/docs/en/mcp.
- **Settings scopes.** Three layered settings files Claude Code reads:
  - `~/.claude/settings.json` (user / global)
  - `.claude/settings.json` (project, committed)
  - `.claude/settings.local.json` (project, gitignored)
  The adapter writes only the project-scope `.claude/settings.json` by default; users wire global preferences themselves.
- **Hooks.** The harness ships a plugin-supplied `hooks/hooks.json`. Reference: https://code.claude.com/docs/en/hooks.
  - **Three-level shape:** `event → matcher → handler[]`.
  - **Five handler types:** `command`, `http`, `mcp_tool`, `prompt`, `agent`.
  - **Events (corrected 2026-11-14 — see note below):** `SessionStart`, `Setup`, `UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Notification`, `MessageDisplay`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `StopFailure`, `TeammateIdle`, `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `Elicitation`, `ElicitationResult`, `SessionEnd` (33 total).
  - **Matchers** use a pseudo-DSL — e.g. `"Bash(rm *)"` to match a `Bash` tool call invoking `rm`. The adapter generates matchers from harness-config rules.
  - **Hook output to influence the model:** hooks emit JSON on stdout. Recognised fields include `hookSpecificOutput.permissionDecision` (`"deny" | "allow" | "ask" | "defer"`), `additionalContext` (string the model sees), and `updatedInput` (rewrites the tool input before the call proceeds).
- **Skills.** Writes `.claude/skills/<id>/SKILL.md` for each selected skill. Skill discovery is automatic in Claude Code.
- **Commands.** Writes `.claude/commands/<id>.md` (the slash-command convention ruflo already uses; see `plugins/ruflo-core/commands/witness.md`).
- **Agents.** Writes `.claude/agents/<id>.md` (Claude Code's subagent convention; see the `Task` tool's `subagent_type` parameter).
- **Host instructions file.** `CLAUDE.md` at the harness root.
- **Thinking blocks.** Claude Code surfaces extended-thinking output but does not require scrubbing in tool calls — Anthropic's SDK handles cache-control of thinking blocks. The post-processor is a no-op.
- **Model invocation.** Delegates to the Anthropic SDK (`@anthropic-ai/sdk`). The harness's `ANTHROPIC_API_KEY` env var is read. Default tier-2 model: `claude-haiku-4-5`. Default tier-3 model: `claude-sonnet-4-7` or `claude-opus-4-7` (per the routing rule in the kernel).
- **Capabilities**: `supportsMcp: 'both'`, `supportsHooks: 'native'`, `supportsThinkingBlocks: true`, `supportsBackgroundAgents: true`, `supportsToolCallApi: 'native'`, `configFileFormat: 'json'`, `configFileLocation: '.claude/settings.json'`.

References:
- MCP — https://code.claude.com/docs/en/mcp
- Hooks — https://code.claude.com/docs/en/hooks

#### Codex (`@metaharness/host-codex`)

Codex is OpenAI's open-source CLI agent (`@openai/codex` on npm; repo: https://github.com/openai/codex). It supports MCP, with a **TOML** config file at `~/.codex/config.toml` (or `.codex/config.toml` at the project root — see the trusted-project quirk below).

- **MCP registration.** Codex's config is **TOML, not JSON.** The adapter writes `~/.codex/config.toml` mutations (additive; respects existing config). For repo-shared config, it writes a `.codex/config.toml` at the harness root that Codex picks up only if the project is marked as trusted (see quirk below). MCP servers are declared as `[mcp_servers.<name>]` TOML tables, NOT as `[[mcp_servers]]` arrays:

  ```toml
  [mcp_servers.acme-support]
  command = "npx"
  args = ["-y", "@acme/acme-support", "mcp", "start"]

  [mcp_servers.acme-support.env]
  ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"
  ```

  For Streamable HTTP MCP servers, the entry uses `url` and `bearer_token_env_var` instead of `command` / `args`. Example from the docs (https://developers.openai.com/codex/mcp):

  ```toml
  [mcp_servers.tooluniverse]
  command = "uvx"
  args = ["--refresh", "tooluniverse"]
  ```

  The Windows cross-platform wrap from ruflo `init/mcp-generator.ts` is preserved by the adapter.

  Programmatic API (the CLI equivalent the adapter can also emit for users who prefer it): `codex mcp add <server-name> --env K=V -- <stdio-cmd>`.

- **Three quirks vs Claude Code (the harness ships scaffolding that handles all three):**

  1. **TOML, not JSON.** The adapter ships a TOML writer; the renamer (ADR-003) handles TOML through a TOML-aware parser, not string substitution.

  2. **"Trusted project" gate.** Project-scoped `.codex/config.toml` is only honored when the user has marked the project as trusted via the Codex UI. This is a documented footgun — see https://github.com/openai/codex/issues/3441 ("Codex does not use MCP servers defined in config.toml"). The adapter's setup output prints a one-liner reminder to trust the project after generation.

  3. **No first-class hooks system.** Codex has no analog to Claude Code's `PreToolUse` / `PostToolUse` / etc. lifecycle hooks. Harness lifecycle events are approximated through MCP tool calls (the harness's MCP server exposes lifecycle hooks as tools the agent calls explicitly) or out-of-band (the harness's `bin/` wrapper fires kernel-side hooks before and after Codex itself runs). The kernel-side fallback (below) is mandatory under Codex.

- **Host instructions file.** `AGENTS.md` at the harness root. Codex reads this similarly to how Claude Code reads `CLAUDE.md` (per the Agentics Foundation standard the ruflo `@claude-flow/codex` README cites).
- **Skills.** Codex does not have a "skills" concept. Skills are exposed as MCP tools instead — each skill the harness ships becomes an MCP tool the harness's MCP server registers, and the agent can call it like any other tool.
- **Commands.** Likewise; commands become MCP tools.
- **Agents.** Codex spawns its own agents per its CLI conventions. The harness ships agent definitions in a Codex-friendly format that mirrors Claude Code's subagent spec (a `.codex/agents/<id>.md` directory mirroring `.claude/agents/`).
- **Thinking blocks.** Codex's underlying model is OpenAI; thinking blocks are returned via the Responses API's `reasoning` field rather than inline `<think>` tags. The post-processor strips reasoning blocks per OpenAI's response format. No `scrubReasoningBlocks` regex is needed for Codex output.
- **Model invocation.** Delegates to the OpenAI SDK. Reads `OPENAI_API_KEY`. Default tier-2: `gpt-5-mini` (or whatever the cheap tier is at v1.0); tier-3: `gpt-5` / `o-series` reasoning models. The exact mapping is configured in the adapter's `defaultProviderModels`.
- **Capabilities**: `supportsMcp: 'stdio' | 'http'` (Codex supports both via the same `[mcp_servers.*]` schema), `supportsHooks: 'kernel-side-only'` (no native hook system), `supportsThinkingBlocks: false` (out-of-band reasoning channel), `supportsToolCallApi: 'native'`, `configFileFormat: 'toml'`, `configFileLocation: '.codex/config.toml'` or `~/.codex/config.toml`.

The ruflo `@claude-flow/codex` package (see `v3/@claude-flow/codex/README.md`) already implements much of this. The adapter for `agent-harness-generator` factors that code out into `@metaharness/host-codex`.

References:
- Codex config (TOML basics) — https://developers.openai.com/codex/config-basic
- Codex MCP — https://developers.openai.com/codex/mcp
- Repo — https://github.com/openai/codex
- Trusted-project footgun — https://github.com/openai/codex/issues/3441

#### pi.dev (`@metaharness/host-pi-dev`)

**Clarification:** "pi.dev" here means the **badlogic / earendil-works "Pi coding agent"** — a minimal CLI agent harness. It is NOT Inflection's Pi.ai consumer chatbot.

- **Landing page:** https://pi.dev/
- **Source:** https://github.com/badlogic/pi-mono — the harness lives at `packages/coding-agent` in that monorepo.
- **Config locations.** `~/.pi/agent/` (global) and `.pi/` (project).
- **Instructions files.** `AGENTS.md` (agent instructions) and `SYSTEM.md` (system prompt) at the harness root. The adapter writes both.
- **Trust store.** `~/.pi/agent/trust.json` — Pi's allow-list of trusted commands and tools.
- **Extensions.** Pi extensions are **TypeScript modules**, installed via:
  - `pi install npm:@foo/pi-tools` (from npm)
  - `pi install git:github.com/owner/repo` (from git)
  Extensions register tools via `pi.registerTool({...})` and slash-commands via `pi.registerCommand(...)`.
- **No MCP — by design.** Pi's README has an explicit "What we didn't build" section: *"No MCP. Build CLI tools with READMEs (see Skills), or build an extension that adds MCP support."* The Pi project considered MCP and deliberately rejected it for the in-process extension model.

  An out-of-tree MCP shim exists (https://github.com/nicobailon/pi-mcp-adapter) with the documented rationale that a single MCP server can burn 10,000+ tokens of context window — Pi's tool-via-extension model avoids that cost. We do not require the shim; for the harness generator we ship the Pi adapter as a Pi extension instead.

- **Adapter shape.** `@metaharness/host-pi-dev` ships as a **Pi extension (TypeScript module)**, not as an MCP server.
  - The harness's tool catalogue is exposed via `pi.registerTool({...})` calls inside the extension.
  - The harness's slash commands are exposed via `pi.registerCommand(...)`.
  - The wasm kernel is still loaded — for memory, routing, intelligence, and the marketplace client. Only the MCP transport layer is bypassed.
  - This means: under Pi, the kernel's `mcp` subsystem is dormant (the harness's MCP server still exists for other hosts in a multi-host harness, but Pi's session does not bind to it).
- **Hooks.** Kernel-side only — Pi has no built-in lifecycle hook system comparable to Claude Code's events. The harness's `bin/` wrapper fires kernel-side hooks before and after the Pi session.
- **Model invocation.** Pi delegates to its own provider routing (see Pi's docs); the harness reads the same env vars Pi expects (e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) and lets Pi pick.
- **Smoke test.** The smoke spins up Pi with the harness extension loaded, asserts `pi /help` lists the harness's commands and that one tool round-trips.
- **Capabilities**: `supportsMcp: 'none'` (deliberately — Pi-via-extension bypasses MCP), `supportsHooks: 'kernel-side-only'`, `supportsThinkingBlocks: false`, `supportsToolCallApi: 'function-calling'` (Pi exposes tools via its extension API, not via the MCP protocol), `configFileFormat: 'json'`, `configFileLocation: '.pi/' (project) or '~/.pi/agent/' (global)`.

References:
- Pi landing — https://pi.dev/
- Source — https://github.com/badlogic/pi-mono
- Optional MCP shim (third-party) — https://github.com/nicobailon/pi-mcp-adapter

#### Hermes / hermes-agent (`@metaharness/host-hermes`)

Hermes is Nous Research's instruction-tuned model series (Hermes-3, Hermes-4, etc.). Two distinct Nous Research projects use the "Hermes" name; the adapter targets both, and reviewers should not conflate them:

1. **`NousResearch/Hermes-Function-Calling`** (https://github.com/NousResearch/Hermes-Function-Calling) — the OLDER function-calling reference for Hermes 2 / 3. Parses ChatML-style `<tool_call>{"name":...,"arguments":{...}}</tool_call>` tags. No `<think>` block handling documented.
2. **`NousResearch/hermes-agent`** (https://github.com/NousResearch/hermes-agent) — the CURRENT (v0.2+) long-running agent runtime. Persistent memory, scheduled automations, and **explicit MCP support** (`optional-mcps/` directory, `mcp_serve.py`). Docs: https://hermes-agent.nousresearch.com/docs/. Install: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`. Config: `hermes config set` and `cli-config.yaml`.

Ruflo already references two hermes-agent patterns in production code:

- The `scrubReasoningBlocks` function at `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts` strips `<think>...</think>`, `<thinking>...</thinking>`, and `<reasoning>...</reasoning>` blocks. The comment block immediately above the function references hermes-agent's behaviour and the contamination of DISTILL embeddings.
- The tool-loop circuit breaker at `v3/@claude-flow/cli/src/mcp-tools/tool-loop-guardrail.ts` cites the "hermes-agent tool_guardrails pattern" — it detects a Hermes-style agent that has gotten stuck repeating a failing tool call.

The Hermes adapter:

- **Two integration modes** (the adapter picks based on which runtime the harness is configured for):
  - **`hermes-agent` runtime mode (preferred when available).** The harness registers as a `hermes-agent` MCP server using the runtime's `optional-mcps/` discovery (writes `~/.hermes/config/optional-mcps/<harness>.json` and updates `cli-config.yaml`). This is the current path; it gives the harness full MCP semantics.
  - **`Hermes-Function-Calling` reference mode (for older deployments).** The harness exposes its tools as a `tools.json` schema document the function-calling reference loads at session start. ChatML `<tool_call>...</tool_call>` parsing is wired by the kernel's function-calling bridge.
- **Hooks.** Kernel-side only in both modes. `hermes-agent` does not expose Claude-Code-style lifecycle hooks; the kernel wraps session start/end.
- **Host instructions file.** `HERMES.md` at the harness root.
- **Thinking blocks — MANDATORY scrubbing.** Hermes-4 (e.g. https://huggingface.co/NousResearch/Hermes-4-14B) emits `<think>...</think>` reasoning blocks AND occasionally raw `<tool_call>` text on the assistant content channel instead of using the OpenAI-compatible function-calling channel. This is a documented behavior — see https://github.com/NousResearch/hermes-agent/issues/741. The adapter's `postProcessAgentOutput` MUST call `scrubReasoningBlocks` to strip both `<think>...</think>` and stray `<tool_call>` text from the assistant content before it reaches the user, memory bridge, or trajectory tracker. This is exactly the pattern ruflo's `scrubReasoningBlocks` in `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts` already implements; the kernel exports it from `@metaharness/kernel/hosts/util/scrub-reasoning-blocks`. **Failing to scrub these blocks contaminates DISTILL embeddings, breaks trajectory replay, and leaks reasoning content into user-visible output.** This is the single load-bearing reason Hermes has its own first-class adapter rather than reusing the OpenAI-compatible Codex adapter — getting the scrubbing right at every output boundary is otherwise an everywhere-fix.
- **Tool-loop guardrail.** The adapter wires the kernel's tool-loop circuit breaker (the `tool-loop-guardrail.ts` code) by default. Without it, Hermes agents are noticeably more prone to repeating-call loops.
- **Model invocation.** Hermes is typically served via a local inference server (TGI, vLLM, llama.cpp) or Together AI. The adapter reads `HERMES_API_BASE` and `HERMES_API_KEY` env vars and posts OpenAI-compatible completion requests.
- **Capabilities**: `supportsMcp: 'stdio'` for the `hermes-agent` runtime mode, `'none'` (function-calling translation is kernel-side) for the reference mode; `supportsHooks: 'kernel-side-only'`; `supportsThinkingBlocks: true` (and the post-processor is mandatory); `supportsToolCallApi: 'function-calling'` for the reference mode, `'native'` for the runtime mode.

References:
- `NousResearch/Hermes-Function-Calling` (older reference) — https://github.com/NousResearch/Hermes-Function-Calling
- `NousResearch/hermes-agent` (current runtime, v0.2+) — https://github.com/NousResearch/hermes-agent
- hermes-agent docs — https://hermes-agent.nousresearch.com/docs/
- The think-block + raw `<tool_call>` quirk — https://github.com/NousResearch/hermes-agent/issues/741
- Hermes-4 model card (example of a model that emits `<think>` blocks) — https://huggingface.co/NousResearch/Hermes-4-14B

### Fallback: kernel-side hooks for hosts without a native hook system

When a host's `supportsHooks` is `'kernel-side-only'`, the kernel runs the hooks itself rather than relying on the host. Concretely:

- The harness's `bin/<name>.mjs` entry point wraps the host's CLI invocation.
- Before the host process starts, the kernel fires `session-start` and `pre-task` hooks.
- The host's tool calls are proxied through the kernel's MCP layer (for hosts that speak MCP) or function-call bridge (for hosts that don't). Each tool call fires `pre-command` and `post-command` hooks.
- After the host process exits, the kernel fires `session-end` and `post-task`.

This is more invasive than letting the host fire hooks natively. The advantage is uniform behaviour: a harness that runs on both Claude Code (native hooks) and Codex (kernel-side hooks for most events) sees the same hook ordering and the same learning signal. The disadvantage is the wrapper introduces latency. The kernel exposes `hooks.bypass = true` to skip hooks entirely for low-latency cases.

### Multi-host harnesses

A harness can declare multiple hosts. The composer (ADR-003) supports this; the manifest enumerates them; the generated tree contains the union of each host's overlay files. At install time the user runs `npm install` once; at runtime they pick which host to launch by running the harness's `bin` under the host they want (e.g. `claude` for Claude Code, `codex exec` for Codex).

Three constraints across multi-host harnesses:

1. **The harness's MCP server is the same in every host.** It is one entry in `package.json` `bin`, one stdio handler. The hosts differ in how they discover it, not in what it is.
2. **The harness's tool catalogue must be implementable in every selected host's capability set.** If a tool requires `supportsBackgroundAgents` and one of the selected hosts is `false` for that, the composer warns. The user can either drop the tool or drop the host.
3. **Shared memory persists across hosts.** A harness invocation from Claude Code and a later invocation from Codex hit the same AgentDB / HNSW indices. The user gets continuity across hosts. This is the load-bearing reason for "shared memory" being a kernel concern, not a host one.

## Consequences

### What gets easier

- **A new host is a new package.** Adding a fifth host (say, Google's Gemini CLI when it eventually ships an MCP equivalent) is a `@metaharness/host-gemini-cli` package, not a kernel change.
- **Host churn is contained.** Codex ships a release that changes its config TOML schema; only `@metaharness/host-codex` needs to update.
- **The adapter contract is testable.** Each adapter passes the same contract test suite (ADR-010 §Contract tests), so we can prove they behave equivalently for all the kernel-level guarantees.

### What gets harder

- **Smoke tests multiply.** A harness with three hosts runs three smoke tests, one per host. CI minutes scale with host count. ADR-007 specifies the parallelisation.
- **Capability gating is a real UX problem.** When a feature does not work in one of the selected hosts, the composer must explain why clearly. The "greyed out" state must surface the reason.
- **Adapter version skew.** A user pins `@metaharness/kernel ^1.2.0` but `@metaharness/host-codex 0.5.0` (which was built against kernel `^1.0.0`). The adapter contract version is independent of the kernel semver. ADR-008 §Drift detection handles this; in short, each adapter declares its `peerDependencies.@metaharness/kernel` range, and `npm install` enforces it.

### What does not change

- The kernel does not know which hosts exist. It only knows the `HostAdapter` contract. New hosts do not require kernel changes.
- The harness's `package.json` `bin` entry is the same regardless of host. The hosts differ in how they invoke that bin.

## Alternatives Considered

### Alternative 1: One mega-adapter ("@metaharness/host-universal")

Ship a single adapter that detects the host at runtime and adapts. Rejected because (a) detecting the host correctly is itself a research problem (what if the user runs the harness's bin directly with no host?), (b) the union of all hosts' surface area is far larger than any one host's, so the universal adapter would be the slowest path for every user, and (c) updating to a new host version would force every harness to re-test against every host. Independent adapter packages give independent release cadences.

### Alternative 2: Host-specific kernels

Ship `@metaharness/kernel-claude-code`, `@metaharness/kernel-codex`, etc. Rejected because the kernel is then redundant across hosts (each kernel re-implements memory, hooks, routing) and the cross-host shared memory promise disappears. The shared kernel + per-host adapter is the only model that delivers cross-host continuity.

### Alternative 3: No adapter; just generate the right files for each host

The generator could write `.claude/settings.json` for Claude Code, `.codex/config.toml` for Codex, etc., with no runtime adapter package at all — purely a build-time concern. Rejected because runtime behaviour differs too: the Hermes thinking-block scrubber, the Codex hook-bridging fallback, the model-invocation provider per host. These need code, not just configuration. The adapters are where that code lives.

### Alternative 4: Adapt at the kernel boundary, not via per-host packages

Put host adapters inside `@metaharness/kernel/hosts/*`. Rejected per ADR-002 §Alternative 3 — each host moves at a different cadence, and the kernel must not absorb each host's churn.

## Test Contract

This ADR is satisfied when the following exist:

### Contract tests (per adapter)

For each of `@metaharness/host-claude-code`, `@metaharness/host-codex`, `@metaharness/host-pi-dev`, `@metaharness/host-hermes`:

1. **Capability contract** — the adapter's `capabilities` object satisfies the schema in `@metaharness/kernel/hosts/contract.ts`. Asserted via a Zod schema.
2. **`generateConfig` produces valid host config** — schema-validated against the host's actual config schema (JSON Schema for Claude Code's `settings.json`, the TOML schema we derive from Codex docs, etc.).
3. **`registerMcp` instructions are runnable** — the returned instructions can be executed in a test sandbox and result in a registered server.
4. **`postProcessAgentOutput` round-trip** — fixtures with and without thinking blocks; output matches expected scrubbed form.
5. **`smokeTest` against a stub host** — each adapter ships a stub of its host (a minimal mock CLI that speaks the host's protocol enough to satisfy the smoke contract).

### Integration tests (real hosts in CI)

6. **Claude Code real-host smoke** — CI runs the test harness against an actual `@anthropic-ai/claude-code` install. Asserts MCP server registers, one tool round-trips.
7. **Codex real-host smoke** — CI runs the test harness against an actual `@openai/codex` install. Asserts MCP server registers, one tool round-trips.
8. **Hermes integration smoke** — CI spins up a local TGI / llama.cpp with a small Hermes model (or stubs the OpenAI-compatible endpoint), asserts the function-calling round-trip works and `<think>` blocks are scrubbed.
9. **pi.dev (badlogic Pi)** — CI runs the test harness against an actual `pi-mono`-installed Pi. Asserts the harness extension loads via `pi install`, `pi /help` lists the harness's commands, one tool round-trips.

### Multi-host harness tests

10. **Cross-host memory continuity** — a harness with two adapters (Claude Code + Codex). A trajectory recorded under Claude Code is retrieved under Codex (via the shared `@metaharness/kernel/memory`). End-to-end fixture lives in `packages/test-harness/tests/cross-host/`.
11. **Capability-gating in composer** — the generator with two selected hosts disables features that one of the hosts cannot support. UI snapshot test.

**Note added 2026-11-14 (Dream Cycle, #503/#504):** the original 10-event
list above (`SessionStart`…`FileChanged`) was this ADR's 2026-06-13
research snapshot. Live-fetched the current official docs
(`https://code.claude.com/docs/en/hooks`) tonight while independently
verifying a `@metaharness/sdk` validation fix, and found the real,
current Claude Code hook surface has grown to 33 events — the original 10
are all still valid subset members (no renames among them; in particular
`PostToolUseFailure` is still correct and is a *different* event from the
newer `StopFailure`, not a rename of it), but 23 real events were missing
entirely (`SessionEnd`, `Notification`, `PreCompact`, `PostCompact`,
`PermissionRequest`, `PermissionDenied`, etc. — full list above). This
means any code that treated the original 10 as exhaustive (the
`HookDef['event']` TypeScript union and the `HOOK_EVENTS` runtime
allowlist in `packages/sdk/src/index.ts`, prior to tonight's fix) was
under-restrictive by omission, not wrong about the 10 it did list — fixed
in the same PR. Source: a single live fetch of the official docs page,
2026-11-14; re-verify before trusting this list long-term, as Claude
Code's hook surface is evidently still growing.

## References

### Ruflo internals cited

- `v3/@claude-flow/codex/README.md` — the existing Codex integration, the basis for `@metaharness/host-codex`.
- `v3/@claude-flow/cli/src/mcp-tools/hooks-tools.ts` — the `scrubReasoningBlocks` function and the `#14` comment block referencing hermes-agent's `<think>` block contamination of DISTILL.
- `v3/@claude-flow/cli/src/mcp-tools/tool-loop-guardrail.ts` — the "hermes-agent tool_guardrails pattern" the Hermes adapter wires by default.
- `v3/@claude-flow/cli/src/init/mcp-generator.ts` — the cross-platform `cmd /c` wrap used by every adapter.

### External hosts cited

- **Claude Code** — https://code.claude.com/docs/en/mcp and https://code.claude.com/docs/en/hooks (note: `docs.claude.com/en/docs/claude-code/...` URLs 301-redirect to these canonical paths).
- **OpenAI Codex CLI** — repo https://github.com/openai/codex; basic config docs https://developers.openai.com/codex/config-basic; MCP docs https://developers.openai.com/codex/mcp; trusted-project quirk https://github.com/openai/codex/issues/3441.
- **pi.dev (badlogic Pi)** — landing https://pi.dev/; source https://github.com/badlogic/pi-mono (specifically `packages/coding-agent`); optional third-party MCP shim https://github.com/nicobailon/pi-mcp-adapter. NOT to be confused with Inflection's Pi.ai consumer chatbot.
- **Hermes / hermes-agent** — older function-calling reference https://github.com/NousResearch/Hermes-Function-Calling; current runtime https://github.com/NousResearch/hermes-agent; docs https://hermes-agent.nousresearch.com/docs/; `<think>` / `<tool_call>` quirk https://github.com/NousResearch/hermes-agent/issues/741; Hermes-4 example model card https://huggingface.co/NousResearch/Hermes-4-14B.

### Ruflo ADRs cited

- ADR-002 (Kernel boundary) — the gating decision for whether adapters live inside the kernel.
