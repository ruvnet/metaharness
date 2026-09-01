// SPDX-License-Identifier: MIT

import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse, resolve, join } from 'node:path';
import { SessionLog } from '@metaharness/kernel';
import {
  PythonArcBridge,
  TRANSITION_RECEIPT_GENESIS,
  createArcController,
  hashArcValue,
  normalizeArcRunBudget,
  normalizeArcRunManifest,
  snapshotArcJson,
} from '@metaharness/arc-agi-3';
import type {
  ArcController,
  ArcEnvironment,
  ArcRunBudget,
  ArcRunManifest,
  ArcSessionLog,
  ArcScorecard,
  PythonArcBridgeOptions,
  ReceiptReconciliation,
  ReceiptVerification,
  ScorecardOptions,
  StartedArcEnvironment,
  StartGameOptions,
} from '@metaharness/arc-agi-3';
import type {
  ArcControllerFactory,
  ArcControllerFactoryContext,
} from './types.js';

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SCORECARD_CONFIG_BYTES = 64 * 1024;
const MAX_EVIDENCE_LOG_BYTES = 256 * 1024 * 1024;
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

/** Private operator input. Never pass this object through an MCP result. */
export interface OfficialArcAssignment {
  readonly gameId: string;
  readonly seed?: number;
  /** Optional private hash of the exact game/version assignment. */
  readonly gameVersionHash?: string;
}

/** Minimal official-bridge surface, kept injectable for deterministic tests. */
export interface OfficialArcBridge {
  createScorecard(options?: ScorecardOptions): Promise<string>;
  startGame(options: StartGameOptions): Promise<StartedArcEnvironment>;
  getScorecard(scorecardId?: string): Promise<ArcScorecard | null>;
  closeScorecard(scorecardId?: string): Promise<ArcScorecard | null>;
  dispose(): Promise<void>;
}

export interface OfficialArcControllerFactoryOptions {
  /** Frozen private queue. One assignment is active at a time. */
  readonly assignments: readonly OfficialArcAssignment[];
  readonly runManifest: ArcRunManifest;
  readonly budget?: Partial<ArcRunBudget>;
  /** Frozen before any scorecard or environment work begins. Defaults to the public set gate. */
  readonly acceptanceGate?: OfficialArcRunGate;
  readonly scorecard?: ScorecardOptions;
  /** Durable directory for action intent/outcome journals, outside prompt state. */
  readonly evidenceRoot: string;
  /** External append-only or WORM anchor. Required for accepted final evidence. */
  readonly evidenceAnchor?: OfficialEvidenceAnchor;
  /** Supplying a bridge transfers its lifecycle to the returned factory. */
  readonly bridge?: OfficialArcBridge;
  readonly bridgeOptions?: PythonArcBridgeOptions;
}

export interface OfficialEvidenceAnchorRecord {
  readonly schema: 'metaharness.arc_agi_3.anchor_event.v1';
  readonly episodeId: string;
  readonly eventCount: number;
  readonly eventKind: string;
  readonly eventHash: string;
  readonly durableStateHash: string;
  readonly receiptHeadHash: string;
}

export interface OfficialEvidenceAnchorProof {
  readonly schema: 'metaharness.arc_agi_3.anchor_proof.v1';
  readonly episodeId: string;
  readonly eventCount: number;
  readonly durableStateHash: string;
  readonly receiptHeadHash: string;
  /** Opaque reference into the operator's independently retained evidence system. */
  readonly anchorReference: string;
}

export interface OfficialEvidenceAnchor {
  append(record: OfficialEvidenceAnchorRecord): Promise<void>;
  readFinal(episodeId: string): Promise<OfficialEvidenceAnchorProof | null>;
}

export interface OfficialArcRunGate {
  readonly expectedGames: number;
  readonly expectedLevels: number;
  readonly requiredScore: number;
}

export const ARC_AGI_3_PUBLIC_ACCEPTANCE_GATE: Readonly<OfficialArcRunGate> = Object.freeze({
  expectedGames: 25,
  expectedLevels: 183,
  requiredScore: 100,
});

export interface OfficialEpisodeEvidence {
  readonly episodeId: string;
  readonly receiptVerification: ReceiptVerification;
  readonly receiptReconciliation: ReceiptReconciliation | null;
  readonly durableEventCount: number;
  readonly durableStateHash: string;
  readonly actionIntentCount: number;
  readonly transitionCount: number;
  readonly danglingActionIntentCount: number;
  readonly scorecardRunMatched: boolean;
  readonly externalAnchorMatched: boolean;
  readonly externalAnchorReferenceHash?: string;
  readonly accepted: boolean;
}

