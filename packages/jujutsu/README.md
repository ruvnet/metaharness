# @metaharness/jujutsu — version-control-for-agents capability + dual-state bridge

> **Give each agent its own branch — of *both* its code and its memory.** Wraps
> [`agentic-jujutsu`](https://www.npmjs.com/package/agentic-jujutsu) (lock-free
> jj/Jujutsu op-log, QuantumDAG agent coordination, ReasoningBank trajectories,
> ML-DSA signing) as a **removable** MetaHarness capability, and bridges it to
> [`agenticow`](https://www.npmjs.com/package/agenticow) copy-on-write vector
> memory so an agent's **code/op branch** and its **memory branch** are created,
> learned, reverted, and merged **as one unit**.

```bash
npm i @metaharness/jujutsu
# optional native peers (removable augmentation — ADR-150):
npm i agentic-jujutsu agenticow
```

## Why

A coding agent that explores must be able to *branch and roll back*. jj gives a
lock-free operation log for the **code/op** plane; agenticow gives ~0.5 ms / 162 B
copy-on-write branches for the **memory** plane. Used separately they drift: you
can revert the code but keep poisoned memory, or promote a memory delta whose
ops you abandoned. This package keeps the two planes **1:1** so a spawn / learn /
revert / merge always touches both.

## Removable by design (ADR-150)

`agentic-jujutsu` and `agenticow` are **optional peer dependencies**. Everything
here imports and type-checks with **neither** installed; nothing is a required
runtime dep. Use `probe()` for honest capability reporting and the bridge
degrades to whichever planes are live.

```ts
import { probe } from '@metaharness/jujutsu';

const cap = await probe();
// { opLog, memory, jjCli, annAcrossBranch, notes[] }
```

| Field | Meaning |
|---|---|
| `opLog` | agentic-jujutsu native addon loadable |
| `jjCli` | `jj` (Jujutsu) CLI resolvable (needed for branch/diff/log) |
| `memory` | agenticow COW memory branching loadable |
| `annAcrossBranch` | native ANN spanning the COW boundary (RuVector PR #617) — **pending** |

## The capability facade

```ts
import { JujutsuCapability } from '@metaharness/jujutsu';

const jj = JujutsuCapability.create();        // throws CapabilityUnavailableError if absent
await jj.enableCoordination();                // QuantumDAG lock-free coordination
await jj.registerAgent('alice', 'coder');
jj.startTrajectory('implement auth');         // ReasoningBank trajectory
jj.addToTrajectory();
jj.finalizeTrajectory(0.9, 'good run');
jj.suggestion('implement auth');              // learned suggestion
jj.userOps(50);                               // op-log (needs jj CLI)
```

Quantum signing (ML-DSA-65) is passed through:

```ts
import { quantumSigner } from '@metaharness/jujutsu';
const QS = quantumSigner();                    // null if addon absent
const kp = QS.generateKeypair();
```

## The dual-state bridge

```ts
import {
  DualStateBridge,
  AgenticJujutsuOpProvider,
  AgenticowMemoryProvider,
  AgenticowQueryProvider,
} from '@metaharness/jujutsu';

const op  = new AgenticJujutsuOpProvider({ coordinate: true });
const mem = await AgenticowMemoryProvider.create({ basePath: 'memory/base.rvf', dimension: 384 });
const bridge = new DualStateBridge(op, mem, { queryProvider: new AgenticowQueryProvider(mem) });

const branch = await bridge.spawn('alice');         // jj bookmark + COW branch, together
// ... agent works ...
await bridge.learn('alice', 0.95, 'tests green');   // finalize trajectory -> embed op-seq -> COW branch
const hits = await bridge.queryMemory('alice', vec); // cross-branch query (stubbed plane, see below)
await bridge.revert('alice');                        // jj undo + drop COW delta
const promo = await bridge.merge('alice');           // squash ops + promote winning COW delta to base
```

### Lifecycle mapping (1:1)

| Verb | Code/op branch (agentic-jujutsu) | Memory branch (agenticow) |
|---|---|---|
| **spawn** | register agent + `jj bookmark create` + open trajectory | `fork()` base + `checkpoint('spawn')` |
| **learn** | `finalizeTrajectory(score)` + read op-sequence | embed op-sequence → `ingest()` into the branch |
| **revert** | `jj undo` (op-log rollback) | `rollback()` to the spawn checkpoint (drop delta) |
| **merge** | `jj squash` ops into base | `promote()` winning delta into the base memory |

### Ports & adapters

The bridge depends only on three interfaces — `OpBranchProvider`,
`MemoryBranchProvider`, `MemoryQueryProvider` — so you can mix real and mock
planes. Ship adapters:

- `AgenticJujutsuOpProvider` / `AgenticowMemoryProvider` — real native planes.
- `MockOpProvider` / `MockMemoryProvider` / `MockQueryProvider` — offline,
  dependency-free (used by the smoke test + unit tests, and as a fallback).

### What's wired vs stubbed

- **Wired (works today):** spawn / learn / revert / merge across both real
  planes — verified end-to-end with jj 0.35.0 bookmarks + agenticow COW.
- **Stubbed plane — cross-branch query:** `queryMemory()` delegates to a
  `MemoryQueryProvider`. `AgenticowQueryProvider` uses agenticow's **exact
  read-through** `query()` (parent ∪ child edits, child wins). The
  **accelerated native ANN that spans the COW boundary** (RuVector PR #617) is
  still in flight; `nativeAnn` is `false` until it lands, at which point this
  adapter swaps to it with no bridge change.

## Embedding

`learn()` turns the op-sequence into vectors via an `Embedder`. The default
`HashEmbedder` is deterministic and offline (a placeholder). Inject a real model
(e.g. ONNX all-MiniLM-L6-v2) for production:

```ts
new DualStateBridge(op, mem, { embedder: myMiniLmEmbedder });
```

## Known upstream issue (agentic-jujutsu ≤ 2.3.6)

`JjWrapper.branchCreate()` invokes the **removed** `jj branch` subcommand; jj
≥0.21 renamed it to `jj bookmark`, so it fails against the jj 0.35.0 the package
bundles. This package **works around it** by driving branching through
`bookmark` and falling back to `branchCreate()` only for old jj. See
[ADR-202](../../docs/adrs/ADR-202-agenticow-jujutsu-dual-state-bridge.md).

## Scripts

```bash
npm run -w @metaharness/jujutsu build   # tsc
npm run -w @metaharness/jujutsu test    # vitest (offline, mock-backed)
npm run -w @metaharness/jujutsu smoke   # offline lifecycle + capability probe
```

MIT © RuvNet
