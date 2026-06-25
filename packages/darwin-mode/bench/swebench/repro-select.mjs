// SPDX-License-Identifier: MIT
// ADR-193 — REPRODUCTION-TEST SELECTION (the conformant, Goodhart-free analog of Test-Driven Repair).
//
// Goal: capture the "verify-and-iterate against a test" value of TDR WITHOUT the gold test, and WITHOUT
// the self-grading trap of ADR-174 (where one trajectory optimizes its own moves against its own
// repro test → Goodhart). The escape is to keep candidates INDEPENDENT of the repro test:
//   1. Candidates: N independent prediction sets (bo3 — solve-agentic ×3 temps or 3 models). No
//      candidate is generated against the repro test, so none can game it.
//   2. Repro test: a model writes reproduce_bug.py from the ISSUE TEXT ONLY (conformant — never reads
//      the gold FAIL_TO_PASS/PASS_TO_PASS). buildReproTest validates it FAILS on the unmodified repo.
//   3. Select: for each candidate, in the instance BASE image (deps present, NO gold test_patch),
//      apply candidate + the repro test → pass/fail. Also run the repo's own existing tests near the
//      changed file as a regression check. Pick the candidate that makes the repro PASS and does not
//      regress. Tie-break / fallback to the LLM judge (discriminator) when 0 or >1 pass.
//   4. Emit the selected patch as the prediction.
//
// === CONFORMANCE (asserted in code, see assertConformant) ===
//   - The repro test is built from inst.problem_statement ONLY. We never read inst.FAIL_TO_PASS /
//     PASS_TO_PASS / test_patch, and runConformantTests NEVER applies the gold test_patch (it stages
//     only the candidate model_patch + reproduce_bug.py into the base image).
//   - Gold tests are used ONLY by the final `swebench` eval to SCORE — same as every other run.
//
// Inputs: --manifest + --preds a.jsonl,b.jsonl,c.jsonl (N independent prediction sets, same ids).
// Output: one merged prediction per instance (the repro-selected pick) + a report comparing how often
// the repro-test selection DIFFERED from the plain LLM judge, plus repro pass-rate diagnostics.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConformantTests, startInstanceContainer, stopInstanceContainer } from './conformant-tests.mjs';
import { buildReproTest, REPRO_PATH } from './test-critic.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

const WRITER = argv('--writer-model', 'deepseek/deepseek-v4-flash'); // writes reproduce_bug.py (conformant)
const JUDGE = argv('--judge-model', 'deepseek/deepseek-v4-flash');   // tie-break / fallback LLM judge
const OUT = rel(argv('--out', 'predictions-repro-select.jsonl'));
const REPORT = rel(argv('--report', 'repro-select-report.json'));
const BASE_URL = (argv('--base-url', 'https://openrouter.ai/api/v1')).replace(/\/$/, '');
const CONC = Math.max(1, +argv('--concurrency', 2));
const REPRO_ATTEMPTS = +argv('--repro-attempts', 3);
const NO_REGRESSION = args.includes('--no-regression'); // skip the repo's-own-tests regression check
const key = (process.env.OPENROUTER_API_KEY || (() => { try { return readFileSync('/tmp/.orkey', 'utf8'); } catch { return ''; } })()).trim();
const URL = `${BASE_URL}/chat/completions`;
const manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'pilot-sample-25.json')), 'utf8')).instances;

const predFiles = (argv('--preds', '')).split(',').filter(Boolean).map(rel);
if (predFiles.length < 2) { console.error('need --preds with >=2 comma-separated prediction files'); process.exit(1); }
const load = (f) => { const m = {}; for (const l of readFileSync(f, 'utf8').trim().split('\n')) { if (!l) continue; const o = JSON.parse(l); m[o.instance_id] = o.model_patch || ''; } return m; };
const sets = predFiles.map(load);

