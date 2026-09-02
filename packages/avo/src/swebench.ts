// SPDX-License-Identifier: MIT

export type BenchmarkArm = 'darwin-fixed' | 'avo-no-supervisor' | 'avo-supervisor-memory';

export interface SWEbenchTask {
  instanceId: string;
  repository: string;
  baseCommit: string;
}

export interface SWEbenchObservation {
  instanceId: string;
  arm: BenchmarkArm;
  resolved: boolean;
  costUsd: number;
  wallTimeMs: number;
  policyViolations: number;
  expectedReplayHash: string;
  actualReplayHash: string;
  rollbackCount: number;
  coherenceRetention: number;
}

export interface ArmMetrics {
  arm: BenchmarkArm;
  tasks: number;
  resolved: number;
  resolveRate: number;
  totalCostUsd: number;
  costPerAcceptedUsd: number | null;
  wallTimeMs: number;
  policyViolations: number;
  replayIntegrity: number;
  rollbackRate: number;
  coherenceRetention: number;
}

export interface SWEbenchComparison {
  schema: 1;
  datasetKind: 'synthetic-mechanism' | 'swe-bench-unseen-preregistered';
  model: string;
  reasoningConfiguration: string;
  tokenBudget: number;
  evaluatorVersion: string;
  taskSetHash: string;
  arms: Record<BenchmarkArm, ArmMetrics>;
}

export interface ShipGate {
  eligibleEvidence: boolean;
  resolutionRelativeLift: number;
  resolutionGatePassed: boolean;
  zeroViolationGatePassed: boolean;
  costIncrease: number;
  costGatePassed: boolean;
  replayGatePassed: boolean;
  ship: boolean;
  reasons: string[];
}

const ARMS: BenchmarkArm[] = ['darwin-fixed', 'avo-no-supervisor', 'avo-supervisor-memory'];

function summarize(arm: BenchmarkArm, observations: SWEbenchObservation[]): ArmMetrics {
  const resolved = observations.filter((observation) => observation.resolved).length;
  const totalCostUsd = observations.reduce((sum, observation) => sum + observation.costUsd, 0);
  return {
    arm,
    tasks: observations.length,
    resolved,
    resolveRate: observations.length === 0 ? 0 : resolved / observations.length,
    totalCostUsd,
    costPerAcceptedUsd: resolved === 0 ? null : totalCostUsd / resolved,
    wallTimeMs: observations.reduce((sum, observation) => sum + observation.wallTimeMs, 0),
    policyViolations: observations.reduce((sum, observation) => sum + observation.policyViolations, 0),
    replayIntegrity: observations.length === 0 ? 0 : observations.filter((observation) => observation.actualReplayHash === observation.expectedReplayHash).length / observations.length,
    rollbackRate: observations.length === 0 ? 0 : observations.filter((observation) => observation.rollbackCount > 0).length / observations.length,
    coherenceRetention: observations.length === 0 ? 0 : observations.reduce((sum, observation) => sum + observation.coherenceRetention, 0) / observations.length,
  };
}

export function compareSWEbench(input: Omit<SWEbenchComparison, 'schema' | 'arms'> & {
  observations: SWEbenchObservation[];
}): SWEbenchComparison {
  const idsByArm = new Map<BenchmarkArm, string[]>();
  for (const arm of ARMS) {
    const ids = input.observations.filter((value) => value.arm === arm).map((value) => value.instanceId).sort();
    if (new Set(ids).size !== ids.length) throw new Error(`avo benchmark: duplicate task in ${arm}`);
    idsByArm.set(arm, ids);
  }
  const reference = JSON.stringify(idsByArm.get('darwin-fixed'));
  if (ARMS.some((arm) => JSON.stringify(idsByArm.get(arm)) !== reference)) {
    throw new Error('avo benchmark: every arm must use the identical task set');
  }
  return {
    schema: 1,
    datasetKind: input.datasetKind,
    model: input.model,
    reasoningConfiguration: input.reasoningConfiguration,
    tokenBudget: input.tokenBudget,
    evaluatorVersion: input.evaluatorVersion,
    taskSetHash: input.taskSetHash,
    arms: Object.fromEntries(ARMS.map((arm) => [arm, summarize(arm, input.observations.filter((value) => value.arm === arm))])) as Record<BenchmarkArm, ArmMetrics>,
  };
}

export function evaluateShipGate(comparison: SWEbenchComparison): ShipGate {
  const baseline = comparison.arms['darwin-fixed'];
  const autonomous = comparison.arms['avo-supervisor-memory'];
  const resolutionRelativeLift = baseline.resolveRate === 0
    ? (autonomous.resolveRate > 0 ? Infinity : 0)
    : (autonomous.resolveRate - baseline.resolveRate) / baseline.resolveRate;
  const baselineCost = baseline.costPerAcceptedUsd ?? Infinity;
  const autonomousCost = autonomous.costPerAcceptedUsd ?? Infinity;
  const costIncrease = baselineCost === 0
    ? (autonomousCost === 0 ? 0 : Infinity)
    : (autonomousCost - baselineCost) / baselineCost;
  const eligibleEvidence = comparison.datasetKind === 'swe-bench-unseen-preregistered'
    && baseline.tasks === 100
    && autonomous.tasks === 100;
  const resolutionGatePassed = resolutionRelativeLift >= 0.2;
  const zeroViolationGatePassed = ARMS.every((arm) => comparison.arms[arm].policyViolations === 0);
  const costGatePassed = costIncrease < 0.5;
  const replayGatePassed = comparison.arms['avo-no-supervisor'].replayIntegrity === 1
    && autonomous.replayIntegrity === 1;
  const reasons: string[] = [];
  if (!eligibleEvidence) reasons.push('requires exactly 100 preregistered unseen SWE-bench tasks');
  if (!resolutionGatePassed) reasons.push('verified resolution lift is below 20%');
  if (!zeroViolationGatePassed) reasons.push('one or more policy violations were recorded');
  if (!costGatePassed) reasons.push('cost per accepted result increased by 50% or more');
  if (!replayGatePassed) reasons.push('autonomous replay integrity is below 100%');
  return {
    eligibleEvidence, resolutionRelativeLift, resolutionGatePassed,
    zeroViolationGatePassed, costIncrease, costGatePassed, replayGatePassed,
    ship: eligibleEvidence && resolutionGatePassed && zeroViolationGatePassed && costGatePassed && replayGatePassed,
    reasons,
  };
}
