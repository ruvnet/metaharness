// Policy gate-only (the default) is unchanged by the daily-best stored-request work: the same 31 decision keys and
// nothing else, a decision without a kind, no policy or kind anywhere in status.json, the report, the notification or
// the journal, the same outcomes, no re-draw ever rendered. The only addition is bookkeeping: the approved bytes are
// stored read-only before the POST and a validated incumbent records that copy. Storing them can never fail a POST: a
// copy that cannot be stored is journaled and noted, the request is POSTed as before, and it simply can never be re-drawn.
// (Equivalence with the pre-change flywheel was also diffed by hand over 9-day scenarios; see the change notes.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../canonical-json.mjs';
import { DECISION_KEYS } from '../decide.mjs';
import { runFlywheel } from '../flywheel.mjs';
import { readStoredRequest } from '../incumbent.mjs';
import { makeFakes, setup, startOf } from './fw-fakes.mjs';

const D1 = '2026-10-09', D2 = '2026-10-10';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const journalOf = dir => readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
async function run(env, fake = {}, { date = D1, mode = 'auto' } = {}) {
  env.config.mode = mode === 'auto' ? 'auto' : 'dry-run';
  const f = makeFakes({ stateDirFn: () => env.stateDir, start: startOf(date), ...fake });
  const st = await runFlywheel({ config: env.config, date, now: startOf(date), mode, stateDir: env.stateDir, deps: f.deps });
  return { st, ...f };
}
function assertGateOnlyShape(env, r) {
  assert.equal(env.config.policy ?? 'gate-only', 'gate-only');
  assert.equal('policy' in r.st, false);
  if (r.st.flags) assert.deepEqual(Object.keys(r.st.flags), [...DECISION_KEYS], 'exactly the gate-only keys');
  if (r.st.decision) assert.deepEqual(Object.keys(r.st.decision).sort(), ['reasons', 'submit'], 'no kind');
  assert.equal(r.st.redraw, undefined, 'a re-draw is never rendered');
  assert.ok(!r.calls.render.some(c => c.outDir.includes('/incumbent-redraw/')));
  const status = readJson(r.st.files.statusPath), md = readFileSync(r.st.files.markdownPath, 'utf8');
  assert.deepEqual(['policy' in status, 'kind' in (status.decision ?? {}), 'kind' in (status.submission ?? {}), 'redraw' in status],
    [false, false, false, false]);
  for (const n of r.calls.notify) assert.deepEqual(Object.keys(n).sort(), ['date', 'mode', 'outcome', 'reasons', 'report', 'submit']);
  assert.doesNotMatch(md, /Policy:|Kind:|Incumbent re-draw request|Source: stored validated request/);
  for (const e of journalOf(env.stateDir)) assert.ok(!('policy' in e) && !('kind' in e), `${e.phase}/${e.event}`);
}

test('gate-only: day 1 promoted + validated, day N gate refuses, day 1 gate refuses; same keys, outcomes and no kind anywhere', async () => {
  const env = setup({ poll: { attempts: 1 } });
  const a = await run(env, { statusSeq: ['validated'] });
  assert.deepEqual([a.st.outcome, a.st.decision, a.calls.submit.length], ['submitted-validated', { submit: true, reasons: [] }, 1]);
  assertGateOnlyShape(env, a);
  const inc = readJson(join(env.stateDir, 'incumbent.json'));
  assert.equal(readStoredRequest(env.stateDir, inc.storedRequest).ok, true, 'the validated request is recorded with its stored copy');
  const b = await run(env, { gatePromote: false }, { date: D2 });
  assert.deepEqual([b.st.outcome, b.calls.submit.length], ['skipped', 0]);
  assert.ok(b.st.decision.reasons.includes('gatePromote'), String(b.st.decision.reasons));
  assertGateOnlyShape(env, b);
  const env2 = setup();
  const c = await run(env2, { gatePromote: false });
  assert.deepEqual([c.st.outcome, c.calls.submit.length, Boolean(c.st.needsHuman)], ['needs-human', 0, true]);
  assertGateOnlyShape(env2, c);
});

test('a copy that cannot be stored never fails or blocks the POST (both policies): journaled, noted, POSTed, recorded without it', async () => {
  for (const policy of ['gate-only', 'daily-best']) {
    // the request this date POSTs (content-addressed and deterministic), learned in a throwaway state
    const probe = setup();
    probe.config.policy = policy;
    const p = await run(probe, { statusSeq: ['validated'] });
    const { request, approvedSha256 } = p.calls.submit[0];
    // a fresh state with a stray, NOT read-only file at exactly that content address
    const env = setup({ poll: { attempts: 1 } });
    env.config.policy = policy;
    const dir = join(env.stateDir, 'validated-requests');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stray = join(dir, `${approvedSha256}.json`);
    writeFileSync(stray, canonicalJson(request));
    chmodSync(stray, 0o600);
    const r = await run(env, { statusSeq: ['validated'] });
    assert.deepEqual([r.st.outcome, r.st.error, r.calls.submit.length], ['submitted-validated', undefined, 1], policy);
    assert.equal(r.calls.submit[0].approvedSha256, approvedSha256);
    assert.ok(r.st.notes.some(n => n.includes('was not stored') && n.includes('stored_request_perms_changed:600')), String(r.st.notes));
    const failed = journalOf(env.stateDir).find(e => e.phase === 'submit' && e.event === 'stored-request-failed');
    assert.match(failed?.reason ?? '', /stored_request_conflict: stored_request_perms_changed:600/);
    const pending = journalOf(env.stateDir).find(e => e.phase === 'submit' && e.event === 'intent');
    assert.equal(pending.requestSha256, approvedSha256);
    const inc = readJson(join(env.stateDir, 'incumbent.json'));
    assert.deepEqual([inc.submissionId, inc.requestSha256, 'storedRequest' in inc, inc.genome !== null], [request.submission_id, approvedSha256, false, true]);
    assert.equal(readFileSync(stray, 'utf8'), canonicalJson(request), 'the stray file is never overwritten');
    if (policy === 'gate-only') assertGateOnlyShape(env, r);
    else { // daily-best: that incumbent can never be re-drawn (no stored copy), so the next gate refusal is a human's call
      const n = await run(env, { gatePromote: false }, { date: D2 });
      assert.deepEqual([n.st.outcome, n.calls.submit.length], ['needs-human', 0]);
      assert.ok(n.st.decision.reasons.includes('storedRequestIntact'), String(n.st.decision.reasons));
    }
  }
  assert.equal(existsSync(join(setup().stateDir, 'validated-requests')), false, 'nothing exists before a POST');
});
