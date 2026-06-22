// SPDX-License-Identifier: MIT
// ADR-173 L0.5 — the leaderboard-CONFORMANT in-loop test signal. Runs the agent's
// patch + a chosen test command inside the instance's prebuilt swebench Docker
// image (deps present, repo at /testbed, conda env `testbed`), explicitly NEVER
// applying the gold test_patch. This is the only honest in-loop signal: the bare
// git clone has no installed deps. The gold FAIL_TO_PASS is reserved for final
// scoring only — never seen here.
import { writeFileSync, mkdtempSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** instance_id → cached swebench eval image (the harness maps `__` → `_1776_`). */
export function dockerImageFor(instanceId) {
  return `swebench/sweb.eval.x86_64.${instanceId.replace(/__/g, '_1776_')}:latest`;
}

/**
 * Run `testCmd` against the agent's `patch` inside the instance image, conformant
 * (no gold test patch). Returns { ran, passed, logTail }. `ran=false` means the
 * harness/env failed (image missing, apply failed) — distinct from a test failure.
 *   patch    unified diff of the agent's SOURCE edits (git apply at /testbed)
 *   testCmd  e.g. "python -m pytest -q -x lib/foo/tests/test_bar.py"  (NOT the gold tests)
 */
export function runConformantTests(instanceId, patch, testCmd, opts = {}) {
  const img = dockerImageFor(instanceId);
  const timeout = opts.timeoutMs ?? 600_000;
  const dir = mkdtempSync(join(tmpdir(), 'cfm-'));
  const pf = join(dir, 'patch.diff');
  writeFileSync(pf, patch || '');
  // ADR-173 L0.6: optional extraFiles (e.g. a self-written reproduce_bug.py) written
  // into /testbed before the test runs — the conformant repro-test mechanism. Each is
  // base64-staged into the container (no host bind needed beyond the patch mount).
  const extra = opts.extraFiles && typeof opts.extraFiles === 'object' ? opts.extraFiles : {};
  const writeExtra = Object.entries(extra).map(([p, c]) =>
    `printf %s ${JSON.stringify(Buffer.from(String(c)).toString('base64'))} | base64 -d > ${JSON.stringify('/testbed/' + p)}`);
  // git apply the source patch (skip if empty); activate conda; stage extra files; run the test cmd.
  // `set -o pipefail` so the pipeline's exit code is testCmd's (not tail's) — lets us judge
  // pass/fail by EXIT CODE, which works for plain `python repro.py` too (django/sympy testbeds
  // ship no pytest). The apply step prints a sentinel we grep before trusting the exit code.
  const script = [
    'set -o pipefail',
    'source /opt/miniconda3/bin/activate testbed',
    'cd /testbed',
    patch && patch.trim() ? '{ git apply -v /tmp/patch.diff 2>&1 | tail -2 || { echo "[apply-failed]"; exit 97; }; }' : 'true',
    ...writeExtra,
    `${testCmd} 2>&1 | tail -50`,
  ].join(' && ');
  const run = () => execSync(`docker run --rm -v ${pf}:/tmp/patch.diff:ro ${img} bash -c ${JSON.stringify(script)}`,
    { stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1 << 27 });
  try {
    const out = run().toString();          // exit 0 → testCmd passed
    return { ran: true, passed: true, logTail: out.slice(-2500) };
  } catch (e) {
    const out = String(e.stdout || e.stderr || e.message || e);
    const code = e.status;
    if (code === 97 || /\[apply-failed\]/.test(out)) return { ran: false, passed: false, logTail: 'patch apply failed\n' + out.slice(-1500) };
    // harness/env failure (image missing, docker error) = ran:false; anything else = the test
    // executed and exited non-zero (failed/raised) = ran:true, passed:false.
    const harness = /Unable to find image|docker: Error|no such image|Cannot connect to the Docker/i.test(out);
    return { ran: !harness, passed: false, logTail: out.slice(-2500) };
  }
}
