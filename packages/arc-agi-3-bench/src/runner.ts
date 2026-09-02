import { performance } from 'node:perf_hooks';

import {
  ArcAvoLoop,
  verifyArcCheckpoint,
  type ArcAvoConfigInput,
  type ArcRunManifest,
} from '@metaharness/arc-agi-3';

import { BenchmarkPlanner, BenchmarkSupervisor } from './bench-planner.js';
import { hashCanonical } from './canonical.js';
import { LogicalClock, MechanismEnvironment, mechanismScore } from './fixture.js';
import { assertFrozenManifest } from './manifest.js';
import {
  MeteredModelDriver,
  ModelTurnBudgetError,
  ScriptedMechanismDriver,
} from './model-driver.js';
import { buildBenchmarkReport } from './report.js';
import { shuffledArms } from './stats.js';
import {
  BENCHMARK_ARMS,
  type BenchmarkArm,
  type BenchmarkReport,
  type DriverFactory,
  type EpisodeIdentity,
  type EpisodeMetrics,
  type EpisodeRunContext,
  type FrozenBenchmarkManifest,
  type MechanismFixtureSuite,
  type MechanismTask,
} from './types.js';

function promptHash(manifest: FrozenBenchmarkManifest, arm: BenchmarkArm): string {
  if (arm === 'direct') return manifest.prompts.directHash;
  if (arm === 'direct-reflection') {
    return hashCanonical([
      manifest.prompts.directHash,
      manifest.prompts.reflectionHash,
    ]);
  }
  return hashCanonical([manifest.prompts.avoHash, manifest.prompts.supervisorHash]);
}

function configForArm(arm: BenchmarkArm): ArcAvoConfigInput {
  if (arm === 'avo') {
    return Object.freeze({
      arm: 'AVO_FULL',
      maxCandidatesPerDecision: 4,
      maxPlanSteps: 1,
    });
  }
  return Object.freeze({
    arm: 'DIRECT_ACTOR',
    maxCandidatesPerDecision: 1,
    maxPlanSteps: 1,
  });
}

function scopeNeutralObservationFingerprint(
  observation: Awaited<ReturnType<ArcAvoLoop['start']>>['observation'],
): string {
  return hashCanonical({
    state: observation.state,
    levelsCompleted: observation.levelsCompleted,
    winLevels: observation.winLevels,
    availableActions: observation.availableActions,
    frames: observation.frames.map(frame => ({
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
    })),
  });
}

function safeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function runEpisode(options: {
  readonly identity: EpisodeIdentity;
  readonly manifest: FrozenBenchmarkManifest;
  readonly suite: MechanismFixtureSuite;
  readonly task: MechanismTask;
  readonly driverFactory: DriverFactory;
}): Promise<EpisodeMetrics> {
  const { identity, manifest, suite, task } = options;
  const clock = new LogicalClock(
    1_700_000_000_000
      + identity.episodeSeed * 10_000
      + BENCHMARK_ARMS.indexOf(identity.arm) * 1_000,
  );
  const environment = new MechanismEnvironment({
    task,
    seed: identity.episodeSeed,
    actionLatencyMs: suite.actionLatencyMs,
    clock,
  });
  const coreRunManifest: ArcRunManifest = Object.freeze({
    visibleModelLabel: manifest.model.visibleModelLabel,
    promptSnapshotHash: promptHash(manifest, identity.arm),
    toolSchemaHash: manifest.toolSchemaHash,
    controllerVersion: manifest.controller.version,
    environmentAdapterVersion: manifest.environmentAdapterVersion,
  });
  const avoConfig = configForArm(identity.arm);
  const runContext: EpisodeRunContext = Object.freeze({
    identity: Object.freeze({
      pairHandle: `pair_${hashCanonical(identity.pairId).slice(0, 32)}`,
      clusterHandle: `cluster_${hashCanonical(identity.clusterId).slice(0, 32)}`,
      episodeSeed: identity.episodeSeed,
      arm: identity.arm,
      randomizedOrder: identity.randomizedOrder,
    }),
    manifest,
    coreRunManifest,
    avoConfig,
  });
  const driver = new MeteredModelDriver(
    options.driverFactory(runContext),
    manifest.budgets.maxModelTurns,
    clock,
  );
  const planner = new BenchmarkPlanner({ identity, driver });
  const supervisor = new BenchmarkSupervisor({ identity, driver });
  const loop = new ArcAvoLoop({
    controllerOptions: {
      principalId: 'arc-agi-3-bench',
      runId: `bench_${hashCanonical(identity).slice(0, 40)}`,
      gameVersionHash: hashCanonical({ suite: manifest.fixtureSuiteHash, task: task.id }),
      environment,
      runManifest: coreRunManifest,
      budget: {
        maxActions: manifest.budgets.maxActions,
        maxWallTimeMs: manifest.budgets.maxWallTimeMs,
      },
      supervisorThresholds: manifest.controller.supervisorThresholds,
      clock: clock.now,
    },
    config: avoConfig,
    planner,
    ...(identity.arm === 'avo' ? { supervisor } : {}),
  });

  const wallStarted = performance.now();
  let context = await loop.start();
  const initialObservationFingerprint = scopeNeutralObservationFingerprint(context.observation);
  let stoppedReason: EpisodeMetrics['stoppedReason'] = 'ACTION_BUDGET';
  let error: string | undefined;

  try {
    while (
      context.observation.state !== 'WIN'
      && context.observation.state !== 'GAME_OVER'
      && !loop.status().budgetExhausted
    ) {
      try {
        context = (await loop.step()).context;
      } catch (caught) {
        if (caught instanceof ModelTurnBudgetError) {
          stoppedReason = 'MODEL_TURN_BUDGET';
          break;
        }
        throw caught;
      }
    }
    if (context.observation.state === 'WIN' || context.observation.state === 'GAME_OVER') {
      stoppedReason = 'TERMINAL';
    } else if (loop.status().budgetExhausted) {
      stoppedReason = 'ACTION_BUDGET';
    }
  } catch (caught) {
    stoppedReason = 'ERROR';
    error = safeError(caught);
    try {
      context = loop.context();
    } catch {
      // Retain the last successfully materialized context.
    }
  }

  const status = loop.status();
  let receiptVerification: EpisodeMetrics['receiptVerification'];
  let resetCount = 0;
  try {
    const checkpoint = await loop.checkpoint();
    verifyArcCheckpoint(checkpoint.coreCheckpoint);
    resetCount = checkpoint.coreCheckpoint.receipts
      .filter(receipt => receipt.action.name === 'RESET').length;
    receiptVerification = {
      ok: true,
      count: checkpoint.coreCheckpoint.receipts.length,
      ...(checkpoint.coreCheckpoint.receipts.at(-1)?.receiptHash === undefined
        ? {}
        : { headHash: checkpoint.coreCheckpoint.receipts.at(-1)!.receiptHash }),
    };
  } catch (caught) {
    receiptVerification = {
      ok: false,
      count: status.receiptCount,
      reason: safeError(caught),
    };
  }
  const elapsedWallMs = performance.now() - wallStarted;
  const model = driver.summary();
  const simulatedLatencyMs = model.latencyMs + status.actionCount * suite.actionLatencyMs;
  const finalObservation = context.observation;
  const score = mechanismScore(task, finalObservation.state, status.actionCount);
  const episode: EpisodeMetrics = Object.freeze({
    ...identity,
    initialObservationFingerprint,
    finalState: finalObservation.state,
    levelsCompleted: finalObservation.levelsCompleted,
    winLevels: finalObservation.winLevels,
    score,
    actionCount: status.actionCount,
    resetCount,
    controllerEpisodeCount: status.episodeCount,
    model,
    simulatedLatencyMs,
    elapsedWallMs,
    receiptVerification: Object.freeze(receiptVerification),
    openSupervisorCaseAtEnd: status.openSupervisorCaseId !== undefined,
    ruleCount: status.ruleCount,
    stoppedReason,
    ...(error === undefined ? {} : { error }),
  });
  await loop.close();
  return episode;
}

export interface RunMechanismBenchmarkOptions {
  readonly suite: MechanismFixtureSuite;
  readonly manifest: FrozenBenchmarkManifest;
  readonly driverFactory?: DriverFactory;
  readonly generatedAt?: string;
}

export async function runMechanismBenchmark(
  options: RunMechanismBenchmarkOptions,
): Promise<BenchmarkReport> {
  assertFrozenManifest(options.manifest);
  const suiteHash = hashCanonical(options.suite);
  if (suiteHash !== options.manifest.fixtureSuiteHash) {
    throw new Error(`fixture suite hash mismatch: expected ${options.manifest.fixtureSuiteHash}, got ${suiteHash}`);
  }
  if (options.suite.suiteId !== options.manifest.fixtureSuiteId) {
    throw new Error('fixture suite id differs from the frozen manifest');
  }
  const driverFactory: DriverFactory = options.driverFactory
    ?? (() => new ScriptedMechanismDriver());
  const episodes: EpisodeMetrics[] = [];
  const randomizedOrders: { pairId: string; order: readonly BenchmarkArm[] }[] = [];

  for (const task of options.suite.tasks) {
    for (const episodeSeed of options.manifest.episodeSeeds) {
      const pairId = `${task.id}:seed-${episodeSeed}`;
      const orderSeed = Number.parseInt(hashCanonical(pairId).slice(0, 8), 16)
        ^ options.manifest.armOrderSeed;
      const order = shuffledArms(BENCHMARK_ARMS, orderSeed) as readonly BenchmarkArm[];
      randomizedOrders.push(Object.freeze({ pairId, order }));
      for (let randomizedOrder = 0; randomizedOrder < order.length; randomizedOrder += 1) {
        const arm = order[randomizedOrder]!;
        const identity: EpisodeIdentity = Object.freeze({
          pairId,
          clusterId: task.id,
          taskId: task.id,
          episodeSeed,
          arm,
          randomizedOrder,
        });
        episodes.push(await runEpisode({
          identity,
          manifest: options.manifest,
          suite: options.suite,
          task,
          driverFactory,
        }));
      }
    }
  }
  return buildBenchmarkReport({
    manifest: options.manifest,
    fixtureSuiteHash: suiteHash,
    randomizedOrders,
    episodes,
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
}
