import {
  containsRawGameIdentityKey,
  hashArcValue,
  MAX_ARC_ANIMATION_FRAMES,
  validateArcAction,
  validateArcRunBudget,
  validateExactArcObservation,
  validateExactGridFrame,
} from './canonical.js';
import {
  EvidenceBackedMemory,
  MAX_SEMANTIC_RULE_VERSIONS,
  memorySnapshotHashFor,
} from './memory.js';
import {
  hiddenStateSafeBeliefKey,
  observableEdgeKey,
  validateBeliefGraphSnapshot,
} from './belief-graph.js';
import { verifyTransitionReceipts } from './receipts.js';
import type {
  ActResult,
  ArcCheckpoint,
  ArcCheckpointBody,
  CheckpointFrameBlob,
  CheckpointIdempotencyResult,
  CheckpointObservation,
  CheckpointTransitionReceipt,
  ExactArcObservation,
  ExactGridFrame,
  GameState,
  StoredIdempotencyResult,
  SupervisorCase,
  SupervisorDirective,
  SupervisorHypothesis,
  TransitionReceipt,
} from './types.js';

const HEX_HASH = /^[0-9a-f]{64}$/;
const SUPERVISOR_CASE_ID = /^supervisor_case_[0-9a-f]{32}$/;
const SUPERVISOR_DIRECTIVE_ID = /^supervisor_directive_[0-9a-f]{32}$/;
const MAX_SUPERVISOR_RECORDS = 10_000;
const PRINCIPAL_SCOPE = /^principal_[0-9a-f]{24}$/;
const GAME_SCOPE = /^game_[0-9a-f]{24}$/;
const RUN_SCOPE = /^run_[0-9a-f]{24}$/;
const CHECKPOINT_PHASES = new Set(['ACTIVE', 'WON', 'FAULTED', 'CLOSED']);

const CHECKPOINT_BODY_REQUIRED_KEYS = new Set([
  'schema',
  'principalScope',
  'opaqueGameScope',
  'runId',
  'createdAtMs',
  'startedAtMs',
  'runManifest',
  'budget',
  'observation',
  'receipts',
  'frameBlobs',
  'episodes',
  'memory',
  'memorySnapshotHash',
  'graph',
  'idempotency',
  'supervisorCases',
  'directives',
  'uncertainMutationCount',
  'phase',
  'closed',
  // Presence distinguishes the explicit non-resumable `null` sentinel from a
  // truncated or injected checkpoint body and survives JSON serialization.
  'environmentCheckpoint',
]);

const CHECKPOINT_BODY_OPTIONAL_KEYS = new Set([
  'activeDirectiveId',
  'lastError',
  'sessionStateHash',
]);

const RUN_MANIFEST_KEYS = new Set([
  'visibleModelLabel',
  'promptSnapshotHash',
  'toolSchemaHash',
  'controllerVersion',
  'environmentAdapterVersion',
]);

const SUPERVISOR_TRIGGERS = new Set([
  'GAME_OVER',
  'PLAN_DIVERGENCE',
  'MODEL_CONTRADICTION',
  'REPEATED_EDGE',
  'NO_EFFECT',
  'PREDICTION_ERROR',
  'STAGNATION',
  'CYCLE',
  'COORDINATE_PROBE',
]);

const SUPERVISOR_MODES = new Set([
  'CONTINUE',
  'FALSIFY_RULE',
  'EXPAND_FRONTIER',
  'REBUILD_MODEL',
  'ROLLBACK_PLAN',
  'RESET',
  'NEW_ACTOR_CONTEXT',
  'STOP',
]);

const SUPERVISOR_CASE_KEYS = new Set([
  'id',
  'principalScope',
  'opaqueGameScope',
  'runId',
  'trigger',
  'openedAtSequence',
  'evidenceReceiptHashes',
  'metrics',
  'status',
  'caseHash',
]);

const SUPERVISOR_DIRECTIVE_KEYS = new Set([
  'id',
  'principalScope',
  'opaqueGameScope',
  'runId',
  'caseId',
  'caseHash',
  'expectedObservationHash',
  'observationHash',
  'trigger',
  'mode',
  'diagnosis',
  'requiredEvidence',
  'prohibitedEdges',
  'actionBudget',
  'expiresAfterActions',
  'hypotheses',
  'recommendedStrategy',
  'constraints',
  'committedAtSequence',
  'commitHash',
  'directiveHash',
]);

const SUPERVISOR_HYPOTHESIS_KEYS = new Set([
  'hypothesis',
  'evidenceReceiptHashes',
  'falsifier',
  'proposedNextAction',
]);

const EPISODE_KEYS = new Set([
  'id',
  'principalScope',
  'opaqueGameScope',
  'runId',
  'receiptHash',
  'sequence',
  'preBeliefKey',
  'postBeliefKey',
  'preObservationHash',
  'postObservationHash',
  'action',
  'effectClass',
  'progressDelta',
  'predictionError',
  'noEffect',
]);

const CHECKPOINT_IDEMPOTENCY_KEYS = new Set([
  'key',
  'requestHash',
  'receiptHash',
  'observation',
]);

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) throw new Error(`${label} contains unexpected field ${unexpected}`);
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximum: number,
  requireTrimmed = false,
): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum ||
      (requireTrimmed && value !== value.trim())) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_HASH.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer in ${minimum}..${maximum}`);
  }
}

function assertUniqueStrings(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumLength: number,
): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maximumItems || value.some(item =>
    typeof item !== 'string' || !item.trim() || item.length > maximumLength) ||
      new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique bounded strings`);
  }
}

