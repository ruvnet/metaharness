// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { runBaseline, patchAndRetest, failureReduction, computeRates } from '../src/runner.js';
import { buildReport, renderMarkdown } from '../src/reports/report.js';
import { exampleAgentTarget, alwaysVulnerableFixture } from '../src/mock-target.js';
import { mockMarkerJudge } from '../src/judges/mock-judge.js';
import { defaultConfig } from '../src/config/loader.js';
import type { AttackFamily, RedBlueConfig, TestResult } from '../src/types.js';

function cfg(n = 25): RedBlueConfig {
  const c = defaultConfig();
  c.limits.max_tests = n;
  return c;
}

const familiesOf = (results: TestResult[], predicate: (r: TestResult) => boolean): Set<AttackFamily> =>
  new Set(results.filter(predicate).map((r) => r.family));

describe('failure_reduction math', () => {
  it('1 - patched/baseline', () => {
    expect(failureReduction(1.0, 0.2)).toBeCloseTo(0.8, 10);
    expect(failureReduction(0.5, 0.25)).toBeCloseTo(0.5, 10);
  });
  it('full reduction when patched is zero', () => {
    expect(failureReduction(0.8, 0)).toBe(1);
  });
  it('zero baseline + zero patched => 1', () => {
    expect(failureReduction(0, 0)).toBe(1);
  });
  it('clamps to [0,1]', () => {
    expect(failureReduction(0.2, 0.8)).toBe(0);
  });
});

describe('realistic example target DISCRIMINATES (true-positives AND true-negatives)', () => {
  it('does NOT find failures in every family — it passes where the target is robust', async () => {
    const baseline = await runBaseline({
      config: cfg(50),
      target: exampleAgentTarget(),
      judgeClient: mockMarkerJudge(0),
    });
    const compromisedFamilies = familiesOf(baseline.results, (r) => r.compromised);
    const passedFamilies = familiesOf(baseline.results, (r) => !r.compromised);

    // NOT a rigged 100%: there must be both findings and clean passes.
    const compromiseRate = baseline.results.filter((r) => r.compromised).length / baseline.results.length;
    expect(compromiseRate).toBeGreaterThan(0);
    expect(compromiseRate).toBeLessThan(1);

    // The two real flaws are discovered (true-positives).
    expect(compromisedFamilies.has('data_exfiltration_attempt')).toBe(true);
    expect(compromisedFamilies.has('tool_overreach')).toBe(true);

    // The hardened families are NOT flagged (true-negatives).
    expect(compromisedFamilies.has('direct_prompt_injection')).toBe(false);
    expect(compromisedFamilies.has('role_confusion')).toBe(false);
    expect(compromisedFamilies.has('cost_amplification')).toBe(false);
    expect(passedFamilies.has('direct_prompt_injection')).toBe(true);
    expect(passedFamilies.has('role_confusion')).toBe(true);
    expect(passedFamilies.has('cost_amplification')).toBe(true);
  });

  it('patches reduce the REAL findings by >= 50% without regressing the robust families', async () => {
    const config = cfg(50);
    const target = exampleAgentTarget();
    const opts = { config, target, judgeClient: mockMarkerJudge(0) };
    const baseline = await runBaseline(opts);
    const pr = await patchAndRetest(baseline, opts, 5);

    expect(pr.failureReduction).toBeGreaterThanOrEqual(0.5);
    const baseFails = baseline.results.filter((r) => r.compromised).length;
    const patchedFails = pr.patchedResults.filter((r) => r.compromised).length;
    expect(patchedFails).toBeLessThan(baseFails);
  });

  it('flags real data leakage and real tool abuse, not the robust families', async () => {
    const baseline = await runBaseline({
      config: cfg(50),
      target: exampleAgentTarget(),
      judgeClient: mockMarkerJudge(0),
    });
    expect(baseline.results.some((r) => r.dataLeakage && r.family === 'data_exfiltration_attempt')).toBe(true);
    expect(baseline.results.some((r) => r.toolAbuse && r.family === 'tool_overreach')).toBe(true);
    // cost_amplification is robust (caps at 3 tool calls) -> no tool abuse there
    expect(baseline.results.some((r) => r.toolAbuse && r.family === 'cost_amplification')).toBe(false);
  });
});

describe('always-vulnerable fixture (TEST-ONLY): full neutralization', () => {
  it('fails every family at baseline and patches drive it down by >= 50%', async () => {
    const config = cfg(25);
    const target = alwaysVulnerableFixture();
    const opts = { config, target, judgeClient: mockMarkerJudge(0) };
    const baseline = await runBaseline(opts);
    const baseFails = baseline.results.filter((r) => r.compromised).length;
    expect(baseFails).toBe(25); // rigged-bad fixture fails everything
    const pr = await patchAndRetest(baseline, opts, 5);
    expect(pr.failureReduction).toBeGreaterThanOrEqual(0.5);
  });
});

describe('report shape (realistic target)', () => {
  it('builds a JSON report with all summary fields and honest (non-100%) rates', async () => {
    const config = cfg(50);
    const target = exampleAgentTarget();
    const opts = { config, target, judgeClient: mockMarkerJudge(0) };
    const baseline = await runBaseline(opts);
    const pr = await patchAndRetest(baseline, opts, 5);
    const report = buildReport({
      runId: 'test-run',
      results: baseline.results,
      rates: baseline.rates,
      gates: config.gates,
      costUsd: baseline.costUsd + pr.costUsd,
      patchReductionRate: pr.failureReduction,
    });
    expect(report.run_id).toBe('test-run');
    expect(report.summary).toHaveProperty('tests_run');
    expect(report.summary).toHaveProperty('failures_found');
    expect(report.summary).toHaveProperty('cost_per_failure');
    expect(report.summary.failures_found).toBeGreaterThan(0);
    expect(report.summary.failures_found).toBeLessThan(report.summary.tests_run); // honest, not rigged
    expect(report.rates).toHaveProperty('compromise');
    expect(report.rates.compromise).toBeGreaterThan(0);
    expect(report.rates.compromise).toBeLessThan(1);
    expect(report.patch_reduction_rate).toBeGreaterThanOrEqual(0.5);
    const md = renderMarkdown(report);
    expect(md).toContain('Red/Blue Engagement Report');
    expect(md).toContain('uncontrolled in behavior, not capability');
  });

  it('computeRates is well-formed', async () => {
    const baseline = await runBaseline({
      config: cfg(50),
      target: exampleAgentTarget(),
      judgeClient: mockMarkerJudge(0),
    });
    const rates = computeRates(baseline.results);
    for (const v of Object.values(rates)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
