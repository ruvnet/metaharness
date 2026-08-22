import { describe, expect, it } from 'vitest';
import type { SessionLog } from '@metaharness/kernel';
import {
  ArcController,
  ArcValidationError,
  containsRawGameIdentityKey,
  createArcCheckpoint,
  hashArcValue,
  reconcileTransitionReceipts,
  TRANSITION_RECEIPT_GENESIS,
  verifyArcCheckpoint,
  verifyTransitionReceipts,
  type ActRequest,
  type ArcAction,
  type ArcCheckpoint,
  type ArcCheckpointBody,
  type ArcEnvironment,
  type ExactArcObservation,
  type JsonValue,
  type RawArcObservation,
  type SupervisorDirectiveCommit,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function raw(
  cells: readonly (readonly number[])[] = [[0, 0], [0, 0]],
  state: RawArcObservation['state'] = 'NOT_FINISHED',
  metadata?: Readonly<Record<string, unknown>>,
  frames?: RawArcObservation['frames'],
): RawArcObservation {
  return {
    state,
    levelsCompleted: state === 'WIN' ? 1 : 0,
    winLevels: 1,
    availableActions: ['ACTION1', 'ACTION6'],
    frames: frames ?? [{ width: cells[0]!.length, height: cells.length, cells }],
    metadata,
  };
}

class FakeEnvironment implements ArcEnvironment {
  current: RawArcObservation;
  readonly queue: RawArcObservation[] = [];
  resetCalls = 0;
  stepCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;
  stepHook?: (action: ArcAction) => Promise<RawArcObservation>;

  constructor(initial = raw()) {
    this.current = initial;
  }

  async reset(): Promise<RawArcObservation> {
    this.resetCalls++;
    return this.current;
  }
  async observe(): Promise<RawArcObservation> { return this.current; }
  async step(action: ArcAction): Promise<RawArcObservation> {
    this.stepCalls++;
    if (this.stepHook) this.current = await this.stepHook(action);
    else this.current = this.queue.shift() ?? this.current;
    return this.current;
  }
  async checkpoint(): Promise<JsonValue> { return { index: this.stepCalls }; }
  async resume(_checkpoint: JsonValue): Promise<RawArcObservation> {
    this.resumeCalls++;
    return this.current;
  }
  async close(): Promise<void> { this.closeCalls++; }
}

function controller(
  environment: ArcEnvironment,
  overrides: Partial<ConstructorParameters<typeof ArcController>[0]> = {},
): ArcController {
  return new ArcController({
    principalId: 'principal one',
    runId: 'private run one',
    gameVersionHash: 'hidden-game-version-hash',
    environment,
    runManifest: {
      visibleModelLabel: 'ChatGPT UI / OpenAI model declared by operator',
      promptSnapshotHash: SHA_A,
      toolSchemaHash: SHA_B,
      environmentAdapterVersion: 'arc-agi==0.9.8;arcengine==0.9.3;bridge=v1',
    },
    ...overrides,
  });
}

function request(
  observation: ExactArcObservation,
  key: string,
  action: ArcAction = { name: 'ACTION1' },
  expectedFrameHash = observation.currentFrame.frameHash,
): ActRequest {
  return {
    expectedObservationHash: observation.observationHash,
    idempotencyKey: key,
    action,
    expectation: { confidence: 0.5, expectedFrameHash },
  };
}

function rehashedCheckpoint(
  checkpoint: ArcCheckpoint,
  mutate: (body: Record<string, unknown>) => void,
): { readonly body: ArcCheckpointBody; readonly checkpoint: ArcCheckpoint } {
  const clone = structuredClone(checkpoint);
  const { checkpointHash: _checkpointHash, ...body } = clone;
  mutate(body as unknown as Record<string, unknown>);
  return {
    body: body as ArcCheckpointBody,
    checkpoint: { ...body, checkpointHash: hashArcValue(body) },
  };
}

const INVALID_CHECKPOINT_MUTATIONS: readonly {
  readonly name: string;
  readonly expected: RegExp;
  readonly mutate: (body: Record<string, unknown>) => void;
}[] = [
  {
    name: 'wrong-type budget',
    expected: /budget|maxActions/,
    mutate: body => {
      body.budget = { maxActions: '1000', maxWallTimeMs: 60_000 };
    },
  },
  {
    name: 'non-finite budget',
    expected: /budget|maxWallTimeMs/,
    mutate: body => {
      body.budget = { maxActions: 1_000, maxWallTimeMs: Number.POSITIVE_INFINITY };
    },
  },
  {
    name: 'extra budget key',
    expected: /budget/,
    mutate: body => {
      body.budget = { maxActions: 1_000, maxWallTimeMs: 60_000, burst: 1 };
    },
  },
  {
    name: 'out-of-range budget',
    expected: /budget|maxActions/,
    mutate: body => {
      body.budget = { maxActions: 10_001, maxWallTimeMs: 60_000 };
    },
  },
  {
    name: 'invalid phase',
    expected: /phase/,
    mutate: body => { body.phase = 'STOPPED'; },
  },
  {
    name: 'non-boolean closed flag',
    expected: /closed/,
    mutate: body => { body.closed = 'false'; },
  },
  {
    name: 'invalid created timestamp',
    expected: /timestamp/,
    mutate: body => { body.createdAtMs = -1; },
  },
  {
    name: 'invalid started timestamp',
    expected: /timestamp/,
    mutate: body => { body.startedAtMs = 1.5; },
  },
  {
    name: 'reversed timestamps',
    expected: /timestamp/,
    mutate: body => {
      body.createdAtMs = (body.startedAtMs as number) - 1;
    },
  },
  {
    name: 'object lastError',
    expected: /lastError/,
    mutate: body => { body.lastError = { code: 'ENVIRONMENT_STEP_FAILED' }; },
  },
  {
    name: 'invalid session state hash',
    expected: /sessionStateHash/,
    mutate: body => { body.sessionStateHash = 'not-a-hash'; },
  },
  {
    name: 'missing environment checkpoint field',
    expected: /environmentCheckpoint/,
    mutate: body => { delete body.environmentCheckpoint; },
  },
  {
    name: 'non-JSON environment checkpoint',
    expected: /environmentCheckpoint/,
    mutate: body => { body.environmentCheckpoint = { cursor: Number.NaN }; },
  },
  {
    name: 'extra checkpoint body key',
    expected: /unexpected field/,
    mutate: body => { body.injected = true; },
  },
  {
    name: 'invalid manifest shape',
    expected: /manifest/,
    mutate: body => {
      body.runManifest = {
        ...(body.runManifest as Record<string, unknown>),
        providerSecret: 'not part of the frozen manifest',
      };
    },
  },
  {
    name: 'invalid scope ID',
    expected: /scope ID/,
    mutate: body => { body.runId = 'run_not-canonical'; },
  },
  {
    name: 'inconsistent phase and closed flag',
    expected: /phase and closed/,
    mutate: body => {
      body.phase = 'CLOSED';
      body.closed = false;
    },
  },
];

describe('ArcController governed transition ledger', () => {
  it('records every returned animation frame, receipt chain, manifest, and idempotent replay', async () => {
    const environment = new FakeEnvironment();
    environment.queue.push(raw([[1, 0], [0, 0]], 'NOT_FINISHED', undefined, [
      { width: 2, height: 2, cells: [[0, 0], [0, 0]], frameIndex: 0 },
      { width: 2, height: 2, cells: [[1, 0], [0, 0]], frameIndex: 1 },
    ]));
    const core = controller(environment);
    const initial = await core.start();
    const input = request(initial, 'action-key-0001', { name: 'ACTION1' }, 'f'.repeat(64));
    const first = await core.act(input);
    const replay = await core.act(input);

    expect(environment.stepCalls).toBe(1);
    expect(first.receipt.frames).toHaveLength(2);
    expect(first.receipt.returnedFrameRefs).toEqual(first.receipt.frames.map(frame => frame.frameRef));
    expect(first.receipt.environmentAdapterVersion).toContain('arc-agi==0.9.8');
    expect(first.receipt.memorySnapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(replay.replayed).toBe(true);
    expect(core.verifyReceipts()).toEqual(expect.objectContaining({ ok: true, count: 1 }));
  });

  it('snapshots the complete action request before any asynchronous boundary', async () => {
    const environment = new FakeEnvironment();
    let release!: () => void;
    let markStarted!: () => void;
    let dispatchedAction: ArcAction | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    environment.stepHook = async (action) => {
      dispatchedAction = action;
      markStarted();
      await gate;
      return raw([[1, 0], [0, 0]]);
    };
    const core = controller(environment);
    const initial = await core.start();
    const input = request(initial, 'stable-request-0001', { name: 'ACTION1' }, 'f'.repeat(64));
    const expectedRequestHash = hashArcValue(input);
    const pending = core.act(input);
    await started;

    const mutable = input as unknown as {
      action: { name: string };
      expectation: { expectedFrameHash?: string };
    };
    mutable.action.name = 'ACTION2';
    mutable.expectation.expectedFrameHash = 'e'.repeat(64);
    release();

    const result = await pending;
    expect(dispatchedAction).toEqual({ name: 'ACTION1' });
    expect(result.receipt.action).toEqual({ name: 'ACTION1' });
    expect(result.receipt.expectation.expectedFrameHash).toBe('f'.repeat(64));
    expect(result.receipt.requestHash).toBe(expectedRequestHash);
    expect(Object.isFrozen(result.receipt.expectation)).toBe(true);
    expect(core.verifyReceipts()).toMatchObject({ ok: true, count: 1 });
  });

  it('serializes the complete CAS critical section under concurrent actors', async () => {
    const environment = new FakeEnvironment();
    let release!: (value: RawArcObservation) => void;
    environment.stepHook = () => new Promise(resolve => { release = resolve; });
    const core = controller(environment);
    const initial = await core.start();
    const first = core.act(request(initial, 'concurrent-key-1'));
    const second = core.act(request(initial, 'concurrent-key-2'));
    while (environment.stepCalls === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    release(raw([[1, 0], [0, 0]]));
    const results = await Promise.allSettled([first, second]);

    expect(results[0]!.status).toBe('fulfilled');
    expect(results[1]!.status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'STALE_OBSERVATION' });
    expect(environment.stepCalls).toBe(1);
  });

  it('faults after a post-dispatch clock failure and never dispatches an identical retry', async () => {
    const environment = new FakeEnvironment();
    let clockCalls = 0;
    const core = controller(environment, {
      clock: () => {
        clockCalls += 1;
        return clockCalls === 4 ? Number.NaN : clockCalls;
      },
      budget: { maxActions: 10, maxWallTimeMs: 60_000 },
    });
    const initial = await core.start();
    const input = request(initial, 'post-dispatch-clock');

    await expect(core.act(input)).rejects.toMatchObject({
      code: 'POST_DISPATCH_COMMIT_FAILED',
    });
    expect(environment.stepCalls).toBe(1);
    expect(core.status()).toMatchObject({
      phase: 'FAULTED',
      uncertainMutationCount: 1,
      lastError: 'POST_DISPATCH_COMMIT_FAILED',
      receiptCount: 0,
    });

    await expect(core.act(input)).rejects.toMatchObject({ code: 'FAULTED' });
    expect(environment.stepCalls).toBe(1);
    expect(core.status().uncertainMutationCount).toBe(1);
  });

  it('enforces reset-only states, strict action shapes, and fail-closed budgets', async () => {
    const environment = new FakeEnvironment(raw([[0]], 'GAME_OVER'));
    environment.queue.push(raw([[0]], 'NOT_FINISHED'));
    const core = controller(environment, { budget: { maxActions: 1, maxWallTimeMs: 10_000 } });
    const initial = await core.start();
    await expect(core.act({
      ...request(initial, 'empty-change-01'),
      expectation: {
        confidence: 0.5,
        expectedState: 'NOT_FINISHED',
        expectedChanges: [{ x: 0, y: 0 }],
      },
    })).rejects.toMatchObject({ code: 'INVALID_EXPECTATION' });
    await expect(core.act(request(initial, 'illegal-action-1'))).rejects.toMatchObject({
      code: 'RESET_REQUIRED',
    });
    await expect(core.act(request(initial, 'bad-shape-001', {
      name: 'ACTION1',
      x: 1,
    } as unknown as ArcAction))).rejects.toMatchObject({ code: 'UNEXPECTED_ACTION_FIELD' });
    const reset = await core.act(request(initial, 'legal-reset-01', { name: 'RESET' }));
    expect(core.reconcileReceipts({
      actionCount: 0,
      resetCount: 1,
      expectedReceiptHeadHash: reset.receipt.receiptHash,
    })).toMatchObject({ ok: true, recordedActionCount: 0, recordedResetCount: 1 });
    await expect(core.act(request(reset.observation, 'over-budget-01'))).rejects.toMatchObject({
      code: 'ACTION_BUDGET_EXHAUSTED',
    });
    expect(environment.stepCalls).toBe(1);
  });

  it('versions semantic rules, retains contradictions, and rejects unsupported evidence', async () => {
    const environment = new FakeEnvironment();
    const core = controller(environment);
    const initial = await core.start();
    const transition = await core.act(request(initial, 'memory-action-1'));
    const first = await core.commitMemoryRule({
      scope: 'GAME',
      kind: 'ACTION_MAP',
      statement: 'ACTION1 appears inert here',
      predictedEffect: 'No final-grid change',
      supportingReceiptHashes: [transition.receipt.receiptHash],
    });
    const second = await core.commitMemoryRule({
      id: first.id,
      scope: 'GAME',
      kind: 'ACTION_MAP',
      statement: 'ACTION1 may be contextual',
      predictedEffect: 'Effect depends on latent context',
      contradictingReceiptHashes: [transition.receipt.receiptHash],
    });
    expect(second.version).toBe(2);
    expect(second.supportingReceiptHashes).toEqual([transition.receipt.receiptHash]);
    expect(second.contradictingReceiptHashes).toEqual([transition.receipt.receiptHash]);
    await expect(core.commitMemoryRule({
      scope: 'GAME',
      kind: 'GOAL',
      statement: 'Unsupported rule',
      predictedEffect: 'Nothing',
      supportingReceiptHashes: ['c'.repeat(64)],
    })).rejects.toThrow(/unknown receipt/);
  });

  it('detects eight ineffective coordinate probes deterministically', async () => {
    const environment = new FakeEnvironment();
    const core = controller(environment, {
      supervisorThresholds: {
        repeatedEdgeCount: 100,
        noEffectCount: 100,
        noEffectWindow: 100,
        predictionErrorMean: 1,
        predictionErrorWindow: 100,
        stagnationWindow: 100,
        cycleWithinComponentCount: 100,
        coordinateProbeCount: 8,
      },
    });
    let observation = await core.start();
    for (let index = 0; index < 8; index++) {
      observation = (await core.act(request(
        observation,
        `coordinate-${index}`,
        { name: 'ACTION6', x: index, y: 0 },
      ))).observation;
    }
    const bundle = core.supervisorCaseBundle();
    expect(bundle?.case.trigger).toBe('COORDINATE_PROBE');
    expect(bundle?.case.evidenceReceiptHashes).toHaveLength(8);
  });

  it('detects more than six actions cycling within one observable component', async () => {
    const environment = new FakeEnvironment(raw([[0]]));
    let value = 0;
    environment.stepHook = async () => {
      value = value === 0 ? 1 : 0;
      return raw([[value]]);
    };
    const core = controller(environment, {
      supervisorThresholds: {
        repeatedEdgeCount: 100,
        noEffectCount: 100,
        noEffectWindow: 100,
        predictionErrorMean: 1,
        predictionErrorWindow: 100,
        stagnationWindow: 100,
        cycleWithinComponentCount: 7,
        coordinateProbeCount: 100,
      },
    });
    let observation = await core.start();
    for (let index = 0; index < 7; index++) {
      observation = (await core.act({
        ...request(observation, `cycle-action-${index}`),
        expectation: { confidence: 1, expectedState: 'NOT_FINISHED' },
      })).observation;
    }
    expect(core.supervisorCaseBundle()?.case.trigger).toBe('CYCLE');
  });

  it('binds exactly-three boss hypotheses into a stale-safe directive hash', async () => {
    const environment = new FakeEnvironment();
    const core = controller(environment);
    const initial = await core.start();
    const transition = await core.act(request(initial, 'supervisor-act1'));
    const bundle = core.openSupervisorCase({
      trigger: 'MODEL_CONTRADICTION',
      evidenceReceiptHashes: [transition.receipt.receiptHash],
    })!;
    const hypotheses = [{
      hypothesis: 'The object is gated by position',
      evidenceReceiptHashes: [transition.receipt.receiptHash],
      falsifier: 'Probe the upper-left coordinate',
      proposedNextAction: { name: 'ACTION6' as const, x: 0, y: 0 },
    }, {
      hypothesis: 'ACTION1 requires a prior directional move',
      evidenceReceiptHashes: [transition.receipt.receiptHash],
      falsifier: 'Try a directional action before ACTION1',
      proposedNextAction: { name: 'ACTION2' as const },
    }, {
      hypothesis: 'The visible object is a distractor',
      evidenceReceiptHashes: [transition.receipt.receiptHash],
      falsifier: 'Probe a different colored region',
      proposedNextAction: { name: 'ACTION6' as const, x: 1, y: 1 },
    }] as const;
    const commit: SupervisorDirectiveCommit = {
      caseId: bundle.case.id,
      caseHash: bundle.case.caseHash,
      expectedObservationHash: bundle.observation.observationHash,
      mode: 'EXPAND_FRONTIER',
      diagnosis: 'Current model is contradicted',
      requiredEvidence: [transition.receipt.receiptHash, transition.receipt.receiptHash],
      prohibitedEdges: [],
      actionBudget: 3,
      expiresAfterActions: 3,
      hypotheses,
      recommendedStrategy: 'Probe novel positions',
      constraints: ['Do not repeat the tested edge'],
    };
    await expect(core.commitSupervisorDirective({
      ...commit,
      mode: 'NOT_A_MODE',
    } as unknown as SupervisorDirectiveCommit)).rejects.toThrow(/mode is invalid/);
    await expect(core.commitSupervisorDirective({
      ...commit,
      actionBudget: 2,
      expiresAfterActions: 3,
    })).rejects.toThrow(/cannot exceed actionBudget/);
    await expect(core.commitSupervisorDirective({
      ...commit,
      mode: 'RESET',
      actionBudget: 1,
      expiresAfterActions: 1,
    })).rejects.toMatchObject({ code: 'RESET_DIRECTIVE_ILLEGAL' });
    await expect(core.commitSupervisorDirective({
      ...commit,
      requiredEvidence: ['f'.repeat(64)],
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_SUPERVISOR_EVIDENCE' });
    const directive = await core.commitSupervisorDirective(commit);
    expect(directive.hypotheses).toHaveLength(3);
    expect(directive.requiredEvidence).toEqual([transition.receipt.receiptHash]);
    expect(directive.expectedObservationHash).toBe(bundle.observation.observationHash);
    const directiveCheckpoint = await core.checkpoint();
    expect(() => verifyArcCheckpoint(directiveCheckpoint)).not.toThrow();
    await expect(core.commitSupervisorDirective({
      ...commit,
      caseHash: 'd'.repeat(64),
    })).rejects.toMatchObject({ code: 'STALE_SUPERVISOR_CASE' });
  });

  it('halts a guarded plan on its first postcondition divergence', async () => {
    const environment = new FakeEnvironment();
    environment.queue.push(raw([[1, 0], [0, 0]]));
    const core = controller(environment);
    const initial = await core.start();
    const result = await core.executeGuardedPlan({
      planId: 'two-step-plan',
      steps: [{
        ...request(initial, 'plan-action-001'),
        postcondition: { expectedFrameHash: 'f'.repeat(64) },
      }, {
        ...request(initial, 'plan-action-002'),
        postcondition: { state: 'WIN' },
      }],
    });
    expect(result.stopReason).toBe('DIVERGED');
    expect(result.completed).toHaveLength(1);
    expect(environment.stepCalls).toBe(1);
    expect(core.supervisorCaseBundle()?.case.trigger).toBe('PLAN_DIVERGENCE');
  });

  it('uses content-addressed frame blobs, detects checkpoint tampering, and resumes exactly', async () => {
    const environment = new FakeEnvironment();
    const core = controller(environment);
    const initial = await core.start();
    await core.act(request(initial, 'checkpoint-act1'));
    const checkpoint = await core.checkpoint();
    expect(checkpoint.frameBlobs).toHaveLength(1);
    expect(() => verifyArcCheckpoint(checkpoint)).not.toThrow();

    const tampered = structuredClone(checkpoint);
    (tampered.frameBlobs[0]!.frame.rows as string[])[0] = 'ff';
    expect(() => verifyArcCheckpoint(tampered)).toThrow(/checkpointHash|frame blob|frame/);

    const resumedEnvironment = new FakeEnvironment(environment.current);
    const resumed = controller(resumedEnvironment);
    const observation = await resumed.resume(checkpoint);
    expect(observation.observationHash).toBe(core.status().observationHash);
    expect(resumed.verifyReceipts()).toEqual(expect.objectContaining({ ok: true, count: 1 }));
  });

  it('snapshots and freezes mutable adapter state before hashing a checkpoint', async () => {
    const environment = new FakeEnvironment();
    const adapterState = {
      cursor: 3,
      nested: { mode: 'ready' },
      history: [1, 2],
    };
    environment.checkpoint = async () => adapterState;
    const core = controller(environment);
    await core.start();
    const checkpoint = await core.checkpoint();

    adapterState.cursor = 99;
    adapterState.nested.mode = 'mutated';
    adapterState.history.push(3);

    expect(checkpoint.environmentCheckpoint).toEqual({
      cursor: 3,
      nested: { mode: 'ready' },
      history: [1, 2],
    });
    expect(Object.isFrozen(checkpoint.environmentCheckpoint)).toBe(true);
    expect(Object.isFrozen((checkpoint.environmentCheckpoint as { nested: object }).nested)).toBe(true);
    expect(() => verifyArcCheckpoint(checkpoint)).not.toThrow();
    const roundTripped = JSON.parse(JSON.stringify(checkpoint)) as ArcCheckpoint;
    expect(() => verifyArcCheckpoint(roundTripped)).not.toThrow();

    let resumedState: unknown;
    const replacementEnvironment = new FakeEnvironment(environment.current);
    replacementEnvironment.resume = async (state) => {
      resumedState = state;
      return replacementEnvironment.current;
    };
    const replacement = controller(replacementEnvironment);
    await replacement.resume(roundTripped);
    expect(resumedState).toEqual({ cursor: 3, nested: { mode: 'ready' }, history: [1, 2] });
  });

  it('deep-freezes nested observation and frame metadata across checkpoint hashing', async () => {
    const initial = raw(
      [[0]],
      'NOT_FINISHED',
      { progress: { phase: { name: 'observation' } } },
      [{
        width: 1,
        height: 1,
        cells: [[0]],
        metadata: { progress: { phase: { name: 'frame' } } },
      }],
    );
    const core = controller(new FakeEnvironment(initial));
    await core.start();
    const checkpoint = await core.checkpoint();
    const observationPhase = (
      checkpoint.observation.metadata as { progress: { phase: { name: string } } }
    ).progress.phase;
    const framePhase = (
      checkpoint.observation.currentFrame.metadata as { progress: { phase: { name: string } } }
    ).progress.phase;

    expect(Object.isFrozen(observationPhase)).toBe(true);
    expect(Object.isFrozen(framePhase)).toBe(true);
    expect(() => { observationPhase.name = 'mutated'; }).toThrow();
    expect(() => { framePhase.name = 'mutated'; }).toThrow();
    expect(() => verifyArcCheckpoint(checkpoint)).not.toThrow();
  });

  it.each(INVALID_CHECKPOINT_MUTATIONS)(
    'rejects a rehashed checkpoint with $name before creation, hydration, or resume',
    async ({ mutate, expected }) => {
      const environment = new FakeEnvironment();
      const source = controller(environment);
      await source.start();
      const valid = await source.checkpoint();
      const tampered = rehashedCheckpoint(valid, mutate);

      expect(() => createArcCheckpoint(tampered.body)).toThrow(expected);
      expect(() => verifyArcCheckpoint(tampered.checkpoint)).toThrow(expected);

      const resumedEnvironment = new FakeEnvironment(environment.current);
      const replacement = controller(resumedEnvironment);
      await expect(replacement.resume(tampered.checkpoint)).rejects.toThrow(expected);
      expect(resumedEnvironment.resumeCalls).toBe(0);
      expect(replacement.status().phase).toBe('NEW');
    },
  );

  it('rejects a closed checkpoint before installing state or touching the adapter', async () => {
    const sourceEnvironment = new FakeEnvironment();
    const source = controller(sourceEnvironment);
    await source.start();
    const checkpoint = await source.checkpoint();
    const closed = rehashedCheckpoint(checkpoint, body => {
      body.phase = 'CLOSED';
      body.closed = true;
    }).checkpoint;
    expect(() => verifyArcCheckpoint(closed)).not.toThrow();

    const replacementEnvironment = new FakeEnvironment(sourceEnvironment.current);
    const replacement = controller(replacementEnvironment);
    await expect(replacement.resume(closed)).rejects.toMatchObject({
      code: 'CLOSED_CHECKPOINT',
    });
    expect(replacementEnvironment.resetCalls).toBe(0);
    expect(replacementEnvironment.resumeCalls).toBe(0);
    expect(replacementEnvironment.closeCalls).toBe(0);
    expect(replacement.status().phase).toBe('NEW');

    await replacement.close();
    expect(replacementEnvironment.closeCalls).toBe(1);
  });

  it('rejects a rehashed checkpoint with an injected active STOP directive', async () => {
    const environment = new FakeEnvironment();
    const core = controller(environment);
    await core.start();
    const checkpoint = await core.checkpoint();
    const fakeDirectiveBase = {
      principalScope: checkpoint.principalScope,
      opaqueGameScope: checkpoint.opaqueGameScope,
      runId: checkpoint.runId,
      caseId: `supervisor_case_${'c'.repeat(32)}`,
      caseHash: 'c'.repeat(64),
      expectedObservationHash: checkpoint.observation.observationHash,
      observationHash: checkpoint.observation.observationHash,
      trigger: 'MODEL_CONTRADICTION' as const,
      mode: 'STOP' as const,
      diagnosis: 'Injected stop',
      requiredEvidence: [] as const,
      prohibitedEdges: [] as const,
      actionBudget: 0,
      expiresAfterActions: 0,
      hypotheses: undefined,
      recommendedStrategy: undefined,
      constraints: undefined,
      committedAtSequence: checkpoint.receipts.length,
      commitHash: 'd'.repeat(64),
    };
    const fakeDirectiveId =
      `supervisor_directive_${hashArcValue(fakeDirectiveBase).slice(0, 32)}`;
    const fakeDirectiveBody = { id: fakeDirectiveId, ...fakeDirectiveBase };
    const fakeDirective = {
      ...fakeDirectiveBody,
      directiveHash: hashArcValue(fakeDirectiveBody),
    };
    const { checkpointHash: _checkpointHash, ...checkpointBody } = checkpoint;
    const injectedBody = {
      ...checkpointBody,
      directives: [fakeDirective],
      activeDirectiveId: fakeDirectiveId,
    };
    const injected = {
      ...injectedBody,
      checkpointHash: hashArcValue(injectedBody),
    };

    expect(() => verifyArcCheckpoint(injected)).toThrow(/backing case/);
    const replacement = controller(new FakeEnvironment(environment.current));
    await expect(replacement.resume(injected)).rejects.toThrow(/backing case/);
    expect(replacement.status().phase).toBe('NEW');
  });

  it('requires explicit game identity for resume, preventing same-grid cross-game import', async () => {
    const environment = new FakeEnvironment();
    const source = controller(environment);
    await source.start();
    const checkpoint = await source.checkpoint();
    const implicit = new ArcController({
      principalId: 'principal one',
      runId: 'private run one',
      environment: new FakeEnvironment(raw(undefined, 'NOT_FINISHED', { gameId: 'other-game' })),
      runManifest: checkpoint.runManifest,
    });
    await expect(implicit.resume(checkpoint)).rejects.toMatchObject({
      code: 'RESUME_REQUIRES_GAME_VERSION_HASH',
    });
  });

  it('rejects observe-only replacement resume even when a new session has the same visible frame', async () => {
    const oldSession = raw([[0]], 'NOT_FINISHED', { guid: 'old-opaque-session' });
    const sourceState = { current: oldSession };
    const sourceEnvironment: ArcEnvironment = {
      async reset() { return sourceState.current; },
      async observe() { return sourceState.current; },
      async step() { return sourceState.current; },
      // Deliberately no checkpoint/resume support.
    };
    const source = controller(sourceEnvironment);
    await source.start();
    const checkpoint = await source.checkpoint();
    expect(checkpoint.environmentCheckpoint).toBeNull();
    const roundTripped = JSON.parse(JSON.stringify(checkpoint)) as ArcCheckpoint;
    expect(roundTripped.environmentCheckpoint).toBeNull();
    expect(() => verifyArcCheckpoint(roundTripped)).not.toThrow();

    let observeCalls = 0;
    let resumeCalls = 0;
    const newSession = raw([[0]], 'NOT_FINISHED', { guid: 'new-opaque-session' });
    const replacementEnvironment: ArcEnvironment = {
      async reset() { return newSession; },
      async observe() { observeCalls++; return newSession; },
      async step() { return newSession; },
      async resume() { resumeCalls++; return newSession; },
    };
    const replacement = controller(replacementEnvironment);
    await expect(replacement.resume(roundTripped)).rejects.toMatchObject({
      code: 'LIVE_RESUME_UNAVAILABLE',
    });
    expect(observeCalls).toBe(0);
    expect(resumeCalls).toBe(0);
    expect(replacement.status().phase).toBe('NEW');
  });

  it('never exposes raw environment failures in plan output, status, or checkpoint', async () => {
    const sentinel = 'gameId=SECRET-GAME guid=TOP-GUID https://secret.example token=sk-secret';
    const environment = new FakeEnvironment(raw([[0]], 'NOT_FINISHED', {
      guid: { gameId: 'SECRET-GAME', title: 'SECRET-TITLE', version: 'SECRET-VERSION' },
    }));
    environment.stepHook = async () => { throw new Error(sentinel); };
    const core = controller(environment);
    const initial = await core.start();
    const plan = await core.executeGuardedPlan({
      planId: 'private-failure-plan',
      steps: [{ ...request(initial, 'private-fail-01'), postcondition: { state: 'WIN' } }],
    });
    const checkpoint = await core.checkpoint();
    const publicJson = JSON.stringify({ plan, status: core.status(), checkpoint });
    expect(publicJson).not.toContain('SECRET-GAME');
    expect(publicJson).not.toContain('TOP-GUID');
    expect(publicJson).not.toContain('secret.example');
    expect(publicJson).not.toContain('sk-secret');
    expect(plan.error).toBe('ENVIRONMENT_STEP_FAILED');
    expect(core.status().lastError).toBe('ENVIRONMENT_STEP_FAILED');
    expect(core.status().uncertainMutationCount).toBe(1);
    expect(checkpoint.uncertainMutationCount).toBe(1);
    expect(core.reconcileReceipts({
      actionCount: 0,
      resetCount: 0,
      expectedReceiptHeadHash: TRANSITION_RECEIPT_GENESIS,
    })).toMatchObject({
      ok: false,
      uncertainMutationCount: 1,
      reason: 'one or more dispatched environment mutations are uncertain',
    });
    expect(containsRawGameIdentityKey({ plan, status: core.status(), checkpoint })).toBe(false);
  });

  it('always closes the environment exactly once even when session logging fails', async () => {
    const environment = new FakeEnvironment();
    const sessionLog = {
      async append(kind: string): Promise<void> {
        if (kind === 'arc.close') throw new Error('disk unavailable');
      },
      stateHash(): string { return SHA_A; },
    } as unknown as SessionLog;
    const core = controller(environment, { sessionLog });
    await core.start();
    await expect(core.close()).rejects.toMatchObject({ code: 'SESSION_LOG_FAILED' });
    await expect(core.close()).rejects.toMatchObject({ code: 'SESSION_LOG_FAILED' });
    await expect(core.checkpoint()).rejects.toMatchObject({ code: 'CLOSED' });
    expect(environment.closeCalls).toBe(1);
    expect(core.status().closed).toBe(true);
  });

  it('faults but returns the committed start observation when lifecycle evidence cannot persist', async () => {
    const environment = new FakeEnvironment();
    const sessionLog = {
      async append(kind: string): Promise<void> {
        if (kind === 'arc.start') throw new Error('anchor unavailable');
      },
      stateHash(): string { return SHA_A; },
    } as unknown as SessionLog;
    const core = controller(environment, { sessionLog });

    const observation = await core.start();
    expect(observation.observationHash).toBe(core.status().observationHash);
    expect(environment.resetCalls).toBe(1);
    expect(core.status()).toMatchObject({
      phase: 'FAULTED',
      stopped: true,
      uncertainMutationCount: 1,
      lastError: 'SESSION_LOG_COMPLETION_FAILED',
    });
    await expect(core.act(request(observation, 'after-failed-start-log')))
      .rejects.toMatchObject({ code: 'FAULTED' });

    const replayed = await core.start();
    expect(replayed.observationHash).toBe(observation.observationHash);
    expect(environment.resetCalls).toBe(1);
  });

  it('faults but returns the committed resume observation when lifecycle evidence cannot persist', async () => {
    const sourceEnvironment = new FakeEnvironment();
    const source = controller(sourceEnvironment);
    await source.start();
    const checkpoint = await source.checkpoint();
    const resumedEnvironment = new FakeEnvironment(sourceEnvironment.current);
    const sessionLog = {
      async append(kind: string): Promise<void> {
        if (kind === 'arc.resume') throw new Error('anchor unavailable');
      },
      stateHash(): string { return SHA_A; },
    } as unknown as SessionLog;
    const replacement = controller(resumedEnvironment, { sessionLog });

    const observation = await replacement.resume(checkpoint);
    expect(observation.observationHash).toBe(checkpoint.observation.observationHash);
    expect(resumedEnvironment.resumeCalls).toBe(1);
    expect(replacement.status()).toMatchObject({
      phase: 'FAULTED',
      stopped: true,
      uncertainMutationCount: 1,
      lastError: 'SESSION_LOG_COMPLETION_FAILED',
    });
    await expect(replacement.act(request(observation, 'after-failed-resume-log')))
      .rejects.toMatchObject({ code: 'FAULTED' });
    await expect(replacement.resume(checkpoint)).rejects.toMatchObject({ code: 'ALREADY_STARTED' });
    expect(resumedEnvironment.resumeCalls).toBe(1);
  });

  it('marks a completed environment mutation uncertain when transition evidence cannot persist', async () => {
    const environment = new FakeEnvironment();
    const sessionLog = {
      async append(kind: string): Promise<void> {
        if (kind === 'arc.transition') throw new Error('anchor unavailable');
      },
      stateHash(): string { return SHA_A; },
    } as unknown as SessionLog;
    const core = controller(environment, { sessionLog });
    const initial = await core.start();
    const input = request(initial, 'uncertain-transition-log');
    await expect(core.act(input)).rejects.toMatchObject({
      code: 'SESSION_LOG_COMPLETION_FAILED',
    });
    expect(environment.stepCalls).toBe(1);
    expect(core.status()).toMatchObject({
      phase: 'FAULTED',
      uncertainMutationCount: 1,
      lastError: 'SESSION_LOG_COMPLETION_FAILED',
    });
    await expect(core.act(input)).rejects.toMatchObject({ code: 'FAULTED' });
    expect(environment.stepCalls).toBe(1);
    expect(core.status().uncertainMutationCount).toBe(1);
    const verification = core.verifyReceipts();
    expect(verification).toMatchObject({ ok: true, count: 1 });
    if (!verification.ok) throw new Error('expected a valid committed receipt');
    expect(core.reconcileReceipts({
      actionCount: 1,
      resetCount: 0,
      expectedReceiptHeadHash: verification.headHash,
    })).toMatchObject({ ok: false, uncertainMutationCount: 1 });
  });

  it('detects receipt manifest and frame-reference tampering', async () => {
    const environment = new FakeEnvironment();
    const core = controller(environment);
    const initial = await core.start();
    const result = await core.act(request(initial, 'tamper-action-1'));
    const second = await core.act(request(result.observation, 'tamper-action-2'));
    const manifestTamper = [{ ...result.receipt, visibleModelLabel: 'another model' }];
    const frameTamper = [{ ...result.receipt, returnedFrameRefs: ['frame_fake_0'] }];
    expect(verifyTransitionReceipts(manifestTamper)).toMatchObject({ ok: false });
    expect(verifyTransitionReceipts(frameTamper)).toMatchObject({ ok: false });
    const { receiptHash: _oldHash, ...secondBody } = second.receipt;
    const changedPreObservationHash = 'e'.repeat(64);
    const discontinuousBody = {
      ...secondBody,
      preObservationHash: changedPreObservationHash,
      requestHash: hashArcValue({
        expectedObservationHash: changedPreObservationHash,
        idempotencyKey: second.receipt.idempotencyKey,
        action: second.receipt.action,
        expectation: second.receipt.expectation,
        ...(second.receipt.directiveId === undefined
          ? {}
          : { directiveId: second.receipt.directiveId }),
      }),
    };
    const discontinuous = { ...discontinuousBody, receiptHash: hashArcValue(discontinuousBody) };
    expect(verifyTransitionReceipts([result.receipt, discontinuous])).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not continue'),
    });
    expect(reconcileTransitionReceipts([result.receipt], {
      actionCount: 1,
      resetCount: 0,
      expectedReceiptHeadHash: result.receipt.receiptHash,
    })).toMatchObject({ ok: true, headMatches: true });
    expect(reconcileTransitionReceipts([result.receipt], {
      actionCount: 2,
      resetCount: 0,
      expectedReceiptHeadHash: result.receipt.receiptHash,
    })).toMatchObject({ ok: false, reason: 'official action or reset counts differ' });
  });

  it('keeps memory and supervisor commits exactly-once across completion-log failure and retry', async () => {
    const environment = new FakeEnvironment();
    const failedKinds = new Set(['arc.memory_rule', 'arc.supervisor_directive']);
    const sessionLog = {
      async append(kind: string): Promise<void> {
        if (failedKinds.has(kind)) {
          failedKinds.delete(kind);
          throw new Error('post-commit disk failure');
        }
      },
      stateHash(): string { return SHA_A; },
    } as unknown as SessionLog;
    const core = controller(environment, { sessionLog });
    const initial = await core.start();
    const transition = await core.act(request(initial, 'tx-action-0001'));
    const memoryInput = {
      scope: 'GAME' as const,
      kind: 'TRANSITION' as const,
      statement: 'The tested action preserved the final frame',
      predictedEffect: 'No final-frame change',
      supportingReceiptHashes: [transition.receipt.receiptHash],
    };
    const firstRule = await core.commitMemoryRule(memoryInput);
    const replayedRule = await core.commitMemoryRule(memoryInput);
    expect(replayedRule.ruleHash).toBe(firstRule.ruleHash);
    expect(core.queryMemory().rules).toHaveLength(1);
    expect(core.queryMemory().rules[0]!.version).toBe(1);

    const bundle = core.openSupervisorCase({
      trigger: 'MODEL_CONTRADICTION',
      evidenceReceiptHashes: [transition.receipt.receiptHash],
    })!;
    const directiveInput: SupervisorDirectiveCommit = {
      caseId: bundle.case.id,
      caseHash: bundle.case.caseHash,
      expectedObservationHash: bundle.observation.observationHash,
      mode: 'EXPAND_FRONTIER',
      diagnosis: 'The prior action model needs alternatives',
      requiredEvidence: [transition.receipt.receiptHash],
      actionBudget: 2,
      expiresAfterActions: 2,
    };
    const firstDirective = await core.commitSupervisorDirective(directiveInput);
    const replayedDirective = await core.commitSupervisorDirective(directiveInput);
    expect(replayedDirective.directiveHash).toBe(firstDirective.directiveHash);
    expect((await core.checkpoint()).directives).toHaveLength(1);
    expect(core.status().lastError).toBe('SESSION_LOG_COMPLETION_FAILED');
  });

  it('rejects budgets beyond the idempotency ledger and invalid thresholds at construction', () => {
    expect(() => controller(new FakeEnvironment(), {
      budget: { maxActions: 10_001, maxWallTimeMs: 10_000 },
    })).toThrow(/maxActions/);
    expect(() => controller(new FakeEnvironment(), {
      supervisorThresholds: { cycleWithinComponentCount: 1.5 },
    })).toThrow(/threshold/);
  });
});
