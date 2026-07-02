// SPDX-License-Identifier: MIT
//
// ADR-228 §4 steps 1-2 + §4.1 — build the GEPA reflective dataset from today's benchmark artifacts:
// fadv-*-report.json (fable-bench worktree: GLM/v4-pro × solo/Fable-advised advisoryLogs),
// advbench-*-report.json (adr226 worktree: D/D-self/D-oracle/B arms), the matching predictions
// *.jsonl (patches), gold reports (resolved_ids), and the pre-authored D-oracle advice files.
//
// ADMISSION GATES (ADR-228 §4.1 — the same gates ADR-227's training queue applies; GEPA never
// trains on raw traces):
//   paired                 a solo-fail record must carry teacher-success evidence on the SAME instance
//   verified-outcome       the teacher's success is gold-resolved (or pre-authored D-oracle advice,
//                          which is gold-derived by construction and flagged as such)
//   contamination-scan     teacher advice excerpts checked for gold-patch content (verbatim added-line
//                          overlap); without gold patches records are NOT admitted unless --allow-unscanned
//   provenance             every record names its source artifacts
// Replay-eval convertibility bar: every admitted record carries {tenant_id, task_signature,
// cheap_failed_trace, strong_success_trace, successful_patch, test_proof, retrieval_keys,
// replay_eligible} — records that cannot become a replay-eval row are DROPPED AND COUNTED.
//
// Usage ($0 — local files only; gold patches come from the swebench venv's HF cache):
//   node gepa/build-reflective-dataset.mjs \
//     --fable-bench ../../../.claude/worktrees/fable-bench/packages/darwin-mode/bench/swebench \
//     --adr226 ../../../.claude/worktrees/agent-a41afa7de96eab8f7/packages/darwin-mode/bench/swebench \
//     --manifest advisor-medium-25.json \
//     --gold advbench-D0-med=/tmp/darwin-advisor.adv_d0_med.json \
//     --gold advbench-D-med=/tmp/darwin-advisor.adv_d_med.json \
//     --gold fadv-glm-solo=/tmp/darwin-advisor.fadv_glm_solo.json \
//     --gold-patches gepa/gold-patches.json \
//     --out gepa/reflective-dataset.json

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { goldFiles } from './metric.mjs';

// ── pure, $0-testable pieces ──────────────────────────────────────────────────────────────────────

/** Fetch gold patches for a set of instance ids from the swebench venv's HF cache (scoring-side
 * only — gold NEVER enters any executor prompt). Returns { instId: patch } or null on failure.
 * Bench-tooling note: this shells the existing Python swebench venv; the repo's Rust-only rule
 * covers ruOS components — bench harness tooling is the established mjs+venv surface here. */
export function fetchGoldPatches(ids, cachePath = null) {
  if (cachePath && existsSync(cachePath)) { try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /**/ } }
  try {
    const py = [
      'import json,sys',
      'from datasets import load_dataset',
      `ids=set(json.loads(${JSON.stringify(JSON.stringify(ids))}))`,
      "ds=load_dataset('princeton-nlp/SWE-bench_Lite',split='test')",
      "print(json.dumps({r['instance_id']:r['patch'] for r in ds if r['instance_id'] in ids}))",
    ].join('\n');
    const outTxt = execSync('. /tmp/swebench-venv/bin/activate && python3 -',
      { shell: '/bin/bash', input: py, maxBuffer: 1 << 26, timeout: 120000 }).toString();
    const patches = JSON.parse(outTxt.trim().split('\n').at(-1));
    if (cachePath) { try { writeFileSync(cachePath, JSON.stringify(patches)); } catch { /**/ } }
    return patches;
  } catch (e) {
    console.error(`[gold-patches] unavailable (${String(e.message || e).slice(0, 120)})`);
    return null;
  }
}

/** Verbatim added-line overlap scan: does the advice contain gold-patch ADDED content (≥minLen chars)
 * — i.e. fix content not derivable from the transcript+diff shown? (ADR-226 §4.8's scan.) */
export function contaminationScan(advice, goldPatch, minLen = 20) {
  const a = String(advice || '');
  if (!a || !goldPatch) return { scanned: !!goldPatch, contaminated: false, hits: [] };
  const added = String(goldPatch).split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.length >= minLen);
  const hits = added.filter((l) => a.includes(l));
  return { scanned: true, contaminated: hits.length > 0, hits: hits.slice(0, 3) };
}

