// SPDX-License-Identifier: MIT
//
// score-gaia.mjs — conformant, leak-free scorer for the GAIA-class agentic runs.
//
// Scores predictions (model_answer) against the manifest gold (answer) with
// GAIA-style normalization (numeric / list / string pathways from the official
// scorer.py, ported to JS — strip $%,, lowercase, drop articles+punctuation,
// element-wise list compare). Reports:
//   - acc_em        strict normalized exact-match (the headline, conformant)
//   - acc_relaxed   gold normalized-tokens fully contained in the prediction
//   - Wilson 95% CI on acc_em
//   - total_cost_usd, cost_per_task, cost_per_correct  (the Pareto axes)
//
// Emits a per-model results.json suitable for docs/research/cheap-vs-frontier/empirical/.
//
// Run: node --experimental-strip-types score-gaia.mjs \
//   --manifest manifest-frames.json --predictions preds.jsonl --model deepseek/deepseek-v4-pro --out results.json

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const rel = (p) => (isAbsolute(p) ? p : join(HERE, p));

// ── GAIA scorer.py normalization, ported (kept faithful to the edge cases) ──
function normalizeNumberStr(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normalizeStr(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }

/** Strict GAIA-style exact match (numeric → list → string pathways). */
function questionScorer(pred, gold) {
  pred = String(pred ?? ''); gold = String(gold ?? '');
  const gn = normalizeNumberStr(gold);
  if (gn !== null) { const pn = normalizeNumberStr(pred); return pn !== null && pn === gn; }
  const gl = splitList(gold);
  if (gl.length > 1) {
    const pl = splitList(pred);
    if (pl.length !== gl.length) return false;
    return gl.every((g, i) => { const gnum = normalizeNumberStr(g); if (gnum !== null) { const pnum = normalizeNumberStr(pl[i]); return pnum !== null && pnum === gnum; } return normalizeStr(g) === normalizeStr(pl[i]); });
  }
  return normalizeStr(pred) === normalizeStr(gold);
}
/** Relaxed: every gold token appears (order-free) in the prediction. */
function relaxedMatch(pred, gold) {
  const g = normalizeStr(gold), p = normalizeStr(pred);
  if (!g) return false;
  if (p.includes(g)) return true;
  const gt = g.split(' ').filter((t) => t.length > 1);
  return gt.length > 0 && gt.every((t) => p.includes(t));
}

// Wilson 95% score interval for a binomial proportion.
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

const manifest = JSON.parse(readFileSync(rel(argv('--manifest', 'manifest-frames.json')), 'utf8'));
const gold = new Map(manifest.tasks.map((t) => [t.task_id, t]));
const preds = readFileSync(rel(argv('--predictions', 'preds-gaia.jsonl')), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const MODEL = argv('--model', preds[0]?.model || 'unknown');
const OUT = rel(argv('--out', 'results.json'));

let em = 0, relaxed = 0, totalCost = 0, scored = 0;
const perReasoning = {};
const details = [];
for (const p of preds) {
  const g = gold.get(p.task_id); if (!g) continue;
  scored++;
  const isEm = questionScorer(p.model_answer, g.answer);
  const isRx = relaxedMatch(p.model_answer, g.answer);
  if (isEm) em++; if (isRx) relaxed++;
  totalCost += p.cost_usd || 0;
  const rt = (p.reasoning_types || g.reasoning_types || 'unknown').split('|')[0].slice(0, 24) || 'unknown';
  (perReasoning[rt] ||= { n: 0, em: 0 }); perReasoning[rt].n++; if (isEm) perReasoning[rt].em++;
  details.push({ task_id: p.task_id, em: isEm, relaxed: isRx, gold: g.answer, pred: p.model_answer, cost_usd: p.cost_usd });
}

const accEm = scored ? em / scored : 0;
const [lo, hi] = wilson(em, scored);
const results = {
  model: MODEL, dataset: manifest.dataset || 'frames', split: manifest.split || 'test', seed: manifest.seed,
  n: scored,
  acc_em: Math.round(accEm * 1e4) / 1e4,
  correct_em: em,
  acc_em_wilson95: [Math.round(lo * 1e4) / 1e4, Math.round(hi * 1e4) / 1e4],
  acc_relaxed: scored ? Math.round(relaxed / scored * 1e4) / 1e4 : 0,
  correct_relaxed: relaxed,
  total_cost_usd: Math.round(totalCost * 1e4) / 1e4,
  cost_per_task_usd: scored ? Math.round(totalCost / scored * 1e6) / 1e6 : 0,
  cost_per_correct_usd: em ? Math.round(totalCost / em * 1e6) / 1e6 : null,
  by_reasoning_type: Object.fromEntries(Object.entries(perReasoning).map(([k, v]) => [k, { n: v.n, acc_em: Math.round(v.em / v.n * 1e4) / 1e4 }])),
  scorer: 'gaia-style-normalized-exact-match (conformant, leak-free)',
  ts: new Date().toISOString(),
};
writeFileSync(OUT, JSON.stringify(results, null, 2));
// Optional: dump per-task detail next to results for auditing.
writeFileSync(OUT.replace(/\.json$/, '.details.json'), JSON.stringify(details, null, 2));

console.error(`MODEL ${MODEL} | n=${scored} | EM ${em}/${scored}=${(accEm * 100).toFixed(1)}% (95% CI ${(lo * 100).toFixed(1)}–${(hi * 100).toFixed(1)}%) | relaxed ${(relaxed / scored * 100).toFixed(1)}% | $${results.total_cost_usd} → $${results.cost_per_task_usd}/task, $${results.cost_per_correct_usd}/correct`);
console.log(JSON.stringify(results, null, 2));
