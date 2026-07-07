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

// ── ADR-175 §63 / GH #47 — SYMPTOM-BINDING signal (NON-GATING, measurement only). ───────────────
// The `failed` verdict above proves the repro raises a REAL exception on the buggy code — but not that
// the failure is THE issue's symptom rather than an unrelated/friendlier assertion the agent authored
// (the Goodhart trap #47 flags: a self-written test with narrower scope or weaker assertions). ADR-175
// names "strengthening it to assert the issue's specific symptom" as follow-up. Hard-GATING on this
// would risk rejecting valid repros → lower the load-bearing conformant resolve, so this is deliberately
// a NON-GATING confidence signal: the measurement you'd want BEFORE deciding whether a gate is safe.
// Pure (issue text + repro source + failure trace → a bounded score) so it unit-tests offline.

const EXC_RE = /\b([A-Z][A-Za-z0-9_]*(?:Error|Exception|Warning))\b/g;

/** Distinct exception/error TYPE names named in a blob (e.g. "raises TypeError"). */
function exceptionTypes(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(EXC_RE)) out.add(m[1]);
  return [...out];
}

/** Salient identifiers the issue calls out: `backtick-quoted` tokens + `foo()` call names (len ≥ 3).
 *  Conservative on purpose — noise here only weakens a NON-gating score, never rejects a repro. */
function issueIdentifiers(problemStatement) {
  const s = String(problemStatement || '');
  const out = new Set();
  for (const m of s.matchAll(/`([A-Za-z_][A-Za-z0-9_.]{2,})`/g)) out.add(m[1].split('.').pop());
  for (const m of s.matchAll(/\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g)) out.add(m[1]);
  // Drop generic English/code stopwords that would match trivially.
  const STOP = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'not', 'test', 'def', 'from', 'import', 'return', 'value', 'error', 'function', 'method', 'class', 'object', 'result']);
  return [...out].filter(w => !STOP.has(w.toLowerCase()));
}

/**
 * Heuristic confidence that a conformant repro exercises the ISSUE'S symptom (not just *a* failure).
 * NON-GATING (ADR-175 §63 / #47) — recorded for analysis, never used to reject a repro.
 *
 *   { assessable, score, issueExceptions, boundExceptionType, matchedExceptions,
 *     issueIdentifierCount, matchedIdentifiers }
 *
 * score ∈ [0,1]: +0.5 when the failure trace raises an exception TYPE the issue names
 * (`boundExceptionType`), +0.5 × the fraction of (up to 3) salient issue identifiers the repro
 * references. `assessable=false` when the issue names neither an exception nor a salient identifier
 * (score null) — we don't fabricate confidence from nothing.
 */
export function symptomBindingScore(problemStatement, repro, logTail) {
  const issueExc = exceptionTypes(problemStatement);
  const traceExc = exceptionTypes(logTail);
  const idents = issueIdentifiers(problemStatement);
  const reproText = String(repro || '');

  const matchedExceptions = issueExc.filter(e => traceExc.includes(e));
  const boundExceptionType = matchedExceptions.length > 0;

  const salient = idents.slice(0, 3);
  const matchedIdentifiers = salient.filter(id => reproText.includes(id));

  const assessable = issueExc.length > 0 || idents.length > 0;
  if (!assessable) {
    return { assessable: false, score: null, issueExceptions: issueExc, boundExceptionType: false, matchedExceptions: [], issueIdentifierCount: idents.length, matchedIdentifiers: [] };
  }
  const excPart = boundExceptionType ? 0.5 : 0;
  const idPart = salient.length > 0 ? 0.5 * (matchedIdentifiers.length / salient.length) : 0;
  const score = Math.round((excPart + idPart) * 1000) / 1000;
  return { assessable: true, score, issueExceptions: issueExc, boundExceptionType, matchedExceptions, issueIdentifierCount: idents.length, matchedIdentifiers };
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
      extraFiles: { [REPRO_PATH]: repro }, timeoutMs: opts.timeoutMs ?? 300_000, containerId: opts.containerId,
    });
    lastTail = r.logTail;
    const verdict = r.ran ? classify(r) : 'error';
    if (verdict === 'failed') {
      // ADR-175 §63 / #47: attach the NON-GATING symptom-binding confidence (valid stays true — this
      // never rejects a repro; it's recorded so a future decision to gate can be measured, not guessed).
      const symptomBinding = symptomBindingScore(problemStatement, repro, r.logTail);
      return { valid: true, repro, attempts: att, cost, logTail: r.logTail, symptomBinding };
    }
    feedback = verdict === 'passed'
      ? `\n--- attempt ${att}: your test PASSED on the unmodified buggy code, so it does NOT reproduce the bug. Rewrite it to assert the CORRECT behavior described in the issue, so it FAILS on the current code. ---`
      : `\n--- attempt ${att}: your test could not run (${verdict}). Output:\n${r.logTail.slice(-800)}\nFix imports/collection so a single test function runs. ---`;
  }
  return { valid: false, repro: '', attempts: maxAttempts, cost, logTail: lastTail };
}

export { REPRO_PATH };
