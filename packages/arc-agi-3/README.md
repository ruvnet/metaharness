# `@metaharness/arc-agi-3`

> **Experimental.** Provider-neutral control and evidence primitives for ARC-AGI-3. This package does not change MetaHarness ADR-251, does not claim NVIDIA AVO-class status, and does not claim or guarantee a 100% benchmark score.

The package gives a ChatGPT actor and a separate ChatGPT supervisor a narrow, auditable interface over an injected ARC environment. It does not call an OpenAI or Anthropic API. The companion `@metaharness/arc-agi-3-chatgpt` package exposes these capabilities as remote MCP tools for two ChatGPT UI conversations.

## What the core enforces

- Exact `hex_rows_v1` grid observations and every returned animation frame.
- A strict action allowlist: `RESET`, `ACTION1` through `ACTION7`; `ACTION6` has integer `x,y` coordinates in `0..63` and no extra keys.
- Compare-and-swap on `expectedObservationHash` and bounded idempotency keys for every scored action.
- One serialized action critical section: idempotency lookup, CAS, policy checks, environment mutation, receipt, memory, graph, and session event.
- `NOT_PLAYED` and `GAME_OVER` are RESET-only. `WIN` stops the run. The initial full reset in `start()` is not counted; subsequent RESET operations are receipted.
- Hash-chained transition receipts containing the frozen run manifest, memory head, exact deltas, prediction error, and all returned frame references.
- Durable intents before semantic-rule and supervisor-directive mutation; identical retries resolve to the one committed version/directive even if completion logging fails.
- Principal, run, and opaque game scoping. The SDK's opaque session `guid` metadata is preserved, while raw game IDs, titles, versions, nested identity keys, URLs from failures, and environment exception text are stripped from model-visible evidence.
- Hidden-state-safe belief keys. Identical visible grids reached through different histories are not silently merged.
- Evidence-backed, versioned semantic rules. Every rule cites real receipt hashes; later contradictions are retained rather than overwriting earlier support.
- Deterministic supervision for game over, plan divergence, repeated edges, no effect, prediction error, stagnation, graph cycles, and eight ineffective coordinate probes.
- A separate `ArcSupervisorAuthority` that can inspect evidence and commit a stale-guarded directive, but has no environment action method.
- Harness-owned action and wall-time budgets. Exhaustion is checked before environment mutation.
- Idempotent `close()` that attempts environment cleanup even if the session log fails.

There is deliberately no random-action fallback.

## Minimal controller

```ts
import { ArcController } from '@metaharness/arc-agi-3';

const controller = new ArcController({
  principalId: authenticatedPrincipal,
  runId: opaqueRunHandle,
  gameVersionHash: operatorPrivateGameVersionHash,
  environment,
  runManifest: {
    visibleModelLabel: 'ChatGPT UI / operator-declared OpenAI model',
    promptSnapshotHash: promptSha256,
    toolSchemaHash: toolSchemaSha256,
    environmentAdapterVersion: 'arc-agi==0.9.8;arcengine==0.9.3;bridge=v1',
  },
  budget: { maxActions: 7_000, maxWallTimeMs: 14_400_000 },
});

const observation = await controller.start();
const result = await controller.act({
  expectedObservationHash: observation.observationHash,
  idempotencyKey: 'actor-turn-00000001',
  action: { name: 'ACTION1' },
  expectation: {
    confidence: 0.6,
    expectedState: 'NOT_FINISHED',
    rationale: 'Tests whether ACTION1 moves the selected object.',
  },
});
```

The UI model label is declared evidence, not provider attestation. Acceptance evidence should freeze the prompt, tool schema, controller version, environment adapter version, scorecard, and receipt head.

## Actor and supervisor contracts

The actor-facing controller supports:

- `start`, `observe`, `act`, `executeGuardedPlan`
- `queryMemory`, `commitMemoryRule`, `graphFrontier`
- `checkpoint`, `resume`, `status`, `verifyReceipts`, `reconcileReceipts`, `close`

`executeGuardedPlan` compares the expected pre-observation hash and validates a postcondition after every action. It stops on the first divergence or rejected action.

`asSupervisor()` returns an attenuated authority with pure `supervisorCaseBundle()` plus case/directive, memory-query, frontier, and status methods. A boss directive is bound to both `caseHash` and `expectedObservationHash`. Optional boss advice must contain exactly three distinct causal hypotheses and falsifiers, receipt-backed evidence, a typed proposed action for each hypothesis, a strategy, and bounded constraints. The core stores that advice in the directive hash instead of dropping it at the MCP boundary.

