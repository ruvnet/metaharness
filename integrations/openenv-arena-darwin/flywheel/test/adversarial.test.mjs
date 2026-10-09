// Regressions for the adversarial review (adv 1-8): every probe that could reach a POST, or a wrong incumbent, through
// resumed state, a loosened config, a rotated pin, a stale date, a racing lock, the CLI flag or a 429 without
// retry_after_s. Fakes for GPU/search/evaluate/render/arena; the REAL gate.mjs + darwin-steps verify where it matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effectiveMode, runFlywheel } from '../flywheel.mjs';
import { makeDarwinSteps } from '../darwin-steps.mjs';
import { acquireLock, LockedError } from '../journal.mjs';
import { currentQuota } from '../wire.mjs';
import { fileSigner } from '../../gate.mjs';
import { makeFakes, setup, startOf } from './fw-fakes.mjs';

const DATE = '2026-10-09';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
async function tick(env, { mode, date = DATE, now = startOf(date), fakeOpts = {}, override } = {}) {
  if (mode === 'auto') env.config.mode = 'auto';
  const f = makeFakes({ stateDirFn: () => env.stateDir, statusSeq: ['validating', 'validated'], ...fakeOpts });
  if (override) await override(f);
  const st = await runFlywheel({ config: env.config, date, now, mode, stateDir: env.stateDir, deps: f.deps });
  return { st, calls: f.calls };
}
const mathRouteWinner = f => { // the re-run search returns a DIFFERENT candidate (math_route d3)
  const orig = f.deps.darwin.search;
  f.deps.darwin.search = async a => { const r = await orig(a); return { ...r, winner: { ...r.winner, variantId: 'g1-c2', genome: { ...a.incumbentGenome, 'math_route.difficulty': 3 } } }; };
};

test('adv 1: a phase journaled done whose file vanished stops the date (no re-search, no rental, no POST)', async () => {
  for (const lost of [['search', 'render-candidate', 'gate'], ['search']]) {
    const env = setup();
    const a = await tick(env);
    assert.equal(a.st.outcome, 'skipped');
    for (const p of lost) unlinkSync(join(env.stateDir, 'runs', DATE, 'phases', `${p}.json`));
    const b = await tick(env, { mode: 'auto', override: mathRouteWinner });
    assert.equal(b.st.outcome, 'error');
    assert.match(b.st.error, /phase_result_missing: search/);
    assert.deepEqual([b.calls.search.length, b.calls.up.length, b.calls.evaluate.length, b.calls.submit.length], [0, 0, 0, 0]);
    assert.equal(existsSync(join(env.stateDir, 'incumbent.json')), false, 'no genome was ever recorded as the incumbent');
  }
});

test('adv 1: the decision re-derives from disk: a plan file that no longer matches blocks the submit', async () => {
  const env = setup();
  await tick(env); // dry-run: every phase completes and is stored
  const planPath = join(env.stateDir, 'runs', DATE, 'confirm', 'plan.json');
  const plan = readJson(planPath);
  writeFileSync(planPath, JSON.stringify({ ...plan, candidate: { ...plan.candidate, genome: { ...plan.candidate.genome, 'math_route.difficulty': 3 } } }));
  const b = await tick(env, { mode: 'auto' });
  assert.equal(b.calls.submit.length, 0);
  for (const k of ['candidateMatchesPlan', 'confirmationPreregistered']) assert.ok(b.st.decision.reasons.includes(k), String(b.st.decision.reasons));
});

test('adv 1: the incumbent recorded after `validated` is the genome the POSTed request was rendered from', async () => {
  const env = setup();
  const r = await tick(env, { mode: 'auto' });
  assert.equal(r.st.outcome, 'submitted-validated');
  const posted = r.calls.submit[0].request.tasks.filter(t => !t.task_id.endsWith('-d2')).map(t => t.task_id);
  const inc = readJson(join(env.stateDir, 'incumbent.json'));
  assert.deepEqual(posted, ['software_change-d3']);
  assert.deepEqual(Object.entries(inc.genome).filter(([, v]) => v === 3).map(([k]) => k), ['software_change.difficulty']);
  assert.deepEqual(inc.genome, readJson(join(env.stateDir, 'runs', DATE, 'phases', 'render-candidate.json')).genome);
});

async function realGateEnv(alpha) {
  const env = setup();
  const keyDir = join(mkdtempSync(join(tmpdir(), 'fw-adv-key-')), 'k');
  mkdirSync(keyDir, { mode: 0o700 }); chmodSync(keyDir, 0o700);
  Object.assign(env.config.gate, { alpha, keyDir, expectPublicKey: fileSigner(keyDir).publicKey(), candidateBudget: 1 });
  env.config.evaluator.dryRun = true; // darwin-steps wiring only: gate/verify never read the evaluator flags
  return env;
}
async function withRealGate(env, f) {
  const real = await makeDarwinSteps(env.config);
  const fakeSearch = f.deps.darwin.search;
  Object.assign(f.deps.darwin, { gate: real.gate, verify: real.verify, digestOf: real.digestOf,
    async search(a) { const r = await fakeSearch(a); mkdirSync(join(a.workRoot, 'reports'), { recursive: true });
      writeFileSync(join(a.workRoot, 'reports', 'darwin-run.json'), JSON.stringify(r)); return r; } });
}