function assertCheckpointOwnKeys(
  value: Record<string, unknown>,
  includeCheckpointHash: boolean,
): void {
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([
    ...CHECKPOINT_BODY_REQUIRED_KEYS,
    ...CHECKPOINT_BODY_OPTIONAL_KEYS,
    ...(includeCheckpointHash ? ['checkpointHash'] : []),
  ]);
  const invalid = keys.find(key => typeof key !== 'string' || !allowed.has(key));
  if (invalid !== undefined) {
    throw new Error(`checkpoint contains unexpected field ${String(invalid)}`);
  }
  for (const required of CHECKPOINT_BODY_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      throw new Error(`checkpoint is missing required field ${required}`);
    }
  }
  if (includeCheckpointHash && !Object.prototype.hasOwnProperty.call(value, 'checkpointHash')) {
    throw new Error('checkpoint is missing required field checkpointHash');
  }
}

function assertJsonPayload(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
  depth = 0,
  counter = { count: 0 },
): void {
  counter.count += 1;
  if (depth > 64 || counter.count > 1_000_000) {
    throw new Error(`${label} exceeds JSON depth or size limits`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new Error(`${label} is not an acyclic JSON value`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' ||
      (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) ||
        Object.keys(value).length !== value.length) {
      throw new Error(`${label} contains a sparse or extended JSON array`);
    }
    for (const item of value) assertJsonPayload(item, label, seen, depth + 1, counter);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects`);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${label} contains a symbol key`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(`${label} contains a non-data JSON property`);
      }
      assertJsonPayload(descriptor.value, label, seen, depth + 1, counter);
    }
  }
  seen.delete(value);
}

function deepFreezeCheckpointData<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const key of Reflect.ownKeys(object)) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && 'value' in descriptor) {
      deepFreezeCheckpointData(descriptor.value, seen);
    }
  }
  Object.freeze(object);
  return value;
}

function validateCheckpointManifest(value: unknown): void {
  assertRecord(value, 'checkpoint run manifest');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== RUN_MANIFEST_KEYS.size || keys.some(key =>
    typeof key !== 'string' || !RUN_MANIFEST_KEYS.has(key))) {
    throw new Error('checkpoint run manifest fields are invalid');
  }
  assertBoundedString(value.visibleModelLabel, 'manifest visibleModelLabel', 256, true);
  assertHash(value.promptSnapshotHash, 'manifest promptSnapshotHash');
  assertHash(value.toolSchemaHash, 'manifest toolSchemaHash');
  assertBoundedString(value.controllerVersion, 'manifest controllerVersion', 128, true);
  assertBoundedString(
    value.environmentAdapterVersion,
    'manifest environmentAdapterVersion',
    256,
    true,
  );
}

function validateCheckpointSchema(value: unknown, includeCheckpointHash: boolean): void {
  assertRecord(value, 'checkpoint');
  assertCheckpointOwnKeys(value, includeCheckpointHash);
  if (value.schema !== 'metaharness.arc_agi_3.checkpoint.v1') {
    throw new Error('checkpoint schema is invalid');
  }
  if (typeof value.principalScope !== 'string' || !PRINCIPAL_SCOPE.test(value.principalScope) ||
      typeof value.opaqueGameScope !== 'string' || !GAME_SCOPE.test(value.opaqueGameScope) ||
      typeof value.runId !== 'string' || !RUN_SCOPE.test(value.runId)) {
    throw new Error('checkpoint principal, game, or run scope ID is invalid');
  }
  if (!Number.isSafeInteger(value.startedAtMs) || (value.startedAtMs as number) < 0 ||
      !Number.isSafeInteger(value.createdAtMs) || (value.createdAtMs as number) < 0 ||
      (value.createdAtMs as number) < (value.startedAtMs as number)) {
    throw new Error('checkpoint timestamps are invalid or out of order');
  }
  validateCheckpointManifest(value.runManifest);
  const budget = validateArcRunBudget(value.budget);
  if (!Array.isArray(value.receipts) || !Array.isArray(value.frameBlobs) ||
      !Array.isArray(value.episodes) || !Array.isArray(value.idempotency) ||
      !Array.isArray(value.supervisorCases) || !Array.isArray(value.directives)) {
    throw new Error('checkpoint collection fields must be arrays');
  }
  assertRecord(value.observation, 'checkpoint observation');
  validateExactArcObservation(value.observation, 'checkpoint observation');
  assertRecord(value.memory, 'checkpoint memory');
  if (!Array.isArray(value.memory.rules)) throw new Error('checkpoint memory rules must be an array');
  assertRecord(value.graph, 'checkpoint graph');
  if (!Array.isArray(value.graph.nodes) || !Array.isArray(value.graph.edges)) {
    throw new Error('checkpoint graph nodes and edges must be arrays');
  }
  if (value.receipts.length > budget.maxActions ||
      value.episodes.length > budget.maxActions ||
      value.idempotency.length > budget.maxActions) {
    throw new Error('checkpoint transition collections exceed the action budget');
  }
  if (value.frameBlobs.length > value.receipts.length * MAX_ARC_ANIMATION_FRAMES) {
    throw new Error('checkpoint frame blobs exceed bounded transition evidence');
  }
  if (value.memory.rules.length > MAX_SEMANTIC_RULE_VERSIONS) {
    throw new Error('checkpoint memory rules exceed bounded capacity');
  }
  if (value.graph.nodes.length > value.receipts.length + 1 ||
      value.graph.edges.length > value.receipts.length) {
    throw new Error('checkpoint belief graph exceeds its transition history');
  }
  assertHash(value.memorySnapshotHash, 'checkpoint memorySnapshotHash');
  if (!Number.isSafeInteger(value.uncertainMutationCount) ||
      (value.uncertainMutationCount as number) < 0) {
    throw new Error('checkpoint uncertainMutationCount must be a nonnegative safe integer');
  }
  if (typeof value.phase !== 'string' || !CHECKPOINT_PHASES.has(value.phase)) {
    throw new Error('checkpoint phase is invalid');
  }
  if (typeof value.closed !== 'boolean' || (value.phase === 'CLOSED') !== value.closed) {
    throw new Error('checkpoint phase and closed flag are inconsistent');
  }
  if (value.lastError !== undefined && (
    typeof value.lastError !== 'string' || !value.lastError.trim() ||
    value.lastError.length > 256 || /[\u0000-\u001f]/.test(value.lastError)
  )) {
    throw new Error('checkpoint lastError must be bounded public text');
  }
  if (value.phase === 'FAULTED' && value.lastError === undefined) {
    throw new Error('a faulted checkpoint must include lastError');
  }
  if (value.sessionStateHash !== undefined && (
    typeof value.sessionStateHash !== 'string' || !HEX_HASH.test(value.sessionStateHash)
  )) {
    throw new Error('checkpoint sessionStateHash is invalid');
  }
  if (includeCheckpointHash) assertHash(value.checkpointHash, 'checkpoint hash');
  if (value.environmentCheckpoint === undefined) {
    throw new Error('checkpoint environmentCheckpoint must use null when non-resumable');
  }
  assertJsonPayload(value.environmentCheckpoint, 'checkpoint environmentCheckpoint');
  const state = value.observation.state;
  if (value.phase === 'WON' && state !== 'WIN') {
    throw new Error('a WON checkpoint must contain a WIN observation');
  }
  if (state === 'WIN' && value.phase !== 'WON' && value.phase !== 'CLOSED') {
    throw new Error('a WIN observation requires a WON or CLOSED checkpoint phase');
  }
}

