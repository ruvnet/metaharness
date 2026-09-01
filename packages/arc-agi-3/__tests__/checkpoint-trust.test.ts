import { describe, expect, it } from 'vitest';
import {
  ArcController,
  createArcCheckpoint,
  hashArcValue,
  hydrateCheckpointReceipts,
  verifyArcCheckpoint,
  type ActRequest,
  type ArcCheckpoint,
  type ArcCheckpointBody,
  type ArcEnvironment,
  type ExactArcObservation,
  type JsonValue,
  type RawArcObservation,
} from '../src/index.js';

const RAW: RawArcObservation = Object.freeze({
  state: 'NOT_FINISHED',
  levelsCompleted: 0,
  winLevels: 1,
  availableActions: Object.freeze(['ACTION1']),
  frames: Object.freeze([Object.freeze({ width: 1, height: 1, cells: Object.freeze([Object.freeze([0])]) })]),
});

class ResumableEnvironment implements ArcEnvironment {
  resumeCalls = 0;

  async reset(): Promise<RawArcObservation> { return RAW; }
  async observe(): Promise<RawArcObservation> { return RAW; }
  async step(): Promise<RawArcObservation> { return RAW; }
  async checkpoint(): Promise<JsonValue> { return { cursor: 0 }; }
  async resume(): Promise<RawArcObservation> {
    this.resumeCalls++;
    return RAW;
  }
}

function controller(
  environment: ArcEnvironment,
  maxActions = 10,
  clock?: () => number,
): ArcController {
  return new ArcController({
    principalId: 'checkpoint trust principal',
    runId: 'checkpoint trust run',
    gameVersionHash: 'checkpoint trust game',
    environment,
    budget: { maxActions, maxWallTimeMs: 60_000 },
    runManifest: {
      visibleModelLabel: 'ChatGPT UI',
      promptSnapshotHash: 'a'.repeat(64),
      toolSchemaHash: 'b'.repeat(64),
      environmentAdapterVersion: 'test-adapter-v1',
    },
    ...(clock === undefined ? {} : { clock }),
  });
}

function action(observation: ExactArcObservation, key: string): ActRequest {
  return {
    expectedObservationHash: observation.observationHash,
    idempotencyKey: key,
    action: { name: 'ACTION1' },
    expectation: {
      confidence: 0.5,
      expectedFrameHash: observation.currentFrame.frameHash,
    },
  };
}

function rehash(
  checkpoint: ArcCheckpoint,
  mutate: (body: ArcCheckpointBody) => void,
): { body: ArcCheckpointBody; checkpoint: ArcCheckpoint } {
  const clone = structuredClone(checkpoint);
  const { checkpointHash: _checkpointHash, ...body } = clone;
  mutate(body);
  return {
    body,
    checkpoint: { ...body, checkpointHash: hashArcValue(body) },
  };
}

async function rejectAtEveryCheckpointBoundary(
  source: ArcController,
  environment: ResumableEnvironment,
  mutate: (body: ArcCheckpointBody) => void,
  expected: RegExp,
): Promise<void> {
  const forged = rehash(await source.checkpoint(), mutate);
  expect(() => createArcCheckpoint(forged.body)).toThrow(expected);
  expect(() => verifyArcCheckpoint(forged.checkpoint)).toThrow(expected);
  const replacement = controller(environment);
  await expect(replacement.resume(forged.checkpoint)).rejects.toThrow(expected);
  expect(environment.resumeCalls).toBe(0);
  expect(replacement.status().phase).toBe('NEW');
}

