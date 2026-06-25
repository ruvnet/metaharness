// SPDX-License-Identifier: MIT
// ADR-193 A/B — compare repro-select vs bo3+judge baseline on the SAME 25 instances. Reads the two
// eval JSONs (from repro-select-eval.mjs) + the union (oracle any-of-N) over the candidate sets, and
// the repro-select report (repro pass-rate, how-often-changed). Honest reporting: Δ + Wilson + noise flag.
import { readFileSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));
const J = (p) => JSON.parse(readFileSync(rel(p), 'utf8'));

const repro = J(argv('--repro-eval', 'repro-select-eval.json'));
const base = J(argv('--base-eval', 'baseline-eval.json'));
const report = J(argv('--repro-report', 'repro-select-report.json'));
const predFiles = (argv('--preds', '')).split(',').filter(Boolean).map(rel);
const manifest = J(argv('--manifest', 'first25.json')).instances;

// Oracle union (any-of-N) — needs per-candidate eval; if eval files for candidates are given, union them.
const candEvals = (argv('--cand-evals', '')).split(',').filter(Boolean).map(J);
const unionResolved = new Set();
for (const ce of candEvals) for (const id of (ce.resolved_ids || [])) unionResolved.add(id);

const n = manifest.length;
const wilson = (k) => { const z = 1.96, p = k / n, d = 1 + z * z / n; const c = (p + z * z / (2 * n)) / d; const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d; return [+(Math.max(0, c - h) * 100).toFixed(1), +(Math.min(1, c + h) * 100).toFixed(1)]; };

const rSet = new Set(repro.resolved_ids), bSet = new Set(base.resolved_ids);
const reproOnly = [...rSet].filter((x) => !bSet.has(x)).sort();
const baseOnly = [...bSet].filter((x) => !rSet.has(x)).sort();

const out = {
  experiment: 'ADR-193 — reproduction-test SELECTION vs bo3+judge baseline (same 25 Lite, conformant)',
  n,
  baseline_bo3_judge: { resolved: base.resolved, resolveRate: base.resolveRate, wilson95: base.wilson95 },
  repro_select: { resolved: repro.resolved, resolveRate: repro.resolveRate, wilson95: repro.wilson95 },
  delta_instances: repro.resolved - base.resolved,
  delta_pct: +((repro.resolved - base.resolved) / n * 100).toFixed(1),
  oracle_union_anyOfN: candEvals.length ? { resolved: unionResolved.size, resolveRate: +(unionResolved.size / n * 100).toFixed(1), wilson95: wilson(unionResolved.size) } : 'n/a (pass --cand-evals)',
  reproSelectOnly_ids: reproOnly,   // instances repro-select got that the baseline missed
  baselineOnly_ids: baseOnly,       // instances the baseline got that repro-select missed
  repro_diagnostics: report.summary,
  noise_flag: 'n=25 is DIRECTIONAL ONLY — a single-instance delta is inside Wilson noise; not a confirmation.',
};
console.log(JSON.stringify(out, null, 2));
