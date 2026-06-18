// SPDX-License-Identifier: MIT
// ADR-142 — analyze the pilot: join the official swebench report with the solve-report,
// compute resolve-rate + Wilson 95% CI + per-repo breakdown + cost. Honest reporting.
// Run: node bench/swebench/analyze.mjs <swebench_report.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const rep = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const solve = JSON.parse(readFileSync(join(HERE, 'solve-report-25.json'), 'utf8'));
const n = solve.instances.length; // honest denominator: the full stratified pilot (25), empty patches included as unresolved
const k = rep.resolved_instances;
// Wilson score interval, 95% (z=1.96)
const z = 1.96, p = k / n;
const denom = 1 + z * z / n;
const centre = (p + z * z / (2 * n)) / denom;
const half = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
const lo = Math.max(0, centre - half), hi = Math.min(1, centre + half);
const byRepo = {};
for (const r of solve.instances) { const repo = r.repo; (byRepo[repo] ||= { n: 0, patched: 0, resolved: 0 }); byRepo[repo].n++; if (r.blocksApplied) byRepo[repo].patched++; if ((rep.resolved_ids || []).includes(r.instance_id)) byRepo[repo].resolved++; }
const out = {
  experiment: 'ADR-142 — SWE-bench Lite pilot (stratified 25, deepseek/searchreplace, single-shot)',
  dataset: 'princeton-nlp/SWE-bench_Lite (test)', model: solve.model, harness: 'official swebench 4.1.0 (Docker)',
  n, resolved: k, resolveRate: +(p * 100).toFixed(1), wilson95: [+(lo * 100).toFixed(1), +(hi * 100).toFixed(1)],
  patchApplied: solve.instances.filter((r) => r.blocksApplied).length, emptyPatch: rep.empty_patch_instances, errors: rep.error_instances,
  solveCost_usd: solve.totalCost_usd,
  resolved_ids: rep.resolved_ids,
  perRepo: byRepo,
};
writeFileSync(join(HERE, 'pilot-25-result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
