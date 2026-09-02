import {
  containsRawGameIdentityKey,
  exactCellDelta,
  hashArcValue,
  MAX_ARC_ANIMATION_FRAMES,
  MAX_ARC_OBSERVATION_CELLS,
  MAX_ARC_RUN_ACTIONS,
  snapshotArcJson,
  validateArcAction,
  validateExactGridFrame,
  validateExpectation,
} from './canonical.js';
import { hiddenStateSafeBeliefKey } from './belief-graph.js';
import type {
  ExactGridFrame,
  OfficialReceiptCounts,
  ReceiptReconciliation,
  ReceiptVerification,
  TransitionReceipt,
} from './types.js';

export const TRANSITION_RECEIPT_GENESIS = '0'.repeat(64);

const HEX_HASH = /^[0-9a-f]{64}$/;
const PRINCIPAL_SCOPE = /^principal_[0-9a-f]{24}$/;
const GAME_SCOPE = /^game_[0-9a-f]{24}$/;
const RUN_SCOPE = /^run_[0-9a-f]{24}$/;
const EPISODE_ID = /^episode_[0-9a-f]{32}$/;
const BELIEF_KEY = /^belief_[0-9a-f]{64}$/;
const DIRECTIVE_ID = /^supervisor_directive_[0-9a-f]{32}$/;
const GAME_STATES = new Set(['NOT_PLAYED', 'NOT_FINISHED', 'WIN', 'GAME_OVER']);

const RECEIPT_REQUIRED_KEYS = new Set([
  'schema',
  'runId',
  'principalScope',
  'opaqueGameScope',
  'sequence',
  'episodeId',
  'idempotencyKey',
  'requestHash',
  'createdAtMs',
  'visibleModelLabel',
  'promptSnapshotHash',
  'toolSchemaHash',
  'controllerVersion',
  'environmentAdapterVersion',
  'runManifestHash',
  'memorySnapshotHash',
  'preObservationHash',
  'postObservationHash',
  'preBeliefKey',
  'postBeliefKey',
  'stateBefore',
  'stateAfter',
  'levelsCompletedBefore',
  'levelsCompletedAfter',
  'action',
  'expectation',
  'exactDelta',
  'frames',
  'returnedFrameRefs',
  'predictionError',
  'noEffect',
  'previousReceiptHash',
  'receiptHash',
]);

const RECEIPT_OPTIONAL_KEYS = new Set(['directiveId']);
const DRAFT_REQUIRED_KEYS = new Set(
  [...RECEIPT_REQUIRED_KEYS].filter(key =>
    key !== 'schema' && key !== 'previousReceiptHash' && key !== 'receiptHash'),
);
const DRAFT_OPTIONAL_KEYS = new Set(['directiveId']);
const DELTA_KEYS = new Set(['x', 'y', 'before', 'after']);

interface ReceiptChainNode {
  readonly receipt: TransitionReceipt;
  readonly previous?: ReceiptChainNode;
}

interface ReceiptChainState {
  count: number;
  previousReceiptHash: string;
  principalScope?: string;
  opaqueGameScope?: string;
  runId?: string;
  manifestHash?: string;
  prior?: TransitionReceipt;
  latentContextHash?: string;
  idempotencyKeys: Set<string>;
  receiptHashes: Set<string>;
  node?: ReceiptChainNode;
  reusable: boolean;
}

const VERIFIED_CHAIN_CACHE = new WeakMap<object, ReceiptChainState>();
const PENDING_APPEND_CACHE = new WeakMap<object, ReceiptChainState>();
const APPEND_OWNED_RECEIPTS = new WeakSet<object>();

function assertPlainReceipt(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('receipt must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' ||
      (!RECEIPT_REQUIRED_KEYS.has(key) && !RECEIPT_OPTIONAL_KEYS.has(key)))) {
    throw new Error('receipt contains an unexpected field');
  }
  for (const required of RECEIPT_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, required)) {
      throw new Error(`receipt is missing required field ${required}`);
    }
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error('receipt fields must be enumerable data properties');
    }
  }
}

function assertPlainDraft(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('transition receipt draft must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' ||
      (!DRAFT_REQUIRED_KEYS.has(key) && !DRAFT_OPTIONAL_KEYS.has(key))) ||
      [...DRAFT_REQUIRED_KEYS].some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error('transition receipt draft fields are invalid');
  }
}