export interface OfficialArcRunEvidence {
  readonly schema: 'metaharness.arc_agi_3.official_run.v1';
  readonly accepted: boolean;
  readonly acceptanceGate: OfficialArcRunGate;
  readonly configurationHash: string;
  readonly scorecardHash: string;
  readonly evidenceHash: string;
  readonly summary: {
    readonly score: number;
    readonly competitionMode: boolean;
    readonly totalGames: number;
    readonly completedGames: number;
    readonly totalLevels: number;
    readonly completedLevels: number;
    readonly totalActions: number;
    readonly totalResets: number;
    readonly scorecardRuns: number;
    readonly receiptedTransitions: number;
    readonly danglingActionIntents: number;
  };
  readonly episodes: readonly OfficialEpisodeEvidence[];
  readonly failures: readonly string[];
}

export interface OfficialArcControllerFactory extends ArcControllerFactory {
  /** Operator-only scorecard read. This is deliberately not an MCP tool. */
  getScorecard(): Promise<ArcScorecard | null>;
  /** Finalize the shared scorecard once and retain the returned evidence. */
  closeScorecard(): Promise<ArcScorecard | null>;
  /** Explicit operator override required to leave a non-winning assignment. */
  approveAdvance(episodeId: string): void;
  /** Permit diagnostic continuation only; a failed attempt invalidates this scorecard for acceptance. */
  approveRetry(episodeId: string): void;
  /** Reconcile the closed official scorecard with receipts and durable intents. */
  finalizeEvidence(): Promise<OfficialArcRunEvidence>;
  close(): Promise<void>;
  readonly assignedCount: number;
  readonly acceptanceGate: OfficialArcRunGate;
}

interface OfficialEpisodeRun {
  readonly episodeId: string;
  readonly principalId: string;
  readonly assignmentIndex: number;
  readonly assignment: OfficialArcAssignment;
  readonly sessionLog: SessionLog;
  readonly sessionPath: string;
  controller?: ArcController;
  guid?: string;
  state: 'STARTING' | 'ACTIVE' | 'FAILED' | 'FINALIZED';
}

interface ScorecardRun {
  readonly guid?: string;
  readonly actions: number;
  readonly resets: number;
}

const PREFLIGHT_ENVIRONMENT: ArcEnvironment = Object.freeze({
  reset: async () => { throw new Error('preflight environment cannot reset'); },
  observe: async () => { throw new Error('preflight environment cannot observe'); },
  step: async () => { throw new Error('preflight environment cannot step'); },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snapshotScorecard(value: ArcScorecard | null): ArcScorecard | null {
  if (value === null) return null;
  const snapshot = snapshotArcJson(value);
  if (!isRecord(snapshot)) throw new TypeError('official ARC scorecard must be a JSON object');
  return snapshot;
}

function snapshotFinalEvidence(value: OfficialArcRunEvidence): OfficialArcRunEvidence {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError('official ARC evidence must be JSON serializable');
  }
  const snapshot = snapshotArcJson(JSON.parse(encoded));
  if (!isRecord(snapshot)) throw new TypeError('official ARC evidence must be a JSON object');
  return snapshot as unknown as OfficialArcRunEvidence;
}

function safeNonnegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function containsLoneSurrogate(value: unknown): boolean {
  if (typeof value === 'string') return LONE_SURROGATE.test(value);
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsLoneSurrogate);
  return Object.entries(value).some(
    ([key, item]) => LONE_SURROGATE.test(key) || containsLoneSurrogate(item),
  );
}

/** Exact copy of the SessionLog canonical fold contract in kernel-js/session. */
function canonicalSessionJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalSessionJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  return `{${keys.map((key) =>
    `${JSON.stringify(key)}:${canonicalSessionJson(record[key])}`).join(',')}}`;
}

function validateAssignment(input: OfficialArcAssignment): OfficialArcAssignment {
  if (!input || typeof input !== 'object' || typeof input.gameId !== 'string') {
    throw new TypeError('each private ARC assignment must contain a gameId');
  }
  const gameId = input.gameId.trim();
  if (!gameId || gameId.length > 1_024 || /[\u0000-\u001f]/.test(gameId)) {
    throw new TypeError('private ARC gameId must be bounded text');
  }
  if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) {
    throw new TypeError('private ARC seed must be a nonnegative safe integer');
  }
  if (input.gameVersionHash !== undefined && !SHA256.test(input.gameVersionHash)) {
    throw new TypeError('private ARC gameVersionHash must be a lowercase SHA-256 hash');
  }
  return Object.freeze({
    gameId,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.gameVersionHash === undefined ? {} : { gameVersionHash: input.gameVersionHash }),
  });
}

function validatedEvidenceRoot(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('evidenceRoot is required');
  const root = resolve(value);
  if (parse(root).root === root) throw new TypeError('evidenceRoot must not be a filesystem root');
  return root;
}

