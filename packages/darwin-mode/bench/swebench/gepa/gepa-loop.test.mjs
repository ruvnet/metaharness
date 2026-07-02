// SPDX-License-Identifier: MIT
// ADR-228 §9.1 — $0 tests for the GEPA loop: Pareto math, parent sampling, target selection from
// ASI votes, reflection parsing, and the end-to-end budgeted loop with scripted evaluator/reflector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paretoFrontier, sampleParent, mutationTargetVotes, pickTargetComponent,
  buildReflectionPrompt, parseReflection, gepaOptimize,
} from './gepa-loop.mjs';
import { SEED_GENOME } from './genome.mjs';

test('paretoFrontier: per-instance-best semantics, ties kept, mean-best tracked', () => {
  const cands = [
    { id: 'A', scores: { i1: 10, i2: 0, i3: 1 } },   // wins i1
    { id: 'B', scores: { i1: 2, i2: 9, i3: 1 } },    // wins i2, ties i3
    { id: 'C', scores: { i1: 1, i2: 1, i3: 1 } },    // ties i3 only
    { id: 'D', scores: { i1: 0, i2: 0, i3: 0 } },    // dominated — off the frontier
  ];
  const f = paretoFrontier(cands);
  assert.deepEqual(f.frontier.sort(), ['A', 'B', 'C']);
  assert.deepEqual(f.winners.i1, ['A']);
  assert.deepEqual(f.winners.i3.sort(), ['A', 'B', 'C']);
  assert.equal(f.wins.A, 2); // i1 + i3 tie
  assert.equal(f.best, 'B'); // mean 4 > A's 11/3
  assert.ok(!f.frontier.includes('D'), 'dominated candidate excluded');
});

test('sampleParent: frequency-weighted by instances won (deterministic rng)', () => {
  const cands = [
    { id: 'A', scores: { i1: 5, i2: 5, i3: 5 } }, // wins 3
    { id: 'B', scores: { i1: 0, i2: 0, i3: 0 } },
  ];
  assert.equal(sampleParent(cands, () => 0.0), 'A');
  assert.equal(sampleParent(cands, () => 0.99), 'A', 'B never wins an instance, never sampled');
  // two winners: A wins 2 (i1,i2), B wins 1 (i3) — rng>2/3 lands on B
  const cands2 = [{ id: 'A', scores: { i1: 5, i2: 5, i3: 0 } }, { id: 'B', scores: { i1: 0, i2: 0, i3: 3 } }];
  assert.equal(sampleParent(cands2, () => 0.1), 'A');
  assert.equal(sampleParent(cands2, () => 0.9), 'B');
});

test('mutationTargetVotes + pickTargetComponent: ASI hints drive the target, round-robin fallback', () => {
  const fbs = {
    a: 'score -2 …\nmutation target: retrieval_policy — stop grep loops',
    b: 'score -1 …\nmutation target: file localization (retrieval_policy / tool_grep) — cap misses',
    c: 'score 0 …\nmutation target: edit_policy — push line_edit',
  };
  const mutable = ['retrieval_policy', 'tool_grep', 'edit_policy', 'test_policy'];
  const votes = mutationTargetVotes(fbs, mutable);
  assert.equal(votes.retrieval_policy, 2);
  assert.equal(votes.tool_grep, 1);
  assert.equal(pickTargetComponent({ feedbacks: fbs, mutable }), 'retrieval_policy');
  // lastMutated is skipped → next-ranked
  assert.equal(pickTargetComponent({ feedbacks: fbs, mutable, lastMutated: 'retrieval_policy' }), 'tool_grep');
  // no hints → round-robin
  assert.equal(pickTargetComponent({ feedbacks: {}, mutable, step: 0 }), 'retrieval_policy');
  assert.equal(pickTargetComponent({ feedbacks: {}, mutable, step: 1 }), 'tool_grep');
});

