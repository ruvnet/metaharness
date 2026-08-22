// SPDX-License-Identifier: MIT

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ArcAvoCheckpoint,
  ArcAvoConfig,
  ArcAvoConfigInput,
  ArcAvoLoopApi,
  ArcCandidatePlan,
  ArcCheckpoint,
  ArcController,
  ArcPlanOutcome,
  ArcPlanSelection,
  ArcRetrodiction,
  ArcSupervisorAuthority,
  CheckpointFrameBlob,
  CheckpointTransitionReceipt,
  ExactArcObservation,
  SupervisorCaseBundle,
  SupervisorDirective,
} from '@metaharness/arc-agi-3';
import type { ArcControllerFactory } from './types.js';
import { exactPublicJson } from './types.js';
import { opaqueAuditHash } from './audit.js';
import {
  bindOfficialAvoRuntime,
  captureOfficialAvoRuntime,
} from './official-avo-runtime.js';
import {
  hashArcValue,
  MAX_ARC_ANIMATION_FRAMES,
  createArcAvoLoop,
  resolveArcAvoConfig,
  validateArcRunBudget,
  verifyArcCheckpoint,
} from '@metaharness/arc-agi-3';

export interface EpisodeRecord {
  readonly episodeId: string;
  readonly principalId: string;
  readonly controller: ArcController;
  /** Present only for an opt-in AVO-mode store. */
  readonly avoLoop?: ArcAvoLoopApi;
  readonly createdAt: string;
  lastObservation: ExactArcObservation;
  readonly checkpoints: Map<string, ArcCheckpoint>;
  lastRestoredCheckpointId?: string;
  lastRestoredCheckpointHash?: string;
  lastSupervisorCase?: SupervisorCaseBundle;
  lastDirective?: SupervisorDirective;
}

export interface CreatedEpisode {
  record: EpisodeRecord;
  observation: ExactArcObservation;
}

function publicHandle(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString('base64url')}`;
}

const EPISODE_ID = /^episode_[A-Za-z0-9_-]{16,128}$/;
const CHECKPOINT_ID = /^checkpoint_[A-Za-z0-9_-]{16,128}$/;
const CAS_HASH = /^[a-f0-9]{64}$/;
const MAX_CHECKPOINT_DESCRIPTOR_BYTES = 64 * 1024 * 1024;
const MAX_CAS_OBJECT_BYTES = 2 * 1024 * 1024;
const MAX_CAS_OBJECTS_PER_ACTION = MAX_ARC_ANIMATION_FRAMES + 1;
const MAX_AVO_CAS_OBJECTS_PER_ACTION = MAX_CAS_OBJECTS_PER_ACTION + 11;
const MAX_CHECKPOINTS_PER_EPISODE = 64;
const MAX_DIRECTIVE_BYTES = 1024 * 1024;
const CAS_IO_CONCURRENCY = 64;

function validateHandle(kind: 'episode' | 'checkpoint', value: string): void {
  const valid = kind === 'episode' ? EPISODE_ID.test(value) : CHECKPOINT_ID.test(value);
  if (!valid) throw new Error(`invalid opaque ${kind} handle`);
}

function validCasHashArray(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every(hash => typeof hash === 'string' && CAS_HASH.test(hash))
    && new Set(value).size === value.length;
}

type CheckpointRemainder = Omit<ArcCheckpoint, 'receipts' | 'frameBlobs'>;

interface PersistedCheckpoint {
  schema: 'metaharness.arc_mcp.checkpoint_ref.v2';
  episodeId: string;
  checkpointId: string;
  checkpoint: CheckpointRemainder;
  receiptObjectHashes: readonly string[];
  frameObjectHashes: readonly string[];
}

type AvoArchiveRemainder = Omit<ArcAvoCheckpoint['archive'],
  'candidates' | 'selections' | 'outcomes'>;
type AvoWorldModelRemainder = Omit<ArcAvoCheckpoint['worldModel'], 'records'>;
type AvoCheckpointRemainder = Omit<
  ArcAvoCheckpoint,
  'coreCheckpoint' | 'archive' | 'worldModel'
> & {
  readonly coreCheckpoint: CheckpointRemainder;
  readonly archive: AvoArchiveRemainder;
  readonly worldModel: AvoWorldModelRemainder;
};

interface PersistedAvoCheckpoint {
  schema: 'metaharness.arc_mcp.avo_checkpoint_ref.v2';
  episodeId: string;
  checkpointId: string;
  checkpoint: AvoCheckpointRemainder;
  receiptObjectHashes: readonly string[];
  frameObjectHashes: readonly string[];
  candidateObjectHashes: readonly string[];
  selectionObjectHashes: readonly string[];
  outcomeObjectHashes: readonly string[];
  retrodictionObjectHashes: readonly string[];
}

interface IdempotencyEntry {
  inputHash: string;
  promise: Promise<unknown>;
}

function activeDirectiveFromCheckpoint(checkpoint: ArcCheckpoint): SupervisorDirective | undefined {
  if (checkpoint.activeDirectiveId === undefined) return undefined;
  const directive = checkpoint.directives.find(
    (candidate) => candidate.id === checkpoint.activeDirectiveId,
  );
  if (!directive) throw new Error('verified checkpoint active directive is unavailable');
  return directive;
}

function isMatchingRestoredCheckpoint(
  record: EpisodeRecord,
  checkpointId: string,
  expectedCheckpointHash: string,
): boolean {
  if (record.lastRestoredCheckpointId !== checkpointId) return false;
  if (record.lastRestoredCheckpointHash !== expectedCheckpointHash) {
    throw new Error('checkpoint does not match the externally anchored hash');
  }
  return true;
}

function validatedAvoCheckpoint(
  input: ArcAvoCheckpoint,
  config: ArcAvoConfig,
): ArcAvoCheckpoint {
  const checkpoint = exactPublicJson(input) as ArcAvoCheckpoint;
  if (
    checkpoint.schema !== 'metaharness.arc_agi_3.avo_checkpoint.v1' ||
    checkpoint.config?.configHash !== config.configHash ||
    typeof checkpoint.checkpointHash !== 'string' ||
    !CAS_HASH.test(checkpoint.checkpointHash)
  ) {
    throw new Error('AVO checkpoint configuration is invalid');
  }
  const { checkpointHash, ...body } = checkpoint;
  if (hashArcValue(body) !== checkpointHash) {
    throw new Error('AVO checkpoint failed integrity validation');
  }
  verifyArcCheckpoint(checkpoint.coreCheckpoint);
  if (checkpoint.observationHash !== checkpoint.coreCheckpoint.observation.observationHash) {
    throw new Error('AVO checkpoint observation is inconsistent');
  }
  return checkpoint;
}

export class NonRetryableMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableMutationError';
  }
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}

function inputHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

type ClosableArcController = ArcController & {
  close?: () => void | Promise<void>;
};

export const MAX_EPISODES_PER_PRINCIPAL = 10_000;
export const MAX_IDEMPOTENCY_ENTRIES_PER_PRINCIPAL = 1_000_000;

function assertStoreCapacity(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer no greater than ${maximum}`);
  }
}

