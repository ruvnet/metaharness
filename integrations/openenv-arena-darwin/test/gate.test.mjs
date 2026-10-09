// Run: node --experimental-strip-types --test integrations/openenv-arena-darwin/test/gate.test.mjs
// Temp signing keys go under DARWIN_TEST_KEY_ROOT (e.g. the session scratchpad) or os.tmpdir(); both are checked to be
// outside any git work tree, and every test key is deleted afterwards. The persistent key lives only in darwin-keys/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateFingerprint, meetsPromotionRule } from '../../../packages/flywheel/src/gate.ts';
import { makeSigner, verifyReceipt } from '../../../packages/flywheel/src/receipts.ts';
import { GATE_KIND, assertOutsideRepo, decide, fileSigner, signDecision, validatePaired, verifyGateReceipt } from '../gate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = resolve(HERE, '../gate.mjs');
const NOW = new Date('2026-10-08T00:00:00Z');
const KEY_ROOT = process.env.DARWIN_TEST_KEY_ROOT ?? tmpdir();
const SEL = { seedBase: 700000, attempts: 8, evaluated: 1 }; // evaluated 1 keeps alpha at 0.05 unless a test raises it
const CONFIRM = 800000;
const prov = (seedBase, attempts) => ({ envSourceSha: 'a'.repeat(64), runnerSha: 'b'.repeat(64), serverSha: 'c'.repeat(64),
  runnerArgsSha: 'd'.repeat(64), model: 'qwen38', modelRevision: '1d4bf0f2', contextTokens: 16384, seedBase, attempts });
// One block of 4 episodes: 'mixed' = all eligible, rewards differ (a pure reasoning gradient); 'flat' = all solved.
const block = (kind, seed) => [1, kind === 'mixed' ? 0.5 : 1, 1, 1].map((reward, i) =>
  ({ seed: seed + i, attempt: i, reward, cls: reward === 1 ? 'solved' : 'partial', reason: 'x' }));
const cell = (family, difficulty, blocks, seedBase = CONFIRM) => ({ family, difficulty, budget: 8192, knobs: {},
  key: `${family}-${difficulty}`.padEnd(64, '0'), episodes: blocks.flatMap((k, i) => block(k, seedBase + 4 * i)) });
const card = (o, cells, seedBase = CONFIRM) => ({ variantId: 'v', primary: 1, noopRate: 0.5, costPerWin: 100000, regressed: false, ...o,
  raw: { provenance: prov(seedBase, 4 * cells[0].episodes.length / 4), cells } });
const flat = (n) => Array(n).fill('flat');
const mixed = (n) => Array(n).fill('mixed');
const pairBase = (n, kinds = flat(n), seedBase) => card({ variantId: 'base' }, [cell('math_route', 2, kinds, seedBase), cell('security_triage', 2, flat(n), seedBase)], seedBase);
const pairCand = (kinds, o = {}, seedBase) => card({ variantId: 'cand', primary: 2, noopRate: 0.25, costPerWin: 90000, ...o },
  [cell('math_route', 3, kinds, seedBase), cell('security_triage', 2, flat(kinds.length), seedBase)], seedBase);
const BASE = pairBase(8);
const BETTER = pairCand(mixed(8)); // 8 candidate-won blocks: e = 1.5^8 = 25.6 >= 20
const gate = (candidate, extra = {}) => decide({ baseline: BASE, candidate, selection: SEL, now: NOW, ...extra });
const tmp = () => { const d = mkdtempSync(join(KEY_ROOT, 'darwin-gate-test-')); assertOutsideRepo(d); return d; };
const cli = (args, env = {}) => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', GATE, ...args],
  { encoding: 'utf8', env: { ...process.env, DARWIN_GATE_KEY_DIR: '', ...env } });

test('(a) a fresh-seed confirmed, clearly better candidate promotes and its signed receipt verifies', () => {
  const d = gate(BETTER);
  assert.deepEqual(d.reasons, []);
  assert.equal(d.promote, true);
  assert.equal(d.kind, GATE_KIND);
  assert.equal(d.upstreamGateFingerprint, gateFingerprint(meetsPromotionRule));
  assert.deepEqual([d.config.candidateBudget, d.config.candidateBudgetSource], [1, 'selection.evaluated']);
  assert.deepEqual(d.deltas, { primary: 1, noopRate: -0.25, costPerWin: -10000 });
  assert.equal(d.sequential.eValue, 1.5 ** 8);
  assert.deepEqual([d.sequential.informativePairs, d.sequential.totalPairs], [8, 8], 'only the changed cell is paired');
  assert.deepEqual(d.selection, SEL);
  assert.deepEqual(d.confirmation, { seedBase: CONFIRM, attempts: 32 });
  const { receipt, verified } = signDecision(d);
  assert.equal(verified, true);
  assert.equal(verifyReceipt(receipt), true);
  assert.equal(gate(BETTER).gateFingerprint, d.gateFingerprint, 'same inputs + config => same fingerprint');
});