test('buildReflectionPrompt: worst instances first, component text + rules included', () => {
  const p = buildReflectionPrompt({
    genome: SEED_GENOME, targetComponent: 'retrieval_policy',
    feedbacks: { good: 'x: score 11.9 (gold RESOLVED). fine', bad: 'y: score -3 (gold FAIL). thrash' },
    maxFeedbacks: 8,
  });
  assert.match(p, /--- component: retrieval_policy ---/);
  assert.ok(p.includes(SEED_GENOME.components.retrieval_policy));
  assert.ok(p.indexOf('[bad]') < p.indexOf('[good]'), 'worst-first ordering');
  assert.match(p, /keep any \{\{ext\}\}\/\{\{glob\}\} placeholders/);
  assert.match(p, /```component/);
});

test('parseReflection: fenced block, generic fence, bare text, degenerate rejection', () => {
  assert.equal(parseReflection('preamble\n```component\nNew policy text here.\n```\ntrailing'), 'New policy text here.');
  assert.equal(parseReflection('```\nGeneric fenced.\n```'), 'Generic fenced.');
  assert.equal(parseReflection('Bare prose proposal, no fence at all.'), 'Bare prose proposal, no fence at all.');
  assert.equal(parseReflection('```component\nhi\n```'), null, 'too-short proposal rejected');
  assert.equal(parseReflection(''), null);
});

test('gepaOptimize end-to-end: accepts improving mutation, Pareto-adds subset winner, respects budget', async () => {
  // Scripted world (markers anywhere in the genome): seed scores {i1:1, i2:0, i3:0}.
  // "FOCUS" fixes i2 (sum improves → accepted). "WEIRD" wins i3 but breaks i1 AND i2
  // (sum worse than its parent → Pareto-add, not accepted).
  const evaluate = async (genome) => {
    const g = JSON.stringify(genome.components);
    const scores = {
      i1: g.includes('WEIRD') ? 0 : 1,
      i2: (g.includes('FOCUS') && !g.includes('WEIRD')) ? 10 : 0,
      i3: g.includes('WEIRD') ? 10 : 0,
    };
    const feedbacks = {
      i1: `i1: score ${scores.i1} (gold ${scores.i1 ? 'RESOLVED' : 'FAIL'}).`,
      i2: `i2: score ${scores.i2} (gold FAIL).\nmutation target: retrieval_policy — stop grep loops`,
      i3: `i3: score ${scores.i3} (gold FAIL).\nmutation target: retrieval_policy — different subset`,
    };
    return { scores, feedbacks, cost: 0.1, metricCalls: 3 };
  };
  const proposals = [
    '```component\nStrategy: FOCUS on the traceback file first; keep {{ext}} in mind.\n```',
    '```component\nStrategy: WEIRD alternative exploration order for a different subset.\n```',
  ];
  let ri = 0;
  const reflect = async () => ({ raw: proposals[Math.min(ri++, proposals.length - 1)], cost: 0.01 });
  const res = await gepaOptimize({
    seed: SEED_GENOME, evaluate, reflect, rng: () => 0.9, // 0.9 → iteration 2 samples cand-1 as parent (wins 3 of 5)
    mutable: ['retrieval_policy', 'edit_policy'], maxCandidates: 3, maxMetricCalls: 100, maxCost: 100,
  });
  assert.equal(res.pool.length, 3);
  const cand1 = res.pool.find((c) => c.id === 'cand-1');
  assert.ok(cand1.accepted, 'sum-improving mutation accepted');
  assert.equal(cand1.scores.i2, 10);
  const cand2 = res.pool.find((c) => JSON.stringify(c.genome.components).includes('WEIRD'));
  assert.ok(cand2, 'subset winner Pareto-added');
  assert.equal(cand2.parent, 'cand-1', 'iteration 2 mutated the accepted candidate');
  assert.equal(cand2.accepted, false, 'sum did not improve — not "accepted", kept for its instance win');
  assert.ok(res.frontier.includes(cand2.id), 'subset winner on the frontier');
  assert.equal(res.best, 'cand-1', 'mean-best tracked');
  assert.equal(res.budget.metricCalls, 9, '3 evals × 3 instances (contract 4)');
  assert.ok(Math.abs(res.budget.evalCost - 0.3) < 1e-9);
  // Full frontier reported, not one winner (ADR-228 §8)
  assert.ok(res.frontier.length >= 2);
});

test('gepaOptimize: stall guard breaks the loop when nothing evaluates', async () => {
  const evaluate = async () => ({ scores: { i1: 1 }, feedbacks: {}, cost: 0, metricCalls: 1 });
  const reflect = async () => ({ raw: '', cost: 0 }); // every proposal degenerate
  const res = await gepaOptimize({ seed: SEED_GENOME, evaluate, reflect, rng: () => 0, mutable: ['retrieval_policy'], maxCandidates: 5, maxStall: 3 });
  assert.ok(res.history.some((h) => h.event === 'stalled'), 'loop terminated via stall guard');
  assert.equal(res.pool.length, 1, 'only the seed evaluated');
});

test('gepaOptimize: metric-call budget stops the loop; reflection errors are non-fatal', async () => {
  let evals = 0;
  const evaluate = async () => { evals++; return { scores: { i1: 1 }, feedbacks: { i1: 'i1: score 1' }, cost: 0, metricCalls: 1 }; };
  let first = true;
  const reflect = async () => { if (first) { first = false; throw new Error('transient 429'); } return { raw: '```component\nA sufficiently long proposal text.\n```', cost: 0 }; };
  const res = await gepaOptimize({ seed: SEED_GENOME, evaluate, reflect, rng: () => 0, mutable: ['retrieval_policy'], maxCandidates: 99, maxMetricCalls: 2 });
  assert.ok(res.history.some((h) => h.event === 'reflection-error'), 'error recorded, loop continued');
  assert.equal(res.budget.metricCalls, 2);
  assert.equal(evals, 2, 'stopped at the metric-call budget');
});

test('gepaOptimize: no-change proposals are rejected without spending an evaluation', async () => {
  let evals = 0;
  const evaluate = async () => { evals++; return { scores: { i1: 1 }, feedbacks: {}, cost: 0, metricCalls: 1 }; };
  let calls = 0;
  const reflect = async () => {
    calls++;
    if (calls < 3) return { raw: '```component\n' + SEED_GENOME.components.retrieval_policy + '\n```', cost: 0 };
    return { raw: '```component\nGenuinely new retrieval policy text.\n```', cost: 0 };
  };
  const res = await gepaOptimize({ seed: SEED_GENOME, evaluate, reflect, rng: () => 0, mutable: ['retrieval_policy'], maxCandidates: 2 });
  assert.equal(evals, 2, 'seed + one real candidate');
  assert.equal(res.history.filter((h) => h.event === 'proposal-rejected' && h.reason === 'no-change').length, 2);
});
