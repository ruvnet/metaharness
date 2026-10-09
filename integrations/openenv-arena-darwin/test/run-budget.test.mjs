// Run-budget settlement (units = runner calls) and the confirmation helpers. Stub evaluators only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBudgetedEvaluator } from '../lib/run-budget.mjs';
import { blockWins, changedFamilies, confirmationPower, pairedOutcomes } from '../lib/confirm.mjs';
import { genomeToCells } from '../lib/cells.mjs';

const toCells = g => Object.keys(g).map(f => ({ family: f, difficulty: g[f], budget: 8192, knobs: {} }));
const okCard = (id, raw = {}) => ({ variantId: id, primary: 1, regressed: false, noopRate: 0, costPerWin: 1, raw });

test('charges runner calls (attempts/4 per cell), refunds cache hits, charges retries', async () => {
  const runs = [];
  const ev = makeBudgetedEvaluator({ genomeToCells: toCells, maxTotalNewCells: 10, unitsPerCell: 2,
    run: async (g, id, allowance) => { runs.push([id, allowance]); return okCard(id, { runnerCalls: id === 'a' ? 5 : 0, attemptedNewCells: 2 }); } });
  await ev.evaluate({ x: 1, y: 1 }, 'a'); // reserves 2 cells x 2 = 4; the evaluator reports 5 calls (one infra retry)
  assert.equal(ev.stats().reservedNewCells, 5);
  await ev.evaluate({ x: 1, y: 1, z: 1 }, 'b'); // one fresh cell (2 units), all cache hits: refunded to 0
  assert.equal(ev.stats().reservedNewCells, 5);
  const refused = await ev.evaluate({ p: 1, q: 1, r: 1 }, 'c'); // 3 x 2 = 6 > 10 - 5
  assert.match(refused.evaluatorError, /max_total_new_cells_exceeded: needs 3 new cell\(s\) x 2 runner call/);
  assert.deepEqual(runs, [['a', 2], ['b', 1]]);
});

test('a FAILED cell is released and re-charged; evaluator refusals are counted, not leaked', async () => {
  let fail = true;
  const ev = makeBudgetedEvaluator({ genomeToCells: toCells, maxTotalNewCells: 6, unitsPerCell: 1,
    run: async (g, id, allowance) => {
      if (id === 'refuse') return { variantId: id, primary: -1, regressed: true, noopRate: 1, costPerWin: 1,
        raw: { evaluatorError: 'max_new_cells_exceeded: 2 > 1', attemptedNewCells: 0, runnerCalls: 0, cells: toCells(g) } };
      const cells = toCells(g).map(c => ({ ...c, ...(fail && c.family === 'x' ? { error: 'runner exit 1' } : {}) }));
      return { ...okCard(id, { runnerCalls: allowance, attemptedNewCells: allowance, cells }), regressed: fail };
    } });
  const first = await ev.evaluate({ x: 1, y: 1 }, 'base');
  assert.equal(first.regressed, true);
  assert.equal(ev.stats().releasedFailedCells, 1);
  fail = false;
  const again = await ev.evaluate({ x: 1, y: 1 }, 'retry'); // x is re-reserved (allowance 1), y stays reserved
  assert.equal(again.regressed, false);
  assert.equal(ev.stats().ledger.at(-1).reserved, 1);
  assert.equal(ev.stats().reservedNewCells, 3, 'x was paid twice (it ran twice), y once');
  await ev.evaluate({ q: 1, w: 1 }, 'refuse');
  const s = ev.stats();
  assert.equal(s.evaluatorRefusedEvaluations, 1);
  assert.equal(s.reservedNewCells, 3, 'a refusal card with runnerCalls 0 refunds its reservation');
  assert.equal((await ev.evaluate({ q: 1, w: 1, e: 1 }, 'after')).regressed, false, 'released cells can be reserved again');
});