// === CONFORMANCE GUARD ===
// Hard assertion: the only field of an instance we are ever allowed to feed the repro writer is
// problem_statement. If anyone wires a gold field into the repro path, fail loudly rather than
// silently produce a tainted result. Also forbid the gold test_patch ever reaching the runner.
function assertConformant(inst, reproInput) {
  const FORBIDDEN = ['FAIL_TO_PASS', 'PASS_TO_PASS', 'test_patch'];
  for (const f of FORBIDDEN) {
    if (inst[f] && reproInput && String(reproInput).includes(String(inst[f]).slice(0, 40))) {
      throw new Error(`CONFORMANCE VIOLATION: gold field ${f} leaked into the repro test for ${inst.instance_id}`);
    }
  }
}
// Runner-level guard: the candidate patch we stage must not itself be (or contain) the gold test_patch,
// and the only extra file we stage is reproduce_bug.py. Belt-and-suspenders around runConformantTests.
function runCandidateWithRepro(instanceId, candidatePatch, repro, inst, opts) {
  if (inst.test_patch && candidatePatch && candidatePatch.includes(String(inst.test_patch).slice(0, 60))) {
    throw new Error(`CONFORMANCE VIOLATION: candidate patch for ${instanceId} contains the gold test_patch`);
  }
  return runConformantTests(instanceId, candidatePatch, `python ${REPRO_PATH}`, {
    extraFiles: { [REPRO_PATH]: repro }, timeoutMs: 300_000, containerId: opts.containerId,
  });
}

function mkLlm(model) {
  return async (prompt, system) => {
    const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }];
    for (let a = 0; a < 4; a++) { if (a) await new Promise(r => setTimeout(r, 1500 * 2 ** a));
      try {
        const res = await fetch(URL, { method: 'POST', signal: AbortSignal.timeout(60000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: 1500, temperature: 0 }) });
        if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
        const j = await res.json(); return { raw: j.choices?.[0]?.message?.content ?? '', cost: j.usage?.cost ?? 0 };
      } catch { /* retry */ }
    }
    return { raw: '', cost: 0 };
  };
}
const writer = mkLlm(WRITER);

// The plain LLM judge — identical prompt to discriminator.mjs, so "judge fallback" == the baseline judge.
async function judge(issue, cands) {
  const body = cands.map((c, k) => `### CANDIDATE ${k}\n\`\`\`diff\n${c.patch.slice(0, 6000)}\n\`\`\``).join('\n\n');
  const prompt = `A GitHub issue and ${cands.length} candidate patches (independent attempts). Pick the ONE most likely to CORRECTLY fix the issue without breaking existing behavior. Judge by: does it address the issue's root cause? minimal + correct? no obvious bug/oversilencing?\n\n--- ISSUE ---\n${String(issue).slice(0, 5000)}\n\n${body}\n\n--- Respond with ONLY the integer index (0..${cands.length - 1}) of the best candidate. ---`;
  for (let a = 0; a < 4; a++) { if (a) await new Promise(r => setTimeout(r, 1500 * 2 ** a));
    try {
      const res = await fetch(URL, { method: 'POST', signal: AbortSignal.timeout(45000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: JUDGE, messages: [{ role: 'user', content: prompt }], max_tokens: 8, temperature: 0 }) });
      if (!res.ok && (res.status === 429 || res.status >= 500)) continue;
      const j = await res.json(); const raw = j.choices?.[0]?.message?.content ?? '';
      const m = raw.match(/\d+/); const idx = m ? +m[0] : 0;
      return { idx: idx >= 0 && idx < cands.length ? idx : 0, cost: j.usage?.cost ?? 0 };
    } catch { /* retry */ }
  }
  return { idx: 0, cost: 0 };
}

