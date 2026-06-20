// SPDX-License-Identifier: MIT
//
// Real evolutionary loop (ADR-155 Addendum A Phase 2 capstone): evolve a detector
// population with REAL semgrep as the fitness oracle, certify the champion vs the
// baseline with the paired bootstrap, write a receipt. Graceful skip when semgrep
// is absent (exit 0).
//
// Run: npm run build && SEMGREP_BIN=$(command -v semgrep) node bench/security/real-evolve.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolveDetectorsReal, semgrepAvailability } from '../../dist/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, 'fixtures', 'semgrep-corpus');
const resultsDir = join(here, '..', 'results');

const avail = semgrepAvailability();
if (!avail.available) {
  process.stdout.write('semgrep not available — skipping real evolutionary loop.\n');
  process.exit(0);
}

const labels = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8')).labels;
const r = evolveDetectorsReal({ corpus: { dir: corpusDir, labels }, generations: 6, population: 6, seed: 5, baseline: ['eval'] });

const receipt = {
  oracle: 'semgrep',
  version: r.version,
  corpus: 'bench/security/fixtures/semgrep-corpus',
  config: { generations: r.generations, population: 6, seed: 5, baseline: r.baseline.patterns },
  baseline: r.baseline,
  champion: r.champion,
  learningCurve: r.history,
  lineage: r.lineage,
  evaluations: r.evaluations,
  realOracleCalls: r.oracleCalls,
  bootstrapVsBaseline: r.bootstrapVsBaseline,
  promotedOverBaseline: r.promotedOverBaseline,
  receiptHash: r.receiptHash,
};
writeFileSync(join(resultsDir, 'semgrep-evolve-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real evolution (semgrep ${r.version}): baseline mean ${r.baseline.mean} → champion mean ${r.champion.mean} (${r.champion.patterns.length} patterns, FP ${r.champion.falsePositives})\n`);
process.stdout.write(`  learning curve: ${JSON.stringify(r.history)}\n`);
process.stdout.write(`  lineage: ${r.lineage.join(' → ')}\n`);
process.stdout.write(`  bootstrap lower95 ${r.bootstrapVsBaseline.lower95} (p ${r.bootstrapVsBaseline.pValue}) → promoted ${r.promotedOverBaseline}\n`);
process.stdout.write(`  ${r.evaluations} evals, ${r.oracleCalls} real semgrep calls (cached) → receipt bench/results/semgrep-evolve-receipt.json\n`);
