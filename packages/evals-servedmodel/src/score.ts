// @metaharness/evals-servedmodel — the SCORE VECTOR and its projection onto the flywheel's four frozen axes.
//
// Mirrors evals-hle's score.ts: we measure a richer vector (mean adapted quality, cost per adapted win,
// latency, no-commit rate, anchor retention, drift risk) and PROJECT it onto the flywheel's opaque `Score`:
//   primary     = mean post-adaptation quality across the suite
//   noopRate    = fraction of tasks the micro-loop declined to adapt for (SONA quality_threshold gate —
//                 "commit more" is the frozen gate's load-bearing signal, same as evals-hle)
//   costPerWin  = cost per task where the adaptation actually cleared the quality-win bar
//   regressed   = a hard stop: structural drift risk (driftguard.ts) OR total no-commit collapse
import type { Score } from '@metaharness/flywheel';
import type { DriftRisk } from './driftguard.js';
import { driftRisky } from './driftguard.js';

export interface PerTaskResult {
  capabilityClass: 'core' | 'domain';
  afterQuality: number;
  costUsd: number;
  latencyMs: number;
  committed: boolean;
}

export interface ServedModelScore extends Score {
  meanQuality: number;
  costPerAdaptedWin: number;
  latencyMsP50: number;
  noCommitRate: number;
  /** Mean post-adaptation quality restricted to 'core' items — the retained-capability signal. */
  coreMeanQuality: number;
  driftRisk: boolean;
  n: number;
}

const COST_SENTINEL = 999;
/** A committed item counts as a "win" once it clears this quality bar (mirrors HLE's exact-match "correct"). */
const QUALITY_WIN_THRESHOLD = 0.5;

/** Aggregate per-task results (+ the static drift-risk verdict) into a ServedModelScore. */
export function projectScore(results: PerTaskResult[], risk: DriftRisk): ServedModelScore {
  const n = results.length || 1;
  const committed = results.filter((r) => r.committed);
  const noCommitRate = (n - committed.length) / n;
  const meanQuality = results.reduce((s, r) => s + (r.committed ? r.afterQuality : 0), 0) / n;

  const core = results.filter((r) => r.capabilityClass === 'core');
  const coreMeanQuality = core.length
    ? core.reduce((s, r) => s + (r.committed ? r.afterQuality : 0), 0) / core.length
    : 0;

  const wins = committed.filter((r) => r.afterQuality >= QUALITY_WIN_THRESHOLD);
  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  const costPerAdaptedWin = wins.length > 0 ? totalCost / wins.length : COST_SENTINEL;

  const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const latencyMsP50 = lat.length ? lat[Math.floor(lat.length / 2)] : 0;

  const risky = driftRisky(risk);
  const regressed = risky || noCommitRate === 1;

  return {
    primary: meanQuality,
    noopRate: noCommitRate,
    costPerWin: costPerAdaptedWin,
    regressed,
    meanQuality,
    costPerAdaptedWin,
    latencyMsP50,
    noCommitRate,
    coreMeanQuality,
    driftRisk: risky,
    n: results.length,
  };
}