function observationAtSequence(
  checkpoint: ArcCheckpointBody,
  receipts: readonly TransitionReceipt[],
  sequence: number,
): { readonly observationHash: string; readonly state: GameState } {
  if (sequence === 0) {
    const first = receipts[0];
    return first
      ? { observationHash: first.preObservationHash, state: first.stateBefore }
      : {
          observationHash: checkpoint.observation.observationHash,
          state: checkpoint.observation.state,
        };
  }
  const receipt = receipts[sequence - 1];
  if (!receipt) throw new Error('supervisor sequence does not identify a checkpoint observation');
  return { observationHash: receipt.postObservationHash, state: receipt.stateAfter };
}

function openCaseHash(supervisorCase: SupervisorCase): string {
  const { caseHash: _caseHash, ...body } = supervisorCase;
  return hashArcValue({ ...body, status: 'OPEN' });
}

function validateSupervisorHypothesis(
  raw: unknown,
  receiptByHash: ReadonlyMap<string, TransitionReceipt>,
  committedAtSequence: number,
): SupervisorHypothesis {
  assertRecord(raw, 'supervisor hypothesis');
  assertExactKeys(raw, SUPERVISOR_HYPOTHESIS_KEYS, 'supervisor hypothesis');
  const hypothesis = raw as unknown as SupervisorHypothesis;
  assertBoundedString(hypothesis.hypothesis, 'supervisor hypothesis text', 4_096);
  assertBoundedString(hypothesis.falsifier, 'supervisor hypothesis falsifier', 4_096);
  assertUniqueStrings(
    hypothesis.evidenceReceiptHashes,
    'supervisor hypothesis evidence',
    128,
    256,
  );
  for (const hash of hypothesis.evidenceReceiptHashes) {
    const receipt = receiptByHash.get(hash);
    if (!receipt || receipt.sequence > committedAtSequence) {
      throw new Error('supervisor hypothesis cites missing or future receipt evidence');
    }
  }
  validateArcAction(hypothesis.proposedNextAction);
  return hypothesis;
}