test('(b) worse, flat, invalid, or unsafe candidates are refused (fail closed)', () => {
  const cases = [
    ['worse primary', pairCand(mixed(8), { primary: 0.5 }), 'primary_regressed'],
    ['equal primary (finding 4: no strict gain)', pairCand(mixed(8), { primary: 1 }), 'primary_not_improved'],
    ['higher noopRate', pairCand(mixed(8), { noopRate: 0.75 }), 'noop_rate_not_improved'],
    ['NaN primary', pairCand(mixed(8), { primary: NaN }), 'invalid_candidate_scorecard:primary'],
    ['null primary (JSON of -Infinity)', pairCand(mixed(8), { primary: null }), 'invalid_candidate_scorecard:primary'],
    ['negative costPerWin', pairCand(mixed(8), { costPerWin: -1 }), 'invalid_candidate_scorecard:costPerWin'],
    ['noopRate > 1', pairCand(mixed(8), { noopRate: 1.5 }), 'invalid_candidate_scorecard:noopRate'],
    ['regressed=true', pairCand(mixed(8), { regressed: true }), 'safety_regressed'],
    ['regressed not boolean', pairCand(mixed(8), { regressed: 'false' }), 'invalid_candidate_scorecard:regressed'],
    ['evaluatorError present', pairCand(mixed(8), { evaluatorError: 'boom' }), 'candidate_evaluator_error'],
    ['missing candidate', undefined, 'invalid_candidate_scorecard:not_object'],
    ['cost per win worsened', pairCand(mixed(8), { costPerWin: 200000 }), 'cost_per_win_worsened'],
  ];
  for (const [name, candidate, reason] of cases) {
    const d = gate(candidate);
    assert.equal(d.promote, false, name);
    assert.ok(d.reasons.includes(reason), `${name}: ${d.reasons.join(',')}`);
    assert.equal(signDecision(d).verified, true, `${name}: refusals are receipted too`);
  }
});

test('(b) a regressed baseline refuses promotion (safety finding 1)', () => {
  const d = decide({ baseline: { ...BASE, regressed: true }, candidate: BETTER, selection: SEL, now: NOW });
  assert.equal(d.promote, false);
  assert.ok(d.reasons.includes('baseline_regressed'), d.reasons.join(','));
  assert.ok(decide({ baseline: { ...BASE, costPerWin: NaN }, candidate: BETTER, selection: SEL }).reasons.includes('invalid_baseline_scorecard:costPerWin'));
});

test('(b) search scorecards, missing selection context and foreign provenance are refused', () => {
  const searchBase = pairBase(2, flat(2), SEL.seedBase); const searchWin = pairCand(mixed(2), {}, SEL.seedBase);
  assert.ok(decide({ baseline: searchBase, candidate: searchWin, selection: SEL }).reasons.includes('selection_seed_reused'));
  const overlap = SEL.seedBase + 4; // seed range 700004.. overlaps the search seeds 700000..700007
  assert.ok(decide({ baseline: pairBase(8, flat(8), overlap), candidate: pairCand(mixed(8), {}, overlap), selection: SEL })
    .reasons.includes('selection_seed_reused'));
  assert.ok(gate(BETTER, { selection: undefined }).reasons.includes('no_selection_context'));
  assert.ok(gate(BETTER, { selection: { ...SEL, mock: true } }).reasons.includes('no_selection_context'), 'mock runs are never admissible');
  const { raw, ...noProv } = BETTER; void raw;
  assert.ok(gate(noProv).reasons.includes('provenance_missing'));
  const foreign = { ...BETTER, raw: { ...BETTER.raw, provenance: { ...BETTER.raw.provenance, serverSha: 'e'.repeat(64) } } };
  assert.ok(gate(foreign).reasons.includes('provenance_mismatch'));
});