test('adv 2: alpha loosened after the paired outcomes were on disk: the REAL gate still tests the preregistered alpha', async () => {
  const env = await realGateEnv(0.05);
  const a = await tick(env, { fakeOpts: { throwAt: 'render' }, override: f => withRealGate(env, f) });
  assert.equal(a.st.outcome, 'error');
  assert.ok(existsSync(join(env.stateDir, 'runs', DATE, 'confirm', 'paired.json')), 'paired outcomes seen before any gate ran');
  env.config.gate.alpha = 0.5; // the attack: same date, looser config, auto
  const b = await tick(env, { mode: 'auto', override: f => withRealGate(env, f) });
  const receipt = readJson(b.st.gate.receiptPath);
  assert.equal(receipt.payload.config.alpha, 0.05, 'the plan\'s alpha, not today\'s config');
  assert.equal(b.st.gate.promote, false);
  assert.ok(b.st.gate.reasons.some(r => r.startsWith('confirmation_underpowered')), String(b.st.gate.reasons));
  assert.equal(b.st.flags.gateConfigMatchesPlan, true);
  assert.equal(b.calls.submit.length, 0);
});

test('adv 4: a resumed date re-verifies the receipt against the pin in force NOW, and an old date never submits', async () => {
  const env = await realGateEnv(0.05);
  const a = await tick(env, { override: f => withRealGate(env, f) });
  assert.equal(a.st.gate.publicKeyPinned, true);
  const other = join(mkdtempSync(join(tmpdir(), 'fw-adv-key2-')), 'k');
  mkdirSync(other, { mode: 0o700 });
  env.config.gate.expectPublicKey = fileSigner(other).publicKey(); // the old key was revoked
  const b = await tick(env, { mode: 'auto', override: f => withRealGate(env, f) });
  assert.deepEqual([b.calls.gate.length, b.calls.render.length], [0, 0], 'everything resumed');
  assert.deepEqual([b.st.gate.atDecision.verified, b.st.gate.atDecision.publicKeyPinned], [false, false]);
  for (const k of ['gateReceiptVerified', 'gatePublicKeyPinned']) assert.ok(b.st.decision.reasons.includes(k), String(b.st.decision.reasons));
  // eleven days later, --date of the old run: runDateIsToday blocks whatever else holds
  const c = await tick(env, { mode: 'auto', now: '2026-10-20T14:17:00.000Z' });
  assert.ok(c.st.decision.reasons.includes('runDateIsToday'), String(c.st.decision.reasons));
  assert.equal(c.calls.submit.length, 0);
});

test('adv 6: two contenders reclaiming the same dead lock: exactly one wins', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-lock-race-'));
  writeFileSync(join(dir, 'flywheel.lock'), JSON.stringify({ pid: 999999, date: '2026-10-08', startedAt: 'x' }));
  let A = null, bErr = null;
  try {
    acquireLock(dir, { pid: 2002, date: DATE, startedAt: 'b', isPidAlive: pid => {
      if (pid === 999999 && !A) A = acquireLock(dir, { pid: 1001, date: DATE, startedAt: 'a', isPidAlive: () => false });
      return pid === 1001 || pid === 2002;
    } });
  } catch (e) { bErr = e; }
  assert.ok(A, 'the first contender reclaimed the dead lock');
  assert.ok(bErr instanceof LockedError, 'the second one sees the fresh lock and backs off');
  assert.equal(readJson(join(dir, 'flywheel.lock')).pid, 1001);
  assert.equal(existsSync(join(dir, 'flywheel.lock.reclaim')), false, 'reclaim mutex released');
  A.release();
  assert.equal(existsSync(join(dir, 'flywheel.lock')), false);
});

test('adv 7: --mode can only downgrade; auto needs config.json to say auto', async () => {
  assert.equal(effectiveMode('auto', 'dry-run'), 'dry-run');
  assert.equal(effectiveMode('dry-run', 'auto'), 'dry-run');
  assert.equal(effectiveMode(undefined, 'auto'), 'auto');
  assert.equal(effectiveMode('auto', 'auto'), 'auto');
  assert.throws(() => effectiveMode('yolo', 'auto'));
  const env = setup(); // config: dry-run
  const f = makeFakes({ stateDirFn: () => env.stateDir });
  const st = await runFlywheel({ config: env.config, date: DATE, now: startOf(DATE), mode: 'auto', stateDir: env.stateDir, deps: f.deps });
  assert.equal(st.mode, 'dry-run');
  assert.equal(f.calls.submit.length, 0);
  assert.ok(st.notes.some(n => n.includes('--mode auto ignored')));
});

test('adv 8: a 429 without retry_after_s blocks for the 24 h window, then the quota record expires and is deleted', async () => {
  const env = setup();
  const r = await tick(env, { mode: 'auto', fakeOpts: { submitResult: { state: 'refused', post_attempted: true, http_status: 429, error_code: 'SUBMISSION_QUOTA_EXCEEDED' } } });
  assert.equal(r.st.outcome, 'slot-busy');
  const q = readJson(join(env.stateDir, 'quota.json'));
  assert.deepEqual([q.retryAfterS, q.retryAfterSource], [86400, 'fallback-24h']);
  assert.equal(currentQuota(env.stateDir, q.observedAtMs + 3600e3).retryAfterS, 86400, 'still blocking an hour later');
  assert.equal(currentQuota(env.stateDir, q.observedAtMs + 86401e3), null, 'expired');
  assert.equal(existsSync(join(env.stateDir, 'quota.json')), false, 'and deleted: it can never block a later day');
  // a legacy record with retryAfterS null (the old behaviour) is read as 24 h from when it was seen, not forever
  writeFileSync(join(env.stateDir, 'quota.json'), JSON.stringify({ retryAfterS: null, observedAtMs: 1_000 }));
  assert.equal(currentQuota(env.stateDir, 1_000 + 11 * 86400e3), null);
});