function receiptCollectionCount(receipts: readonly TransitionReceipt[]): number {
  if (!Array.isArray(receipts) || Object.getPrototypeOf(receipts) !== Array.prototype) {
    throw new Error('receipt collection is not a bounded dense array');
  }
  const count = receipts.length;
  const keys = Reflect.ownKeys(receipts);
  if (keys.some(key => typeof key !== 'string' ||
      (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) ||
      (key !== 'length' && (
        !Object.getOwnPropertyDescriptor(receipts, key)?.enumerable ||
        !('value' in Object.getOwnPropertyDescriptor(receipts, key)!)
      ))) || Object.keys(receipts).length !== count || count > MAX_ARC_RUN_ACTIONS) {
    throw new Error('receipt collection is not a bounded dense array');
  }
  return count;
}

function initialChainState(): ReceiptChainState {
  return {
    count: 0,
    previousReceiptHash: TRANSITION_RECEIPT_GENESIS,
    idempotencyKeys: new Set(),
    receiptHashes: new Set(),
    reusable: true,
  };
}

function cloneChainState(state: ReceiptChainState): ReceiptChainState {
  return {
    ...state,
    idempotencyKeys: new Set(state.idempotencyKeys),
    receiptHashes: new Set(state.receiptHashes),
  };
}

