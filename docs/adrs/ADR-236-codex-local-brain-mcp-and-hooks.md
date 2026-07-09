# ADR-236: Codex local brain MCP and hook integration

- **Status**: Accepted — local Codex MCP integration shipped; hook activation + bridge hardening tracked as follow-up
- **Date**: 2026-07-08
- **Deciders**: ruv
- **Tags**: codex, mcp, brain, ruvultra, memory, hooks, self-learning, local-runtime
- **Extends**: ADR-006, ADR-022, ADR-074, ADR-161, ADR-169, ADR-202, ADR-234
- **Prompted by**: integrating the ruflo/ruvultra self-learning brain capability into Codex as MCP and hooks, without pretending an MCP memory server or a generated-harness MCP entrypoint exists where it does not.

---

## 1. Context

The current workspace has three separate but related surfaces:

1. **MetaHarness generated harnesses** already know how to describe MCP servers, skills, host configs, and default-deny policy, but this checkout does not currently ship a working stdio entrypoint named `mcp-serve` for `metaharness` itself. Wiring the documented example command into Codex would register a broken server.
2. **`ruvultra-mcp`** is a real local stdio MCP server. It exposes machine inventory plus the local brain/self-learning surface: `ruv_brain_health`, `ruv_brain_info`, memory list/get/write, preference-pair list/write, checkpoint, RVF inspect/validate, vector search, index stats, training stats, and pair export. Mutations are explicitly gated by `--enable-mutations`.
3. **`meta-llm/integrations/mcp-dev-bridge`** is a real MCP bridge, but it correctly refuses to start unless `COGNITUM_DEV_KEY` is present in the Codex process environment. Registering it without that key makes Codex launch a failing MCP server.

Codex also has a local plugin system with `.codex-plugin/plugin.json`, `.mcp.json`, skills, and cached plugin installation. Cached curated plugins may carry `hooks.json`, but the local plugin validator currently rejects a manifest-level `hooks` field. Therefore hook files can be packaged as local assets, but they cannot be claimed as first-class active Codex plugin hooks until the accepted manifest schema supports them.

## 2. Decision

Use **`ruvultra-mcp` as the Codex brain MCP**, not a new MCP memory server. The active local Codex config registers:

```toml
[mcp_servers.ruvultra-brain]
command = "/home/ruvultra/projects/ruvultra-mcp/target/release/ruvultra-mcp"
args = ["--enable-mutations"]
```

This makes the local brain available to Codex through MCP while keeping memory writes and checkpoints explicit tool calls. It also avoids inventing a second storage model: the MCP server delegates to the local brain service and RVF/vector backend already present on the machine.

Create a personal Codex plugin, **`metaharness-brain@personal`**, with:

- `.mcp.json` registering `ruvultra-brain`;
- a `metaharness-brain` skill describing which read-only brain tools to prefer and which mutation tools require explicit user intent;
- a packaged post-write safety hook script that checks diffs for conflict markers and common secret patterns.

Do **not** register `metallm-dev-bridge` by default until `COGNITUM_DEV_KEY` is available to the Codex process. The bridge is real, but a missing env key is a startup failure, not a harmless disabled state.

Do **not** register a `metaharness mcp-serve` server until the repo ships and tests a real stdio MCP server entrypoint. Existing harness CLI commands and Codex skills remain the supported path for MetaHarness authoring operations.

## 3. Verification

The local integration was verified on 2026-07-08:

- `ruvultra-mcp` built with `cargo build --release`;
- stdio MCP `initialize` and `tools/list` succeeded;
- `tools/call ruv_brain_health` returned a healthy local sqlite-backed brain response;
- the personal plugin passed `validate_plugin.py`;
- `codex plugin add metaharness-brain@personal` installed and enabled the plugin;
- the packaged hook script ran cleanly against the current repo diff.

## 4. Consequences

- **Codex can now inspect and use the local brain** through MCP: health, info, semantic search, memory list/get/write, preference pairs, checkpoints, RVF validation, index stats, and training-pair export.
- **Self-learning writes are possible but explicit.** Running `ruvultra-mcp --enable-mutations` enables memory and checkpoint tools, so the operational rule is: read first, write only when the user asked for behavior-changing memory/checkpoint work, and summarize exactly what changed.
- **This is not an MCP memory-server product.** The brain remains the local ruvultra/ruvector service surface; MCP is the control plane into it.
- **Codex hook support is partially packaged, not fully activated.** The safety hook script and `hooks.json` exist in the plugin source/cache, but the plugin manifest cannot advertise `hooks` under the current validator. First-class activation needs a schema-supported hook installation path.
- **The meta-llm bridge stays credential-gated.** Once `COGNITUM_DEV_KEY` is exported into the Codex environment, the bridge can be registered with `COGNITUM_GATEWAY_URL`, sandbox root, and timeout bounds.
- **The generator still needs a real MCP serving entrypoint.** The docs/example mention `mcp-serve`, but the package currently exposes `metaharness` and `harness` bins and harness CLI `mcp` subcommands, not a long-lived stdio server for Codex to mount.

## 5. Follow-up issue scope

Track the remaining productionization as one issue:

1. Add a tested `metaharness mcp-serve` or equivalent stdio MCP server for the generator's own authoring tools.
2. Decide the supported Codex hook activation path and either make `hooks.json` schema-valid or install hooks through the documented plugin runtime path.
3. Add a Secret Manager or shell-wrapper path that exports `COGNITUM_DEV_KEY` into Codex before enabling `metallm-dev-bridge`.
4. Add smoke tests for the personal plugin `.mcp.json`, the brain MCP tool list, and the post-write safety hook.
5. Document the operational rule for mutation tools: explicit user intent, local-only, summarize writes, and never silently change brain behavior.
