import { describe, expect, it } from 'vitest';
import {
  appendTransitionReceipt,
  ArcController,
  hashArcValue,
  validateExactArcObservation,
  validateTransitionReceiptSchema,
  verifyTransitionReceipts,
  type ActRequest,
  type ArcAction,
  type ArcEnvironment,
  type ExactArcObservation,
  type RawArcObservation,
  type TransitionReceipt,
  type TransitionReceiptDraft,
} from '../src/index.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function raw(cells: readonly (readonly number[])[] = [[0, 0], [0, 0]]): RawArcObservation {
  return {
    state: 'NOT_FINISHED',
    levelsCompleted: 0,
    winLevels: 1,
    availableActions: ['ACTION1', 'ACTION6'],
    frames: [{ width: cells[0]!.length, height: cells.length, cells }],
  };
}

class ReceiptEnvironment implements ArcEnvironment {
  current = raw();
  readonly queue: RawArcObservation[] = [];
  stepCalls = 0;

  async reset(): Promise<RawArcObservation> { return this.current; }
  async observe(): Promise<RawArcObservation> { return this.current; }
  async step(_action: ArcAction): Promise<RawArcObservation> {
    this.stepCalls += 1;
    this.current = this.queue.shift() ?? this.current;
    return this.current;
  }
}

function controller(
  environment: ArcEnvironment,
  overrides: Partial<ConstructorParameters<typeof ArcController>[0]> = {},
): ArcController {
  return new ArcController({
    principalId: 'receipt validator principal',
    runId: 'receipt validator run',
    gameVersionHash: 'receipt validator game',
    environment,
    runManifest: {
      visibleModelLabel: 'ChatGPT UI',
      promptSnapshotHash: SHA_A,
      toolSchemaHash: SHA_B,
      environmentAdapterVersion: 'test-adapter-v1',
    },
    ...overrides,
  });
}

function request(observation: ExactArcObservation, idempotencyKey: string): ActRequest {
  return {
    expectedObservationHash: observation.observationHash,
    idempotencyKey,
    action: { name: 'ACTION1' },
    expectation: {
      confidence: 0.5,
      expectedFrameHash: observation.currentFrame.frameHash,
    },
  };
}

function rehash(
  source: TransitionReceipt,
  mutate: (receipt: Record<string, unknown>) => void,
  requestChanged = false,
): TransitionReceipt {
  const receipt = structuredClone(source) as unknown as Record<string, unknown>;
  mutate(receipt);
  if (requestChanged) {
    receipt.requestHash = hashArcValue({
      expectedObservationHash: receipt.preObservationHash,
      idempotencyKey: receipt.idempotencyKey,
      action: receipt.action,
      expectation: receipt.expectation,
      ...(receipt.directiveId === undefined ? {} : { directiveId: receipt.directiveId }),
    });
  }
  const { receiptHash: _receiptHash, ...body } = receipt;
  return { ...body, receiptHash: hashArcValue(body) } as unknown as TransitionReceipt;
}