function validateSupervisorState(
  checkpoint: ArcCheckpointBody,
  receipts: readonly TransitionReceipt[],
): void {
  const rawCases: unknown = checkpoint.supervisorCases;
  const rawDirectives: unknown = checkpoint.directives;
  if (!Array.isArray(rawCases) || rawCases.length > MAX_SUPERVISOR_RECORDS ||
      !Array.isArray(rawDirectives) || rawDirectives.length > MAX_SUPERVISOR_RECORDS) {
    throw new Error('checkpoint supervisor records exceed bounded capacity');
  }

  const receiptByHash = new Map(receipts.map(receipt => [receipt.receiptHash, receipt]));
  const casesById = new Map<string, SupervisorCase>();
  let openCaseCount = 0;
  for (const rawCase of rawCases) {
    assertRecord(rawCase, 'supervisor case');
    assertExactKeys(rawCase, SUPERVISOR_CASE_KEYS, 'supervisor case');
    const supervisorCase = rawCase as unknown as SupervisorCase;
    if (!SUPERVISOR_CASE_ID.test(supervisorCase.id) || casesById.has(supervisorCase.id)) {
      throw new Error('checkpoint supervisor case IDs must be unique and canonical');
    }
    if (supervisorCase.principalScope !== checkpoint.principalScope ||
        supervisorCase.opaqueGameScope !== checkpoint.opaqueGameScope ||
        supervisorCase.runId !== checkpoint.runId) {
      throw new Error('checkpoint supervisor case has a foreign scope');
    }
    if (!SUPERVISOR_TRIGGERS.has(supervisorCase.trigger) ||
        (supervisorCase.status !== 'OPEN' && supervisorCase.status !== 'RESOLVED')) {
      throw new Error('checkpoint supervisor case trigger or status is invalid');
    }
    assertInteger(
      supervisorCase.openedAtSequence,
      'supervisor case openedAtSequence',
      0,
      receipts.length,
    );
    assertUniqueStrings(
      supervisorCase.evidenceReceiptHashes,
      'supervisor case evidence',
      MAX_SUPERVISOR_RECORDS,
      256,
    );
    for (const hash of supervisorCase.evidenceReceiptHashes) {
      const receipt = receiptByHash.get(hash);
      if (!receipt || receipt.sequence > supervisorCase.openedAtSequence) {
        throw new Error('supervisor case cites missing or future receipt evidence');
      }
    }
    assertRecord(supervisorCase.metrics, 'supervisor case metrics');
    const metrics = Object.entries(supervisorCase.metrics);
    if (metrics.length > 64 || metrics.some(([key, value]) =>
      !key.trim() || key.length > 128 || !Number.isFinite(value))) {
      throw new Error('supervisor case metrics are invalid');
    }
    assertHash(supervisorCase.caseHash, 'supervisor case hash');
    const { caseHash, ...caseBody } = supervisorCase;
    if (hashArcValue(caseBody) !== caseHash) {
      throw new Error('supervisor case hash does not match its canonical body');
    }
    const { id: _id, ...openBase } = caseBody;
    const expectedId = `supervisor_case_${hashArcValue({
      ...openBase,
      status: 'OPEN',
    }).slice(0, 32)}`;
    if (supervisorCase.id !== expectedId) {
      throw new Error('supervisor case ID does not match its canonical open body');
    }
    if (supervisorCase.trigger === 'MODEL_CONTRADICTION' &&
        supervisorCase.evidenceReceiptHashes.length === 0) {
      throw new Error('MODEL_CONTRADICTION supervisor cases require receipt evidence');
    }
    if (supervisorCase.status === 'OPEN') openCaseCount++;
    casesById.set(supervisorCase.id, supervisorCase);
  }
  if (openCaseCount > 1) {
    throw new Error('checkpoint contains more than one open supervisor case');
  }

  const directiveIds = new Set<string>();
  const directiveHashes = new Set<string>();
  const commitHashes = new Set<string>();
  const directedCaseIds = new Set<string>();
  const directives: SupervisorDirective[] = [];
  let priorCommittedAtSequence = -1;
  for (const rawDirective of rawDirectives) {
    assertRecord(rawDirective, 'supervisor directive');
    assertExactKeys(rawDirective, SUPERVISOR_DIRECTIVE_KEYS, 'supervisor directive');
    const directive = rawDirective as unknown as SupervisorDirective;
    if (!SUPERVISOR_DIRECTIVE_ID.test(directive.id) || directiveIds.has(directive.id)) {
      throw new Error('checkpoint supervisor directive IDs must be unique and canonical');
    }
    if (directive.principalScope !== checkpoint.principalScope ||
        directive.opaqueGameScope !== checkpoint.opaqueGameScope ||
        directive.runId !== checkpoint.runId) {
      throw new Error('checkpoint supervisor directive has a foreign scope');
    }
    if (!SUPERVISOR_TRIGGERS.has(directive.trigger) || !SUPERVISOR_MODES.has(directive.mode)) {
      throw new Error('checkpoint supervisor directive trigger or mode is invalid');
    }
    assertBoundedString(directive.diagnosis, 'supervisor directive diagnosis', 4_096, true);
    assertHash(directive.caseHash, 'supervisor directive case hash');
    assertHash(directive.expectedObservationHash, 'supervisor expected observation hash');
    assertHash(directive.observationHash, 'supervisor observation hash');
    assertHash(directive.commitHash, 'supervisor commit hash');
    assertHash(directive.directiveHash, 'supervisor directive hash');
    if (directive.expectedObservationHash !== directive.observationHash) {
      throw new Error('supervisor directive observation hashes differ');
    }
    assertUniqueStrings(directive.requiredEvidence, 'supervisor required evidence', 256, 256);
    assertUniqueStrings(directive.prohibitedEdges, 'supervisor prohibited edges', 256, 256);
    assertInteger(directive.actionBudget, 'supervisor actionBudget', 0, 10_000);
    assertInteger(directive.expiresAfterActions, 'supervisor expiresAfterActions', 0, 10_000);
    if (directive.expiresAfterActions > directive.actionBudget) {
      throw new Error('supervisor directive expiry exceeds its action budget');
    }
    assertInteger(
      directive.committedAtSequence,
      'supervisor committedAtSequence',
      0,
      receipts.length,
    );
    if (directive.committedAtSequence < priorCommittedAtSequence) {
      throw new Error('supervisor directives are not in commit order');
    }
    priorCommittedAtSequence = directive.committedAtSequence;

    const supervisorCase = casesById.get(directive.caseId);
    if (!supervisorCase || supervisorCase.status !== 'RESOLVED' ||
        directedCaseIds.has(directive.caseId)) {
      throw new Error('supervisor directive lacks a unique resolved backing case');
    }
    if (directive.caseHash !== openCaseHash(supervisorCase) ||
        directive.trigger !== supervisorCase.trigger ||
        directive.committedAtSequence < supervisorCase.openedAtSequence) {
      throw new Error('supervisor directive does not match its backing case');
    }
    const caseEvidence = new Set(supervisorCase.evidenceReceiptHashes);
    for (const hash of directive.requiredEvidence) {
      const receipt = receiptByHash.get(hash);
      if (!receipt || receipt.sequence > directive.committedAtSequence || !caseEvidence.has(hash)) {
        throw new Error('supervisor directive cites unsupported or future case evidence');
      }
    }

    const commitObservation = observationAtSequence(
      checkpoint,
      receipts,
      directive.committedAtSequence,
    );
    if (directive.expectedObservationHash !== commitObservation.observationHash) {
      throw new Error('supervisor directive was committed for a different observation');
    }
    if (directive.mode === 'RESET' &&
        commitObservation.state !== 'NOT_PLAYED' && commitObservation.state !== 'GAME_OVER') {
      throw new Error('RESET supervisor directive was not legal at commit time');
    }

    const hasAdvice = directive.hypotheses !== undefined ||
      directive.recommendedStrategy !== undefined || directive.constraints !== undefined;
    if (hasAdvice) {
      if (!Array.isArray(directive.hypotheses) || directive.hypotheses.length !== 3) {
        throw new Error('supervisor advice must contain exactly three hypotheses');
      }
      assertBoundedString(
        directive.recommendedStrategy,
        'supervisor recommended strategy',
        4_096,
        true,
      );
      assertUniqueStrings(directive.constraints, 'supervisor constraints', 64, 1_024);
      const hypotheses = directive.hypotheses.map(hypothesis =>
        validateSupervisorHypothesis(hypothesis, receiptByHash, directive.committedAtSequence));
      const normalized = hypotheses.map(hypothesis =>
        hypothesis.hypothesis.trim().replace(/\s+/g, ' ').toLowerCase());
      const falsifiers = hypotheses.map(hypothesis =>
        hypothesis.falsifier.trim().replace(/\s+/g, ' ').toLowerCase());
      if (new Set(normalized).size !== 3 || new Set(falsifiers).size !== 3) {
        throw new Error('supervisor advice hypotheses and falsifiers must be distinct');
      }
    }

    const { directiveHash, ...directiveBody } = directive;
    if (hashArcValue(directiveBody) !== directiveHash) {
      throw new Error('supervisor directive hash does not match its canonical body');
    }
    const { id: _id, ...directiveBase } = directiveBody;
    const expectedId = `supervisor_directive_${hashArcValue(directiveBase).slice(0, 32)}`;
    if (directive.id !== expectedId) {
      throw new Error('supervisor directive ID does not match its canonical body');
    }
    if (directiveHashes.has(directive.directiveHash) || commitHashes.has(directive.commitHash)) {
      throw new Error('checkpoint reuses a supervisor directive or commit hash');
    }
    directiveIds.add(directive.id);
    directiveHashes.add(directive.directiveHash);
    commitHashes.add(directive.commitHash);
    directedCaseIds.add(directive.caseId);
    directives.push(directive);
  }

  for (const supervisorCase of casesById.values()) {
    const hasDirective = directedCaseIds.has(supervisorCase.id);
    if ((supervisorCase.status === 'RESOLVED') !== hasDirective) {
      throw new Error('supervisor case resolution does not match directive backing');
    }
  }

  let nextDirectiveIndex = 0;
  let latestHistoricalDirective: SupervisorDirective | undefined;
  for (const receipt of receipts) {
    while (nextDirectiveIndex < directives.length &&
        directives[nextDirectiveIndex]!.committedAtSequence < receipt.sequence) {
      latestHistoricalDirective = directives[nextDirectiveIndex];
      nextDirectiveIndex++;
    }
    const latest = latestHistoricalDirective;
    const usedBefore = latest === undefined
      ? 0
      : receipt.sequence - 1 - latest.committedAtSequence;
    const active = latest !== undefined &&
      (latest.mode === 'STOP' || usedBefore < latest.expiresAfterActions)
      ? latest
      : undefined;
    if (receipt.directiveId !== active?.id) {
      throw new Error('checkpoint receipt directive does not match the active supervisor directive');
    }
    if (!active) continue;
    if (active.mode === 'STOP' || usedBefore >= active.actionBudget) {
      throw new Error('checkpoint records an action after a supervisor stop or budget');
    }
    if (active.prohibitedEdges.includes(
      observableEdgeKey(receipt.preObservationHash, receipt.action),
    )) {
      throw new Error('checkpoint receipt uses a supervisor-prohibited edge');
    }
    if (active.mode === 'RESET' && receipt.action.name !== 'RESET') {
      throw new Error('checkpoint RESET directive does not govern a RESET action');
    }
  }

  const activeId: unknown = checkpoint.activeDirectiveId;
  if (activeId !== undefined &&
      (typeof activeId !== 'string' || !SUPERVISOR_DIRECTIVE_ID.test(activeId))) {
    throw new Error('checkpoint active supervisor directive ID is invalid');
  }
  const latest = directives.at(-1);
  const used = latest ? receipts.length - latest.committedAtSequence : 0;
  const latestIsCurrent = latest !== undefined &&
    (latest.mode === 'STOP' || used < latest.expiresAfterActions);
  if (activeId === undefined) {
    if (latestIsCurrent) {
      throw new Error('checkpoint omits its current supervisor directive');
    }
  } else if (!latest || latest.id !== activeId || !latestIsCurrent) {
    throw new Error('checkpoint active supervisor directive is missing, stale, or not latest');
  }
  if (latest?.mode === 'STOP' && used !== 0) {
    throw new Error('checkpoint records actions after an active STOP directive');
  }
}

