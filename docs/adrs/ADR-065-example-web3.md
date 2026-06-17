# ADR-065: example-web3 — Blockchain / web3 SDK showcase

**Status**: Proposed
**Date**: 2026-06-17
**Project**: `ruvnet/agent-harness-generator`
**Related**: ADR-051 (examples program), ADR-022 (MCP default-deny), ADR-026 (tiered routing), ADR-050 (verification-gated output)

---

## Context

Blockchain / web3 is one of the most-requested integration categories for
agent harnesses: developers want agents that can monitor wallet balances,
stream on-chain events, simulate contract interactions before broadcasting,
and reason over transaction history — without ever inadvertently sending a
real transaction or exposing a private key.

The canonical TypeScript client for the EVM ecosystem is **viem** (npm
package `viem`, current stable `2.52.x` as of June 2026, published by
the wevm org). Viem provides:

- A `PublicClient` for all read-only and simulation actions (`getBalance`,
  `getLogs`, `getBlockNumber`, `simulateContract`, `call`).
- A `WalletClient` for signing and broadcasting, constructed separately
  from private-key accounts via `privateKeyToAccount`.
- Full TypeScript inference from ABI definitions, making it the safest
  statically-typed EVM library available.
- First-class support for Sepolia (chain ID 11155111), the recommended
  Ethereum testnet for dApp development as of 2026; Hoodi (chain ID
  560048) is also included as the newer staking-focused testnet.

The alternative library **ethers.js v6** (npm package `ethers`) remains
popular and is included as a documented secondary option, but viem is
chosen as primary because its explicit `PublicClient` / `WalletClient`
split enforces the read-vs-write boundary at the type level, which is the
safest default for an agent harness.

This is a regulated-adjacent domain (financial assets) so the example
operates on a **public testnet by default**, never holds mainnet private
keys, and gates any transaction broadcast behind an explicit `--allow-send`
flag.

---

## Decision

### Chosen SDK

**Primary**: `viem` (npm: `viem`, import from `"viem"` and `"viem/chains"`)
**Documented alternative**: `ethers` v6 (npm: `ethers`, import from `"ethers"`)

Viem is chosen because its two-client model (`createPublicClient` vs
`createWalletClient`) makes it impossible to accidentally call a mutating
action from the read path, and because its ABI-typed `simulateContract`
provides a genuine dry-run of any write function before a transaction is
ever constructed.

### Headline capabilities showcased

1. **Read-chain fan-out** — parallel `getBalance` + `getLogs` + `getBlockNumber`
   across one or more addresses, materialised as structured JSON, routing
   through the cheap tier.
2. **Event stream replay** — `getLogs` with `parseAbiItem` filter for a
   well-known contract event (ERC-20 `Transfer`), formatted into a human
   summary by the frontier tier.
3. **Simulate transaction** — `simulateContract` dry-run of a write function
   on Sepolia (no gas spent, no transaction broadcast); result validated
   before being shown to the user.
4. **Guarded send** (opt-in only) — `walletClient.sendTransaction` on Sepolia
   only, available exclusively when `--allow-send` is passed and
   `WEB3_PRIVATE_KEY` is set to a testnet key.

### Agent and skill design

Three specialised agents:

| Agent | Role | Model tier |
|---|---|---|
| `chain-reader` | Fan-out read operations (`getBalance`, `getLogs`, `getBlockNumber`) in parallel; extracts raw data | Tier 2 — cheap |
| `event-analyst` | Receives raw log data; reasons about patterns, summarises in natural language | Tier 3 — frontier |
| `tx-verifier` | Runs `simulateContract` or `call` dry-run; validates request params; gates the optional send | Tier 2 for simulation, Tier 3 for final go/no-go |

One `/slash` command:

- `/web3` — accepts a subcommand (`read`, `events`, `simulate`, `send`) and
  dispatches to the appropriate agent; default subcommand is `read`.

### Routing tiers (ADR-026)

| Tier | Handler | Use cases in this example |
|---|---|---|
| 1 (WASM booster) | Agent Booster | ABI hex encoding, wei↔ether unit conversion |
| 2 (cheap — e.g. Haiku) | `chain-reader`, `tx-verifier` (simulate) | parallel read fan-out, raw JSON extraction, param validation |
| 3 (frontier — e.g. Sonnet) | `event-analyst`, `tx-verifier` (go/no-go) | natural-language event summaries, final transaction approval decision |