describe('strict transition receipt verification', () => {
  it('accepts genuine receipts and exact observations', async () => {
    const environment = new ReceiptEnvironment();
    environment.queue.push(raw([[1, 0], [0, 0]]), raw([[1, 2], [0, 0]]));
    const core = controller(environment);
    const initial = await core.start();
    const first = await core.act(request(initial, 'receipt-action-0001'));
    const second = await core.act(request(first.observation, 'receipt-action-0002'));

    expect(() => validateExactArcObservation(second.observation)).not.toThrow();
    expect(() => validateTransitionReceiptSchema(first.receipt)).not.toThrow();
    expect(verifyTransitionReceipts([first.receipt, second.receipt])).toMatchObject({
      ok: true,
      count: 2,
      headHash: second.receipt.receiptHash,
    });

    const {
      schema: _schema,
      previousReceiptHash: _previousReceiptHash,
      receiptHash: _receiptHash,
      ...draft
    } = first.receipt;
    expect(appendTransitionReceipt([], draft)).toEqual(first.receipt);
    const mutableDraft = structuredClone(draft);
    const snapshotted = appendTransitionReceipt([], mutableDraft);
    (mutableDraft.expectation as { expectedFrameHash?: string }).expectedFrameHash = 'f'.repeat(64);
    expect(snapshotted.expectation.expectedFrameHash).toBe(
      first.receipt.expectation.expectedFrameHash,
    );
    expect(Object.isFrozen(snapshotted.expectation)).toBe(true);
    expect(() => appendTransitionReceipt([], {
      ...draft,
      createdAtMs: Number.MAX_VALUE,
    } as TransitionReceiptDraft)).toThrow(/timestamp/);
  });

  it('rejects rehashed schema, scalar, action, expectation, frame, and metric attacks', async () => {
    const environment = new ReceiptEnvironment();
    environment.queue.push(raw([[1, 0], [0, 0]]), raw([[1, 2], [0, 0]]));
    const core = controller(environment);
    const initial = await core.start();
    const first = await core.act(request(initial, 'receipt-tamper-0001'));
    const second = await core.act(request(first.observation, 'receipt-tamper-0002'));

    const singleAttacks: readonly TransitionReceipt[] = [
      rehash(first.receipt, receipt => { receipt.injected = true; }),
      rehash(first.receipt, receipt => { receipt.createdAtMs = Number.MAX_VALUE; }),
      rehash(first.receipt, receipt => { receipt.idempotencyKey = 'bad key'; }, true),
      rehash(first.receipt, receipt => {
        receipt.action = { name: 'ACTION1', x: 1 };
      }, true),
      rehash(first.receipt, receipt => {
        receipt.expectation = { ...(receipt.expectation as object), injected: true };
      }, true),
      rehash(first.receipt, receipt => {
        const frames = receipt.frames as { rows: string[] }[];
        frames[0]!.rows[0] = 'zz';
      }),
      rehash(first.receipt, receipt => { receipt.returnedFrameRefs = []; }),
      rehash(first.receipt, receipt => { receipt.noEffect = true; }),
      rehash(first.receipt, receipt => { receipt.episodeId = `episode_${'f'.repeat(32)}`; }),
      rehash(first.receipt, receipt => { receipt.visibleModelLabel = 'different model'; }),
      rehash(first.receipt, receipt => { receipt.stateBefore = 'WIN'; }),
      rehash(first.receipt, receipt => {
        receipt.preBeliefKey = `belief_${'f'.repeat(64)}`;
        receipt.episodeId = `episode_${hashArcValue({
          principalScope: receipt.principalScope,
          opaqueGameScope: receipt.opaqueGameScope,
          runId: receipt.runId,
          sequence: receipt.sequence,
          preBeliefKey: receipt.preBeliefKey,
          postBeliefKey: receipt.postBeliefKey,
        }).slice(0, 32)}`;
      }),
    ];
    for (const attack of singleAttacks) {
      expect(verifyTransitionReceipts([attack])).toMatchObject({ ok: false, brokenAt: 0 });
    }

    const wrongDelta = rehash(second.receipt, receipt => { receipt.exactDelta = []; });
    const wrongPrediction = rehash(second.receipt, receipt => {
      receipt.predictionError = (receipt.predictionError as number) === 0 ? 1 : 0;
    });
    const backwardsTime = rehash(second.receipt, receipt => {
      receipt.createdAtMs = first.receipt.createdAtMs - 1;
    });
    for (const attack of [wrongDelta, wrongPrediction, backwardsTime]) {
      expect(verifyTransitionReceipts([first.receipt, attack])).toMatchObject({
        ok: false,
        brokenAt: 1,
      });
    }
  });

  it('rejects direct ActRequest extensions but preserves projected guarded plans', async () => {
    const directEnvironment = new ReceiptEnvironment();
    const direct = controller(directEnvironment);
    const initial = await direct.start();
    await expect(direct.act({
      ...request(initial, 'request-extra-0001'),
      postcondition: { state: 'NOT_FINISHED' },
    } as unknown as ActRequest)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(directEnvironment.stepCalls).toBe(0);

    const planEnvironment = new ReceiptEnvironment();
    const planned = controller(planEnvironment);
    const planInitial = await planned.start();
    const result = await planned.executeGuardedPlan({
      planId: 'valid projected plan',
      steps: [{
        ...request(planInitial, 'request-plan-0001'),
        postcondition: { expectedObservationHash: planInitial.observationHash },
      }],
    });
    expect(result).toMatchObject({ stopReason: 'COMPLETED' });
    expect(planEnvironment.stepCalls).toBe(1);
    expect(planned.verifyReceipts()).toMatchObject({ ok: true, count: 1 });
  });

  it('returns a failure instead of throwing for cyclic or hostile collections', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => verifyTransitionReceipts([cyclic as unknown as TransitionReceipt])).not.toThrow();
    expect(verifyTransitionReceipts([cyclic as unknown as TransitionReceipt])).toMatchObject({
      ok: false,
      brokenAt: 0,
    });

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expect(() => verifyTransitionReceipts(
      revoked.proxy as unknown as readonly TransitionReceipt[],
    )).not.toThrow();
    expect(verifyTransitionReceipts(
      revoked.proxy as unknown as readonly TransitionReceipt[],
    )).toMatchObject({ ok: false });
  });

  it('rejects unsafe integers from generic adapters and actor expectations', async () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    const invalidObservations: readonly RawArcObservation[] = [
      { ...raw(), levelsCompleted: unsafe },
      { ...raw(), winLevels: unsafe },
      {
        ...raw(),
        frames: [{ width: 2, height: 2, cells: [[0, 0], [0, 0]], frameIndex: unsafe }],
      },
    ];
    for (const invalid of invalidObservations) {
      const environment = new ReceiptEnvironment();
      environment.current = invalid;
      await expect(controller(environment).start()).rejects.toMatchObject({
        code: 'INVALID_ENVIRONMENT_OUTPUT',
      });
      expect(environment.stepCalls).toBe(0);
    }

    const environment = new ReceiptEnvironment();
    const core = controller(environment);
    const initial = await core.start();
    await expect(core.act({
      ...request(initial, 'unsafe-expectation-0001'),
      expectation: { confidence: 0.5, expectedLevelsCompleted: unsafe },
    })).rejects.toMatchObject({ code: 'INVALID_EXPECTATION' });
    expect(environment.stepCalls).toBe(0);
  });

  it('snapshots memory commits before a delayed durable intent boundary', async () => {
    let releaseIntent!: () => void;
    let signalIntent!: () => void;
    const intentReached = new Promise<void>(resolve => { signalIntent = resolve; });
    const intentRelease = new Promise<void>(resolve => { releaseIntent = resolve; });
    const sessionLog = {
      async append(kind: string): Promise<void> {
        if (kind === 'arc.memory_rule_intent') {
          signalIntent();
          await intentRelease;
        }
      },
      stateHash(): string { return SHA_A; },
    };
    const environment = new ReceiptEnvironment();
    const core = controller(environment, { sessionLog });
    const initial = await core.start();
    const transition = await core.act(request(initial, 'memory-race-action-0001'));
    const input = {
      scope: 'GAME' as const,
      kind: 'TRANSITION' as const,
      statement: 'Original stable statement',
      predictedEffect: 'Original stable prediction',
      supportingReceiptHashes: [transition.receipt.receiptHash],
    };
    const pending = core.commitMemoryRule(input);
    input.statement = 'Caller mutated statement';
    input.predictedEffect = 'Caller mutated prediction';
    input.supportingReceiptHashes[0] = 'f'.repeat(64);
    await intentReached;
    releaseIntent();

    const committed = await pending;
    expect(committed).toMatchObject({
      statement: 'Original stable statement',
      predictedEffect: 'Original stable prediction',
      supportingReceiptHashes: [transition.receipt.receiptHash],
    });
    await expect(core.commitMemoryRule({
      ...input,
      supportingReceiptHashes: [transition.receipt.receiptHash],
      injected: true,
    } as never)).rejects.toMatchObject({ code: 'INVALID_MEMORY_COMMIT' });
    expect(core.queryMemory().rules).toHaveLength(1);
  });
});
