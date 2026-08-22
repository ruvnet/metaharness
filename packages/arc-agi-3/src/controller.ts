import { BeliefGraph, observableEdgeKey } from './belief-graph.js';
import {
  ArcValidationError,
  MAX_ARC_RUN_ACTIONS,
  containsRawGameIdentityKey,
  deriveGameIdentityHash,
  exactCellDelta,
  exactObservationFromRaw,
  hashArcValue,
  opaqueGameScopeFor,
  predictionError,
  principalScopeFor,
  snapshotArcJson,
  validateArcAction,
  validateExpectation,
  validateArcRunBudget,
} from './canonical.js';
import {
  compactCheckpointEvidence,
  createArcCheckpoint,
  hydrateCheckpointIdempotency,
  hydrateCheckpointReceipts,
  verifyArcCheckpoint,
} from './checkpoint.js';
import {
  EvidenceBackedMemory,
  appendEpisodeMemoryHead,
  appendSemanticMemoryHead,
  combineMemorySnapshotHeads,
  initialMemorySnapshotHeads,
  memorySnapshotHeadsFor,
  type MemoryCommitmentScope,
  type MemorySnapshotHeads,
} from './memory.js';
import {
  appendTransitionReceipt,
  reconcileTransitionReceipts,
  TRANSITION_RECEIPT_GENESIS,
  verifyTransitionReceipts,
} from './receipts.js';
import {
  commitTypedSupervisorDirective,
  defaultSupervisorCommit,
  detectSupervisorCase,
  resolveSupervisorCase,
  resolveSupervisorThresholds,
} from './supervisor.js';
import type {
  ActRequest,
  ActResult,
  ArcCheckpoint,
  ArcControllerOptions,
  ArcControllerStatus,
  ArcEpisode,
  ArcRunBudget,
  ArcRunManifest,
  ArcSupervisorAuthority,
  ExactArcObservation,
  ExplicitSupervisorCaseRequest,
  FrontierEdge,
  GuardedPlanRequest,
  GuardedPlanResult,
  JsonValue,
  MemoryQuery,
  MemoryQueryResult,
  ObservationPostcondition,
  OfficialReceiptCounts,
  ReceiptReconciliation,
  ReceiptVerification,
  SemanticRule,
  SemanticRuleCommit,
  StoredIdempotencyResult,
  SupervisorCase,
  SupervisorCaseBundle,
  SupervisorDirective,
  SupervisorDirectiveCommit,
  SupervisorThresholds,
  TransitionReceipt,
} from './types.js';

export const ARC_CONTROLLER_VERSION = '0.1.0';
const DEFAULT_BUDGET: ArcRunBudget = Object.freeze({
  maxActions: 1_000,
  maxWallTimeMs: 4 * 60 * 60 * 1_000,
});
const HEX_HASH = /^[0-9a-f]{64}$/;
const MAX_IDEMPOTENCY_ENTRIES = MAX_ARC_RUN_ACTIONS;
const ACT_REQUEST_KEYS = new Set([
  'expectedObservationHash',
  'idempotencyKey',
  'action',
  'expectation',
  'directiveId',
]);
const ACT_REQUEST_REQUIRED_KEYS = new Set([
  'expectedObservationHash',
  'idempotencyKey',
  'action',
  'expectation',
]);
const MEMORY_COMMIT_KEYS = new Set([
  'id',
  'scope',
  'kind',
  'statement',
  'preconditions',
  'predictedEffect',
  'supportingReceiptHashes',
  'contradictingReceiptHashes',
  'status',
]);
const MEMORY_COMMIT_REQUIRED_KEYS = new Set([
  'scope',
  'kind',
  'statement',
  'predictedEffect',
]);

type ControllerPhase = ArcControllerStatus['phase'];
export type NormalizedArcRunManifest = Required<ArcRunManifest>;

function boundedText(name: string, value: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw new ArcValidationError('INVALID_INPUT', `${name} must be non-empty, bounded text`);
  }
  return value.trim();
}

export function normalizeArcRunManifest(input: ArcRunManifest): NormalizedArcRunManifest {
  if (!input || typeof input !== 'object') {
    throw new ArcValidationError('INVALID_MANIFEST', 'runManifest is required');
  }
  const visibleModelLabel = boundedText('visibleModelLabel', input.visibleModelLabel, 256);
  for (const [name, value] of [
    ['promptSnapshotHash', input.promptSnapshotHash],
    ['toolSchemaHash', input.toolSchemaHash],
  ] as const) {
    if (!HEX_HASH.test(value)) {
      throw new ArcValidationError('INVALID_MANIFEST', `${name} must be a lowercase SHA-256 hash`);
    }
  }
  const controllerVersion = boundedText(
    'controllerVersion',
    input.controllerVersion ?? ARC_CONTROLLER_VERSION,
    128,
  );
  const environmentAdapterVersion = boundedText(
    'environmentAdapterVersion',
    input.environmentAdapterVersion,
    256,
  );
  return Object.freeze({
    visibleModelLabel,
    promptSnapshotHash: input.promptSnapshotHash,
    toolSchemaHash: input.toolSchemaHash,
    controllerVersion,
    environmentAdapterVersion,
  });
}

export function normalizeArcRunBudget(input: Partial<ArcRunBudget> = {}): ArcRunBudget {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some(key => typeof key !== 'string' ||
        (key !== 'maxActions' && key !== 'maxWallTimeMs'))) {
    throw new ArcValidationError('INVALID_BUDGET', 'run budget contains unexpected fields');
  }
  return validateArcRunBudget({ ...DEFAULT_BUDGET, ...input });
}

function validateIdempotencyKey(key: string): void {
  if (typeof key !== 'string' || key.length < 8 || key.length > 200 ||
      /[^\x21-\x7e]/.test(key)) {
    throw new ArcValidationError(
      'INVALID_IDEMPOTENCY_KEY',
      'idempotencyKey must contain 8..200 printable ASCII characters without spaces',
    );
  }
}

function validateObservationHash(hash: string, field = 'expectedObservationHash'): void {
  if (!HEX_HASH.test(hash)) {
    throw new ArcValidationError('INVALID_HASH', `${field} must be a lowercase SHA-256 hash`);
  }
}

