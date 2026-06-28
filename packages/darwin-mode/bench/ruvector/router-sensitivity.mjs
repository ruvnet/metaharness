// SPDX-License-Identifier: MIT
//
// router-sensitivity.mjs — robustness of the ruvector SemanticRouter difficulty
// null across every cheap×frontier pairing (and best-of pairs). Reuses the
// cached Firestore pull + cached ONNX embeddings — $0, no re-embedding.
// Confirms the routing null isn't an artifact of the deepseek↔gpt-5.2 choice.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const ROUTER_PATH = '/home/ruvultra/projects/ruvector/node_modules/@ruvector/router';

// scorer (ported from score-gaia.mjs)
function nNum(s) { const n = Number(String(s).replace(/[$%,]/g, '').trim()); return Number.isFinite(n) ? n : null; }
function nStr(s) { return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\w\s]/g, ' ').replace(/\b(a|an|the)\b/g, ' ').replace(/\s+/g, ' ').trim(); }
function splitList(s) { return String(s ?? '').split(/[,;]/).map((x) => x.trim()).filter(Boolean); }
function em(pred, gold) { pred = String(pred ?? ''); gold = String(gold ?? ''); const gn = nNum(gold); if (gn !== null) { const pn = nNum(pred); return pn !== null && pn === gn; } const gl = splitList(gold); if (gl.length > 1) { const pl = splitList(pred); if (pl.length !== gl.length) return false; return gl.every((g, i) => { const gnum = nNum(g); if (gnum !== null) { const pnum = nNum(pl[i]); return pnum !== null && pnum === gnum; } return nStr(g) === nStr(pl[i]); }); } return nStr(pred) === nStr(gold); }
function rng(seed) { let s = seed >>> 0; return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function shuffle(a, r) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function rocAuc(score, y) { const all = score.map((s, i) => ({ s, y: y[i] })).sort((a, b) => a.s - b.s); const nP = y.reduce((a, b) => a + b, 0), nN = y.length - nP; if (!nP || !nN) return null; let i = 0, rs = 0; while (i < all.length) { let j = i; while (j < all.length && all[j].s === all[i].s) j++; const ar = (i + 1 + j) / 2; for (let t = i; t < j; t++) if (all[t].y) rs += ar; i = j; } return (rs - nP * (nP + 1) / 2) / (nP * nN); }

const manifest = JSON.parse(readFileSync(join(DATA, 'manifest-frames-n150.json'), 'utf8'));
const gold = new Map(manifest.tasks.map((t) => [t.task_id, t]));
const byModel = JSON.parse(readFileSync(join(DATA, 'frames-preds-firestore.json'), 'utf8'));
const emb = JSON.parse(readFileSync(join(DATA, 'router-embeddings.json'), 'utf8'));
const { SemanticRouter } = require(ROUTER_PATH);

// per-model per-task EM
const score = {}; // model -> taskid -> bool
for (const m of Object.keys(byModel)) { score[m] = {}; for (const p of byModel[m].preds) { const g = gold.get(p.task_id); if (g) score[m][p.task_id] = em(p.model_answer, g.answer); } }

const order = emb.task_ids; // embedding row order
const N = order.length;
const CHEAP = ['deepseek/deepseek-v4-pro', 'z-ai/glm-5.2'];
const FRONT = ['openai/gpt-5.2', 'anthropic/claude-opus-4.5'];

// CV AUC for hard-detection via kNN SemanticRouter (reuse cached embeddings)
function cvAuc(y, K = 15, REPEATS = 20, FOLDS = 5) {
  const Float = (i) => new Float32Array(emb.vectors[i]);
  const sum = new Array(N).fill(0), cnt = new Array(N).fill(0);
  for (let rep = 0; rep < REPEATS; rep++) {
    const r = rng(1234 + rep * 7919);
    const pos = shuffle([...Array(N).keys()].filter((i) => y[i] === 1), r);
    const neg = shuffle([...Array(N).keys()].filter((i) => y[i] === 0), r);
    const fold = new Array(N); pos.forEach((i, t) => fold[i] = t % FOLDS); neg.forEach((i, t) => fold[i] = t % FOLDS);
    for (let f = 0; f < FOLDS; f++) {
      const train = [], test = []; for (let i = 0; i < N; i++) (fold[i] === f ? test : train).push(i);
      if (!train.some((i) => y[i] === 1) || !train.some((i) => y[i] === 0)) continue;
      const sr = new SemanticRouter({ dimension: emb.dim, metric: 'cosine', threshold: -2 });
      for (const i of train) sr.addIntent({ name: `t${i}`, utterances: [order[i]], embedding: Float(i), metadata: { y: y[i] } });
      const k = Math.min(K, train.length);
      for (const i of test) { const h = sr.routeWithEmbedding(Float(i), k); const s = h.length ? h.reduce((a, x) => a + (x.metadata?.y === 1 ? 1 : 0), 0) / h.length : 0; sum[i] += s; cnt[i]++; }
    }
  }
  const sc = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0);
  return rocAuc(sc, y);
}

function labelsFor(cheapModels, frontModels) {
  const cheapOK = (id) => cheapModels.some((m) => score[m][id]);
  const frontOK = (id) => frontModels.some((m) => score[m][id]);
  const y = order.map((id) => (!cheapOK(id) && frontOK(id)) ? 1 : 0);
  const easy = order.filter((id) => cheapOK(id)).length;
  const hard = y.reduce((a, b) => a + b, 0);
  const union = order.filter((id) => cheapOK(id) || frontOK(id)).length;
  const cheapAcc = order.filter((id) => cheapOK(id)).length / N;
  const frontAcc = order.filter((id) => frontOK(id)).length / N;
  return { y, easy, hard, neither: N - easy - hard, union, cheapAcc, frontAcc };
}

console.log(`pair                                  cheapEM  frontEM  hard  oracle(union)  kNN-AUC`);
const pairs = [
  [['deepseek/deepseek-v4-pro'], ['openai/gpt-5.2']],
  [['deepseek/deepseek-v4-pro'], ['anthropic/claude-opus-4.5']],
  [['z-ai/glm-5.2'], ['openai/gpt-5.2']],
  [['z-ai/glm-5.2'], ['anthropic/claude-opus-4.5']],
  [CHEAP, FRONT], // best-of-cheap vs best-of-frontier
];
const short = (a) => a.map((m) => m.split('/').pop()).join('+');
for (const [c, f] of pairs) {
  const L = labelsFor(c, f);
  const auc = cvAuc(L.y);
  const name = `${short(c)} ↔ ${short(f)}`;
  console.log(`${name.padEnd(38)} ${(L.cheapAcc * 100).toFixed(1)}%   ${(L.frontAcc * 100).toFixed(1)}%   ${String(L.hard).padStart(3)}   ${(L.union / N * 100).toFixed(1)}% (${L.union}/${N})    ${auc === null ? 'n/a' : auc.toFixed(3)}`);
}
console.log(`\n(AUC≈0.5 = no separation; routing gate needs ≥0.65–0.70 to consider a live eval)`);
