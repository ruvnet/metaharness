import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '../src/canonical.js';

async function checkedResult(name: string): Promise<Record<string, any>> {
  return JSON.parse(await readFile(
    new URL(`../results/${name}`, import.meta.url),
    'utf8',
  )) as Record<string, any>;
}

describe('checked benchmark claim boundaries', () => {
  it('retains the failed live pair without promoting it to an ARC claim', async () => {
    const report = await checkedResult('live-smoke-v2-paired.json');
    const [direct, avo] = report.pair.arms;

    expect(report).toMatchObject({
      benchmarkKind: 'online-public-single-game-smoke',
      claimEligible: false,
      acceptance: { passed: false },
    });
    expect(report.pair.competitionMode).toBe(false);
    expect(direct).toMatchObject({
      arm: 'direct',
      score: 3.571428571428571,
      levelsCompleted: 1,
      actionCount: 80,
      receiptVerification: { ok: true, count: 80 },
    });
    expect(avo).toMatchObject({
      arm: 'avo',
      score: direct.score,
      levelsCompleted: direct.levelsCompleted,
      actionCount: direct.actionCount,
      receiptVerification: { ok: true, count: 80 },
    });
    expect(report.pair.comparison).toMatchObject({
      avoMinusDirectScore: 0,
      avoMinusDirectLevels: 0,
      avoMinusDirectActions: 0,
    });
  });

  it('labels the long-horizon result as infrastructure-only evidence', async () => {
    const report = await checkedResult('long-horizon-v1.json');
    expect(report).toMatchObject({
      benchmarkKind: 'offline-deterministic-infrastructure',
      claimEligible: false,
      actions: 6624,
      loaded: {
        receipts: 6624,
        candidates: 6624,
        selections: 6624,
        outcomes: 6624,
      },
      receiptVerification: { ok: true, count: 6624 },
      checks: {
        actionCount: true,
        archiveCoverage: true,
        durableHashMatch: true,
        logicalCheckpointBound: true,
        descriptorBound: true,
      },
      accepted: true,
    });
    expect(report.checkpointHashes.source).toBe(report.checkpointHashes.loaded);
    const {
      generatedAt: _generatedAt,
      timingsMs: _timingsMs,
      deterministicEvidenceHash,
      reportHash,
      checkpointHashes: _checkpointHashes,
      receiptVerification,
      ...stableEvidence
    } = report;
    expect(deterministicEvidenceHash).toBe(hashCanonical({
      ...stableEvidence,
      receiptVerification: {
        ok: receiptVerification.ok,
        count: receiptVerification.count,
      },
    }));
    const { reportHash: _reportHash, ...reportBody } = report;
    expect(reportHash).toBe(hashCanonical(reportBody));
  });

  it('retains the clean live improvement while keeping the official gate closed', async () => {
    const report = await checkedResult('live-smoke-v3b-clean-paired.json');
    const [direct, avo] = report.pair.arms;

    expect(report).toMatchObject({
      benchmarkKind: 'online-public-single-game-actor-declared-clean-smoke',
      claimEligible: false,
      acceptance: {
        passed: false,
        observedExploratoryImprovement: true,
      },
    });
    expect(report.pair.competitionMode).toBe(false);
    expect(direct).toMatchObject({
      arm: 'direct',
      score: 0.3968253968253968,
      levelsCompleted: 1,
      actionCount: 80,
      levelActionCounts: [66, 14, 0, 0, 0, 0, 0],
      receiptVerification: { ok: true, count: 80 },
    });
    expect(avo).toMatchObject({
      arm: 'avo',
      score: 3.267620847961113,
      levelsCompleted: 1,
      actionCount: 80,
      levelActionCounts: [23, 57, 0, 0, 0, 0, 0],
      receiptVerification: { ok: true, count: 80 },
    });
    expect(report.pair.comparison).toMatchObject({
      outcome: 'AVO_HIGHER_SCORE',
      avoMinusDirectScore: 2.870795451135716,
      avoMinusDirectFirstLevelActions: -43,
    });

    const {
      generatedAt: _generatedAt,
      deterministicEvidenceHash,
      reportHash,
      ...deterministicEvidence
    } = report;
    expect(deterministicEvidenceHash).toBe(hashCanonical(deterministicEvidence));
    expect(reportHash).toBe(hashCanonical({
      generatedAt: report.generatedAt,
      ...deterministicEvidence,
      deterministicEvidenceHash,
    }));
  });
});