function snapshotActRequest(input: ActRequest): ActRequest {
  let stableRequest: ActRequest;
  try {
    stableRequest = snapshotArcJson(input) as unknown as ActRequest;
  } catch {
    throw new ArcValidationError('INVALID_REQUEST', 'action request must be strict JSON');
  }
  if (!stableRequest || typeof stableRequest !== 'object' || Array.isArray(stableRequest)) {
    throw new ArcValidationError('INVALID_REQUEST', 'action request must be an object');
  }
  const requestKeys = Reflect.ownKeys(stableRequest);
  if (requestKeys.some(key => typeof key !== 'string' || !ACT_REQUEST_KEYS.has(key)) ||
      [...ACT_REQUEST_REQUIRED_KEYS].some(key =>
        !Object.prototype.hasOwnProperty.call(stableRequest, key))) {
    throw new ArcValidationError(
      'INVALID_REQUEST',
      'action request fields do not exactly match the public schema',
    );
  }
  return stableRequest;
}

function snapshotMemoryCommit(input: SemanticRuleCommit): SemanticRuleCommit {
  let stableInput: SemanticRuleCommit;
  try {
    stableInput = snapshotArcJson(input) as unknown as SemanticRuleCommit;
  } catch {
    throw new ArcValidationError(
      'INVALID_MEMORY_COMMIT',
      'semantic rule commit must be strict JSON',
    );
  }
  if (!stableInput || typeof stableInput !== 'object' || Array.isArray(stableInput)) {
    throw new ArcValidationError(
      'INVALID_MEMORY_COMMIT',
      'semantic rule commit must be an object',
    );
  }
  const keys = Reflect.ownKeys(stableInput);
  if (keys.some(key => typeof key !== 'string' || !MEMORY_COMMIT_KEYS.has(key)) ||
      [...MEMORY_COMMIT_REQUIRED_KEYS].some(key =>
        !Object.prototype.hasOwnProperty.call(stableInput, key))) {
    throw new ArcValidationError(
      'INVALID_MEMORY_COMMIT',
      'semantic rule commit fields do not exactly match the public schema',
    );
  }
  return stableInput;
}

function matchesPostcondition(
  observation: ExactArcObservation,
  postcondition: ObservationPostcondition,
): boolean {
  if (!postcondition || typeof postcondition !== 'object') return false;
  const keys = Object.keys(postcondition);
  if (keys.length === 0 || keys.some(key => ![
    'expectedObservationHash',
    'expectedFrameHash',
    'state',
    'levelsCompleted',
  ].includes(key))) return false;
  return (postcondition.expectedObservationHash === undefined ||
      postcondition.expectedObservationHash === observation.observationHash) &&
    (postcondition.expectedFrameHash === undefined ||
      postcondition.expectedFrameHash === observation.currentFrame.frameHash) &&
    (postcondition.state === undefined || postcondition.state === observation.state) &&
    (postcondition.levelsCompleted === undefined ||
      postcondition.levelsCompleted === observation.levelsCompleted);
}

function effectClass(
  before: ExactArcObservation,
  after: ExactArcObservation,
): ArcEpisode['effectClass'] {
  if (after.state === 'WIN' || after.state === 'GAME_OVER') return 'TERMINAL';
  if (after.levelsCompleted !== before.levelsCompleted) return 'PROGRESS';
  if (after.currentFrame.frameHash !== before.currentFrame.frameHash) return 'GRID_CHANGE';
  return 'NO_EFFECT';
}

function lastOpenCase(cases: readonly SupervisorCase[]): SupervisorCase | undefined {
  for (let index = cases.length - 1; index >= 0; index--) {
    if (cases[index]!.status === 'OPEN') return cases[index];
  }
  return undefined;
}

/**
 * Experimental provider-neutral ARC-AGI-3 controller. It executes no model
 * calls; ChatGPT or another actor interacts only through the typed methods.
 */
export class ArcController {
  readonly principalScope: string;
  readonly runId: string;

  private readonly environment: ArcControllerOptions['environment'];
  private readonly sessionLog?: ArcControllerOptions['sessionLog'];
  private readonly clock: () => number;
  private lastClockMs?: number;
  private readonly manifest: NormalizedArcRunManifest;
  private readonly manifestHash: string;
  private readonly thresholds: SupervisorThresholds;
  private readonly configuredBudget: ArcRunBudget;
  private budget: ArcRunBudget;
  private readonly explicitGameVersion: boolean;
  private internalGameIdentityHash: string;
  private _opaqueGameScope: string;
  private startedAtMs?: number;
  private phase: ControllerPhase = 'NEW';
  private lastError?: string;
  private observation?: ExactArcObservation;
  private receipts: TransitionReceipt[] = [];
  private readonly receiptHashes = new Set<string>();
  private episodes: ArcEpisode[] = [];
  private memoryHeads: MemorySnapshotHeads = Object.freeze({
    episodicHeadHash: '',
    semanticHeadHash: '',
  });
  private memory?: EvidenceBackedMemory;
  private graph?: BeliefGraph;
  private readonly idempotency = new Map<string, StoredIdempotencyResult>();
  private supervisorCases: SupervisorCase[] = [];
  private directives: SupervisorDirective[] = [];
  private activeDirectiveId?: string;
  private planDivergenceReceiptHash?: string;
  private uncertainMutationCount = 0;
  private mutationTail: Promise<void> = Promise.resolve();
  private closePromise?: Promise<void>;

  constructor(options: ArcControllerOptions) {
    if (!options || typeof options !== 'object') {
      throw new ArcValidationError('INVALID_OPTIONS', 'controller options are required');
    }
    this.principalScope = principalScopeFor(boundedText('principalId', options.principalId, 1_024));
    const privateRunId = boundedText('runId', options.runId, 1_024);
    this.runId = `run_${hashArcValue({ principalScope: this.principalScope, privateRunId }).slice(0, 24)}`;
    this.environment = options.environment;
    if (!this.environment || typeof this.environment.reset !== 'function' ||
        typeof this.environment.observe !== 'function' || typeof this.environment.step !== 'function') {
      throw new ArcValidationError('INVALID_ENVIRONMENT', 'environment must implement reset, observe, and step');
    }
    this.sessionLog = options.sessionLog;
    this.clock = options.clock ?? Date.now;
    this.manifest = normalizeArcRunManifest(options.runManifest);
    this.manifestHash = hashArcValue(this.manifest);
    this.configuredBudget = normalizeArcRunBudget(options.budget);
    this.budget = this.configuredBudget;
    this.thresholds = resolveSupervisorThresholds(options.supervisorThresholds);
    this.explicitGameVersion = options.gameVersionHash !== undefined;
    this.internalGameIdentityHash = deriveGameIdentityHash(undefined, options.gameVersionHash);
    this._opaqueGameScope = opaqueGameScopeFor(
      this.principalScope,
      this.runId,
      this.internalGameIdentityHash,
    );
  }

  get opaqueGameScope(): string {
    return this._opaqueGameScope;
  }