/**
 * Process-local routing index. Durable episode facts and semantic memory live in
 * the injected ArcController, whose production factory must configure its
 * SessionLog/state root. The outer map prevents cross-principal lookup even if
 * an episode id is disclosed.
 */
export class ArcEpisodeStore {
  private readonly principals = new Map<string, Map<string, EpisodeRecord>>();
  private readonly controllerClosePromises = new Map<ArcController, Promise<void>>();
  private readonly retiredControllers = new Set<ArcController>();
  private factoryClosePromise: Promise<void> | undefined;
  private readonly idempotency = new Map<string, Map<string, IdempotencyEntry>>();
  private readonly activeIdempotentBodies = new Set<Promise<unknown>>();
  private readonly createLocks = new Map<string, Promise<void>>();
  private readonly resumeLocks = new Map<string, Promise<void>>();
  private readonly checkpointLocks = new Map<string, Promise<void>>();
  private readonly preparedCasDirectories = new Set<string>();
  private readonly avoConfig?: ArcAvoConfig;
  private closing = false;

  constructor(
    private readonly factory: ArcControllerFactory,
    private readonly stateRoot: string,
    private readonly now: () => Date = () => new Date(),
    private readonly maxEpisodesPerPrincipal = 32,
    private readonly maxIdempotencyEntriesPerPrincipal = 50_000,
    avoConfig?: ArcAvoConfig | ArcAvoConfigInput,
  ) {
    assertStoreCapacity(
      maxEpisodesPerPrincipal,
      'maxEpisodesPerPrincipal',
      MAX_EPISODES_PER_PRINCIPAL,
    );
    assertStoreCapacity(
      maxIdempotencyEntriesPerPrincipal,
      'maxIdempotencyEntriesPerPrincipal',
      MAX_IDEMPOTENCY_ENTRIES_PER_PRINCIPAL,
    );
    this.avoConfig = avoConfig === undefined ? undefined : resolveArcAvoConfig(avoConfig);
  }

