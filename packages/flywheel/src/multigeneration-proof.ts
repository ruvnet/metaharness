import { createHash } from 'node:crypto';
import { canon, verifyReceipt } from './receipts.js';
import type { PromotionReceipt } from './types.js';

export const MULTIGEN_PROOF_VERSION = 'multigen-proof-v1' as const;
export const MULTIGEN_AUTHORITY = 'none' as const;

export type EvidenceClass = 'synthetic' | 'development' | 'sealed_holdout' | 'independent_confirmation';

export interface Outcome {
  primary: number;
  costPerWin: number;
  safetyViolations: number;
  regressions: number;
}

export interface BudgetEnvelope {
  attempts: number;
  evaluationCalls: number;
  processStarts: number;
  tokenCeiling: number;
  costMicroUsdCeiling: number;
}

export interface ImproverProbe {
  budget: BudgetEnvelope;
  successfulSuccessors: number;
  bestSuccessorLift: number;
  medianSuccessorLift: number;
  actualCostMicroUsd: number;
}

export type ControlArm = 'frozen' | 'static' | 'shuffled' | 'previous';

export interface ControlObservation {
  arm: ControlArm;
  outcome: Outcome;
  improver: ImproverProbe;
}

export interface ReviewerAttestation {
  reviewerId: string;
  receipt: PromotionReceipt;
}

export interface GenerationEvidence {
  generation: number;
  parentId: string;
  childId: string;
  sourceDigest: string;
  selectionSetDigest: string;
  confirmationSetDigest: string;
  evidenceClass: EvidenceClass;
  baseline: Outcome;
  child: Outcome;
  parentImprover: ImproverProbe;
  childImprover: ImproverProbe;
  controls: ControlObservation[];
  reviewerAttestations: ReviewerAttestation[];
  authority: typeof MULTIGEN_AUTHORITY;
}

export interface MultiGenerationEvidence {
  version: typeof MULTIGEN_PROOF_VERSION;
  runId: string;
  rootId: string;
  gateDigest: string;
  createdAt: string;
  generations: GenerationEvidence[];
  authority: typeof MULTIGEN_AUTHORITY;
}

export interface MultiGenerationProofPolicy {
  minGenerations: number;
  minPrimaryDelta: number;
  minRelativeCostReduction: number;
  minImproverYieldDelta: number;
  minControlPrimaryMargin: number;
  maxPrimaryRegressionForCostWin: number;
  minTrustedReviewersPerGeneration: number;
  requireUniqueConfirmationSets: boolean;
  requireSelectionConfirmationSeparation: boolean;
  requireAllControls: boolean;
}

export interface MultiGenerationProofExpectation {
  runId: string;
  rootId: string;
  gateDigest: string;
  trustedReviewerKeys: Record<string, string>;
  /** Digests frozen by an external owner before candidate outcomes are visible. Required for the
   *  strongest independent-confirmation classification; a self-applied evidenceClass label is not enough. */
  sealedConfirmationSetDigests?: string[];
}

export interface GenerationDerived {
  generation: number;
  capabilityImproved: boolean;
  primaryDelta: number;
  relativeCostReduction: number;
  parentImproverYield: number;
  childImproverYield: number;
  improverYieldDelta: number;
  controlPrimaryMargin: number;
  trustedReviewers: number;
}

export type ProofClass =
  | 'INVALID'
  | 'STRUCTURAL_MULTI_GENERATION'
  | 'SYNTHETIC_RECURSIVE_IMPROVER'
  | 'BOUNDED_RECURSIVE_IMPROVER'
  | 'INDEPENDENT_CONFIRMATION';

export interface MultiGenerationProofVerdict {
  pass: boolean;
  proofClass: ProofClass;
  recursiveImproverEvidence: boolean;
  independentConfirmation: boolean;
  failures: string[];
  derived: GenerationDerived[];
  evidenceDigest: string;
}

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export const DEFAULT_MULTIGEN_POLICY: MultiGenerationProofPolicy = {
  minGenerations: 3,
  minPrimaryDelta: 0.03,
  minRelativeCostReduction: 0.20,
  minImproverYieldDelta: 0.05,
  minControlPrimaryMargin: 0.01,
  maxPrimaryRegressionForCostWin: 0.00,
  minTrustedReviewersPerGeneration: 2,
  requireUniqueConfirmationSets: true,
  requireSelectionConfirmationSeparation: true,
  requireAllControls: true,
};

