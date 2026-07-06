// D1-S4 — the REAL gradePredictions: wrap the OFFICIAL swebench Docker harness (run_evaluation). Given
// flywheel predictions [{instance_id, model_patch}], write predictions.jsonl, run the harness (builds
// per-instance Docker envs + runs the gold tests), and parse the report for the resolved set. This is the
// ONLY thing that gold-scores SWE-bench — the flywheel/adapter never re-implements it. Heavy (Docker +
// minutes/instance); used only for the budgeted live run.
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function makeSwebenchGrader({
  venvPython = '/tmp/swebench-venv/bin/python',
  // The frozen holdout/anchor (from full-300.json) are SWE-bench_LITE instance IDs — verified 40/40 ∩ Lite
  // vs only 11/40 ∩ Verified. The grader MUST pass the dataset that actually contains the IDs, or
  // run_evaluation aborts with "Some prediction IDs not found in dataset!" (the D1-S4 smoke's exact failure).
  dataset = 'princeton-nlp/SWE-bench_Lite',
  split = 'test',
  maxWorkers = 4,
  runIdPrefix = 'fw',
  timeoutPerInstance = 1800,
} = {}) {
  let n = 0;
  return async function gradePredictions(predictions) {
    const work = mkdtempSync(join(tmpdir(), 'fw-grade-'));
    const runId = `${runIdPrefix}-${n++}`;
    const model = predictions.find((p) => p.model_name_or_path)?.model_name_or_path ?? 'darwin-flywheel';
    const predPath = join(work, 'preds.jsonl');
    writeFileSync(predPath, predictions.map((p) => JSON.stringify({ instance_id: p.instance_id, model_name_or_path: model, model_patch: p.model_patch ?? '' })).join('\n') + '\n');
    const ids = predictions.map((p) => p.instance_id);

    const res = spawnSync(venvPython, [
      '-m', 'swebench.harness.run_evaluation',
      '-d', dataset, '-s', split, '-p', predPath, '-id', runId,
      '--max_workers', String(maxWorkers), '-t', String(timeoutPerInstance),
      '--report_dir', work, '--cache_level', 'env', '-i', ...ids,
    ], { cwd: work, encoding: 'utf-8', timeout: (timeoutPerInstance + 120) * 1000 * Math.max(1, Math.ceil(ids.length / maxWorkers)), maxBuffer: 1 << 28 });

    // The harness writes a final report JSON (name varies by version: <model>.<run_id>.json). Find it +
    // read `resolved_ids`; fall back to scanning any report-shaped JSON in the work dir.
    let resolvedIds = [];
    const candidates = [join(work, `${model}.${runId}.json`), ...readdirSync(work).filter((f) => f.endsWith('.json')).map((f) => join(work, f))];
    for (const f of candidates) {
      try {
        if (!existsSync(f)) continue;
        const r = JSON.parse(readFileSync(f, 'utf-8'));
        const ri = r.resolved_ids ?? r.resolved ?? r.resolved_instances;
        if (Array.isArray(ri)) { resolvedIds = ri; break; }
        if (ri && typeof ri === 'object') { resolvedIds = Object.keys(ri); break; }
      } catch { /* keep scanning */ }
    }
    return { resolvedIds, runId, harnessExit: res.status, stderrTail: String(res.stderr || res.error || '').slice(-500) };
  };
}
