// SPDX-License-Identifier: MIT

import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ArcAction,
  ArcController,
  ArcEnvironment,
  ArcRunBudget,
  ArcScorecard,
  RawArcObservation,
  ScorecardOptions,
  StartedArcEnvironment,
  StartGameOptions,
} from '@metaharness/arc-agi-3';
import { hashArcValue } from '@metaharness/arc-agi-3';
import {
  ARC_AGI_3_PUBLIC_ACCEPTANCE_GATE,
  createOfficialArcControllerFactory as createOfficialArcControllerFactoryImplementation,
  type OfficialArcBridge,
  type OfficialArcControllerFactory,
  type OfficialArcControllerFactoryOptions,
  type OfficialArcRunGate,
  type OfficialEvidenceAnchor,
  type OfficialEvidenceAnchorProof,
  type OfficialEvidenceAnchorRecord,
} from '../src/official-factory.js';
import { ArcEpisodeStore } from '../src/store.js';
import { HASH, TestEnvironment } from './helpers.js';

const MANIFEST = {
  visibleModelLabel: 'ChatGPT UI test model',
  promptSnapshotHash: HASH,
  toolSchemaHash: HASH,
  environmentAdapterVersion: 'arc-agi==0.9.8;arcengine==0.9.3;bridge=v1',
} as const;

const TEST_GATE = Object.freeze({
  expectedGames: 1,
  expectedLevels: 1,
  requiredScore: 100,
}) satisfies OfficialArcRunGate;

function createOfficialArcControllerFactory(
  options: OfficialArcControllerFactoryOptions,
): OfficialArcControllerFactory {
  return createOfficialArcControllerFactoryImplementation({
    acceptanceGate: {
      ...TEST_GATE,
      expectedGames: options.assignments.length,
    },
    ...options,
  });
}

const evidenceRoots: string[] = [];
const openFactories: OfficialArcControllerFactory[] = [];

async function temporaryEvidenceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'metaharness-arc-official-'));
  evidenceRoots.push(root);
  return root;
}

function track(factory: OfficialArcControllerFactory): OfficialArcControllerFactory {
  openFactories.push(factory);
  return factory;
}

afterEach(async () => {
  await Promise.allSettled(openFactories.splice(0).map(factory => factory.close()));
  await Promise.allSettled(evidenceRoots.splice(0).map(root =>
    rm(root, { recursive: true, force: true })));
});

function context(episodeId: string, principalId = 'operator') {
  return { principalId, episodeId, runId: episodeId };
}

function canonicalJournalValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJournalValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter(key => record[key] !== undefined).map(key => (
    `${JSON.stringify(key)}:${canonicalJournalValue(record[key])}`
  )).join(',')}}`;
}

function journalStateHash(events: readonly unknown[]): string {
  let stateHash = '';
  for (const event of events) {
    stateHash = createHash('sha256')
      .update(stateHash + canonicalJournalValue(event), 'utf8')
      .digest('hex');
  }
  return stateHash;
}

function officialScorecard(input: {
  guid: string;
  actions: number;
  resets?: number;
  score?: number;
}): ArcScorecard {
  return {
    score: input.score ?? 100,
    competition_mode: true,
    total_environments: 1,
    total_environments_completed: 1,
    total_levels: 1,
    total_levels_completed: 1,
    total_actions: input.actions,
    environments: [{
      runs: [{
        guid: input.guid,
        actions: input.actions,
        resets: input.resets ?? 0,
      }],
    }],
  };
}

class FakeOfficialBridge implements OfficialArcBridge {
  createCalls = 0;
  getCalls = 0;
  closeScorecardCalls = 0;
  disposeCalls = 0;
  failuresRemaining = 0;
  failureMessage = 'upstream start failure';
  readonly starts: StartGameOptions[] = [];
  readonly environments: TestEnvironment[] = [];
  scorecard: ArcScorecard = officialScorecard({
    guid: 'opaque-guid-1',
    actions: 0,
  });

  async createScorecard(_options: ScorecardOptions = {}): Promise<string> {
    this.createCalls += 1;
    return 'private-scorecard-id';
  }

  async startGame(options: StartGameOptions): Promise<StartedArcEnvironment> {
    this.starts.push(options);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error(this.failureMessage);
    }
    const environment = new TestEnvironment();
    this.environments.push(environment);
    const initial = await environment.reset();
    const guid = `opaque-guid-${this.environments.length}`;
    return {
      environmentId: `private-environment-${this.environments.length}`,
      environment,
      initialObservation: { ...initial, metadata: { guid } },
    };
  }

  async getScorecard(_scorecardId?: string): Promise<ArcScorecard> {
    this.getCalls += 1;
    return this.scorecard;
  }

  async closeScorecard(_scorecardId?: string): Promise<ArcScorecard> {
    this.closeScorecardCalls += 1;
    return this.scorecard;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

class FailAfterInitialResetEnvironment extends TestEnvironment {
  resetCalls = 0;

  override async reset(): Promise<RawArcObservation> {
    this.resetCalls += 1;
    if (this.resetCalls > 1) throw new Error('controller reset failure');
    return super.reset();
  }
}

class ControllerResetFailureBridge extends FakeOfficialBridge {
  controllerFailuresRemaining = 1;

  override async startGame(options: StartGameOptions): Promise<StartedArcEnvironment> {
    this.starts.push(options);
    const environment = this.controllerFailuresRemaining > 0
      ? new FailAfterInitialResetEnvironment()
      : new TestEnvironment();
    this.controllerFailuresRemaining = Math.max(0, this.controllerFailuresRemaining - 1);
    this.environments.push(environment);
    const initial = await environment.reset();
    const guid = `opaque-guid-${this.environments.length}`;
    return {
      environmentId: `private-environment-${this.environments.length}`,
      environment,
      initialObservation: { ...initial, metadata: { guid } },
    };
  }
}

class ResetEnvironment implements ArcEnvironment {
  state: RawArcObservation['state'] = 'GAME_OVER';
  frameIndex = 0;
  closeCalls = 0;

  private observation(): RawArcObservation {
    return {
      state: this.state,
      levelsCompleted: 0,
      winLevels: 1,
      availableActions: this.state === 'GAME_OVER' ? [] : ['ACTION1'],
      frames: [{
        width: 1,
        height: 1,
        cells: [[this.state === 'GAME_OVER' ? 0 : 1]],
        frameIndex: this.frameIndex,
      }],
    };
  }

  async reset(): Promise<RawArcObservation> {
    this.state = 'GAME_OVER';
    this.frameIndex = 0;
    return this.observation();
  }

  async observe(): Promise<RawArcObservation> {
    return this.observation();
  }

  async step(action: ArcAction): Promise<RawArcObservation> {
    if (action.name !== 'RESET') throw new Error('reset environment accepts only RESET');
    this.state = 'NOT_FINISHED';
    this.frameIndex += 1;
    return this.observation();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class ResetOfficialBridge extends FakeOfficialBridge {
  readonly resetEnvironments: ResetEnvironment[] = [];

  override async startGame(options: StartGameOptions): Promise<StartedArcEnvironment> {
    this.starts.push(options);
    const environment = new ResetEnvironment();
    this.resetEnvironments.push(environment);
    const initial = await environment.reset();
    return {
      environmentId: `private-reset-environment-${this.resetEnvironments.length}`,
      environment,
      initialObservation: { ...initial, metadata: { guid: 'opaque-guid-1' } },
    };
  }
}

class MockExternalAnchor implements OfficialEvidenceAnchor {
  readonly records = new Map<string, OfficialEvidenceAnchorRecord[]>();

  async append(record: OfficialEvidenceAnchorRecord): Promise<void> {
    const records = this.records.get(record.episodeId) ?? [];
    records.push(Object.freeze({ ...record }));
    this.records.set(record.episodeId, records);
  }

  async readFinal(episodeId: string): Promise<OfficialEvidenceAnchorProof | null> {
    const latest = this.records.get(episodeId)?.at(-1);
    if (!latest) return null;
    return {
      schema: 'metaharness.arc_agi_3.anchor_proof.v1',
      episodeId,
      eventCount: latest.eventCount,
      durableStateHash: latest.durableStateHash,
      receiptHeadHash: latest.receiptHeadHash,
      anchorReference: `worm-anchor:${episodeId}:${latest.eventCount}`,
    };
  }
}

async function recordOneAction(controller: ArcController, key: string): Promise<void> {
  const observation = await controller.start();
  await controller.act({
    expectedObservationHash: observation.observationHash,
    idempotencyKey: key,
    action: { name: 'ACTION1' },
    expectation: { confidence: 0.5, expectedState: 'NOT_FINISHED' },
  });
}

describe('official hidden-assignment factory', () => {
  it('freezes the public acceptance gate by default and rejects malformed overrides', async () => {
    const bridge = new FakeOfficialBridge();
    const factory = track(createOfficialArcControllerFactoryImplementation({
      assignments: Array.from({ length: 25 }, (_, index) => ({
        gameId: `private-public-gate-default-${index}`,
      })),
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
    }));
    expect(factory.acceptanceGate).toEqual(ARC_AGI_3_PUBLIC_ACCEPTANCE_GATE);
    expect(Object.isFrozen(factory.acceptanceGate)).toBe(true);
    expect(() => createOfficialArcControllerFactoryImplementation({
      assignments: [{ gameId: 'private-invalid-gate' }],
      bridge: new FakeOfficialBridge(),
      evidenceRoot: '/tmp/unused-invalid-gate-evidence',
      runManifest: MANIFEST,
      acceptanceGate: {
        expectedGames: 1,
        expectedLevels: 1,
        requiredScore: 0,
        extra: true,
      } as unknown as OfficialArcRunGate,
    })).toThrow(/acceptanceGate fields/);
    expect(() => createOfficialArcControllerFactoryImplementation({
      assignments: [{ gameId: 'private-count-mismatch' }],
      bridge: new FakeOfficialBridge(),
      evidenceRoot: '/tmp/unused-count-mismatch-evidence',
      runManifest: MANIFEST,
    })).toThrow(/assignment count.*acceptanceGate/);
    expect(() => createOfficialArcControllerFactoryImplementation({
      assignments: [{ gameId: 'private-duplicate' }, { gameId: 'private-duplicate' }],
      acceptanceGate: { expectedGames: 2, expectedLevels: 2, requiredScore: 100 },
      bridge: new FakeOfficialBridge(),
      evidenceRoot: '/tmp/unused-duplicate-evidence',
      runManifest: MANIFEST,
    })).toThrow(/game IDs must be unique/);
  });

  it('requires evidenceRoot and completes controller preflight before bridge calls', async () => {
    const bridge = new FakeOfficialBridge();
    expect(() => createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      runManifest: MANIFEST,
    } as unknown as OfficialArcControllerFactoryOptions)).toThrow('evidenceRoot is required');

    const evidenceRoot = await temporaryEvidenceRoot();
    expect(() => createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot,
      runManifest: MANIFEST,
      budget: { maxActions: 10_001, maxWallTimeMs: 60_000 },
    })).toThrow(/maxActions/);
    expect(bridge.createCalls).toBe(0);
    expect(bridge.starts).toHaveLength(0);

    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot,
      runManifest: MANIFEST,
    }));
    await expect(factory(context('invalid-context', ''))).rejects.toThrow(/principalId/);
    expect(bridge.createCalls).toBe(0);
    expect(bridge.starts).toHaveLength(0);
  });

  it('serializes assignment starts and advances only after explicit approval', async () => {
    const bridge = new FakeOfficialBridge();
    const factory = track(createOfficialArcControllerFactory({
      assignments: [
        { gameId: 'private-game-a', seed: 7 },
        { gameId: 'private-game-b', gameVersionHash: 'e'.repeat(64) },
      ],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
      budget: { maxActions: 100, maxWallTimeMs: 60_000 },
      scorecard: { tags: ['frozen-test'] },
    }));

    const firstEpisode = 'episode-first';
    const secondEpisode = 'episode-second';
    const concurrent = await Promise.allSettled([
      factory(context(firstEpisode)),
      factory(context(secondEpisode)),
    ]);
    expect(concurrent[0]!.status).toBe('fulfilled');
    expect(concurrent[1]!.status).toBe('rejected');
    expect((concurrent[1] as PromiseRejectedResult).reason).toMatchObject({
      message: 'official ARC assignment is still active',
    });
    expect(bridge.starts.map(start => start.gameId)).toEqual(['private-game-a']);
    expect(factory.assignedCount).toBe(1);

    const first = (concurrent[0] as PromiseFulfilledResult<ArcController>).value;
    factory.approveAdvance(firstEpisode);
    const second = await factory(context(secondEpisode));
    expect(first.status().closed).toBe(true);
    expect(second.status().closed).toBe(false);
    expect(bridge.starts.map(start => start.gameId)).toEqual([
      'private-game-a',
      'private-game-b',
    ]);
    expect(bridge.starts.every(start => start.bridgeOwnership === 'external')).toBe(true);
    expect(bridge.createCalls).toBe(1);
    expect(factory.assignedCount).toBe(2);
    expect(factory.supportsResume).toBe(false);
  });

  it('retries a failed start only after approval and reuses the same assignment', async () => {
    const bridge = new FakeOfficialBridge();
    bridge.failuresRemaining = 1;
    const factory = track(createOfficialArcControllerFactory({
      assignments: [
        { gameId: 'private-game-a' },
        { gameId: 'private-game-b' },
      ],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
    }));

    const failedEpisode = 'episode-failed-start';
    await expect(factory(context(failedEpisode))).rejects.toThrow(
      'official ARC environment start failed',
    );
    expect(factory.assignedCount).toBe(0);
    await expect(factory(context('episode-premature-next'))).rejects.toThrow(
      'official ARC assignment is still active',
    );
    expect(bridge.starts.map(start => start.gameId)).toEqual(['private-game-a']);

    factory.approveRetry(failedEpisode);
    const retried = await factory(context('episode-retry-a'));
    expect(bridge.starts.map(start => start.gameId)).toEqual([
      'private-game-a',
      'private-game-a',
    ]);
    expect(factory.assignedCount).toBe(1);

    factory.approveAdvance('episode-retry-a');
    await factory(context('episode-after-retry'));
    expect(retried.status().closed).toBe(true);
    expect(bridge.starts.map(start => start.gameId)).toEqual([
      'private-game-a',
      'private-game-a',
      'private-game-b',
    ]);
    expect(factory.assignedCount).toBe(2);
  });

  it('releases an unpublished bridge start failure so arc_start can retry the assignment', async () => {
    const bridge = new FakeOfficialBridge();
    bridge.failuresRemaining = 1;
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
    }));
    const store = new ArcEpisodeStore(factory, await temporaryEvidenceRoot());

    await expect(store.create('operator')).rejects.toThrow('controller factory failed');
    expect(factory.assignedCount).toBe(0);
    await expect(store.create('operator')).resolves.toBeDefined();
    expect(bridge.starts.map(start => start.gameId)).toEqual([
      'private-game-a',
      'private-game-a',
    ]);
    expect(factory.assignedCount).toBe(1);
    await store.closeAll();
  });

  it('releases a controller whose unpublished start fails so the assignment is not wedged', async () => {
    const bridge = new ControllerResetFailureBridge();
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
    }));
    const store = new ArcEpisodeStore(factory, await temporaryEvidenceRoot());

    await expect(store.create('operator')).rejects.toThrow('controller start failed');
    expect(factory.assignedCount).toBe(0);
    expect(bridge.environments[0]?.closeCalls).toBe(1);
    await expect(store.create('operator')).resolves.toBeDefined();
    expect(bridge.starts.map(start => start.gameId)).toEqual([
      'private-game-a',
      'private-game-a',
    ]);
    expect(factory.assignedCount).toBe(1);
    await store.closeAll();
  });

  it('redacts hidden assignment identifiers from bridge start failures', async () => {
    const bridge = new FakeOfficialBridge();
    bridge.failuresRemaining = 1;
    bridge.failureMessage = [
      'private-game-secret',
      'guid=private-guid-secret',
      'https://private.example/assignment',
      'token=sk-secret',
    ].join(' ');
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-secret' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
    }));

    const failure = await Promise.resolve(factory(context('episode-redacted-failure'))).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const publicError = failure as Error;
    expect(publicError.message).toBe('official ARC environment start failed');
    expect(publicError.message).not.toContain('private-game-secret');
    expect(publicError.message).not.toContain('private-guid-secret');
    expect(publicError.message).not.toContain('private.example');
    expect(publicError.message).not.toContain('sk-secret');
  });

  it('accepts finalized evidence with a matching scorecard and external anchor', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-accepted'));
    await recordOneAction(controller, 'official-action-0001');
    await controller.close();
    const closedScorecard = await factory.closeScorecard();
    if (!closedScorecard) throw new Error('expected closed scorecard');
    expect(Object.isFrozen(closedScorecard)).toBe(true);
    expect(Object.isFrozen(closedScorecard.environments)).toBe(true);
    expect(() => {
      (closedScorecard as { score: number }).score = 0;
    }).toThrow();
    const closedRun = (
      closedScorecard as { environments: Array<{ runs: Array<{ actions: number }> }> }
    ).environments[0]!.runs[0]!;
    expect(Object.isFrozen(closedRun)).toBe(true);
    expect(() => { closedRun.actions = 999; }).toThrow();
    const evidence = await factory.finalizeEvidence();

    expect(evidence.accepted).toBe(true);
    expect(evidence.acceptanceGate).toEqual(TEST_GATE);
    expect(evidence.failures).toEqual([]);
    expect(evidence.summary).toMatchObject({
      totalActions: 1,
      totalResets: 0,
      receiptedTransitions: 1,
      danglingActionIntents: 0,
    });
    expect(evidence.episodes).toEqual([
      expect.objectContaining({
        episodeId: 'episode-accepted',
        accepted: true,
        scorecardRunMatched: true,
        externalAnchorMatched: true,
        actionIntentCount: 1,
        transitionCount: 1,
        danglingActionIntentCount: 0,
      }),
    ]);
    expect(evidence.episodes[0]!.receiptReconciliation).toMatchObject({
      ok: true,
      recordedActionCount: 1,
      officialActionCount: 1,
    });
    expect(Object.isFrozen(evidence.summary)).toBe(true);
    expect(Object.isFrozen(evidence.episodes[0]?.receiptVerification)).toBe(true);
    expect(() => {
      (evidence.summary as { score: number }).score = 0;
    }).toThrow();
    const { evidenceHash, ...evidenceBody } = evidence;
    expect(hashArcValue(evidenceBody)).toBe(evidenceHash);
    expect(anchor.records.get('episode-accepted')?.length).toBeGreaterThan(0);
    expect(bridge.closeScorecardCalls).toBe(1);
  });

  it('does not interpret Windows stat mode bits as POSIX group permissions', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    const evidenceRoot = await temporaryEvidenceRoot();
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-windows-mode' }],
      bridge,
      evidenceRoot,
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-windows-mode'));
    await recordOneAction(controller, 'windows-mode-action-0001');
    await controller.close();

    const journalFiles = (await readdir(evidenceRoot)).filter(name => name.endsWith('.jsonl'));
    expect(journalFiles).toHaveLength(1);
    await chmod(join(evidenceRoot, journalFiles[0]!), 0o666);

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('expected process.platform descriptor');
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    try {
      const evidence = await factory.finalizeEvidence();
      expect(evidence.accepted).toBe(true);
      expect(evidence.failures).not.toContain('INVALID_DURABLE_JOURNAL');
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('fails closed when the scorecard contains an additional malformed run', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    const valid = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    bridge.scorecard = {
      ...valid,
      environments: [{
        runs: [
          { guid: 'opaque-guid-1', actions: 1, resets: 0 },
          { guid: 'opaque-guid-extra', actions: 'invalid', resets: 0 },
        ],
      }],
    };
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-malformed-scorecard'));
    await recordOneAction(controller, 'malformed-scorecard-action');
    const evidence = await factory.finalizeEvidence();

    expect(evidence.accepted).toBe(false);
    expect(evidence.summary.scorecardRuns).toBe(2);
    expect(evidence.failures).toEqual(expect.arrayContaining([
      'MALFORMED_SCORECARD_RUNS',
      'FROZEN_ASSIGNMENT_GATE_FAILED',
    ]));
  });

  it('fails closed when the scorecard contains an additional empty environment', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    const valid = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    bridge.scorecard = {
      ...valid,
      environments: [
        { runs: [{ guid: 'opaque-guid-1', actions: 1, resets: 0 }] },
        { runs: [] },
      ],
    };
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-empty-scorecard-environment'));
    await recordOneAction(controller, 'empty-scorecard-environment-action');
    const evidence = await factory.finalizeEvidence();

    expect(evidence.accepted).toBe(false);
    expect(evidence.failures).toEqual(expect.arrayContaining([
      'MALFORMED_SCORECARD_RUNS',
      'FROZEN_ASSIGNMENT_GATE_FAILED',
    ]));
  });

  it('fails closed when the scorecard reports an out-of-range score', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 1, score: 101 });
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-invalid-score' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-invalid-score'));
    await recordOneAction(controller, 'invalid-score-action');
    const evidence = await factory.finalizeEvidence();

    expect(evidence.accepted).toBe(false);
    expect(evidence.summary.score).toBe(-1);
    expect(evidence.failures).toEqual(expect.arrayContaining([
      'MALFORMED_SCORECARD_SCORE',
      'SCORE_GATE_FAILED',
    ]));
  });

  it('serializes finalization and closes active controllers under the frozen gate', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-finalization' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-finalization'));
    await recordOneAction(controller, 'finalization-action-0001');
    const firstFinalization = factory.finalizeEvidence();

    await expect(factory(context('episode-after-finalization'))).rejects.toThrow(
      'official ARC run is closing',
    );
    const evidence = await firstFinalization;
    expect(controller.status().closed).toBe(true);
    expect(evidence.accepted).toBe(true);
    expect(await factory.finalizeEvidence()).toBe(evidence);
    expect(bridge.closeScorecardCalls).toBe(1);
  });

  it('snapshots a mutable manifest and budget at factory creation', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    const mutableManifest = {
      visibleModelLabel: `  ${String(MANIFEST.visibleModelLabel)}  `,
      promptSnapshotHash: String(MANIFEST.promptSnapshotHash),
      toolSchemaHash: String(MANIFEST.toolSchemaHash),
      environmentAdapterVersion: `  ${String(MANIFEST.environmentAdapterVersion)}  `,
    };
    const mutableBudget: Partial<ArcRunBudget> = { maxActions: 2 };
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-snapshot' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: mutableManifest,
      budget: mutableBudget,
    }));

    mutableManifest.visibleModelLabel = 'mutated model label';
    mutableManifest.promptSnapshotHash = 'f'.repeat(64);
    mutableManifest.toolSchemaHash = 'a'.repeat(64);
    mutableManifest.environmentAdapterVersion = 'mutated-adapter';
    mutableBudget.maxActions = 1;
    mutableBudget.maxWallTimeMs = 1_000;

    const controller = await factory(context('episode-snapshot'));
    const observation = await controller.start();
    const transition = await controller.act({
      expectedObservationHash: observation.observationHash,
      idempotencyKey: 'snapshot-action-0001',
      action: { name: 'ACTION1' },
      expectation: { confidence: 0.5, expectedState: 'NOT_FINISHED' },
    });
    expect(transition.receipt.visibleModelLabel).toBe(MANIFEST.visibleModelLabel);
    expect(transition.receipt.promptSnapshotHash).toBe(MANIFEST.promptSnapshotHash);
    expect(transition.receipt.toolSchemaHash).toBe(MANIFEST.toolSchemaHash);
    expect(transition.receipt.environmentAdapterVersion).toBe(MANIFEST.environmentAdapterVersion);
    expect(controller.status()).toMatchObject({ maxActions: 2, maxWallTimeMs: 14_400_000 });
    await controller.close();

    const evidence = await factory.finalizeEvidence();
    expect(evidence.accepted).toBe(true);
    expect(evidence.configurationHash).toBe(hashArcValue({
      assignments: [{ gameId: 'private-game-snapshot' }],
      runManifest: { ...MANIFEST, controllerVersion: '0.1.0' },
      budget: { maxActions: 2, maxWallTimeMs: 14_400_000 },
      scorecard: {},
      acceptanceGate: TEST_GATE,
    }));
  });

  it('reconciles RESET separately when official run actions include resets', async () => {
    const bridge = new ResetOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({
      guid: 'opaque-guid-1',
      actions: 1,
      resets: 1,
    });
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-reset-game' }],
      bridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-reset'));
    const observation = await controller.start();
    expect(observation.state).toBe('GAME_OVER');
    await controller.act({
      expectedObservationHash: observation.observationHash,
      idempotencyKey: 'official-reset-0001',
      action: { name: 'RESET' },
      expectation: { confidence: 1, expectedState: 'NOT_FINISHED' },
    });
    await controller.close();
    const evidence = await factory.finalizeEvidence();

    expect(evidence.accepted).toBe(true);
    expect(evidence.summary).toMatchObject({
      totalActions: 1,
      totalResets: 1,
      receiptedTransitions: 1,
    });
    expect(evidence.episodes[0]!.receiptReconciliation).toMatchObject({
      ok: true,
      recordedActionCount: 0,
      recordedResetCount: 1,
      officialActionCount: 0,
      officialResetCount: 1,
      officialTransitionCount: 1,
    });
  });

  it('rejects structurally valid same-count journal tampering', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 1 });
    const evidenceRoot = await temporaryEvidenceRoot();
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-tamper' }],
      bridge,
      evidenceRoot,
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context('episode-journal-tamper'));
    await recordOneAction(controller, 'tamper-action-0001');
    await controller.close();

    const journalFiles = (await readdir(evidenceRoot)).filter(name => name.endsWith('.jsonl'));
    expect(journalFiles).toHaveLength(1);
    const journalPath = join(evidenceRoot, journalFiles[0]!);
    const events = (await readFile(journalPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const first = events[0]!;
    const payload = first.payload && typeof first.payload === 'object' && !Array.isArray(first.payload)
      ? first.payload as Record<string, unknown>
      : {};
    first.payload = { ...payload, structurallyValidTamper: true };
    await writeFile(journalPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');

    const evidence = await factory.finalizeEvidence();
    expect(evidence.accepted).toBe(false);
    expect(evidence.failures).toContain('EXTERNAL_ANCHOR_MISMATCH');
    expect(evidence.failures).not.toContain('INVALID_DURABLE_JOURNAL');
    expect(evidence.episodes[0]).toMatchObject({
      accepted: false,
      externalAnchorMatched: false,
      actionIntentCount: 1,
      transitionCount: 1,
      danglingActionIntentCount: 0,
    });
  });

  it('rejects an anchored same-count journal with a wrong intermediate receipt', async () => {
    const bridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    bridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 2 });
    const evidenceRoot = await temporaryEvidenceRoot();
    const episodeId = 'episode-intermediate-receipt-tamper';
    const factory = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-intermediate-tamper' }],
      bridge,
      evidenceRoot,
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));

    const controller = await factory(context(episodeId));
    let observation = await controller.start();
    for (let index = 0; index < 2; index += 1) {
      const result = await controller.act({
        expectedObservationHash: observation.observationHash,
        idempotencyKey: `intermediate-tamper-action-${index}`,
        action: { name: 'ACTION1' },
        expectation: { confidence: 0.5, expectedState: 'NOT_FINISHED' },
      });
      observation = result.observation;
    }
    await controller.close();

    const journalFiles = (await readdir(evidenceRoot)).filter(name => name.endsWith('.jsonl'));
    const journalPath = join(evidenceRoot, journalFiles[0]!);
    const events = (await readFile(journalPath, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const transitions = events.filter(event => event.kind === 'arc.transition');
    expect(transitions).toHaveLength(2);
    const firstPayload = transitions[0]!.payload as Record<string, unknown>;
    const replacementHash = firstPayload.receiptHash === 'f'.repeat(64)
      ? 'e'.repeat(64)
      : 'f'.repeat(64);
    firstPayload.receiptHash = replacementHash;
    await writeFile(journalPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');

    const records = anchor.records.get(episodeId)!;
    const latest = records.at(-1)!;
    records[records.length - 1] = Object.freeze({
      ...latest,
      durableStateHash: journalStateHash(events),
    });

    const evidence = await factory.finalizeEvidence();
    expect(evidence.accepted).toBe(false);
    expect(evidence.failures).toContain('JOURNAL_RECEIPT_MISMATCH');
    expect(evidence.failures).not.toContain('EXTERNAL_ANCHOR_MISMATCH');
    expect(evidence.episodes[0]).toMatchObject({
      externalAnchorMatched: true,
      transitionCount: 2,
      danglingActionIntentCount: 0,
      accepted: false,
    });
  });

  it('refuses accepted evidence without an anchor or with mismatched scorecard counts', async () => {
    const unanchoredBridge = new FakeOfficialBridge();
    unanchoredBridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 0 });
    const unanchored = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-a' }],
      bridge: unanchoredBridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      runManifest: MANIFEST,
    }));
    const unanchoredController = await unanchored(context('episode-unanchored'));
    await unanchoredController.start();
    await unanchoredController.close();
    const unanchoredEvidence = await unanchored.finalizeEvidence();
    expect(unanchoredEvidence.accepted).toBe(false);
    expect(unanchoredEvidence.failures).toContain('EXTERNAL_ANCHOR_REQUIRED');

    const mismatchedBridge = new FakeOfficialBridge();
    const anchor = new MockExternalAnchor();
    mismatchedBridge.scorecard = officialScorecard({ guid: 'opaque-guid-1', actions: 0 });
    const mismatched = track(createOfficialArcControllerFactory({
      assignments: [{ gameId: 'private-game-b' }],
      bridge: mismatchedBridge,
      evidenceRoot: await temporaryEvidenceRoot(),
      evidenceAnchor: anchor,
      runManifest: MANIFEST,
    }));
    const mismatchedController = await mismatched(context('episode-count-mismatch'));
    await recordOneAction(mismatchedController, 'official-action-0002');
    await mismatchedController.close();
    const mismatchedEvidence = await mismatched.finalizeEvidence();
    expect(mismatchedEvidence.accepted).toBe(false);
    expect(mismatchedEvidence.failures).toContain('RECEIPT_SCORECARD_MISMATCH');
    expect(mismatchedEvidence.episodes[0]!.receiptReconciliation).toMatchObject({ ok: false });
  });
});