function finite(n: number): boolean {
  return Number.isFinite(n);
}

function validOutcome(o: Outcome): boolean {
  return finite(o.primary) &&
    finite(o.costPerWin) && o.costPerWin >= 0 &&
    Number.isInteger(o.safetyViolations) && o.safetyViolations >= 0 &&
    Number.isInteger(o.regressions) && o.regressions >= 0;
}

function validBudget(b: BudgetEnvelope): boolean {
  return Number.isInteger(b.attempts) && b.attempts > 0 &&
    Number.isInteger(b.evaluationCalls) && b.evaluationCalls >= 0 &&
    Number.isInteger(b.processStarts) && b.processStarts >= 0 &&
    Number.isInteger(b.tokenCeiling) && b.tokenCeiling >= 0 &&
    Number.isInteger(b.costMicroUsdCeiling) && b.costMicroUsdCeiling >= 0;
}

function sameBudget(a: BudgetEnvelope, b: BudgetEnvelope): boolean {
  return a.attempts === b.attempts &&
    a.evaluationCalls === b.evaluationCalls &&
    a.processStarts === b.processStarts &&
    a.tokenCeiling === b.tokenCeiling &&
    a.costMicroUsdCeiling === b.costMicroUsdCeiling;
}

function validProbe(p: ImproverProbe): boolean {
  return validBudget(p.budget) &&
    Number.isInteger(p.successfulSuccessors) &&
    p.successfulSuccessors >= 0 &&
    p.successfulSuccessors <= p.budget.attempts &&
    finite(p.bestSuccessorLift) &&
    finite(p.medianSuccessorLift) &&
    Number.isInteger(p.actualCostMicroUsd) &&
    p.actualCostMicroUsd >= 0 &&
    p.actualCostMicroUsd <= p.budget.costMicroUsdCeiling;
}

function yieldOf(p: ImproverProbe): number {
  return p.successfulSuccessors / p.budget.attempts;
}

function coreGeneration(g: GenerationEvidence): Omit<GenerationEvidence, 'reviewerAttestations'> {
  const { reviewerAttestations: _drop, ...core } = g;
  return core;
}

export function generationEvidenceDigest(runId: string, g: GenerationEvidence): string {
  return `sha256:${createHash('sha256').update(canon({ runId, generation: coreGeneration(g) })).digest('hex')}`;
}

export function multiGenerationEvidenceDigest(e: MultiGenerationEvidence): string {
  return `sha256:${createHash('sha256').update(canon({
    version: e.version,
    runId: e.runId,
    rootId: e.rootId,
    gateDigest: e.gateDigest,
    createdAt: e.createdAt,
    authority: e.authority,
    generations: e.generations.map(coreGeneration),
  })).digest('hex')}`;
}

function reviewerPayload(
  runId: string,
  g: GenerationEvidence,
  reviewerId: string,
): Record<string, unknown> {
  return {
    kind: 'multigen-generation-review',
    version: MULTIGEN_PROOF_VERSION,
    runId,
    generation: g.generation,
    parentId: g.parentId,
    childId: g.childId,
    evidenceDigest: generationEvidenceDigest(runId, g),
    reviewerId,
    verdict: 'ACCEPT',
    authority: MULTIGEN_AUTHORITY,
  };
}

export function reviewerAttestationPayload(
  runId: string,
  g: GenerationEvidence,
  reviewerId: string,
): Record<string, unknown> {
  return reviewerPayload(runId, g, reviewerId);
}

function validAttestation(
  runId: string,
  g: GenerationEvidence,
  a: ReviewerAttestation,
  trustedReviewerKeys: Record<string, string>,
): boolean {
  const trusted = trustedReviewerKeys[a.reviewerId];
  if (!trusted || trusted !== a.receipt.publicKey || !verifyReceipt(a.receipt)) return false;
  return canon(a.receipt.payload) === canon(reviewerPayload(runId, g, a.reviewerId));
}

