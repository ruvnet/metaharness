// follow() only trusts a `validated` status when the durable submit receipt proves THIS process POSTed the pending digest
// (review F1), and reconciles a receipt a crash left at `sending` without ever re-POSTing (review F2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFlywheel } from '../flywheel.mjs';
import { makeFakes, setup, startOf } from './fw-fakes.mjs';

const DATE = '2026-10-09';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const journalOf = stateDir => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
async function run(fakeOpts = {}, { env = setup() } = {}) {
  env.config.mode = 'auto';
  const f = makeFakes({ stateDirFn: () => env.stateDir, ...fakeOpts, journalPath: () => join(env.stateDir, 'journal.jsonl') });
  const st = await runFlywheel({ config: env.config, date: DATE, now: startOf(DATE), mode: 'auto', stateDir: env.stateDir, deps: f.deps });
  return { st, ...f, ...env };
}
const receiptOf = r => readJson(join(r.runDir ?? join(r.stateDir, 'runs', DATE), 'submit', 'arena-receipt.json'));

test('F1: a genuine POST receipt (post_attempted, matching digest) installs the incumbent', async () => {
  const r = await run({ statusSeq: ['validated'] });
  assert.equal(r.st.outcome, 'submitted-validated');
  const inc = readJson(join(r.stateDir, 'incumbent.json'));
  assert.equal(inc.requestSha256, r.calls.submit[0].approvedSha256);
  assert.equal(existsSync(join(r.stateDir, 'pending-submission.json')), false);
});

test('F1: an existing-id receipt (post_attempted:false) never installs the incumbent, even when GET says validated', async () => {
  const r = await run({ statusSeq: ['validated'], receiptMode: 'existing' });
  assert.equal(r.calls.submit.length, 1);
  assert.equal(existsSync(join(r.stateDir, 'incumbent.json')), false, 'someone else\'s validation must not become our incumbent');
  assert.equal(existsSync(join(r.stateDir, 'pending-submission.json')), false, 'pending is cleared, loudly');
  assert.ok(journalOf(r.stateDir).some(e => e.phase === 'incumbent' && e.event === 'unproven-validation'), 'journaled');
  assert.ok(r.st.notes.some(n => /not proven|unproven|existing/i.test(n) && n.includes('needs-human') ), r.st.notes.join('\n'));
});

test('F1: a receipt whose digest differs from the pending digest never installs the incumbent', async () => {
  const env = setup();
  const a = await run({ statusSeq: ['validating'], receiptMode: 'crash-sending' }, { env });
  assert.equal(a.st.outcome, 'submit-unknown');
  const p = join(env.stateDir, 'runs', DATE, 'submit', 'arena-receipt.json');
  writeFileSync(p, JSON.stringify({ ...readJson(p), request_sha256: 'f'.repeat(64) }));
  const b = await run({ statusSeq: ['validated'] }, { env });
  assert.equal(b.calls.submit.length, 0);
  assert.equal(existsSync(join(env.stateDir, 'incumbent.json')), false);
});

test('F2: a crash after the POST leaves `sending`; the next run reconciles the receipt to recorded, installs the incumbent, never re-POSTs', async () => {
  const env = setup();
  const a = await run({ statusSeq: ['validating'], receiptMode: 'crash-sending' }, { env });
  assert.equal(a.st.outcome, 'submit-unknown');
  const p = join(env.stateDir, 'runs', DATE, 'submit', 'arena-receipt.json');
  assert.equal(readJson(p).state, 'sending', 'reproduced: the receipt is stuck at sending');
  const b = await run({ statusSeq: ['validated'] }, { env });
  assert.equal(b.calls.submit.length, 0, 'never a second POST');
  const rec = readJson(p);
  assert.equal(rec.state, 'recorded');
  assert.equal(rec.post_attempted, true);
  assert.equal(rec.arena.state, 'validated');
  assert.ok(rec.reconciled_at);
  assert.equal(readJson(join(env.stateDir, 'incumbent.json')).requestSha256, rec.request_sha256);
});
