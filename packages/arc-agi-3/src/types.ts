export interface ArcSessionLog {
  append(kind: string, payload: unknown): Promise<unknown>;
  stateHash(): string;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type GameState = 'NOT_PLAYED' | 'NOT_FINISHED' | 'WIN' | 'GAME_OVER';

export type ArcActionName =
  | 'RESET'
  | 'ACTION1'
  | 'ACTION2'
  | 'ACTION3'
  | 'ACTION4'
  | 'ACTION5'
  | 'ACTION6'
  | 'ACTION7';

export type ArcSimpleActionName = Exclude<ArcActionName, 'ACTION6'>;

export type ArcAction =
  | { readonly name: ArcSimpleActionName }
  | { readonly name: 'ACTION6'; readonly x: number; readonly y: number };

export interface RawGridFrame {
  readonly width: number;
  readonly height: number;
  readonly cells: readonly (readonly number[])[];
  readonly frameIndex?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RawArcObservation {
  readonly state: GameState;
  readonly levelsCompleted: number;
  readonly winLevels: number;
  readonly availableActions: readonly ArcActionName[];
  /** Every frame returned by the environment, in animation order. */
  readonly frames: readonly RawGridFrame[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExactGridFrame {
  readonly frameIndex: number;
  readonly width: number;
  readonly height: number;
  readonly encoding: 'hex_rows_v1';
  readonly rows: readonly string[];
  readonly frameHash: string;
  readonly frameRef: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ExactArcObservation {
  /** Opaque isolation key. Raw game IDs, titles, and versions are never exposed. */
  readonly opaqueGameScope: string;
  readonly state: GameState;
  readonly levelsCompleted: number;
  readonly winLevels: number;
  readonly availableActions: readonly ArcActionName[];
  readonly frames: readonly ExactGridFrame[];
  readonly currentFrame: ExactGridFrame;
  /** Hash of observable state, independent of animation history and metadata. */
  readonly observationHash: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ArcEnvironment {
  /** Initial full reset. This operation is not counted as an ARC action. */
  reset(): Promise<RawArcObservation>;
  /** Read current state without mutating it. */
  observe(): Promise<RawArcObservation>;
  /** Submit one scored environment action, including recovery RESET actions. */
  step(action: ArcAction): Promise<RawArcObservation>;
  checkpoint?(): Promise<JsonValue>;
  resume?(checkpoint: JsonValue): Promise<RawArcObservation>;
  close?(): Promise<void>;
}

export interface ExpectedCellChange {
  readonly x: number;
  readonly y: number;
  readonly before?: number;
  readonly after?: number;
}

export interface ActionExpectation {
  readonly confidence: number;
  readonly hypothesisIds?: readonly string[];
  readonly expectedObservationHash?: string;
  readonly expectedState?: GameState;
  readonly expectedLevelsCompleted?: number;
  readonly expectedFrameHash?: string;
  readonly expectedChanges?: readonly ExpectedCellChange[];
  /** Concise public rationale, not private chain of thought. */
  readonly rationale?: string;
}

export interface ActRequest {
  readonly expectedObservationHash: string;
  readonly idempotencyKey: string;
  readonly action: ArcAction;
  readonly expectation: ActionExpectation;
  readonly directiveId?: string;
}

export interface ExactCellDelta {
  readonly x: number;
  readonly y: number;
  readonly before: number;
  readonly after: number;
}

export interface TransitionReceipt {
  readonly schema: 'metaharness.arc_agi_3.transition.v1';
  readonly runId: string;
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly sequence: number;
  readonly episodeId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly directiveId?: string;
  readonly createdAtMs: number;
  readonly visibleModelLabel: string;
  readonly promptSnapshotHash: string;
  readonly toolSchemaHash: string;
  readonly controllerVersion: string;
  readonly environmentAdapterVersion: string;
  readonly runManifestHash: string;
  readonly memorySnapshotHash: string;
  readonly preObservationHash: string;
  readonly postObservationHash: string;
  readonly preBeliefKey: string;
  readonly postBeliefKey: string;
  readonly stateBefore: GameState;
  readonly stateAfter: GameState;
  readonly levelsCompletedBefore: number;
  readonly levelsCompletedAfter: number;
  readonly action: ArcAction;
  readonly expectation: ActionExpectation;
  readonly exactDelta: readonly ExactCellDelta[];
  /** Full exact animation sequence returned by this action. */
  readonly frames: readonly ExactGridFrame[];
  readonly returnedFrameRefs: readonly string[];
  readonly predictionError: number;
  readonly noEffect: boolean;
  readonly previousReceiptHash: string;
  readonly receiptHash: string;
}

export interface ReceiptVerificationSuccess {
  readonly ok: true;
  readonly count: number;
  readonly headHash: string;
}

export interface ReceiptVerificationFailure {
  readonly ok: false;
  readonly count: number;
  readonly brokenAt: number;
  readonly reason: string;
}

export type ReceiptVerification = ReceiptVerificationSuccess | ReceiptVerificationFailure;

export interface OfficialReceiptCounts {
  /** Official ACTION1..ACTION7 count; RESET is reported separately. */
  readonly actionCount: number;
  /** Official scored RESET actions, excluding the initial full reset. */
  readonly resetCount: number;
  readonly expectedReceiptHeadHash: string;
}

export interface ReceiptReconciliation {
  readonly ok: boolean;
  readonly chain: ReceiptVerification;
  readonly recordedActionCount: number;
  readonly recordedResetCount: number;
  readonly recordedTransitionCount: number;
  readonly officialActionCount: number;
  readonly officialResetCount: number;
  readonly officialTransitionCount: number;
  readonly headMatches: boolean;
  readonly uncertainMutationCount: number;
  readonly reason?: string;
}

export interface ArcEpisode {
  readonly id: string;
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly receiptHash: string;
  readonly sequence: number;
  readonly preBeliefKey: string;
  readonly postBeliefKey: string;
  readonly preObservationHash: string;
  readonly postObservationHash: string;
  readonly action: ArcAction;
  readonly effectClass: 'NO_EFFECT' | 'GRID_CHANGE' | 'PROGRESS' | 'TERMINAL';
  readonly progressDelta: number;
  readonly predictionError: number;
  readonly noEffect: boolean;
}

export type SemanticRuleScope = 'LEVEL' | 'GAME' | 'GENERIC';
export type SemanticRuleKind =
  | 'ACTION_MAP'
  | 'OBJECT_ROLE'
  | 'TRANSITION'
  | 'GOAL'
  | 'CONSTRAINT'
  | 'STRATEGY';
export type SemanticRuleStatus = 'CANDIDATE' | 'ACTIVE' | 'FALSIFIED' | 'SUPERSEDED';

export interface SemanticRule {
  readonly id: string;
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly version: number;
  readonly scope: SemanticRuleScope;
  readonly kind: SemanticRuleKind;
  readonly statement: string;
  readonly preconditions: readonly string[];
  readonly predictedEffect: string;
  readonly supportingReceiptHashes: readonly string[];
  readonly contradictingReceiptHashes: readonly string[];
  readonly alpha: number;
  readonly beta: number;
  readonly status: SemanticRuleStatus;
  readonly previousVersionHash?: string;
  readonly commitHash: string;
  readonly ruleHash: string;
}

export interface SemanticRuleCommit {
  readonly id?: string;
  readonly scope: SemanticRuleScope;
  readonly kind: SemanticRuleKind;
  readonly statement: string;
  readonly preconditions?: readonly string[];
  readonly predictedEffect: string;
  readonly supportingReceiptHashes?: readonly string[];
  readonly contradictingReceiptHashes?: readonly string[];
  readonly status?: SemanticRuleStatus;
}

export interface MemoryQuery {
  readonly scope?: SemanticRuleScope;
  readonly kind?: SemanticRuleKind;
  readonly status?: SemanticRuleStatus;
  readonly receiptHash?: string;
  readonly text?: string;
  readonly limit?: number;
}

export interface MemoryQueryResult {
  readonly episodes: readonly ArcEpisode[];
  readonly rules: readonly SemanticRule[];
}

export interface BeliefNode {
  readonly key: string;
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly observationHash: string;
  readonly frameHash: string;
  readonly latentContextHash: string;
  readonly state: GameState;
  readonly levelsCompleted: number;
  readonly availableActions: readonly ArcActionName[];
  readonly visits: number;
}

export interface BeliefOutcome {
  readonly toBeliefKey: string;
  readonly receiptHashes: readonly string[];
  readonly count: number;
}

export interface BeliefEdge {
  readonly key: string;
  readonly fromBeliefKey: string;
  readonly observationHash: string;
  readonly action: ArcAction;
  readonly outcomes: readonly BeliefOutcome[];
  readonly testedCount: number;
  readonly noEffectCount: number;
}

export interface FrontierEdge {
  readonly fromBeliefKey: string;
  readonly observationHash: string;
  readonly actionName: ArcActionName;
  readonly testedCount: number;
  readonly noveltyPriority: number;
}

export type SupervisorTrigger =
  | 'GAME_OVER'
  | 'PLAN_DIVERGENCE'
  | 'MODEL_CONTRADICTION'
  | 'REPEATED_EDGE'
  | 'NO_EFFECT'
  | 'PREDICTION_ERROR'
  | 'STAGNATION'
  | 'CYCLE'
  | 'COORDINATE_PROBE';

export type SupervisorMode =
  | 'CONTINUE'
  | 'FALSIFY_RULE'
  | 'EXPAND_FRONTIER'
  | 'REBUILD_MODEL'
  | 'ROLLBACK_PLAN'
  | 'RESET'
  | 'NEW_ACTOR_CONTEXT'
  | 'STOP';

export interface SupervisorThresholds {
  readonly repeatedEdgeCount: number;
  readonly noEffectCount: number;
  readonly noEffectWindow: number;
  readonly predictionErrorMean: number;
  readonly predictionErrorWindow: number;
  readonly stagnationWindow: number;
  readonly cycleWithinComponentCount: number;
  readonly coordinateProbeCount: number;
}

export interface SupervisorCase {
  readonly id: string;
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly trigger: SupervisorTrigger;
  readonly openedAtSequence: number;
  readonly evidenceReceiptHashes: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly status: 'OPEN' | 'RESOLVED';
  readonly caseHash: string;
}

export interface SupervisorDirective {
  readonly id: string;
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly caseId: string;
  /** Optimistic-concurrency guard captured by the separate supervisor lane. */
  readonly caseHash: string;
  readonly expectedObservationHash: string;
  readonly observationHash: string;
  readonly trigger: SupervisorTrigger;
  readonly mode: SupervisorMode;
  readonly diagnosis: string;
  readonly requiredEvidence: readonly string[];
  readonly prohibitedEdges: readonly string[];
  readonly actionBudget: number;
  readonly expiresAfterActions: number;
  readonly hypotheses?: readonly [
    SupervisorHypothesis,
    SupervisorHypothesis,
    SupervisorHypothesis,
  ];
  readonly recommendedStrategy?: string;
  readonly constraints?: readonly string[];
  readonly committedAtSequence: number;
  readonly commitHash: string;
  readonly directiveHash: string;
}

export interface SupervisorDirectiveCommit {
  readonly caseId: string;
  readonly caseHash: string;
  /** Current boss-visible observation. `observationHash` is an auditable alias. */
  readonly expectedObservationHash: string;
  readonly observationHash?: string;
  readonly mode: SupervisorMode;
  readonly diagnosis: string;
  readonly requiredEvidence?: readonly string[];
  readonly prohibitedEdges?: readonly string[];
  readonly actionBudget: number;
  readonly expiresAfterActions: number;
  readonly hypotheses?: readonly [
    SupervisorHypothesis,
    SupervisorHypothesis,
    SupervisorHypothesis,
  ];
  readonly recommendedStrategy?: string;
  readonly constraints?: readonly string[];
}

export interface SupervisorHypothesis {
  readonly hypothesis: string;
  readonly evidenceReceiptHashes: readonly string[];
  readonly falsifier: string;
  readonly proposedNextAction: ArcAction;
}

export interface ExplicitSupervisorCaseRequest {
  readonly trigger: 'MODEL_CONTRADICTION';
  readonly evidenceReceiptHashes: readonly string[];
  readonly metrics?: Readonly<Record<string, number>>;
}

export interface SupervisorReceiptSummary {
  readonly count: number;
  readonly headHash: string;
  readonly recent: readonly Pick<
    TransitionReceipt,
    | 'receiptHash'
    | 'sequence'
    | 'action'
    | 'preObservationHash'
    | 'postObservationHash'
    | 'predictionError'
    | 'noEffect'
  >[];
}

export interface SupervisorCaseBundle {
  readonly case: SupervisorCase;
  readonly observation: ExactArcObservation;
  readonly memory: MemoryQueryResult;
  readonly graphFrontier: readonly FrontierEdge[];
  readonly receiptSummary: SupervisorReceiptSummary;
}

export interface ObservationPostcondition {
  readonly expectedObservationHash?: string;
  readonly expectedFrameHash?: string;
  readonly state?: GameState;
  readonly levelsCompleted?: number;
}

export interface GuardedPlanStep extends ActRequest {
  readonly postcondition: ObservationPostcondition;
}

export interface GuardedPlanRequest {
  readonly planId: string;
  readonly steps: readonly GuardedPlanStep[];
}

export interface ActResult {
  readonly observation: ExactArcObservation;
  readonly receipt: TransitionReceipt;
  /** True when the idempotency ledger returned a prior result without acting. */
  readonly replayed: boolean;
}

export interface GuardedPlanResult {
  readonly planId: string;
  readonly completed: readonly ActResult[];
  readonly stopReason: 'COMPLETED' | 'DIVERGED' | 'ACTION_REJECTED';
  readonly divergenceAt?: number;
  readonly error?: string;
}

export interface StoredIdempotencyResult {
  readonly key: string;
  readonly requestHash: string;
  readonly result: ActResult;
}

/** Content-addressed exact frame stored once per checkpoint. */
export interface CheckpointFrameBlob {
  readonly blobHash: string;
  readonly frame: ExactGridFrame;
}

/** Receipt body with exact frames replaced by content-addressed blob hashes. */
export type CheckpointTransitionReceipt = Omit<TransitionReceipt, 'frames'> & {
  readonly frameBlobHashes: readonly string[];
};

export type CheckpointObservation = Omit<ExactArcObservation, 'frames' | 'currentFrame'> & {
  readonly frameBlobHashes: readonly string[];
  readonly currentFrameBlobHash: string;
};

export interface CheckpointIdempotencyResult {
  readonly key: string;
  readonly requestHash: string;
  readonly receiptHash: string;
  readonly observation: CheckpointObservation;
}

export interface SemanticMemorySnapshot {
  readonly rules: readonly SemanticRule[];
}

export interface BeliefGraphSnapshot {
  readonly nodes: readonly BeliefNode[];
  readonly edges: readonly BeliefEdge[];
  readonly currentBeliefKey?: string;
}

export interface ArcCheckpointBody {
  readonly schema: 'metaharness.arc_agi_3.checkpoint.v1';
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly createdAtMs: number;
  readonly startedAtMs: number;
  readonly runManifest: ArcRunManifest;
  readonly budget: ArcRunBudget;
  readonly observation: ExactArcObservation;
  readonly receipts: readonly CheckpointTransitionReceipt[];
  readonly frameBlobs: readonly CheckpointFrameBlob[];
  readonly episodes: readonly ArcEpisode[];
  readonly memory: SemanticMemorySnapshot;
  readonly memorySnapshotHash: string;
  readonly graph: BeliefGraphSnapshot;
  readonly idempotency: readonly CheckpointIdempotencyResult[];
  readonly supervisorCases: readonly SupervisorCase[];
  readonly directives: readonly SupervisorDirective[];
  readonly activeDirectiveId?: string;
  readonly uncertainMutationCount: number;
  readonly phase: 'ACTIVE' | 'WON' | 'FAULTED' | 'CLOSED';
  readonly lastError?: string;
  readonly closed: boolean;
  /** Exact adapter state, or explicit `null` when the adapter cannot resume. */
  readonly environmentCheckpoint: JsonValue;
  readonly sessionStateHash?: string;
}

export interface ArcCheckpoint extends ArcCheckpointBody {
  readonly checkpointHash: string;
}

export interface ArcControllerStatus {
  readonly principalScope: string;
  readonly opaqueGameScope: string;
  readonly runId: string;
  readonly phase: 'NEW' | 'ACTIVE' | 'WON' | 'FAULTED' | 'CLOSED';
  readonly gameState?: GameState;
  readonly observationHash?: string;
  readonly currentBeliefKey?: string;
  readonly actionCount: number;
  readonly uncertainMutationCount: number;
  readonly startedAtMs?: number;
  readonly maxActions: number;
  readonly remainingActions: number;
  readonly maxWallTimeMs: number;
  readonly remainingWallTimeMs: number;
  readonly budgetExhausted: boolean;
  readonly receiptCount: number;
  readonly episodeCount: number;
  readonly ruleCount: number;
  readonly openSupervisorCaseId?: string;
  readonly activeDirectiveId?: string;
  readonly stopped: boolean;
  readonly closed: boolean;
  readonly lastError?: string;
}

export interface ArcControllerOptions {
  readonly principalId: string;
  readonly runId: string;
  /** Already-hashed private version identity used only to derive opaqueGameScope. */
  readonly gameVersionHash?: string;
  readonly environment: ArcEnvironment;
  readonly runManifest: ArcRunManifest;
  readonly budget?: Partial<ArcRunBudget>;
  readonly sessionLog?: ArcSessionLog;
  readonly supervisorThresholds?: Partial<SupervisorThresholds>;
  readonly clock?: () => number;
}

export interface ArcRunManifest {
  /** User-selected UI label. Evidence only, not a provider attestation. */
  readonly visibleModelLabel: string;
  readonly promptSnapshotHash: string;
  readonly toolSchemaHash: string;
  readonly controllerVersion?: string;
  /** Exact SDK/bridge/adapter configuration label used for this run. */
  readonly environmentAdapterVersion: string;
}

export interface ArcRunBudget {
  readonly maxActions: number;
  readonly maxWallTimeMs: number;
}

/** Narrow capability for a separate boss conversation. It cannot act. */
export interface ArcSupervisorAuthority {
  /** Pure read. Returns the current or deterministically detected case bundle. */
  supervisorCaseBundle(): SupervisorCaseBundle | null;
  openSupervisorCase(request?: ExplicitSupervisorCaseRequest): SupervisorCaseBundle | null;
  commitSupervisorDirective(input: SupervisorDirectiveCommit): Promise<SupervisorDirective>;
  queryMemory(query?: MemoryQuery): MemoryQueryResult;
  graphFrontier(limit?: number): readonly FrontierEdge[];
  status(): ArcControllerStatus;
}
