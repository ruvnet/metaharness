import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { loadMechanismFixture } from '../src/fixture.js';
import { createDefaultManifest } from '../src/manifest.js';
import { ScriptedMechanismDriver } from '../src/model-driver.js';
import { buildBenchmarkReport } from '../src/report.js';
import { runMechanismBenchmark } from '../src/runner.js';
import type {
  EpisodeMetrics,
  EpisodeRunContext,
  ModelDriver,
  ModelTurnRequest,
} from '../src/types.js';

describe('paired mechanism benchmark', () => {
  it('proves the mechanism, validates receipts, blinds task ids, and reproduces evidence', async () => {
    const fixture = await loadMechanismFixture();
    const manifest = createDefaultManifest({
      fixtureSuiteId: fixture.suite.suiteId,
      fixtureSuiteHash: fixture.suiteHash,
    });
    const captured: ModelTurnRequest[] = [];
    const factoryContexts: EpisodeRunContext[] = [];
    const first = await runMechanismBenchmark({
      suite: fixture.suite,
      manifest,
      generatedAt: '2026-08-22T00:00:00.000Z',
      driverFactory: context => {
        factoryContexts.push(context);
        const scripted = new ScriptedMechanismDriver();
        const capture: ModelDriver = {
          id: scripted.id,
          latencySource: scripted.latencySource,
          async turn(request) {
            captured.push(request);
            return scripted.turn(request);
          },
        };
        return capture;
      },
    });
    const second = await runMechanismBenchmark({
      suite: fixture.suite,
      manifest,
      generatedAt: '2026-08-22T00:00:00.000Z',
    });

    expect(first.acceptance.passed).toBe(true);
    expect(first.episodes).toHaveLength(
      fixture.suite.tasks.length * manifest.episodeSeeds.length * manifest.arms.length,
    );
    expect(first.aggregates.direct.meanScore).toBe(0);
    expect(first.aggregates['direct-reflection'].meanScore).toBe(0);
    expect(first.aggregates.avo.meanScore).toBe(100);
    expect(first.comparisons.avoVsDirectReflection.score).toMatchObject({
      meanDelta: 100,
      confidenceInterval: [100, 100],
      signFlipPValue: 1 / 64,
    });
    expect(first.episodes.every(episode =>
      episode.receiptVerification.ok
      && episode.receiptVerification.count === episode.actionCount)).toBe(true);
    expect(first.deterministicEvidenceHash).toBe(second.deterministicEvidenceHash);
    const checked = JSON.parse(await readFile(
      new URL('../results/mechanism-v1.json', import.meta.url),
      'utf8',
    )) as {
      deterministicEvidenceHash: string;
      acceptance: { passed: boolean; checks: Record<string, boolean> };
    };
    expect(checked.deterministicEvidenceHash).toBe(first.deterministicEvidenceHash);
    expect(checked.acceptance).toEqual(first.acceptance);
    expect(first.acceptance.checks).toMatchObject({
      completeModelUsage: true,
      noFailedModelCalls: true,
      computeProtocolMatched: true,
      computeUsageBounded: true,
    });

    for (const context of factoryContexts) {
      expect(Object.keys(context).sort()).toEqual([
        'avoConfig',
        'coreRunManifest',
        'identity',
        'manifest',
      ]);
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain('goalAction');
      expect(serialized).not.toMatch(/"task"\s*:/);
      expect(serialized).not.toContain('taskId');
      expect(serialized).not.toContain('pairId');
      expect(serialized).not.toContain('clusterId');
      for (const task of fixture.suite.tasks) {
        expect(serialized).not.toContain(task.id);
      }
    }

    for (const pair of first.randomizedOrders) {
      expect(new Set(pair.order)).toEqual(new Set(manifest.arms));
      const fingerprints = new Set(first.episodes
        .filter(episode => episode.pairId === pair.pairId)
        .map(episode => episode.initialObservationFingerprint));
      expect(fingerprints.size).toBe(1);
    }
    expect(new Set(first.randomizedOrders.map(pair => pair.order.join(','))).size).toBeGreaterThan(1);

    for (const episode of first.episodes.filter(value => value.arm === 'direct-reflection')) {
      expect(episode.model.planTurns).toBe(episode.actionCount);
      expect(episode.model.reflectionTurns).toBe(episode.actionCount);
      expect(episode.model.totalUsageUnits).toBe(324 * episode.actionCount);
    }
    for (const episode of first.episodes.filter(value => value.arm === 'avo')) {
      expect(episode.model.planTurns).toBe(episode.actionCount);
      expect(episode.model.reflectionTurns + episode.model.supervisorTurns)
        .toBe(episode.actionCount);
      expect(episode.model.totalUsageUnits).toBe(324 * episode.actionCount);
    }

    const serializedRequests = captured.map(request => JSON.stringify(request));
    for (const serialized of serializedRequests) {
      expect(serialized).not.toContain('goalAction');
      for (const task of fixture.suite.tasks) {
        expect(serialized).not.toContain(task.id);
      }
    }

    const rebuild = (episodes: readonly EpisodeMetrics[]) => buildBenchmarkReport({
      manifest,
      fixtureSuiteHash: fixture.suiteHash,
      randomizedOrders: first.randomizedOrders,
      episodes,
      generatedAt: '2026-08-22T00:00:00.000Z',
    });
    const replaceFirstModel = (
      update: (model: EpisodeMetrics['model']) => EpisodeMetrics['model'],
      arm?: EpisodeMetrics['arm'],
    ): readonly EpisodeMetrics[] => {
      let replaced = false;
      return first.episodes.map(episode => {
        if (replaced || (arm !== undefined && episode.arm !== arm)) return episode;
        replaced = true;
        return { ...episode, model: update(episode.model) };
      });
    };
    const incompleteUsage = rebuild(replaceFirstModel(model => ({
      ...model,
      usageComplete: false,
    })));
    expect(incompleteUsage.acceptance.passed).toBe(false);
    expect(incompleteUsage.acceptance.checks.completeModelUsage).toBe(false);

    const failedCall = rebuild(replaceFirstModel(model => ({
      ...model,
      failedTurnCount: 1,
    })));
    expect(failedCall.acceptance.passed).toBe(false);
    expect(failedCall.acceptance.checks.noFailedModelCalls).toBe(false);

    const mismatchedCompute = rebuild(replaceFirstModel(model => ({
      ...model,
      reflectionTurns: model.reflectionTurns + 1,
    }), 'avo'));
    expect(mismatchedCompute.acceptance.passed).toBe(false);
    expect(mismatchedCompute.acceptance.checks.computeProtocolMatched).toBe(false);

    const excessiveAvoUsage = rebuild(replaceFirstModel(model => ({
      ...model,
      usage: { ...model.usage, reasoningUnits: model.usage.reasoningUnits + 1_000_000 },
      totalUsageUnits: model.totalUsageUnits + 1_000_000,
    }), 'avo'));
    expect(excessiveAvoUsage.acceptance.passed).toBe(false);
    expect(excessiveAvoUsage.acceptance.checks.computeUsageBounded).toBe(false);
  });
});
