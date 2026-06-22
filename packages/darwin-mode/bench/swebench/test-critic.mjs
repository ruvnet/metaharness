// SPDX-License-Identifier: MIT
// ADR-174 L0.6 — the Test-Critic loop. The agent writes a `reproduce_bug.py` from
// the GitHub issue; we run it against the UNMODIFIED repo (in the instance Docker
// image, conformant — no gold test). A VALID repro must FAIL on the buggy code
// (it captures the bug). If it passes, the critic tells the model to rewrite until
// it produces a clean failing test. The result is a conformant "gold-test proxy"
// that downstream best-of-N / MCTS optimizes against — without ever touching the
// real FAIL_TO_PASS.
import { runConformantTests } from './conformant-tests.mjs';

const REPRO_PATH = 'reproduce_bug.py';

const SYS = `You write a single self-contained pytest file that REPRODUCES a bug from a GitHub issue.
Rules:
- Output ONLY the Python file contents — no prose, no markdown fences.
- It must import the project and assert the CORRECT (post-fix) behavior, so that on the CURRENT (buggy)
  code it FAILS with an assertion (not an import/collection error).
- Keep it minimal and fast; one focused test function. Do not edit project files.`;

function classify(out) {
  // pytest summary line semantics
  if (/\b\d+ failed\b/.test(out) && !/\berror/i.test(out.split('\n').slice(-4).join('\n'))) return 'failed'; // reproduces the bug ✓
  if (/\b\d+ passed\b/.test(out) && !/\b\d+ failed\b/.test(out)) return 'passed'; // did NOT catch the bug
  if (/no tests ran|collected 0 items/i.test(out)) return 'empty';
  return 'error'; // import/syntax/collection error
}

/**
 * Produce a validated conformant repro test. Returns
 *   { valid, repro, attempts, cost, logTail }
 * `valid=true` ⇒ the test FAILS on the unmodified repo (a usable gold-test proxy).
 *   llm   async (prompt, system) => { raw, cost }
 */
export async function buildReproTest(instanceId, problemStatement, llm, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  let feedback = '';
  let cost = 0;
  let lastTail = '';
  for (let att = 1; att <= maxAttempts; att++) {
    const prompt = `--- GitHub issue ---\n${String(problemStatement).slice(0, 6000)}\n${feedback}\n--- write ${REPRO_PATH} ---`;
    let raw = '';
    try { const r = await llm(prompt, SYS); raw = r.raw; cost += r.cost || 0; }
    catch (e) { return { valid: false, repro: '', attempts: att, cost, logTail: 'llm error: ' + (e.message || e) }; }
    const repro = raw.replace(/^```(python)?\n?|\n?```$/g, '').trim();
    const r = runConformantTests(instanceId, '', `python -m pytest -q -p no:cacheprovider ${REPRO_PATH}`, {
      extraFiles: { [REPRO_PATH]: repro }, timeoutMs: opts.timeoutMs ?? 300_000,
    });
    lastTail = r.logTail;
    const verdict = r.ran ? classify(r.logTail) : 'error';
    if (verdict === 'failed') return { valid: true, repro, attempts: att, cost, logTail: r.logTail };
    feedback = verdict === 'passed'
      ? `\n--- attempt ${att}: your test PASSED on the unmodified buggy code, so it does NOT reproduce the bug. Rewrite it to assert the CORRECT behavior described in the issue, so it FAILS on the current code. ---`
      : `\n--- attempt ${att}: your test could not run (${verdict}). Output:\n${r.logTail.slice(-800)}\nFix imports/collection so a single test function runs. ---`;
  }
  return { valid: false, repro: '', attempts: maxAttempts, cost, logTail: lastTail };
}

export { REPRO_PATH };