// Regression check (same rule as discriminator.envSignal): run the existing test file(s) near the
// changed module. 'pass' ran clean, 'fail' ran+regressed, 'nosignal' couldn't run. Conformant — these
// are the repo's OWN committed tests, not the gold FAIL_TO_PASS.
function existingTestTargets(diff) {
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+\.py)$/gm)].map((m) => m[1]).filter((f) => !/(^|\/)(test_|tests?\/|conftest)/i.test(f));
  const targets = new Set();
  for (const f of files) { const parts = f.split('/'); const base = parts[parts.length - 1].replace(/\.py$/, ''); const dir = parts.slice(0, -1).join('/'); targets.add(`${dir}/tests/test_${base}.py`); targets.add(`${dir}/test_${base}.py`); }
  return [...targets].slice(0, 4);
}
function regressionSignal(instanceId, patch, containerId) {
  const targets = existingTestTargets(patch);
  if (!targets.length) return 'nosignal';
  const cmd = `python -m pytest -q -p no:cacheprovider ${targets.map((t) => `'${t}'`).join(' ')}`;
  const r = runConformantTests(instanceId, patch, cmd, { timeoutMs: 300_000, containerId });
  if (!r.ran) return 'nosignal';
  return r.passed ? 'pass' : 'fail';
}

let cost = 0; const report = []; let cursor = 0;
writeFileSync(OUT, '');
const outRows = [];

async function one(inst) {
  const id = inst.instance_id;
  const all = sets.map((s) => s[id] || '');
  // unique non-empty candidates, remembering each one's originating set index
  const nonEmpty = [...new Map(all.map((p, i) => [p, { i, patch: p }])).values()].filter((c) => c.patch.trim());
  const row = {
    instance_id: id, nCandidates: nonEmpty.length, reproValid: false, reproAttempts: 0,
    reproPassByCand: [], how: 'none', pickIdx: -1, judgeIdx: -1, changedVsJudge: false,
  };
  let picked = ''; let pickIdx = -1;
  if (nonEmpty.length === 0) { /* no candidate at all */ }
  else if (nonEmpty.length === 1) { picked = nonEmpty[0].patch; pickIdx = nonEmpty[0].i; row.how = 'sole'; }
  else {
    // One detached container per instance (cheap repeated docker exec instead of cold run --rm).
    const cid = startInstanceContainer(id);
    try {
      // (2) build the conformant repro test from issue text ONLY
      assertConformant(inst, inst.problem_statement);
      const rb = await buildReproTest(id, inst.problem_statement, writer, { maxAttempts: REPRO_ATTEMPTS, containerId: cid });
      cost += rb.cost; row.reproValid = rb.valid; row.reproAttempts = rb.attempts;
      assertConformant(inst, rb.repro);

      // Always compute the judge pick too, so we can measure how often the repro signal changed it.
      const jr = await judge(inst.problem_statement, nonEmpty); cost += jr.cost;
      row.judgeIdx = nonEmpty[jr.idx].i;

      let survivors = nonEmpty;
      if (rb.valid) {
        // (3) for each candidate: apply candidate + repro in base env (NO gold test_patch) → pass/fail
        const scored = nonEmpty.map((c) => {
          const rr = runCandidateWithRepro(id, c.patch, rb.repro, inst, { containerId: cid });
          const reg = NO_REGRESSION ? 'skip' : regressionSignal(id, c.patch, cid);
          return { ...c, reproPass: rr.ran && rr.passed, reproRan: rr.ran, reg };
        });
        row.reproPassByCand = scored.map((c) => ({ set: c.i, reproPass: c.reproPass, reproRan: c.reproRan, reg: c.reg }));
        // candidates that make the repro PASS and don't regress
        const passers = scored.filter((c) => c.reproPass && c.reg !== 'fail');
        const passersAny = scored.filter((c) => c.reproPass); // even if regression couldn't run
        survivors = passers.length ? passers : (passersAny.length ? passersAny : scored.filter((c) => c.reg !== 'fail'));
        if (!survivors.length) survivors = scored;

        if (survivors.length === 1 && survivors[0].reproPass) { picked = survivors[0].patch; pickIdx = survivors[0].i; row.how = 'repro-sole'; }
        else if (survivors.length >= 1 && survivors.some((c) => c.reproPass)) {
          // >1 repro-passers: tie-break with the judge restricted to the passers
          const tb = await judge(inst.problem_statement, survivors); cost += tb.cost;
          picked = survivors[tb.idx].patch; pickIdx = survivors[tb.idx].i; row.how = 'repro-tiebreak-judge';
        } else {
          // no candidate passed the repro → fall back to the plain judge over all candidates
          picked = nonEmpty[jr.idx].patch; pickIdx = nonEmpty[jr.idx].i; row.how = 'judge-fallback-norepro';
        }
      } else {
        // repro test itself never reproduced the bug → fall back to the plain judge (== baseline)
        picked = nonEmpty[jr.idx].patch; pickIdx = nonEmpty[jr.idx].i; row.how = 'judge-fallback-invalid';
      }
    } catch (e) {
      row.error = String(e.message || e).slice(0, 160);
      // On any error, default to the judge so we never crash the run.
      try { const jr = await judge(inst.problem_statement, nonEmpty); cost += jr.cost; row.judgeIdx = nonEmpty[jr.idx].i; picked = nonEmpty[jr.idx].patch; pickIdx = nonEmpty[jr.idx].i; row.how = 'judge-fallback-error'; }
      catch { picked = nonEmpty[0].patch; pickIdx = nonEmpty[0].i; row.how = 'first-fallback'; }
    } finally { stopInstanceContainer(cid); }
  }
  row.pickIdx = pickIdx;
  row.changedVsJudge = row.judgeIdx >= 0 && pickIdx >= 0 && pickIdx !== row.judgeIdx;
  outRows.push({ instance_id: id, model_name_or_path: 'darwin-repro-select', model_patch: picked });
  report.push(row);
  console.error(`[${report.length}/${manifest.length}] ${id}: ${row.nCandidates} cand valid=${row.reproValid} → ${row.how} set#${pickIdx}${row.changedVsJudge ? ' (CHANGED vs judge#' + row.judgeIdx + ')' : ''}`);
}

