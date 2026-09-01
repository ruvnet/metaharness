#!/usr/bin/env node

import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ArcController, hashArcValue } from '../packages/arc-agi-3/dist/index.js';
import { ArcEpisodeStore } from '../packages/arc-agi-3-chatgpt/dist/store.js';

function parseArguments(values) {
  let actions = 6_624;
  let outputPath;
  let pretty = true;
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (flag === '--compact') {
      pretty = false;
      continue;
    }
    const value = values[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--actions') actions = Number(value);
    else if (flag === '--out') outputPath = resolve(value);
    else throw new Error(`unknown option ${flag}`);
  }
  if (!Number.isSafeInteger(actions) || actions < 1 || actions > 10_000) {
    throw new Error('--actions must be an integer in 1..10000');
  }
  return { actions, outputPath, pretty };
}

const options = parseArguments(process.argv.slice(2));
const config = { arm: 'AVO_FULL', maxCandidatesPerDecision: 1 };
const rawObservation = () => ({
  state: 'NOT_FINISHED',
  levelsCompleted: 0,
  winLevels: 1,
  availableActions: ['ACTION1'],
  frames: [{ width: 1, height: 1, cells: [[0]] }],
});

class StableEnvironment {
  constructor() {
    this.current = rawObservation();
    this.calls = 0;
  }

  async reset() { return this.current; }
  async observe() { return this.current; }
  async step() { this.calls += 1; return this.current; }
  async checkpoint() { return { calls: this.calls }; }
  async resume(value) { this.calls = value.calls; return this.current; }
  async close() {}
}

const factory = async ({ principalId, runId, requestedSupervisionGate }) => {
  const environment = new StableEnvironment();
  return new ArcController({
    principalId,
    runId,
    gameVersionHash: 'long-horizon-fixture-version',
    environment,
    runManifest: {
      visibleModelLabel: 'fixed long-horizon benchmark planner',
      promptSnapshotHash: 'a'.repeat(64),
      toolSchemaHash: 'b'.repeat(64),
      environmentAdapterVersion: 'stable-long-horizon-benchmark-v1',
    },
    budget: { maxActions: options.actions, maxWallTimeMs: 86_400_000 },
    supervisionGate: requestedSupervisionGate,
    supervisorThresholds: {
      repeatedEdgeCount: options.actions + 1,
      noEffectCount: options.actions + 1,
      noEffectWindow: options.actions + 1,
      predictionErrorMean: 1,
      predictionErrorWindow: options.actions + 1,
      stagnationWindow: options.actions + 1,
      cycleWithinComponentCount: options.actions + 1,
      coordinateProbeCount: options.actions + 1,
    },
    clock: () => 1_000,
  });
};

async function emit(result) {
  const encoded = `${JSON.stringify(result, null, options.pretty ? 2 : undefined)}\n`;
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    const temporary = `${options.outputPath}.partial`;
    await writeFile(temporary, encoded, { mode: 0o600 });
    await rename(temporary, options.outputPath);
  }
  process.stdout.write(encoded);
}

