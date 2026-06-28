// SPDX-License-Identifier: MIT
//
// router-prep.mjs — build the difficulty-labeled dataset for the ruvector
// SemanticRouter cost-Pareto pilot ($0; uses EXISTING completed-run outcomes).
//
// Source of truth: Firestore `frames_preds` (per-model, per-task model_answer +
// cost) for the FRAMES n=150 seed-42 batch — deepseek-v4-pro & glm-5.2 (cheap)
// vs gpt-5.2 & opus-4.5 (frontier), the SAME questions per model. Gold answers
// come from the locally regenerated manifest-frames-n150.json (frames-loader,
// seed 42). Each model_answer is scored with the SAME GAIA-style normalized
// exact-match scorer used in score-gaia.mjs (conformant, leak-free).
//
// Labels (per task):
//   cheap_em  = cheap model EM-correct      (primary cheap = deepseek-v4-pro)
//   front_em  = frontier model EM-correct   (primary frontier = gpt-5.2)
//   class:
//     'easy'    cheap_em                       (route cheap — cheap already wins)
//     'hard'    !cheap_em && front_em          (route UP — the cases worth escalating)
//     'neither' !cheap_em && !front_em         (route cheap — frontier won't help, save $)
//   route_up  = (class === 'hard')   ← the binary target the router must predict
//
// Output: data/router-labels.json  (per-task records + per-model EM summary).
//
// Run: node router-prep.mjs [--cheap deepseek/deepseek-v4-pro] [--frontier openai/gpt-5.2]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const PROJECT = 'cognitum-20260110';
const CHEAP = argv('--cheap', 'deepseek/deepseek-v4-pro');
const FRONTIER = argv('--frontier', 'openai/gpt-5.2');
const MANIFEST = join(DATA, 'manifest-frames-n150.json');
const RAW_CACHE = join(DATA, 'frames-preds-firestore.json'); // cached Firestore pull (provenance)
const OUT = join(DATA, 'router-labels.json');

// ── GAIA scorer.py normalization, ported verbatim from score-gaia.mjs ──
function normalizeNumberStr(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function normalizeStr(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim();
}
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }
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

// ── pull frames_preds from Firestore (REST, gcloud bearer token) ──
function fetchFramesPreds() {
  if (existsSync(RAW_CACHE)) {
    console.error(`[prep] using cached Firestore pull: ${RAW_CACHE}`);
    return JSON.parse(readFileSync(RAW_CACHE, 'utf8'));
  }
  const token = execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/frames_preds?pageSize=100`;
  const raw = execSync(`curl -s -H "Authorization: Bearer ${token}" "${url}"`, { encoding: 'utf8', maxBuffer: 1 << 26 });
  const docs = JSON.parse(raw).documents || [];
  const byModel = {};
  for (const doc of docs) {
    const f = doc.fields;
    const model = f.model?.stringValue;
    const preds = JSON.parse(f.preds_json?.stringValue || '[]');
    if (model) byModel[model] = { ts: f.ts?.stringValue, n: +(f.n?.integerValue || 0), preds };
  }
  writeFileSync(RAW_CACHE, JSON.stringify(byModel, null, 2));
  console.error(`[prep] fetched ${Object.keys(byModel).length} model runs from Firestore → cached ${RAW_CACHE}`);
  return byModel;
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const gold = new Map(manifest.tasks.map((t) => [t.task_id, t]));
const byModel = fetchFramesPreds();
const models = Object.keys(byModel);
console.error(`[prep] models: ${models.join(', ')}`);

// score every model per task
const perModelEm = {}; // model -> {task_id -> {em, cost}}
const perModelSummary = {};
for (const m of models) {
  perModelEm[m] = {};
  let em = 0, cost = 0, n = 0;
  for (const p of byModel[m].preds) {
    const g = gold.get(p.task_id); if (!g) continue;
    const isEm = questionScorer(p.model_answer, g.answer);
    perModelEm[m][p.task_id] = { em: isEm, cost: p.cost_usd || 0, answer: p.model_answer };
    if (isEm) em++; cost += p.cost_usd || 0; n++;
  }
  perModelSummary[m] = { n, correct_em: em, acc_em: +(em / n).toFixed(4), total_cost_usd: +cost.toFixed(4), cost_per_task_usd: +(cost / n).toFixed(6) };
}
console.error('[prep] per-model EM:', JSON.stringify(perModelSummary, null, 2));

if (!perModelEm[CHEAP]) throw new Error(`cheap model ${CHEAP} not in frames_preds (have: ${models.join(', ')})`);
if (!perModelEm[FRONTIER]) throw new Error(`frontier model ${FRONTIER} not in frames_preds`);

// build per-task labeled records (intersection of tasks all 4 models answered + gold present)
const records = [];
let easy = 0, hard = 0, neither = 0;
for (const t of manifest.tasks) {
  const id = t.task_id;
  const c = perModelEm[CHEAP][id];
  const f = perModelEm[FRONTIER][id];
  if (!c || !f) continue;
  const cheap_em = c.em, front_em = f.em;
  let cls;
  if (cheap_em) cls = 'easy';
  else if (front_em) cls = 'hard';
  else cls = 'neither';
  if (cls === 'easy') easy++; else if (cls === 'hard') hard++; else neither++;
  records.push({
    task_id: id,
    question: t.question,
    gold: t.answer,
    reasoning_types: t.reasoning_types || '',
    cheap_em, front_em,
    cheap_cost: c.cost, front_cost: f.cost,
    // all-model EM for union/oracle analysis & best-of sensitivity
    em: Object.fromEntries(models.map((m) => [m, perModelEm[m][id]?.em ?? null])),
    cost: Object.fromEntries(models.map((m) => [m, perModelEm[m][id]?.cost ?? null])),
    class: cls,
    route_up: cls === 'hard',
  });
}

const out = {
  generated: new Date().toISOString(),
  source: 'Firestore frames_preds (FRAMES n=150, seed 42) + manifest-frames-n150.json gold',
  scorer: 'gaia-style-normalized-exact-match (conformant, leak-free; ported from score-gaia.mjs)',
  cheap_model: CHEAP,
  frontier_model: FRONTIER,
  n: records.length,
  per_model_em: perModelSummary,
  label_distribution: { easy, hard, neither },
  records,
};
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.error(`\n[prep] wrote ${OUT}`);
console.error(`[prep] n=${records.length}  easy=${easy} hard=${hard} neither=${neither}`);
console.error(`[prep] cheap(${CHEAP}) EM=${perModelSummary[CHEAP].acc_em}  frontier(${FRONTIER}) EM=${perModelSummary[FRONTIER].acc_em}`);