function validateCheckpointCrossFields(
  checkpoint: ArcCheckpointBody,
  receipts: readonly TransitionReceipt[],
): void {
  if (checkpoint.observation.opaqueGameScope !== checkpoint.opaqueGameScope) {
    throw new Error('checkpoint observation has a foreign opaque game scope');
  }
  const checkpointManifestHash = hashArcValue(checkpoint.runManifest);
  for (const receipt of receipts) {
    if (receipt.principalScope !== checkpoint.principalScope ||
        receipt.opaqueGameScope !== checkpoint.opaqueGameScope ||
        receipt.runId !== checkpoint.runId) {
      throw new Error('checkpoint receipt scope differs from checkpoint scope');
    }
    if (receipt.runManifestHash !== checkpointManifestHash) {
      throw new Error('checkpoint receipt manifest differs from checkpoint run manifest');
    }
    if (receipt.createdAtMs < checkpoint.startedAtMs ||
        receipt.createdAtMs > checkpoint.createdAtMs) {
      throw new Error('checkpoint receipt timestamp is outside the checkpoint lifetime');
    }
  }
  validateCheckpointBeliefHistory(checkpoint, receipts);
  const last = receipts.at(-1);
  if (last && (
    checkpoint.observation.observationHash !== last.postObservationHash ||
    checkpoint.observation.state !== last.stateAfter ||
    checkpoint.observation.levelsCompleted !== last.levelsCompletedAfter ||
    checkpoint.observation.currentFrame.frameRef !== last.returnedFrameRefs.at(-1)
  )) {
    throw new Error('checkpoint current observation does not continue its receipt head');
  }

  const currentBeliefKey = checkpoint.graph.currentBeliefKey;
  const currentBelief = checkpoint.graph.nodes.find(node => node.key === currentBeliefKey);
  if (!currentBelief || currentBelief.principalScope !== checkpoint.principalScope ||
      currentBelief.opaqueGameScope !== checkpoint.opaqueGameScope ||
      currentBelief.runId !== checkpoint.runId ||
      currentBelief.observationHash !== checkpoint.observation.observationHash ||
      currentBelief.frameHash !== checkpoint.observation.currentFrame.frameHash ||
      (last !== undefined && currentBelief.key !== last.postBeliefKey)) {
    throw new Error('checkpoint current belief does not match its current observation');
  }

  if (!Array.isArray(checkpoint.episodes) || checkpoint.episodes.length !== receipts.length) {
    throw new Error('checkpoint episodes do not cover every transition receipt');
  }
  for (let index = 0; index < receipts.length; index++) {
    const episode = checkpoint.episodes[index]!;
    const receipt = receipts[index]!;
    assertRecord(episode, 'checkpoint episode');
    assertExactKeys(episode as unknown as Record<string, unknown>, EPISODE_KEYS, 'checkpoint episode');
    const preBelief = checkpoint.graph.nodes.find(node => node.key === receipt.preBeliefKey);
    const postFrame = receipt.frames.at(-1);
    const expectedEffectClass = receipt.stateAfter === 'WIN' || receipt.stateAfter === 'GAME_OVER'
      ? 'TERMINAL'
      : receipt.levelsCompletedAfter !== receipt.levelsCompletedBefore
        ? 'PROGRESS'
        : preBelief && postFrame && preBelief.frameHash !== postFrame.frameHash
          ? 'GRID_CHANGE'
          : 'NO_EFFECT';
    if (episode.id !== receipt.episodeId || episode.sequence !== receipt.sequence ||
        episode.receiptHash !== receipt.receiptHash ||
        episode.principalScope !== checkpoint.principalScope ||
        episode.opaqueGameScope !== checkpoint.opaqueGameScope || episode.runId !== checkpoint.runId ||
        episode.preBeliefKey !== receipt.preBeliefKey ||
        episode.postBeliefKey !== receipt.postBeliefKey ||
        episode.preObservationHash !== receipt.preObservationHash ||
        episode.postObservationHash !== receipt.postObservationHash ||
        hashArcValue(episode.action) !== hashArcValue(receipt.action) ||
        episode.effectClass !== expectedEffectClass ||
        episode.progressDelta !== receipt.levelsCompletedAfter - receipt.levelsCompletedBefore ||
        episode.predictionError !== receipt.predictionError || episode.noEffect !== receipt.noEffect) {
      throw new Error('checkpoint episode does not match its transition receipt');
    }
  }

  const idempotency = hydrateCheckpointIdempotency(checkpoint, receipts);
  if (idempotency.length !== receipts.length ||
      new Set(idempotency.map(entry => entry.key)).size !== idempotency.length) {
    throw new Error('checkpoint idempotency ledger does not cover every transition receipt');
  }
  const seenReceiptHashes = new Set<string>();
  for (const entry of idempotency) {
    const receipt = entry.result.receipt;
    if (seenReceiptHashes.has(receipt.receiptHash) || entry.key !== receipt.idempotencyKey ||
        entry.requestHash !== receipt.requestHash ||
        entry.result.observation.observationHash !== receipt.postObservationHash ||
        entry.result.observation.state !== receipt.stateAfter ||
        entry.result.observation.levelsCompleted !== receipt.levelsCompletedAfter ||
        entry.result.observation.currentFrame.frameRef !== receipt.returnedFrameRefs.at(-1) ||
        hashArcValue(entry.result.observation.frames) !== hashArcValue(receipt.frames) ||
        hashArcValue(entry.result.observation.frames.map(frame => frame.frameRef)) !==
          hashArcValue(receipt.returnedFrameRefs)) {
      throw new Error('checkpoint idempotency result does not match its transition receipt');
    }
    seenReceiptHashes.add(receipt.receiptHash);
  }
  if (last) {
    const latestResult = idempotency.find(entry =>
      entry.result.receipt.receiptHash === last.receiptHash);
    if (!latestResult ||
        hashArcValue(latestResult.result.observation) !== hashArcValue(checkpoint.observation)) {
      throw new Error('checkpoint current observation differs from its latest idempotency result');
    }
  }

  const referencedFrameBlobs = new Set(
    checkpoint.receipts.flatMap(receipt => receipt.frameBlobHashes),
  );
  if (referencedFrameBlobs.size !== checkpoint.frameBlobs.length ||
      checkpoint.frameBlobs.some(blob => !referencedFrameBlobs.has(blob.blobHash))) {
    throw new Error('checkpoint contains missing, duplicate, or unreferenced frame blobs');
  }

  const memory = new EvidenceBackedMemory({
    principalScope: checkpoint.principalScope,
    opaqueGameScope: checkpoint.opaqueGameScope,
    runId: checkpoint.runId,
    receiptExists: hash => seenReceiptHashes.has(hash),
  });
  memory.loadEpisodes(checkpoint.episodes);
  memory.load(checkpoint.memory);
  const expectedMemorySnapshotHash = memorySnapshotHashFor(
    {
      principalScope: checkpoint.principalScope,
      opaqueGameScope: checkpoint.opaqueGameScope,
      runId: checkpoint.runId,
    },
    checkpoint.episodes,
    checkpoint.memory,
  );
  if (checkpoint.memorySnapshotHash !== expectedMemorySnapshotHash) {
    throw new Error('checkpoint memorySnapshotHash does not bind its memory snapshot');
  }

  validateSupervisorState(checkpoint, receipts);
}

