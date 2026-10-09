// Pure helpers: date-derived fresh seeds, the preregistered plan hash, paired outcomes, genome -> tasks, config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineGenome, FAMILIES, genomeToCells } from '../../lib/cells.mjs';
import { cardMatchesGenome, changedFamilies, confirmationPlan, confirmSeedBase, dayIndex, pairedOutcomes, pairedPower,
  planHashOf, provenanceMatches } from '../confirm.mjs';
import { pairedOutcomes as darwinPairedOutcomes } from '../../lib/confirm.mjs';
import { genomeToTasks, loadIncumbent, submissionIdFor, tasksMatch, writeIncumbent } from '../incumbent.mjs';
import { ConfigError, defaultConfig, loadConfig } from '../flywheel-config.mjs';
import { candidateOf, fakeCard } from './fw-fakes.mjs';

const q = { seedBase0: 2_000_000, stride: 100, attempts: 8 };
const prov = (seedBase, attempts = 8) => ({ envSourceSha: 'a'.repeat(64), runnerSha: 'b'.repeat(64), model: 'qwen38', modelRevision: 'r1', contextTokens: 16384, seedBase, attempts });
const limits = defaultConfig('/h').submission.taskLimits;

test('dayIndex/confirmSeedBase: pure, strict, disjoint per date', () => {
  assert.equal(dayIndex('2026-01-01'), 0);
  assert.equal(dayIndex('2026-10-09'), 281);
  for (const bad of ['2026-02-30', '2025-12-31', '2026-1-01', '20261009', '', null]) assert.throws(() => dayIndex(bad));
  const a = confirmSeedBase('2026-10-09', q), b = confirmSeedBase('2026-10-10', q);
  assert.equal(a, 2_028_100);
  assert.ok(b - a >= q.attempts, 'consecutive days never share a seed');
  assert.equal(confirmSeedBase('2026-10-09', q), a, 'same date, same block (safe resume)');
  assert.throws(() => confirmSeedBase('2026-10-09', { ...q, stride: 4 }), /stride/);
});

test('plan hash is canonical (key order) and changes with any preregistered field', () => {
  const inc = { genome: baselineGenome() }, cand = { variantId: 'g1-c0', genome: candidateOf(baselineGenome()) };
  const args = { date: '2026-10-09', incumbent: inc, candidate: cand, seedBase: 2_028_100, attempts: 8, expectedProvenance: prov(2_028_100),
    image: 'ghcr.io/ruvnet/x@sha256:' + '1'.repeat(64), gate: { alpha: 0.05, lambda: 0.5, candidateBudget: 1 }, changed: ['software_change'] };
  const { plan, planHash } = confirmationPlan(args);
  assert.equal(planHashOf(JSON.parse(JSON.stringify(plan))), planHash);
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  assert.equal(planHashOf(reordered), planHash);
  for (const tweak of [{ seedBase: 2_028_200, expectedProvenance: prov(2_028_200) }, { image: 'ghcr.io/ruvnet/x@sha256:' + '2'.repeat(64) },
    { expectedProvenance: { ...prov(2_028_100), runnerSha: 'c'.repeat(64) } }, { gate: { alpha: 0.01, lambda: 0.5, candidateBudget: 1 } }]) {
    assert.notEqual(confirmationPlan({ ...args, ...tweak }).planHash, planHash, JSON.stringify(Object.keys(tweak)));
  }
  assert.throws(() => confirmationPlan({ ...args, expectedProvenance: prov(1) }), /plan_provenance_seed_mismatch/);
});

