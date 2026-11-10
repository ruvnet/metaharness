#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Post-solve escalation predictor (offline study, $0).
//
// The cascade today escalates a cheap-tier attempt to the frontier model only
// when the cheap patch is EMPTY. This asks whether a NON-empty cheap patch that
// will fail the gold evaluation can be recognised from the patch itself, so it
// could be escalated too. ADR-169's pre-solve difficulty router (issue text
// only) measured a null (AUC 0.505); this uses post-solve patch features.
//
// Data: every committed (predictions, gold report) pair in this directory.
// Validation: instance-grouped k-fold cross-validation, repeated; an instance
// never appears in both train and test, across ALL runs. No gold information
// is a feature. Repo and run base rates are computed inside the training fold.
//
//   node escalation-predictor.mjs [--target e1-agentic-v4pro-300] [--repeats 10] [--folds 5] [--json out.json]

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFeatures as issueFeatures, FEATURE_NAMES as ISSUE_NAMES } from './difficulty-router.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argv = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const REPEATS = Number(argv('--repeats', 10));
const FOLDS = Number(argv('--folds', 5));
const TARGETS = argv('--target', 'e1-agentic-v4pro-300,agentic-v4pro-300,3tier-300,v4pro-hybrid-300').split(',');

// ---------- data ----------
export function loadRuns(dir = HERE) {
  const J = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const reports = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { const j = J(f); return Array.isArray(j?.resolved_ids) && Array.isArray(j?.empty_patch_ids) && Array.isArray(j?.submitted_ids) ? { f, j } : null; } catch { return null; }
  }).filter(Boolean);
  const runs = [];
  for (const pf of readdirSync(dir).filter((f) => /^predictions.*\.jsonl$/.test(f)).sort()) {
    const rows = readFileSync(join(dir, pf), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (rows.length < 100) continue;
    const ids = new Set(rows.map((r) => r.instance_id));
    const empty = new Set(rows.filter((r) => !(r.model_patch || '').trim()).map((r) => r.instance_id));
    // A report belongs to a prediction file only if both the submitted set and the empty-patch set match exactly.
    const match = reports.find(({ j }) => j.submitted_ids.length === ids.size && j.submitted_ids.every((i) => ids.has(i))
      && j.empty_patch_ids.length === empty.size && j.empty_patch_ids.every((i) => empty.has(i)));
    if (!match) continue;
    const resolved = new Set(match.j.resolved_ids);
    runs.push({
      name: pf.replace(/^predictions-?/, '').replace(/\.jsonl$/, '') || 'base',
      rows: rows.filter((r) => (r.model_patch || '').trim()).map((r) => ({ id: r.instance_id, patch: r.model_patch, y: resolved.has(r.instance_id) ? 1 : 0 })),
    });
  }
  const issues = new Map();
  for (const f of ['full-300.json', 'verified-500.json']) {
    try { for (const inst of J(f).instances) issues.set(inst.instance_id, inst); } catch { /* optional */ }
  }
  return { runs, issues };
}

// ---------- features ----------
export const PATCH_NAMES = [
  'log_patch_chars', 'n_files', 'n_hunks', 'log_added', 'log_removed', 'add_remove_balance',
  'touches_tests', 'creates_file', 'only_additions', 'max_hunk_lines', 'comment_frac',
  'adds_guard', 'adds_try', 'adds_import', 'file_named_in_issue', 'ident_overlap',
];