describe('checkpoint trust boundary', () => {
  it('binds the recomputable memory head to episodes and ordered semantic rules', async () => {
    const source = controller(new ResumableEnvironment());
    const initial = await source.start();
    const transition = await source.act(action(initial, 'memory-bind-action'));
    const firstRule = await source.commitMemoryRule({
      scope: 'GAME',
      kind: 'ACTION_MAP',
      statement: 'ACTION1 is inert',
      predictedEffect: 'The exact frame remains unchanged',
      supportingReceiptHashes: [transition.receipt.receiptHash],
    });
    await source.commitMemoryRule({
      scope: 'GAME',
      kind: 'GOAL',
      statement: 'The current board still needs progress',
      predictedEffect: 'A future action must change progress',
      supportingReceiptHashes: [transition.receipt.receiptHash],
    });
    await source.commitMemoryRule({
      id: firstRule.id,
      scope: 'GAME',
      kind: 'ACTION_MAP',
      statement: 'ACTION1 remains inert',
      predictedEffect: 'The exact frame remains unchanged again',
      contradictingReceiptHashes: [transition.receipt.receiptHash],
      status: 'ACTIVE',
    });

    const valid = await source.checkpoint();
    expect(valid.memory.rules.map(rule => rule.id)).toEqual([
      firstRule.id,
      expect.not.stringMatching(firstRule.id),
      firstRule.id,
    ]);
    expect(() => verifyArcCheckpoint(valid)).not.toThrow();
    const validReplacement = controller(new ResumableEnvironment());
    await validReplacement.resume(valid);
    expect(validReplacement.queryMemory().rules).toHaveLength(3);

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => { (body.memory.rules as unknown as unknown[]) = []; },
      /memorySnapshotHash/,
    );
  });

  it('rejects duplicate canonical graph keys before a forged graph can be loaded', async () => {
    const source = controller(new ResumableEnvironment());
    const initial = await source.start();
    await source.act(action(initial, 'duplicate-graph-action'));

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => {
        const nodes = body.graph.nodes as unknown as Record<string, unknown>[];
        nodes[1] = structuredClone(nodes[0]!);
      },
      /belief graph|duplicate node/,
    );
  });

  it('rejects an internally inconsistent exact current frame', async () => {
    const source = controller(new ResumableEnvironment());
    await source.start();

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => {
        body.observation = {
          ...body.observation,
          currentFrame: {
            ...body.observation.currentFrame,
            width: 64,
            height: 64,
            rows: ['not-hex'],
          },
        };
      },
      /frame|grid|row|observation/,
    );
  });

  it('rejects transition history that exceeds its checkpoint action budget', async () => {
    const source = controller(new ResumableEnvironment());
    let observation = await source.start();
    observation = (await source.act(action(observation, 'budget-history-one'))).observation;
    await source.act(action(observation, 'budget-history-two'));

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => { body.budget = { ...body.budget, maxActions: 1 }; },
      /action budget/,
    );
  });

  it('binds every idempotency observation animation frame to its receipt', async () => {
    const source = controller(new ResumableEnvironment());
    const initial = await source.start();
    await source.act(action(initial, 'idempotency-frame-binding-action'));

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => {
        const frame = body.observation.frames[0]!;
        body.observation = {
          ...body.observation,
          frames: [frame, frame],
          currentFrame: frame,
        };
        const entry = body.idempotency[0]!;
        const compact = entry.observation;
        const blobHash = compact.frameBlobHashes[0]!;
        (body.idempotency as unknown as typeof body.idempotency[number][])[0] = {
          ...entry,
          observation: {
            ...compact,
            frameBlobHashes: [blobHash, blobHash],
            currentFrameBlobHash: blobHash,
          },
        };
      },
      /idempotency result.*receipt/,
    );
  });

  it('binds every transition receipt to the checkpoint manifest and lifetime', async () => {
    const source = controller(new ResumableEnvironment());
    const initial = await source.start();
    await source.act(action(initial, 'manifest-and-time-action'));

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => {
        (body as unknown as { runManifest: ArcCheckpointBody['runManifest'] }).runManifest = {
          ...body.runManifest,
          visibleModelLabel: 'Unrelated UI model',
        };
      },
      /receipt manifest/,
    );

    await rejectAtEveryCheckpointBoundary(
      source,
      new ResumableEnvironment(),
      body => {
        const afterReceipt = body.createdAtMs + 1;
        (body as unknown as { startedAtMs: number }).startedAtMs = afterReceipt;
        (body as unknown as { createdAtMs: number }).createdAtMs = afterReceipt;
      },
      /receipt timestamp/,
    );
  });

  it('rejects a future checkpoint creation time before environment resume', async () => {
    const source = controller(new ResumableEnvironment());
    await source.start();
    const forged = rehash(await source.checkpoint(), body => {
      (body as unknown as { createdAtMs: number }).createdAtMs += 1_000;
    });
    expect(() => createArcCheckpoint(forged.body)).not.toThrow();
    expect(() => verifyArcCheckpoint(forged.checkpoint)).not.toThrow();

    const environment = new ResumableEnvironment();
    const replacement = controller(environment, 10, () => forged.body.createdAtMs - 1);
    await expect(replacement.resume(forged.checkpoint)).rejects.toMatchObject({
      code: 'CHECKPOINT_FROM_FUTURE',
    });
    expect(environment.resumeCalls).toBe(0);
    expect(replacement.status().phase).toBe('NEW');
  });

  it('deep-freezes created, verified, and hydrated checkpoint evidence', async () => {
    const source = controller(new ResumableEnvironment());
    const initial = await source.start();
    await source.act(action(initial, 'immutable-checkpoint-action'));
    const raw = structuredClone(await source.checkpoint());
    const { checkpointHash: _checkpointHash, ...body } = raw;
    const created = createArcCheckpoint(body);
    expect(Object.isFrozen(created.observation.currentFrame.rows)).toBe(true);
    expect(Object.isFrozen(created.receipts[0]!.action)).toBe(true);
    expect(Object.isFrozen(created.frameBlobs[0]!.frame.rows)).toBe(true);

    const parsed = structuredClone(created);
    verifyArcCheckpoint(parsed);
    expect(Object.isFrozen(parsed.observation.currentFrame.rows)).toBe(true);
    expect(Object.isFrozen(parsed.receipts[0]!.action)).toBe(true);

    const hydrationInput = structuredClone(created);
    const hydrated = hydrateCheckpointReceipts(hydrationInput);
    expect(Object.isFrozen(hydrated[0]!.action)).toBe(true);
    expect(Object.isFrozen(hydrated[0]!.frames[0]!.rows)).toBe(true);
  });

  it('rejects oversized semantic-memory snapshots during create and verify', async () => {
    const source = controller(new ResumableEnvironment());
    await source.start();
    const forged = rehash(await source.checkpoint(), body => {
      (body.memory.rules as unknown as unknown[]) = Array.from({ length: 10_001 }, () => ({}));
    });
    expect(() => createArcCheckpoint(forged.body)).toThrow(/memory rules|capacity/);
    expect(() => verifyArcCheckpoint(forged.checkpoint)).toThrow(/memory rules|capacity/);
  });
});