test('(c) tampered or re-keyed receipts fail verification', () => {
  const signer = makeSigner();
  const { receipt } = signDecision(gate(pairCand(mixed(8), { primary: 0.5 })), signer);
  assert.equal(receipt.payload.promote, false);
  assert.equal(verifyGateReceipt(receipt), true);
  const flip = structuredClone(receipt); flip.payload.promote = true; flip.payload.reasons = [];
  assert.equal(verifyGateReceipt(flip), false);
  const swapped = { ...receipt, publicKey: makeSigner().publicKey() };
  assert.equal(verifyGateReceipt(swapped), false);
  const forged = makeSigner().sign({ ...receipt.payload, promote: true, reasons: [] });
  assert.equal(verifyGateReceipt(forged), true, 'embedded-key check alone accepts a forger');
  assert.equal(verifyGateReceipt(forged, { expectedPublicKey: signer.publicKey() }), false);
  assert.equal(verifyGateReceipt(signer.sign({ kind: 'something_else', promote: true })), false);
});

test('(d) paired evidence is re-derived from the episodes; a supplied file must match it exactly', () => {
  const derived = gate(BETTER).sequential;
  const supplied = Array.from({ length: 8 }, (_, k) => ({ itemId: `math_route:d2b8192->d3b8192@seed${CONFIRM + 4 * k}`, candidateWon: true, baselineWon: false }));
  assert.equal(gate(BETTER, { paired: { pairedOutcomes: supplied } }).promote, true);
  const forged = supplied.map((p, i) => (i === 0 ? { ...p, itemId: 'math_route@1' } : p));
  assert.ok(gate(BETTER, { paired: forged }).reasons.includes('paired_evidence_mismatch'));
  assert.equal(derived.informativePairs, 8);
  assert.throws(() => validatePaired([...supplied, supplied[0]]), /duplicate_paired_item/);
  assert.throws(() => validatePaired([{ itemId: 'x', candidateWon: 1, baselineWon: false }]), /invalid_paired_outcome/);
});

test('(d) underpowered, insufficient, contrary or uninformative evidence refuses', () => {
  const seven = gate(pairCand(mixed(7)), { baseline: pairBase(7) });
  assert.ok(seven.reasons.some(r => r.startsWith('confirmation_underpowered(need>=8 paired blocks')), seven.reasons.join(','));
  const contrary = gate(pairCand([...mixed(9), 'flat']), { baseline: pairBase(10, [...flat(9), 'mixed']) }); // 1.5^9 * 0.5 = 19.2
  assert.ok(Math.abs(contrary.sequential.eValue - 1.5 ** 9 * 0.5) < 1e-12);
  assert.ok(contrary.reasons.some(r => r.startsWith('insufficient_sequential_evidence')), contrary.reasons.join(','));
  const concordant = gate(pairCand(mixed(8)), { baseline: pairBase(8, mixed(8)) });
  assert.deepEqual([concordant.sequential.informativePairs, concordant.promote], [0, false]);
  const same = { ...BETTER, raw: { ...BETTER.raw, cells: BASE.raw.cells } };
  assert.ok(gate(same).reasons.includes('missing_paired_evidence'), 'no changed cell: nothing to pair');
});

test('(d) candidate budget defaults to the number of Darwin candidates evaluated', () => {
  const thirteen = gate(BETTER, { selection: { ...SEL, evaluated: 13 } });
  assert.deepEqual([thirteen.config.candidateBudget, thirteen.config.effectiveAlpha], [13, 0.05 / 13]);
  assert.ok(thirteen.reasons.some(r => r.startsWith('confirmation_underpowered(need>=14 paired blocks at candidateBudget 13')));
  const enough = gate(pairCand(mixed(14)), { baseline: pairBase(14), selection: { ...SEL, evaluated: 13 } }); // 1.5^14 = 291.9 >= 260
  assert.equal(enough.promote, true, enough.reasons.join(','));
  const explicit = gate(BETTER, { selection: { ...SEL, evaluated: 13 }, candidateBudget: 1 });
  assert.deepEqual([explicit.promote, explicit.config.candidateBudgetSource], [true, 'explicit']);
  assert.throws(() => gate(BETTER, { candidateBudget: 1.5 }), RangeError);
  assert.throws(() => gate(BETTER, { alpha: 0 }), RangeError);
});

