// @metaharness/flywheel — a verifiable self-improvement loop for agent harnesses.
// Freeze the model. Evolve the harness. Promote only what proves lift.
//
// The reusable engine for run → measure → mutate → verify → promote. It knows only candidates, scores,
// gates, receipts, and promotion lineage — never a host, model, or benchmark. Plug in your own proposer,
// evaluator, gate, holdouts, and cost/security rules; get the same auditable, replayable improvement loop.
export { runFlywheelGenerations } from './run.js';
export type { FlywheelConfig, FlywheelResult } from './run.js';

export { meetsPromotionRule, gateFingerprint } from './gate.js';
export { makeSigner, verifyReceipt, canon } from './receipts.js';
export { InMemoryLineageStore, computeLiftCurve, liftPoint } from './lineage.js';
export { verifyReplayBundle } from './replay.js';
export type { ReplayVerdict } from './replay.js';

export type {
  Policy,
  PolicyGenome,
  CandidateMutation,
  Score,
  PromotionEvidence,
  PromotionDecision,
  PromotionRule,
  Suite,
  HoldoutSuite,
  AnchorSuite,
  Proposer,
  Evaluator,
  PromotionReceipt,
  Signer,
  LineageCommit,
  LineageStore,
  LiftPoint,
  LiftCurve,
  ReplayBundle,
} from './types.js';
