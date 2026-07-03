// SPDX-License-Identifier: MIT
//
// ADR-228 §4 steps 4-7 — the GENOME EVALUATOR: runs one genome candidate on a manifest slice
// through the UNMODIFIED solve-advisor D0 path (`--genome` + `--transcripts-dir`, additive knobs),
// gold-scores the run, computes the pre-registered §5.1 metric per instance, and emits the rich
// per-instance textual feedback (ASI) — including the paired teacher-trace summary where the
// reflective dataset has one.
//
// Verified-contract rule 1: NEVER raises for individual instance failures — a failed instance
// scores 0.0 with the failure text as its feedback. num_metric_calls = N instances (rule 4).
//
// PAID when run for real: cheap-model rollouts (~$0.35/eval on medium-12 per ADR-228 §9.5) +
// Docker gold-scoring compute. The assembly step (assembleEvaluation) is pure and $0-tested.
//
// Usage:
//   OPENROUTER_API_KEY=$(cat /tmp/.orkey) node gepa/evaluate-genome.mjs \
//     --genome gepa/seed-genome.json --manifest advisor-medium-25.json --first 12 \
//     --model z-ai/glm-5.2 --max-steps 12 --concurrency 2 --max-cost 3 \
//     --reflective gepa/reflective-dataset.json --out gepa/eval-seed.json
//   Flags: --skip N (offset before --first, for holdout = --skip 12), --no-gold ($0 dry run,
//   goldResolved=false everywhere), --run-id label, --keep-artifacts dir.

import { readFileSync, writeFileSync, mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeTranscript, computeInstanceScore, classifyFailure, makeFeedback, goldFiles } from './metric.mjs';
import { fetchGoldPatches } from './build-reflective-dataset.mjs';

// ── pure assembly ($0-tested in evaluate-genome.test.mjs) ─────────────────────────────────────────

/** Compose a one-line teacher summary from a reflective-dataset record (ADR-228 §5.2). */
export function teacherSummaryFromRecord(rec) {
  if (!rec) return null;
  const t = rec.strong_success_trace || {};
  if (t.kind === 'oracle-advice' || t.kind === 'advisory') return `[${t.arm}/${t.kind}] ${t.advice_excerpt || ''}`.trim();
  const files = rec.successful_patch ? goldFiles(rec.successful_patch) : [];
  return `[${t.arm}/acting-success] resolved gold with a patch touching ${JSON.stringify(files.slice(0, 4))}`;
}

/**
 * Assemble per-instance {scores, feedbacks} from run artifacts. Never throws per instance:
 * missing rows/transcripts score 0.0 with an error feedback (verified contract rule 1).
 *   manifest     sliced instances [{instance_id, repo, problem_statement}]
 *   report       solve-advisor report JSON ({instances: rows})
 *   preds        { instId: patch }
 *   transcripts  { instId: { transcript, thrash, resolvedInLoop, cost } }
 *   resolvedIds  Set of gold-resolved ids (null ⇒ --no-gold: all false)
 *   goldPatches  { instId: goldPatch } | null
 *   reflective   { instId: reflectiveRecord } | null   (teacher pairing)
 */
export function assembleEvaluation({ manifest, report, preds = {}, transcripts = {}, resolvedIds = null, goldPatches = null, reflective = null, costCap = 0.5, maxSteps = 12 }) {
  const scores = {}; const feedbacks = {}; const details = {};
  let goldResolved = 0; let totalCost = 0;
  for (const inst of manifest) {
    const id = inst.instance_id;
    try {
      const row = (report?.instances || []).find((r) => r.instance_id === id);
      if (!row) throw new Error('no report row (solver crashed or budget-capped before this instance)');
      if (row.error) throw new Error(`solver error: ${row.error}`);
      const t = transcripts[id];
      const analysis = analyzeTranscript(t?.transcript || []);
      const patch = preds[id] ?? '';
      const gold = resolvedIds ? resolvedIds.has(id) : false;
      const goldPatchFiles = goldPatches?.[id] ? goldFiles(goldPatches[id]) : null;
      const scored = computeInstanceScore({
        goldResolved: gold, resolvedInLoop: !!row.resolvedInLoop, patch, goldPatchFiles,
        analysis, cost: row.cost || 0, thrash: row.thrash || 0, costCap,
      });
      const failureClass = classifyFailure({ goldResolved: gold, analysis, patch, goldPatchFiles, maxSteps });
      scores[id] = scored.score;
      feedbacks[id] = makeFeedback({ instanceId: id, analysis, scored, failureClass, goldPatchFiles, teacherSummary: teacherSummaryFromRecord(reflective?.[id]) });
      details[id] = { gold, resolvedInLoop: !!row.resolvedInLoop, failureClass, steps: row.steps, thrash: row.thrash, cost: row.cost, parts: scored.parts };
      if (gold) goldResolved++;
      totalCost += row.cost || 0;
    } catch (e) {
      scores[id] = 0.0; // never-raise contract
      feedbacks[id] = makeFeedback({ instanceId: id, error: String(e.message || e) });
      details[id] = { error: String(e.message || e) };
    }
  }
  const vals = Object.values(scores);
  return {
    scores, feedbacks, details, goldResolved, n: manifest.length,
    sumScore: Math.round(vals.reduce((s, x) => s + x, 0) * 1000) / 1000,
    meanScore: vals.length ? Math.round(vals.reduce((s, x) => s + x, 0) / vals.length * 1000) / 1000 : 0,
    cost: Math.round(totalCost * 1e4) / 1e4,
    metricCalls: manifest.length, // verified contract rule 4
  };
}

