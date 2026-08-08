# @metaharness/radio

**Passive-awareness swarm bus for agent pods.**
_Freeze the model. Evolve the comms policy._

A dependency-free, deterministic TypeScript implementation of **AgentRadio**
([arXiv:2607.28430](https://arxiv.org/abs/2607.28430)) — the asynchronous
messaging layer that lets multi-agent systems communicate **during** task
execution instead of only at phase boundaries. See
[ADR-241](../../docs/adrs/ADR-241-radio-passive-awareness-swarm-bus.md).

## Why

The paper's ablation on long-horizon codebase QnA (four agents vs one, same
model): naive division of labor +7.2 pts, negotiated partition +12.1, and
**passive awareness +10.5 (p = 0.0023)** — 62.1% vs 32.3% single-agent overall.
The passive layer is one primitive: `wait_for_mention` backgrounded as an OS
task, not an LLM step. Listening becomes free; an @-mention folds in at the
next step boundary with a full thread snapshot, never interrupting a running
command.

## What ships

- **`RadioBus`** — threads, non-blocking `send` with @-mentions, total order by
  a logical clock (no wall clock: replays bit-for-bit).
- **`Watcher`** — `fold()` surfaces pending mentions + snapshots at a step
  boundary at **zero step cost**; `blockingReceive()` is the ablation arm and
  costs one. Separate methods, so a protocol can't silently mix the modes.
- **`runProtocol`** — the paper's five-phase, assembler-gated pod protocol:
  Explore → Divide (negotiate until approved) → Execute (live sharing under
  passive awareness; silent under blocking) → Review (can reopen Execute) →
  Submit (unanimous).
- **`runSim` / `makeTask`** — a seeded, deterministic codebase-QnA swarm sim
  (facts scattered across units, configurable cross-partition fraction). Its
  headline property: reproducing the paper's ablation **order**
  `passive < negotiate ≤ divide < single` in foreground steps-to-resolve.
- **`scripts/flywheel-radio.mjs`** — evolves the comms policy
  `{mode, foldEvery, postPolicy}` from a deliberately bad root under
  `@metaharness/flywheel`'s frozen gate + never-optimized anchor topology,
  Ed25519-signed and replay-verified. The wheel re-discovering
  `passive/immediate` is the paper's ablation direction, measured on our own
  machinery.

## Honest bounds

Mentions can derail (the paper's passive layer gained 47 rubrics, lost 23);
awareness cannot surface conclusions no agent forms; the sim is a mechanism
testbed, not a benchmark claim. Live LLM-pod wiring is deferred to its own
measured ADR.

## Usage

```ts
import { RadioBus, Watcher, runSim, makeTask } from '@metaharness/radio';

const bus = new RadioBus();
bus.createThread('worklog', ['scout', 'builder']);
const scout = new Watcher(bus, 'scout');
bus.send('worklog', 'builder', 'auth flow lives in gateway/, not api/', ['scout']);
// ...later, at scout's next step boundary — zero step cost:
for (const { mention, snapshot } of scout.fold()) {
  /* fold the discovery into the current sub-task */
}
```

MIT.
