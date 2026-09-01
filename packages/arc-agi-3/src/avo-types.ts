import type {
  ActResult,
  ArcAction,
  ArcCheckpoint,
  ArcControllerOptions,
  ArcControllerStatus,
  ArcEpisode,
  ArcSupervisorAuthority,
  ExactArcObservation,
  FrontierEdge,
  GuardedPlanStep,
  MemoryQueryResult,
  SemanticRule,
  SemanticRuleKind,
  SemanticRuleScope,
  SupervisorCaseBundle,
  SupervisorDirectiveCommit,
} from './types.js';
import type { ArcController } from './controller.js';

export type ArcAblationArm =
  | 'DIRECT_ACTOR'
  | 'AVO_LINEAGE'
  | 'AVO_MEMORY'
  | 'AVO_SUPERVISOR_MEMORY'
  | 'AVO_FULL'
  | 'AVO_FULL_RETRODICTION'
  | 'CUSTOM';

export interface ArcAvoFeatures {
  readonly candidatePlanSelection: boolean;
  readonly planLineage: boolean;
  readonly semanticRuleMemory: boolean;
  readonly beliefFrontier: boolean;
  readonly supervisorGate: 'OFF' | 'BLOCKING';
  readonly guardedExecution: boolean;
  readonly retrodictiveWorldModel: boolean;
}

export interface ArcPlanSelectorWeights {
  readonly expectedProgress: number;
  readonly predictionFit: number;
  readonly novelty: number;
  readonly ruleConfidence: number;
  readonly noEffectRisk: number;
  readonly actionCost: number;
}

export interface ArcAvoConfigInput {
  readonly arm: ArcAblationArm;
  /** Required only for CUSTOM and forbidden for named arms. */
  readonly features?: ArcAvoFeatures;
  readonly maxCandidatesPerDecision?: number;
  readonly maxPlanSteps?: number;
  readonly supportErrorMax?: number;
  readonly contradictionErrorMin?: number;
  readonly selector?: Partial<ArcPlanSelectorWeights>;
}

export interface ArcAvoConfig {
  readonly arm: ArcAblationArm;
  readonly features: ArcAvoFeatures;
  readonly maxCandidatesPerDecision: number;
  readonly maxPlanSteps: number;
  readonly supportErrorMax: number;
  readonly contradictionErrorMin: number;
  readonly selector: ArcPlanSelectorWeights;
  readonly configHash: string;
}

export interface ArcRuleHypothesisDraft {
  /** Existing semantic-rule id when revising a rule; omitted for a new rule. */
  readonly id?: string;
  readonly scope: SemanticRuleScope;
  readonly kind: SemanticRuleKind;
  readonly statement: string;
  readonly preconditions: readonly string[];
  readonly predictedEffect: string;
}

export interface ArcCandidatePlanDraft {
  readonly parentCandidateId: string | null;
  readonly baseObservationHash: string;
  /** Concise public hypothesis, never private chain of thought. */
  readonly hypothesis: string;
  readonly citedRuleIds: readonly string[];
  readonly ruleHypotheses: readonly ArcRuleHypothesisDraft[];
  readonly steps: readonly GuardedPlanStep[];
}

export interface ArcCandidatePlan extends ArcCandidatePlanDraft {
  readonly id: string;
  readonly depth: number;
  readonly candidateHash: string;
}

export interface ArcPlanScore {
  readonly expectedProgress: number;
  readonly predictionFit: number;
  readonly novelty: number;
  readonly ruleConfidence: number;
  readonly noEffectRisk: number;
  readonly normalizedActionCost: number;
  readonly utility: number;
}

export interface ArcPlanSelection {
  readonly observationHash: string;
  readonly offeredCandidateIds: readonly string[];
  readonly eligibleCandidateIds: readonly string[];
  readonly rejectionCodes: Readonly<Record<string, string>>;
  readonly scores: Readonly<Record<string, ArcPlanScore>>;
  readonly selectedCandidateId: string;
  readonly configHash: string;
  readonly selectionHash: string;
}

export interface ArcPlanOutcome {
  readonly candidateId: string;
  readonly selectionHash: string;
  readonly coreReceiptHashes: readonly string[];
  readonly retrodictionHashes: readonly string[];
  readonly stopReason: 'COMPLETED' | 'DIVERGED' | 'ACTION_REJECTED';
  readonly previousOutcomeHash: string;
  readonly outcomeHash: string;
}

export interface ArcPlanArchiveSnapshot {
  readonly schema: 'metaharness.arc_agi_3.plan_archive.v1';
  readonly candidates: readonly ArcCandidatePlan[];
  readonly selections: readonly ArcPlanSelection[];
  readonly outcomes: readonly ArcPlanOutcome[];
  readonly lineageHeadId?: string;
  readonly outcomeHeadHash: string;
  readonly archiveHash: string;
}

