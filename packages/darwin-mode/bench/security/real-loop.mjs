// SPDX-License-Identifier: MIT
//
// Real in-loop judge (ADR-155 Addendum A Phase 2): synthesize a Semgrep rule,
// have REAL semgrep judge it vs the incumbent through the paired-bootstrap gate,
// write a receipt. Graceful skip when semgrep is absent (exit 0).
//
// Run: npm run build && SEMGREP_BIN=$(command -v semgrep) node bench/security/real-loop.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRealCandidate, semgrepAvailability } from '../../dist/security/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, 'fixtures', 'semgrep-corpus');
const resultsDir = join(here, '..', 'results');

const avail = semgrepAvailability();
if (!avail.available) {
  process.stdout.write(`semgrep not available — skipping real in-loop judge.\n`);
  process.exit(0);
}

const labels = JSON.parse(readFileSync(join(corpusDir, 'labels.json'), 'utf8')).labels;
const corpus = { dir: corpusDir, labels };
const incumbent = ['eval'];
const candidate = ['eval', 'exec', 'shell-true', 'yaml-load', 'pickle-loads'];
const v = evaluateRealCandidate(incumbent, candidate, corpus, { seed: 0 });

const receipt = {
  oracle: 'semgrep',
  version: v.version,
  corpus: 'bench/security/fixtures/semgrep-corpus',
  incumbentRule: incumbent,
  candidateRule: candidate,
  incumbentPerFileMean: v.incumbentScore,
  candidatePerFileMean: v.candidateScore,
  candidateFalsePositives: v.candidateFalsePositives,
  bootstrap: v.bootstrap,
  gates: v.gates,
  promote: v.promote,
  receiptHash: v.receiptHash,
};
writeFileSync(join(resultsDir, 'semgrep-inloop-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`Real in-loop judge (semgrep ${v.version}): incumbent ${v.incumbentScore} → candidate ${v.candidateScore}, FP ${v.candidateFalsePositives}\n`);
process.stdout.write(`  lower95 ${v.bootstrap.lower95} (p ${v.bootstrap.pValue}) → promote=${v.promote}\n`);
process.stdout.write(`  receipt → bench/results/semgrep-inloop-receipt.json\n`);
