// SPDX-License-Identifier: MIT
//
// Real-CVE-shaped benchmark (ADR-155 Addendum A Phase 2): evolve a detector
// population with REAL semgrep over an 8-CWE corpus that includes pre-fix /
// post-fix PAIRS — a detector that fires on the patched twin is a false positive,
// so the fitness landscape rewards real precision, not just recall. Writes a
// receipt; graceful skip when semgrep is absent.
//
// Run: npm run build && SEMGREP_BIN=$(command -v semgrep) node bench/security/cwe-bench.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evolveDetectorsReal, FULL_VOCABULARY, semgrepAvailability } from '../../dist/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, 'fixtures', 'cwe-bench');
const resultsDir = join(here, '..', 'results');

const avail = semgrepAvailability();
if (!avail.available) {
  process.stdout.write('semgrep not available — skipping real-CVE-shaped benchmark.\n');
  process.exit(0);
}

const meta = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8'));
const labels = meta.labels;
const SEED = 0;
const r = evolveDetectorsReal({
  corpus: { dir: corpusDir, labels },
  generations: 10,
  population: 8,
  seed: SEED,
  baseline: ['eval'],
  vocabulary: FULL_VOCABULARY,
});

const receipt = {
  oracle: 'semgrep',
  version: r.version,
  corpus: 'bench/security/fixtures/cwe-bench',
  shape: 'pre-fix/post-fix pairs + decoys (real-CVE-shaped)',
  counts: { files: labels.length, vulnerable: labels.filter((l) => l.vulnerable).length, fixedTwins: labels.filter((l) => l.fixed).length },
  config: { generations: r.generations, population: 8, seed: SEED, vocabulary: FULL_VOCABULARY },
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
writeFileSync(join(resultsDir, 'cwe-bench-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real-CVE-shaped benchmark (semgrep ${r.version}): ${labels.length} files, ${receipt.counts.vulnerable} vulns + ${receipt.counts.fixedTwins} patched twins\n`);
process.stdout.write(`  baseline mean ${r.baseline.mean} → champion mean ${r.champion.mean} (${r.champion.patterns.length}/${FULL_VOCABULARY.length} patterns, FP ${r.champion.falsePositives})\n`);
process.stdout.write(`  learning curve: ${JSON.stringify(r.history)}\n`);
process.stdout.write(`  bootstrap lower95 ${r.bootstrapVsBaseline.lower95} (p ${r.bootstrapVsBaseline.pValue}) → promoted ${r.promotedOverBaseline}\n`);
process.stdout.write(`  ${r.evaluations} evals, ${r.oracleCalls} real semgrep calls → receipt bench/results/cwe-bench-receipt.json\n`);
