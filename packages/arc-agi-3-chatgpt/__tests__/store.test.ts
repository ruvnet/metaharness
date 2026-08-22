// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createArcCheckpoint,
  createArcController,
  exactFrameFromRaw,
  hashArcValue,
} from '@metaharness/arc-agi-3';
import type { ArcEnvironment, RawArcObservation } from '@metaharness/arc-agi-3';
import { opaqueAuditHash } from '../src/audit.js';
import { ArcEpisodeStore } from '../src/store.js';
import type { ArcControllerFactory } from '../src/types.js';
import { createFactoryFixture, HASH, TestEnvironment } from './helpers.js';

async function temporaryStateRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'arc-chatgpt-store-'));
}

function controllerFor(
  environment: ArcEnvironment,
  principalId: string,
  runId: string,
  sessionLog?: NonNullable<Parameters<typeof createArcController>[0]['sessionLog']>,
) {
  return createArcController({
    principalId,
    runId,
    gameVersionHash: '9'.repeat(64),
    environment,
    runManifest: {
      visibleModelLabel: 'ChatGPT resume test',
      promptSnapshotHash: HASH,
      toolSchemaHash: HASH,
      environmentAdapterVersion: '@metaharness/arc-agi-3/test@0.1.0',
    },
    budget: { maxActions: 100, maxWallTimeMs: 3_600_000 },
    ...(sessionLog ? { sessionLog } : {}),
  });
}

