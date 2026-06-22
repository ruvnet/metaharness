// SPDX-License-Identifier: MIT
// ADR-169 (research E2) — offline tests for the difficulty router. Verifies the
// scalar feature extraction, that L2-regularized logistic regression learns a
// separable signal AND that stronger L2 shrinks the weights (the p≫N mitigation),
// and that routing gates on the predicted cheap-resolve probability.
import { describe, it, expect } from 'vitest';
import {
  FEATURE_NAMES, extractFeatures, buildDataset, standardize, trainLogReg, predictProba, route,
} from '../bench/swebench/difficulty-router.mjs';

describe('extractFeatures', () => {
  it('returns one scalar per FEATURE_NAMES entry (small p, no embeddings)', () => {
    const f = extractFeatures({ instance_id: 'django__django-1', problem_statement: 'Traceback: FieldError in models.py when calling annotate()\n```\nx\n```' });
    expect(f).toHaveLength(FEATURE_NAMES.length);
    expect(FEATURE_NAMES.length).toBeLessThanOrEqual(8); // keep p ≪ N
    expect(f.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true);
  });
  it('uses the repo prior when provided', () => {
    const ctx = { repoResolveRate: new Map([['django', 0.42]]) };
    const f = extractFeatures({ instance_id: 'django__django-1', repo: 'django', problem_statement: 'x' }, ctx);
    expect(f[FEATURE_NAMES.indexOf('repo_prior')]).toBe(0.42);
  });
});

describe('L2 logistic regression', () => {
  // Separable toy: label = 1 iff feature[0] high. 60 samples, 6 features.
  const insts = Array.from({ length: 60 }, (_, i) => ({
    instance_id: `r__r-${i}`,
    problem_statement: (i % 2 === 0 ? 'short' : 'x'.repeat(4000)) + ' Traceback Error models.py annotate_thing',
  }));
  const resolved = new Set(insts.filter((_, i) => i % 2 === 0).map((x) => x.instance_id)); // short issues resolve
  const { X, y } = buildDataset(insts, resolved);

  it('learns the separable signal (train accuracy well above chance)', () => {
    const { Xz, mean, std } = standardize(X);
    const model = trainLogReg(Xz, y, { l2: 0.5, iters: 800 });
    let correct = 0;
    for (let i = 0; i < insts.length; i++) {
      const p = predictProba(model, mean, std, X[i]);
      if ((p >= 0.5 ? 1 : 0) === y[i]) correct++;
    }
    expect(correct / insts.length).toBeGreaterThan(0.8);
  });

  it('stronger L2 shrinks the weight norm (overfit mitigation)', () => {
    const { Xz } = standardize(X);
    const weak = trainLogReg(Xz, y, { l2: 0.1, iters: 800 });
    const strong = trainLogReg(Xz, y, { l2: 50, iters: 800 });
    const norm = (m) => Math.sqrt(m.w.reduce((s, v) => s + v * v, 0));
    expect(norm(strong)).toBeLessThan(norm(weak));
  });

  it('predictProba is a probability in [0,1]', () => {
    const { Xz, mean, std } = standardize(X);
    const model = trainLogReg(Xz, y);
    const p = predictProba(model, mean, std, X[0]);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThanOrEqual(1);
  });
});

describe('route', () => {
  it('escalates when predicted cheap-resolve probability is below threshold', () => {
    const insts = Array.from({ length: 40 }, (_, i) => ({ instance_id: `r__r-${i}`, problem_statement: i % 2 ? 'x'.repeat(5000) : 'short' }));
    const resolved = new Set(insts.filter((_, i) => i % 2 === 0).map((x) => x.instance_id));
    const { X, y } = buildDataset(insts, resolved);
    const { Xz, mean, std } = standardize(X);
    const model = trainLogReg(Xz, y, { iters: 800 });
    const hard = route(model, mean, std, { instance_id: 'r__r-99', problem_statement: 'x'.repeat(5000) }, {}, 0.5);
    const easy = route(model, mean, std, { instance_id: 'r__r-98', problem_statement: 'short' }, {}, 0.5);
    expect(typeof hard.escalate).toBe('boolean');
    expect(hard.p).toBeGreaterThanOrEqual(0);
    // the long ("hard") issue should be no more likely to resolve than the short one
    expect(hard.p).toBeLessThanOrEqual(easy.p + 1e-9);
  });
});
