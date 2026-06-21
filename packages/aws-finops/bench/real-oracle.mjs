// SPDX-License-Identifier: MIT
//
// REAL-TOOL oracle bench (ADR-168). Drives the actual binaries over a labeled
// Terraform corpus and validates the package's adapters + oracle against their REAL
// JSON output:
//   - terraform init + validate -json   → build gate (real)
//   - checkov -o json                   → compliance gate via parsePolicyReport/newFailures (real)
//   - infracost breakdown --format json → savings gate via parseCostReport/costDelta
//                                         (real IFF INFRACOST_API_KEY is set; else skipped)
//
// The thesis under test: the deterministic oracle is the anti-hallucination spine —
// it must REJECT the traps (a patch that "saves money" by breaking the build or
// dropping encryption) at the correct gate, and PASS genuine savings on build +
// compliance. Scored as discrimination over the labeled corpus.
//
// Skip-when-absent: missing binaries ⇒ graceful skip (exit 0). Excluded from run-all
// (needs binaries + a corpus). Writes a committed receipt.
//
// Run: TERRAFORM_BIN=/path/to/terraform CHECKOV_BIN=/path/to/checkov \
//      [INFRACOST_BIN=/path INFRACOST_API_KEY=...] node bench/real-oracle.mjs

import { writeFileSync, readFileSync, existsSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePolicyReport,
  newFailures,
  parseCostReport,
  costDelta,
  verifyProposal,
  terraformBin,
  checkovBin,
  infracostBin,
  terraformAvailable,
  checkovAvailable,
} from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(here, 'corpus');
const CASES = JSON.parse(readFileSync(join(CORPUS, 'cases.json'), 'utf8')).cases;
const TF = terraformBin();
const CHECKOV = checkovBin();
const INFRACOST = infracostBin();
const INFRACOST_AUTHED = Boolean(process.env.INFRACOST_API_KEY);
const PLUGIN_CACHE = process.env.TF_PLUGIN_CACHE_DIR || join(tmpdir(), 'tfcache-finops');

if (!terraformAvailable() || !checkovAvailable()) {
  process.stdout.write(`Skipping real-oracle bench (terraform=${terraformAvailable()}, checkov=${checkovAvailable()}).\n`);
  process.exit(0);
}
try { execFileSync('mkdir', ['-p', PLUGIN_CACHE]); } catch { /* ignore */ }