/** Approximate failure class from a report row + patch when no transcript exists (ADR-228 §5.3). */
export function approxFailureClass({ row = {}, patch = '', goldPatchFiles = null, maxSteps = 12 }) {
  const empty = !String(patch || '').trim();
  if (row.resolvedGold) return 0;
  if (empty) return 3; // no landed edits visible — exploration/edit failure indistinguishable without a transcript; class 3 is the conservative label
  const files = [...String(patch).matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const touchesGold = Array.isArray(goldPatchFiles) && goldPatchFiles.length ? files.some((f) => goldPatchFiles.includes(f)) : null;
  if (touchesGold === false) return 1;
  if (touchesGold && row.thrash > 0 && (row.steps ?? 0) >= maxSteps) return 5;
  if (touchesGold) return 4;
  return (row.steps ?? 0) >= maxSteps ? 6 : 4;
}

/** One-line mechanical summary of a cheap arm's run (feeds the record + later the reflection prompt). */
export function summarizeRow(arm, row = {}, patch = '') {
  const empty = !String(patch || '').trim();
  return `${arm}: ${row.steps ?? '?'} steps, ${row.executorActions ?? '?'} executor actions, thrash=${row.thrash ?? 0}, `
    + `${row.advisories ?? 0} advisories, ${row.vetoes ?? 0} vetoes, submitted=${!!row.submitted}, `
    + `in-loop-tests=${!!row.resolvedInLoop}, patch=${empty ? 'EMPTY' : 'non-empty'}, $${row.cost ?? '?'}`;
}

/**
 * Assemble + gate the records. Inputs are plain data (CLI does the file I/O):
 *   arms         { armName: { report, preds: {instId: patch}, kind: 'student'|'teacher', gold: Set<instId>|null } }
 *   manifest     [{ instance_id, repo, problem_statement }]
 *   goldPatches  { instId: goldPatchText } | null
 *   oracleAdvice { instId: adviceText }    (pre-authored D-oracle files; gold-derived by construction)
 * Returns { records, counts } with drop reasons itemized (§4.1: drop + count).
 */
export function buildRecords({ arms, manifest, goldPatches = null, oracleAdvice = {}, tenant = 'local-bench', allowUnscanned = false, maxSteps = 12 }) {
  const counts = { candidates: 0, admitted: 0, dropped: {} };
  const drop = (reason) => { counts.dropped[reason] = (counts.dropped[reason] || 0) + 1; };
  const records = [];
  const students = Object.entries(arms).filter(([, a]) => a.kind === 'student');
  const teachers = Object.entries(arms).filter(([, a]) => a.kind === 'teacher');

  for (const inst of manifest) {
    const id = inst.instance_id;
    const goldPatch = goldPatches?.[id] ?? null;
    const goldPatchFileList = goldPatch ? goldFiles(goldPatch) : null;

    for (const [armName, arm] of students) {
      const row = (arm.report.instances || []).find((r) => r.instance_id === id);
      if (!row) continue;
      const studentGold = arm.gold ? arm.gold.has(id) : null;
      counts.candidates++;
      if (studentGold !== false) { drop(studentGold === null ? 'student-gold-unknown' : 'student-not-a-failure'); continue; }
      const patch = arm.preds?.[id] ?? '';

      // teacher evidence on the SAME instance (gate: paired). Preference order: a REAL gold-resolved
      // advised/acting arm (production-like evidence) > pre-authored oracle advice (fallback;
      // gold-derived by construction, ADR-226 §4.8).
      let teacher = null;
      for (const [tName, t] of teachers) {
        if (!t.gold?.has(id)) continue; // gate: verified-outcome — teacher must be GOLD-resolved
        const tRow = (t.report.instances || []).find((r) => r.instance_id === id);
        teacher = {
          arm: tName, kind: (tRow?.advisoryLog || []).length ? 'advisory' : 'acting-success',
          advice: (tRow?.advisoryLog || []).map((a) => a.advice).filter(Boolean).join('\n---\n') || null,
          gold: true, patch: t.preds?.[id] ?? null, testProof: t.goldSource || 'gold-report',
        };
        break;
      }
      if (!teacher && oracleAdvice[id]) {
        teacher = { arm: 'D-oracle', kind: 'oracle-advice', advice: oracleAdvice[id], gold: 'pre-authored-gold-derived', patch: goldPatch, testProof: 'gold-patch-by-construction' };
      }
      if (!teacher) { drop('unpaired-no-verified-teacher'); continue; }
      if (!teacher.patch) { drop('not-replay-convertible-no-successful-patch'); continue; }

      // gate: contamination scan of teacher ADVICE (advisory text only — an acting teacher's patch
      // legitimately resembles gold; the scan targets advice masquerading as judgment).
      if (teacher.advice) {
        const scan = contaminationScan(teacher.advice, goldPatch);
        if (!scan.scanned && !allowUnscanned && teacher.kind !== 'oracle-advice') { drop('unscanned-no-gold-patch'); continue; }
        if (scan.contaminated && teacher.kind !== 'oracle-advice') { drop('contaminated-advice'); continue; }
        teacher.contamination = teacher.kind === 'oracle-advice' ? 'exempt-pre-authored' : (scan.scanned ? 'clean' : 'unscanned-allowed');
      }

      const failureClass = approxFailureClass({ row: { ...row, resolvedGold: false }, patch, goldPatchFiles: goldPatchFileList, maxSteps });
      counts.admitted++;
      records.push({
        tenant_id: tenant,
        task_signature: `swebench-lite:${id}`,
        instance_id: id, repo: inst.repo,
        task: String(inst.problem_statement || '').slice(0, 2000),
        cheap_failed_trace: { arm: armName, summary: summarizeRow(armName, row, patch), steps: row.steps, thrash: row.thrash, resolvedInLoop: !!row.resolvedInLoop, gold: false, patch_empty: !patch.trim(), source: arm.source },
        strong_success_trace: { arm: teacher.arm, kind: teacher.kind, gold: teacher.gold, advice_excerpt: teacher.advice ? String(teacher.advice).slice(0, 1200) : null, contamination: teacher.contamination ?? 'n/a-no-advice', source: arms[teacher.arm]?.source ?? 'pre-authored-oracle-advice' },
        successful_patch: teacher.patch,
        test_proof: teacher.testProof,
        retrieval_keys: [inst.repo, id, `failure-class-${failureClass}`],
        replay_eligible: true,
        failure_class: failureClass,
        student_patch: patch || null,
        gold_patch_files: goldPatchFileList,
      });
    }
  }
  return { records, counts };
}

// ── CLI wiring ────────────────────────────────────────────────────────────────────────────────────

function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const argvAll = (f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []));
  const rel = (p) => (isAbsolute(p) ? p : join(HERE, '..', p)); // relative to bench/swebench
  const J = (p) => JSON.parse(readFileSync(p, 'utf8'));

  const dirs = [argv('--fable-bench', null), argv('--adr226', null), join(HERE, '..')].filter(Boolean).map(rel);
  const manifest = J(rel(argv('--manifest', 'advisor-medium-25.json'))).instances;
  const out = rel(argv('--out', 'gepa/reflective-dataset.json'));
  const tenant = argv('--tenant', 'local-bench');
  const allowUnscanned = args.includes('--allow-unscanned');
  const goldMaps = Object.fromEntries(argvAll('--gold').map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));

  // gold patches: --gold-patches cache file, else fetch via the swebench venv's HF cache (scoring-side only).
  const gpPath = argv('--gold-patches', null);
  const goldPatches = fetchGoldPatches(manifest.map((i) => i.instance_id), gpPath ? rel(gpPath) : null);
  if (goldPatches) console.error(`[gold-patches] ${Object.keys(goldPatches).length} available`);
  else console.error('[gold-patches] missing — contamination scan will gate records out unless --allow-unscanned');

  // discover arm reports (+ preds jsonl) across the given dirs
  const arms = {};
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/^(fadv|advbench)-.*-report\.json$/.test(f)) continue;
      const armName = f.replace(/-report\.json$/, '');
      let report; try { report = J(join(dir, f)); } catch { continue; }
      const predsFile = join(dir, `${armName}.jsonl`);
      const preds = {};
      if (existsSync(predsFile)) {
        for (const line of readFileSync(predsFile, 'utf8').split('\n').filter(Boolean)) {
          try { const p = JSON.parse(line); preds[p.instance_id] = p.model_patch || ''; } catch { /**/ }
        }
      }
      let gold = null;
      if (goldMaps[armName] && existsSync(goldMaps[armName])) {
        try { gold = new Set(J(goldMaps[armName]).resolved_ids || []); } catch { /**/ }
      }
      // teacher = an arm with a strong advisor or a cascade/acting arm; student = cheap solo (advisorModel none/self)
      const adv = report.advisorModel;
      const kind = (!report.mode || (adv && adv !== 'none' && adv !== report.model)) ? 'teacher' : 'student';
      arms[armName] = { report, preds, gold, kind, source: join(dir, f), goldSource: goldMaps[armName] || null };
    }
  }
  // pre-authored oracle advice (gold-derived by construction, ADR-226 §4.8)
  const oracleAdvice = {};
  for (const dir of dirs) {
    const od = join(dir, 'advisor-oracle-advice');
    if (!existsSync(od)) continue;
    for (const f of readdirSync(od)) if (f.endsWith('.txt')) oracleAdvice[f.replace(/\.txt$/, '')] = readFileSync(join(od, f), 'utf8');
  }

  console.error(`[arms] ${Object.entries(arms).map(([n, a]) => `${n}(${a.kind}${a.gold ? `,gold=${a.gold.size}` : ',gold=?'})`).join(' ')}`);
  console.error(`[oracle-advice] ${Object.keys(oracleAdvice).length} pre-authored files`);
  const { records, counts } = buildRecords({ arms, manifest, goldPatches, oracleAdvice, tenant, allowUnscanned });
  writeFileSync(out, JSON.stringify({
    built_at: new Date().toISOString(), tenant,
    gates: ['paired', 'verified-outcome', 'contamination-scan', 'provenance', 'replay-eval-convertible'],
    counts, sources: Object.fromEntries(Object.entries(arms).map(([n, a]) => [n, a.source])),
    records,
  }, null, 2));
  console.error(`DONE: ${counts.admitted} admitted / ${counts.candidates} candidates; dropped: ${JSON.stringify(counts.dropped)} → ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