function validatedScorecardOptions(input: ScorecardOptions = {}): ScorecardOptions {
  if (input.sourceUrl !== undefined && (
    typeof input.sourceUrl !== 'string' || input.sourceUrl.length > 2_048
  )) throw new TypeError('scorecard sourceUrl is invalid');
  if (input.tags !== undefined && (
    !Array.isArray(input.tags)
    || input.tags.length > 64
    || input.tags.some((tag) => typeof tag !== 'string' || !tag || tag.length > 200)
  )) throw new TypeError('scorecard tags are invalid');
  let encoded: string;
  try {
    encoded = JSON.stringify(input);
  } catch {
    throw new TypeError('scorecard options must be JSON serializable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_SCORECARD_CONFIG_BYTES) {
    throw new TypeError('scorecard options exceed the configuration limit');
  }
  return Object.freeze({
    ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
    ...(input.tags === undefined ? {} : { tags: Object.freeze([...input.tags]) }),
    ...(input.opaque === undefined ? {} : { opaque: JSON.parse(JSON.stringify(input.opaque)) }),
  });
}

function validatedRunGate(
  input: OfficialArcRunGate = ARC_AGI_3_PUBLIC_ACCEPTANCE_GATE,
): Readonly<OfficialArcRunGate> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('official ARC acceptanceGate is required');
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 || keys.some((key) => typeof key !== 'string' || ![
    'expectedGames',
    'expectedLevels',
    'requiredScore',
  ].includes(key))) {
    throw new TypeError('official ARC acceptanceGate fields are invalid');
  }
  return Object.freeze({
    expectedGames: gateValue(input.expectedGames, 'expectedGames', 1, 10_000),
    expectedLevels: gateValue(input.expectedLevels, 'expectedLevels', 1, 1_000_000),
    requiredScore: gateValue(input.requiredScore, 'requiredScore', 0, 100),
  });
}

function privateVersionHash(assignment: OfficialArcAssignment, manifest: ArcRunManifest): string {
  return assignment.gameVersionHash ?? hashArcValue({
    privateGameId: assignment.gameId,
    seed: assignment.seed ?? null,
    environmentAdapterVersion: manifest.environmentAdapterVersion,
  });
}

function preflightController(
  context: ArcControllerFactoryContext,
  assignment: OfficialArcAssignment,
  manifest: ArcRunManifest,
  budget: Partial<ArcRunBudget> | undefined,
): void {
  createArcController({
    principalId: context.principalId,
    runId: context.runId,
    gameVersionHash: privateVersionHash(assignment, manifest),
    environment: PREFLIGHT_ENVIRONMENT,
    runManifest: manifest,
    budget,
  });
}

async function createEvidenceLog(
  root: string,
  context: ArcControllerFactoryContext,
  anchor?: OfficialEvidenceAnchor,
): Promise<{ log: SessionLog; controllerLog: ArcSessionLog; path: string }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const scope = hashArcValue({ principalId: context.principalId, episodeId: context.episodeId });
  const path = join(root, `episode_${scope}.jsonl`);
  await writeFile(path, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await chmod(path, 0o600);
  const log = await SessionLog.open(path);
  let receiptHeadHash = TRANSITION_RECEIPT_GENESIS;
  const controllerLog: ArcSessionLog = anchor
    ? {
        append: async (kind, payload) => {
          const event = await log.append(kind, payload);
          if (isRecord(payload)) {
            const candidate = kind === 'arc.transition'
              ? payload.receiptHash
              : kind === 'arc.close'
                ? payload.receiptHead
                : undefined;
            if (typeof candidate === 'string' && SHA256.test(candidate)) {
              receiptHeadHash = candidate;
            }
          }
          const record: OfficialEvidenceAnchorRecord = Object.freeze({
            schema: 'metaharness.arc_agi_3.anchor_event.v1',
            episodeId: context.episodeId,
            eventCount: event.index + 1,
            eventKind: kind,
            eventHash: hashArcValue(event),
            durableStateHash: log.stateHash(),
            receiptHeadHash,
          });
          await anchor.append(record);
          return event;
        },
        stateHash: () => log.stateHash(),
      }
    : log;
  return { log, controllerLog, path };
}

function anchorProofMatches(
  proof: OfficialEvidenceAnchorProof | null,
  run: OfficialEpisodeRun,
  journal: Awaited<ReturnType<typeof journalEvidence>>,
  receiptHeadHash: string,
): proof is OfficialEvidenceAnchorProof {
  return proof !== null
    && proof.schema === 'metaharness.arc_agi_3.anchor_proof.v1'
    && proof.episodeId === run.episodeId
    && proof.eventCount === journal.eventCount
    && proof.durableStateHash === journal.stateHash
    && proof.receiptHeadHash === receiptHeadHash
    && typeof proof.anchorReference === 'string'
    && proof.anchorReference.length > 0
    && proof.anchorReference.length <= 2_048
    && !/[\u0000-\u001f]/.test(proof.anchorReference);
}

