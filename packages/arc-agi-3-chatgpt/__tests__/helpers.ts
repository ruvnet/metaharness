// SPDX-License-Identifier: MIT

import { createArcController } from '@metaharness/arc-agi-3';
import type {
  ArcAction,
  ArcController,
  ArcEnvironment,
  RawArcObservation,
} from '@metaharness/arc-agi-3';
import type { ArcControllerFactory } from '../src/types.js';

export const ACTOR_TOKEN = 'a'.repeat(64);
export const BOSS_TOKEN = 'b'.repeat(64);
export const OTHER_TOKEN = 'c'.repeat(64);
export const HASH = 'd'.repeat(64);

export class TestEnvironment implements ArcEnvironment {
  value = 0;
  stepCalls = 0;
  closeCalls = 0;

  private observation(): RawArcObservation {
    return {
      state: 'NOT_FINISHED',
      levelsCompleted: 0,
      winLevels: 1,
      availableActions: ['ACTION1', 'ACTION6'],
      frames: [{
        width: 2,
        height: 2,
        cells: [[this.value % 16, 0], [0, 0]],
        frameIndex: this.stepCalls,
      }],
    };
  }

  async reset(): Promise<RawArcObservation> {
    this.value = 0;
    this.stepCalls = 0;
    return this.observation();
  }

  async observe(): Promise<RawArcObservation> {
    return this.observation();
  }

  async step(_action: ArcAction): Promise<RawArcObservation> {
    this.stepCalls += 1;
    this.value += 1;
    return this.observation();
  }

  async checkpoint(): Promise<{ value: number; stepCalls: number }> {
    return { value: this.value, stepCalls: this.stepCalls };
  }

  async resume(checkpoint: { value?: number; stepCalls?: number }): Promise<RawArcObservation> {
    this.value = checkpoint.value ?? 0;
    this.stepCalls = checkpoint.stepCalls ?? 0;
    return this.observation();
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export interface FactoryFixture {
  factory: ArcControllerFactory;
  environments: TestEnvironment[];
  controllers: ArcController[];
  calls: number;
  factoryCloseCalls: number;
}

export function createFactoryFixture(options: {
  delay?: Promise<void>;
  failMessage?: string;
  maxActions?: number;
} = {}): FactoryFixture {
  const fixture: FactoryFixture = {
    factory: undefined as unknown as ArcControllerFactory,
    environments: [],
    controllers: [],
    calls: 0,
    factoryCloseCalls: 0,
  };
  const factory = (async ({ principalId, runId }) => {
    fixture.calls += 1;
    if (options.delay) await options.delay;
    if (options.failMessage) throw new Error(options.failMessage);
    const environment = new TestEnvironment();
    const controller = createArcController({
      principalId,
      runId,
      gameVersionHash: 'e'.repeat(64),
      environment,
      runManifest: {
        visibleModelLabel: 'ChatGPT test model',
        promptSnapshotHash: HASH,
        toolSchemaHash: HASH,
        environmentAdapterVersion: '@metaharness/arc-agi-3/test@0.1.0',
      },
      budget: { maxActions: options.maxActions ?? 10_000, maxWallTimeMs: 3_600_000 },
    });
    fixture.environments.push(environment);
    fixture.controllers.push(controller);
    return controller;
  }) as ArcControllerFactory;
  factory.close = async () => { fixture.factoryCloseCalls += 1; };
  fixture.factory = factory;
  return fixture;
}

export function toolPayload(result: { structuredContent?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.structuredContent) throw new Error(`missing structuredContent: ${JSON.stringify(result)}`);
  return result.structuredContent;
}
