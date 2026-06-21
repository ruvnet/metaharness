// SPDX-License-Identifier: MIT
//
// Run the REAL Semgrep oracle (ADR-155 Addendum A, Phase 2) on the labeled
// fixture and write a receipt. Graceful: if semgrep is not installed it prints a
// skip notice and exits 0 (so CI without semgrep stays green).
//
// Run: npm run build && SEMGREP_BIN=$(command -v semgrep) node bench/security/semgrep-oracle.mjs
//   (or just `node bench/security/semgrep-oracle.mjs` if semgrep is on PATH)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SemgrepDetectorOracle, semgrepAvailability } from '../../dist/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'semgrep');
const resultsDir = join(here, '..', 'results');

const avail = semgrepAvailability();
if (!avail.available) {
  process.stdout.write(`semgrep not available (${avail.binary}) — skipping real-oracle run.\n`);
  process.stdout.write(`install: pip install semgrep, then re-run.\n`);
  process.exit(0);
}

const oracle = new SemgrepDetectorOracle();
const rule = readFileSync(join(fixtureDir, 'rule.yaml'), 'utf8');
const labels = JSON.parse(readFileSync(join(fixtureDir, 'labels.json'), 'utf8')).labels;
const res = oracle.evaluate(rule, { dir: fixtureDir, labels });

const receipt = {
  oracle: 'semgrep',
  version: res.version,
  fixture: 'bench/security/fixtures/semgrep',
  rule: 'darwin-shield-py-eval (CWE-94)',
  labels: { vulnerable: labels.filter((l) => l.vulnerable).length, decoys: labels.filter((l) => !l.vulnerable).length },
  result: { truePositives: res.truePositives, falsePositives: res.falsePositives, falseNegatives: res.falseNegatives, precision: res.precision, recall: res.recall },
  findings: res.findings,
};
writeFileSync(join(resultsDir, 'semgrep-oracle-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real Semgrep ${res.version} on ${labels.length} labeled files:\n`);
process.stdout.write(`  TP=${res.truePositives} FP=${res.falsePositives} FN=${res.falseNegatives} precision=${res.precision} recall=${res.recall}\n`);
process.stdout.write(`  receipt → bench/results/semgrep-oracle-receipt.json\n`);