function scorecardRuns(scorecard: ArcScorecard): {
  runs: ScorecardRun[];
  rawEnvironmentCount: number;
  rawRunCount: number;
  valid: boolean;
} {
  if (!Array.isArray(scorecard.environments)) {
    return { runs: [], rawEnvironmentCount: 0, rawRunCount: 0, valid: false };
  }
  const result: ScorecardRun[] = [];
  let rawRunCount = 0;
  let valid = true;
  for (const environment of scorecard.environments) {
    if (!isRecord(environment) || !Array.isArray(environment.runs)) {
      valid = false;
      continue;
    }
    if (environment.runs.length === 0) valid = false;
    for (const run of environment.runs) {
      rawRunCount += 1;
      if (!isRecord(run)) {
        valid = false;
        continue;
      }
      const actions = safeNonnegativeInteger(run.actions);
      const resets = run.resets === undefined ? 0 : safeNonnegativeInteger(run.resets);
      if (actions === undefined || resets === undefined || actions < resets ||
          typeof run.guid !== 'string' || !run.guid || run.guid.length > 2_048 ||
          /[\u0000-\u001f]/.test(run.guid)) {
        valid = false;
        continue;
      }
      result.push({
        guid: run.guid,
        actions,
        resets,
      });
    }
  }
  return {
    runs: result,
    rawEnvironmentCount: scorecard.environments.length,
    rawRunCount,
    valid,
  };
}

async function journalEvidence(run: OfficialEpisodeRun): Promise<{
  valid: boolean;
  eventCount: number;
  stateHash: string;
  intentCount: number;
  transitionCount: number;
  dangling: number;
  headHash: string;
  intentRequestHashes: readonly string[];
  transitionRequestHashes: readonly string[];
  transitionReceiptHashes: readonly string[];
}> {
  let raw = '';
  let privateMode = false;
  try {
    const handle = await open(
      run.sessionPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_EVIDENCE_LOG_BYTES) throw new Error('invalid log');
      // Windows exposes only a limited subset of POSIX mode semantics through
      // stat/chmod. In particular, group/other bits do not represent Windows
      // DACLs, so they cannot validate privacy there. Journal integrity and
      // the independent anchor are still verified below. Keep the strict 0600
      // check everywhere Node provides meaningful POSIX permission bits.
      privateMode = process.platform === 'win32' || (info.mode & 0o077) === 0;
      raw = await handle.readFile({ encoding: 'utf8' });
    } finally {
      await handle.close();
    }
  } catch {
    return {
      valid: false,
      eventCount: 0,
      stateHash: '',
      intentCount: 0,
      transitionCount: 0,
      dangling: 0,
      headHash: TRANSITION_RECEIPT_GENESIS,
      intentRequestHashes: [],
      transitionRequestHashes: [],
      transitionReceiptHashes: [],
    };
  }
  const intentRequestHashes: string[] = [];
  const transitionRequestHashes: string[] = [];
  const transitionReceiptHashes: string[] = [];
  let parseValid = privateMode;
  let expectedIndex = 0;
  let stateHash = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      parseValid = false;
      continue;
    }
    if (
      !isRecord(event)
      || event.index !== expectedIndex
      || event.branch !== 'main'
      || event.parent !== undefined
      || typeof event.kind !== 'string'
      || !('payload' in event)
      || containsLoneSurrogate(event)
    ) {
      parseValid = false;
      continue;
    }
    expectedIndex += 1;
    stateHash = createHash('sha256')
      .update(stateHash + canonicalSessionJson(event), 'utf8')
      .digest('hex');
    if (event.kind === 'arc.action_intent') {
      if (isRecord(event.payload) && typeof event.payload.requestHash === 'string' &&
          SHA256.test(event.payload.requestHash)) {
        intentRequestHashes.push(event.payload.requestHash);
      } else {
        parseValid = false;
      }
    }
    if (event.kind === 'arc.transition') {
      if (isRecord(event.payload) && typeof event.payload.receiptHash === 'string' &&
          SHA256.test(event.payload.receiptHash) &&
          typeof event.payload.requestHash === 'string' && SHA256.test(event.payload.requestHash)) {
        transitionReceiptHashes.push(event.payload.receiptHash);
        transitionRequestHashes.push(event.payload.requestHash);
      } else {
        parseValid = false;
      }
    }
  }
  return {
    valid: parseValid,
    eventCount: expectedIndex,
    stateHash,
    intentCount: intentRequestHashes.length,
    transitionCount: transitionReceiptHashes.length,
    dangling: Math.abs(intentRequestHashes.length - transitionReceiptHashes.length),
    headHash: transitionReceiptHashes.at(-1) ?? TRANSITION_RECEIPT_GENESIS,
    intentRequestHashes: Object.freeze(intentRequestHashes),
    transitionRequestHashes: Object.freeze(transitionRequestHashes),
    transitionReceiptHashes: Object.freeze(transitionReceiptHashes),
  };
}

