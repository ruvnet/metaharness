# @metaharness/workspace-probe

**Evaluation + Darwin-Mode bridge for [`@metaharness/workspace-lens`](https://www.npmjs.com/package/@metaharness/workspace-lens).**
Turn Jacobian-Lens interpretability *receipts* into (1) a flywheel-consumable **`workspace_probe` score** and
(2) **Darwin-Mode mutation evidence** that rejects structurally-brittle prompt/policy mutations.

Pure · dependency-light (only the workspace-lens types) · deterministic · `$0`.

## Why

`@metaharness/workspace-lens` reads the model's internal *verbalizable workspace* into a
`WorkspaceLensReceipt` per decision. This package projects a *set* of those receipts into evaluation signal:

- **`workspaceProbeScore(receipts)`** → `{ score, meanDrift, flagRate, criticalRate, cleanFraction }`.
  `score` (= `cleanFraction`) is the fraction of decisions whose workspace was **clean** — no critical
  safety trigger AND drift below threshold. A harness/policy that makes the model hold steadier, safer
  intermediate concepts before answering scores higher. Use it as a `workspace_probe` Score dimension.

- **`gradeMutationByWorkspace(baseline, mutant)`** → `{ keep, reasons, baseline, mutant }`. A Darwin-Mode
  **veto**: reject a mutation that improves the final answer *at the cost of the internal process* —
  it raises the critical-trigger rate, destabilizes the workspace (drift up), or lowers the clean
  fraction. *"Final answer up, workspace grip down"* = structurally brittle. Pair with the usual
  gold/final-answer gate: keep a mutation only if **both** pass. It never weakens the answer gate.

## Quickstart

```ts
import { buildReceipt } from '@metaharness/workspace-lens';
import { workspaceProbeScore, gradeMutationByWorkspace } from '@metaharness/workspace-probe';

const receipts = decisions.map(d => buildReceipt(lens, d.prompt, d.states, { createdAt: d.ts, concepts }));

const probe = workspaceProbeScore(receipts, { driftThreshold: 0.25 });
// → { n, score, meanDrift, flagRate, criticalRate, cleanFraction }

const verdict = gradeMutationByWorkspace(baselineReceipts, mutantReceipts);
if (!verdict.keep) rejectMutation(verdict.reasons);   // structurally brittle
```

## Links

- **workspace-lens (the primitive):** https://www.npmjs.com/package/@metaharness/workspace-lens
- **MetaHarness:** https://github.com/ruvnet/metaharness

## License

MIT.
