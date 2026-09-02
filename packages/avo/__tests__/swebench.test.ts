import { describe, expect, it } from 'vitest';
import { compareSWEbench, evaluateShipGate, type BenchmarkArm, type SWEbenchObservation } from '../src/index.js';

const arms: BenchmarkArm[] = ['darwin-fixed', 'avo-no-supervisor', 'avo-supervisor-memory'];

function observations(tasks = 100): SWEbenchObservation[] {
  return arms.flatMap((arm) => Array.from({ length: tasks }, (_, index) => ({
    instanceId: `task-${index}`, arm,
    resolved: index < (arm === 'darwin-fixed' ? 40 : arm === 'avo-no-supervisor' ? 45 : 49),
    costUsd: arm === 'darwin-fixed' ? 0.4 : arm === 'avo-no-supervisor' ? 0.5 : 0.56,
    wallTimeMs: arm === 'darwin-fixed' ? 100 : 300,
    policyViolations: 0,
    expectedReplayHash: `hash-${index}`, actualReplayHash: `hash-${index}`,
    rollbackCount: arm === 'darwin-fixed' ? 0 : index % 10 === 0 ? 1 : 0,
    coherenceRetention: arm === 'darwin-fixed' ? 0.7 : 0.9,
  })));
}

describe('SWE-bench three-arm contract', () => {
  it('enforces identical task sets and computes every acceptance metric', () => {
    const comparison = compareSWEbench({
      datasetKind: 'swe-bench-unseen-preregistered', model: 'fixed-model',
      reasoningConfiguration: 'fixed', tokenBudget: 1_000_000,
      evaluatorVersion: 'swebench-v1', taskSetHash: 'sha256:registered',
      observations: observations(),
    });
    const gate = evaluateShipGate(comparison);
    expect(comparison.arms['avo-supervisor-memory'].resolved).toBe(49);
    expect(gate.resolutionRelativeLift).toBeCloseTo(0.225);
    expect(gate.ship).toBe(true);
  });

  it('never treats the bundled mechanism fixture as product evidence', () => {
    const comparison = compareSWEbench({
      datasetKind: 'synthetic-mechanism', model: 'deterministic-fixture',
      reasoningConfiguration: 'none', tokenBudget: 0,
      evaluatorVersion: 'fixture-v1', taskSetHash: 'sha256:fixture',
      observations: observations(),
    });
    expect(evaluateShipGate(comparison)).toMatchObject({ eligibleEvidence: false, ship: false });
  });

  it('fails closed when arms do not share the same task set', () => {
    const values = observations(2);
    values.find((value) => value.arm === 'avo-no-supervisor')!.instanceId = 'different';
    expect(() => compareSWEbench({
      datasetKind: 'synthetic-mechanism', model: 'fixture', reasoningConfiguration: 'none',
      tokenBudget: 0, evaluatorVersion: 'v1', taskSetHash: 'hash', observations: values,
    })).toThrow(/identical task set/);
  });
});