  async start(): Promise<ExactArcObservation> {
    return this.withMutation(async () => {
      this.assertNotClosed();
      if (this.observation) return this.observation;
      this.startedAtMs = this.now();
      let raw;
      try {
        raw = await this.environment.reset();
      } catch {
        this.fault('ENVIRONMENT_RESET_FAILED');
        throw new ArcValidationError('ENVIRONMENT_RESET_FAILED', 'environment reset failed');
      }
      let observation: ExactArcObservation;
      try {
        if (!this.explicitGameVersion) {
          this.internalGameIdentityHash = deriveGameIdentityHash(raw.metadata);
          this._opaqueGameScope = opaqueGameScopeFor(
            this.principalScope,
            this.runId,
            this.internalGameIdentityHash,
          );
        }
        observation = exactObservationFromRaw(raw, this._opaqueGameScope);
      } catch {
        this.fault('INVALID_ENVIRONMENT_OUTPUT');
        throw new ArcValidationError('INVALID_ENVIRONMENT_OUTPUT', 'environment returned invalid output');
      }
      this.initializeStores(observation);
      this.observation = observation;
      this.phase = observation.state === 'WIN' ? 'WON' : 'ACTIVE';
      try {
        await this.appendSession('arc.start', {
          principalScope: this.principalScope,
          opaqueGameScope: this._opaqueGameScope,
          runId: this.runId,
          observationHash: observation.observationHash,
          runManifestHash: this.manifestHash,
          budget: this.budget,
        });
      } catch {
        // reset already returned an authoritative live observation. Preserve it
        // and fault the published controller so a caller can inspect the exact
        // committed state without retrying the environment mutation.
        this.uncertainMutationCount++;
        this.fault('SESSION_LOG_COMPLETION_FAILED');
      }
      return observation;
    });
  }

  async observe(): Promise<ExactArcObservation> {
    return this.withMutation(async () => {
      this.assertOperational();
      const prior = this.requireObservation();
      let raw;
      try {
        raw = await this.environment.observe();
      } catch {
        this.fault('ENVIRONMENT_OBSERVE_FAILED');
        throw new ArcValidationError('ENVIRONMENT_OBSERVE_FAILED', 'environment observation failed');
      }
      let observed: ExactArcObservation;
      try {
        observed = exactObservationFromRaw(raw, this._opaqueGameScope);
      } catch {
        this.fault('INVALID_ENVIRONMENT_OUTPUT');
        throw new ArcValidationError('INVALID_ENVIRONMENT_OUTPUT', 'environment returned invalid output');
      }
      if (observed.observationHash !== prior.observationHash) {
        this.fault('UNLEDGERED_ENVIRONMENT_CHANGE');
        throw new ArcValidationError(
          'UNLEDGERED_ENVIRONMENT_CHANGE',
          'observed state differs from the last receipted controller state',
        );
      }
      return observed;
    });
  }

  async act(request: ActRequest): Promise<ActResult> {
    const stableRequest = snapshotActRequest(request);
    return this.withMutation(() => this.actCriticalSection(stableRequest));
  }

  queryMemory(query: MemoryQuery = {}): MemoryQueryResult {
    return this.requireMemory().query(query);
  }

  async commitMemoryRule(input: SemanticRuleCommit): Promise<SemanticRule> {
    const stableInput = snapshotMemoryCommit(input);
    return this.withMutation(async () => {
      this.assertOperational();
      const commitHash = hashArcValue(stableInput);
      const memory = this.requireMemory();
      const replay = memory.ruleForCommitHash(commitHash);
      if (replay) return replay;
      await this.appendSession('arc.memory_rule_intent', { commitHash });
      const rule = memory.commit(stableInput);
      if (containsRawGameIdentityKey(rule)) {
        throw new ArcValidationError('GAME_IDENTITY_LEAK', 'semantic rule contains raw game identity');
      }
      this.memoryHeads = Object.freeze({
        ...this.memoryHeads,
        semanticHeadHash: appendSemanticMemoryHead(this.memoryHeads.semanticHeadHash, rule),
      });
      try {
        await this.appendSession('arc.memory_rule', {
          commitHash,
          ruleId: rule.id,
          version: rule.version,
          ruleHash: rule.ruleHash,
        });
      } catch {
        // The durable intent plus rule commit is authoritative; return the
        // committed value so a transport retry resolves idempotently.
        this.lastError = 'SESSION_LOG_COMPLETION_FAILED';
      }
      return rule;
    });
  }

  commitMemory(input: SemanticRuleCommit): Promise<SemanticRule> {
    return this.commitMemoryRule(input);
  }

  graphFrontier(limit = 32): readonly FrontierEdge[] {
    return this.requireGraph().frontier(this.requireObservation(), limit);
  }