  private async withLock<T>(
    locks: Map<string, Promise<void>>,
    key: string,
    body: () => Promise<T>,
  ): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const tail = previous.then(() => held);
    locks.set(key, tail);
    await previous;
    try {
      return await body();
    } finally {
      release();
      if (locks.get(key) === tail) locks.delete(key);
    }
  }

  async runIdempotent<T>(options: {
    principalId: string;
    tool: string;
    key: string;
    input: unknown;
    body: () => Promise<T>;
  }): Promise<IdempotentResult<T>> {
    if (this.closing) throw new Error('episode store is closing');
    if (options.key.length < 8 || options.key.length > 200) {
      throw new Error('invalid idempotency key');
    }
    let ledger = this.idempotency.get(options.principalId);
    if (!ledger) {
      ledger = new Map();
      this.idempotency.set(options.principalId, ledger);
    }
    const scopedKey = `${options.tool}\0${options.key}`;
    const digest = inputHash(options.input);
    const existing = ledger.get(scopedKey);
    if (existing) {
      if (existing.inputHash !== digest) {
        throw new Error('idempotency key was already used with different input');
      }
      return { value: await existing.promise as T, replayed: true };
    }
    if (ledger.size >= this.maxIdempotencyEntriesPerPrincipal) {
      throw new Error('idempotency ledger limit reached');
    }
    const promise = options.body();
    this.activeIdempotentBodies.add(promise);
    void promise.then(
      () => this.activeIdempotentBodies.delete(promise),
      () => this.activeIdempotentBodies.delete(promise),
    );
    ledger.set(scopedKey, { inputHash: digest, promise });
    try {
      return { value: await promise, replayed: false };
    } catch (error) {
      if (!(error instanceof NonRetryableMutationError)) ledger.delete(scopedKey);
      throw error;
    }
  }

  async create(principalId: string): Promise<CreatedEpisode> {
    if (this.closing) throw new Error('episode store is closing');
    return this.withLock(this.createLocks, principalId, async () => {
      if (this.closing) throw new Error('episode store is closing');
      const existing = this.principals.get(principalId);
      if ((existing?.size ?? 0) >= this.maxEpisodesPerPrincipal) {
        throw new Error('episode limit reached; close the server or use another configured principal');
      }
      const episodeId = publicHandle('episode');
      const context = {
        principalId,
        episodeId,
        runId: episodeId,
        ...(this.avoConfig === undefined
          ? {}
          : { requestedSupervisionGate: this.avoConfig.features.supervisorGate }),
      };
      let controller: ArcController | undefined;
      let avoLoop: ArcAvoLoopApi | undefined;
      try {
        controller = await this.factory(context);
      } catch {
        try {
          await this.factory.releaseUnpublishedEpisode?.(context);
        } catch {
          throw new Error('controller factory cleanup failed');
        }
        throw new Error('controller factory failed');
      }
      let observation: ExactArcObservation;
      try {
        if (this.avoConfig) {
          avoLoop = createArcAvoLoop({ controller, config: this.avoConfig });
          observation = (await avoLoop.start()).observation;
          bindOfficialAvoRuntime(this.factory, context, avoLoop);
        } else {
          observation = await controller.start();
        }
        exactPublicJson(observation);
      } catch {
        const cleanup = await Promise.allSettled([
          Promise.resolve(avoLoop?.close()),
          this.closeController(controller),
          Promise.resolve(this.factory.releaseUnpublishedEpisode?.(context)),
        ]);
        if (cleanup.some(result => result.status === 'rejected')) {
          throw new Error('controller start cleanup failed');
        }
        throw new Error('controller start failed');
      }

      let episodes = this.principals.get(principalId);
      if (!episodes) {
        episodes = new Map();
        this.principals.set(principalId, episodes);
      }
      const record: EpisodeRecord = {
        episodeId,
        principalId,
        controller,
        ...(avoLoop === undefined ? {} : { avoLoop }),
        createdAt: this.now().toISOString(),
        lastObservation: observation,
        checkpoints: new Map(),
      };
      episodes.set(episodeId, record);
      return { record, observation };
    });
  }

  get(principalId: string, episodeId: string): EpisodeRecord {
    const record = this.principals.get(principalId)?.get(episodeId);
    if (!record) throw new Error('episode is unavailable to this principal');
    return record;
  }

  updateObservation(record: EpisodeRecord, observation: ExactArcObservation): void {
    exactPublicJson(observation);
    record.lastObservation = observation;
  }

  private checkpointDirectory(principalId: string, episodeId: string): string {
    validateHandle('episode', episodeId);
    const principalDirectory = `principal_${opaqueAuditHash(principalId)}`;
    return resolve(this.stateRoot, principalDirectory, episodeId);
  }

  private checkpointPath(principalId: string, episodeId: string, checkpointId: string): string {
    validateHandle('checkpoint', checkpointId);
    return join(this.checkpointDirectory(principalId, episodeId), 'checkpoints', `${checkpointId}.json`);
  }

  private casDirectory(principalId: string, episodeId: string): string {
    return join(this.checkpointDirectory(principalId, episodeId), 'objects');
  }

  private async ensureCasDirectory(principalId: string, episodeId: string): Promise<string> {
    const directory = this.casDirectory(principalId, episodeId);
    if (!this.preparedCasDirectories.has(directory)) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      this.preparedCasDirectories.add(directory);
    }
    return directory;
  }

  private async writeCasObject(
    principalId: string,
    episodeId: string,
    value: unknown,
  ): Promise<string> {
    const hash = hashArcValue(value);
    if (!CAS_HASH.test(hash)) throw new Error('checkpoint object hash is invalid');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('checkpoint object is not JSON serializable');
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CAS_OBJECT_BYTES) {
      throw new Error('checkpoint object exceeds durable size limit');
    }
    const directory = await this.ensureCasDirectory(principalId, episodeId);
    const target = join(directory, `${hash}.json`);
    const reuseExisting = async (): Promise<string> => {
      const info = await stat(target).catch(() => undefined);
      if (!info?.isFile() || info.size > MAX_CAS_OBJECT_BYTES) {
        throw new Error('checkpoint object is unavailable');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(target, 'utf8'));
      } catch {
        throw new Error('checkpoint object is unavailable');
      }
      if (hashArcValue(parsed) !== hash) {
        throw new Error('checkpoint object failed integrity validation');
      }
      return hash;
    };
    const existing = await stat(target).catch(() => undefined);
    if (existing) return reuseExisting();
    const temporary = join(directory, `.${hash}.tmp-${randomBytes(8).toString('hex')}`);
    await writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EPERM') return reuseExisting();
      throw error;
    }
    return hash;
  }

  private async writeCasObjects(
    principalId: string,
    episodeId: string,
    values: readonly unknown[],
  ): Promise<string[]> {
    await this.ensureCasDirectory(principalId, episodeId);
    const hashes: string[] = [];
    for (let index = 0; index < values.length; index += CAS_IO_CONCURRENCY) {
      hashes.push(...await Promise.all(
        values.slice(index, index + CAS_IO_CONCURRENCY).map(value => (
          this.writeCasObject(principalId, episodeId, value)
        )),
      ));
    }
    return hashes;
  }

  private async loadCasObject<T>(
    principalId: string,
    episodeId: string,
    hash: string,
  ): Promise<T> {
    if (!CAS_HASH.test(hash)) throw new Error('checkpoint object is unavailable');
    const target = join(this.casDirectory(principalId, episodeId), `${hash}.json`);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_CAS_OBJECT_BYTES) {
      throw new Error('checkpoint object is unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(target, 'utf8'));
    } catch {
      throw new Error('checkpoint object is unavailable');
    }
    if (hashArcValue(parsed) !== hash) throw new Error('checkpoint object failed integrity validation');
    return parsed as T;
  }

  private async loadCasObjects<T>(
    principalId: string,
    episodeId: string,
    hashes: readonly string[],
  ): Promise<T[]> {
    const values: T[] = [];
    for (let index = 0; index < hashes.length; index += CAS_IO_CONCURRENCY) {
      values.push(...await Promise.all(
        hashes.slice(index, index + CAS_IO_CONCURRENCY).map(hash => (
          this.loadCasObject<T>(principalId, episodeId, hash)
        )),
      ));
    }
    return values;
  }

  async saveCheckpoint(record: EpisodeRecord, checkpoint: ArcCheckpoint): Promise<string> {
    if (this.closing) throw new Error('episode store is closing');
    const key = `${record.principalId}\0${record.episodeId}`;
    return this.withLock(this.checkpointLocks, key, () => (
      this.saveCheckpointLocked(record, checkpoint)
    ));
  }

  private async saveCheckpointLocked(
    record: EpisodeRecord,
    checkpoint: ArcCheckpoint,
  ): Promise<string> {
    exactPublicJson(checkpoint);
    verifyArcCheckpoint(checkpoint);
    const liveStatus = record.controller.status();
    if (
      checkpoint.runId !== liveStatus.runId
      || checkpoint.principalScope !== liveStatus.principalScope
      || checkpoint.opaqueGameScope !== liveStatus.opaqueGameScope
    ) {
      throw new Error('checkpoint does not belong to this episode');
    }
    if (!Number.isSafeInteger(checkpoint.budget.maxActions) || checkpoint.budget.maxActions <= 0) {
      throw new Error('checkpoint action budget is invalid');
    }
    const maximumObjects = checkpoint.budget.maxActions * MAX_CAS_OBJECTS_PER_ACTION
      + MAX_ARC_ANIMATION_FRAMES;
    if (
      checkpoint.receipts.length > checkpoint.budget.maxActions
      || checkpoint.receipts.length + checkpoint.frameBlobs.length > maximumObjects
    ) {
      throw new Error('checkpoint object count exceeds its action budget');
    }
    const checkpointId = publicHandle('checkpoint');
    const directory = join(this.checkpointDirectory(record.principalId, record.episodeId), 'checkpoints');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const existing = (await readdir(directory)).filter((name) => {
      const checkpointName = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
      return CHECKPOINT_ID.test(checkpointName);
    });
    if (existing.length >= MAX_CHECKPOINTS_PER_EPISODE) {
      throw new Error('durable checkpoint limit reached');
    }
    const receiptObjectHashes = await this.writeCasObjects(
      record.principalId,
      record.episodeId,
      checkpoint.receipts,
    );
    const frameObjectHashes = await this.writeCasObjects(
      record.principalId,
      record.episodeId,
      checkpoint.frameBlobs,
    );
    const { receipts: _receipts, frameBlobs: _frameBlobs, ...remainder } = checkpoint;
    const body: PersistedCheckpoint = {
      schema: 'metaharness.arc_mcp.checkpoint_ref.v2',
      episodeId: record.episodeId,
      checkpointId,
      checkpoint: remainder,
      receiptObjectHashes,
      frameObjectHashes,
    };
    const encoded = JSON.stringify(body);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CHECKPOINT_DESCRIPTOR_BYTES) {
      throw new Error('checkpoint descriptor exceeds durable size limit');
    }
    const target = this.checkpointPath(record.principalId, record.episodeId, checkpointId);
    const temporary = `${target}.tmp-${randomBytes(8).toString('hex')}`;
    await writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    return checkpointId;
  }

  async saveAvoCheckpoint(
    record: EpisodeRecord,
    checkpoint: ArcAvoCheckpoint,
  ): Promise<string> {
    if (this.closing) throw new Error('episode store is closing');
    if (!this.avoConfig || !record.avoLoop) {
      throw new Error('AVO checkpoint persistence is unavailable outside AVO mode');
    }
    const key = `${record.principalId}\0${record.episodeId}`;
    return this.withLock(this.checkpointLocks, key, async () => {
      const stable = validatedAvoCheckpoint(checkpoint, this.avoConfig!);
      const core = stable.coreCheckpoint;
      const liveStatus = record.controller.status();
      if (
        core.runId !== liveStatus.runId
        || core.principalScope !== liveStatus.principalScope
        || core.opaqueGameScope !== liveStatus.opaqueGameScope
      ) {
        throw new Error('AVO checkpoint does not belong to this episode');
      }
      if (!Number.isSafeInteger(core.budget.maxActions) || core.budget.maxActions <= 0) {
        throw new Error('checkpoint action budget is invalid');
      }
      const maximumObjects = core.budget.maxActions * MAX_AVO_CAS_OBJECTS_PER_ACTION
        + MAX_ARC_ANIMATION_FRAMES;
      const archiveObjectCount = stable.archive.candidates.length
        + stable.archive.selections.length
        + stable.archive.outcomes.length
        + stable.worldModel.records.length;
      if (
        core.receipts.length > core.budget.maxActions ||
        stable.archive.candidates.length
          > core.budget.maxActions * stable.config.maxCandidatesPerDecision ||
        stable.archive.selections.length > core.budget.maxActions ||
        stable.archive.outcomes.length > core.budget.maxActions ||
        stable.worldModel.records.length > core.budget.maxActions ||
        core.receipts.length + core.frameBlobs.length + archiveObjectCount > maximumObjects
      ) {
        throw new Error('checkpoint object count exceeds its action budget');
      }
      const checkpointId = publicHandle('checkpoint');
      const directory = join(
        this.checkpointDirectory(record.principalId, record.episodeId),
        'checkpoints',
      );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const existing = (await readdir(directory)).filter((name) => {
        const checkpointName = name.endsWith('.json')
          ? name.slice(0, -'.json'.length)
          : '';
        return CHECKPOINT_ID.test(checkpointName);
      });
      if (existing.length >= MAX_CHECKPOINTS_PER_EPISODE) {
        throw new Error('durable checkpoint limit reached');
      }
      const receiptObjectHashes = await this.writeCasObjects(
        record.principalId,
        record.episodeId,
        core.receipts,
      );
      const frameObjectHashes = await this.writeCasObjects(
        record.principalId,
        record.episodeId,
        core.frameBlobs,
      );
      const candidateObjectHashes = await this.writeCasObjects(
        record.principalId,
        record.episodeId,
        stable.archive.candidates,
      );
      const selectionObjectHashes = await this.writeCasObjects(
        record.principalId,
        record.episodeId,
        stable.archive.selections,
      );
      const outcomeObjectHashes = await this.writeCasObjects(
        record.principalId,
        record.episodeId,
        stable.archive.outcomes,
      );
      const retrodictionObjectHashes = await this.writeCasObjects(
        record.principalId,
        record.episodeId,
        stable.worldModel.records,
      );
      const { receipts: _receipts, frameBlobs: _frameBlobs, ...coreRemainder } = core;
      const {
        candidates: _candidates,
        selections: _selections,
        outcomes: _outcomes,
        ...archiveRemainder
      } = stable.archive;
      const { records: _records, ...worldModelRemainder } = stable.worldModel;
      const {
        coreCheckpoint: _coreCheckpoint,
        archive: _archive,
        worldModel: _worldModel,
        ...avoRemainder
      } = stable;
      const body: PersistedAvoCheckpoint = {
        schema: 'metaharness.arc_mcp.avo_checkpoint_ref.v2',
        episodeId: record.episodeId,
        checkpointId,
        checkpoint: {
          ...avoRemainder,
          coreCheckpoint: coreRemainder,
          archive: archiveRemainder,
          worldModel: worldModelRemainder,
        },
        receiptObjectHashes,
        frameObjectHashes,
        candidateObjectHashes,
        selectionObjectHashes,
        outcomeObjectHashes,
        retrodictionObjectHashes,
      };
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_CHECKPOINT_DESCRIPTOR_BYTES) {
        throw new Error('checkpoint descriptor exceeds durable size limit');
      }
      const target = this.checkpointPath(record.principalId, record.episodeId, checkpointId);
      const temporary = `${target}.tmp-${randomBytes(8).toString('hex')}`;
      await writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      return checkpointId;
    });
  }

  async getCheckpoint(record: EpisodeRecord, checkpointId: string): Promise<ArcCheckpoint> {
    const checkpoint = record.checkpoints.get(checkpointId);
    if (checkpoint) return checkpoint;
    return this.loadCheckpoint(record.principalId, record.episodeId, checkpointId);
  }

  async loadCheckpoint(
    principalId: string,
    episodeId: string,
    checkpointId: string,
  ): Promise<ArcCheckpoint> {
    const path = this.checkpointPath(principalId, episodeId, checkpointId);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_CHECKPOINT_DESCRIPTOR_BYTES) {
      throw new Error('checkpoint is unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('checkpoint is unavailable');
    }
    const stored = parsed as Partial<PersistedCheckpoint>;
    if (
      stored.schema !== 'metaharness.arc_mcp.checkpoint_ref.v2' ||
      stored.episodeId !== episodeId ||
      stored.checkpointId !== checkpointId ||
      !stored.checkpoint || typeof stored.checkpoint !== 'object' ||
      !Array.isArray(stored.receiptObjectHashes) ||
      !Array.isArray(stored.frameObjectHashes)
    ) {
      throw new Error('checkpoint is unavailable');
    }
    let budget;
    try {
      budget = validateArcRunBudget(
        (stored.checkpoint as Partial<CheckpointRemainder>).budget,
      );
    } catch {
      throw new Error('checkpoint is unavailable');
    }
    const maximumObjects = budget.maxActions * MAX_CAS_OBJECTS_PER_ACTION
      + MAX_ARC_ANIMATION_FRAMES;
    if (
      stored.receiptObjectHashes.length > budget.maxActions
      || stored.receiptObjectHashes.length + stored.frameObjectHashes.length > maximumObjects
      || stored.receiptObjectHashes.some(hash => typeof hash !== 'string' || !CAS_HASH.test(hash))
      || stored.frameObjectHashes.some(hash => typeof hash !== 'string' || !CAS_HASH.test(hash))
      || new Set(stored.receiptObjectHashes).size !== stored.receiptObjectHashes.length
      || new Set(stored.frameObjectHashes).size !== stored.frameObjectHashes.length
    ) {
      throw new Error('checkpoint is unavailable');
    }
    const receipts = await this.loadCasObjects<CheckpointTransitionReceipt>(
      principalId,
      episodeId,
      stored.receiptObjectHashes,
    );
    const frameBlobs = await this.loadCasObjects<CheckpointFrameBlob>(
      principalId,
      episodeId,
      stored.frameObjectHashes,
    );
    const checkpoint = {
      ...stored.checkpoint,
      receipts,
      frameBlobs,
    } as ArcCheckpoint;
    exactPublicJson(checkpoint);
    try {
      verifyArcCheckpoint(checkpoint);
    } catch {
      throw new Error('checkpoint failed integrity validation');
    }
    return checkpoint;
  }

  async getAvoCheckpoint(
    record: EpisodeRecord,
    checkpointId: string,
  ): Promise<ArcAvoCheckpoint> {
    return this.loadAvoCheckpoint(record.principalId, record.episodeId, checkpointId);
  }

  async loadAvoCheckpoint(
    principalId: string,
    episodeId: string,
    checkpointId: string,
  ): Promise<ArcAvoCheckpoint> {
    if (!this.avoConfig) throw new Error('AVO checkpoint is unavailable outside AVO mode');
    const path = this.checkpointPath(principalId, episodeId, checkpointId);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_CHECKPOINT_DESCRIPTOR_BYTES) {
      throw new Error('checkpoint is unavailable');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('checkpoint is unavailable');
    }
    const stored = parsed as Partial<PersistedAvoCheckpoint>;
    if (
      stored.schema !== 'metaharness.arc_mcp.avo_checkpoint_ref.v2' ||
      stored.episodeId !== episodeId ||
      stored.checkpointId !== checkpointId ||
      !stored.checkpoint || typeof stored.checkpoint !== 'object' ||
      !stored.checkpoint.coreCheckpoint ||
      typeof stored.checkpoint.coreCheckpoint !== 'object' ||
      !stored.checkpoint.archive || typeof stored.checkpoint.archive !== 'object' ||
      !stored.checkpoint.worldModel || typeof stored.checkpoint.worldModel !== 'object'
    ) {
      throw new Error('checkpoint is unavailable');
    }
    let budget;
    try {
      budget = validateArcRunBudget(stored.checkpoint.coreCheckpoint.budget);
    } catch {
      throw new Error('checkpoint is unavailable');
    }
    const maximumObjects = budget.maxActions * MAX_AVO_CAS_OBJECTS_PER_ACTION
      + MAX_ARC_ANIMATION_FRAMES;
    const maxCandidates = budget.maxActions * this.avoConfig.maxCandidatesPerDecision;
    if (
      !validCasHashArray(stored.receiptObjectHashes, budget.maxActions) ||
      !validCasHashArray(
        stored.frameObjectHashes,
        budget.maxActions * MAX_ARC_ANIMATION_FRAMES + MAX_ARC_ANIMATION_FRAMES,
      ) ||
      !validCasHashArray(stored.candidateObjectHashes, maxCandidates) ||
      !validCasHashArray(stored.selectionObjectHashes, budget.maxActions) ||
      !validCasHashArray(stored.outcomeObjectHashes, budget.maxActions) ||
      !validCasHashArray(stored.retrodictionObjectHashes, budget.maxActions) ||
      stored.receiptObjectHashes.length
        + stored.frameObjectHashes.length
        + stored.candidateObjectHashes.length
        + stored.selectionObjectHashes.length
        + stored.outcomeObjectHashes.length
        + stored.retrodictionObjectHashes.length > maximumObjects
    ) {
      throw new Error('checkpoint is unavailable');
    }
    const receipts = await this.loadCasObjects<CheckpointTransitionReceipt>(
      principalId,
      episodeId,
      stored.receiptObjectHashes,
    );
    const frameBlobs = await this.loadCasObjects<CheckpointFrameBlob>(
      principalId,
      episodeId,
      stored.frameObjectHashes,
    );
    const candidates = await this.loadCasObjects<ArcCandidatePlan>(
      principalId,
      episodeId,
      stored.candidateObjectHashes,
    );
    const selections = await this.loadCasObjects<ArcPlanSelection>(
      principalId,
      episodeId,
      stored.selectionObjectHashes,
    );
    const outcomes = await this.loadCasObjects<ArcPlanOutcome>(
      principalId,
      episodeId,
      stored.outcomeObjectHashes,
    );
    const retrodictions = await this.loadCasObjects<ArcRetrodiction>(
      principalId,
      episodeId,
      stored.retrodictionObjectHashes,
    );
    const checkpoint = {
      ...stored.checkpoint,
      coreCheckpoint: {
        ...stored.checkpoint.coreCheckpoint,
        receipts,
        frameBlobs,
      },
      archive: {
        ...stored.checkpoint.archive,
        candidates,
        selections,
        outcomes,
      },
      worldModel: {
        ...stored.checkpoint.worldModel,
        records: retrodictions,
      },
    } as ArcAvoCheckpoint;
    try {
      return validatedAvoCheckpoint(checkpoint, this.avoConfig);
    } catch {
      throw new Error('checkpoint failed integrity validation');
    }
  }

  async resumePersisted(
    principalId: string,
    episodeId: string,
    checkpointId: string,
    expectedCheckpointHash: string,
  ): Promise<{ record: EpisodeRecord; observation: ExactArcObservation }> {
    if (this.closing) throw new Error('episode store is closing');
    if (this.avoConfig) {
      return this.resumeAvoPersisted(
        principalId,
        episodeId,
        checkpointId,
        expectedCheckpointHash,
      );
    }
    if (this.factory.supportsResume === false) {
      throw new Error('checkpoint live resume is unavailable for this environment adapter');
    }
    const resumeKey = `${principalId}\0${episodeId}`;
    return this.withLock(this.resumeLocks, resumeKey, async () => {
      if (this.closing) throw new Error('episode store is closing');
      const live = this.principals.get(principalId)?.get(episodeId);
      if (live) {
        if (isMatchingRestoredCheckpoint(live, checkpointId, expectedCheckpointHash)) {
          return { record: live, observation: live.lastObservation };
        }
        const checkpoint = await this.getCheckpoint(live, checkpointId);
        if (checkpoint.checkpointHash !== expectedCheckpointHash) {
          throw new Error('checkpoint does not match the externally anchored hash');
        }
        if (checkpoint.environmentCheckpoint === undefined) {
          throw new Error('checkpoint does not contain resumable environment state');
        }
        let replacement: ArcController | undefined;
        let observation: ExactArcObservation;
        try {
          replacement = await this.factory({ principalId, episodeId, runId: episodeId });
          observation = await replacement.resume(checkpoint);
          exactPublicJson(observation);
        } catch {
          if (replacement) await this.closeController(replacement);
          throw new Error('checkpoint resume failed');
        }
        const record: EpisodeRecord = {
          episodeId,
          principalId,
          controller: replacement,
          createdAt: this.now().toISOString(),
          lastObservation: observation,
          checkpoints: new Map(),
          lastRestoredCheckpointId: checkpointId,
          lastRestoredCheckpointHash: checkpoint.checkpointHash,
          lastDirective: activeDirectiveFromCheckpoint(checkpoint),
        };
        this.retiredControllers.add(live.controller);
        let closeFailure: unknown;
        try {
          await this.closeController(live.controller);
          this.retiredControllers.delete(live.controller);
        } catch (error) {
          closeFailure = error;
        }
        // The fresh controller is already resumed. Install it exactly once even
        // when cleanup of the prior controller reports a failure; the retained
        // idempotency error prevents a retry from creating another controller.
        this.principals.get(principalId)!.set(episodeId, record);
        if (closeFailure) {
          throw new NonRetryableMutationError('checkpoint resumed but prior controller cleanup failed');
        }
        return { record, observation };
      }
      return this.withLock(this.createLocks, principalId, async () => {
        if (this.closing) throw new Error('episode store is closing');
        const nowLive = this.principals.get(principalId)?.get(episodeId);
        if (nowLive) {
          if (isMatchingRestoredCheckpoint(nowLive, checkpointId, expectedCheckpointHash)) {
            return { record: nowLive, observation: nowLive.lastObservation };
          }
          throw new Error('checkpoint resume conflicted with a live episode');
        }
        if ((this.principals.get(principalId)?.size ?? 0) >= this.maxEpisodesPerPrincipal) {
          throw new Error('episode limit reached');
        }
        const checkpoint = await this.loadCheckpoint(principalId, episodeId, checkpointId);
        if (checkpoint.checkpointHash !== expectedCheckpointHash) {
          throw new Error('checkpoint does not match the externally anchored hash');
        }
        if (checkpoint.environmentCheckpoint === undefined) {
          throw new Error('checkpoint does not contain resumable environment state');
        }
        let controller: ArcController | undefined;
        try {
          controller = await this.factory({ principalId, episodeId, runId: episodeId });
          const observation = await controller.resume(checkpoint);
          exactPublicJson(observation);
          let episodes = this.principals.get(principalId);
          if (!episodes) {
            episodes = new Map();
            this.principals.set(principalId, episodes);
          }
          const record: EpisodeRecord = {
            episodeId,
            principalId,
            controller,
            createdAt: this.now().toISOString(),
            lastObservation: observation,
            checkpoints: new Map(),
            lastRestoredCheckpointId: checkpointId,
            lastRestoredCheckpointHash: checkpoint.checkpointHash,
          };
          record.lastDirective = activeDirectiveFromCheckpoint(checkpoint);
          episodes.set(episodeId, record);
          return { record, observation };
        } catch {
          if (controller) await this.closeController(controller);
          throw new Error('checkpoint resume failed');
        }
      });
    });
  }

  private async resumeAvoPersisted(
    principalId: string,
    episodeId: string,
    checkpointId: string,
    expectedCheckpointHash: string,
  ): Promise<{ record: EpisodeRecord; observation: ExactArcObservation }> {
    if (!this.avoConfig) throw new Error('AVO resume is unavailable outside AVO mode');
    if (this.factory.supportsResume === false) {
      throw new Error('checkpoint live resume is unavailable for this environment adapter');
    }
    const restore = async (checkpoint: ArcAvoCheckpoint): Promise<{
      controller: ArcController;
      avoLoop: ArcAvoLoopApi;
      observation: ExactArcObservation;
    }> => {
      let controller: ArcController | undefined;
      let avoLoop: ArcAvoLoopApi | undefined;
      try {
        controller = await this.factory({
          principalId,
          episodeId,
          runId: episodeId,
          requestedSupervisionGate: this.avoConfig!.features.supervisorGate,
        });
        avoLoop = createArcAvoLoop({ controller, config: this.avoConfig! });
        const observation = (await avoLoop.resume(checkpoint)).observation;
        exactPublicJson(observation);
        return { controller, avoLoop, observation };
      } catch {
        await Promise.resolve(avoLoop?.close()).catch(() => undefined);
        if (controller) await this.closeController(controller).catch(() => undefined);
        throw new Error('checkpoint resume failed');
      }
    };
    const closeRecord = async (record: EpisodeRecord): Promise<void> => {
      const failures: unknown[] = [];
      try {
        await record.avoLoop?.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.closeController(record.controller);
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw new AggregateError(failures, 'AVO episode cleanup failed');
    };
    const resumeKey = `${principalId}\0${episodeId}`;
    return this.withLock(this.resumeLocks, resumeKey, async () => {
      if (this.closing) throw new Error('episode store is closing');
      const live = this.principals.get(principalId)?.get(episodeId);
      if (live) {
        if (isMatchingRestoredCheckpoint(live, checkpointId, expectedCheckpointHash)) {
          return { record: live, observation: live.lastObservation };
        }
        const checkpoint = await this.getAvoCheckpoint(live, checkpointId);
        if (checkpoint.checkpointHash !== expectedCheckpointHash) {
          throw new Error('checkpoint does not match the externally anchored hash');
        }
        if (checkpoint.coreCheckpoint.environmentCheckpoint === undefined) {
          throw new Error('checkpoint does not contain resumable environment state');
        }
        const restored = await restore(checkpoint);
        const record: EpisodeRecord = {
          episodeId,
          principalId,
          controller: restored.controller,
          avoLoop: restored.avoLoop,
          createdAt: this.now().toISOString(),
          lastObservation: restored.observation,
          checkpoints: new Map(),
          lastRestoredCheckpointId: checkpointId,
          lastRestoredCheckpointHash: checkpoint.checkpointHash,
          lastDirective: activeDirectiveFromCheckpoint(checkpoint.coreCheckpoint),
        };
        this.retiredControllers.add(live.controller);
        let closeFailure: unknown;
        try {
          await closeRecord(live);
          this.retiredControllers.delete(live.controller);
        } catch (error) {
          closeFailure = error;
        }
        this.principals.get(principalId)!.set(episodeId, record);
        if (closeFailure) {
          throw new NonRetryableMutationError(
            'checkpoint resumed but prior AVO controller cleanup failed',
          );
        }
        return { record, observation: restored.observation };
      }
      return this.withLock(this.createLocks, principalId, async () => {
        if (this.closing) throw new Error('episode store is closing');
        const nowLive = this.principals.get(principalId)?.get(episodeId);
        if (nowLive) {
          if (isMatchingRestoredCheckpoint(nowLive, checkpointId, expectedCheckpointHash)) {
            return { record: nowLive, observation: nowLive.lastObservation };
          }
          throw new Error('checkpoint resume conflicted with a live episode');
        }
        if ((this.principals.get(principalId)?.size ?? 0) >= this.maxEpisodesPerPrincipal) {
          throw new Error('episode limit reached');
        }
        const checkpoint = await this.loadAvoCheckpoint(principalId, episodeId, checkpointId);
        if (checkpoint.checkpointHash !== expectedCheckpointHash) {
          throw new Error('checkpoint does not match the externally anchored hash');
        }
        if (checkpoint.coreCheckpoint.environmentCheckpoint === undefined) {
          throw new Error('checkpoint does not contain resumable environment state');
        }
        const restored = await restore(checkpoint);
        let episodes = this.principals.get(principalId);
        if (!episodes) {
          episodes = new Map();
          this.principals.set(principalId, episodes);
        }
        const record: EpisodeRecord = {
          episodeId,
          principalId,
          controller: restored.controller,
          avoLoop: restored.avoLoop,
          createdAt: this.now().toISOString(),
          lastObservation: restored.observation,
          checkpoints: new Map(),
          lastRestoredCheckpointId: checkpointId,
          lastRestoredCheckpointHash: checkpoint.checkpointHash,
          lastDirective: activeDirectiveFromCheckpoint(checkpoint.coreCheckpoint),
        };
        episodes.set(episodeId, record);
        return { record, observation: restored.observation };
      });
    });
  }

  async saveBossDirective(
    record: EpisodeRecord,
    directive: SupervisorDirective,
    idempotencyKey?: string,
  ): Promise<SupervisorDirective> {
    exactPublicJson(directive);
    const encoded = JSON.stringify(directive);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_DIRECTIVE_BYTES) {
      throw new Error('supervisor directive exceeds durable size limit');
    }
    if (idempotencyKey !== undefined) {
      await unlink(this.pendingDirectivePath(record, idempotencyKey)).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    record.lastDirective = directive;
    return directive;
  }

  private pendingDirectivePath(record: EpisodeRecord, idempotencyKey: string): string {
    const keyHash = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
    return join(
      this.checkpointDirectory(record.principalId, record.episodeId),
      `pending-directive-${keyHash}.json`,
    );
  }

  async prepareBossDirective(
    record: EpisodeRecord,
    idempotencyKey: string,
    input: unknown,
  ): Promise<void> {
    exactPublicJson(input);
    const directory = this.checkpointDirectory(record.principalId, record.episodeId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const target = this.pendingDirectivePath(record, idempotencyKey);
    const encoded = JSON.stringify({
      schema: 'metaharness.arc_mcp.directive_intent.v1',
      episodeId: record.episodeId,
      input,
    });
    if (Buffer.byteLength(encoded, 'utf8') > MAX_DIRECTIVE_BYTES) {
      throw new Error('supervisor directive intent exceeds durable size limit');
    }
    const prior = await readFile(target, 'utf8').catch(() => undefined);
    if (prior !== undefined) {
      if (inputHash(JSON.parse(prior)) !== inputHash(JSON.parse(encoded))) {
        throw new Error('directive idempotency intent conflicts with durable input');
      }
      return;
    }
    const temporary = `${target}.tmp-${randomBytes(8).toString('hex')}`;
    await writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  }

  async discardBossDirectiveIntent(record: EpisodeRecord, idempotencyKey: string): Promise<void> {
    await unlink(this.pendingDirectivePath(record, idempotencyKey)).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }

  /** Runtime capability attenuation for the boss MCP lane. */
  supervisorAuthority(record: EpisodeRecord): ArcSupervisorAuthority {
    const controller = record.avoLoop?.asSupervisor() ?? record.controller;
    return Object.freeze({
      supervisorCaseBundle: controller.supervisorCaseBundle.bind(controller),
      openSupervisorCase: controller.openSupervisorCase.bind(controller),
      commitSupervisorDirective: controller.commitSupervisorDirective.bind(controller),
      queryMemory: controller.queryMemory.bind(controller),
      graphFrontier: controller.graphFrontier.bind(controller),
      status: controller.status.bind(controller),
    });
  }

  private async closeController(controller: ArcController): Promise<void> {
    const existing = this.controllerClosePromises.get(controller);
    if (existing) return existing;
    const promise = Promise.resolve().then(async () => {
      await (controller as ClosableArcController).close?.();
    });
    this.controllerClosePromises.set(controller, promise);
    try {
      await promise;
    } catch (error) {
      this.controllerClosePromises.delete(controller);
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([
      ...this.createLocks.values(),
      ...this.resumeLocks.values(),
      ...this.checkpointLocks.values(),
    ]);
    while (this.activeIdempotentBodies.size > 0) {
      await Promise.allSettled([...this.activeIdempotentBodies]);
    }
    // The official AVO factory must snapshot the store-owned loop while its
    // controller is still open. The snapshot proves archive/outcome coverage
    // of the final authoritative receipt chain.
    const avoAttestationResults = await Promise.allSettled([
      captureOfficialAvoRuntime(this.factory),
    ]);
    const records = [...this.principals.values()].flatMap((episodes) => [...episodes.values()]);
    const loopResults = await Promise.allSettled(
      records.flatMap((record) => record.avoLoop ? [record.avoLoop.close()] : []),
    );
    const controllers = [...new Set([
      ...records.map((record) => record.controller),
      ...this.retiredControllers,
    ])];
    const controllerResults = await Promise.allSettled(
      controllers.map((controller) => this.closeController(controller)),
    );
    if (!this.factoryClosePromise) {
      this.factoryClosePromise = Promise.resolve().then(async () => this.factory.close?.());
    }
    const factoryResults = await Promise.allSettled([this.factoryClosePromise]);
    const failures = [
      ...avoAttestationResults,
      ...loopResults,
      ...controllerResults,
      ...factoryResults,
    ]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `failed to close ${failures.length} ARC controller or factory resource(s)`,
      );
    }
    this.principals.clear();
    this.retiredControllers.clear();
    this.idempotency.clear();
  }

  /** Exposed for deterministic tests and operator observability, not as an MCP tool. */
  sizeForPrincipal(principalId: string): number {
    return this.principals.get(principalId)?.size ?? 0;
  }
}

export function createEpisodeIdForTest(): string {
  return `episode_${randomUUID().replaceAll('-', '')}`;
}