export function patchFeatures(patch, issueText = '') {
  const lines = patch.split('\n');
  const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
  const hunks = lines.filter((l) => l.startsWith('@@')).length;
  const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
  const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).map((l) => l.slice(1));
  let maxHunk = 0; let cur = 0;
  for (const l of lines) {
    if (l.startsWith('@@')) { maxHunk = Math.max(maxHunk, cur); cur = 0; } else if (/^[+-](?![+-]{2})/.test(l)) cur += 1;
  }
  maxHunk = Math.max(maxHunk, cur);
  const code = added.filter((l) => l.trim());
  const comments = code.filter((l) => /^\s*(#|"""|''')/.test(l)).length;
  const issue = issueText.toLowerCase();
  const named = files.some((f) => issue.includes(f.toLowerCase()) || issue.includes(f.split('/').pop().toLowerCase()));
  const idents = new Set(added.join('\n').match(/[A-Za-z_][A-Za-z0-9_]{4,}/g) || []);
  let overlap = 0;
  for (const id of idents) if (issue.includes(id.toLowerCase())) overlap += 1;
  return [
    Math.log1p(patch.length), files.length, hunks, Math.log1p(added.length), Math.log1p(removed.length),
    (added.length - removed.length) / (added.length + removed.length + 1),
    files.some((f) => /(^|\/)(tests?\/|test_|conftest)/i.test(f)) ? 1 : 0,
    /^--- \/dev\/null$/m.test(patch) ? 1 : 0,
    removed.length === 0 ? 1 : 0,
    Math.log1p(maxHunk),
    code.length ? comments / code.length : 0,
    code.some((l) => /^\s*(if|elif)\b/.test(l)) ? 1 : 0,
    code.some((l) => /^\s*(try:|except\b)/.test(l)) ? 1 : 0,
    code.some((l) => /^\s*(import|from)\s/.test(l)) ? 1 : 0,
    named ? 1 : 0,
    idents.size ? overlap / idents.size : 0,
  ];
}

const repoOf = (id) => id.split('__')[0];

/** Feature groups, so the study can report which information carries the signal. */
export const FEATURE_SETS = {
  issue: { patch: false, issue: true, priors: false },
  patch: { patch: true, issue: false, priors: false },
  'patch+issue': { patch: true, issue: true, priors: false },
  'patch+issue+priors': { patch: true, issue: true, priors: true },
};

function buildMatrix(rows, issues, set, priors) {
  return rows.map((r) => {
    const inst = issues.get(r.id) || { instance_id: r.id, problem_statement: '' };
    const v = [];
    if (set.patch) v.push(...patchFeatures(r.patch, inst.problem_statement || ''));
    if (set.issue) v.push(...issueFeatures(inst, {}).slice(0, ISSUE_NAMES.length - 1)); // drop its repo_prior slot: priors are in-fold here
    if (set.priors) v.push(priors.repo.get(`${r.run}|${repoOf(r.id)}`) ?? priors.run.get(r.run) ?? priors.global, priors.run.get(r.run) ?? priors.global);
    return v;
  });
}

/** Smoothed base rates from TRAINING rows only. */
function foldPriors(train) {
  const global = train.reduce((s, r) => s + r.y, 0) / Math.max(1, train.length);
  const agg = (key) => {
    const m = new Map();
    for (const r of train) { const k = key(r); const a = m.get(k) || [0, 0]; a[0] += r.y; a[1] += 1; m.set(k, a); }
    return m;
  };
  const run = new Map([...agg((r) => r.run)].map(([k, [s, n]]) => [k, (s + 5 * global) / (n + 5)]));
  const repo = new Map([...agg((r) => `${r.run}|${repoOf(r.id)}`)].map(([k, [s, n]]) => [k, (s + 5 * (run.get(k.split('|')[0]) ?? global)) / (n + 5)]));
  return { global, run, repo };
}

function standardize(train, test) {
  const d = train[0].length; const mean = new Array(d).fill(0); const sd = new Array(d).fill(0);
  for (const r of train) for (let j = 0; j < d; j++) mean[j] += r[j] / train.length;
  for (const r of train) for (let j = 0; j < d; j++) sd[j] += (r[j] - mean[j]) ** 2 / train.length;
  const z = (m) => m.map((r) => r.map((v, j) => (sd[j] > 1e-12 ? (v - mean[j]) / Math.sqrt(sd[j]) : 0)));
  return [z(train), z(test)];
}

// ---------- models ----------
function logistic(X, y, lambda = 1, iters = 400, lr = 0.1) {
  const d = X[0].length; const w = new Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const g = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < d; j++) g[j] += e * X[i][j]; gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / X.length + (lambda * w[j]) / X.length);
    b -= (lr * gb) / X.length;
  }
  return (T) => T.map((r) => { let z = b; for (let j = 0; j < d; j++) z += w[j] * r[j]; return 1 / (1 + Math.exp(-z)); });
}

