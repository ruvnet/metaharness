# unknown-thing-not-a-verb

My AI agent harness

## Behavioral rules

- Use the harness's MCP tools (`mcp__unknown-thing-not-a-verb__*`) for orchestration
- Memory and routing are handled by the kernel — you don't need to learn them
- Defer destructive operations to the user

## Commands

After `unknown-thing-not-a-verb init`, the following are available:

| Command | What it does |
|---|---|
| `unknown-thing-not-a-verb doctor` | Health check the install |
| `unknown-thing-not-a-verb memory search <query>` | Semantic search across stored patterns |
| `unknown-thing-not-a-verb route <task>` | Get the routing tier recommendation |

## Architecture

This harness uses [@ruflo/kernel](https://www.npmjs.com/package/@ruflo/kernel) for its primitives. The kernel is a Rust-compiled WASM module with a NAPI-RS native fallback — same code runs identically on every platform.