function capabilityImproved(
  baseline: Outcome,
  child: Outcome,
  p: MultiGenerationProofPolicy,
): { improved: boolean; primaryDelta: number; relativeCostReduction: number } {
  const primaryDelta = child.primary - baseline.primary;
  const relativeCostReduction = baseline.costPerWin > 0
    ? (baseline.costPerWin - child.costPerWin) / baseline.costPerWin
    : (child.costPerWin === 0 ? 0 : -Infinity);

  const qualityWin = primaryDelta >= p.minPrimaryDelta && child.costPerWin <= baseline.costPerWin;
  const costWin = primaryDelta >= -p.maxPrimaryRegressionForCostWin &&
    relativeCostReduction >= p.minRelativeCostReduction;

  return { improved: qualityWin || costWin, primaryDelta, relativeCostReduction };
}

function exactControls(g: GenerationEvidence): boolean {
  const arms = new Set(g.controls.map((c) => c.arm));
  return arms.size === 4 &&
    arms.has('frozen') &&
    arms.has('static') &&
    arms.has('shuffled') &&
    arms.has('previous');
}

export function verifyMultiGenerationEvidence(
  e: MultiGenerationEvidence,
  expected: MultiGenerationProofExpectation,
  policy: MultiGenerationProofPolicy = DEFAULT_MULTIGEN_POLICY,
): MultiGenerationProofVerdict {
  const failures: string[] = [];
  const derived: GenerationDerived[] = [];

  if (e.version !== MULTIGEN_PROOF_VERSION) failures.push('version_mismatch');
  if (e.authority !== MULTIGEN_AUTHORITY) failures.push('authority_not_none');
  if (e.runId !== expected.runId) failures.push('run_id_mismatch');
  if (e.rootId !== expected.rootId) failures.push('root_id_mismatch');
  if (e.gateDigest !== expected.gateDigest) failures.push('gate_digest_mismatch');
  if (!DIGEST_RE.test(e.gateDigest)) failures.push('invalid_gate_digest');
  if (e.generations.length < policy.minGenerations) failures.push('too_few_generations');

  const seenChildIds = new Set<string>();
  const seenConfirm = new Set<string>();
  let expectedParent = e.rootId;
  let previousChild: Outcome | null = null;
  let previousChildImprover: ImproverProbe | null = null;
  let allRecursive = e.generations.length >= policy.minGenerations;
  let allIndependent = e.generations.length >= policy.minGenerations &&
    Array.isArray(expected.sealedConfirmationSetDigests) &&
    expected.sealedConfirmationSetDigests.length >= policy.minGenerations;
  const expectedSealed = new Set(expected.sealedConfirmationSetDigests ?? []);

  for (let i = 0; i < e.generations.length; i++) {
    const g = e.generations[i]!;
    const prefix = `gen${g.generation}:`;

    if (g.authority !== MULTIGEN_AUTHORITY) failures.push(`${prefix}authority_not_none`);
    if (g.generation !== i + 1) failures.push(`${prefix}noncontiguous_generation`);
    if (g.parentId !== expectedParent) failures.push(`${prefix}parent_chain_mismatch`);
    if (seenChildIds.has(g.childId)) failures.push(`${prefix}duplicate_child_id`);
    seenChildIds.add(g.childId);
    expectedParent = g.childId;

    if (![g.sourceDigest, g.selectionSetDigest, g.confirmationSetDigest].every((d) => DIGEST_RE.test(d))) {
      failures.push(`${prefix}invalid_digest`);
    }
    if (policy.requireSelectionConfirmationSeparation && g.selectionSetDigest === g.confirmationSetDigest) {
      failures.push(`${prefix}selection_confirmation_overlap`);
    }
    if (policy.requireUniqueConfirmationSets) {
      if (seenConfirm.has(g.confirmationSetDigest)) failures.push(`${prefix}confirmation_reused`);
      seenConfirm.add(g.confirmationSetDigest);
    }

    if (!validOutcome(g.baseline) || !validOutcome(g.child)) failures.push(`${prefix}invalid_outcome`);
    if (!validProbe(g.parentImprover) || !validProbe(g.childImprover)) failures.push(`${prefix}invalid_improver_probe`);
    if (!sameBudget(g.parentImprover.budget, g.childImprover.budget)) failures.push(`${prefix}unmatched_improver_budget`);

    if (previousChild && canon(previousChild) !== canon(g.baseline)) failures.push(`${prefix}baseline_not_prior_child`);
    if (previousChildImprover && canon(previousChildImprover) !== canon(g.parentImprover)) {
      failures.push(`${prefix}improver_not_prior_child`);
    }

    const cap = capabilityImproved(g.baseline, g.child, policy);
    if (!cap.improved) failures.push(`${prefix}capability_not_improved`);
    if (g.child.safetyViolations !== 0 || g.child.regressions !== 0) failures.push(`${prefix}protected_regression`);

    const parentYield = validProbe(g.parentImprover) ? yieldOf(g.parentImprover) : 0;
    const childYield = validProbe(g.childImprover) ? yieldOf(g.childImprover) : 0;
    const improverDelta = childYield - parentYield;
    if (improverDelta < policy.minImproverYieldDelta) {
      failures.push(`${prefix}improver_yield_not_improved`);
      allRecursive = false;
    }

    if (policy.requireAllControls && !exactControls(g)) failures.push(`${prefix}missing_controls`);
    let maxControlPrimary = -Infinity;
    for (const c of g.controls) {
      if (!validOutcome(c.outcome) || !validProbe(c.improver)) failures.push(`${prefix}invalid_control`);
      if (!sameBudget(g.childImprover.budget, c.improver.budget)) failures.push(`${prefix}unmatched_control_budget`);
      maxControlPrimary = Math.max(maxControlPrimary, c.outcome.primary);
    }
    const controlMargin = g.controls.length ? g.child.primary - maxControlPrimary : -Infinity;
    if (g.controls.length && controlMargin < policy.minControlPrimaryMargin) failures.push(`${prefix}control_margin_too_small`);

    const validReviewerIds = new Set<string>();
    for (const a of g.reviewerAttestations) {
      if (validAttestation(e.runId, g, a, expected.trustedReviewerKeys)) validReviewerIds.add(a.reviewerId);
    }
    const trustedReviewers = validReviewerIds.size;
    if (trustedReviewers < policy.minTrustedReviewersPerGeneration) {
      failures.push(`${prefix}insufficient_trusted_reviewers`);
      allIndependent = false;
    }
    if (g.evidenceClass !== 'independent_confirmation' || !expectedSealed.has(g.confirmationSetDigest)) {
      allIndependent = false;
    }

    derived.push({
      generation: g.generation,
      capabilityImproved: cap.improved,
      primaryDelta: cap.primaryDelta,
      relativeCostReduction: cap.relativeCostReduction,
      parentImproverYield: parentYield,
      childImproverYield: childYield,
      improverYieldDelta: improverDelta,
      controlPrimaryMargin: controlMargin,
      trustedReviewers,
    });

    previousChild = g.child;
    previousChildImprover = g.childImprover;
  }

  const structuralFailures = failures.filter((f) =>
    !f.includes('insufficient_trusted_reviewers') &&
    !f.includes('improver_yield_not_improved')
  );
  const structuralPass = structuralFailures.length === 0;
  const recursiveImproverEvidence = structuralPass && allRecursive;
  const independentConfirmation = recursiveImproverEvidence && allIndependent;

  let proofClass: ProofClass = 'INVALID';
  if (independentConfirmation) proofClass = 'INDEPENDENT_CONFIRMATION';
  else if (recursiveImproverEvidence) {
    const allSynthetic = e.generations.every((g) => g.evidenceClass === 'synthetic');
    proofClass = allSynthetic ? 'SYNTHETIC_RECURSIVE_IMPROVER' : 'BOUNDED_RECURSIVE_IMPROVER';
  } else if (structuralPass) proofClass = 'STRUCTURAL_MULTI_GENERATION';

  return {
    pass: failures.length === 0,
    proofClass,
    recursiveImproverEvidence,
    independentConfirmation,
    failures,
    derived,
    evidenceDigest: multiGenerationEvidenceDigest(e),
  };
}