export type ArcRetrodictionVerdict = 'SUPPORTED' | 'INCONCLUSIVE' | 'CONTRADICTED';

export interface ArcRetrodiction {
  readonly selectionHash: string;
  readonly candidateId: string;
  readonly coreReceiptHash: string;
  readonly action: ArcAction;
  readonly predictionError: number;
  readonly verdict: ArcRetrodictionVerdict;
  readonly supportedRuleIds: readonly string[];
  readonly contradictedRuleIds: readonly string[];
  readonly previousRetrodictionHash: string;
  readonly retrodictionHash: string;
}

export interface ArcWorldModelSnapshot {
  readonly schema: 'metaharness.arc_agi_3.world_model.v1';
  readonly modelVersion: 'evidence-retrodiction-v1';
  readonly records: readonly ArcRetrodiction[];
  readonly headHash: string;
  readonly snapshotHash: string;
}

export interface ArcAvoContext {
  readonly config: ArcAvoConfig;
  readonly observation: ExactArcObservation;
  readonly status: ArcControllerStatus;
  readonly memory: MemoryQueryResult;
  readonly frontier: readonly FrontierEdge[];
  readonly lineageHeadId?: string;
  readonly recentCandidates: readonly ArcCandidatePlan[];
  readonly recentOutcomes: readonly ArcPlanOutcome[];
  readonly recentRetrodictions: readonly ArcRetrodiction[];
}

export interface ArcAvoPlanner {
  readonly version: string;
  propose(
    context: Readonly<ArcAvoContext>,
  ): Promise<readonly ArcCandidatePlanDraft[]>;
}

export interface ArcAvoSupervisor {
  readonly version: string;
  review(
    bundle: Readonly<SupervisorCaseBundle>,
  ): Promise<SupervisorDirectiveCommit>;
}

export interface ArcAvoLoopOptions {
  /** Supply exactly one controller source. Injected controllers remain externally owned. */
  readonly controllerOptions?: ArcControllerOptions;
  readonly controller?: ArcController;
  readonly config: ArcAvoConfig | ArcAvoConfigInput;
  /** Optional for ChatGPT UI, which submits candidate drafts explicitly. */
  readonly planner?: ArcAvoPlanner;
  /** Omit for a separate external boss lane. The blocking gate still applies. */
  readonly supervisor?: ArcAvoSupervisor;
}

export interface ArcAvoStepResult {
  readonly selection: ArcPlanSelection;
  readonly candidate: ArcCandidatePlan;
  readonly completed: readonly ActResult[];
  readonly stopReason: ArcPlanOutcome['stopReason'];
  readonly retrodictions: readonly ArcRetrodiction[];
  readonly updatedRules: readonly SemanticRule[];
  readonly context: ArcAvoContext;
}

export interface ArcAvoCheckpointBody {
  readonly schema: 'metaharness.arc_agi_3.avo_checkpoint.v1';
  readonly config: ArcAvoConfig;
  readonly plannerVersion: string;
  readonly supervisorVersion?: string;
  readonly observationHash: string;
  /** Authoritative core-receipt prefix that predates an injected loop. */
  readonly coreReceiptBaselineCount: number;
  readonly coreReceiptBaselineHeadHash: string;
  readonly coreCheckpoint: ArcCheckpoint;
  readonly archive: ArcPlanArchiveSnapshot;
  readonly worldModel: ArcWorldModelSnapshot;
}

export interface ArcAvoCheckpoint extends ArcAvoCheckpointBody {
  readonly checkpointHash: string;
}

export interface ArcAvoLoopApi {
  start(): Promise<ArcAvoContext>;
  context(): ArcAvoContext;
  step(): Promise<ArcAvoStepResult>;
  stepWithCandidates(
    candidates: readonly ArcCandidatePlanDraft[],
  ): Promise<ArcAvoStepResult>;
  checkpoint(): Promise<ArcAvoCheckpoint>;
  resume(checkpoint: ArcAvoCheckpoint): Promise<ArcAvoContext>;
  status(): ArcControllerStatus;
  asSupervisor(): ArcSupervisorAuthority;
  close(): Promise<void>;
}

export interface ArcPlanScoringEvidence {
  readonly observation: ExactArcObservation;
  readonly frontier: readonly FrontierEdge[];
  readonly episodes: readonly ArcEpisode[];
  readonly rules: readonly SemanticRule[];
  readonly retrodictions: readonly ArcRetrodiction[];
}
