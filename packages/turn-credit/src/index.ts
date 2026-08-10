// @metaharness/turn-credit — public surface (ADR-248).
export {
  PAPER_DEFAULTS,
  GOVERNED_DEFAULTS,
  type EvidenceMode,
  type TurnEvidence,
  type CreditConfig,
  type BeliefStep,
  type TurnCredit,
  type TrajectoryCredit,
  type ScorePair,
  type LogProbPair,
} from './types.js';
export { clip, round6, logit, sigmoid, clipPrior, beliefTrajectory } from './belief.js';
export {
  outcomeSign,
  effectiveBound,
  reshapeCredits,
  markPivotal,
  reshapedAdvantage,
} from './reshape.js';
export {
  processTrajectory,
  advantageFromOutcome,
  evidenceFromLogProbs,
  evidenceFromScorePairs,
  type ProcessInput,
} from './processor.js';
export {
  creditByLabel,
  attributeMutation,
  toQualityLabels,
  toMemoryFeedback,
  type LabelCredit,
  type MutationAttribution,
} from './adapters.js';
export { canon, digest, buildCreditReceiptPayload, type CreditReceiptInput } from './receipt.js';
