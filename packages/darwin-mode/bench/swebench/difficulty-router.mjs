// SPDX-License-Identifier: MIT
//
// ADR-169 (research E2) — learned difficulty router for cost-optimal escalation.
// Predict P(cheap tier resolves this instance); route only the low-probability
// tail to the expensive frontier tier, cutting frontier spend at equal resolve.
//
// PEER-REVIEW MITIGATION (the p≫N trap): with only ~300 labeled instances we do
// NOT feed a raw 384-D embedding (that memorizes + fails out-of-sample). We use a
// HANDFUL of interpretable SCALAR features, z-score standardize them, and train
// an L2-regularized logistic regression with a STRONG default lambda. Everything
// here is pure JS, deterministic, $0 — no model, no network.

/**
 * Interpretable scalar features from an instance (+ optional repo prior). Keep
 * this list SMALL (p ≪ N). All numeric; standardized before training.
 *   inst: { instance_id, repo?, problem_statement }
 *   ctx:  { repoResolveRate?: Map<repo, number> }  (historical cheap-tier rate)
 */
export const FEATURE_NAMES = [
  'log_issue_len',      // log1p(chars) — longer issues tend to be harder
  'n_code_blocks',      // ``` fences / indented blocks — repro detail
  'n_tracebacks',       // "Traceback"/"Error:" mentions — concrete failure
  'n_file_paths',       // *.py paths named in the issue — localization hints
  'n_code_idents',      // CamelCase / snake_case identifiers — specificity
  'repo_prior',         // historical cheap-tier resolve-rate for this repo
];

export function extractFeatures(inst, ctx = {}) {
  const t = String(inst.problem_statement || '');
  const repo = inst.repo || String(inst.instance_id || '').split('__')[0];
  const count = (re) => (t.match(re) || []).length;
  const repoPrior = (ctx.repoResolveRate && ctx.repoResolveRate.get(repo)) ?? 0.15; // global-ish default
  return [
    Math.log1p(t.length),
    count(/```|\n {4}\S/g),
    count(/Traceback|Error:|Exception|assert/gi),
    count(/[\w/]+\.py\b/g),
    Math.min(count(/\b[a-z]+_[a-z_]+\b|\b[A-Z][a-z]+[A-Z]\w*\b/g), 50),
    repoPrior,
  ];
}

/** Build {X, y, repos} from instances + a Set of cheap-tier resolved ids. */
export function buildDataset(instances, resolvedIds, ctx = {}) {
  const X = [], y = [];
  for (const inst of instances) {
    X.push(extractFeatures(inst, ctx));
    y.push(resolvedIds.has(inst.instance_id) ? 1 : 0);
  }
  return { X, y };
}

/** Per-column z-score standardization. Returns { Xz, mean, std }. */
export function standardize(X) {
  const n = X.length, d = X[0]?.length || 0;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j] / n;
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Xz = X.map((row) => row.map((v, j) => (v - mean[j]) / std[j]));
  return { Xz, mean, std };
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * L2-regularized logistic regression via full-batch gradient descent. Strong
 * default `l2` (peer-review mitigation against p≫N overfit). Bias is NOT
 * regularized. Deterministic (zero init).
 */
export function trainLogReg(Xz, y, { l2 = 2.0, lr = 0.1, iters = 500 } = {}) {
  const n = Xz.length, d = Xz[0]?.length || 0;
  const w = Array(d).fill(0); let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const p = sigmoid(Xz[i].reduce((s, v, j) => s + v * w[j], b));
      const err = p - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * Xz[i][j] / n;
      gb += err / n;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] + (l2 / n) * w[j]); // L2 on weights only
    b -= lr * gb;
  }
  return { w, b, l2 };
}

/** P(resolve) for a raw feature vector, given trained model + standardizer. */
export function predictProba(model, mean, std, features) {
  const z = features.reduce((s, v, j) => s + ((v - mean[j]) / std[j]) * model.w[j], model.b);
  return sigmoid(z);
}

/**
 * Routing decision: escalate to the expensive tier when predicted cheap-resolve
 * probability is below `threshold`. Returns { escalate, p }.
 */
export function route(model, mean, std, inst, ctx = {}, threshold = 0.5) {
  const p = predictProba(model, mean, std, extractFeatures(inst, ctx));
  return { escalate: p < threshold, p: Math.round(p * 1000) / 1000 };
}
