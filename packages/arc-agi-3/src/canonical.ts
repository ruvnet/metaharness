import { canonical, hash } from '@metaharness/harness';
import type {
  ActionExpectation,
  ArcAction,
  ArcActionName,
  ArcRunBudget,
  ExactArcObservation,
  ExactCellDelta,
  ExactGridFrame,
  GameState,
  JsonValue,
  RawArcObservation,
  RawGridFrame,
} from './types.js';

const ACTIONS: ReadonlySet<string> = new Set([
  'RESET',
  'ACTION1',
  'ACTION2',
  'ACTION3',
  'ACTION4',
  'ACTION5',
  'ACTION6',
  'ACTION7',
]);

const STATES: ReadonlySet<string> = new Set([
  'NOT_PLAYED',
  'NOT_FINISHED',
  'WIN',
  'GAME_OVER',
]);

const EXACT_FRAME_KEYS: ReadonlySet<string> = new Set([
  'frameIndex',
  'width',
  'height',
  'encoding',
  'rows',
  'frameHash',
  'frameRef',
  'metadata',
]);

const EXACT_OBSERVATION_KEYS: ReadonlySet<string> = new Set([
  'opaqueGameScope',
  'state',
  'levelsCompleted',
  'winLevels',
  'availableActions',
  'frames',
  'currentFrame',
  'observationHash',
  'metadata',
]);

const EXPECTATION_KEYS: ReadonlySet<string> = new Set([
  'confidence',
  'hypothesisIds',
  'expectedObservationHash',
  'expectedState',
  'expectedLevelsCompleted',
  'expectedFrameHash',
  'expectedChanges',
  'rationale',
]);

const EXPECTED_CHANGE_KEYS: ReadonlySet<string> = new Set([
  'x',
  'y',
  'before',
  'after',
]);

const HEX_HASH = /^[0-9a-f]{64}$/;
const GAME_SCOPE = /^game_[0-9a-f]{24}$/;

export const MAX_ARC_ANIMATION_FRAMES = 256;
export const MAX_ARC_OBSERVATION_CELLS = 1_048_576;
export const MAX_ARC_RUN_ACTIONS = 10_000;
export const MAX_ARC_RUN_WALL_TIME_MS = 30 * 24 * 60 * 60 * 1_000;

const PUBLIC_METADATA_KEYS: ReadonlySet<string> = new Set([
  'guid',
  'fullreset',
  'actioninput',
  'progress',
]);

const PRIVATE_METADATA_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'gameid',
  'gamename',
  'gametitle',
  'gameversion',
  'title',
  'version',
]);

/** Public domain objects legitimately use generic `version` fields. */
const PUBLIC_IDENTITY_KEYS: ReadonlySet<string> = new Set([
  'gameid',
  'gamename',
  'gametitle',
  'gameversion',
  'title',
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export class ArcValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ArcValidationError';
    this.code = code;
  }
}

function assertPlainDataRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ArcValidationError('INVALID_SCHEMA', `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !allowedKeys.has(key))) {
    throw new ArcValidationError('INVALID_SCHEMA', `${label} contains an unexpected field`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new ArcValidationError('INVALID_SCHEMA', `${label} contains a non-data field`);
    }
  }
}

function assertDenseArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) ||
      Object.keys(value).length !== value.length) {
    throw new ArcValidationError('INVALID_SCHEMA', `${label} must be a dense plain array`);
  }
}

function assertPublicMetadata(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !PUBLIC_METADATA_KEYS.has(normalizedKey(key)))) {
    throw new ArcValidationError('INVALID_METADATA', `${label} is not allowlisted public metadata`);
  }
  snapshotArcJson(value);
  if (containsRawGameIdentityKey(value)) {
    throw new ArcValidationError('GAME_IDENTITY_LEAK', `${label} contains raw game identity`);
  }
}

export function canonicalArcJson(value: unknown): string {
  return canonical(value);
}

export function hashArcValue(value: unknown): string {
  return hash(value);
}

/** Strictly clone and freeze an adapter value before it enters a hash boundary. */
export function snapshotArcJson(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  const counter = { count: 0 };
  const clone = (candidate: unknown, depth: number): JsonValue => {
    counter.count += 1;
    if (depth > 64 || counter.count > 1_000_000) {
      throw new TypeError('JSON value exceeds depth or size limits');
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('JSON value contains a non-finite number');
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) {
      throw new TypeError('value is not acyclic JSON');
    }
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const keys = Reflect.ownKeys(candidate);
        if (keys.some(key => typeof key !== 'string' ||
          (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))) ||
            Object.keys(candidate).length !== candidate.length) {
          throw new TypeError('JSON array is sparse or extended');
        }
        const output: JsonValue[] = [];
        for (let index = 0; index < candidate.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor?.enumerable || !('value' in descriptor)) {
            throw new TypeError('JSON array contains a non-data item');
          }
          output.push(clone(descriptor.value, depth + 1));
        }
        return Object.freeze(output) as unknown as JsonValue;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('JSON value contains a non-plain object');
      }
      const output: Record<string, JsonValue> = {};
      for (const key of Reflect.ownKeys(candidate)) {
        if (typeof key !== 'string') throw new TypeError('JSON value contains a symbol key');
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new TypeError('JSON object contains a non-data property');
        }
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return Object.freeze(output) as unknown as JsonValue;
    } finally {
      seen.delete(candidate);
    }
  };
  return clone(value, 0);
}

/** Strict normalized run budget used by controllers and checkpoint trust boundaries. */
export function validateArcRunBudget(value: unknown): ArcRunBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArcValidationError('INVALID_BUDGET', 'run budget must be an object');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys.some(key =>
    typeof key !== 'string' || (key !== 'maxActions' && key !== 'maxWallTimeMs'))) {
    throw new ArcValidationError(
      'INVALID_BUDGET',
      'run budget must contain exactly maxActions and maxWallTimeMs',
    );
  }
  const record = value as Record<string, unknown>;
  const maxActions = record.maxActions;
  const maxWallTimeMs = record.maxWallTimeMs;
  if (!Number.isSafeInteger(maxActions) || (maxActions as number) < 1 ||
      (maxActions as number) > MAX_ARC_RUN_ACTIONS) {
    throw new ArcValidationError(
      'INVALID_BUDGET',
      `maxActions must be a safe integer in 1..${MAX_ARC_RUN_ACTIONS}`,
    );
  }
  if (!Number.isSafeInteger(maxWallTimeMs) || (maxWallTimeMs as number) < 1_000 ||
      (maxWallTimeMs as number) > MAX_ARC_RUN_WALL_TIME_MS) {
    throw new ArcValidationError(
      'INVALID_BUDGET',
      'maxWallTimeMs must be a safe integer from 1000ms through 30 days',
    );
  }
  return Object.freeze({
    maxActions: maxActions as number,
    maxWallTimeMs: maxWallTimeMs as number,
  });
}

export function principalScopeFor(principalId: string): string {
  const normalized = principalId.trim();
  if (!normalized) {
    throw new ArcValidationError('INVALID_PRINCIPAL', 'principalId must be non-empty');
  }
  return `principal_${hashArcValue({ principalId: normalized }).slice(0, 24)}`;
}

export function deriveGameIdentityHash(
  metadata: Readonly<Record<string, unknown>> | undefined,
  explicitHash?: string,
): string {
  if (explicitHash !== undefined) {
    const value = explicitHash.trim();
    if (!value) {
      throw new ArcValidationError(
        'INVALID_GAME_VERSION_HASH',
        'gameVersionHash must be non-empty when provided',
      );
    }
    return hashArcValue({ explicitHash: value });
  }
  const identity: Record<string, unknown> = {};
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      if (PRIVATE_METADATA_IDENTITY_KEYS.has(normalizedKey(key))) identity[key] = value;
    }
  }
  return hashArcValue({ identity });
}

export function opaqueGameScopeFor(
  principalScope: string,
  runId: string,
  internalGameIdentityHash: string,
): string {
  return `game_${hashArcValue({ principalScope, runId, internalGameIdentityHash }).slice(0, 24)}`;
}

function toSafeJson(
  value: unknown,
  seen: WeakSet<object>,
): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out: JsonValue[] = [];
    for (const item of value) {
      const safe = toSafeJson(item, seen);
      if (safe !== undefined) out.push(safe);
    }
    seen.delete(value);
    return Object.freeze(out) as unknown as JsonValue;
  }
  if (value && typeof value === 'object') {
    if (seen.has(value)) return undefined;
    seen.add(value);
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (PRIVATE_METADATA_IDENTITY_KEYS.has(normalizedKey(key))) continue;
      const safe = toSafeJson(item, seen);
      if (safe !== undefined) out[key] = safe;
    }
    seen.delete(value);
    return Object.freeze(out) as unknown as JsonValue;
  }
  return undefined;
}

/** Allowlist public metadata and recursively strip raw game identity fields. */
export function sanitizePublicMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!metadata) return undefined;
  const out: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!PUBLIC_METADATA_KEYS.has(normalizedKey(key))) continue;
    const safe = toSafeJson(value, new WeakSet());
    if (safe !== undefined) out[key] = safe;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : undefined;
}

export function containsRawGameIdentityKey(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pending: object[] = [value];
  const seen = new WeakSet<object>();
  let visited = 0;
  while (pending.length > 0) {
    const candidate = pending.pop()!;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    visited += 1;
    if (visited > 1_000_000) return true;
    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(candidate);
    } catch {
      return true;
    }
    for (const key of keys) {
      if (typeof key !== 'string') continue;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      } catch {
        return true;
      }
      if (!descriptor?.enumerable) continue;
      if (!('value' in descriptor)) return true;
      if (PUBLIC_IDENTITY_KEYS.has(normalizedKey(key))) return true;
      if (descriptor.value && typeof descriptor.value === 'object') {
        pending.push(descriptor.value as object);
      }
    }
  }
  return false;
}

export function encodeGridRows(cells: readonly (readonly number[])[]): readonly string[] {
  return Object.freeze(
    cells.map(row => row.map(cell => cell.toString(16)).join('')),
  );
}

export function decodeGridRows(rows: readonly string[]): readonly (readonly number[])[] {
  if (rows.length === 0) {
    throw new ArcValidationError('EMPTY_GRID', 'grid rows must be non-empty');
  }
  const width = rows[0]!.length;
  if (width === 0) {
    throw new ArcValidationError('EMPTY_GRID', 'grid width must be positive');
  }
  return Object.freeze(rows.map((row, y) => {
    if (row.length !== width || !/^[0-9a-f]+$/.test(row)) {
      throw new ArcValidationError(
        'INVALID_GRID_ENCODING',
        `row ${y} is not a ${width}-cell lowercase hexadecimal row`,
      );
    }
    return Object.freeze([...row].map(cell => Number.parseInt(cell, 16)));
  }));
}

function validateFrame(frame: RawGridFrame, ordinal: number): void {
  if (!Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > 64) {
    throw new ArcValidationError('INVALID_GRID_WIDTH', `frame ${ordinal} width must be 1..64`);
  }
  if (!Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 64) {
    throw new ArcValidationError('INVALID_GRID_HEIGHT', `frame ${ordinal} height must be 1..64`);
  }
  if (frame.cells.length !== frame.height) {
    throw new ArcValidationError(
      'INVALID_GRID_HEIGHT',
      `frame ${ordinal} declared height ${frame.height} but has ${frame.cells.length} rows`,
    );
  }
  for (let y = 0; y < frame.cells.length; y++) {
    const row = frame.cells[y]!;
    if (row.length !== frame.width) {
      throw new ArcValidationError(
        'INVALID_GRID_WIDTH',
        `frame ${ordinal} row ${y} declared width ${frame.width} but has ${row.length} cells`,
      );
    }
    for (let x = 0; x < row.length; x++) {
      const cell = row[x]!;
      if (!Number.isSafeInteger(cell) || cell < 0 || cell > 15) {
        throw new ArcValidationError(
          'INVALID_CELL',
          `frame ${ordinal} cell (${x},${y}) must be an integer in 0..15`,
        );
      }
    }
  }
  if (frame.frameIndex !== undefined &&
      (!Number.isSafeInteger(frame.frameIndex) || frame.frameIndex < 0)) {
    throw new ArcValidationError(
      'INVALID_FRAME_INDEX',
      `frame ${ordinal} frameIndex must be a non-negative integer`,
    );
  }
}

export function exactFrameFromRaw(frame: RawGridFrame, ordinal: number): ExactGridFrame {
  validateFrame(frame, ordinal);
  const frameIndex = frame.frameIndex ?? ordinal;
  const rows = encodeGridRows(frame.cells);
  const frameHash = hashArcValue({
    encoding: 'hex_rows_v1',
    width: frame.width,
    height: frame.height,
    rows,
  });
  const metadata = sanitizePublicMetadata(frame.metadata);
  return Object.freeze({
    frameIndex,
    width: frame.width,
    height: frame.height,
    encoding: 'hex_rows_v1' as const,
    rows,
    frameHash,
    frameRef: `frame_${frameHash.slice(0, 32)}_${frameIndex}`,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

/** Validate an exact frame at a persisted or externally supplied trust boundary. */
export function validateExactGridFrame(
  frame: unknown,
  label = 'exact frame',
): asserts frame is ExactGridFrame {
  assertPlainDataRecord(frame, EXACT_FRAME_KEYS, label);
  const candidate = frame as unknown as ExactGridFrame;
  if (!Number.isSafeInteger(candidate.frameIndex) || candidate.frameIndex < 0) {
    throw new ArcValidationError(
      'INVALID_FRAME_INDEX',
      `${label} frameIndex must be a non-negative safe integer`,
    );
  }
  if (!Number.isSafeInteger(candidate.width) || candidate.width < 1 || candidate.width > 64 ||
      !Number.isSafeInteger(candidate.height) || candidate.height < 1 || candidate.height > 64) {
    throw new ArcValidationError('INVALID_GRID_SIZE', `${label} dimensions must be in 1..64`);
  }
  if (candidate.encoding !== 'hex_rows_v1') {
    throw new ArcValidationError('INVALID_GRID_ENCODING', `${label} encoding is invalid`);
  }
  assertDenseArray(candidate.rows, `${label} rows`);
  if (candidate.rows.length !== candidate.height || candidate.rows.some(row =>
    typeof row !== 'string' || row.length !== candidate.width || !/^[0-9a-f]+$/.test(row))) {
    throw new ArcValidationError(
      'INVALID_GRID_ENCODING',
      `${label} rows do not match its declared dimensions`,
    );
  }
  const computedHash = hashArcValue({
    encoding: candidate.encoding,
    width: candidate.width,
    height: candidate.height,
    rows: candidate.rows,
  });
  if (candidate.frameHash !== computedHash ||
      candidate.frameRef !== `frame_${computedHash.slice(0, 32)}_${candidate.frameIndex}`) {
    throw new ArcValidationError(
      'INVALID_FRAME_HASH',
      `${label} hash or reference does not match its exact rows`,
    );
  }
  assertPublicMetadata(candidate.metadata, `${label} metadata`);
}

function assertRawObservation(raw: RawArcObservation): void {
  if (!STATES.has(raw.state)) {
    throw new ArcValidationError('INVALID_STATE', `unknown game state: ${String(raw.state)}`);
  }
  if (!Number.isSafeInteger(raw.levelsCompleted) || raw.levelsCompleted < 0) {
    throw new ArcValidationError(
      'INVALID_PROGRESS',
      'levelsCompleted must be a non-negative integer',
    );
  }
  if (!Number.isSafeInteger(raw.winLevels) || raw.winLevels < 0) {
    throw new ArcValidationError('INVALID_PROGRESS', 'winLevels must be a non-negative integer');
  }
  if (raw.frames.length === 0) {
    throw new ArcValidationError('EMPTY_FRAMES', 'an observation must contain at least one frame');
  }
  if (raw.frames.length > MAX_ARC_ANIMATION_FRAMES) {
    throw new ArcValidationError(
      'TOO_MANY_FRAMES',
      `an observation may contain at most ${MAX_ARC_ANIMATION_FRAMES} animation frames`,
    );
  }
  const totalCells = raw.frames.reduce(
    (sum, frame) => sum + Number(frame.width) * Number(frame.height),
    0,
  );
  if (!Number.isFinite(totalCells) || totalCells > MAX_ARC_OBSERVATION_CELLS) {
    throw new ArcValidationError(
      'OBSERVATION_TOO_LARGE',
      `an observation may contain at most ${MAX_ARC_OBSERVATION_CELLS} cells across frames`,
    );
  }
  const seen = new Set<string>();
  for (const action of raw.availableActions) {
    if (!ACTIONS.has(action)) {
      throw new ArcValidationError('INVALID_ACTION', `unknown available action: ${String(action)}`);
    }
    if (seen.has(action)) {
      throw new ArcValidationError('DUPLICATE_ACTION', `available action ${action} is duplicated`);
    }
    seen.add(action);
  }
}

export function exactObservationFromRaw(
  raw: RawArcObservation,
  opaqueGameScope: string,
): ExactArcObservation {
  assertRawObservation(raw);
  if (!opaqueGameScope.trim()) {
    throw new ArcValidationError('INVALID_GAME_SCOPE', 'opaqueGameScope must be non-empty');
  }
  const frames = Object.freeze(raw.frames.map(exactFrameFromRaw));
  const currentFrame = frames[frames.length - 1]!;
  // Sort the (validated, unique) action names before hashing/storing so a benign
  // reorder from the environment adapter yields the same observationHash instead
  // of faulting the run (UNLEDGERED_ENVIRONMENT_CHANGE / STALE_OBSERVATION).
  const availableActions = Object.freeze([...raw.availableActions].sort());
  const observationHash = hashArcValue({
    opaqueGameScope,
    state: raw.state,
    levelsCompleted: raw.levelsCompleted,
    winLevels: raw.winLevels,
    availableActions,
    currentFrameHash: currentFrame.frameHash,
  });
  const metadata = sanitizePublicMetadata(raw.metadata);
  const exact: ExactArcObservation = Object.freeze({
    opaqueGameScope,
    state: raw.state,
    levelsCompleted: raw.levelsCompleted,
    winLevels: raw.winLevels,
    availableActions,
    frames,
    currentFrame,
    observationHash,
    ...(metadata === undefined ? {} : { metadata }),
  });
  if (containsRawGameIdentityKey(exact)) {
    throw new ArcValidationError(
      'GAME_IDENTITY_LEAK',
      'sanitized observation still contains a raw game identity field',
    );
  }
  return exact;
}

/** Validate a full exact observation, including every frame and its observation commitment. */
export function validateExactArcObservation(
  observation: unknown,
  label = 'exact observation',
): asserts observation is ExactArcObservation {
  assertPlainDataRecord(observation, EXACT_OBSERVATION_KEYS, label);
  const candidate = observation as unknown as ExactArcObservation;
  if (typeof candidate.opaqueGameScope !== 'string' || !GAME_SCOPE.test(candidate.opaqueGameScope)) {
    throw new ArcValidationError('INVALID_GAME_SCOPE', `${label} opaque game scope is invalid`);
  }
  if (!STATES.has(candidate.state)) {
    throw new ArcValidationError('INVALID_STATE', `${label} state is invalid`);
  }
  if (!Number.isSafeInteger(candidate.levelsCompleted) || candidate.levelsCompleted < 0 ||
      !Number.isSafeInteger(candidate.winLevels) || candidate.winLevels < 0) {
    throw new ArcValidationError('INVALID_PROGRESS', `${label} progress is invalid`);
  }
  assertDenseArray(candidate.availableActions, `${label} availableActions`);
  if (candidate.availableActions.length > ACTIONS.size || candidate.availableActions.some(action =>
    typeof action !== 'string' || !ACTIONS.has(action)) ||
      new Set(candidate.availableActions).size !== candidate.availableActions.length) {
    throw new ArcValidationError('INVALID_ACTION', `${label} availableActions are invalid`);
  }
  assertDenseArray(candidate.frames, `${label} frames`);
  if (candidate.frames.length < 1 || candidate.frames.length > MAX_ARC_ANIMATION_FRAMES) {
    throw new ArcValidationError(
      'INVALID_FRAME_COUNT',
      `${label} must contain 1..${MAX_ARC_ANIMATION_FRAMES} frames`,
    );
  }
  let totalCells = 0;
  for (let index = 0; index < candidate.frames.length; index += 1) {
    const frame = candidate.frames[index];
    validateExactGridFrame(frame, `${label} frame ${index}`);
    totalCells += frame.width * frame.height;
    if (totalCells > MAX_ARC_OBSERVATION_CELLS) {
      throw new ArcValidationError(
        'OBSERVATION_TOO_LARGE',
        `${label} exceeds ${MAX_ARC_OBSERVATION_CELLS} cells`,
      );
    }
  }
  validateExactGridFrame(candidate.currentFrame, `${label} currentFrame`);
  const lastFrame = candidate.frames.at(-1)!;
  if (hashArcValue(candidate.currentFrame) !== hashArcValue(lastFrame)) {
    throw new ArcValidationError(
      'INVALID_CURRENT_FRAME',
      `${label} currentFrame is not its final animation frame`,
    );
  }
  if (!HEX_HASH.test(candidate.observationHash) || candidate.observationHash !== hashArcValue({
    opaqueGameScope: candidate.opaqueGameScope,
    state: candidate.state,
    levelsCompleted: candidate.levelsCompleted,
    winLevels: candidate.winLevels,
    availableActions: candidate.availableActions,
    currentFrameHash: candidate.currentFrame.frameHash,
  })) {
    throw new ArcValidationError(
      'INVALID_OBSERVATION_HASH',
      `${label} observationHash does not match its exact state`,
    );
  }
  assertPublicMetadata(candidate.metadata, `${label} metadata`);
  if (containsRawGameIdentityKey(candidate)) {
    throw new ArcValidationError('GAME_IDENTITY_LEAK', `${label} contains raw game identity`);
  }
}

export function validateArcAction(action: ArcAction): void {
  if (!action || typeof action !== 'object' || Array.isArray(action) ||
      Object.getPrototypeOf(action) !== Object.prototype || !ACTIONS.has((action as ArcAction).name)) {
    throw new ArcValidationError('INVALID_ACTION', 'action name is not in the ARC allowlist');
  }
  const ownKeys = Reflect.ownKeys(action);
  if (ownKeys.some(key => typeof key !== 'string' ||
    !Object.getOwnPropertyDescriptor(action, key)?.enumerable ||
    !('value' in Object.getOwnPropertyDescriptor(action, key)!))) {
    throw new ArcValidationError('UNEXPECTED_ACTION_FIELD', 'action fields must be plain data');
  }
  if (action.name === 'ACTION6') {
    const keys = ownKeys.sort();
    if (keys.length !== 3 || keys[0] !== 'name' || keys[1] !== 'x' || keys[2] !== 'y') {
      throw new ArcValidationError(
        'UNEXPECTED_ACTION_FIELD',
        'ACTION6 accepts exactly name, x, and y',
      );
    }
    if (!Number.isInteger(action.x) || action.x < 0 || action.x > 63 ||
        !Number.isInteger(action.y) || action.y < 0 || action.y > 63) {
      throw new ArcValidationError(
        'INVALID_COORDINATES',
        'ACTION6 x and y must be integers in 0..63',
      );
    }
  } else if (Object.keys(action).length !== 1 || Object.keys(action)[0] !== 'name') {
    throw new ArcValidationError(
      'UNEXPECTED_ACTION_FIELD',
      `${action.name} accepts exactly the name field`,
    );
  }
}

export function validateExpectation(expectation: ActionExpectation): void {
  assertPlainDataRecord(expectation, EXPECTATION_KEYS, 'expectation');
  if (Object.entries(expectation).some(([key, value]) =>
    key !== 'confidence' && value === undefined)) {
    throw new ArcValidationError(
      'INVALID_EXPECTATION',
      'optional expectation fields must be omitted instead of undefined',
    );
  }
  if (!Number.isFinite(expectation.confidence) ||
      expectation.confidence < 0 || expectation.confidence > 1) {
    throw new ArcValidationError('INVALID_EXPECTATION', 'confidence must be in 0..1');
  }
  if (expectation.rationale !== undefined && (
    typeof expectation.rationale !== 'string' || expectation.rationale.length > 2_048 ||
    /[\u0000-\u001f]/.test(expectation.rationale)
  )) {
    throw new ArcValidationError('INVALID_EXPECTATION', 'rationale exceeds 2048 characters');
  }
  if (expectation.hypothesisIds !== undefined) {
    assertDenseArray(expectation.hypothesisIds, 'expectation hypothesisIds');
  }
  if ((expectation.hypothesisIds?.length ?? 0) > 64 ||
      (expectation.hypothesisIds ?? []).some(id =>
        typeof id !== 'string' || !id.trim() || id.length > 256 || /[\u0000-\u001f]/.test(id)) ||
      new Set(expectation.hypothesisIds ?? []).size !== (expectation.hypothesisIds?.length ?? 0)) {
    throw new ArcValidationError(
      'INVALID_EXPECTATION',
      'hypothesisIds must contain at most 64 unique bounded IDs',
    );
  }
  for (const [field, value] of [
    ['expectedObservationHash', expectation.expectedObservationHash],
    ['expectedFrameHash', expectation.expectedFrameHash],
  ] as const) {
    if (value !== undefined && (typeof value !== 'string' || !HEX_HASH.test(value))) {
      throw new ArcValidationError('INVALID_EXPECTATION', `${field} must be a lowercase hash`);
    }
  }
  if (expectation.expectedChanges !== undefined) {
    assertDenseArray(expectation.expectedChanges, 'expectation expectedChanges');
  }
  if ((expectation.expectedChanges?.length ?? 0) > 512) {
    throw new ArcValidationError(
      'INVALID_EXPECTATION',
      'expectedChanges may contain at most 512 entries',
    );
  }
  const hasPrediction =
    expectation.expectedObservationHash !== undefined ||
    expectation.expectedState !== undefined ||
    expectation.expectedLevelsCompleted !== undefined ||
    expectation.expectedFrameHash !== undefined ||
    (expectation.expectedChanges ?? []).some(change => (
      change.before !== undefined || change.after !== undefined
    ));
  if (!hasPrediction) {
    throw new ArcValidationError(
      'UNFALSIFIABLE_EXPECTATION',
      'expectation must contain at least one falsifiable prediction',
    );
  }
  if (expectation.expectedState !== undefined && !STATES.has(expectation.expectedState)) {
    throw new ArcValidationError('INVALID_EXPECTATION', 'expectedState is invalid');
  }
  if (expectation.expectedLevelsCompleted !== undefined &&
      (!Number.isSafeInteger(expectation.expectedLevelsCompleted) ||
        expectation.expectedLevelsCompleted < 0)) {
    throw new ArcValidationError(
      'INVALID_EXPECTATION',
      'expectedLevelsCompleted must be a non-negative integer',
    );
  }
  for (const change of expectation.expectedChanges ?? []) {
    assertPlainDataRecord(change, EXPECTED_CHANGE_KEYS, 'expected change');
    if (Object.entries(change).some(([, value]) => value === undefined)) {
      throw new ArcValidationError(
        'INVALID_EXPECTATION',
        'expected change fields must not be undefined',
      );
    }
    if (change.before === undefined && change.after === undefined) {
      throw new ArcValidationError(
        'INVALID_EXPECTATION',
        'each expected change must specify before or after',
      );
    }
    if (!Number.isInteger(change.x) || change.x < 0 || change.x > 63 ||
        !Number.isInteger(change.y) || change.y < 0 || change.y > 63) {
      throw new ArcValidationError(
        'INVALID_EXPECTATION',
        'expected change coordinates must be integers in 0..63',
      );
    }
    for (const cell of [change.before, change.after]) {
      if (cell !== undefined && (!Number.isInteger(cell) || cell < 0 || cell > 15)) {
        throw new ArcValidationError(
          'INVALID_EXPECTATION',
          'expected cell values must be integers in 0..15',
        );
      }
    }
  }
}

export function exactCellDelta(
  before: ExactGridFrame,
  after: ExactGridFrame,
): readonly ExactCellDelta[] {
  const beforeCells = decodeGridRows(before.rows);
  const afterCells = decodeGridRows(after.rows);
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const delta: ExactCellDelta[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const prior = beforeCells[y]?.[x] ?? -1;
      const next = afterCells[y]?.[x] ?? -1;
      if (prior !== next) delta.push(Object.freeze({ x, y, before: prior, after: next }));
    }
  }
  return Object.freeze(delta);
}

function actualCellAt(frame: ExactGridFrame, x: number, y: number): number | undefined {
  if (y < 0 || y >= frame.rows.length || x < 0 || x >= frame.width) return undefined;
  return Number.parseInt(frame.rows[y]![x]!, 16);
}

export function predictionError(
  expectation: ActionExpectation,
  before: ExactArcObservation,
  after: ExactArcObservation,
): number {
  const results: boolean[] = [];
  if (expectation.expectedObservationHash !== undefined) {
    results.push(expectation.expectedObservationHash === after.observationHash);
  }
  if (expectation.expectedState !== undefined) {
    results.push(expectation.expectedState === after.state);
  }
  if (expectation.expectedLevelsCompleted !== undefined) {
    results.push(expectation.expectedLevelsCompleted === after.levelsCompleted);
  }
  if (expectation.expectedFrameHash !== undefined) {
    results.push(expectation.expectedFrameHash === after.currentFrame.frameHash);
  }
  for (const change of expectation.expectedChanges ?? []) {
    if (change.before !== undefined) {
      results.push(actualCellAt(before.currentFrame, change.x, change.y) === change.before);
    }
    if (change.after !== undefined) {
      results.push(actualCellAt(after.currentFrame, change.x, change.y) === change.after);
    }
  }
  if (results.length === 0) return 1;
  const mismatches = results.reduce((count, matched) => count + (matched ? 0 : 1), 0);
  return mismatches / results.length;
}

export function validActionNames(): readonly ArcActionName[] {
  return Object.freeze([...ACTIONS] as ArcActionName[]);
}

export function validGameStates(): readonly GameState[] {
  return Object.freeze([...STATES] as GameState[]);
}