test('pairedOutcomes = gate.mjs v2 derivation (lib/confirm.mjs): changed cells only, one item per 4-seed block', () => {
  const g = baselineGenome(), c = candidateOf(g), seedBase = 2_028_100;
  const inc = fakeCard(g, { variantId: 'incumbent', seedBase, attempts: 8, provenance: prov(seedBase) });
  const cand = fakeCard(c, { variantId: 'candidate', seedBase, attempts: 8, provenance: prov(seedBase), informative: ['software_change'] });
  const pairs = pairedOutcomes(inc, cand);
  assert.deepEqual(pairs, darwinPairedOutcomes(inc, cand), 'exactly what the gate re-derives (else paired_evidence_mismatch)');
  assert.deepEqual(pairs.map(p => p.itemId), ['software_change:d2b8192->d3b8192@seed2028100', 'software_change:d2b8192->d3b8192@seed2028104']);
  assert.ok(pairs.every(p => p.candidateWon === true && p.baselineWon === false));
  // different provenance, an incomplete block or different families: refuse (fail closed)
  assert.throws(() => pairedOutcomes(inc, fakeCard(c, { seedBase, attempts: 8, provenance: { ...prov(seedBase), modelRevision: 'x' } })), /pairing_provenance_mismatch/);
  const short = structuredClone(cand); short.raw.cells[0].episodes.pop();
  assert.throws(() => pairedOutcomes(inc, short), /pairing_incomplete_block/);
  const fewer = structuredClone(cand); fewer.raw.cells.pop();
  assert.throws(() => pairedOutcomes(inc, fewer), /pairing_cell_sets_differ/);
  assert.equal(FAMILIES.length, inc.raw.cells.length);
});

test('pairedPower (Darwin confirmationPower): 8 attempts and a one-family change can never reach the threshold', () => {
  assert.deepEqual(pairedPower({ changedFamilies: 1, attempts: 8, alpha: 0.05, lambda: 0.5, candidateBudget: 1 }),
    { needed: 8, maxDiscordant: 2, reachable: false, candidateBudget: 1, attemptsPerChangedCellNeeded: 32 });
  const seven = pairedPower({ changedFamilies: 1, attempts: 8, alpha: 0.05, lambda: 0.5, candidateBudget: 7 });
  assert.deepEqual([seven.needed, seven.attemptsPerChangedCellNeeded], [13, 52], 'alpha split over 7 search candidates (gate v2 default)');
  assert.equal(pairedPower({ changedFamilies: 1, attempts: 32, alpha: 0.05, lambda: 0.5, candidateBudget: 1 }).reachable, true);
  assert.deepEqual(changedFamilies(genomeToCells, baselineGenome(), candidateOf(baselineGenome())), ['software_change']);
});

test('provenance and cell checks are exact', () => {
  const g = baselineGenome(), card = fakeCard(g, { seedBase: 5, attempts: 8, provenance: prov(5) });
  assert.equal(provenanceMatches(card, prov(5)), true);
  assert.equal(provenanceMatches(card, { ...prov(5), attempts: 4 }), false);
  assert.equal(provenanceMatches({ raw: {} }, null), false);
  assert.equal(cardMatchesGenome(card, genomeToCells, g), true);
  assert.equal(cardMatchesGenome(card, genomeToCells, candidateOf(g)), false);
});

test('genomeToTasks: day-1 v2 defaults = 8 x <family>-d2, 8192 completion, evaluator context, explicit limits', () => {
  const tasks = genomeToTasks(baselineGenome(), { genomeToCells, contextTokens: 16384, taskLimits: limits });
  assert.deepEqual(tasks.map(t => t.task_id), FAMILIES.map(f => `${f}-d2`));
  assert.ok(tasks.every(t => t.split === 'train' && t.completion_tokens === 8192 && t.context_tokens === 16384 && t.rollout_wall_s === 1800));
  assert.equal(tasksMatch(tasks, tasks), true);
  assert.equal(tasksMatch(tasks.map((t, i) => (i ? t : { ...t, completion_tokens: 1 })), tasks), false);
  assert.equal(tasksMatch(tasks.slice(1), tasks), false);
  assert.throws(() => genomeToTasks(baselineGenome(), { genomeToCells, contextTokens: 40000, taskLimits: limits }), /contextTokens/);
  assert.throws(() => genomeToTasks(baselineGenome(), { genomeToCells, contextTokens: 16384, taskLimits: { ...limits, rollout_wall_s: 3500 } }), /3600/);
  assert.throws(() => genomeToTasks(baselineGenome(), { genomeToCells, contextTokens: 16384, taskLimits: { ...limits, image: 'x' } }), /not a configurable/);
  const id = submissionIdFor({ prefix: 'metaharness-darwin', date: '2026-10-09', tasks, image: 'i' });
  assert.match(id, /^metaharness-darwin-2026-10-09-[0-9a-f]{10}$/);
  assert.equal(submissionIdFor({ prefix: 'metaharness-darwin', date: '2026-10-09', tasks, image: 'i' }), id, 'deterministic');
});

