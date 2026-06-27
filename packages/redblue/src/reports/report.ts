// SPDX-License-Identifier: MIT
//
// Report generation — the JSON result format and a board-readable markdown
// summary. Everything emitted here is already redacted (the runner redacts
// evidence before it reaches a result).

import type { Gates, RunRates, RunReport, TestResult } from '../types.js';
import { shouldBlockProduction } from '../judges/severity.js';

export interface BuildReportArgs {
  runId: string;
  results: TestResult[];
  rates: RunRates;
  gates: Gates;
  costUsd: number;
  patchReductionRate?: number;
  recommendations?: string[];
}

function countBand(results: TestResult[], band: TestResult['severity']): number {
  return results.filter((r) => r.severity === band).length;
}

/** Build the structured JSON report. */
export function buildReport(args: BuildReportArgs): RunReport {
  const { results, rates, gates } = args;
  const failures = results.filter((r) => r.compromised);
  const failuresFound = failures.length;
  const costPerFailure = failuresFound > 0 ? args.costUsd / failuresFound : 0;

  const gatesPassed =
    rates.compromise <= 1 && // sanity
    failures.filter((r) => r.policyViolation).length / (results.length || 1) <= gates.max_policy_violation_rate &&
    rates.data_leakage <= gates.max_data_leakage_rate &&
    rates.tool_abuse <= gates.max_tool_abuse_rate &&
    (args.patchReductionRate === undefined || args.patchReductionRate >= gates.min_patch_reduction_rate);

  const recommendations =
    args.recommendations ??
    Array.from(
      new Set(
        failures
          .map((f) => f.recommendedFix)
          .filter((x): x is string => !!x && x.trim().length > 0),
      ),
    ).slice(0, 10);

  return {
    run_id: args.runId,
    summary: {
      tests_run: results.length,
      failures_found: failuresFound,
      critical: countBand(results, 'Critical'),
      high: countBand(results, 'High'),
      med: countBand(results, 'Med'),
      low: countBand(results, 'Low'),
      info: countBand(results, 'Info'),
      cost_usd: Number(args.costUsd.toFixed(6)),
      cost_per_failure: Number(costPerFailure.toFixed(6)),
    },
    rates,
    patch_reduction_rate: args.patchReductionRate,
    should_block_production: shouldBlockProduction(results),
    gates_passed: gatesPassed,
    recommendations,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Render a board-readable markdown summary from a JSON report. */
export function renderMarkdown(report: RunReport): string {
  const s = report.summary;
  const verdict = report.should_block_production
    ? '🔴 **BLOCK PRODUCTION**'
    : report.gates_passed
      ? '🟢 **GATES PASSED**'
      : '🟡 **REVIEW REQUIRED**';

  const lines: string[] = [];
  lines.push(`# Red/Blue Engagement Report — ${report.run_id}`);
  lines.push('');
  lines.push(`**Verdict:** ${verdict}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Tests run | ${s.tests_run} |`);
  lines.push(`| Failures found | ${s.failures_found} |`);
  lines.push(`| Critical / High / Med / Low / Info | ${s.critical} / ${s.high} / ${s.med} / ${s.low} / ${s.info} |`);
  lines.push(`| Cost (USD) | $${s.cost_usd.toFixed(4)} |`);
  lines.push(`| Cost per failure | $${s.cost_per_failure.toFixed(4)} |`);
  if (report.patch_reduction_rate !== undefined) {
    lines.push(`| Patch failure reduction | ${pct(report.patch_reduction_rate)} |`);
  }
  lines.push('');
  lines.push('## Rates');
  lines.push('');
  lines.push('| Rate | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Compromise | ${pct(report.rates.compromise)} |`);
  lines.push(`| Tool abuse | ${pct(report.rates.tool_abuse)} |`);
  lines.push(`| Data leakage | ${pct(report.rates.data_leakage)} |`);
  lines.push(`| Prompt-injection success | ${pct(report.rates.prompt_injection_success)} |`);
  lines.push(`| Recovery (passed) | ${pct(report.rates.recovery)} |`);
  lines.push('');
  if (report.recommendations.length) {
    lines.push('## Recommendations');
    lines.push('');
    for (const r of report.recommendations) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  lines.push('_Defensive red/blue harness. Red actors are uncontrolled in behavior, not capability. No real credentials, live targets, or shell access were used. Sensitive outputs are redacted._');
  return lines.join('\n');
}
