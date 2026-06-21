// SPDX-License-Identifier: MIT
//
// Real property-fuzzer oracle (ADR-155 Addendum B Phase 2): execute real code with
// seeded random inputs, falsify the totality invariant, write a receipt. Graceful
// skip when python3 is absent (exit 0).
//
// Run: npm run build && node bench/security/fuzz-oracle.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RealFuzzOracle, pythonAvailability } from '../../dist/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, 'fixtures', 'fuzz');
const resultsDir = join(here, '..', 'results');

const avail = pythonAvailability();
if (!avail.available) {
  process.stdout.write('python3 not available — skipping real fuzz oracle.\n');
  process.exit(0);
}

const labels = JSON.parse(readFileSync(join(fixtureDir, 'labels.json'), 'utf8')).labels;
const corpus = { dir: fixtureDir, driver: 'driver.py', labels };
const oracle = new RealFuzzOracle();
const res = oracle.evaluate(corpus, { seed: 0, iterations: 5000 });

const receipt = {
  oracle: 'python-property-fuzzer',
  version: res.version,
  invariant: 'totality (target never raises on bounded inputs)',
  fixture: 'bench/security/fixtures/fuzz',
  result: { truePositives: res.truePositives, falsePositives: res.falsePositives, falseNegatives: res.falseNegatives, precision: res.precision, recall: res.recall },
  outcomes: res.outcomes,
};
writeFileSync(join(resultsDir, 'fuzz-oracle-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real fuzzer (${res.version}): TP=${res.truePositives} FP=${res.falsePositives} FN=${res.falseNegatives} precision=${res.precision}\n`);
for (const o of res.outcomes) process.stdout.write(`  ${o.file}: ${o.vulnerable ? 'vuln' : 'clean'} → ${o.falsified ? 'FALSIFIED ' + o.exceptionClass : 'holds'}\n`);
process.stdout.write(`  receipt → bench/results/fuzz-oracle-receipt.json\n`);
