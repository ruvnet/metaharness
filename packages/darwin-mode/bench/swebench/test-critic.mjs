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

const SYS = `You write a single self-contained Python script that REPRODUCES a bug from a GitHub issue.
Rules:
- Output ONLY the Python file contents — no prose, no markdown fences.
- Import the project and assert the CORRECT (post-fix) behavior. End with:
    if __name__ == "__main__":
        test_...()   # call your test function(s)
  so that running \`python reproduce_bug.py\` RAISES (exits non-zero) on the CURRENT buggy code and exits
  0 once fixed. Do NOT rely on pytest — many testbeds (django, sympy) don't ship it.
- The failure must be the BUG's assertion/exception, never an ImportError/ModuleNotFoundError/SyntaxError.
- Keep it minimal and fast; one focused check. Do not edit project files.`;

// Verdict from runConformantTests({ran,passed,logTail}). Exit-code based now:
// passed (exit 0) = the test ran clean on buggy code → did NOT catch the bug.
// exit non-zero = raised; distinguish a real bug-reproduction from a broken test (import/syntax).
function classify(r) {
  if (r.passed) return 'passed';
  const out = (r.logTail || '').replace(/\x1b\[[0-9;]*m/g, '');
  if (/ModuleNotFoundError|ImportError|SyntaxError|IndentationError|NameError|cannot import name|No module named/i.test(out)) return 'error';
  if (/no tests ran|collected 0 items/i.test(out)) return 'empty';
  return 'failed'; // raised a real exception/assertion → reproduces the bug ✓
}

// Framework-aware repro guidance — the recurring repro-gap (django/sympy ~30% of Lite need scaffolding
// before a self-contained pytest can import the project). Keyed off the SWE-bench instance prefix.
function frameworkHint(instanceId) {
  const repo = String(instanceId).split('__')[0];
  if (repo === 'django') return `\nDJANGO: before importing any models/forms, configure settings or it won't import:\n  import django; from django.conf import settings\n  if not settings.configured: settings.configure(DEBUG=True, DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}, INSTALLED_APPS=['django.contrib.contenttypes','django.contrib.auth'], USE_TZ=True)\n  django.setup()\nPrefer importing the specific buggy module (utils/forms/ORM helper) directly; avoid needing migrations or a full app.`;
  if (repo === 'sympy') return `\nSYMPY: import the specific symbols (from sympy import ...). Assert with == / simplify()==0 / .equals() exactly as the issue's correct behavior specifies; symbolic objects compare structurally, not by value.`;
  if (repo === 'sphinx') return `\nSPHINX: import and call the specific function/class under test; do not build a full doc project unless the bug requires it.`;
  if (repo === 'matplotlib') return `\nMATPLOTLIB: set a non-interactive backend first — import matplotlib; matplotlib.use('Agg').`;
  return '';
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
    const prompt = `--- GitHub issue ---\n${String(problemStatement).slice(0, 6000)}\n${frameworkHint(instanceId)}\n${feedback}\n--- write ${REPRO_PATH} ---`;
    let raw = '';
    try { const r = await llm(prompt, SYS); raw = r.raw; cost += r.cost || 0; }
    catch (e) { return { valid: false, repro: '', attempts: att, cost, logTail: 'llm error: ' + (e.message || e) }; }
    const repro = raw.replace(/^```(python)?\n?|\n?```$/g, '').trim();
    const r = runConformantTests(instanceId, '', `python ${REPRO_PATH}`, {
      extraFiles: { [REPRO_PATH]: repro }, timeoutMs: opts.timeoutMs ?? 300_000,
    });
    lastTail = r.logTail;
    const verdict = r.ran ? classify(r) : 'error';
    if (verdict === 'failed') return { valid: true, repro, attempts: att, cost, logTail: r.logTail };
    feedback = verdict === 'passed'
      ? `\n--- attempt ${att}: your test PASSED on the unmodified buggy code, so it does NOT reproduce the bug. Rewrite it to assert the CORRECT behavior described in the issue, so it FAILS on the current code. ---`
      : `\n--- attempt ${att}: your test could not run (${verdict}). Output:\n${r.logTail.slice(-800)}\nFix imports/collection so a single test function runs. ---`;
  }
  return { valid: false, repro: '', attempts: maxAttempts, cost, logTail: lastTail };
}

export { REPRO_PATH };