test('incumbent state: day 1 = cells defaults; written only from a validated submission; tampering fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-inc-'));
  const cells = { baselineGenome, genomeToCells };
  assert.equal(loadIncumbent(dir, cells).day1, true);
  assert.throws(() => writeIncumbent(dir, { genome: baselineGenome(), state: 'validating' }), /validated/);
  writeIncumbent(dir, { genome: candidateOf(baselineGenome()), submissionId: 's', requestSha256: 'a'.repeat(64), date: '2026-10-09', state: 'validated' });
  const inc = loadIncumbent(dir, cells);
  assert.equal(inc.day1, false);
  assert.equal(inc.genome['software_change.difficulty'], 3);
  writeFileSync(join(dir, 'incumbent.json'), JSON.stringify({ genome: { 'software_change.difficulty': 9 } }));
  assert.throws(() => loadIncumbent(dir, cells));
});

test('config: defaults are dry-run; bad values and overlapping seed blocks are refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-cfg-'));
  assert.equal(loadConfig(join(dir, 'missing.json'), { home: dir }).mode, 'dry-run');
  const write = obj => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(obj)); return p; };
  const pin = { expectEnvCommit: '0af81c55269be029dd64ccdc79e23654aa9dcaa4' };
  assert.equal(loadConfig(write({ mode: 'auto', evaluator: { envDir: '~/env' }, checks: pin }), { home: dir }).evaluator.envDir, join(dir, 'env'));
  // adv 5: auto runs the env lane's scripts every tick, so they must be a pinned (40-hex) commit
  for (const checks of [{}, { expectEnvCommit: '0af81c55' }, { expectEnvCommit: 'X'.repeat(40) }]) {
    assert.throws(() => loadConfig(write({ mode: 'auto', checks }), { home: dir }), /mode "auto" requires checks\.expectEnvCommit/, JSON.stringify(checks));
  }
  assert.equal(loadConfig(write({ mode: 'dry-run', checks: {} }), { home: dir }).mode, 'dry-run', 'dry-run needs no pin');
  const d = loadConfig(join(dir, 'missing.json'), { home: dir });
  assert.deepEqual([d.gate.candidateBudget, d.darwin.searchAttempts, d.arena.user, d.evaluator.rentGpuInDryRun], [null, 4, 'ruv', false]);
  assert.equal(d.schedule.onCalendar, '*-*-* 10:17:00 America/Toronto', 'matches systemd/arena-flywheel.timer');
  assert.ok(d.darwin.searchTimeoutMs + d.confirmation.evaluateTimeoutMs <= 8 * 3600e3, 'fits TimeoutStartSec=8h');
  for (const bad of [{ mode: 'yes' }, { image: 'ghcr.io/ruvnet/x:latest' }, { dataset: 'ruv/x@rev' }, { confirmation: { attempts: 6 } },
    { confirmation: { seedBase0: 700010 } }, { gate: { alpha: 0 } }, { gate: { expectPublicKey: 'not base64!' } }, { caps: { dailyUsd: -1 } },
    { submission: { taskLimits: { ...limits, reset_wall_s: 60 } } }, { darwin: { maxTotalNewCells: -1 } }, { darwin: { searchAttempts: 6 } },
    { gate: { candidateBudget: 0 } }, { arena: { user: '' } }, { evaluator: { rentGpuInDryRun: 'yes' } }]) {
    assert.throws(() => loadConfig(write(bad), { home: dir }), ConfigError, JSON.stringify(bad));
  }
  assert.throws(() => loadConfig(write([1]), { home: dir }), ConfigError);
});