let fannRuntime;
function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
/** ruv-fann ensemble: d → hidden (Tanh) → 1 (Sigmoid), trained on 0/1 targets, mean of `members`. */
export async function fann(X, y, { hidden = 6, epochs = 150, lr = 0.02, members = 5, seed = 0, maxRows = 2048 } = {}) {
  if (!fannRuntime) { const { loadRuntime } = await import('ruv-fann'); fannRuntime = await loadRuntime({ simd: 'auto' }); }
  // ruv-fann caps rows per call; subsample deterministically when the pool is larger.
  let idx = X.map((_, i) => i);
  if (idx.length > maxRows) { const r = mulberry32(seed + 99); idx = idx.map((i) => [r(), i]).sort((a, b) => a[0] - b[0]).slice(0, maxRows).map((p) => p[1]); }
  const d = X[0].length; const n = idx.length;
  const xs = new Float64Array(n * d); const ys = new Float64Array(n);
  idx.forEach((i, k) => { xs.set(X[i], k * d); ys[k] = y[i]; });
  const P = d * hidden + hidden + hidden + 1;
  const backward = n * (32 * P + 8 * (d + 1) + 1);
  const ep = Math.max(1, Math.min(epochs, Math.floor((100_000_000 - backward) / (backward + 64 * P))));
  const prepared = [];
  for (let m = 0; m < members; m++) {
    const rand = mulberry32(seed * 1000 + m + 1);
    const layer = (i, o, activation) => { const lim = Math.sqrt(6 / (i + o)); return { inputs: i, outputs: o, weights: Array.from({ length: i * o }, () => (rand() * 2 - 1) * lim), bias: new Array(o).fill(0), activation, steepness: 1 }; };
    const res = fannRuntime.train({ schema: 'ruv-fann.dense-layers/1', layers: [layer(d, hidden, 'Tanh'), layer(hidden, 1, 'Sigmoid')] },
      { inputs: xs, targets: ys, rows: n, epochs: ep, learningRate: lr, optimizer: 'adamw' });
    prepared.push(fannRuntime.prepare(res.model, { maxRows: 512 }));
  }
  return (T) => {
    const out = new Array(T.length).fill(0);
    for (let s = 0; s < T.length; s += 512) {
      const chunk = T.slice(s, s + 512); const tx = new Float64Array(chunk.length * d);
      chunk.forEach((r, i) => tx.set(r, i * d));
      for (const p of prepared) { const o = p.predict(tx, chunk.length); for (let i = 0; i < chunk.length; i++) out[s + i] += o[i] / prepared.length; }
    }
    return out;
  };
}
export const MODELS = {
  logistic: async (X, y) => logistic(X, y),
  'ruv-fann': async (X, y, seed) => fann(X, y, { seed }),
};

// ---------- metrics ----------
export function auc(scores, labels) {
  const order = scores.map((s, i) => [s, labels[i]]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0; let pos = 0;
  for (let i = 0; i < order.length;) {
    let j = i; while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (order[k][1] === 1) { rankSum += avg; pos += 1; }
    i = j + 1;
  }
  const neg = order.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

/**
 * Out-of-fold scores for `target` rows. `pool`: 'target' trains on the target
 * run's training-fold rows only; 'all' adds every other run's rows for the
 * training-fold INSTANCES (test-fold instances are excluded from every run).
 */
export async function oofScores({ runs, issues }, targetName, setName, modelName, pool, repeat) {
  const all = runs.flatMap((r) => r.rows.map((row) => ({ ...row, run: r.name })));
  const target = all.filter((r) => r.run === targetName);
  const ids = [...new Set(all.map((r) => r.id))].sort();
  const rand = mulberry32(1234 + repeat);
  const fold = new Map(ids.map((id) => [rand(), id]).sort((a, b) => a[0] - b[0]).map(([, id], i) => [id, i % FOLDS]));
  const scores = new Map();
  for (let f = 0; f < FOLDS; f++) {
    const train = (pool === 'all' ? all : target).filter((r) => fold.get(r.id) !== f);
    const test = target.filter((r) => fold.get(r.id) === f);
    if (!test.length) continue;
    const priors = foldPriors(train);
    const [Xtr, Xte] = standardize(buildMatrix(train, issues, FEATURE_SETS[setName], priors), buildMatrix(test, issues, FEATURE_SETS[setName], priors));
    const predict = await MODELS[modelName](Xtr, train.map((r) => r.y), repeat * 10 + f);
    predict(Xte).forEach((s, i) => scores.set(test[i].id, s));
  }
  return target.map((r) => ({ id: r.id, y: r.y, score: scores.get(r.id) }));
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

async function main() {
  const data = loadRuns();
  console.log(`runs: ${data.runs.map((r) => `${r.name} (${r.rows.length} non-empty, ${(100 * mean(r.rows.map((x) => x.y))).toFixed(0)}% resolved)`).join('; ')}`);
  console.log(`total labelled non-empty patches: ${data.runs.reduce((s, r) => s + r.rows.length, 0)}; ${FOLDS}-fold instance-grouped CV × ${REPEATS} repeats\n`);
  const table = [];
  for (const target of TARGETS) {
    for (const set of Object.keys(FEATURE_SETS)) for (const model of Object.keys(MODELS)) for (const pool of ['target', 'all']) {
      const aucs = [];
      for (let rep = 0; rep < REPEATS; rep++) { const s = await oofScores(data, target, set, model, pool, rep); aucs.push(auc(s.map((x) => x.score), s.map((x) => x.y))); }
      table.push({ target, features: set, model, 'train pool': pool, 'AUC mean': mean(aucs).toFixed(3), 'AUC sd (repeats)': sd(aucs).toFixed(3), min: Math.min(...aucs).toFixed(3) });
    }
  }
  console.table(table);
  if (argv('--json')) writeFileSync(argv('--json'), JSON.stringify(table, null, 2));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
