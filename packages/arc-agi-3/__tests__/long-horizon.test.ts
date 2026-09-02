import { describe, expect, it } from 'vitest';
import {
  ArcController,
  type ArcAction,
  type ArcEnvironment,
  type RawArcObservation,
} from '../src/index.js';

const ACTIONS = 6_624;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

class StableLongEnvironment implements ArcEnvironment {
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
    this.calls++;
    return this.observation;
  }
}

describe('long-horizon checkpoint representation', () => {
  it('content-addresses repeated exact frames across a 6,624-action run', async () => {
    const environment = new StableLongEnvironment();
    const controller = new ArcController({
      principalId: 'long-principal',
      runId: 'long-public-run',
      gameVersionHash: 'long-game-version',
      environment,
      runManifest: {
        visibleModelLabel: 'ChatGPT UI / declared OpenAI model',
        promptSnapshotHash: HASH_A,
        toolSchemaHash: HASH_B,
        environmentAdapterVersion: 'arc-agi==0.9.8;arcengine==0.9.3;bridge=v1',
      },
      budget: { maxActions: 7_000, maxWallTimeMs: 86_400_000 },
      clock: () => 1_000,
    });
    let observation = await controller.start();
    for (let index = 0; index < ACTIONS; index++) {
      const result = await controller.act({
        expectedObservationHash: observation.observationHash,
        idempotencyKey: `long-action-${index.toString().padStart(6, '0')}`,
        action: { name: 'ACTION1' },
        expectation: {
          confidence: 1,
          expectedObservationHash: observation.observationHash,
        },
      });
      observation = result.observation;
    }
    const checkpoint = await controller.checkpoint();
    const bytes = Buffer.byteLength(JSON.stringify(checkpoint), 'utf8');

    expect(environment.calls).toBe(ACTIONS);
    expect(checkpoint.receipts).toHaveLength(ACTIONS);
    expect(checkpoint.frameBlobs).toHaveLength(1);
    // Currently ~28.2 MiB; leave a deterministic margin for schema evolution.
    expect(bytes).toBeLessThan(32 * 1024 * 1024);
    expect(controller.verifyReceipts()).toEqual(expect.objectContaining({ ok: true, count: ACTIONS }));
  }, 120_000);
});
