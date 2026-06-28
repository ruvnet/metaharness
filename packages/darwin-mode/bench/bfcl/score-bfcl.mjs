// SPDX-License-Identifier: MIT
//
// score-bfcl.mjs — conformant AST grader for BFCL function-calling predictions.
//
// Faithful to the BFCL non-exec checker: a prediction is CORRECT iff there is a
// bijection between the gold calls and the model's emitted tool_calls such that,
// for each matched pair: (1) function names equal, (2) the model provides NO
// param absent from the gold spec (no hallucinated args), (3) every gold param is
// either present with a value in its acceptable set, or absent when the
// acceptable set marks it optional (contains ""), and (4) #calls match (parallel).
// Values compared with type coercion (10 == 10.0 == "10"; strings case/space-insensitive).
//
// Reports acc + Wilson 95% CI + per-category acc + $/task, $/correct. Leak-free
// (gold lives only in the manifest). Run:
//   node --experimental-strip-types score-bfcl.mjs --manifest manifest-bfcl.json \
//     --predictions preds.jsonl --model deepseek/deepseek-v4-pro --out results.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

function num(x) { if (typeof x === 'number') return x; if (typeof x === 'string' && x.trim() !== '' && !isNaN(Number(x))) return Number(x); return null; }
function eqCoerce(a, b) {
  const na = num(a), nb = num(b);
  if (na !== null && nb !== null) return na === nb;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => eqCoerce(x, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && eqCoerce(a[k], b[k]));
  }
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
const isOptional = (A) => A.some((v) => v === '' || v === null);
const valueOk = (v, A) => A.some((cand) => cand !== '' && cand !== null && eqCoerce(v, cand)) || (A.some((c) => c === '') && (v === '' || v == null));

function callMatches(modelCall, goldCall) {
  const name = Object.keys(goldCall)[0];
  if (modelCall.name !== name) return false;
  const goldParams = goldCall[name] || {};
  const argv2 = modelCall.args || {};
  // (2) no hallucinated params
  for (const k of Object.keys(argv2)) if (!(k in goldParams)) return false;
  // (3) each gold param satisfied
  for (const [p, A] of Object.entries(goldParams)) {
    const acc = Array.isArray(A) ? A : [A];
    if (p in argv2) { if (!valueOk(argv2[p], acc)) return false; }
    else if (!isOptional(acc)) return false;
  }
  return true;
}
// Perfect-matching (bijection) gold↔model via backtracking; require equal counts.
function gradeTask(goldTruth, modelCalls) {
  if (!Array.isArray(goldTruth) || goldTruth.length === 0) return false;
  if (modelCalls.length !== goldTruth.length) return false;
  const used = new Array(modelCalls.length).fill(false);
  const rec = (gi) => {
    if (gi === goldTruth.length) return true;
    for (let mi = 0; mi < modelCalls.length; mi++) {
      if (used[mi]) continue;
      if (callMatches(modelCalls[mi], goldTruth[gi])) { used[mi] = true; if (rec(gi + 1)) return true; used[mi] = false; }
    }
    return false;
  };
  return rec(0);
}

function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest-bfcl.json')), 'utf8'));
const gold = new Map(manifest.tasks.map((t) => [t.task_id, t]));
const preds = readFileSync(rel(argv('--predictions', 'preds-bfcl.jsonl')), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const MODEL = argv('--model', preds[0]?.model || 'unknown');
const OUT = rel(argv('--out', 'results.json'));

let correct = 0, totalCost = 0, scored = 0;
const perCat = {};
const details = [];
for (const p of preds) {
  const g = gold.get(p.task_id); if (!g) continue;
  scored++;
  const ok = gradeTask(g.ground_truth, p.calls || []);
  if (ok) correct++;
  totalCost += p.cost_usd || 0;
  const cat = p.category || g.category || 'unknown';
  (perCat[cat] ||= { n: 0, ok: 0 }); perCat[cat].n++; if (ok) perCat[cat].ok++;
  details.push({ task_id: p.task_id, category: cat, ok, gold: g.ground_truth, calls: p.calls, cost_usd: p.cost_usd });
}

const acc = scored ? correct / scored : 0;
const [lo, hi] = wilson(correct, scored);
const results = {
  model: MODEL, dataset: 'bfcl_v3', task_family: 'tool-use / function-calling',
  categories: manifest.categories, seed: manifest.seed, n: scored,
  acc, correct,
  acc_wilson95: [Math.round(lo * 1e4) / 1e4, Math.round(hi * 1e4) / 1e4],
  total_cost_usd: Math.round(totalCost * 1e4) / 1e4,
  cost_per_task_usd: scored ? Math.round(totalCost / scored * 1e6) / 1e6 : 0,
  cost_per_correct_usd: correct ? Math.round(totalCost / correct * 1e6) / 1e6 : null,
  by_category: Object.fromEntries(Object.entries(perCat).map(([k, v]) => [k, { n: v.n, acc: Math.round(v.ok / v.n * 1e4) / 1e4 }])),
  scorer: 'bfcl-ast-match (conformant, leak-free)',
  ts: new Date().toISOString(),
};
results.acc = Math.round(acc * 1e4) / 1e4;
writeFileSync(OUT, JSON.stringify(results, null, 2));
writeFileSync(OUT.replace(/\.json$/, '.details.json'), JSON.stringify(details, null, 2));
console.error(`MODEL ${MODEL} | n=${scored} | acc ${correct}/${scored}=${(acc * 100).toFixed(1)}% (95% CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%) | $${results.total_cost_usd} → $${results.cost_per_task_usd}/task | by-cat ${JSON.stringify(results.by_category)}`);
console.log(JSON.stringify(results, null, 2));