function gateValue(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} is outside the accepted gate range`);
  }
  return value;
}

/** Build one hidden, sequential assignment factory around one official scorecard. */
export function createOfficialArcControllerFactory(
  options: OfficialArcControllerFactoryOptions,
): OfficialArcControllerFactory {
  if (!options || typeof options !== 'object') {
    throw new TypeError('official ARC factory options are required');
  }
  if (!Array.isArray(options.assignments) || options.assignments.length === 0) {
    throw new TypeError('at least one private ARC assignment is required');
  }
  if (options.assignments.length > 10_000 ||
      Object.keys(options.assignments).length !== options.assignments.length) {
    throw new TypeError('private ARC assignments must be a bounded dense array');
  }
  if (options.bridge && options.bridgeOptions) {
    throw new TypeError('provide either bridge or bridgeOptions, not both');
  }
  const acceptanceGate = validatedRunGate(options.acceptanceGate);
  if (options.assignments.length !== acceptanceGate.expectedGames) {
    throw new TypeError('private ARC assignment count must match the frozen acceptanceGate');
  }
  const assignments = Object.freeze(options.assignments.map(validateAssignment));
  if (new Set(assignments.map(assignment => assignment.gameId)).size !== assignments.length) {
    throw new TypeError('private ARC assignment game IDs must be unique');
  }
  const evidenceRoot = validatedEvidenceRoot(options.evidenceRoot);
  const scorecardOptions = validatedScorecardOptions(options.scorecard);
  // Commit the exact normalized values enforced by every controller, including
  // the controller version and defaults omitted from partial operator input.
  const runManifest = normalizeArcRunManifest(options.runManifest);
  const budget = normalizeArcRunBudget(options.budget);
  const evidenceAnchor: OfficialEvidenceAnchor | undefined = options.evidenceAnchor
    ? Object.freeze({
        append: options.evidenceAnchor.append.bind(options.evidenceAnchor),
        readFinal: options.evidenceAnchor.readFinal.bind(options.evidenceAnchor),
      })
    : undefined;
  const requestedMode = options.bridgeOptions?.env?.ARC_OPERATION_MODE
    ?? options.bridgeOptions?.env?.OPERATION_MODE;
  if (!options.bridge && requestedMode !== undefined && requestedMode !== 'competition') {
    throw new TypeError('official ARC evidence requires competition operation mode');
  }
  // Validate manifest and budget before spawning Python or touching a scorecard.
  preflightController(
    { principalId: 'preflight', episodeId: 'preflight', runId: 'preflight' },
    assignments[0]!,
    runManifest,
    budget,
  );

  const bridge: OfficialArcBridge = options.bridge ?? new PythonArcBridge({
    ...options.bridgeOptions,
    env: {
      ...options.bridgeOptions?.env,
      ARC_OPERATION_MODE: 'competition',
      OPERATION_MODE: 'competition',
    },
  });
  const runs = new Map<string, OfficialEpisodeRun>();
  const approvedAdvance = new Set<string>();
  const approvedRetry = new Set<string>();
  let currentEpisodeId: string | undefined;
  let nextAssignment = 0;
  let boundPrincipal: string | undefined;
  let scorecardIdPromise: Promise<string> | undefined;
  let closedScorecard: ArcScorecard | null | undefined;
  let closeScorecardPromise: Promise<ArcScorecard | null> | undefined;
  let finalEvidencePromise: Promise<OfficialArcRunEvidence> | undefined;
  let closePromise: Promise<void> | undefined;
  let lifecycle: 'RUNNING' | 'FINALIZING' | 'FINALIZED' | 'CLOSED' = 'RUNNING';
  let factoryTail: Promise<void> = Promise.resolve();

  const withFactoryLock = async <T>(body: () => Promise<T>): Promise<T> => {
    const prior = factoryTail;
    let release!: () => void;
    factoryTail = new Promise<void>((resolveLock) => { release = resolveLock; });
    await prior;
    try {
      return await body();
    } finally {
      release();
    }
  };

  const scorecardId = (): Promise<string> => {
    scorecardIdPromise ??= bridge.createScorecard(scorecardOptions).catch(() => {
      scorecardIdPromise = undefined;
      throw new Error('official ARC scorecard creation failed');
    });
    return scorecardIdPromise;
  };

  const finishCurrent = async (): Promise<void> => {
    if (!currentEpisodeId) return;
    const current = runs.get(currentEpisodeId);
    if (!current) throw new Error('official ARC run state is unavailable');
    const phase = current.controller?.status().phase;
    if (current.state === 'FAILED' && approvedRetry.delete(current.episodeId)) {
      nextAssignment = current.assignmentIndex;
      current.state = 'FINALIZED';
      currentEpisodeId = undefined;
      return;
    }
    if (phase !== 'WON' && !approvedAdvance.delete(current.episodeId)) {
      throw new Error('official ARC assignment is still active');
    }
    await current.controller?.close();
    current.state = 'FINALIZED';
    currentEpisodeId = undefined;
  };

  const callable = (async (context: ArcControllerFactoryContext): Promise<ArcController> => (
    withFactoryLock(async () => {
      if (lifecycle !== 'RUNNING') throw new Error('official ARC run is closing');
      if (runs.has(context.episodeId)) throw new Error('official ARC episode is already bound');
      if (boundPrincipal !== undefined && boundPrincipal !== context.principalId) {
        throw new Error('official ARC assignment is unavailable');
      }
      boundPrincipal ??= context.principalId;
      await finishCurrent();
      const assignment = assignments[nextAssignment];
      if (!assignment) throw new Error('official ARC assignment queue is exhausted');
      preflightController(context, assignment, runManifest, budget);
      const evidence = await createEvidenceLog(evidenceRoot, context, evidenceAnchor);
      const run: OfficialEpisodeRun = {
        episodeId: context.episodeId,
        principalId: context.principalId,
        assignmentIndex: nextAssignment,
        assignment,
        sessionLog: evidence.log,
        sessionPath: evidence.path,
        state: 'STARTING',
      };
      runs.set(context.episodeId, run);
      currentEpisodeId = context.episodeId;
      let started: StartedArcEnvironment;
      try {
        started = await bridge.startGame({
          gameId: assignment.gameId,
          scorecardId: await scorecardId(),
          ...(assignment.seed === undefined ? {} : { seed: assignment.seed }),
          bridgeOwnership: 'external',
        });
      } catch {
        run.state = 'FAILED';
        throw new Error('official ARC environment start failed');
      }
      try {
        const controller = createArcController({
          principalId: context.principalId,
          runId: context.runId,
          gameVersionHash: privateVersionHash(assignment, runManifest),
          environment: started.environment,
          runManifest,
          budget,
          sessionLog: evidence.controllerLog,
        });
        run.controller = controller;
        const guid = started.initialObservation.metadata?.guid;
        if (typeof guid === 'string' && guid) run.guid = guid;
        run.state = 'ACTIVE';
        nextAssignment += 1;
        return controller;
      } catch {
        run.state = 'FAILED';
        await Promise.resolve(started.environment.close?.()).catch(() => undefined);
        throw new Error('official ARC controller creation failed');
      }
    })
  )) as OfficialArcControllerFactory;

  Object.defineProperty(callable, 'assignedCount', {
    enumerable: true,
    get: () => nextAssignment,
  });
  Object.defineProperty(callable, 'acceptanceGate', {
    enumerable: true,
    value: acceptanceGate,
  });
  callable.supportsResume = false;

  callable.releaseUnpublishedEpisode = (context: ArcControllerFactoryContext): Promise<void> => (
    withFactoryLock(async () => {
      const run = runs.get(context.episodeId);
      if (!run) return;
      if (
        run.principalId !== context.principalId
        || currentEpisodeId !== context.episodeId
        || run.state === 'FINALIZED'
        || (run.controller?.status().actionCount ?? 0) !== 0
      ) {
        throw new Error('official ARC unpublished episode cannot be released');
      }
      run.state = 'FAILED';
      currentEpisodeId = undefined;
      nextAssignment = run.assignmentIndex;
      approvedAdvance.delete(run.episodeId);
      approvedRetry.delete(run.episodeId);
    })
  );

  callable.approveAdvance = (episodeId: string): void => {
    if (lifecycle !== 'RUNNING') throw new Error('official ARC run is closing');
    const run = runs.get(episodeId);
    if (episodeId !== currentEpisodeId || !run || !run.controller || run.state !== 'ACTIVE') {
      throw new Error('official ARC episode is not current');
    }
    approvedAdvance.add(episodeId);
  };

  callable.approveRetry = (episodeId: string): void => {
    if (lifecycle !== 'RUNNING') throw new Error('official ARC run is closing');
    const run = runs.get(episodeId);
    if (episodeId !== currentEpisodeId || !run || run.state !== 'FAILED') {
      throw new Error('official ARC episode is not retryable');
    }
    approvedRetry.add(episodeId);
  };

  callable.getScorecard = async (): Promise<ArcScorecard | null> => {
    if (closedScorecard !== undefined) return closedScorecard;
    if (!scorecardIdPromise) return null;
    try {
      return snapshotScorecard(await bridge.getScorecard(await scorecardIdPromise));
    } catch {
      throw new Error('official ARC scorecard read failed');
    }
  };

  callable.closeScorecard = (): Promise<ArcScorecard | null> => {
    if (closeScorecardPromise) return closeScorecardPromise;
    lifecycle = 'FINALIZING';
    closeScorecardPromise = withFactoryLock(async () => {
      const controllerResults = await Promise.allSettled(
        [...runs.values()].map(async (run) => {
          await run.controller?.close();
          run.state = 'FINALIZED';
        }),
      );
      currentEpisodeId = undefined;
      let scorecard: ArcScorecard | null = null;
      let scorecardFailed = false;
      if (scorecardIdPromise) {
        try {
          scorecard = snapshotScorecard(await bridge.closeScorecard(await scorecardIdPromise));
        } catch {
          scorecardFailed = true;
        }
      }
      closedScorecard = scorecard;
      if (controllerResults.some((result) => result.status === 'rejected')) {
        throw new Error('official ARC controller close failed');
      }
      if (scorecardFailed) {
        throw new Error('official ARC scorecard close failed');
      }
      lifecycle = 'FINALIZED';
      return scorecard;
    });
    return closeScorecardPromise;
  };

  callable.finalizeEvidence = (): Promise<OfficialArcRunEvidence> => {
    if (finalEvidencePromise) return finalEvidencePromise;
    finalEvidencePromise = (async () => {
      const scorecard = await callable.closeScorecard();
      if (!scorecard) throw new Error('official ARC scorecard is unavailable');
      const parsedScorecardRuns = scorecardRuns(scorecard);
      const officialRuns = parsedScorecardRuns.runs;
      const claimedGuids = new Set<string>();
      const episodeEvidence: OfficialEpisodeEvidence[] = [];
      const failures = new Set<string>();
      if (!parsedScorecardRuns.valid) failures.add('MALFORMED_SCORECARD_RUNS');

      for (const run of runs.values()) {
        if (!run.controller) {
          failures.add('EPISODE_WITHOUT_CONTROLLER');
          continue;
        }
        const journal = await journalEvidence(run);
        const verification = run.controller.verifyReceipts();
        const commitments = run.controller.orderedReceiptCommitments();
        const journalReceiptsMatch = commitments.length === journal.transitionReceiptHashes.length
          && commitments.length === journal.intentRequestHashes.length
          && commitments.length === journal.transitionRequestHashes.length
          && commitments.every((commitment, index) => (
            commitment.receiptHash === journal.transitionReceiptHashes[index]
            && commitment.requestHash === journal.intentRequestHashes[index]
            && commitment.requestHash === journal.transitionRequestHashes[index]
          ));
        let anchorProof: OfficialEvidenceAnchorProof | null = null;
        if (evidenceAnchor) {
          try {
            anchorProof = await evidenceAnchor.readFinal(run.episodeId);
          } catch {
            failures.add('EXTERNAL_ANCHOR_READ_FAILED');
          }
        }
        const verifiedHead = verification.ok
          ? verification.headHash
          : TRANSITION_RECEIPT_GENESIS;
        const matchedAnchorProof = anchorProofMatches(
          anchorProof,
          run,
          journal,
          verifiedHead,
        ) ? anchorProof : undefined;
        const anchorMatched = matchedAnchorProof !== undefined;
        const matches = run.guid
          ? officialRuns.filter((candidate) => candidate.guid === run.guid)
          : [];
        const official = matches.length === 1 && run.guid && !claimedGuids.has(run.guid)
          ? matches[0]
          : undefined;
        if (run.guid && official) claimedGuids.add(run.guid);
        const reconciliation = official && anchorMatched
          ? run.controller.reconcileReceipts({
              // The official SDK includes RESET in EnvironmentScore.actions.
              actionCount: official.actions - official.resets,
              resetCount: official.resets,
              expectedReceiptHeadHash: matchedAnchorProof.receiptHeadHash,
            })
          : null;
        const accepted = journal.valid
          && journal.dangling === 0
          && verification.ok
          && journal.transitionCount === verification.count
          && journalReceiptsMatch
          && anchorMatched
          && reconciliation?.ok === true
          && run.controller.status().uncertainMutationCount === 0;
        if (!journal.valid) failures.add('INVALID_DURABLE_JOURNAL');
        if (journal.dangling > 0) failures.add('DANGLING_ACTION_INTENT');
        if (!verification.ok) failures.add('INVALID_RECEIPT_CHAIN');
        if (!journalReceiptsMatch) failures.add('JOURNAL_RECEIPT_MISMATCH');
        if (!evidenceAnchor) failures.add('EXTERNAL_ANCHOR_REQUIRED');
        else if (!anchorMatched) failures.add('EXTERNAL_ANCHOR_MISMATCH');
        if (!official) failures.add('UNMATCHED_SCORECARD_RUN');
        if (reconciliation && !reconciliation.ok) failures.add('RECEIPT_SCORECARD_MISMATCH');
        if (run.controller.status().uncertainMutationCount > 0) failures.add('UNCERTAIN_MUTATION');
        episodeEvidence.push(Object.freeze({
          episodeId: run.episodeId,
          receiptVerification: verification,
          receiptReconciliation: reconciliation,
          durableEventCount: journal.eventCount,
          durableStateHash: journal.stateHash,
          actionIntentCount: journal.intentCount,
          transitionCount: journal.transitionCount,
          danglingActionIntentCount: journal.dangling,
          scorecardRunMatched: official !== undefined,
          externalAnchorMatched: anchorMatched,
          ...(anchorMatched
            ? { externalAnchorReferenceHash: hashArcValue(matchedAnchorProof.anchorReference) }
            : {}),
          accepted,
        }));
      }

      const rawScore = safeNumber(scorecard.score);
      const scoreIsValid = rawScore !== undefined && rawScore >= 0 && rawScore <= 100;
      const score = scoreIsValid ? rawScore : -1;
      const competitionMode = scorecard.competition_mode === true;
      const totalGames = safeNonnegativeInteger(scorecard.total_environments) ?? -1;
      const completedGames = safeNonnegativeInteger(scorecard.total_environments_completed) ?? -1;
      const totalLevels = safeNonnegativeInteger(scorecard.total_levels) ?? -1;
      const completedLevels = safeNonnegativeInteger(scorecard.total_levels_completed) ?? -1;
      const totalActions = safeNonnegativeInteger(scorecard.total_actions) ?? -1;
      const summedActions = officialRuns.reduce((sum, run) => sum + run.actions, 0);
      const totalResets = officialRuns.reduce((sum, run) => sum + run.resets, 0);
      const receiptedTransitions = episodeEvidence.reduce((sum, item) => sum + item.transitionCount, 0);
      const danglingActionIntents = episodeEvidence.reduce(
        (sum, item) => sum + item.danglingActionIntentCount,
        0,
      );
      if (!scoreIsValid) failures.add('MALFORMED_SCORECARD_SCORE');
      if (score < acceptanceGate.requiredScore) failures.add('SCORE_GATE_FAILED');
      if (!competitionMode) failures.add('COMPETITION_MODE_REQUIRED');
      if (totalGames !== acceptanceGate.expectedGames ||
          completedGames !== acceptanceGate.expectedGames) {
        failures.add('GAME_GATE_FAILED');
      }
      if (totalLevels !== acceptanceGate.expectedLevels ||
          completedLevels !== acceptanceGate.expectedLevels) {
        failures.add('LEVEL_GATE_FAILED');
      }
      if (
        assignments.length !== acceptanceGate.expectedGames
        || nextAssignment !== acceptanceGate.expectedGames
        || episodeEvidence.length !== acceptanceGate.expectedGames
        || parsedScorecardRuns.rawEnvironmentCount !== acceptanceGate.expectedGames
        || parsedScorecardRuns.rawRunCount !== acceptanceGate.expectedGames
        || officialRuns.length !== acceptanceGate.expectedGames
      ) failures.add('FROZEN_ASSIGNMENT_GATE_FAILED');
      if (totalActions !== summedActions) failures.add('SCORECARD_TOTAL_MISMATCH');
      if (episodeEvidence.some((item) => !item.accepted)) failures.add('EPISODE_GATE_FAILED');

      const body = {
        schema: 'metaharness.arc_agi_3.official_run.v1' as const,
        accepted: failures.size === 0,
        acceptanceGate,
        configurationHash: hashArcValue({
          assignments,
          runManifest,
          budget,
          scorecard: scorecardOptions,
          acceptanceGate,
        }),
        scorecardHash: hashArcValue(scorecard),
        summary: {
          score,
          competitionMode,
          totalGames,
          completedGames,
          totalLevels,
          completedLevels,
          totalActions,
          totalResets,
          scorecardRuns: parsedScorecardRuns.rawRunCount,
          receiptedTransitions,
          danglingActionIntents,
        },
        episodes: Object.freeze(episodeEvidence),
        failures: Object.freeze([...failures].sort()),
      };
      return snapshotFinalEvidence({ ...body, evidenceHash: hashArcValue(body) });
    })();
    return finalEvidencePromise;
  };

  callable.close = (): Promise<void> => {
    if (closePromise) return closePromise;
    const scorecardClosure = callable.closeScorecard();
    closePromise = (async () => {
      const scorecardResult = await Promise.allSettled([scorecardClosure]);
      const bridgeResult = await Promise.allSettled([bridge.dispose()]);
      lifecycle = 'CLOSED';
      const failures = [...scorecardResult, ...bridgeResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) throw new Error('official ARC factory cleanup failed');
    })();
    return closePromise;
  };

  return callable;
}
