import { describe, expect, it } from 'vitest';
import {
  ArcAvoLoop,
  type ArcAction,
  type ArcAvoContext,
  type ArcCandidatePlanDraft,
  type ArcEnvironment,
  type JsonValue,
  type RawArcObservation,
} from '../src/index.js';

const ACTIONS = 6_624;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

class StableAvoEnvironment implements ArcEnvironment {
  calls = 0;
  private readonly observation: RawArcObservation = {
    state: 'NOT_FINISHED',
    levelsCompleted: 0,
    winLevels: 1,
    availableActions: ['ACTION1'],
    frames: [{ width: 1, height: 1, cells: [[0]] }],
  };

  async reset(): Promise<RawArcObservation> { return this.observation; }
  async observe(): Promise<RawArcObservation> { return this.observation; }
  async step(_action: ArcAction): Promise<RawArcObservation> {
    this.calls += 1;
    return this.observation;
  }
  async checkpoint(): Promise<JsonValue> { return { calls: this.calls }; }
  async resume(checkpoint: JsonValue): Promise<RawArcObservation> {
    this.calls = (checkpoint as { calls: number }).calls;
    return this.observation;
  }
}

function plan(context: ArcAvoContext, index: number): ArcCandidatePlanDraft {
  const first = index === 0;
  return {
    parentCandidateId: context.lineageHeadId ?? null,
    baseObservationHash: context.observation.observationHash,
    hypothesis: 'A receipted ACTION1 no-effect transition remains safe to test.',
    citedRuleIds: first ? [] : [context.memory.rules[0]!.id],
    ruleHypotheses: first ? [{
      scope: 'GAME',
      kind: 'ACTION_MAP',
      statement: 'ACTION1 leaves this exact visible frame unchanged.',
      preconditions: ['The current exact frame matches the candidate base.'],
      predictedEffect: 'The exact frame remains unchanged.',
    }] : [],
    steps: [{
      expectedObservationHash: context.observation.observationHash,
      idempotencyKey: `avo-long-action-${index.toString().padStart(6, '0')}`,
      action: { name: 'ACTION1' },
      expectation: {
        confidence: 1,
        expectedObservationHash: context.observation.observationHash,
      },
      postcondition: {
        expectedObservationHash: context.observation.observationHash,
      },
    }],
  };
}

function makeLoop(environment: ArcEnvironment): ArcAvoLoop {
  return new ArcAvoLoop({
    controllerOptions: {
      principalId: 'avo-long-principal',
      runId: 'avo-long-public-run',
      gameVersionHash: 'avo-long-game-version',
      environment,
      runManifest: {
        visibleModelLabel: 'fixed long-horizon test planner',
        promptSnapshotHash: HASH_A,
        toolSchemaHash: HASH_B,
        environmentAdapterVersion: 'stable-long-horizon-v1',
      },
      budget: { maxActions: ACTIONS, maxWallTimeMs: 86_400_000 },
      supervisorThresholds: {
        repeatedEdgeCount: ACTIONS + 1,
        noEffectCount: ACTIONS + 1,
        noEffectWindow: ACTIONS + 1,
        predictionErrorMean: 1,
        predictionErrorWindow: ACTIONS + 1,
        stagnationWindow: ACTIONS + 1,
        cycleWithinComponentCount: ACTIONS + 1,
        coordinateProbeCount: ACTIONS + 1,
      },
      clock: () => 1_000,
    },
    config: { arm: 'AVO_FULL', maxCandidatesPerDecision: 1 },
  });
}

describe('AVO long-horizon checkpoint and restore', () => {
  it('preserves a full 6,624-action lineage beyond the former JSON limit', async () => {
    const environment = new StableAvoEnvironment();
    const loop = makeLoop(environment);
    let context = await loop.start();
    for (let index = 0; index < ACTIONS; index += 1) {
      context = (await loop.stepWithCandidates([plan(context, index)])).context;
    }

    const checkpoint = await loop.checkpoint();
    expect(environment.calls).toBe(ACTIONS);
    expect(checkpoint.coreCheckpoint.receipts).toHaveLength(ACTIONS);
    expect(checkpoint.archive.candidates).toHaveLength(ACTIONS);
    expect(checkpoint.archive.selections).toHaveLength(ACTIONS);
    expect(checkpoint.archive.outcomes).toHaveLength(ACTIONS);
    expect(checkpoint.coreCheckpoint.frameBlobs).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8')).toBeLessThan(48 * 1024 * 1024);

    const resumedEnvironment = new StableAvoEnvironment();
    const resumed = makeLoop(resumedEnvironment);
    const resumedContext = await resumed.resume(checkpoint);
    expect(resumedContext.status).toMatchObject({
      actionCount: ACTIONS,
      receiptCount: ACTIONS,
      remainingActions: 0,
      budgetExhausted: true,
    });
    expect(resumedContext.lineageHeadId).toBe(checkpoint.archive.lineageHeadId);
    expect(resumedEnvironment.calls).toBe(ACTIONS);
  }, 180_000);
});
