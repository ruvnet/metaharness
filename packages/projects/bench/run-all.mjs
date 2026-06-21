// SPDX-License-Identifier: MIT
//
// Run every @metaharness/projects benchmark, then print a consolidated table from
// the receipts in bench/results/. Assumes the package is already built (dist/).

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = join(here, 'results');

// Real-LLM / bakeoff benches make paid API calls and are slow; run-all only runs
// the deterministic, free benches. Exclude anything matching `-llm.bench.mjs` or
// `bakeoff`. (integrated.bench.mjs stays in — it is deterministic.)
const isExcluded = (f) => /-llm\.bench\.mjs$/.test(f) || f.includes('bakeoff') || f.includes('zero-day-discovery') || f.includes('real-corpus') || f.includes('learning-loop') || f.includes('multiseed');

// Per-module benches first, then the integrated acceptance scenario last.
const benches = readdirSync(here)
  .filter((f) => f.endsWith('.bench.mjs') && f !== 'integrated.bench.mjs' && !isExcluded(f))
  .sort();
benches.push('integrated.bench.mjs');

let failures = 0;
for (const b of benches) {
  process.stdout.write(`\n─── ${b} ───\n`);
  try {
    const out = execFileSync('node', [join(here, b)], { encoding: 'utf8' });
    process.stdout.write(out);
  } catch (e) {
    failures += 1;
    process.stdout.write((e.stdout ?? '') + `\n[FAILED] ${b}: ${e.message}\n`);
  }
}

// Consolidated receipt table.
process.stdout.write('\n══════════ consolidated receipts ══════════\n');
for (const f of readdirSync(resultsDir).filter((f) => f.endsWith('.json')).sort()) {
  const r = JSON.parse(readFileSync(join(resultsDir, f), 'utf8'));
  process.stdout.write(`${f.padEnd(24)} ${JSON.stringify(summarize(r))}\n`);
}

if (failures > 0) {
  process.stdout.write(`\n${failures} benchmark(s) failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nAll benchmarks passed.\n');
}

/** Pull the headline metrics out of each receipt for the table. */
function summarize(r) {
  if (r.allPass !== undefined) return { allPass: r.allPass };
  if (r.costSavedPct !== undefined) return { costSavedPct: r.costSavedPct, reliability: r.reliability };
  if (r.projectedSavingsPct !== undefined) return { leaks: r.leaks, projectedSavingsPct: r.projectedSavingsPct };
  if (r.replayDeterministic !== undefined) return { roundTripOk: r.roundTripOk, replayDeterministic: r.replayDeterministic };
  if (r.costReductionPct !== undefined) return { costReductionPct: r.costReductionPct, allTerminated: r.allTerminated };
  if (r.tokensSavedPct !== undefined) return { tokensSavedPct: r.tokensSavedPct, solvedOn: r.solvedOn };
  if (r.trueWinnerPromoted !== undefined) return { trueWinnerPromoted: r.trueWinnerPromoted, falseWinnerPromoted: r.falseWinnerPromoted };
  if (r.retryReductionPct !== undefined) return { retryReductionPct: r.retryReductionPct };
  if (r.cheatsRejectedPct !== undefined) return { cheatsRejectedPct: r.cheatsRejectedPct, falseRejections: r.falseRejections };
  if (r.totalExpectedSaving !== undefined) return { totalExpectedSaving: r.totalExpectedSaving };
  if (r.reductionPct !== undefined) return { reductionPct: r.reductionPct, escapedDefects: r.escapedDefects };
  return r;
}
