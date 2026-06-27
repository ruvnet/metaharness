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
// ADR-176 throughput — per-instance container reuse. `docker run --rm` restarts the
// (large) image on EVERY repro check; an MCTS instance does up to k×turns checks
// (django-15061 took 1003s). Start one detached container per instance, `docker exec`
// each check (resetting /testbed between), remove at end → far fewer cold starts.
export function startInstanceContainer(instanceId) {
  const img = dockerImageFor(instanceId);
  try { return execSync(`docker run -d ${img} sleep infinity`, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim(); }
  catch { return null; }
}
export function stopInstanceContainer(cid) { if (cid) try { execSync(`docker rm -f ${cid}`, { stdio: 'ignore' }); } catch { /**/ } }

export function runConformantTests(instanceId, patch, testCmd, opts = {}) {
  const img = dockerImageFor(instanceId);
  const timeout = opts.timeoutMs ?? 600_000;
  const reuse = !!opts.containerId;
  // ADR-196 fix: callers that need a large machine-readable block in the output (the execution
  // tracer emits a JSON block that can exceed the default 2500-char tail; truncating it drops the
  // TRACE_BEGIN sentinel and silently breaks parseTrace) can opt into a bigger tail. Default is
  // unchanged (2500) so every other caller's behaviour is identical.
  const TAIL = Math.max(2500, opts.tailBytes ?? 2500);
  // ADR-196 fix #2 (§59): the in-container `| tail -50` LINE cap (below) is a SECOND, independent
  // truncation that the byte-tail fix above never touched. A chatty repro (django/sympy/sphinx emit
  // many lines of their own output before the tracer's sentinels) pushes TRACE_BEGIN out of the last
  // 50 lines → parseTrace finds no block → silent null seed → trace-localize is a no-op. This is why
  // it fired 8/10 on the quiet HARD-25 repros (§56) but 0/82 on the full-300 escalated set (§59).
  // Callers needing the full machine-readable block opt into a large LINE tail too (default unchanged).
  const TAILLINES = Math.max(50, opts.tailLines ?? 50);
  // optional extraFiles (e.g. reproduce_bug.py) base64-staged into /testbed before the test.
  const extra = opts.extraFiles && typeof opts.extraFiles === 'object' ? opts.extraFiles : {};
  const writeExtra = Object.entries(extra).map(([p, c]) =>
    `printf %s ${JSON.stringify(Buffer.from(String(c)).toString('base64'))} | base64 -d > ${JSON.stringify('/testbed/' + p)}`);
  // patch is base64-staged (no host mount) so the SAME script works for run --rm and exec.
  // `set -o pipefail` makes the pipeline exit = testCmd's, so we judge by EXIT CODE (works for
  // plain `python repro.py`; django/sympy testbeds ship no pytest). On reuse, reset /testbed first.
  const b64 = Buffer.from(patch || '').toString('base64');
  const script = [
    'set -o pipefail',
    'source /opt/miniconda3/bin/activate testbed',
    'cd /testbed',
    reuse ? 'git checkout -q -- . 2>/dev/null; git clean -fdq 2>/dev/null; rm -f reproduce_bug.py 2>/dev/null; true' : 'true',
    patch && patch.trim()
      ? `{ printf %s ${JSON.stringify(b64)} | base64 -d > /tmp/patch.diff && git apply -v /tmp/patch.diff 2>&1 | tail -2 || { echo "[apply-failed]"; exit 97; }; }`
      : 'true',
    ...writeExtra,
    `${testCmd} 2>&1 | tail -${TAILLINES}`,
  ].join(' && ');
  const cmd = reuse
    ? `docker exec ${opts.containerId} bash -c ${JSON.stringify(script)}`
    : `docker run --rm ${img} bash -c ${JSON.stringify(script)}`;
  const run = () => execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'], timeout, maxBuffer: 1 << 27 });
  try {
    const out = run().toString();          // exit 0 → testCmd passed
    return { ran: true, passed: true, logTail: out.slice(-TAIL) };
  } catch (e) {
    const out = String(e.stdout || e.stderr || e.message || e);
    const code = e.status;
    if (code === 97 || /\[apply-failed\]/.test(out)) return { ran: false, passed: false, logTail: 'patch apply failed\n' + out.slice(-1500) };
    // harness/env failure (image missing, docker error) = ran:false; anything else = the test
    // executed and exited non-zero (failed/raised) = ran:true, passed:false.
    const harness = /Unable to find image|docker: Error|no such image|Cannot connect to the Docker/i.test(out);
    return { ran: !harness, passed: false, logTail: out.slice(-TAIL) };
  }
}
