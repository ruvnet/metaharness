// SPDX-License-Identifier: MIT

export type EvolvableSurface =
  | 'retrievalPolicy'
  | 'modelRouting'
  | 'contextPolicy'
  | 'testPolicy'
  | 'repairStrategy';

export type ActionKind =
  | 'inspect'
  | 'search'
  | 'hypothesize'
  | 'edit'
  | 'execute'
  | 'evaluate'
  | 'revert'
  | 'branch'
  | 'consultMemory'
  | 'commit';

export type VariationAction =
  | { kind: 'inspect'; path: string }
  | { kind: 'search'; query: string; paths?: string[] }
  | { kind: 'hypothesize'; hypothesis: Hypothesis }
  | { kind: 'edit'; path: string; content: string; surface: EvolvableSurface }
  | { kind: 'execute'; command: string }
  | { kind: 'evaluate' }
  | { kind: 'revert'; checkpointId?: string }
  | { kind: 'branch'; parentCandidateId: string }
  | { kind: 'consultMemory'; query: string; limit?: number }
  | { kind: 'commit'; summary: string };

export interface Hypothesis {
  id: string;
  statement: string;
  causalMechanism: string;
  expectedEvidence: string[];
  surface: EvolvableSurface;
}

export interface EvaluationResult {
  evaluatorVersion: string;
  correct: boolean;
  safe: boolean;
  replayable: boolean;
  noRegression: boolean;
  budgetValid: boolean;
  quality: number;
  costUsd: number;
  wallTimeMs: number;
  policyViolations: number;
  rollbackRequired?: boolean;
  protectedTestsPassed: boolean;
  scoreSamples?: number[];
  lowerConfidenceBound?: number;
  evidence: Record<string, unknown>;
  failureSignature?: string;
}

export interface Candidate {
  id: string;
  parentId: string | null;
  branchId: string;
  workspaceDigest: string;
  evaluation: EvaluationResult;
  novelty: number;
  visits: number;
  learningPotential: number;
  risk: number;
  committed: boolean;
}

export interface PolicyDecision {
  verdict: 'allow' | 'deny' | 'require-approval';
  reason: string;
  policyVersion: string;
  riskCharge: number;
}

export interface ActionObservation {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs: number;
  costUsd: number;
  workspaceDigest: string;
  data?: unknown;
  failureSignature?: string;
}

export interface ActionReceipt {
  sequence: number;
  previousStateHash: string;
  stateHash: string;
  action: VariationAction;
  observation: ActionObservation;
  policyDecision: PolicyDecision;
  workspaceDigest: string;
  costUsd: number;
  signature: string;
  signer: string;
}

export interface ResourceBudget {
  maxActions: number;
  maxBranchActions: number;
  maxCostUsd: number;
  maxWallTimeMs: number;
  riskBudget: number;
}

export interface BudgetState extends ResourceBudget {
  actionsUsed: number;
  branchActionsUsed: number;
  costUsdUsed: number;
  wallTimeMsUsed: number;
  riskUsed: number;
}

export interface ProtectedInvariants {
  immutableCapabilities: string[];
  protectedPaths: string[];
  promotionDelta: number;
  requireSignedReceipts: boolean;
  requireZeroPolicyViolations: boolean;
}

export interface StructuredMemoryRecord {
  id: string;
  type: 'hypothesis' | 'tool-receipt' | 'evaluator-result' | 'counterexample' | 'lineage' | 'rejected-lesson';
  hypothesis?: Hypothesis;
  supportingObservations: string[];
  contradictingObservations: string[];
  actionsAttempted: ActionKind[];
  evaluation?: EvaluationResult;
  failureSignatures: string[];
  promotionDecision?: string;
  rollbackDecision?: string;
  lineageReferences: string[];
  costUsd: number;
  latencyMs: number;
  /** Raw private reasoning is deliberately absent. */
}

export interface SupervisorIntervention {
  trigger: 'plateau' | 'repeated-failure' | 'low-novelty' | 'cost-progress';
  reason: string;
  dominantFailure?: string;
  alternateCandidateId?: string;
  strategies: [Hypothesis, Hypothesis, Hypothesis];
  explorationAllocation: number;
  policyVersion: string;
}

export interface VariationState {
  schema: 1;
  runId: string;
  task: string;
  stateHash: string;
  currentCandidateId: string;
  currentBranchId: string;
  currentHypothesis: Hypothesis | null;
  receipts: ActionReceipt[];
  evaluations: EvaluationResult[];
  candidates: Candidate[];
  memoryUpdates: StructuredMemoryRecord[];
  rejectedLessons: StructuredMemoryRecord[];
  interventions: SupervisorIntervention[];
  budget: BudgetState;
  memoryCursor: string | null;
  pendingApprovals: string[];
  startedAt: string;
}

export interface VariationContext {
  task: string;
  state: Readonly<VariationState>;
  candidate: Candidate;
  recentObservations: ActionObservation[];
  memories: StructuredMemoryRecord[];
  knowledge: unknown[];
  allowedSurfaces: readonly EvolvableSurface[];
}

export interface VariationResult {
  winner: Candidate | null;
  lineage: Candidate[];
  receipts: ActionReceipt[];
  evaluatorEvidence: EvaluationResult[];
  memoryUpdates: StructuredMemoryRecord[];
  checkpoint: VariationCheckpoint;
  failureReport?: string;
}

export interface VariationCheckpoint {
  schema: 1;
  runtimeVersion: string;
  policyVersion: string;
  evaluatorVersion: string;
  state: VariationState;
  checkpointHash: string;
  signature: string;
  signer: string;
  rvfManifestPath?: string;
}
