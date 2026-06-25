// SPDX-License-Identifier: MIT
// ADR-193 helper — run the OFFICIAL swebench gold eval on a predictions file (full manifest), parse the
// resolved set, compute resolve% + Wilson 95% CI. Gold tests used here for SCORING ONLY (conformant).
// Usage: node repro-select-eval.mjs --preds predictions-x.jsonl --manifest first25.json --run-id rs_x
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const VENV = '/tmp/swebench-venv';
const PREDS = rel(argv('--preds', ''));
const MANIFEST = JSON.parse(readFileSync(rel(argv('--manifest', 'first25.json')), 'utf8')).instances;
const RUN_ID = argv('--run-id', 'rs_eval_' + Date.now());
const OUT = rel(argv('--out', 'repro-select-eval-' + RUN_ID + '.json'));

const ids = MANIFEST.map((i) => i.instance_id);
const idArgs = ids.join(' ');
const predName = JSON.parse(readFileSync(PREDS, 'utf8').trim().split('\n')[0]).model_name_or_path || 'darwin';

console.error(`Running official swebench gold eval on ${ids.length} instances → run_id=${RUN_ID}`);
try {
  execSync(`. ${VENV}/bin/activate && python -m swebench.harness.run_evaluation --dataset_name princeton-nlp/SWE-bench_Lite --predictions_path ${PREDS} --instance_ids ${idArgs} --run_id ${RUN_ID} --max_workers 6 --cache_level instance --timeout 1200`,
    { cwd: '/tmp', shell: '/bin/bash', stdio: ['ignore', 'inherit', 'inherit'], timeout: 3_600_000, maxBuffer: 1 << 28 });
} catch (e) { console.error('eval harness returned nonzero (some unresolved) — continuing to parse logs'); }

// Determine resolved from the per-instance report.json files written under logs/run_evaluation/<run>/<model>/<id>/.
// The harness may sanitize model_name_or_path for the dir, so glob the model-level dirs rather than assume the name.
const resolved = [];
const runDir = `/tmp/logs/run_evaluation/${RUN_ID}`;
const modelDirs = existsSync(runDir) ? readdirSync(runDir) : [];
const candDirs = modelDirs.length ? modelDirs : [predName];
for (const id of ids) {
  for (const md of candDirs) {
    const rp = `${runDir}/${md}/${id}/report.json`;
    if (existsSync(rp)) { try { const r = JSON.parse(readFileSync(rp, 'utf8')); if (r[id]?.resolved) { resolved.push(id); break; } } catch { /**/ } }
  }
}
// Fallback: the top-level <model>.<run_id>.json swebench summary if present.
if (resolved.length === 0) {
  try {
    const f = readdirSync('/tmp').find((x) => x.includes(RUN_ID) && x.endsWith('.json'));
    if (f) { const j = JSON.parse(readFileSync('/tmp/' + f, 'utf8')); for (const id of (j.resolved_ids || [])) resolved.push(id); }
  } catch { /**/ }
}

const n = ids.length, k = resolved.length;
const z = 1.96, p = k / n, denom = 1 + z * z / n;
const centre = (p + z * z / (2 * n)) / denom;
const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
const lo = Math.max(0, centre - half), hi = Math.min(1, centre + half);
const out = { run_id: RUN_ID, preds: PREDS, model: predName, n, resolved: k, resolveRate: +(p * 100).toFixed(1), wilson95: [+(lo * 100).toFixed(1), +(hi * 100).toFixed(1)], resolved_ids: resolved.sort() };
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error('\n=== EVAL ===\n' + JSON.stringify(out, null, 2));