describe('ArcEpisodeStore isolation and lifecycle', () => {
  it('isolates principals and exposes a frozen boss authority without action methods', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    try {
      const { record } = await store.create('principal-one');
      expect(() => store.get('principal-two', record.episodeId)).toThrow(/unavailable/);
      const authority = store.supervisorAuthority(record) as unknown as Record<string, unknown>;
      expect(Object.isFrozen(authority)).toBe(true);
      expect(authority).not.toHaveProperty('act');
      expect(authority).not.toHaveProperty('start');
      expect(authority).not.toHaveProperty('resume');
      expect(authority).not.toHaveProperty('executeGuardedPlan');
      expect(fixture.environments[0]?.stepCalls).toBe(0);
    } finally {
      await store.closeAll();
      await store.closeAll();
      expect(fixture.environments[0]?.closeCalls).toBe(1);
      expect(fixture.factoryCloseCalls).toBe(1);
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('serializes concurrent creates so the per-principal cap cannot be bypassed', async () => {
    const stateRoot = await temporaryStateRoot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = createFactoryFixture({ delay: gate });
    const store = new ArcEpisodeStore(fixture.factory, stateRoot, () => new Date(), 32);
    const creates = Array.from({ length: 64 }, () => store.create('one-principal'));
    release();
    const results = await Promise.allSettled(creates);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(32);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(32);
    expect(fixture.calls).toBe(32);
    expect(store.sizeForPrincipal('one-principal')).toBe(32);
    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('retains more than 2,048 principal-scoped idempotency records', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    for (let index = 0; index < 3_000; index += 1) {
      const result = await store.runIdempotent({
        principalId: 'long-run',
        tool: 'arc_act',
        key: `unique-key-${index}`,
        input: { index },
        body: async () => index,
      });
      expect(result.value).toBe(index);
    }
    await expect(store.runIdempotent({
      principalId: 'long-run',
      tool: 'arc_act',
      key: 'unique-key-2999',
      input: { index: -1 },
      body: async () => -1,
    })).rejects.toThrow(/different input/);
    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('waits for active idempotent persistence bodies before shutdown completes', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const operation = store.runIdempotent({
      principalId: 'shutdown-principal',
      tool: 'arc_checkpoint',
      key: 'shutdown-checkpoint-body',
      input: { checkpoint: 1 },
      body: async () => {
        markStarted();
        await gate;
        return 'persisted';
      },
    });
    await started;
    const closing = store.closeAll();
    await Promise.resolve();
    expect(fixture.factoryCloseCalls).toBe(0);

    release();
    await expect(operation).resolves.toEqual({ value: 'persisted', replayed: false });
    await closing;
    expect(fixture.factoryCloseCalls).toBe(1);
    await expect(store.runIdempotent({
      principalId: 'shutdown-principal',
      tool: 'arc_checkpoint',
      key: 'shutdown-after-close',
      input: {},
      body: async () => 'unexpected',
    })).rejects.toThrow('episode store is closing');
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('resumes a live episode into one fresh controller and coalesces concurrent repeats', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    const created = await store.create('resume-principal');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    const oldController = created.record.controller;
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      store.resumePersisted(
        'resume-principal',
        created.record.episodeId,
        checkpointId,
        checkpoint.checkpointHash,
      )));
    expect(results).toHaveLength(12);
    expect(fixture.calls).toBe(2);
    expect(store.get('resume-principal', created.record.episodeId).controller).not.toBe(oldController);
    expect(fixture.environments[0]?.closeCalls).toBe(1);
    await store.closeAll();
    expect(fixture.environments[1]?.closeCalls).toBe(1);
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('installs one faulted replacement when the resume completion log fails', async () => {
    const stateRoot = await temporaryStateRoot();
    const environments: TestEnvironment[] = [];
    let calls = 0;
    class CountingResumeEnvironment extends TestEnvironment {
      resumeCalls = 0;

      override async resume(checkpoint: { value?: number; stepCalls?: number }) {
        this.resumeCalls += 1;
        return super.resume(checkpoint);
      }
    }
    const resumedEnvironment = new CountingResumeEnvironment();
    const factory = (async ({ principalId, runId }) => {
      calls += 1;
      const environment = calls === 1 ? new TestEnvironment() : resumedEnvironment;
      environments.push(environment);
      const sessionLog = calls === 2 ? {
        async append(kind: string): Promise<void> {
          if (kind === 'arc.resume') throw new Error('anchor unavailable');
        },
        stateHash(): string { return HASH; },
      } : undefined;
      return controllerFor(environment, principalId, runId, sessionLog);
    }) as ArcControllerFactory;
    const store = new ArcEpisodeStore(factory, stateRoot);
    const created = await store.create('resume-log-failure');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);

    const results = await Promise.all(Array.from({ length: 12 }, () =>
      store.resumePersisted(
        'resume-log-failure',
        created.record.episodeId,
        checkpointId,
        checkpoint.checkpointHash,
      )));
    const installed = store.get('resume-log-failure', created.record.episodeId);
    expect(results).toHaveLength(12);
    expect(calls).toBe(2);
    expect(resumedEnvironment.resumeCalls).toBe(1);
    expect(installed.controller).not.toBe(created.record.controller);
    expect(installed.controller.status()).toMatchObject({
      phase: 'FAULTED',
      stopped: true,
      uncertainMutationCount: 1,
      lastError: 'SESSION_LOG_COMPLETION_FAILED',
    });
    expect(results.every(result => result.record.controller === installed.controller)).toBe(true);
    expect(environments[0]?.closeCalls).toBe(1);
    await store.closeAll();
    expect(resumedEnvironment.closeCalls).toBe(1);
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('releases an unpublished start even when controller close also fails', async () => {
    const stateRoot = await temporaryStateRoot();
    let reserved = false;
    let factoryCalls = 0;
    let releaseCalls = 0;
    const factory = (async ({ principalId, runId }) => {
      if (reserved) throw new Error('assignment remains reserved');
      reserved = true;
      factoryCalls += 1;
      const environment = new TestEnvironment();
      if (factoryCalls === 1) {
        environment.reset = async () => { throw new Error('reset failed'); };
      }
      return controllerFor(environment, principalId, runId, {
        async append(kind: string): Promise<void> {
          if (factoryCalls === 1 && kind === 'arc.close') throw new Error('close log failed');
        },
        stateHash(): string { return HASH; },
      });
    }) as ArcControllerFactory;
    factory.releaseUnpublishedEpisode = async () => {
      releaseCalls += 1;
      reserved = false;
    };
    const store = new ArcEpisodeStore(factory, stateRoot);

    await expect(store.create('unpublished-cleanup')).rejects.toThrow(/cleanup failed/);
    expect(releaseCalls).toBe(1);
    expect(reserved).toBe(false);
    const created = await store.create('unpublished-cleanup');
    expect(created.observation.state).toBe('NOT_FINISHED');
    expect(factoryCalls).toBe(2);

    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('rejects resume before factory creation when the adapter disables it', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    fixture.factory.supportsResume = false;
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    const created = await store.create('nonresumable-principal');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    await expect(store.resumePersisted(
      'nonresumable-principal',
      created.record.episodeId,
      checkpointId,
      checkpoint.checkpointHash,
    )).rejects.toThrow(/resume is unavailable/);
    expect(fixture.calls).toBe(1);
    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('loads an opaque checkpoint with a new process-local store instance', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    const firstStore = new ArcEpisodeStore(fixture.factory, stateRoot);
    const created = await firstStore.create('restart-principal');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await firstStore.saveCheckpoint(created.record, checkpoint);
    const restartedStore = new ArcEpisodeStore(fixture.factory, stateRoot);
    const resumed = await restartedStore.resumePersisted(
      'restart-principal',
      created.record.episodeId,
      checkpointId,
      checkpoint.checkpointHash,
    );
    expect(resumed.observation.observationHash).toBe(created.observation.observationHash);
    expect(fixture.calls).toBe(2);
    await Promise.all([firstStore.closeAll(), restartedStore.closeAll()]);
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('keeps the live controller when a fresh controller cannot resume', async () => {
    const stateRoot = await temporaryStateRoot();
    const environments: TestEnvironment[] = [];
    let calls = 0;
    const factory = (async ({ principalId, runId }) => {
      calls += 1;
      const environment = new TestEnvironment();
      if (calls === 2) {
        environment.resume = async () => { throw new Error('resume unavailable'); };
      }
      environments.push(environment);
      return controllerFor(environment, principalId, runId);
    }) as ArcControllerFactory;
    const store = new ArcEpisodeStore(factory, stateRoot);
    const created = await store.create('resume-failure');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    await expect(store.resumePersisted(
      'resume-failure',
      created.record.episodeId,
      checkpointId,
      checkpoint.checkpointHash,
    ))
      .rejects.toThrow(/resume failed/);
    expect(store.get('resume-failure', created.record.episodeId).controller)
      .toBe(created.record.controller);
    expect(environments[0]?.closeCalls).toBe(0);
    expect(environments[1]?.closeCalls).toBe(1);
    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('installs the resumed controller but returns a nonretryable failure if old cleanup fails', async () => {
    const stateRoot = await temporaryStateRoot();
    const environments: TestEnvironment[] = [];
    let calls = 0;
    class FailingCloseEnvironment extends TestEnvironment {
      override async close(): Promise<void> {
        this.closeCalls += 1;
        throw new Error('cleanup failed');
      }
    }
    const factory = (async ({ principalId, runId }) => {
      calls += 1;
      const environment = calls === 1 ? new FailingCloseEnvironment() : new TestEnvironment();
      environments.push(environment);
      return controllerFor(environment, principalId, runId);
    }) as ArcControllerFactory;
    const store = new ArcEpisodeStore(factory, stateRoot);
    const created = await store.create('close-failure');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    await expect(store.resumePersisted(
      'close-failure',
      created.record.episodeId,
      checkpointId,
      checkpoint.checkpointHash,
    ))
      .rejects.toThrow(/cleanup failed/);
    expect(store.get('close-failure', created.record.episodeId).controller)
      .not.toBe(created.record.controller);
    expect(calls).toBe(2);
    await expect(store.closeAll()).rejects.toThrow(/failed to close/);
    expect(environments[1]?.closeCalls).toBe(1);
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('attempts every controller close and the factory close when one controller fails', async () => {
    const stateRoot = await temporaryStateRoot();
    const attempts: string[] = [];
    let created = 0;
    const base = createFactoryFixture();
    const factory = Object.assign(async (context: Parameters<typeof base.factory>[0]) => {
      const controller = await base.factory(context);
      created += 1;
      const label = `controller-${created}`;
      const originalClose = controller.close.bind(controller);
      Object.defineProperty(controller, 'close', {
        configurable: true,
        value: async () => {
          attempts.push(label);
          if (label === 'controller-1') throw new Error('first close failed');
          await originalClose();
        },
      });
      return controller;
    }, {
      close: async () => { attempts.push('factory'); },
    });
    const store = new ArcEpisodeStore(factory, stateRoot);
    await store.create('principal');
    await store.create('principal');
    await expect(store.closeAll()).rejects.toThrow(/failed to close/);
    expect(attempts).toEqual(expect.arrayContaining(['controller-1', 'controller-2', 'factory']));
    await rm(stateRoot, { recursive: true, force: true });
  });
});

describe('durable content-addressed checkpoints', () => {
  it('serializes concurrent checkpoint commits at the per-episode file cap', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture();
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    const created = await store.create('checkpoint-cap-principal');
    const checkpoint = await created.record.controller.checkpoint();

    const results = await Promise.allSettled(Array.from(
      { length: 70 },
      () => store.saveCheckpoint(created.record, checkpoint),
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(64);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(6);
    const directory = join(
      stateRoot,
      `principal_${opaqueAuditHash('checkpoint-cap-principal')}`,
      created.record.episodeId,
      'checkpoints',
    );
    expect((await readdir(directory)).filter(name => name.endsWith('.json'))).toHaveLength(64);

    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('rejects 7,000 unreferenced frame objects before durable persistence', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture({ maxActions: 7_000 });
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    const created = await store.create('frame-principal');
    const base = await created.record.controller.checkpoint();
    const frameBlobs = Array.from({ length: 7_000 }, (_, index) => {
      const digits = [
        (index >>> 12) & 15,
        (index >>> 8) & 15,
        (index >>> 4) & 15,
        index & 15,
      ];
      const frame = exactFrameFromRaw({
        width: 4,
        height: 1,
        cells: [digits],
        frameIndex: index,
      }, index);
      return { blobHash: hashArcValue(frame), frame };
    });
    const { checkpointHash: _oldHash, frameBlobs: _oldFrames, ...body } = base;
    expect(() => createArcCheckpoint({ ...body, frameBlobs })).toThrow(
      /frame blobs exceed|unreferenced frame blobs/,
    );
    await store.closeAll();
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('rejects invalid budgets and duplicate CAS lists before loading checkpoint objects', async () => {
    const stateRoot = await temporaryStateRoot();
    const fixture = createFactoryFixture({ maxActions: 7_000 });
    const store = new ArcEpisodeStore(fixture.factory, stateRoot);
    const created = await store.create('bounded-load-principal');
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    const descriptor = join(
      stateRoot,
      `principal_${opaqueAuditHash('bounded-load-principal')}`,
      created.record.episodeId,
      'checkpoints',
      `${checkpointId}.json`,
    );
    const original = JSON.parse(await readFile(descriptor, 'utf8')) as {
      checkpoint: { budget: { maxActions: number; maxWallTimeMs: number } };
      frameObjectHashes: string[];
    };
    const reloadedStore = new ArcEpisodeStore(fixture.factory, stateRoot);

    const invalidBudget = structuredClone(original);
    invalidBudget.checkpoint.budget.maxActions = 10_001;
    await writeFile(descriptor, JSON.stringify(invalidBudget), 'utf8');
    await expect(reloadedStore.loadCheckpoint(
      'bounded-load-principal',
      created.record.episodeId,
      checkpointId,
    )).rejects.toThrow('checkpoint is unavailable');

    const repeatedHashes = structuredClone(original);
    repeatedHashes.frameObjectHashes = Array.from(
      { length: 7_000 },
      () => original.frameObjectHashes[0]!,
    );
    await writeFile(descriptor, JSON.stringify(repeatedHashes), 'utf8');
    await expect(reloadedStore.loadCheckpoint(
      'bounded-load-principal',
      created.record.episodeId,
      checkpointId,
    )).rejects.toThrow('checkpoint is unavailable');

    await Promise.all([store.closeAll(), reloadedStore.closeAll()]);
    await rm(stateRoot, { recursive: true, force: true });
  });

  it('persists and reloads a real 6,624-action controller checkpoint below the 64 MiB bound', async () => {
    const stateRoot = await temporaryStateRoot();
    const repeatedObservation = (): RawArcObservation => ({
      state: 'NOT_FINISHED',
      levelsCompleted: 0,
      winLevels: 1,
      availableActions: ['ACTION1'],
      frames: [{ width: 1, height: 1, cells: [[0]] }],
    });
    const environment: ArcEnvironment = {
      reset: async () => repeatedObservation(),
      observe: async () => repeatedObservation(),
      step: async () => repeatedObservation(),
      checkpoint: async () => ({ repeated: true }),
      resume: async () => repeatedObservation(),
    };
    const factory = async ({ principalId, runId }: { principalId: string; runId: string }) =>
      createArcController({
        principalId,
        runId,
        gameVersionHash: 'f'.repeat(64),
        environment,
        runManifest: {
          visibleModelLabel: 'ChatGPT long-horizon test',
          promptSnapshotHash: HASH,
          toolSchemaHash: HASH,
          environmentAdapterVersion: '@metaharness/arc-agi-3/test@0.1.0',
        },
        budget: { maxActions: 7_000, maxWallTimeMs: 3_600_000 },
      });
    const store = new ArcEpisodeStore(factory, stateRoot);
    const created = await store.create('long-principal');
    let observation = created.observation;
    for (let index = 0; index < 6_624; index += 1) {
      const result = await created.record.controller.act({
        expectedObservationHash: observation.observationHash,
        idempotencyKey: `long-action-${index.toString().padStart(5, '0')}`,
        action: { name: 'ACTION1' },
        expectation: { confidence: 0.5, expectedState: 'NOT_FINISHED' },
      });
      observation = result.observation;
    }
    const checkpoint = await created.record.controller.checkpoint();
    const checkpointId = await store.saveCheckpoint(created.record, checkpoint);
    const descriptor = join(
      stateRoot,
      `principal_${opaqueAuditHash('long-principal')}`,
      created.record.episodeId,
      'checkpoints',
      `${checkpointId}.json`,
    );
    expect((await stat(descriptor)).size).toBeLessThanOrEqual(64 * 1024 * 1024);
    const newStore = new ArcEpisodeStore(factory, stateRoot);
    const reloaded = await newStore.loadCheckpoint('long-principal', created.record.episodeId, checkpointId);
    expect(reloaded.checkpointHash).toBe(checkpoint.checkpointHash);
    expect(reloaded.receipts).toHaveLength(6_624);
    await Promise.all([store.closeAll(), newStore.closeAll()]);
    await rm(stateRoot, { recursive: true, force: true });
  }, 180_000);
});
