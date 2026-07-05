# @metaharness/flywheel

**A verifiable self-improvement loop for agent harnesses.**
_Freeze the model. Evolve the harness. Promote only what proves lift._

[![npm](https://img.shields.io/npm/v/@metaharness/flywheel.svg)](https://www.npmjs.com/package/@metaharness/flywheel)
[![types](https://img.shields.io/npm/types/@metaharness/flywheel.svg)](https://www.npmjs.com/package/@metaharness/flywheel)
[![license](https://img.shields.io/npm/l/@metaharness/flywheel.svg)](./LICENSE)

The reusable engine for **run → measure → mutate → verify → promote**. It turns "self-improving agent
harness" from a claim into an **installable primitive**: plug in your own proposer, evaluator, gate,
holdouts, and cost/security rules and get the same **auditable, replayable** improvement loop — a signed
promotion lineage and a compounding lift curve you (or an outside auditor) can verify with no trust in the
machine that produced it.

Part of the [MetaHarness](https://www.npmjs.com/package/metaharness) stack: **`metaharness`** mints
harnesses, **`@metaharness/darwin`** evolves them, and **`@metaharness/flywheel`** formalizes the promotion
loop so every host and vertical harness reuses one engine instead of copying code.

---

## Why

Most "self-improving agent" pitches are unfalsifiable. The flywheel makes improvement **provable**:

- **The gate is the product.** A promotion is only trusted if it clears a **frozen, conjunctive** gate
  (`meetsPromotionRule`). The gate never moves during a run, and its fingerprint is recorded so anyone can
  prove it was unchanged.
- **Freeze the model, evolve the harness.** The expensive model stays fixed; what evolves is the cheap
  executor's **operating policy**. (ADR-226 receipts: a read-only advisor loop produced *zero* marginal
  lift at *5.4×* cost — the executor policy is the part that mattered. Invest in policy evolution + gates,
  not expensive advisory loops.)
- **Compounding, not searching.** Each generation re-bases on the previous **promoted winner**, so verified
  wins accumulate into an immutable lineage — a *lift curve*, not a scatter of one-off tweaks.
- **Anti-Goodhart by construction.** A candidate must clear both a **holdout** and a **frozen anchor** it is
  never optimized against.
- **Receipt-backed + replayable.** Every promotion is Ed25519-signed; an external reviewer replays the
  bundle, reconstructs the lineage to gen-0, and verifies the gate — trusting the *signature*, not you.

## Features

- 🎯 **One tiny API** — `runFlywheelGenerations()` drives coding *and* non-coding harnesses unchanged.
- 🧊 **Frozen, pluggable gate** — ship the default `meetsPromotionRule` or inject your own compliance/cost gate.
- 🧬 **Compounding lineage (DAG)** — "git for operating policies": every promotion is a parent-linked commit.
- 📈 **Lift curve** — the observable proof the wheel *climbs*, generation over generation.
- 🧾 **Ed25519 receipts + `verifyReplayBundle()`** — independent, no-trust replay.
- 🔒 **Gate fingerprint** — prove the promotion rule was unchanged between runs.
- 🧩 **Zero host/benchmark coupling** — knows only candidates, scores, gates, receipts, lineage.
- 🪶 **Thin + dependency-free** at runtime (Node `crypto` only). ESM, fully typed.

## Install

```bash
npm install @metaharness/flywheel
```

## Usage

```ts
import { runFlywheelGenerations, meetsPromotionRule, makeSigner, verifyReplayBundle } from "@metaharness/flywheel";

const result = await runFlywheelGenerations({
  rootPolicy: { reasoning: "", format: "", verification: "" },   // the levers you evolve
  proposer:   async (base, target) => improve(base.policy[target]), // your model call
  evaluator:  async (policy, suite) => score(policy, suite),        // your host/benchmark → Score
  promotionRule: meetsPromotionRule,   // the frozen gate (or inject your own)
  holdout: { id: "holdout", items: myHoldoutTasks },
  anchor:  { id: "anchor",  items: myAnchorTasks },   // never optimized against
  maxGenerations: 10,
  signer: makeSigner(),
  dataSource: "LIVE",
});

console.log(result.liftCurve);      // [{ generation, primary, delta, anchor }, …] — the climb
console.log(result.promotions);     // the promoted chain (current → gen-0 root)
console.log(result.milestoneReached); // ≥2 anchor-surviving compounding improvements

// Anyone can replay it — no trust in the producer:
const verdict = verifyReplayBundle(result.replayBundle);
console.log(verdict.pass, verdict.chainSummary); // true  "gen4(format) → gen2(reasoning) → gen1(…) → gen0(root)"
```

Your `Evaluator` projects whatever your domain measures onto four abstract axes — the **only** place a
host or benchmark enters:

```ts
interface Score {
  primary: number;     // wins / accuracy / resolved  (higher better)
  noopRate: number;    // no-op / empty / abstained   (lower better)
  costPerWin: number;  // resource cost per success   (lower better)
  regressed: boolean;  // hard safety/security stop
}
```

## API

| Export | What |
| --- | --- |
| `runFlywheelGenerations(config)` | the promotion loop → `{ liftCurve, promotions, replayBundle, … }` |
| `meetsPromotionRule` | the default frozen conjunctive gate (`PromotionRule`) |
| `gateFingerprint(rule)` | sha256 of a gate's source — prove it was unchanged |
| `makeSigner()` / `verifyReceipt` / `canon` | Ed25519 receipts |
| `InMemoryLineageStore` / `computeLiftCurve` | lineage graph + lift curve |
| `verifyReplayBundle(bundle, { pinnedGateFingerprint })` | the external acceptance test |
| types | `Policy` · `PolicyGenome` · `CandidateMutation` · `Score` · `PromotionReceipt` · `LiftCurve` · `LineageStore` · `ReplayBundle` · `AnchorSuite` · `HoldoutSuite` · `Proposer` · `Evaluator` · `PromotionRule` · `Signer` |

## Package boundary

| Package | Job |
| --- | --- |
| `metaharness` | CLI, Studio, repo analysis, user entry point |
| `@metaharness/darwin` | mutation strategy + evolutionary search |
| **`@metaharness/flywheel`** | **promotion loop, receipts, lineage, replay, lift curve** |
| `@metaharness/router` | model / host routing |
| `@metaharness/hosts-*` | Claude Code, Codex, Hermes, OpenClaw, RVM adapters |

**Design rule:** the flywheel must not know about Claude Code, SWE-bench, GLM, Sonnet, Fable, or any
benchmark. If you need a benchmark-specific branch, it belongs in your `Evaluator`, not here.

## Topics

`agent-harness` · `self-improving-agents` · `llm-evaluation` · `holdout` · `promotion-gate` ·
`evolutionary-optimization` · `policy-optimization` · `verifiable-ai` · `audit-trail` · `lineage` ·
`ed25519` · `receipts` · `provenance` · `goodhart` · `anti-goodhart` · `lift-curve` · `agentic-ci` ·
`prompt-optimization` · `metaharness` · `darwin` · `flywheel`

## License

MIT © MetaHarness