function runFixture(dir, candidate = BETTER, selection = SEL) {
  const f = (name, v) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(v)); return p; };
  return f('darwin-run.json', { kind: 'openenv_arena_darwin_run', selection, files: {
    confirmBaselineScorecard: f('cb.json', BASE), confirmWinnerScorecard: f('cw.json', candidate), confirmPaired: join(dir, 'absent.json') } });
}

test('CLI: --run gates the confirmation cards; refusal exits 1; --verify needs a pinned key', () => {
  const dir = tmp();
  try {
    const keyDir = join(dir, 'keys');
    const ok = cli(['--run', runFixture(dir), '--out', join(dir, 'r1.json'), '--key-dir', keyDir]);
    assert.equal(ok.status, 0, ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.deepEqual([out.promote, out.verified], [true, true]);
    assert.equal(cli(['--verify', join(dir, 'r1.json')]).status, 2, 'no pin -> fail closed (safety finding 7)');
    assert.equal(cli(['--verify', join(dir, 'r1.json'), '--expect-public-key', out.publicKey]).status, 0);
    assert.equal(cli(['--verify', join(dir, 'r1.json'), '--key-dir', keyDir]).status, 0);
    assert.equal(cli(['--verify', join(dir, 'r1.json')], { DARWIN_GATE_KEY_DIR: keyDir }).status, 0);
    // A receipt forged with a throwaway key (no scorecards at all) is rejected once a pin is required.
    writeFileSync(join(dir, 'forged.json'), JSON.stringify(makeSigner().sign({ kind: GATE_KIND, version: 2, promote: true, reasons: [] })));
    assert.equal(cli(['--verify', join(dir, 'forged.json')]).status, 2);
    assert.equal(cli(['--verify', join(dir, 'forged.json'), '--key-dir', keyDir]).status, 2);
    const refused = cli(['--run', runFixture(dir, pairCand(mixed(8), { primary: 0.5 })), '--out', join(dir, 'r2.json'), '--key-dir', keyDir]);
    assert.equal(refused.status, 1, refused.stderr);
    assert.equal(cli(['--verify', join(dir, 'r2.json'), '--key-dir', keyDir]).status, 1);
    const tampered = JSON.parse(readFileSync(join(dir, 'r2.json'), 'utf8')); tampered.payload.promote = true;
    writeFileSync(join(dir, 'r3.json'), JSON.stringify(tampered));
    assert.equal(cli(['--verify', join(dir, 'r3.json'), '--key-dir', keyDir]).status, 2);
    assert.equal(cli(['--baseline', join(dir, 'cb.json'), '--candidate', join(dir, 'cw.json'), '--out', join(dir, 'r4.json')]).status, 2, '--run required');
    assert.equal(cli(['--run', runFixture(dir), '--out', join(dir, 'r5.json'), '--alpha', 'x']).status, 2);
    assert.equal(cli(['--run', join(dir, 'nope.json'), '--out', join(dir, 'r6.json')]).status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('signing keys: stable pinnable key, 0600 in a 0700 dir, never in this repo or any git work tree', () => {
  const dir = tmp();
  try {
    const keyDir = join(dir, 'darwin-keys');
    const s1 = fileSigner(keyDir), s2 = fileSigner(keyDir);
    assert.equal(s1.publicKey(), s2.publicKey());
    assert.equal(statSync(join(keyDir, 'gate-ed25519.pem')).mode & 0o777, 0o600);
    assert.equal(statSync(keyDir).mode & 0o777, 0o700);
    const open = join(dir, 'open'); mkdirSync(open); chmodSync(open, 0o755);
    assert.throws(() => fileSigner(open), /signing_key_dir_permissions_too_open/);
    assert.throws(() => fileSigner(join(dir, 'missing'), { create: false }), /signing_key_dir_missing/);
    const fakeRepo = join(dir, 'other-checkout'); mkdirSync(join(fakeRepo, '.git'), { recursive: true });
    assert.throws(() => assertOutsideRepo(join(fakeRepo, 'keys')), /signing_key_dir_inside_git_worktree/);
    assert.throws(() => assertOutsideRepo(join(fakeRepo, 'a', 'b', 'not-yet-created')), /inside_git_worktree/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const inRepo = join(HERE, 'should-not-exist-keys');
  assert.throws(() => assertOutsideRepo(inRepo), /signing_key_dir_inside_repo/);
  assert.throws(() => fileSigner(inRepo), /signing_key_dir_inside_repo/);
  assert.equal(existsSync(inRepo), false);
});