// terraform init + validate -json on a copy of the dir (keeps the corpus pristine).
function tfValid(srcDir) {
  const work = mkdtempSync(join(tmpdir(), 'tfval-'));
  try {
    cpSync(srcDir, work, { recursive: true });
    execFileSync(TF, ['init', '-input=false', '-backend=false', '-no-color'], {
      cwd: work, stdio: 'ignore', timeout: 120000,
      env: { ...process.env, TF_PLUGIN_CACHE_DIR: PLUGIN_CACHE, TF_IN_AUTOMATION: '1' },
    });
    let out = '';
    try {
      out = execFileSync(TF, ['validate', '-json', '-no-color'], { cwd: work, encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      out = (e.stdout && e.stdout.toString()) || '{"valid":false}';
    }
    const j = JSON.parse(out);
    return { valid: j.valid === true, errors: j.error_count ?? (j.diagnostics?.length ?? 0) };
  } catch (e) {
    return { valid: false, errors: -1, err: String(e.message || e).slice(0, 200) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// checkov -o json on a dir → normalized PolicyReport via the package adapter.
function checkovReport(dir) {
  let out = '';
  try {
    out = execFileSync(CHECKOV, ['-d', dir, '-o', 'json', '--compact', '--quiet'], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    // checkov exits non-zero when there are failed checks — its JSON is still on stdout.
    out = (e.stdout && e.stdout.toString()) || '';
  }
  let json;
  try { json = JSON.parse(out); } catch { json = {}; }
  return parsePolicyReport(json);
}

// infracost breakdown --format json on a dir → normalized CostReport (or null).
function infracostReport(dir) {
  if (!INFRACOST_AUTHED) return null;
  try {
    const out = execFileSync(INFRACOST, ['breakdown', '--path', dir, '--format', 'json', '--no-color'], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env },
    });
    return parseCostReport(JSON.parse(out));
  } catch {
    return null;
  }
}

const results = [];
for (const c of CASES) {
  const baseDir = join(CORPUS, c.id, 'baseline');
  const patchedDir = join(CORPUS, c.id, 'patched');
  if (!existsSync(patchedDir)) continue;

  const buildBase = tfValid(baseDir);
  const buildPatched = tfValid(patchedDir);
  const polBefore = checkovReport(baseDir);
  const polAfter = checkovReport(patchedDir);
  const broke = newFailures(polBefore, polAfter);

  // Savings: real infracost delta if authed, else synthetic (clearly flagged) so the
  // oracle's earlier gates still get exercised end-to-end on the genuine cases.
  const costBase = infracostReport(baseDir);
  const costPatched = infracostReport(patchedDir);
  const realDelta = costBase && costPatched ? costDelta(costBase, costPatched) : null;
  const savingsSource = realDelta ? 'infracost' : 'synthetic (no INFRACOST_API_KEY)';
  const delta = realDelta ?? { baselineMonthlyUsd: 0, patchedMonthlyUsd: 0, diffMonthlyUsd: -1 };

  const proposal = {
    address: c.address,
    kind: c.kind,
    patchedTemplate: readFileSync(join(patchedDir, 'main.tf'), 'utf8'),
    requiresUtilizationEvidence: Boolean(c.requiresUtilizationEvidence),
    rationale: c.note || c.kind,
  };
  const utilization = c.utilization
    ? { [c.address]: { address: c.address, windowDays: c.utilization.windowDays, cpuP95: c.utilization.cpuP95 } }
    : undefined;

  // The oracle ruling on REAL build + REAL compliance (+ real-or-synthetic savings).
  const verdict = verifyProposal({
    buildOk: buildPatched.valid,
    delta,
    policyBefore: polBefore,
    policyAfter: polAfter,
    proposal,
    utilization,
  });

  // Which gate rejected (first REJECT reason), for trap-gate matching.
  const rejReason = verdict.reasons.find((r) => r.startsWith('REJECT'));
  const rejectGate = rejReason ? rejReason.split(':')[0].replace('REJECT ', '').trim() : null;

  // Expectation match. For accepts with synthetic savings, "accept" means the real
  // gates (build + compliance + evidence) passed — the savings gate is not a real claim.
  let matches;
  if (c.expect === 'reject') {
    matches = !verdict.accepted && rejectGate === c.expectGate;
  } else {
    matches = verdict.accepted; // synthetic -1 delta lets genuine cases clear the savings gate
  }

  results.push({
    id: c.id,
    expect: c.expect,
    expectGate: c.expectGate ?? null,
    build: { baselineValid: buildBase.valid, patchedValid: buildPatched.valid },
    compliance: { baselineFailed: polBefore.failed, patchedFailed: polAfter.failed, newFailures: broke },
    savings: { source: savingsSource, diffMonthlyUsd: realDelta ? realDelta.diffMonthlyUsd : null },
    oracle: { accepted: verdict.accepted, rejectGate, reasons: verdict.reasons },
    matchesExpectation: matches,
  });
  process.stdout.write(`  ${c.id.padEnd(22)} expect=${c.expect}${c.expectGate ? '@' + c.expectGate : ''}  →  ${verdict.accepted ? 'ACCEPT' : 'REJECT@' + rejectGate}  ${matches ? '✓' : '✗'}\n`);
}

// Discrimination scoring over the labeled corpus.
const accepts = results.filter((r) => r.expect === 'accept');
const rejects = results.filter((r) => r.expect === 'reject');
const tp = accepts.filter((r) => r.oracle.accepted).length; // genuine savings correctly accepted
const fn = accepts.length - tp;
const trapsCaught = rejects.filter((r) => !r.oracle.accepted && r.oracle.rejectGate === r.expectGate).length;
const trapsMissed = rejects.length - trapsCaught;
const allMatch = results.every((r) => r.matchesExpectation);

const receipt = {
  experiment: 'real-tool cost-oracle discrimination on a labeled Terraform corpus',
  tools: {
    terraform: safeVer([TF, 'version']),
    checkov: safeVer([CHECKOV, '--version']),
    infracost: INFRACOST_AUTHED ? safeVer([INFRACOST, '--version']) : 'present but unauthed (INFRACOST_API_KEY unset)',
  },
  savingsOracle: INFRACOST_AUTHED ? 'real (infracost cloud pricing)' : 'SKIPPED — synthetic delta; build+compliance+evidence gates are REAL',
  cases: results.length,
  genuineAcceptedOnRealGates: `${tp}/${accepts.length}`,
  trapsRejectedAtCorrectGate: `${trapsCaught}/${rejects.length}`,
  falseNegatives: fn,
  trapsMissed,
  allMatchExpectation: allMatch,
  results,
  note: 'Build gate = terraform init+validate -json (REAL). Compliance gate = checkov -o json via parsePolicyReport/newFailures (REAL). Savings gate = infracost breakdown via parseCostReport/costDelta — REAL only with INFRACOST_API_KEY, else a synthetic -1 delta is used so the genuine cases still exercise the earlier real gates end-to-end (no real savings is claimed in that mode). Traps are rejected by the REAL build/compliance gates regardless of the savings source.',
};
writeFileSync(join(here, 'results', 'real-oracle.json'), JSON.stringify(receipt, null, 2) + '\n');

process.stdout.write(`\nReal-tool oracle discrimination (${results.length} cases)\n`);
process.stdout.write(`  genuine accepted on real gates: ${tp}/${accepts.length}\n`);
process.stdout.write(`  traps rejected at correct gate:  ${trapsCaught}/${rejects.length}\n`);
process.stdout.write(`  savings oracle: ${receipt.savingsOracle}\n`);
process.stdout.write(`  all match expectation: ${allMatch}\n`);
process.stdout.write(`  receipt → bench/results/real-oracle.json\n`);

function safeVer(argv) {
  try { return execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 15000 }).split('\n')[0].trim(); }
  catch { return 'unknown'; }
}
