# @metaharness/example-web3

**A MetaHarness scaffold that wires a multi-agent harness to the Ethereum ecosystem via viem — reading balances, streaming events, and simulating transactions on a testnet, safely by default.**

> **Illustrative output disclaimer.** The agents scaffolded by this package
> demonstrate MetaHarness capabilities against public blockchain testnets.
> All output is for educational purposes only and does not constitute
> financial advice. No mainnet private keys should ever be used with this
> example. See the [Safety](#safety) section.

---

[![npm version](https://img.shields.io/npm/v/@metaharness/example-web3?label=%40metaharness%2Fexample-web3)](https://www.npmjs.com/package/@metaharness/example-web3)
[![npm downloads](https://img.shields.io/npm/dm/@metaharness/example-web3)](https://www.npmjs.com/package/@metaharness/example-web3)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org/)
[![Built with MetaHarness](https://img.shields.io/badge/built%20with-metaharness-blueviolet)](https://github.com/ruvnet/agent-harness-generator)

---

## Intro

`@metaharness/example-web3` scaffolds a MetaHarness project pre-wired to
the **viem** Ethereum TypeScript library. It shows how a multi-agent harness
can:

- read live on-chain data (balances, block number, event logs) in parallel,
- simulate smart contract writes without broadcasting a transaction or
  spending gas, and
- (optionally, when explicitly enabled) broadcast a real transaction on
  Ethereum **Sepolia testnet only**.

**What it is not**: a custodial wallet, a DeFi protocol, a trading bot, or
anything that touches mainnet by default. No private keys are ever written to
scaffolded files.

---

## Features

| Capability | How it works in this example |
|---|---|
| **Read-chain fan-out** | `chain-reader` agent calls `publicClient.getBalance`, `publicClient.getLogs`, and `publicClient.getBlockNumber` in parallel via viem |
| **Event stream replay** | Fetches and parses ERC-20 `Transfer` logs for any address using `parseAbiItem` + `getLogs`; `event-analyst` agent summarises them |
| **Simulate transaction** | `tx-verifier` agent calls `publicClient.simulateContract` — a genuine dry-run; no gas, no broadcast |
| **Tiered model routing** | Cheap tier for data extraction and simulation; frontier tier for natural-language analysis and go/no-go decisions |
| **MCP default-deny** | `.harness/mcp-policy.json` grants only the six web3 tools needed; all others are denied; every call is audit-logged |
| **Verification gate** | `simulateContract` must return `{ ok: true }` before the optional send is unlocked |
| **Guarded send (opt-in)** | `walletClient.sendTransaction` on Sepolia only; requires `--allow-send` flag AND `WEB3_PRIVATE_KEY` set to a testnet key |
| **All-host scaffold** | `--host all` emits config for claude-code, codex, copilot, github-actions, hermes, openclaw, opencode, pi-dev, rvm |

---

## Quickstart

```bash
npx @metaharness/example-web3@latest my-web3-bot
cd my-web3-bot
npm install
npm run doctor
```

The `doctor` command checks that `WEB3_RPC_URL` is set and reachable,
confirms you are on a testnet, and prints what each agent will do.

---

## Configuration

Copy `.env.example` to `.env` and fill in the values below. **Never commit
`.env` to version control.**

### Required

| Env var | Description | Example |
|---|---|---|
| `WEB3_RPC_URL` | JSON-RPC endpoint for your chosen testnet | `https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY` |

### Optional — RPC provider keys

| Env var | Where to get it | Used in |
|---|---|---|
| `ALCHEMY_API_KEY` | [alchemy.com](https://www.alchemy.com/) dashboard | `WEB3_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/$ALCHEMY_API_KEY` |
| `INFURA_API_KEY` | [infura.io](https://www.infura.io/) project settings | `WEB3_RPC_URL=https://sepolia.infura.io/v3/$INFURA_API_KEY` |

If you have no API key, set `WEB3_RPC_URL=https://rpc.sepolia.org` for the
public rate-limited Sepolia endpoint — sufficient for evaluation.

### Optional — testnet send (opt-in only)

| Env var | Description |
|---|---|
| `WEB3_PRIVATE_KEY` | Hex private key for a **testnet-only** account (never a mainnet key) |

`WEB3_PRIVATE_KEY` is read only when `--allow-send` is passed at scaffold
time. Get free Sepolia ETH from the [Alchemy Sepolia faucet](https://sepoliafaucet.com/)
or the [Infura faucet](https://www.infura.io/faucet/sepolia).

### Optional — chain override

| Env var | Default | Description |
|---|---|---|
| `WEB3_CHAIN` | `sepolia` | Chain name recognised by viem/chains (`sepolia`, `holesky`, `hoodi`). If set to `mainnet` the harness emits a prominent warning and `--allow-send` is still required for any write. |

---

## Usage

### /slash command

```
/web3 read   <address>           — balance + block number for <address>
/web3 events <address> [blocks]  — last <blocks> (default 1000) ERC-20 Transfer events for <address>
/web3 simulate <contractAddr> <functionName> [args...]  — dry-run a write function
/web3 send   <to> <valueEth>     — send ETH on testnet (requires --allow-send)
```

### Representative natural-language prompts

```
"What is the ETH balance and recent Transfer events for 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 on Sepolia?"

"Simulate calling the mint(address,uint256) function on contract
0xYourERC20 with args (0xAlice, 1000000000000000000) — show me
whether it would succeed and what it would return."

"Show me the last 500 blocks of Transfer logs for the USDC contract
on Sepolia and summarise who sent the most."
```

The `chain-reader` agent fans out the read calls in parallel, the
`event-analyst` agent produces the natural-language summary, and the
`tx-verifier` agent validates any simulate request before showing
results.

---

## Safety

> **NOT FOR PRODUCTION. NOT FINANCIAL ADVICE. NOT AUDITED.**
>
> This example is illustrative scaffolding for educational purposes. It has
> not been security-audited for smart contract interaction vulnerabilities.
> It does not constitute investment or financial advice. Interaction with
> real blockchain networks (mainnet) or custody of real private keys is
> solely the operator's responsibility.
>
> **Never set `WEB3_PRIVATE_KEY` to a key that controls real funds.**

Safety posture summary:

- **Read-only by default.** `createWalletClient` is never constructed unless
  `--allow-send` is explicitly passed at scaffold time.
- **Testnet by default.** Chain defaults to Sepolia (chain ID 11155111).
  The harness logs a warning if `WEB3_RPC_URL` resolves to a mainnet node
  (chain ID 1).
- **Simulation before any send.** `simulateContract` must succeed and return
  `{ ok: true }` before `sendTransaction` is invoked.
- **Secrets in ENV only.** No key or credential is written to any scaffolded
  file. `.env` is added to `.gitignore` automatically.
- **MCP audit log.** Every tool call is appended to `.harness/audit.jsonl`.
- **No mainnet keys.** The generated `.env.example` contains a warning comment
  on every key field.

---

## How it works

### Agents

| Agent | Model tier | Responsibilities |
|---|---|---|
| `chain-reader` | Tier 2 (cheap) | Parallel `getBalance`, `getLogs`, `getBlockNumber`; returns raw JSON |
| `event-analyst` | Tier 3 (frontier) | Parses log arrays; produces human-readable summaries and insights |
| `tx-verifier` | Tier 2 for sim / Tier 3 for go-no-go | Validates params; calls `simulateContract`; gatekeeps send |

### Routing tiers (ADR-026)

| Tier | Examples in this harness |
|---|---|
| Tier 1 — WASM booster | ABI hex encoding, wei-to-ether unit conversion |
| Tier 2 — cheap (Haiku-class) | `chain-reader` fan-out, `tx-verifier` simulation call, raw data extraction |
| Tier 3 — frontier (Sonnet-class) | `event-analyst` summaries, `tx-verifier` final go/no-go decision |

### MCP policy — granted tools

`.harness/mcp-policy.json` applies **default-deny** (ADR-022) and grants
exactly:

| Tool | Purpose |
|---|---|
| `web3_getBalance` | Read ETH/token balance for an address |
| `web3_getLogs` | Fetch on-chain event logs with ABI filter |
| `web3_getBlockNumber` | Current chain tip |
| `web3_simulateContract` | Dry-run a contract write (no broadcast) |
| `web3_call` | Low-level call simulation |
| `web3_sendTransaction` | GUARDED — active only with `--allow-send` |

All calls are appended to `.harness/audit.jsonl` with timestamp, agent
ID, tool name, and a SHA-256 of the parameters.

### viem usage pattern

```js
// Read path — always on
import { createPublicClient, http, parseAbiItem, formatEther } from 'viem'
import { sepolia } from 'viem/chains'

const client = createPublicClient({ chain: sepolia, transport: http(process.env.WEB3_RPC_URL) })

const [balance, blockNumber] = await Promise.all([
  client.getBalance({ address: '0x...' }),
  client.getBlockNumber(),
])

const logs = await client.getLogs({
  address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
  fromBlock: blockNumber - 1000n,
  toBlock: blockNumber,
})

// Simulate path — dry-run, no gas
const { result } = await client.simulateContract({
  address: contractAddress,
  abi,
  functionName: 'mint',
  args: [recipient, amount],
  account,
})

// Write path — opt-in only, testnet only
// import { createWalletClient } from 'viem'
// import { privateKeyToAccount } from 'viem/accounts'
// const account = privateKeyToAccount(process.env.WEB3_PRIVATE_KEY)
// const walletClient = createWalletClient({ account, chain: sepolia, transport: http(...) })
// await walletClient.sendTransaction({ to, value })
```

ethers v6 is documented as an alternative:

```js
import { JsonRpcProvider, formatEther } from 'ethers'
const provider = new JsonRpcProvider(process.env.WEB3_RPC_URL)
const balance = await provider.getBalance('0x...')
```

---

## Links

- **viem documentation**: https://viem.sh/docs/getting-started
- **viem simulateContract**: https://viem.sh/docs/contract/simulateContract
- **viem getLogs**: https://viem.sh/docs/actions/public/getLogs
- **viem chains (Sepolia, Holesky, Hoodi)**: https://viem.sh/docs/clients/public
- **ethers v6 documentation**: https://docs.ethers.org/v6/getting-started/
- **Sepolia testnet faucet (Alchemy)**: https://sepoliafaucet.com/
- **Sepolia testnet faucet (Infura)**: https://www.infura.io/faucet/sepolia
- **Ethereum testnet guide 2026**: https://theethereum.wiki/learn/ethereum-testnets-guide/
- **Hoodi testnet announcement**: https://blog.ethereum.org/2025/03/18/hoodi-holesky
- **ADR-065** (this design): `docs/adrs/ADR-065-example-web3.md`
- **ADR-051** (examples program): `docs/adrs/ADR-051-third-party-sdk-showcase-examples.md`
- **MetaHarness GitHub**: https://github.com/ruvnet/agent-harness-generator