function validateCheckpointBeliefHistory(
  checkpoint: ArcCheckpointBody,
  receipts: readonly TransitionReceipt[],
): void {
  const scope = {
    principalScope: checkpoint.principalScope,
    opaqueGameScope: checkpoint.opaqueGameScope,
    runId: checkpoint.runId,
  };
  validateBeliefGraphSnapshot(
    checkpoint.graph,
    scope,
    receipts.length + 1,
    receipts.length,
  );
  if (checkpoint.graph.nodes.length !== receipts.length + 1 ||
      checkpoint.graph.edges.length !== receipts.length) {
    throw new Error('checkpoint belief graph does not exactly cover its transition history');
  }

  const nodes = new Map(checkpoint.graph.nodes.map(node => [node.key, node]));
  const edges = new Map(checkpoint.graph.edges.map(edge => [edge.key, edge]));
  const firstObservationHash = receipts[0]?.preObservationHash ?? checkpoint.observation.observationHash;
  const genesisLatentContextHash = hashArcValue({
    genesis: true,
    observation: firstObservationHash,
  });
  const genesisKey = hiddenStateSafeBeliefKey({
    ...scope,
    observationHash: firstObservationHash,
    latentContextHash: genesisLatentContextHash,
  });
  const genesis = nodes.get(genesisKey);
  if (!genesis || genesis.latentContextHash !== genesisLatentContextHash || genesis.visits !== 1) {
    throw new Error('checkpoint belief graph genesis is invalid');
  }

  if (receipts.length === 0) {
    if (checkpoint.graph.currentBeliefKey !== genesisKey ||
        genesis.observationHash !== checkpoint.observation.observationHash ||
        genesis.frameHash !== checkpoint.observation.currentFrame.frameHash ||
        genesis.state !== checkpoint.observation.state ||
        genesis.levelsCompleted !== checkpoint.observation.levelsCompleted ||
        hashArcValue(genesis.availableActions) !== hashArcValue(checkpoint.observation.availableActions)) {
      throw new Error('checkpoint genesis belief does not match its observation');
    }
    return;
  }

  for (const receipt of receipts) {
    const from = nodes.get(receipt.preBeliefKey);
    const to = nodes.get(receipt.postBeliefKey);
    const returnedFrame = receipt.frames.at(-1);
    if (!from || !to || !returnedFrame || from.observationHash !== receipt.preObservationHash ||
        from.state !== receipt.stateBefore ||
        from.levelsCompleted !== receipt.levelsCompletedBefore ||
        to.observationHash !== receipt.postObservationHash || to.state !== receipt.stateAfter ||
        to.levelsCompleted !== receipt.levelsCompletedAfter ||
        to.frameHash !== returnedFrame.frameHash || from.visits !== 1 || to.visits !== 1) {
      throw new Error('checkpoint belief nodes do not match a transition receipt');
    }
    const expectedLatentContextHash = hashArcValue({
      previousLatentContextHash: from.latentContextHash,
      previousBeliefKey: from.key,
      action: receipt.action,
      resultingObservationHash: receipt.postObservationHash,
      sequence: receipt.sequence,
    });
    const expectedToKey = hiddenStateSafeBeliefKey({
      ...scope,
      observationHash: receipt.postObservationHash,
      latentContextHash: expectedLatentContextHash,
    });
    if (to.key !== expectedToKey || to.latentContextHash !== expectedLatentContextHash) {
      throw new Error('checkpoint belief transition does not continue its hidden-state history');
    }

    const edgeKey = `belief_edge_${hashArcValue({ from: from.key, action: receipt.action })}`;
    const edge = edges.get(edgeKey);
    const outcome = edge?.outcomes[0];
    if (!edge || edge.observationHash !== receipt.preObservationHash ||
        hashArcValue(edge.action) !== hashArcValue(receipt.action) || edge.testedCount !== 1 ||
        edge.noEffectCount !== (receipt.noEffect ? 1 : 0) || edge.outcomes.length !== 1 ||
        !outcome || outcome.toBeliefKey !== to.key || outcome.count !== 1 ||
        outcome.receiptHashes.length !== 1 || outcome.receiptHashes[0] !== receipt.receiptHash) {
      throw new Error('checkpoint belief edge does not exactly match its transition receipt');
    }
  }
}