/** Index a reflective dataset by instance_id (first record wins — records are ordered by arm). */
export function indexReflective(dataset) {
  const byId = {};
  for (const r of dataset?.records || []) if (!(r.instance_id in byId)) byId[r.instance_id] = r;
  return byId;
}

// ── CLI wiring (spawns the real solver + gold harness) ────────────────────────────────────────────

function main() {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const BENCH = join(HERE, '..');
  const args = process.argv.slice(2);
  const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
  const rel = (p) => (isAbsolute(p) ? p : join(BENCH, p));
  const J = (p) => JSON.parse(readFileSync(p, 'utf8'));

  const genomePath = rel(argv('--genome', 'gepa/seed-genome.json'));
  const genome = J(genomePath);
  const manifestPath = rel(argv('--manifest', 'advisor-medium-25.json'));
  const skip = +argv('--skip', 0);
  const first = +argv('--first', Infinity);
  const model = argv('--model', 'z-ai/glm-5.2');
  const maxSteps = +argv('--max-steps', 12);
  const concurrency = +argv('--concurrency', 2);
  const maxCost = +argv('--max-cost', 3);
  // Gateway backend passthrough (ADR-210/204): forward --base-url + --api-key-env to solve-advisor so
  // rollouts route through the meta-llm Completions API (cache + metering). Absent ⇒ OpenRouter-direct.
  const baseUrl = argv('--base-url', null);
  const apiKeyEnv = argv('--api-key-env', null);
  const noGold = args.includes('--no-gold');
  const runId = (argv('--run-id', `gepa_${genome.meta?.id || 'genome'}_${Date.now().toString(36)}`)).replace(/[^a-zA-Z0-9_]/g, '_');
  const outPath = rel(argv('--out', `gepa/eval-${runId}.json`));
  const reflectivePath = argv('--reflective', null);
  const keepDir = argv('--keep-artifacts', null);

  const all = J(manifestPath).instances;
  const slice = all.slice(skip, skip + (Number.isFinite(first) ? first : all.length));
  const work = keepDir ? rel(keepDir) : mkdtempSync(join(tmpdir(), 'gepa-eval-'));
  execSync(`mkdir -p ${JSON.stringify(work)}`);
  const tmpManifest = join(work, 'slice.json');
  writeFileSync(tmpManifest, JSON.stringify({ instances: slice }));
  const preds = join(work, 'preds.jsonl');
  const reportPath = join(work, 'report.json');
  const tdir = join(work, 'transcripts');

  console.error(`[evaluate] genome=${genome.meta?.id} model=${model} n=${slice.length} (skip ${skip}) runId=${runId}`);
  // 1. rollouts through the UNMODIFIED solve-advisor D0 path (conformant: --no-test-oracle)
  execFileSync('node', ['--no-warnings', join(BENCH, 'solve-advisor.mjs'),
    '--manifest', tmpManifest, '--model', model, '--advisor-model', 'none',
    '--max-steps', String(maxSteps), '--concurrency', String(concurrency), '--max-cost', String(maxCost),
    '--no-test-oracle', '--genome', genomePath, '--transcripts-dir', tdir,
    ...(baseUrl ? ['--base-url', baseUrl] : []),
    ...(apiKeyEnv ? ['--api-key-env', apiKeyEnv] : []),
    '--out', preds, '--report', reportPath,
  ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 3 * 3600 * 1000 });

  // 2. gold scoring (Docker; the same harness every arm uses)
  let resolvedIds = null;
  if (!noGold) {
    try {
      execSync(`. /tmp/swebench-venv/bin/activate && python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${preds} --run_id ${runId} --max_workers ${Math.min(4, concurrency * 2)} --cache_level instance --timeout 1200`,
        { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'], timeout: 4 * 3600 * 1000, maxBuffer: 1 << 28 });
    } catch { /* per-instance failures are fine; the report below is authoritative */ }
    try { resolvedIds = new Set(J(`/tmp/darwin-advisor.${runId}.json`).resolved_ids || []); }
    catch { console.error('[gold] report missing — scoring as 0 gold (never-raise)'); resolvedIds = new Set(); }
  }

  // 3. assemble scores + ASI
  const predMap = {};
  if (existsSync(preds)) for (const line of readFileSync(preds, 'utf8').split('\n').filter(Boolean)) {
    try { const p = JSON.parse(line); predMap[p.instance_id] = p.model_patch || ''; } catch { /**/ }
  }
  const transcripts = {};
  if (existsSync(tdir)) for (const f of readdirSync(tdir)) {
    try { const t = J(join(tdir, f)); transcripts[t.instance_id] = t; } catch { /**/ }
  }
  const goldPatches = fetchGoldPatches(slice.map((i) => i.instance_id), join(BENCH, 'gepa/gold-patches.json'));
  const reflective = reflectivePath ? indexReflective(J(rel(reflectivePath))) : null;
  const report = existsSync(reportPath) ? J(reportPath) : { instances: [] };
  const evaluation = assembleEvaluation({ manifest: slice, report, preds: predMap, transcripts, resolvedIds, goldPatches, reflective, maxSteps });

  writeFileSync(outPath, JSON.stringify({
    genome: genome.meta?.id ?? genomePath, genomePath, model, manifest: manifestPath, skip, first: slice.length,
    maxSteps, noGold, runId, evaluatedAt: new Date().toISOString(),
    ...evaluation,
    artifacts: keepDir ? { preds, report: reportPath, transcripts: tdir } : null,
  }, null, 2));
  if (!keepDir) { try { rmSync(work, { recursive: true, force: true }); } catch { /**/ } }
  console.error(`[evaluate] DONE gold ${evaluation.goldResolved}/${evaluation.n} sum=${evaluation.sumScore} mean=${evaluation.meanScore} $${evaluation.cost} → ${outPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