### MCP policy — granted tools

The scoped `.harness/mcp-policy.json` applies **default-deny** (ADR-022)
and grants only:

```json
{
  "version": "1",
  "default": "deny",
  "audit": true,
  "grants": [
    { "tool": "web3_getBalance",        "reason": "read ETH/token balance" },
    { "tool": "web3_getLogs",           "reason": "fetch on-chain event logs" },
    { "tool": "web3_getBlockNumber",    "reason": "current chain tip" },
    { "tool": "web3_simulateContract",  "reason": "dry-run contract writes" },
    { "tool": "web3_call",              "reason": "low-level call simulation" },
    { "tool": "web3_sendTransaction",   "reason": "GUARDED: only when --allow-send", "requireFlag": "allow-send" }
  ]
}
```

`web3_sendTransaction` is listed in the policy but blocked at the
harness gate unless `--allow-send` is explicitly passed at scaffold time;
the agent receives a clear error if it attempts the tool without the flag.

### Auth model

- **RPC endpoint**: any JSON-RPC provider URL injected via `WEB3_RPC_URL`.
  - Alchemy Sepolia: `https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY`
  - Infura Sepolia: `https://sepolia.infura.io/v3/$INFURA_API_KEY`
  - Public fallback (rate-limited): `https://rpc.sepolia.org` (no key needed)
- **Private key** (opt-in only): `WEB3_PRIVATE_KEY` — a hex string for a
  testnet-only account loaded via `privateKeyToAccount`. The scaffolded files
  never contain or echo this value.

### Safety gates

1. **Read-only by default**: `createPublicClient` is always constructed;
   `createWalletClient` is constructed only when `--allow-send` is present
   and `WEB3_PRIVATE_KEY` is set.
2. **Testnet chain default**: chain is `sepolia` (chain ID 11155111) by
   default; the scaffold emits an explicit warning if any RPC URL points to
   mainnet (chain ID 1).
3. **simulateContract before any send**: the `tx-verifier` agent must
   complete a successful `simulateContract` run and return `{ ok: true }`
   before the optional `sendTransaction` is unlocked.
4. **No mainnet private keys**: the scaffold README and the generated
   `.env.example` carry a prominent warning that `WEB3_PRIVATE_KEY` must
   never hold a mainnet private key.
5. **MCP audit log**: every tool call is logged to `.harness/audit.jsonl`
   so the operator can review what the agent attempted.

---

## Consequences

### Positive

- Demonstrates that a generated harness can safely interact with a live
  blockchain without ever risking real funds, making it concrete for web3
  developers evaluating metaharness.
- The `PublicClient`-first model and explicit `simulateContract` gate are
  pedagogically correct: they mirror the best-practice workflow any web3
  developer should follow.
- viem's ABI type-inference means the scaffold generates strongly-typed
  contract call wrappers, giving the agent correct argument shapes without
  any prompt engineering.
- Sepolia is confirmed active through at least September 2026; Hoodi is
  available as an alternative for staking-focused testing.

### Limitations

- **Not a custodial wallet or DeFi protocol**: this example reads chain
  state and simulates; it does not implement MEV, flash loans, multi-sig,
  or any protocol-specific logic.
- **No mainnet support by default**: deliberately omitted to prevent
  accidental fund loss; operators who understand the risks can override the
  chain by passing `WEB3_CHAIN=mainnet` but must also supply `--allow-send`
  and accept full responsibility.
- **RPC rate limits**: the public Sepolia RPC (`rpc.sepolia.org`) is heavily
  rate-limited; production use requires an Alchemy or Infura API key.
- **Not audited or certified**: this example is illustrative scaffolding, not
  a security-audited smart contract framework. It carries the disclaimer below.

### Disclaimer

> **NOT FOR PRODUCTION / NOT A FINANCIAL INSTRUMENT.**
> This example is provided for **illustrative and educational purposes
> only**. It has not been audited for security vulnerabilities in smart
> contract interaction. It does not constitute financial advice. Any
> interaction with real blockchain networks (mainnet) or custody of private
> keys is solely the operator's responsibility. Do not use a private key
> that controls real funds in any environment scaffolded by this example.