test('a waiter whose shared cell failed reserves it itself instead of being refused by the evaluator', async () => {
  let releaseA;
  const gateA = new Promise(r => { releaseA = r; });
  const allowances = {};
  const ev = makeBudgetedEvaluator({ genomeToCells: toCells, maxTotalNewCells: 10, unitsPerCell: 1,
    run: async (g, id, allowance) => {
      allowances[id] = allowance;
      if (id === 'a') { await gateA; return { ...okCard(id, { runnerCalls: 2, cells: toCells(g).map(c => ({ ...c, error: c.family === 'x' ? 'boom' : undefined })) }), regressed: true }; }
      return okCard(id, { runnerCalls: allowance });
    } });
  const a = ev.evaluate({ x: 1, y: 1 }, 'a');
  const b = ev.evaluate({ x: 1, z: 1 }, 'b'); // waits on a for x
  releaseA();
  await Promise.all([a, b]);
  assert.equal(allowances.b, 2, 'b took over the failed cell x plus its own z');
});

const ep = (seed, reward, cls) => ({ seed, attempt: seed % 4, reward, cls, reason: 'x' });
const cell = (family, difficulty, key, rewardsPerBlock, seedBase = 800000) => ({ family, difficulty, budget: 8192, key,
  episodes: rewardsPerBlock.flatMap((rs, k) => rs.map((r, i) => ep(seedBase + 4 * k + i, r, r === 'T' ? 'truncation' : r === 1 ? 'solved' : 'partial')))
    .map(e => (e.reward === 'T' ? { ...e, reward: 0 } : e)) });
const prov = { envSourceSha: 'a', runnerSha: 'b', serverSha: 'c', runnerArgsSha: 'd', model: 'm', modelRevision: 'r', contextTokens: 1, seedBase: 800000, attempts: 8 };

test('pairedOutcomes pairs only changed cells, block by block; a truncated block never wins', () => {
  assert.equal(blockWins([ep(0, 1, 'solved'), ep(1, 0.5, 'partial'), ep(2, 1, 'solved'), ep(3, 1, 'solved')]), true);
  assert.equal(blockWins([ep(0, 1, 'solved'), ep(1, 0, 'truncation'), ep(2, 1, 'solved'), ep(3, 1, 'solved')]), false);
  assert.equal(blockWins([ep(0, 1, 'solved'), ep(1, 1, 'solved'), ep(2, 1, 'solved'), ep(3, 1, 'solved')]), false);
  const base = { raw: { provenance: prov, cells: [cell('math_route', 2, 'k1', [[1, 1, 1, 1], [1, 'T', 1, 1]]), cell('media_timeline', 2, 'k2', [[1, 1, 1, 1], [1, 1, 1, 1]])] } };
  const cand = { raw: { provenance: prov, cells: [cell('math_route', 3, 'k3', [[1, 0.5, 1, 1], [1, 'T', 0.5, 1]]), base.raw.cells[1]] } };
  assert.deepEqual(pairedOutcomes(base, cand), [
    { itemId: 'math_route:d2b8192->d3b8192@seed800000', candidateWon: true, baselineWon: false },
    { itemId: 'math_route:d2b8192->d3b8192@seed800004', candidateWon: false, baselineWon: false },
  ]);
  assert.throws(() => pairedOutcomes(base, { raw: { ...cand.raw, provenance: { ...prov, seedBase: 1 } } }), /pairing_provenance_mismatch:seedBase/);
  assert.throws(() => pairedOutcomes({ raw: {} }, cand), /pairing_needs_provenance/);
  assert.deepEqual(changedFamilies(genomeToCells, { 'math_route.difficulty': 2, 'math_route.budget': 8192 },
    { 'math_route.difficulty': 3, 'math_route.budget': 8192 }), ['math_route']);
});

test('confirmationPower: the e-value ceiling and the attempts needed to reach 1/alpha', () => {
  assert.deepEqual(confirmationPower({ changedCells: 1, attempts: 16 }), { threshold: 20, maxPairs: 4, maxEValue: 1.5 ** 4,
    blocksNeeded: 8, reachable: false, attemptsPerChangedCellNeeded: 32 });
  const thirteen = confirmationPower({ changedCells: 1, attempts: 64, candidateBudget: 13 });
  assert.deepEqual([thirteen.blocksNeeded, thirteen.reachable, thirteen.attemptsPerChangedCellNeeded], [14, true, 56]);
});