function addFrame(
  frame: ExactGridFrame,
  blobs: Map<string, CheckpointFrameBlob>,
): string {
  const blobHash = hashArcValue(frame);
  const existing = blobs.get(blobHash);
  if (existing && hashArcValue(existing.frame) !== blobHash) {
    throw new Error('content-addressed frame collision');
  }
  if (!existing) blobs.set(blobHash, Object.freeze({ blobHash, frame }));
  return blobHash;
}

function compactObservation(
  observation: ExactArcObservation,
  blobs: Map<string, CheckpointFrameBlob>,
): CheckpointObservation {
  const { frames, currentFrame, ...rest } = observation;
  const frameBlobHashes = Object.freeze(frames.map(frame => addFrame(frame, blobs)));
  return Object.freeze({
    ...rest,
    frameBlobHashes,
    currentFrameBlobHash: addFrame(currentFrame, blobs),
  });
}

/** Deduplicate exact frame payloads while retaining receipt and idempotency semantics. */
export function compactCheckpointEvidence(
  receipts: readonly TransitionReceipt[],
  idempotency: readonly StoredIdempotencyResult[],
): {
  readonly receipts: readonly CheckpointTransitionReceipt[];
  readonly idempotency: readonly CheckpointIdempotencyResult[];
  readonly frameBlobs: readonly CheckpointFrameBlob[];
} {
  const blobs = new Map<string, CheckpointFrameBlob>();
  const compactReceipts = receipts.map(receipt => {
    const { frames, ...rest } = receipt;
    return Object.freeze({
      ...rest,
      frameBlobHashes: Object.freeze(frames.map(frame => addFrame(frame, blobs))),
    });
  });
  const compactIdempotency = idempotency.map(entry => Object.freeze({
    key: entry.key,
    requestHash: entry.requestHash,
    receiptHash: entry.result.receipt.receiptHash,
    observation: compactObservation(entry.result.observation, blobs),
  }));
  return Object.freeze({
    receipts: Object.freeze(compactReceipts),
    idempotency: Object.freeze(compactIdempotency),
    frameBlobs: Object.freeze([...blobs.values()]),
  });
}