Default deterministic supervisor thresholds are:

| Trigger | Default |
|---|---:|
| Repeated observable edge | 2 |
| No-effect actions | 3 in 6 |
| Mean prediction error | greater than 0.35 over 5 |
| Stagnation | 8 actions |
| Cycle within one observable component | more than 6 actions |
| Ineffective `ACTION6` probes | 8 |

All count and window overrides must be positive integers. Prediction-error mean is the only fractional threshold.

## Receipts: integrity versus completeness

`verifyReceipts()` checks canonical hashes, sequence, chain links, stable run/principal/game/manifest scope, prior-post to next-pre belief/observation/state/progress continuity, and exact frame references. It proves chain integrity only. A valid prefix cannot prove that no unreceipted environment action occurred.

`reconcileReceipts()` is the completeness check. Feed it independently obtained official `actionCount` (ACTION1–ACTION7 only), `resetCount`, and expected receipt head. It separately compares non-RESET actions, RESET transitions, total transitions, and the head hash. A rejected/invalid response after an environment step was dispatched increments `uncertainMutationCount`; reconciliation fails while that count is nonzero, even if all known hashes and official counts otherwise match.

## Checkpoints and size bounds

Runtime receipts retain every exact frame. Checkpoints replace repeated frame bodies with content-addressed `frameBlobHashes`; `frameBlobs` stores each exact frame object once. Compact idempotency records also point to these blobs. Hydration reconstitutes full receipts and verifies their original hashes.

The deterministic long-horizon test executes 6,624 no-effect actions and serializes a checkpoint with one unique 1×1 frame. It currently measures about **28.2 MiB** and is gated below 32 MiB. The ChatGPT adapter should permit at least 64 MiB per checkpoint for this workload.

That measurement is not a universal upper bound. The enforced input limits are 10,000 actions, at most 256 animation frames and 1,048,576 cells per observation, with each frame at most 64×64. In the adversarial all-unique limit, exact frame evidence alone can approach 10.5 billion encoded cells before JSON/object overhead. Configure storage from the preregistered environment envelope; do not advertise a fixed small checkpoint cap as generally sufficient. Canonical receipts, frames, and semantic evidence are never compacted away. Prompt-context compaction belongs in a UI adapter, not the evidence store.

## Resume limits

Resumable controllers require an explicit private `gameVersionHash`, preventing a checkpoint from importing memory into a different game that happens to show the same grid.

The official online Python SDK cannot rehydrate remote GUID/cookie state after the Python process dies. Controller memory and checkpoints are durable, and ChatGPT context/tab rotation works while the bridge process survives. A replacement controller's `resume()` requires both an environment checkpoint payload and adapter `resume` support; it never falls back to `observe()` on a fresh session, even when the visible frame is identical. This package does not claim that the official online bridge provides exact environment-process crash recovery.

For benchmark parity, pin exactly:

```text
arc-agi==0.9.8
arcengine==0.9.3
```

This packaged bridge refuses `arc-agi==0.9.9`. Using that release requires a separate reviewed bridge condition and a distinct `environmentAdapterVersion`; contract similarity is not treated as benchmark parity.

## Evaluation and ablations

Preregister game set, seeds, prompt/tool hashes, model label, adapter versions, budgets, context-rotation policy, and supervisor thresholds before evaluating. Report public and private/held-out results separately, with Wilson intervals over independent runs where repeated runs are permitted.

| Variant | Exact frames | Semantic memory | Belief graph | Supervisor | CAS/receipts | Purpose |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Full harness | ✓ | ✓ | ✓ | ✓ | ✓ | Primary governed result |
| No supervisor | ✓ | ✓ | ✓ | — | ✓ | Isolate boss intervention |
| No semantic memory | ✓ | — | ✓ | ✓ | ✓ | Isolate reusable rule memory |
| No belief graph | ✓ | ✓ | — | ✓ | ✓ | Isolate hidden-state-safe exploration |
| Final frame only | — | ✓ | ✓ | ✓ | ✓ | Measure animation evidence value |
| No guarded plans | ✓ | ✓ | ✓ | ✓ | ✓ | Measure per-step postcondition value |
| Ungoverned actor | ✓ | — | — | — | — | Descriptive baseline only |

For every variant report: level/game success, scored actions, RESET count, action efficiency relative to the best successful run, wall time, prediction calibration, supervisor triggers, context rotations, receipt reconciliation, and failures by stable public error code.

A 100% public score from one frozen configuration is evidence about that configuration and set—not a guarantee of private-set performance, robustness to SDK changes, or a controlled comparison with a bare-model baseline.