async function worker() { while (cursor < manifest.length) await one(manifest[cursor++]); }
await Promise.all(Array.from({ length: CONC }, worker));

// Write predictions in manifest order (stable), then the report.
const byId = Object.fromEntries(outRows.map((r) => [r.instance_id, r]));
for (const inst of manifest) {
  const r = byId[inst.instance_id] || { instance_id: inst.instance_id, model_name_or_path: 'darwin-repro-select', model_patch: '' };
  writeFileSync(OUT, JSON.stringify(r) + '\n', { flag: 'a' });
}

const reproValidN = report.filter((r) => r.reproValid).length;
const withCands = report.filter((r) => r.nCandidates > 1).length;
const reproPassedSomeCand = report.filter((r) => (r.reproPassByCand || []).some((c) => c.reproPass)).length;
const changed = report.filter((r) => r.changedVsJudge).length;
const summary = {
  writerModel: WRITER, judgeModel: JUDGE, nSets: predFiles.length, n: report.length,
  multiCandidate: withCands,
  reproValidRate: `${reproValidN}/${report.length}`,             // repro test FAILED on buggy code (usable)
  reproPassedSomeCandidate: `${reproPassedSomeCand}/${withCands}`, // >=1 candidate made the repro pass
  changedSelectionVsJudge: `${changed}/${withCands}`,             // repro signal overrode the plain judge
  how: report.reduce((a, r) => ((a[r.how] = (a[r.how] || 0) + 1), a), {}),
  cost_usd: Math.round(cost * 1e4) / 1e4,
};
writeFileSync(REPORT, JSON.stringify({ summary, instances: report }, null, 2));
console.error('\n=== REPRO-SELECT ===\n' + JSON.stringify(summary, null, 2));
console.error(`→ ${OUT}  (gold-eval this; baseline = discriminator.mjs on the SAME --preds)`);