function frameMap(checkpoint: ArcCheckpointBody): Map<string, ExactGridFrame> {
  const frames = new Map<string, ExactGridFrame>();
  for (const blob of checkpoint.frameBlobs) {
    if (!blob || typeof blob !== 'object' || Array.isArray(blob) ||
        Object.getPrototypeOf(blob) !== Object.prototype ||
        Reflect.ownKeys(blob).length !== 2 || Reflect.ownKeys(blob).some(key =>
          typeof key !== 'string' || (key !== 'blobHash' && key !== 'frame') ||
          !Object.getOwnPropertyDescriptor(blob, key)?.enumerable ||
          !('value' in Object.getOwnPropertyDescriptor(blob, key)!)) ||
        typeof blob.blobHash !== 'string' || !HEX_HASH.test(blob.blobHash) ||
        frames.has(blob.blobHash)) {
      throw new Error('checkpoint contains an invalid or duplicate frame blob');
    }
    validateExactGridFrame(blob.frame, 'checkpoint frame blob');
    if (hashArcValue(blob.frame) !== blob.blobHash) {
      throw new Error('checkpoint frame blob hash does not match its exact frame');
    }
    frames.set(blob.blobHash, deepFreezeCheckpointData(blob.frame));
  }
  return frames;
}

export function hydrateCheckpointReceipts(
  checkpoint: ArcCheckpointBody,
): readonly TransitionReceipt[] {
  const frames = frameMap(checkpoint);
  const receipts = checkpoint.receipts.map(compact => {
    const { frameBlobHashes, ...rest } = compact;
    const exactFrames = frameBlobHashes.map(blobHash => {
      const frame = frames.get(blobHash);
      if (!frame) throw new Error(`checkpoint references missing frame blob ${blobHash}`);
      return frame;
    });
    const receipt: TransitionReceipt = deepFreezeCheckpointData({
      ...rest,
      frames: Object.freeze(exactFrames),
    });
    return receipt;
  });
  const verification = verifyTransitionReceipts(receipts);
  if (!verification.ok) {
    throw new Error(`checkpoint receipt chain is invalid: ${verification.reason}`);
  }
  return Object.freeze(receipts);
}

function hydrateObservation(
  compact: CheckpointObservation,
  frames: ReadonlyMap<string, ExactGridFrame>,
): ExactArcObservation {
  const { frameBlobHashes, currentFrameBlobHash, ...rest } = compact;
  const exactFrames = frameBlobHashes.map(blobHash => {
    const frame = frames.get(blobHash);
    if (!frame) throw new Error(`checkpoint references missing frame blob ${blobHash}`);
    return frame;
  });
  const currentFrame = frames.get(currentFrameBlobHash);
  if (!currentFrame || exactFrames.at(-1)?.frameRef !== currentFrame.frameRef) {
    throw new Error('checkpoint compact observation current frame is invalid');
  }
  const observation = deepFreezeCheckpointData({
    ...rest,
    frames: Object.freeze(exactFrames),
    currentFrame,
  });
  validateExactArcObservation(observation, 'checkpoint compact observation');
  return observation;
}

export function hydrateCheckpointIdempotency(
  checkpoint: ArcCheckpointBody,
  receipts: readonly TransitionReceipt[],
): readonly StoredIdempotencyResult[] {
  const frames = frameMap(checkpoint);
  const byHash = new Map(receipts.map(receipt => [receipt.receiptHash, receipt]));
  return Object.freeze(checkpoint.idempotency.map(entry => {
    assertRecord(entry, 'checkpoint idempotency entry');
    assertExactKeys(
      entry as unknown as Record<string, unknown>,
      CHECKPOINT_IDEMPOTENCY_KEYS,
      'checkpoint idempotency entry',
    );
    const receipt = byHash.get(entry.receiptHash);
    if (!receipt) throw new Error('checkpoint idempotency entry references a missing receipt');
    const observation = hydrateObservation(entry.observation, frames);
    const result: ActResult = Object.freeze({ observation, receipt, replayed: false });
    return Object.freeze({ key: entry.key, requestHash: entry.requestHash, result });
  }));
}

export function createArcCheckpoint(body: ArcCheckpointBody): ArcCheckpoint {
  validateCheckpointSchema(body, false);
  if (containsRawGameIdentityKey(body)) {
    throw new Error('checkpoint contains a forbidden raw game identity field');
  }
  if (!Number.isInteger(body.uncertainMutationCount) || body.uncertainMutationCount < 0 ||
      !/^[0-9a-f]{64}$/.test(body.memorySnapshotHash)) {
    throw new Error('checkpoint mutation count or memory snapshot hash is invalid');
  }
  const receipts = hydrateCheckpointReceipts(body);
  validateCheckpointCrossFields(body, receipts);
  deepFreezeCheckpointData(body);
  return Object.freeze({ ...body, checkpointHash: hashArcValue(body) });
}

export function verifyArcCheckpoint(checkpoint: ArcCheckpoint): void {
  validateCheckpointSchema(checkpoint, true);
  if (containsRawGameIdentityKey(checkpoint)) {
    throw new Error('checkpoint contains a forbidden raw game identity field');
  }
  if (!Number.isInteger(checkpoint.uncertainMutationCount) ||
      checkpoint.uncertainMutationCount < 0 ||
      !/^[0-9a-f]{64}$/.test(checkpoint.memorySnapshotHash)) {
    throw new Error('checkpoint mutation count or memory snapshot hash is invalid');
  }
  const { checkpointHash, ...body } = checkpoint;
  if (hashArcValue(body) !== checkpointHash) {
    throw new Error('checkpointHash does not match the canonical checkpoint body');
  }
  const receipts = hydrateCheckpointReceipts(checkpoint);
  validateCheckpointCrossFields(checkpoint, receipts);
  deepFreezeCheckpointData(checkpoint);
}