function chainObjectsMatch(
  receipts: readonly TransitionReceipt[],
  state: ReceiptChainState,
): boolean {
  if (!state.reusable || receipts.length !== state.count) return false;
  let node = state.node;
  for (let index = receipts.length - 1; index >= 0; index -= 1) {
    if (!node || receipts[index] !== node.receipt) return false;
    node = node.previous;
  }
  return node === undefined;
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) ||
      Object.keys(value).length !== value.length) {
    throw new Error(`${label} must be a dense plain array`);
  }
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HEX_HASH.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash`);
  }
}

function assertBoundedText(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() ||
      value.length > maximum || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`${label} must be bounded normalized text`);
  }
}

function frameCell(frame: ExactGridFrame, x: number, y: number): number | undefined {
  if (x < 0 || x >= frame.width || y < 0 || y >= frame.height) return undefined;
  return Number.parseInt(frame.rows[y]![x]!, 16);
}

function expectedPredictionError(
  receipt: TransitionReceipt,
  beforeFrame: ExactGridFrame | undefined,
): number | undefined {
  const results: boolean[] = [];
  const expectation = receipt.expectation;
  if (expectation.expectedObservationHash !== undefined) {
    results.push(expectation.expectedObservationHash === receipt.postObservationHash);
  }
  if (expectation.expectedState !== undefined) {
    results.push(expectation.expectedState === receipt.stateAfter);
  }
  if (expectation.expectedLevelsCompleted !== undefined) {
    results.push(expectation.expectedLevelsCompleted === receipt.levelsCompletedAfter);
  }
  if (expectation.expectedFrameHash !== undefined) {
    results.push(expectation.expectedFrameHash === receipt.frames.at(-1)!.frameHash);
  }
  for (const change of expectation.expectedChanges ?? []) {
    if (change.before !== undefined) {
      if (beforeFrame === undefined) return undefined;
      results.push(frameCell(beforeFrame, change.x, change.y) === change.before);
    }
    if (change.after !== undefined) {
      results.push(frameCell(receipt.frames.at(-1)!, change.x, change.y) === change.after);
    }
  }
  if (results.length === 0) return undefined;
  return results.reduce((count, matched) => count + (matched ? 0 : 1), 0) / results.length;
}

/** Strict standalone schema validation used before any receipt hash is trusted. */
export function validateTransitionReceiptSchema(
  value: unknown,
): asserts value is TransitionReceipt {
  assertPlainReceipt(value);
  const receipt = value as unknown as TransitionReceipt;
  if (receipt.schema !== 'metaharness.arc_agi_3.transition.v1') {
    throw new Error('receipt schema is invalid');
  }
  if (typeof receipt.principalScope !== 'string' || !PRINCIPAL_SCOPE.test(receipt.principalScope) ||
      typeof receipt.opaqueGameScope !== 'string' || !GAME_SCOPE.test(receipt.opaqueGameScope) ||
      typeof receipt.runId !== 'string' || !RUN_SCOPE.test(receipt.runId)) {
    throw new Error('receipt scope identifiers are invalid');
  }
  if (!Number.isSafeInteger(receipt.sequence) || receipt.sequence < 1 ||
      receipt.sequence > MAX_ARC_RUN_ACTIONS || !EPISODE_ID.test(receipt.episodeId)) {
    throw new Error('receipt sequence or episode ID is invalid');
  }
  if (typeof receipt.idempotencyKey !== 'string' || receipt.idempotencyKey.length < 8 ||
      receipt.idempotencyKey.length > 200 || /[^\x21-\x7e]/.test(receipt.idempotencyKey)) {
    throw new Error('receipt idempotency key is invalid');
  }
  assertHash(receipt.requestHash, 'receipt requestHash');
  if (Object.prototype.hasOwnProperty.call(receipt, 'directiveId') &&
      (typeof receipt.directiveId !== 'string' || !DIRECTIVE_ID.test(receipt.directiveId))) {
    throw new Error('receipt directiveId is invalid');
  }
  if (!Number.isSafeInteger(receipt.createdAtMs) || receipt.createdAtMs < 0) {
    throw new Error('receipt timestamp is invalid');
  }
  assertBoundedText(receipt.visibleModelLabel, 'receipt visibleModelLabel', 256);
  assertHash(receipt.promptSnapshotHash, 'receipt promptSnapshotHash');
  assertHash(receipt.toolSchemaHash, 'receipt toolSchemaHash');
  assertBoundedText(receipt.controllerVersion, 'receipt controllerVersion', 128);
  assertBoundedText(
    receipt.environmentAdapterVersion,
    'receipt environmentAdapterVersion',
    256,
  );
  for (const [label, hash] of [
    ['runManifestHash', receipt.runManifestHash],
    ['memorySnapshotHash', receipt.memorySnapshotHash],
    ['preObservationHash', receipt.preObservationHash],
    ['postObservationHash', receipt.postObservationHash],
    ['previousReceiptHash', receipt.previousReceiptHash],
    ['receiptHash', receipt.receiptHash],
  ] as const) assertHash(hash, `receipt ${label}`);
  if (typeof receipt.preBeliefKey !== 'string' || !BELIEF_KEY.test(receipt.preBeliefKey) ||
      typeof receipt.postBeliefKey !== 'string' || !BELIEF_KEY.test(receipt.postBeliefKey)) {
    throw new Error('receipt belief keys are invalid');
  }
  if (!GAME_STATES.has(receipt.stateBefore) || !GAME_STATES.has(receipt.stateAfter) ||
      !Number.isSafeInteger(receipt.levelsCompletedBefore) || receipt.levelsCompletedBefore < 0 ||
      !Number.isSafeInteger(receipt.levelsCompletedAfter) || receipt.levelsCompletedAfter < 0) {
    throw new Error('receipt state or progress is invalid');
  }
  validateArcAction(receipt.action);
  validateExpectation(receipt.expectation);
  if (receipt.stateBefore === 'WIN' ||
      ((receipt.stateBefore === 'NOT_PLAYED' || receipt.stateBefore === 'GAME_OVER') &&
        receipt.action.name !== 'RESET') ||
      (receipt.stateBefore === 'NOT_FINISHED' && receipt.action.name === 'RESET')) {
    throw new Error('receipt action is inconsistent with its pre-state');
  }
  assertDenseArray(receipt.exactDelta, 'receipt exactDelta');
  if (receipt.exactDelta.length > 64 * 64) {
    throw new Error('receipt exactDelta exceeds the grid bound');
  }
  let priorCoordinate = -1;
  for (const rawDelta of receipt.exactDelta) {
    if (!rawDelta || typeof rawDelta !== 'object' || Array.isArray(rawDelta) ||
        Object.getPrototypeOf(rawDelta) !== Object.prototype ||
        Reflect.ownKeys(rawDelta).length !== DELTA_KEYS.size ||
        Reflect.ownKeys(rawDelta).some(key => typeof key !== 'string' || !DELTA_KEYS.has(key) ||
          !Object.getOwnPropertyDescriptor(rawDelta, key)?.enumerable ||
          !('value' in Object.getOwnPropertyDescriptor(rawDelta, key)!))) {
      throw new Error('receipt exactDelta item schema is invalid');
    }
    const delta = rawDelta as { x: unknown; y: unknown; before: unknown; after: unknown };
    if (!Number.isSafeInteger(delta.x) || (delta.x as number) < 0 || (delta.x as number) > 63 ||
        !Number.isSafeInteger(delta.y) || (delta.y as number) < 0 || (delta.y as number) > 63 ||
        !Number.isSafeInteger(delta.before) || (delta.before as number) < -1 ||
        (delta.before as number) > 15 || !Number.isSafeInteger(delta.after) ||
        (delta.after as number) < -1 || (delta.after as number) > 15 ||
        delta.before === delta.after) {
      throw new Error('receipt exactDelta item values are invalid');
    }
    const coordinate = (delta.y as number) * 64 + (delta.x as number);
    if (coordinate <= priorCoordinate) throw new Error('receipt exactDelta is not canonical');
    priorCoordinate = coordinate;
  }
  assertDenseArray(receipt.frames, 'receipt frames');
  if (receipt.frames.length < 1 || receipt.frames.length > MAX_ARC_ANIMATION_FRAMES) {
    throw new Error('receipt frame count is invalid');
  }
  let totalCells = 0;
  for (let index = 0; index < receipt.frames.length; index += 1) {
    const frame = receipt.frames[index];
    validateExactGridFrame(frame, `receipt frame ${index}`);
    totalCells += frame.width * frame.height;
    if (totalCells > MAX_ARC_OBSERVATION_CELLS) {
      throw new Error('receipt frames exceed the observation cell bound');
    }
  }
  assertDenseArray(receipt.returnedFrameRefs, 'receipt returnedFrameRefs');
  if (receipt.returnedFrameRefs.length !== receipt.frames.length ||
      receipt.returnedFrameRefs.some((ref, index) =>
        typeof ref !== 'string' || ref !== receipt.frames[index]!.frameRef)) {
    throw new Error('receipt returnedFrameRefs do not exactly match returned frames');
  }
  if (!Number.isFinite(receipt.predictionError) || receipt.predictionError < 0 ||
      receipt.predictionError > 1 || typeof receipt.noEffect !== 'boolean') {
    throw new Error('receipt outcome metrics are invalid');
  }
}

function validateReceiptContinuation(
  receipt: TransitionReceipt,
  state: ReceiptChainState,
): void {
  validateTransitionReceiptSchema(receipt);
  if (containsRawGameIdentityKey(receipt)) {
    throw new Error('receipt contains a forbidden raw game identity field');
  }
  if (receipt.sequence !== state.count + 1) throw new Error('receipt sequence is not monotonic');
  if (state.idempotencyKeys.has(receipt.idempotencyKey)) {
    throw new Error('receipt idempotency key is duplicated');
  }
  if (state.receiptHashes.has(receipt.receiptHash)) throw new Error('receipt hash is duplicated');
  if (hashArcValue({
    expectedObservationHash: receipt.preObservationHash,
    idempotencyKey: receipt.idempotencyKey,
    action: receipt.action,
    expectation: receipt.expectation,
    ...(receipt.directiveId === undefined ? {} : { directiveId: receipt.directiveId }),
  }) !== receipt.requestHash) {
    throw new Error('receipt request fields do not match requestHash');
  }
  const prior = state.prior;
  if (prior && (
    receipt.preObservationHash !== prior.postObservationHash ||
    receipt.preBeliefKey !== prior.postBeliefKey ||
    receipt.stateBefore !== prior.stateAfter ||
    receipt.levelsCompletedBefore !== prior.levelsCompletedAfter
  )) throw new Error('receipt pre-state does not continue the prior receipt post-state');
  if (receipt.noEffect !== (receipt.preObservationHash === receipt.postObservationHash)) {
    throw new Error('receipt noEffect does not match its observation hashes');
  }
  if (receipt.previousReceiptHash !== state.previousReceiptHash) {
    throw new Error('previousReceiptHash does not chain');
  }
  const { receiptHash, ...body } = receipt;
  if (hashArcValue(body) !== receiptHash) {
    throw new Error('receiptHash does not match canonical receipt body');
  }
  state.principalScope ??= receipt.principalScope;
  state.opaqueGameScope ??= receipt.opaqueGameScope;
  state.runId ??= receipt.runId;
  state.manifestHash ??= receipt.runManifestHash;
  if (receipt.principalScope !== state.principalScope ||
      receipt.opaqueGameScope !== state.opaqueGameScope || receipt.runId !== state.runId ||
      receipt.runManifestHash !== state.manifestHash) {
    throw new Error('receipt changed run, principal, game, or manifest scope');
  }
  if (hashArcValue({
    visibleModelLabel: receipt.visibleModelLabel,
    promptSnapshotHash: receipt.promptSnapshotHash,
    toolSchemaHash: receipt.toolSchemaHash,
    controllerVersion: receipt.controllerVersion,
    environmentAdapterVersion: receipt.environmentAdapterVersion,
  }) !== receipt.runManifestHash) {
    throw new Error('receipt run manifest fields do not match runManifestHash');
  }
  let latentContextHash = state.latentContextHash;
  if (latentContextHash === undefined) {
    latentContextHash = hashArcValue({ genesis: true, observation: receipt.preObservationHash });
    if (receipt.preBeliefKey !== hiddenStateSafeBeliefKey({
      principalScope: receipt.principalScope,
      opaqueGameScope: receipt.opaqueGameScope,
      runId: receipt.runId,
      observationHash: receipt.preObservationHash,
      latentContextHash,
    })) throw new Error('receipt genesis belief key is invalid');
  }
  const nextLatentContextHash = hashArcValue({
    previousLatentContextHash: latentContextHash,
    previousBeliefKey: receipt.preBeliefKey,
    action: receipt.action,
    resultingObservationHash: receipt.postObservationHash,
    sequence: receipt.sequence,
  });
  if (receipt.postBeliefKey !== hiddenStateSafeBeliefKey({
    principalScope: receipt.principalScope,
    opaqueGameScope: receipt.opaqueGameScope,
    runId: receipt.runId,
    observationHash: receipt.postObservationHash,
    latentContextHash: nextLatentContextHash,
  })) throw new Error('receipt post belief key is invalid');
  if (receipt.episodeId !== `episode_${hashArcValue({
    principalScope: receipt.principalScope,
    opaqueGameScope: receipt.opaqueGameScope,
    runId: receipt.runId,
    sequence: receipt.sequence,
    preBeliefKey: receipt.preBeliefKey,
    postBeliefKey: receipt.postBeliefKey,
  }).slice(0, 32)}`) throw new Error('receipt episode ID does not match its transition identity');
  const beforeFrame = prior?.frames.at(-1);
  if (beforeFrame !== undefined &&
      hashArcValue(exactCellDelta(beforeFrame, receipt.frames.at(-1)!)) !==
        hashArcValue(receipt.exactDelta)) {
    throw new Error('receipt exactDelta does not match its adjacent exact frames');
  }
  const computedPredictionError = expectedPredictionError(receipt, beforeFrame);
  if (computedPredictionError !== undefined && computedPredictionError !== receipt.predictionError) {
    throw new Error('receipt predictionError does not match its exact evidence');
  }
  if (prior && receipt.createdAtMs < prior.createdAtMs) {
    throw new Error('receipt timestamp moves backwards');
  }
  state.count += 1;
  state.previousReceiptHash = receiptHash;
  state.prior = receipt;
  state.latentContextHash = nextLatentContextHash;
  state.idempotencyKeys.add(receipt.idempotencyKey);
  state.receiptHashes.add(receiptHash);
  state.node = { receipt, previous: state.node };
  state.reusable = state.reusable && APPEND_OWNED_RECEIPTS.has(receipt);
}

export type TransitionReceiptDraft = Omit<
  TransitionReceipt,
  'schema' | 'previousReceiptHash' | 'receiptHash'
>;

function validatedPrefixState(receipts: readonly TransitionReceipt[]): ReceiptChainState {
  const count = receiptCollectionCount(receipts);
  if (count === 0) return initialChainState();
  const pending = PENDING_APPEND_CACHE.get(receipts as object);
  if (pending && chainObjectsMatch(receipts, pending)) return cloneChainState(pending);
  const cached = VERIFIED_CHAIN_CACHE.get(receipts as object);
  if (cached && chainObjectsMatch(receipts, cached)) return cloneChainState(cached);
  const verification = verifyTransitionReceipts(receipts);
  if (!verification.ok) throw new Error(`existing receipt chain is invalid: ${verification.reason}`);
  const verified = VERIFIED_CHAIN_CACHE.get(receipts as object);
  if (!verified) throw new Error('existing receipt chain validation state is unavailable');
  return cloneChainState(verified);
}

export function appendTransitionReceipt(
  receipts: readonly TransitionReceipt[],
  draft: TransitionReceiptDraft,
): TransitionReceipt {
  const prefix = validatedPrefixState(receipts);
  let stableDraft: TransitionReceiptDraft;
  try {
    stableDraft = snapshotArcJson(draft) as unknown as TransitionReceiptDraft;
  } catch {
    throw new Error('transition receipt draft must be strict acyclic JSON');
  }
  assertPlainDraft(stableDraft);
  const body = {
    schema: 'metaharness.arc_agi_3.transition.v1' as const,
    ...stableDraft,
    previousReceiptHash: prefix.previousReceiptHash,
  };
  const receipt = Object.freeze({ ...body, receiptHash: hashArcValue(body) });
  const next = cloneChainState(prefix);
  validateReceiptContinuation(receipt, next);
  APPEND_OWNED_RECEIPTS.add(receipt);
  next.reusable = prefix.reusable;
  if (next.reusable) PENDING_APPEND_CACHE.set(receipts as object, next);
  return receipt;
}

export function verifyTransitionReceipts(
  receipts: readonly TransitionReceipt[],
): ReceiptVerification {
  let count = 0;
  let collectionIsInvalid = false;
  try {
    if (Array.isArray(receipts)) count = receipts.length;
    const keys = Reflect.ownKeys(receipts);
    collectionIsInvalid = !Array.isArray(receipts) ||
      Object.getPrototypeOf(receipts) !== Array.prototype ||
      keys.some(key => typeof key !== 'string' ||
        (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) ||
        (key !== 'length' && (
          !Object.getOwnPropertyDescriptor(receipts, key)?.enumerable ||
          !('value' in Object.getOwnPropertyDescriptor(receipts, key)!)
        ))) ||
      Object.keys(receipts).length !== count || count > MAX_ARC_RUN_ACTIONS;
  } catch {
    collectionIsInvalid = true;
  }
  if (collectionIsInvalid) {
    return {
      ok: false,
      count,
      brokenAt: 0,
      reason: 'receipt collection is not a bounded dense array',
    };
  }
  const state = initialChainState();

  for (let index = 0; index < count; index++) {
    try {
      validateReceiptContinuation(receipts[index]!, state);
    } catch (error) {
      return {
        ok: false,
        count,
        brokenAt: index,
        reason: error instanceof Error ? error.message : 'receipt validation failed',
      };
    }
  }

  VERIFIED_CHAIN_CACHE.set(receipts as object, state);

  return {
    ok: true,
    count,
    headHash: state.previousReceiptHash,
  };
}

/**
 * Reconcile chain integrity against independently obtained official counts.
 * This is the completeness check; a valid hash-chain prefix alone is not.
 */
export function reconcileTransitionReceipts(
  receipts: readonly TransitionReceipt[],
  official: OfficialReceiptCounts,
  uncertainMutationCount = 0,
): ReceiptReconciliation {
  if (!Number.isSafeInteger(official.actionCount) || official.actionCount < 0 ||
      !Number.isSafeInteger(official.resetCount) || official.resetCount < 0 ||
      official.actionCount + official.resetCount > MAX_ARC_RUN_ACTIONS ||
      !HEX_HASH.test(official.expectedReceiptHeadHash) ||
      !Number.isSafeInteger(uncertainMutationCount) || uncertainMutationCount < 0) {
    throw new Error('official reconciliation counts or expected head hash are invalid');
  }
  const chain = verifyTransitionReceipts(receipts);
  const recordedResetCount = receipts.filter(receipt => receipt.action.name === 'RESET').length;
  const recordedActionCount = receipts.length - recordedResetCount;
  const recordedTransitionCount = receipts.length;
  const officialTransitionCount = official.actionCount + official.resetCount;
  const actualHead = chain.ok
    ? chain.headHash
    : receipts.at(-1)?.receiptHash ?? TRANSITION_RECEIPT_GENESIS;
  const headMatches = actualHead === official.expectedReceiptHeadHash;
  const countsMatch = recordedActionCount === official.actionCount &&
    recordedResetCount === official.resetCount &&
    recordedTransitionCount === officialTransitionCount;
  const ok = chain.ok && countsMatch && headMatches && uncertainMutationCount === 0;
  return Object.freeze({
    ok,
    chain,
    recordedActionCount,
    recordedResetCount,
    recordedTransitionCount,
    officialActionCount: official.actionCount,
    officialResetCount: official.resetCount,
    officialTransitionCount,
    headMatches,
    uncertainMutationCount,
    reason: ok
      ? undefined
      : !chain.ok
        ? 'receipt chain integrity failed'
        : !countsMatch
          ? 'official action or reset counts differ'
          : !headMatches
            ? 'official expected receipt head differs'
            : 'one or more dispatched environment mutations are uncertain',
  });
}
