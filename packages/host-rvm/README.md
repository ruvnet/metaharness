# @ruflo/host-rvm

[RVM](https://github.com/ruvnet/rvm) — the Agentic Virtual Machine — host adapter for the [agent-harness-generator](https://github.com/ruvnet/agent-harness-generator) project.

> Agents don't fit in VMs. They need something that understands how they think.

## What this is for

Use RVM as the **deployment target** for harnesses that need hardware-level isolation — federated / multi-tenant / untrusted-peer scenarios. The kernel's claims subsystem maps directly onto RVM's capability tokens; same security model, stronger backend.

## Files this adapter emits

| File | Purpose |
|---|---|
| `rvm-partition.toml` | Partition manifest (coherence domain seed, memory tier, scheduler signals) |
| `capability-table.json` | Capability tokens derived from the harness's kernel claims |
| `wasm-guest.json` | Reference to the kernel WASM bundle + failure-class recovery map |
| `install-rvm.sh` | Idempotent runbook: register partition → install caps → boot guest |

## Claim → capability mapping

The kernel's `Claim { capability, resource, expires_at }` maps onto RVM's 7-right capability tokens:

| Kernel claim capability | RVM rights |
|---|---|
| `*` or `*.*` | all 7 rights (READ/WRITE/GRANT/REVOKE/EXECUTE/PROVE/GRANT_ONCE) |
| `*.read` | READ |
| `*.write` | WRITE |
| `*.execute` or `tool.invoke.*` | EXECUTE |
| `*.grant` / `*.revoke` / `*.prove` | GRANT / REVOKE / PROVE |
| `*.grant_once` | GRANT_ONCE + `grant_once: true` |
| `memory.*`, `tool.*`, etc. (prefix) | READ / WRITE / EXECUTE |
| anything else | READ |

Default proof tier:

- **P3** (strongest) for grant / revoke / prove
- **P2** for write + execute
- **P1** (cheapest) for read

## Usage

```js
import adapter, { buildCapabilityTable, partitionToml } from '@ruflo/host-rvm';

const config = adapter.generateConfig({
  name: 'my-bot',
  description: 'My harness on RVM',
  mcpServers: [{ name: 'my-bot', command: ['npx', '-y', 'my-bot', 'mcp'] }],
});

// Convert kernel claims explicitly:
const caps = buildCapabilityTable([
  { capability: 'memory.read', resource: 'ns/x', expires_at: 1_700_000_000 + 86400 },
  { capability: 'tool.invoke.memory.store', expires_at: 1_700_000_000 + 86400 },
]);
```

## Tier picture vs other host adapters

| | Isolation | Tier |
|---|---|---|
| claude-code / codex / pi-dev / hermes / openclaw | OS-level | Local-dev / personal use |
| **rvm** | **Hardware (microhypervisor + capability tokens + hash-chained witness)** | **Multi-tenant / untrusted peers** |

For everyday local-dev, use the OS-level adapters. For federation across trust boundaries, RVM is the natural backend.

## Pairs with @ruvector/rvf (recommended)

[`@ruvector/rvf`](https://www.npmjs.com/package/@ruvector/rvf) — RuVector Format, a unified TypeScript SDK for vector intelligence with HNSW + SIMD — is the recommended vector-storage companion for RVM-deployed harnesses. The pairing gives you:

- **Hardware-isolated vector storage** — the RVF index lives inside the RVM partition, gated by the same capability tokens
- **WASM addon** (`@ruvector/rvf-wasm`) — runs as a sub-guest under the RVM partition, so vector ops benefit from RVM's witness-native syscalls
- **Binary format with HNSW** — the same on-disk format works in Node, the browser, and inside an RVM partition

The adapter declares this pairing in the emitted `wasm-guest.json`:

```json
{
  "companion": {
    "vector_format": {
      "package": "@ruvector/rvf",
      "version": "^0.2.0",
      "wasm_addon": "@ruvector/rvf-wasm",
      "recommended": true
    }
  }
}
```

RVF is opt-in — the partition still boots without it. Use `@ruflo/kernel/memory-rvf` to plug it into the kernel memory subsystem.

## RVM facts

- Bare-metal microhypervisor for AArch64
- Rust 95-99% (~500 LoC assembly); forbids unsafe in most subsystems
- Dynamic coherence domains (graph-mincut on agent comms)
- Witness-native syscalls — every privileged op = 64-byte SHA-256 hash-chained record
- WASM guest runtime (where our kernel boots as a guest)
- F1–F4 failure-class graduated rollback
- License: Apache-2.0 OR MIT
- Latest release: v1.5.0 (April 2026)

## License

MIT
