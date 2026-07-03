// SPDX-License-Identifier: MIT
//
// ADR-228 §5 — the pre-registered per-instance metric + the rich TEXTUAL feedback (ASI —
// "Actionable Side Information", GEPA's text-optimization analogue of a gradient). Pure functions,
// $0-testable; the caller wires them to real transcripts/gold reports (in-repo, the SWE-bench
// evaluator does this — it does not ship in this package).
//
// TypeScript port of bench/swebench/gepa/metric.mjs — behavior-preserving.
//
// Score (§5.1, verbatim from the ADR):
//   +10.0 gold-resolved  +1.0 targeted-tests-pass  +0.5 minimal-patch  +0.5 touched-expected-files
//   −1.0 empty-patch  −0.5 repeated-reads  −0.5 no-tests-run  −1.0 test-file-edits  −normalized-cost
//
// Verified-contract rule 1 (ADR-228 §9.3): per-instance failures NEVER throw — callers map errors
// to score 0.0 + failure text; these functions are total over malformed transcripts.
/** Extract the action object from a transcript entry's actionRaw (JSON.stringify(action).slice(0,400)
 * — possibly TRUNCATED, so fall back to regex extraction of tool/path when JSON.parse fails). */
export function parseActionRaw(actionRaw) {
    const s = String(actionRaw ?? '');
    try {
        const o = JSON.parse(s);
        if (o && typeof o === 'object')
            return o;
    }
    catch { /* truncated */ }
    const tool = (s.match(/"tool"\s*:\s*"([^"]+)"/) || [])[1] || null;
    const path = (s.match(/"path"\s*:\s*"([^"]+)"/) || [])[1];
    return tool ? { tool, ...(path ? { path } : {}), _truncated: true } : { tool: 'noop', _unparseable: true };
}
/** Mechanical trajectory analysis over an advisorSolve/agenticSolve transcript ({actionRaw, obs}[]). */
export function analyzeTranscript(transcript = []) {
    const a = {
        steps: transcript.length,
        counts: {},
        runTestsCount: 0, runTestsFails: 0, runTestsPasses: 0,
        editAttempts: 0, editsLanded: 0, editsFailed: 0,
        testFileEditAttempts: 0,
        noopCount: 0,
        filesRead: [], filesEdited: [],
        repeatedActionWarnings: 0,
        submitted: false, vetoes: 0, advisories: 0,
    };
    const readSet = new Set();
    const editSet = new Set();
    for (const t of transcript) {
        const act = parseActionRaw(t?.actionRaw);
        const obs = String(t?.obs ?? '');
        const tool = String(act.tool); // JS-coercion-equivalent: an absent tool counts under "undefined"
        a.counts[tool] = (a.counts[tool] || 0) + 1;
        if (act.tool === 'noop')
            a.noopCount++;
        if (act.tool === 'read' && act.path)
            readSet.add(act.path);
        if (act.tool === 'run_tests') {
            a.runTestsCount++;
            if (/ALL TARGET TESTS PASS/.test(obs))
                a.runTestsPasses++;
            else if (!/no edits applied yet/.test(obs))
                a.runTestsFails++;
        }
        if (act.tool === 'edit' || act.tool === 'line_edit') {
            a.editAttempts++;
            if (/is a test file/.test(obs))
                a.testFileEditAttempts++;
            else if (/^(edited |line_edit .*replaced lines)/.test(obs)) {
                a.editsLanded++;
                if (act.path)
                    editSet.add(act.path);
            }
            else
                a.editsFailed++;
        }
        if (act.tool === 'submit') {
            if (/VETOED/.test(obs))
                a.vetoes++;
            else
                a.submitted = true;
        }
        if (act.tool === 'advise')
            a.advisories++;
        if (/⚠️ SYSTEM: You already ran this exact action/.test(obs))
            a.repeatedActionWarnings++;
    }
    a.filesRead = [...readSet];
    a.filesEdited = [...editSet];
    return a;
}
const DEFAULT_IS_TEST_PATH = (p) => /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*$|_test\.[a-z]+$/.test(p);
/** Non-test source files touched by a unified diff, + total changed (±) line count. */
export function patchStats(patch, isTestPath = DEFAULT_IS_TEST_PATH) {
    const d = String(patch ?? '');
    const files = [...d.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
    const changedLines = d.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
    return { files, nonTestFiles: files.filter((f) => !isTestPath(f)), testFiles: files.filter((f) => isTestPath(f)), changedLines, empty: !d.trim() };
}
/** Files touched by the GOLD patch (scoring-side only — never enters any executor prompt). */
export function goldFiles(goldPatch) { return patchStats(goldPatch).files; }
/**
 * The pre-registered §5.1 score. Inputs are plain facts; returns { score, parts } with every
 * term itemized so the ASI can cite them. costCap defaults to $0.50 (clamped normalized cost).
 */
export function computeInstanceScore({ goldResolved = false, resolvedInLoop = false, patch = '', goldPatchFiles = null, analysis = analyzeTranscript([]), cost = 0, thrash = 0, costCap = 0.5, isTestPath, } = {}) {
    const ps = patchStats(patch, isTestPath);
    const parts = {
        goldResolved: goldResolved ? 10.0 : 0,
        targetedTestsPass: resolvedInLoop ? 1.0 : 0,
        minimalPatch: (!ps.empty && ps.nonTestFiles.length <= 2 && ps.changedLines <= 60) ? 0.5 : 0,
        touchedExpectedFiles: (Array.isArray(goldPatchFiles) && goldPatchFiles.length
            && ps.files.some((f) => goldPatchFiles.includes(f))) ? 0.5 : 0,
        emptyPatch: ps.empty ? -1.0 : 0,
        repeatedReads: (thrash > 0 || analysis.repeatedActionWarnings > 0) ? -0.5 : 0,
        noTestsRun: analysis.runTestsCount === 0 ? -0.5 : 0,
        testFileEdits: (analysis.testFileEditAttempts > 0 || ps.testFiles.length > 0) ? -1.0 : 0,
        normalizedCost: -Math.min(Math.max(cost, 0) / costCap, 1),
    };
    const score = Object.values(parts).reduce((s, v) => s + v, 0);
    return { score: Math.round(score * 1000) / 1000, parts, patch: ps };
}
/** ADR-228 §5.3 failure classes. 0 = resolved. Deterministic precedence, tested. */
export const FAILURE_CLASSES = {
    0: 'resolved',
    1: 'localization-failure (never read the gold files)',
    2: 'edit-mechanics (edits attempted, failed to apply)',
    3: 'exploration-loop (all steps read/grep/ls, empty patch)',
    4: 'wrong-fix (right file, gold still fails)',
    5: 'test-thrash (repeated failing run_tests without strategy change)',
    6: 'budget-exhaustion (edits landed, ran out of steps)',
};
export function classifyFailure({ goldResolved = false, analysis, patch = '', goldPatchFiles = null, maxSteps = 12, } = {}) {
    const a = analysis || analyzeTranscript([]);
    const ps = patchStats(patch);
    if (goldResolved)
        return 0;
    if (ps.empty && a.editAttempts === 0)
        return 3; // pure exploration loop
    if (a.editAttempts > 0 && a.editsLanded === 0)
        return 2; // edits never applied
    const readGold = Array.isArray(goldPatchFiles) && goldPatchFiles.length
        ? a.filesRead.some((f) => goldPatchFiles.includes(f)) || ps.files.some((f) => goldPatchFiles.includes(f))
        : null;
    if (readGold === false)
        return 1; // never even looked at the fix site
    if (a.runTestsFails >= 3 && a.runTestsPasses === 0)
        return 5; // hammering failing tests
    if (!ps.empty && readGold)
        return 4; // right place, wrong fix
    if (a.editsLanded > 0 && a.steps >= maxSteps)
        return 6; // ran out of road
    return ps.empty ? 3 : 4;
}
const MUTATION_HINTS = {
    1: 'mutation target: file localization (retrieval_policy / tool_grep) — direct the agent to the traceback/stack file first and cap grep misses',
    2: 'mutation target: edit_policy / tool_edit description — push harder toward line_edit and exact-copy discipline',
    3: 'mutation target: retrieval_policy — stop grep loops, force an edit attempt by mid-budget',
    4: 'mutation target: retrieval_policy + test_policy — require reading surrounding context and re-running tests before submit',
    5: 'mutation target: test_policy — after 2 failing runs, require re-reading the failing trace and changing approach, not re-running',
    6: 'mutation target: retrieval_policy — reach the edit earlier; spend fewer steps exploring',
    0: '',
};
/**
 * §5.2 — the per-instance ASI: rich prose the reflection LM can act on, generated mechanically
 * from the transcript analysis + score parts + the paired teacher summary where one exists.
 */
export function makeFeedback({ instanceId = '?', analysis, scored, failureClass, goldPatchFiles = null, teacherSummary = null, error = null, } = {}) {
    if (error)
        return `${instanceId}: EVALUATION ERROR — ${error}. Scored 0.0 (never-raise contract); no trajectory available.`;
    const a = analysis || analyzeTranscript([]);
    const s = scored || computeInstanceScore({ analysis: a });
    const counts = Object.entries(a.counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'no actions';
    const lines = [];
    lines.push(`${instanceId}: score ${s.score} (gold ${s.parts.goldResolved > 0 ? 'RESOLVED' : 'FAIL'}).`);
    lines.push(`${a.steps} steps: ${counts}; ${a.editsLanded}/${a.editAttempts} edits landed; run_tests ${a.runTestsCount}× (${a.runTestsPasses} pass, ${a.runTestsFails} fail)${a.noopCount ? `; ${a.noopCount} malformed turns` : ''}${a.repeatedActionWarnings ? `; ${a.repeatedActionWarnings} repeated-action warnings (thrash)` : ''}.`);
    lines.push(`read ${JSON.stringify(a.filesRead.slice(0, 6))}; patch touched ${JSON.stringify(s.patch.files)}${Array.isArray(goldPatchFiles) ? `; gold fix lives in ${JSON.stringify(goldPatchFiles)}${a.filesRead.some((f) => goldPatchFiles.includes(f)) ? '' : ' — never read it'}` : ''}.`);
    const penalties = Object.entries(s.parts).filter(([, v]) => v < 0).map(([k, v]) => `${k} ${v}`).join(', ');
    if (penalties)
        lines.push(`penalties: ${penalties}.`);
    if (failureClass != null)
        lines.push(`failure class ${failureClass} (${FAILURE_CLASSES[failureClass]}). ${MUTATION_HINTS[failureClass] || ''}`.trim());
    if (teacherSummary)
        lines.push(`teacher (paired success/advice): ${String(teacherSummary).slice(0, 700)}`);
    return lines.join('\n');
}
//# sourceMappingURL=metric.js.map