async function main() {
  const stateRoot = await mkdtemp(join(tmpdir(), 'avo-long-horizon-benchmark-'));
  const store = new ArcEpisodeStore(factory, stateRoot, () => new Date(0), 1, 50_000, config);
  let restartedStore;
  try {
    const created = await store.create('avo-long-horizon-principal');
    let context = created.record.avoLoop.context();
    const actionStart = performance.now();
    for (let index = 0; index < options.actions; index += 1) {
      const first = index === 0;
      const draft = {
        parentCandidateId: context.lineageHeadId ?? null,
        baseObservationHash: context.observation.observationHash,
        hypothesis: 'A receipted ACTION1 no-effect transition remains safe to test.',
        citedRuleIds: first ? [] : [context.memory.rules[0].id],
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
          postcondition: { expectedObservationHash: context.observation.observationHash },
        }],
      };
      context = (await created.record.avoLoop.stepWithCandidates([draft])).context;
    }
    const actionMs = performance.now() - actionStart;
    const receiptVerification = created.record.controller.verifyReceipts();
    const checkpointStart = performance.now();
    const checkpoint = await created.record.avoLoop.checkpoint();
    const checkpointMs = performance.now() - checkpointStart;
    const saveStart = performance.now();
    const checkpointId = await store.saveAvoCheckpoint(created.record, checkpoint);
    const saveMs = performance.now() - saveStart;
    const principalDirectory = (await readdir(stateRoot))[0];
    const episodeDirectory = join(stateRoot, principalDirectory, created.record.episodeId);
    const descriptorPath = join(episodeDirectory, 'checkpoints', `${checkpointId}.json`);
    const descriptorBytes = (await stat(descriptorPath)).size;
    const objectCount = (await readdir(join(episodeDirectory, 'objects'))).length;

    restartedStore = new ArcEpisodeStore(factory, stateRoot, () => new Date(0), 1, 50_000, config);
    const loadStart = performance.now();
    const loaded = await restartedStore.loadAvoCheckpoint(
      'avo-long-horizon-principal',
      created.record.episodeId,
      checkpointId,
    );
    const loadMs = performance.now() - loadStart;
    const checks = {
      actionCount: receiptVerification.ok && receiptVerification.count === options.actions,
      archiveCoverage: loaded.archive.candidates.length === options.actions
        && loaded.archive.selections.length === options.actions
        && loaded.archive.outcomes.length === options.actions,
      durableHashMatch: loaded.checkpointHash === checkpoint.checkpointHash,
      logicalCheckpointBound: Buffer.byteLength(JSON.stringify(checkpoint)) < 48 * 1024 * 1024,
      descriptorBound: descriptorBytes < 64 * 1024 * 1024,
    };
    const stableEvidence = {
      benchmarkKind: 'offline-deterministic-infrastructure',
      claimEligible: false,
      claimBoundary: 'Long-horizon durability and runtime only; not an ARC score or intelligence result.',
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      actions: options.actions,
      avoConfigHash: checkpoint.config.configHash,
      checkpointHashes: {
        source: checkpoint.checkpointHash,
        loaded: loaded.checkpointHash,
      },
      storage: {
        logicalCheckpointBytes: Buffer.byteLength(JSON.stringify(checkpoint)),
        descriptorBytes,
        contentAddressedObjectCount: objectCount,
      },
      loaded: {
        receipts: loaded.coreCheckpoint.receipts.length,
        candidates: loaded.archive.candidates.length,
        selections: loaded.archive.selections.length,
        outcomes: loaded.archive.outcomes.length,
      },
      receiptVerification,
      checks,
      accepted: Object.values(checks).every(Boolean),
      hashScope: {
        deterministicEvidenceHashExcludes: [
          'generatedAt',
          'timingsMs',
          'checkpointHashes',
          'receiptVerification.headHash',
        ],
      },
      limitations: [
        'Wall-clock values are a single local measurement and are not a statistical latency claim.',
        'The stable no-effect fixture validates infrastructure scaling, not planning quality.',
      ],
    };
    const {
      checkpointHashes: _identityBoundCheckpointHashes,
      receiptVerification: stableReceiptVerification,
      ...stableHashEvidence
    } = stableEvidence;
    const reportBody = {
      schema: 'metaharness.arc_agi_3.avo_long_horizon_benchmark.v1',
      generatedAt: new Date().toISOString(),
      ...stableEvidence,
      timingsMs: { actionLoop: actionMs, checkpoint: checkpointMs, save: saveMs, load: loadMs },
      deterministicEvidenceHash: hashArcValue({
        schema: 'metaharness.arc_agi_3.avo_long_horizon_benchmark.v1',
        ...stableHashEvidence,
        receiptVerification: {
          ok: stableReceiptVerification.ok,
          count: stableReceiptVerification.count,
        },
      }),
    };
    const result = { ...reportBody, reportHash: hashArcValue(reportBody) };
    await emit(result);
    if (!result.accepted) process.exitCode = 2;
  } finally {
    await Promise.allSettled([store.closeAll(), restartedStore?.closeAll()]);
    await rm(stateRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`arc-avo-long-horizon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
