// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from './darwin-ledger.mjs';
import { createProposer } from './tpe-proposer.mjs';
import { loadReplay, scoreState, syntheticCases } from './tuning-cases.mjs';

const grid = { seed: 123, moves: [1, 2, 4, 8, 16], restarts: [1, 2, 4] };

function proposals(method, score) {
  const proposer = createProposer({ method, ...grid });
  const results = [];
  for (let config; (config = proposer.suggest()) !== null;) {
    assert.ok(results.length < 15, 'proposed more settings than the grid contains');
    proposer.observe(config, score(config));
    results.push(config);
  }
  return results;
}

test('paired TPE warmup, seeded reproducibility, coverage and adaptation', () => {
  const score = ({ moves, restarts }) => moves + restarts;
  const random = proposals('random', score);
  const tpe = proposals('tpe', score);
  const expected = grid.moves.flatMap(m => grid.restarts.map(r => m + ':' + r)).sort();
  for (const sequence of [tpe, random]) {
    assert.deepEqual(sequence.map(c => c.moves + ':' + c.restarts).sort(), expected);
  }
  assert.deepEqual(tpe, proposals('tpe', score));
  assert.deepEqual(tpe.slice(0, 4), random.slice(0, 4));
  assert.deepEqual(proposals('tpe', () => 0), random);
  assert.notDeepEqual(tpe, proposals('tpe', c => -score(c)));
});

test('invalid observations do not consume the pending trial', () => {
  const proposer = createProposer({ method: 'tpe', ...grid });
  const config = proposer.suggest();
  assert.throws(() => proposer.observe(config, Infinity));
  assert.throws(() => proposer.observe({ moves: 999, restarts: 4 }, 0));
  proposer.observe(config, 0);
  assert.throws(() => proposer.observe(config, 0));
});

test('Darwin selects minimum loss, retains the first tie and rejects duplicate IDs', () => {
  const ledger = createLedger();
  assert.equal(ledger.best(), null);
  const first = { moves: 1, restarts: 1 };
  const second = { moves: 2, restarts: 1 };
  ledger.append({ trial: 0, loss: 3, config: first });
  ledger.append({ trial: 1, loss: 2, config: second });
  ledger.append({ trial: 2, loss: 2, config: first });
  assert.throws(() => ledger.append({ trial: 1, loss: 0, config: first }));
  assert.throws(() => ledger.append({ trial: 3, loss: NaN, config: first }));
  assert.deepEqual(ledger.best(), { config: second, trial: 1, loss: 2 });
});

test('fixture splits are disjoint and repeatable, with known published ring minima', () => {
  const { train, heldout, regressions } = syntheticCases();
  assert.deepEqual({ train, heldout, regressions }, syntheticCases());
  const all = [...train, ...heldout, ...regressions];
  assert.equal(new Set(all.map(c => c.id)).size, all.length);
  assert.equal(new Set(all.map(c => JSON.stringify(c.model))).size, all.length);
  const smooth = regressions.find(c => c.id === 'regression-smooth-96');
  const frustrated = regressions.find(c => c.id === 'regression-frustrated-96');
  assert.equal(smooth.referenceEnergy, 0);
  assert.equal(frustrated.referenceEnergy, 48);
  assert.equal(scoreState(smooth.model, Array(96).fill(0)), 0);
  assert.equal(scoreState(frustrated.model, Array.from({ length: 96 }, (_, i) => i % 2)), 48);
});

test('replay recomputes the reference and rejects clamped, forbidden and duplicate records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'energy-replay-'));
  const path = join(dir, 'fixture.json');
  const read = rows => {
    writeFileSync(path, JSON.stringify(rows));
    return loadReplay(path);
  };
  const model = {
    unary: [[0, 1], [null, -2, 0]], fixed: { 0: 1 },
    pairs: [{ i: 0, j: 1, costs: [[0, 0, 0], [1, -3, null]] }],
  };
  const row = { id: 'case1', model, referenceState: [1, 1], referenceEnergy: 99, baselineCpuMs: 4 };
  try {
    assert.deepEqual(read([row]), [{ id: 'case1', model, referenceEnergy: -4, baselineCpuMs: 4 }]);
    for (const state of [[0, 1], [1, 0], [1, 2], [1, 3], [1], null]) {
      assert.throws(() => read([{ ...row, referenceState: state }]));
    }
    assert.throws(() => read([row, row]));
    assert.throws(() => read([{ ...row, baselineCpuMs: 0 }]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