  async executeGuardedPlan(request: GuardedPlanRequest): Promise<GuardedPlanResult> {
    const planId = boundedText('planId', request.planId, 256);
    if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > 256) {
      throw new ArcValidationError('INVALID_PLAN', 'guarded plan must contain 1..256 steps');
    }
    const completed: ActResult[] = [];
    for (let index = 0; index < request.steps.length; index++) {
      const step = request.steps[index]!;
      let result: ActResult;
      try {
        result = await this.act({
          expectedObservationHash: step.expectedObservationHash,
          idempotencyKey: step.idempotencyKey,
          action: step.action,
          expectation: step.expectation,
          ...(step.directiveId === undefined ? {} : { directiveId: step.directiveId }),
        });
      } catch (error) {
        return Object.freeze({
          planId,
          completed: Object.freeze(completed),
          stopReason: 'ACTION_REJECTED' as const,
          divergenceAt: index,
          error: error instanceof ArcValidationError ? error.code : 'ACTION_REJECTED',
        });
      }
      completed.push(result);
      if (!matchesPostcondition(result.observation, step.postcondition)) {
        this.planDivergenceReceiptHash = result.receipt.receiptHash;
        this.openSupervisorCase();
        return Object.freeze({
          planId,
          completed: Object.freeze(completed),
          stopReason: 'DIVERGED' as const,
          divergenceAt: index,
        });
      }
    }
    return Object.freeze({
      planId,
      completed: Object.freeze(completed),
      stopReason: 'COMPLETED' as const,
    });
  }

  supervisorCaseBundle(): SupervisorCaseBundle | null {
    if (!this.observation || !this.graph || !this.memory) return null;
    const open = lastOpenCase(this.supervisorCases);
    const candidate = open ?? this.detectCase();
    if (!candidate) return null;
    if (!open && this.supervisorCases.some(item =>
      item.id === candidate.id && item.status === 'RESOLVED')) return null;
    return this.bundleFor(candidate);
  }

  openSupervisorCase(request?: ExplicitSupervisorCaseRequest): SupervisorCaseBundle | null {
    this.assertOperational();
    const open = lastOpenCase(this.supervisorCases);
    if (open) return this.bundleFor(open);
    this.validateExplicitCase(request);
    const candidate = this.detectCase(request);
    if (!candidate || this.supervisorCases.some(item =>
      item.id === candidate.id && item.status === 'RESOLVED')) return null;
    this.supervisorCases.push(candidate);
    return this.bundleFor(candidate);
  }

  async commitSupervisorDirective(
    input: SupervisorDirectiveCommit,
  ): Promise<SupervisorDirective> {
    return this.withMutation(() => this.commitDirectiveCriticalSection(input));
  }

  async supervise(): Promise<SupervisorDirective | null> {
    return this.withMutation(async () => {
      this.assertOperational();
      let supervisorCase = lastOpenCase(this.supervisorCases);
      if (!supervisorCase) {
        const detected = this.detectCase();
        if (!detected || this.supervisorCases.some(item =>
          item.id === detected.id && item.status === 'RESOLVED')) return null;
        supervisorCase = detected;
        this.supervisorCases.push(supervisorCase);
      }
      return this.commitDirectiveCriticalSection(
        defaultSupervisorCommit(supervisorCase, this.requireObservation().observationHash),
        true,
      );
    });
  }

  asSupervisor(): ArcSupervisorAuthority {
    return Object.freeze({
      supervisorCaseBundle: () => this.supervisorCaseBundle(),
      openSupervisorCase: (request?: ExplicitSupervisorCaseRequest) => this.openSupervisorCase(request),
      commitSupervisorDirective: (input: SupervisorDirectiveCommit) => this.commitSupervisorDirective(input),
      queryMemory: (query?: MemoryQuery) => this.queryMemory(query),
      graphFrontier: (limit?: number) => this.graphFrontier(limit),
      status: () => this.status(),
    });
  }

  async checkpoint(): Promise<ArcCheckpoint> {
    return this.withMutation(async () => {
      this.assertNotClosed();
      this.assertStarted();
      let environmentCheckpoint: JsonValue = null;
      if (this.environment.checkpoint && !this.closed) {
        try {
          const captured = await this.environment.checkpoint();
          if (captured === undefined) throw new Error('invalid environment checkpoint');
          environmentCheckpoint = snapshotArcJson(captured);
        } catch {
          throw new ArcValidationError(
            'ENVIRONMENT_CHECKPOINT_FAILED',
            'environment checkpoint failed',
          );
        }
      }
      const compact = compactCheckpointEvidence(
        this.receipts,
        [...this.idempotency.values()],
      );
      // Do not persist a non-STOP directive that expired at this boundary.
      this.activeDirective();
      const body = {
        schema: 'metaharness.arc_agi_3.checkpoint.v1' as const,
        principalScope: this.principalScope,
        opaqueGameScope: this._opaqueGameScope,
        runId: this.runId,
        createdAtMs: this.now(),
        startedAtMs: this.startedAtMs!,
        runManifest: this.manifest,
        budget: this.budget,
        observation: this.requireObservation(),
        receipts: compact.receipts,
        frameBlobs: compact.frameBlobs,
        episodes: Object.freeze([...this.episodes]),
        memory: this.requireMemory().snapshot(),
        memorySnapshotHash: this.memorySnapshotHash(),
        graph: this.requireGraph().snapshot(),
        idempotency: compact.idempotency,
        supervisorCases: Object.freeze([...this.supervisorCases]),
        directives: Object.freeze([...this.directives]),
        activeDirectiveId: this.activeDirectiveId,
        uncertainMutationCount: this.uncertainMutationCount,
        phase: this.phase === 'NEW' ? 'ACTIVE' as const : this.phase,
        lastError: this.lastError,
        closed: this.closed,
        environmentCheckpoint,
        sessionStateHash: this.sessionLog?.stateHash(),
      };
      const checkpoint = createArcCheckpoint(body);
      try {
        await this.appendSession('arc.checkpoint', {
          checkpointHash: checkpoint.checkpointHash,
          receiptHead: this.receipts.at(-1)?.receiptHash ?? TRANSITION_RECEIPT_GENESIS,
        });
      } catch {
        this.lastError = 'SESSION_LOG_COMPLETION_FAILED';
      }
      return checkpoint;
    });
  }

  async resume(checkpoint: ArcCheckpoint): Promise<ExactArcObservation> {
    return this.withMutation(async () => {
      if (this.observation || this.phase !== 'NEW') {
        throw new ArcValidationError('ALREADY_STARTED', 'resume requires a fresh controller');
      }
      if (!this.explicitGameVersion) {
        throw new ArcValidationError(
          'RESUME_REQUIRES_GAME_VERSION_HASH',
          'resumable controllers must be constructed with an explicit gameVersionHash',
        );
      }
      verifyArcCheckpoint(checkpoint);
      if (checkpoint.closed) {
        throw new ArcValidationError(
          'CLOSED_CHECKPOINT',
          'closed checkpoints cannot be resumed into a live controller',
        );
      }
      const checkpointBudget = validateArcRunBudget(checkpoint.budget);
      if (checkpoint.principalScope !== this.principalScope || checkpoint.runId !== this.runId) {
        throw new ArcValidationError('FOREIGN_CHECKPOINT', 'checkpoint principal or run scope differs');
      }
      if (hashArcValue(checkpoint.runManifest) !== this.manifestHash) {
        throw new ArcValidationError('MANIFEST_MISMATCH', 'checkpoint run manifest differs');
      }
      if (this.explicitGameVersion && checkpoint.opaqueGameScope !== this._opaqueGameScope) {
        throw new ArcValidationError('GAME_SCOPE_MISMATCH', 'checkpoint game scope differs');
      }
      if (checkpointBudget.maxActions > this.configuredBudget.maxActions ||
          checkpointBudget.maxWallTimeMs > this.configuredBudget.maxWallTimeMs) {
        throw new ArcValidationError('BUDGET_ESCALATION', 'checkpoint exceeds configured run budget');
      }
      if (!Object.prototype.hasOwnProperty.call(checkpoint, 'environmentCheckpoint') ||
          checkpoint.environmentCheckpoint === undefined ||
          checkpoint.environmentCheckpoint === null || !this.environment.resume) {
        throw new ArcValidationError(
          'LIVE_RESUME_UNAVAILABLE',
          'exact resume requires an environment checkpoint and adapter resume support',
        );
      }
      const resumedAtMs = this.now();
      if (resumedAtMs < checkpoint.startedAtMs || resumedAtMs < checkpoint.createdAtMs) {
        throw new ArcValidationError(
          'CHECKPOINT_FROM_FUTURE',
          'checkpoint start or creation time is in the future',
        );
      }
      this._opaqueGameScope = checkpoint.opaqueGameScope;
      this.budget = checkpointBudget;
      this.startedAtMs = checkpoint.startedAtMs;
      this.receipts = [...hydrateCheckpointReceipts(checkpoint)];
      this.receiptHashes.clear();
      for (const receipt of this.receipts) this.receiptHashes.add(receipt.receiptHash);
      this.episodes = [];
      this.initializeStores(checkpoint.observation);
      this.requireMemory().loadEpisodes(checkpoint.episodes);
      this.episodes = [...checkpoint.episodes];
      this.requireMemory().load(checkpoint.memory);
      this.memoryHeads = memorySnapshotHeadsFor(
        this.memoryCommitmentScope(),
        checkpoint.episodes,
        checkpoint.memory,
      );
      this.requireGraph().load(checkpoint.graph);
      this.idempotency.clear();
      for (const entry of hydrateCheckpointIdempotency(checkpoint, this.receipts)) {
        if (this.idempotency.has(entry.key)) {
          throw new ArcValidationError('INVALID_CHECKPOINT', 'duplicate idempotency key');
        }
        this.idempotency.set(entry.key, entry);
      }
      this.supervisorCases = [...checkpoint.supervisorCases];
      this.directives = [...checkpoint.directives];
      this.activeDirectiveId = checkpoint.activeDirectiveId;
      this.uncertainMutationCount = checkpoint.uncertainMutationCount;
      this.lastError = checkpoint.lastError;
      this.observation = checkpoint.observation;
      let raw;
      try {
        raw = await this.environment.resume(checkpoint.environmentCheckpoint);
      } catch {
        this.fault('ENVIRONMENT_RESUME_FAILED');
        throw new ArcValidationError('ENVIRONMENT_RESUME_FAILED', 'environment resume failed');
      }
      let live: ExactArcObservation;
      try {
        live = exactObservationFromRaw(raw, this._opaqueGameScope);
      } catch {
        this.fault('INVALID_ENVIRONMENT_OUTPUT');
        throw new ArcValidationError('INVALID_ENVIRONMENT_OUTPUT', 'environment returned invalid output');
      }
      if (live.observationHash !== checkpoint.observation.observationHash) {
        this.fault('LIVE_RESUME_MISMATCH');
        throw new ArcValidationError(
          'LIVE_RESUME_MISMATCH',
          'environment state does not match the exact checkpoint observation',
        );
      }
      this.observation = live;
      this.phase = checkpoint.phase;
      try {
        await this.appendSession('arc.resume', {
          checkpointHash: checkpoint.checkpointHash,
          observationHash: live.observationHash,
        });
      } catch {
        // The adapter is already restored. Return its committed observation and
        // make the replacement terminal so store retries cannot restore again.
        this.uncertainMutationCount++;
        this.fault('SESSION_LOG_COMPLETION_FAILED');
      }
      return live;
    });
  }

  status(): ArcControllerStatus {
    const now = this.now();
    const elapsed = this.startedAtMs === undefined ? 0 : Math.max(0, now - this.startedAtMs);
    const remainingActions = Math.max(0, this.budget.maxActions - this.receipts.length);
    const remainingWallTimeMs = Math.max(0, this.budget.maxWallTimeMs - elapsed);
    const budgetExhausted = remainingActions === 0 || remainingWallTimeMs === 0;
    const directive = this.activeDirective();
    return Object.freeze({
      principalScope: this.principalScope,
      opaqueGameScope: this._opaqueGameScope,
      runId: this.runId,
      phase: this.phase,
      gameState: this.observation?.state,
      observationHash: this.observation?.observationHash,
      currentBeliefKey: this.graph?.snapshot().currentBeliefKey,
      actionCount: this.receipts.length,
      uncertainMutationCount: this.uncertainMutationCount,
      startedAtMs: this.startedAtMs,
      maxActions: this.budget.maxActions,
      remainingActions,
      maxWallTimeMs: this.budget.maxWallTimeMs,
      remainingWallTimeMs,
      budgetExhausted,
      receiptCount: this.receipts.length,
      episodeCount: this.episodes.length,
      ruleCount: this.memory?.ruleCount ?? 0,
      openSupervisorCaseId: lastOpenCase(this.supervisorCases)?.id,
      activeDirectiveId: directive?.id,
      stopped: this.phase === 'WON' || this.phase === 'FAULTED' || this.phase === 'CLOSED' ||
        budgetExhausted || directive?.mode === 'STOP',
      closed: this.closed,
      lastError: this.lastError,
    });
  }

  verifyReceipts(): ReceiptVerification {
    return verifyTransitionReceipts(this.receipts);
  }

  /** Ordered public commitments used to reconcile the durable intent journal. */
  orderedReceiptCommitments(): readonly Readonly<{
    receiptHash: string;
    requestHash: string;
  }>[] {
    return Object.freeze(this.receipts.map(receipt => Object.freeze({
      receiptHash: receipt.receiptHash,
      requestHash: receipt.requestHash,
    })));
  }

  /** Chain integrity plus independent official action/reset/head reconciliation. */
  reconcileReceipts(official: OfficialReceiptCounts): ReceiptReconciliation {
    return reconcileTransitionReceipts(this.receipts, official, this.uncertainMutationCount);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.withMutation(async () => {
      if (this.phase === 'CLOSED') return;
      const failures: unknown[] = [];
      try {
        try {
          await this.appendSession('arc.close', {
            receiptHead: this.receipts.at(-1)?.receiptHash ?? TRANSITION_RECEIPT_GENESIS,
          });
        } catch (error) {
          failures.push(error);
        }
        try {
          await this.environment.close?.();
        } catch (error) {
          failures.push(error);
        }
      } finally {
        this.phase = 'CLOSED';
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'controller close failed');
    });
    return this.closePromise;
  }

  private get closed(): boolean {
    return this.phase === 'CLOSED';
  }

  private async actCriticalSection(stableRequest: ActRequest): Promise<ActResult> {
    validateIdempotencyKey(stableRequest.idempotencyKey);
    validateObservationHash(stableRequest.expectedObservationHash);
    validateArcAction(stableRequest.action);
    validateExpectation(stableRequest.expectation);
    if (stableRequest.directiveId !== undefined) {
      boundedText('directiveId', stableRequest.directiveId, 256);
    }
    const requestHash = hashArcValue(stableRequest);
    const priorIdempotent = this.idempotency.get(stableRequest.idempotencyKey);
    if (priorIdempotent) {
      if (priorIdempotent.requestHash !== requestHash) {
        throw new ArcValidationError(
          'IDEMPOTENCY_CONFLICT',
          'idempotencyKey was already used with a different request',
        );
      }
      return Object.freeze({ ...priorIdempotent.result, replayed: true });
    }
    this.assertOperational();
    if (this.idempotency.size >= MAX_IDEMPOTENCY_ENTRIES) {
      throw new ArcValidationError('IDEMPOTENCY_LIMIT', 'idempotency ledger limit reached');
    }
    const before = this.requireObservation();
    if (stableRequest.expectedObservationHash !== before.observationHash) {
      throw new ArcValidationError(
        'STALE_OBSERVATION',
        'expectedObservationHash does not match the current exact observation',
      );
    }
    this.assertActionBudget();
    this.assertActionLegal(stableRequest, before);
    await this.appendSession('arc.action_intent', {
      idempotencyKey: stableRequest.idempotencyKey,
      expectedObservationHash: stableRequest.expectedObservationHash,
      action: stableRequest.action,
      ...(stableRequest.directiveId === undefined ? {} : { directiveId: stableRequest.directiveId }),
      requestHash,
    });
    // Session persistence can take time; recheck immediately before mutation.
    this.assertActionBudget();

    let raw;
    try {
      raw = await this.environment.step(stableRequest.action);
    } catch {
      this.uncertainMutationCount++;
      this.fault('ENVIRONMENT_STEP_FAILED');
      throw new ArcValidationError('ENVIRONMENT_STEP_FAILED', 'environment action failed');
    }
    try {
      let after: ExactArcObservation;
      try {
        after = exactObservationFromRaw(raw, this._opaqueGameScope);
      } catch {
        throw new ArcValidationError(
          'INVALID_ENVIRONMENT_OUTPUT',
          'environment returned invalid output',
        );
      }
      const graph = this.requireGraph();
      const sequence = this.receipts.length + 1;
      const preBeliefKey = graph.current().key;
      const next = graph.previewNext(stableRequest.action, after, sequence);
      const exactDelta = exactCellDelta(before.currentFrame, after.currentFrame);
      const noEffect = after.observationHash === before.observationHash;
      const error = predictionError(stableRequest.expectation, before, after);
      const episodeId = `episode_${hashArcValue({
        principalScope: this.principalScope,
        opaqueGameScope: this._opaqueGameScope,
        runId: this.runId,
        sequence,
        preBeliefKey,
        postBeliefKey: next.key,
      }).slice(0, 32)}`;
      const receipt = appendTransitionReceipt(this.receipts, {
        runId: this.runId,
        principalScope: this.principalScope,
        opaqueGameScope: this._opaqueGameScope,
        sequence,
        episodeId,
        idempotencyKey: stableRequest.idempotencyKey,
        requestHash,
        ...(stableRequest.directiveId === undefined ? {} : { directiveId: stableRequest.directiveId }),
        createdAtMs: this.now(),
        visibleModelLabel: this.manifest.visibleModelLabel,
        promptSnapshotHash: this.manifest.promptSnapshotHash,
        toolSchemaHash: this.manifest.toolSchemaHash,
        controllerVersion: this.manifest.controllerVersion,
        environmentAdapterVersion: this.manifest.environmentAdapterVersion,
        runManifestHash: this.manifestHash,
        memorySnapshotHash: this.memorySnapshotHash(),
        preObservationHash: before.observationHash,
        postObservationHash: after.observationHash,
        preBeliefKey,
        postBeliefKey: next.key,
        stateBefore: before.state,
        stateAfter: after.state,
        levelsCompletedBefore: before.levelsCompleted,
        levelsCompletedAfter: after.levelsCompleted,
        action: stableRequest.action,
        expectation: stableRequest.expectation,
        exactDelta,
        frames: after.frames,
        returnedFrameRefs: Object.freeze(after.frames.map(frame => frame.frameRef)),
        predictionError: error,
        noEffect,
      });
      this.receipts.push(receipt);
      this.receiptHashes.add(receipt.receiptHash);
      graph.recordTransition({
        action: stableRequest.action,
        observation: after,
        next,
        receiptHash: receipt.receiptHash,
        noEffect,
      });
      const episode: ArcEpisode = Object.freeze({
        id: episodeId,
        principalScope: this.principalScope,
        opaqueGameScope: this._opaqueGameScope,
        runId: this.runId,
        receiptHash: receipt.receiptHash,
        sequence,
        preBeliefKey,
        postBeliefKey: next.key,
        preObservationHash: before.observationHash,
        postObservationHash: after.observationHash,
        action: stableRequest.action,
        effectClass: effectClass(before, after),
        progressDelta: after.levelsCompleted - before.levelsCompleted,
        predictionError: error,
        noEffect,
      });
      this.requireMemory().appendEpisode(episode);
      this.episodes.push(episode);
      this.memoryHeads = Object.freeze({
        ...this.memoryHeads,
        episodicHeadHash: appendEpisodeMemoryHead(this.memoryHeads.episodicHeadHash, episode),
      });
      this.observation = after;
      if (after.state === 'WIN') this.phase = 'WON';
      const result: ActResult = Object.freeze({ observation: after, receipt, replayed: false });
      await this.appendSession('arc.transition', {
        receiptHash: receipt.receiptHash,
        requestHash,
        sequence,
        postObservationHash: after.observationHash,
      });
      this.ensureDetectedCase();
      // The replay ledger is the last commit. Any prior post-dispatch failure
      // faults the controller, so a retry cannot dispatch the action again.
      this.idempotency.set(stableRequest.idempotencyKey, Object.freeze({
        key: stableRequest.idempotencyKey,
        requestHash,
        result,
      }));
      return result;
    } catch (error) {
      const code = error instanceof ArcValidationError &&
          error.code === 'INVALID_ENVIRONMENT_OUTPUT'
        ? 'INVALID_ENVIRONMENT_OUTPUT'
        : error instanceof ArcValidationError && error.code === 'SESSION_LOG_FAILED'
          ? 'SESSION_LOG_COMPLETION_FAILED'
          : 'POST_DISPATCH_COMMIT_FAILED';
      this.uncertainMutationCount++;
      this.fault(code);
      const message = code === 'INVALID_ENVIRONMENT_OUTPUT'
        ? 'environment returned invalid output'
        : code === 'SESSION_LOG_COMPLETION_FAILED'
          ? 'transition evidence persistence failed after dispatch'
          : 'environment action dispatched but transition commit failed';
      throw new ArcValidationError(code, message);
    }
  }

  private assertActionLegal(request: ActRequest, observation: ExactArcObservation): void {
    if (observation.state === 'WIN') {
      throw new ArcValidationError('RUN_WON', 'WIN is terminal; no further actions are legal');
    }
    if (observation.state === 'NOT_PLAYED' || observation.state === 'GAME_OVER') {
      if (request.action.name !== 'RESET') {
        throw new ArcValidationError('RESET_REQUIRED', `${observation.state} permits only RESET`);
      }
    } else if (request.action.name === 'RESET' ||
        !observation.availableActions.includes(request.action.name)) {
      throw new ArcValidationError('ACTION_UNAVAILABLE', 'action is not currently available');
    }
    const directive = this.activeDirective();
    if (!directive) {
      if (request.directiveId !== undefined) {
        throw new ArcValidationError('UNKNOWN_DIRECTIVE', 'no active supervisor directive exists');
      }
      return;
    }
    if (request.directiveId !== directive.id) {
      throw new ArcValidationError('DIRECTIVE_REQUIRED', 'the active supervisor directiveId is required');
    }
    if (directive.mode === 'STOP') {
      throw new ArcValidationError('SUPERVISOR_STOP', 'the supervisor directive stopped the run');
    }
    const used = this.receipts.length - directive.committedAtSequence;
    if (used >= directive.actionBudget) {
      throw new ArcValidationError('DIRECTIVE_BUDGET', 'supervisor directive action budget is exhausted');
    }
    const edge = observableEdgeKey(observation.observationHash, request.action);
    if (directive.prohibitedEdges.includes(edge)) {
      throw new ArcValidationError('PROHIBITED_EDGE', 'supervisor directive prohibits this edge');
    }
    if (directive.mode === 'RESET' && request.action.name !== 'RESET') {
      throw new ArcValidationError('RESET_DIRECTIVE', 'supervisor directive requires RESET');
    }
  }

  private assertActionBudget(): void {
    if (this.receipts.length >= this.budget.maxActions) {
      throw new ArcValidationError('ACTION_BUDGET_EXHAUSTED', 'run action budget is exhausted');
    }
    const elapsed = this.now() - this.startedAtMs!;
    if (elapsed >= this.budget.maxWallTimeMs) {
      throw new ArcValidationError('WALL_TIME_EXHAUSTED', 'run wall-time budget is exhausted');
    }
  }

  private activeDirective(): SupervisorDirective | undefined {
    const active = this.directives.find(item => item.id === this.activeDirectiveId);
    if (!active) return undefined;
    const used = this.receipts.length - active.committedAtSequence;
    if (active.mode !== 'STOP' && used >= active.expiresAfterActions) {
      this.activeDirectiveId = undefined;
      return undefined;
    }
    return active;
  }

  private async commitDirectiveCriticalSection(
    input: SupervisorDirectiveCommit,
    lockAlreadyHeld = false,
  ): Promise<SupervisorDirective> {
    void lockAlreadyHeld;
    const inputCommitHash = hashArcValue(input);
    const replay = this.directives.find(item => item.commitHash === inputCommitHash);
    if (replay) return replay;
    this.assertOperational();
    const observation = this.requireObservation();
    const expectedObservationHash = input.expectedObservationHash;
    const observationHash = input.observationHash ?? expectedObservationHash;
    validateObservationHash(observationHash, 'observationHash');
    validateObservationHash(expectedObservationHash);
    if (observationHash !== expectedObservationHash ||
        expectedObservationHash !== observation.observationHash) {
      throw new ArcValidationError('STALE_SUPERVISOR_OBSERVATION', 'supervisor observation is stale');
    }
    if (input.mode === 'RESET' &&
        observation.state !== 'NOT_PLAYED' && observation.state !== 'GAME_OVER') {
      throw new ArcValidationError(
        'RESET_DIRECTIVE_ILLEGAL',
        'RESET directives are legal only in NOT_PLAYED or GAME_OVER',
      );
    }
    let supervisorCase = this.supervisorCases.find(item =>
      item.id === input.caseId && item.status === 'OPEN');
    let caseNeedsPersist = false;
    if (!supervisorCase) {
      const detected = this.detectCase();
      if (detected?.id === input.caseId && detected.caseHash === input.caseHash) {
        supervisorCase = detected;
        caseNeedsPersist = true;
      }
    }
    if (!supervisorCase || supervisorCase.caseHash !== input.caseHash) {
      throw new ArcValidationError('STALE_SUPERVISOR_CASE', 'supervisor case is missing or stale');
    }
    const knownReceipts = new Set(this.receipts.map(receipt => receipt.receiptHash));
    for (const evidence of input.requiredEvidence ?? []) {
      if (!knownReceipts.has(evidence) || !supervisorCase.evidenceReceiptHashes.includes(evidence)) {
        throw new ArcValidationError(
          'UNSUPPORTED_SUPERVISOR_EVIDENCE',
          'requiredEvidence must cite a receipt in the open supervisor case',
        );
      }
    }
    for (const hypothesis of input.hypotheses ?? []) {
      for (const evidence of hypothesis.evidenceReceiptHashes) {
        if (!knownReceipts.has(evidence)) {
          throw new ArcValidationError(
            'UNSUPPORTED_SUPERVISOR_EVIDENCE',
            'hypothesis evidence must cite a known transition receipt',
          );
        }
      }
    }
    const directive = commitTypedSupervisorDirective({
      principalScope: this.principalScope,
      opaqueGameScope: this._opaqueGameScope,
      runId: this.runId,
      supervisorCase,
      commit: input,
      sequence: this.receipts.length,
    });
    await this.appendSession('arc.supervisor_directive_intent', {
      commitHash: directive.commitHash,
      directiveHash: directive.directiveHash,
      caseHash: directive.caseHash,
      expectedObservationHash: directive.expectedObservationHash,
    });
    if (caseNeedsPersist) this.supervisorCases.push(supervisorCase);
    const index = this.supervisorCases.findIndex(item => item.id === supervisorCase!.id);
    this.supervisorCases[index] = resolveSupervisorCase(supervisorCase);
    this.directives.push(directive);
    this.activeDirectiveId = directive.id;
    this.planDivergenceReceiptHash = undefined;
    try {
      await this.appendSession('arc.supervisor_directive', {
        commitHash: directive.commitHash,
        directiveHash: directive.directiveHash,
        caseHash: directive.caseHash,
        expectedObservationHash: directive.expectedObservationHash,
      });
    } catch {
      this.lastError = 'SESSION_LOG_COMPLETION_FAILED';
    }
    return directive;
  }

  private validateExplicitCase(request?: ExplicitSupervisorCaseRequest): void {
    if (!request) return;
    if (request.trigger !== 'MODEL_CONTRADICTION' ||
        !Array.isArray(request.evidenceReceiptHashes) ||
        request.evidenceReceiptHashes.length < 1 || request.evidenceReceiptHashes.length > 256) {
      throw new ArcValidationError('INVALID_SUPERVISOR_CASE', 'explicit case input is invalid');
    }
    const evidence = [...new Set(request.evidenceReceiptHashes)];
    if (evidence.length !== request.evidenceReceiptHashes.length || evidence.some(value =>
      typeof value !== 'string' || !HEX_HASH.test(value) || !this.receiptExists(value))) {
      throw new ArcValidationError(
        'UNSUPPORTED_SUPERVISOR_EVIDENCE',
        'explicit case evidence must be unique known receipt hashes',
      );
    }
    const metrics = Object.entries(request.metrics ?? {});
    if (metrics.length > 64 || metrics.some(([key, value]) =>
      !key.trim() || key.length > 128 || !Number.isFinite(value))) {
      throw new ArcValidationError('INVALID_SUPERVISOR_CASE', 'explicit case metrics are invalid');
    }
  }

  private detectCase(explicit?: ExplicitSupervisorCaseRequest): SupervisorCase | null {
    return detectSupervisorCase({
      principalScope: this.principalScope,
      opaqueGameScope: this._opaqueGameScope,
      runId: this.runId,
      observation: this.requireObservation(),
      episodes: this.episodes,
      receipts: this.receipts,
      graph: this.requireGraph(),
      thresholds: this.thresholds,
      planDivergenceReceiptHash: this.planDivergenceReceiptHash,
      explicit,
    });
  }

  private ensureDetectedCase(): void {
    if (this.supervisorCases.some(item => item.status === 'OPEN')) return;
    const candidate = this.detectCase();
    if (candidate && !this.supervisorCases.some(item =>
      item.id === candidate.id && item.status === 'RESOLVED')) {
      this.supervisorCases.push(candidate);
    }
  }

  private bundleFor(supervisorCase: SupervisorCase): SupervisorCaseBundle {
    const verification = this.verifyReceipts();
    const recent = Object.freeze(this.receipts.slice(-16).map(receipt => Object.freeze({
      receiptHash: receipt.receiptHash,
      sequence: receipt.sequence,
      action: receipt.action,
      preObservationHash: receipt.preObservationHash,
      postObservationHash: receipt.postObservationHash,
      predictionError: receipt.predictionError,
      noEffect: receipt.noEffect,
    })));
    const bundle: SupervisorCaseBundle = Object.freeze({
      case: supervisorCase,
      observation: this.requireObservation(),
      memory: this.requireMemory().query({ limit: 32 }),
      graphFrontier: this.requireGraph().frontier(this.requireObservation(), 32),
      receiptSummary: Object.freeze({
        count: this.receipts.length,
        headHash: verification.ok
          ? verification.headHash
          : this.receipts.at(-1)?.receiptHash ?? TRANSITION_RECEIPT_GENESIS,
        recent,
      }),
    });
    if (containsRawGameIdentityKey(bundle)) {
      throw new ArcValidationError('GAME_IDENTITY_LEAK', 'supervisor case contains raw game identity');
    }
    return bundle;
  }

  private initializeStores(observation: ExactArcObservation): void {
    this.graph = new BeliefGraph({
      principalScope: this.principalScope,
      opaqueGameScope: this._opaqueGameScope,
      runId: this.runId,
    });
    this.graph.initialize(observation);
    this.memory = new EvidenceBackedMemory({
      principalScope: this.principalScope,
      opaqueGameScope: this._opaqueGameScope,
      runId: this.runId,
      receiptExists: hash => this.receiptExists(hash),
    });
    this.memoryHeads = initialMemorySnapshotHeads(this.memoryCommitmentScope());
  }

  private receiptExists(hash: string): boolean {
    return this.receiptHashes.has(hash);
  }

  private memorySnapshotHash(): string {
    this.requireMemory();
    return combineMemorySnapshotHeads(this.memoryCommitmentScope(), this.memoryHeads);
  }

  private memoryCommitmentScope(): MemoryCommitmentScope {
    return Object.freeze({
      principalScope: this.principalScope,
      opaqueGameScope: this._opaqueGameScope,
      runId: this.runId,
    });
  }

  private requireObservation(): ExactArcObservation {
    if (!this.observation) throw new ArcValidationError('NOT_STARTED', 'controller is not started');
    return this.observation;
  }

  private requireMemory(): EvidenceBackedMemory {
    if (!this.memory) throw new ArcValidationError('NOT_STARTED', 'controller is not started');
    return this.memory;
  }

  private requireGraph(): BeliefGraph {
    if (!this.graph) throw new ArcValidationError('NOT_STARTED', 'controller is not started');
    return this.graph;
  }

  private assertStarted(): void {
    if (!this.observation) throw new ArcValidationError('NOT_STARTED', 'controller is not started');
  }

  private assertNotClosed(): void {
    if (this.closed) throw new ArcValidationError('CLOSED', 'controller is closed');
  }

  private assertOperational(): void {
    this.assertNotClosed();
    this.assertStarted();
    if (this.phase === 'FAULTED') {
      throw new ArcValidationError('FAULTED', 'controller faulted and cannot mutate the environment');
    }
    if (this.phase === 'WON') {
      throw new ArcValidationError('RUN_WON', 'run has won and is stopped');
    }
  }

  private fault(code: string): void {
    this.phase = 'FAULTED';
    this.lastError = code;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0 ||
        (this.lastClockMs !== undefined && value < this.lastClockMs)) {
      throw new ArcValidationError(
        'INVALID_CLOCK',
        'controller clock must return monotonic non-negative safe integers',
      );
    }
    this.lastClockMs = value;
    return value;
  }

  private async appendSession(kind: string, payload: unknown): Promise<void> {
    if (!this.sessionLog) return;
    if (containsRawGameIdentityKey(payload)) {
      throw new ArcValidationError('GAME_IDENTITY_LEAK', 'session event contains raw game identity');
    }
    try {
      await this.sessionLog.append(kind, payload);
    } catch {
      throw new ArcValidationError('SESSION_LOG_FAILED', 'session evidence log failed');
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>(resolve => { release = resolve; });
    return prior.then(operation).finally(release);
  }
}

export function createArcController(options: ArcControllerOptions): ArcController {
  return new ArcController(options);
}

export { DEFAULT_BUDGET as DEFAULT_ARC_RUN_BUDGET };
