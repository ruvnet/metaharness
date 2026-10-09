// policy daily-best re-draws the STORED copy of the arena-validated request, not a genome re-render. Covers a body-only
// incumbent bootstrapped from a hand-curated request no genome can express (math at d2 AND d3, custom per-task budgets,
// like metaharness-mix8-20261009): no GPU, no search; the stored body re-submitted under a fresh id after every check today;
// a tampered, re-pointed, missing, re-permissioned or foreign stored copy blocks (needs-human); a rejected body stays
// blocked; dry-run never POSTs; gate-only never re-draws. Full fakes: no GPU, network, docker or token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineGenome, FAMILIES, genomeToCells } from '../../lib/cells.mjs';
import { bootstrapIncumbent } from '../bootstrap-incumbent.mjs';
import { canonicalDigest, canonicalJson } from '../canonical-json.mjs';
import { DECISION_KEYS } from '../decide.mjs';
import { runFlywheel } from '../flywheel.mjs';
import { requestBodyDigest, storeRequest } from '../incumbent.mjs';
import { makeFakes, MIX8_ID, mix8Request, receiptFor, setup, startOf } from './fw-fakes.mjs';

const D1 = '2026-10-09', D2 = '2026-10-10', D3 = '2026-10-11';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const OTHER_IMAGE = 'ghcr.io/ruvnet/metaharness-arena@sha256:' + '7'.repeat(64);
const evidenceFor = (req, over = {}) => ({ submission_id: req.submission_id, state: 'validated', slot: { state: 'used' },
  images: [{ submitted: req.image, resolved: req.image }], dataset: { repo: req.dataset, revision: 'abc123' }, ...over });

/** A fresh state whose incumbent is the bootstrapped (genome-less) mix8 request, validated on D1. */
function bootstrapped(over = {}) {
  const env = setup({ poll: { attempts: 1 } });
  const req = mix8Request();
  const r = bootstrapIncumbent({ stateDir: env.stateDir, request: req, submissionId: MIX8_ID, requestSha256: canonicalDigest(req), receipt: receiptFor(req),
    evidence: evidenceFor(req), date: D1, clock: () => `${D1}T23:00:00.000Z`, ...over });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { env, req, incPath: join(env.stateDir, 'incumbent.json'), storedPath: join(env.stateDir, r.storedRequest.path) };
}
async function run(env, fakeOpts = {}, { date = D2, mode = 'auto', policy = 'daily-best', now } = {}) {
  env.config.policy = policy;
  if (mode === 'auto') env.config.mode = 'auto';
  const f = makeFakes({ stateDirFn: () => env.stateDir, start: startOf(date), ...fakeOpts });
  const st = await runFlywheel({ config: env.config, date, now: now ?? startOf(date), mode, stateDir: env.stateDir, deps: f.deps });
  return { st, ...f };
}
const noGpu = r => assert.deepEqual([r.calls.ready, r.calls.up.length, r.calls.search.length, r.calls.evaluate.length, r.calls.gate.length,
  r.calls.precheck], [0, 0, 0, 0, 0, 0], 'a body-only incumbent never rents, searches, confirms or gates');

test('a hand-curated validated request is not expressible as a genome (a genome has exactly one cell per family)', () => {
  const families = mix8Request().tasks.map(t => t.task_id.replace(/-d[123]$/, ''));
  assert.ok(new Set(families).size < families.length, 'math_route (and science_calibration) at two difficulties');
  const cells = genomeToCells(baselineGenome()).map(c => c.family);
  assert.deepEqual([...new Set(cells)].sort(), [...FAMILIES].sort());
  assert.equal(cells.length, FAMILIES.length);
});

test('stored-body re-draw, happy path: the bootstrapped request itself, fresh id, every check today, no GPU; only the pointer moves', async () => {
  const { env, req, incPath, storedPath } = bootstrapped();
  assert.equal(statSync(storedPath).mode & 0o777, 0o400);
  const before = readJson(incPath);
  assert.deepEqual([before.genome, before.genomeDigest, before.submissionId, before.requestSha256, before.requestName],
    [null, null, MIX8_ID, canonicalDigest(req), req.name]);
  const r = await run(env, { statusSeq: ['validated'] });
  noGpu(r);
  assert.deepEqual(r.st.decision, { submit: true, reasons: [], kind: 'incumbent-redraw' });
  assert.equal(r.st.outcome, 'submitted-validated');
  assert.equal(r.calls.submit.length, 1);
  const sub = r.calls.submit[0];
  assert.equal(sub.approvedSha256, canonicalDigest(sub.request), 'POSTs exactly the approved bytes');
  assert.match(sub.request.submission_id, /^metaharness-darwin-2026-10-10-redraw-[0-9a-f]{10}$/);
  assert.equal(sub.request.name, `${req.name} (incumbent re-draw)`);
  assert.deepEqual({ ...sub.request, submission_id: req.submission_id, name: req.name }, req, 'the validated body itself, byte for byte');
  assert.equal(requestBodyDigest(sub.request), requestBodyDigest(req));
  const render = r.calls.render.find(c => c.outDir.includes('/incumbent-redraw/'));
  assert.deepEqual([render.image, render.request.tasks, render.dataset], [req.image, req.tasks, req.dataset], 'every check ran on the stored request');
  assert.ok(r.st.notes.some(n => n.includes('no genome')), String(r.st.notes));
  // validated: the genome stays absent; the pointer AND its stored copy move to the re-draw's exact bytes
  const after = readJson(incPath);
  assert.deepEqual([after.genome, after.genomeDigest, after.submissionId, after.date, after.lastKind], [null, null, sub.request.submission_id, D2, 'incumbent-redraw']);
  assert.deepEqual(after.genomeFrom, { submissionId: MIX8_ID, date: D1 });
  assert.deepEqual(after.storedRequest, { path: `validated-requests/${sub.approvedSha256}.json`, sha256: sub.approvedSha256 });
  assert.equal(after.requestSha256, after.storedRequest.sha256, 'the record and its stored copy always name the same bytes');
  assert.equal(readFileSync(join(env.stateDir, after.storedRequest.path), 'utf8'), canonicalJson(sub.request));
  assert.equal(statSync(join(env.stateDir, after.storedRequest.path)).mode & 0o777, 0o400);
  assert.ok(existsSync(storedPath), 'the bootstrapped copy is never deleted');
  // next day (dry-run): the board agrees with the moved pointer; the same body again, the name never accumulates suffixes
  const n = await run(env, {}, { date: D3, mode: 'dry-run' });
  noGpu(n);
  assert.deepEqual([n.st.incumbent.boardAgrees, n.st.decision.reasons, n.st.wouldSubmitInAuto, n.calls.submit.length], [true, ['modeAuto'], true, 0]);
  assert.equal(n.st.redraw.name, `${req.name} (incumbent re-draw)`);
  assert.equal(requestBodyDigest(readJson(n.st.redraw.requestPath)), requestBodyDigest(req));
});

test('stored-body re-draw: dry-run never POSTs; config.image differing is reported, not blocking; a rental refusal is irrelevant', async () => {
  const { env, req } = bootstrapped();
  env.config.image = OTHER_IMAGE;
  const d = await run(env, { precheckRefuses: true }, { mode: 'dry-run' });
  noGpu(d);
  assert.deepEqual([d.st.decision.reasons, d.st.wouldSubmitInAuto, d.calls.submit.length, d.st.outcome], [['modeAuto'], true, 0, 'no-candidate']);
  assert.equal(d.st.redraw.image, req.image, 'the stored request\'s own image, not config.image');
  assert.ok(d.st.notes.some(n => n.includes(`config.image is ${OTHER_IMAGE}`)), String(d.st.notes));
  assert.match(readFileSync(d.st.files.markdownPath, 'utf8'), /Source: stored validated request `[0-9a-f]{64}`; image `ghcr\.io[^`]+2f3f12b9[^`]+` \(config\.image `[^`]+` differs: not blocking/);
  // --mode auto on a dry-run config stays dry-run
  env.config.mode = 'dry-run';
  const f = makeFakes({ stateDirFn: () => env.stateDir, start: startOf(D3) });
  const st = await runFlywheel({ config: env.config, date: D3, now: startOf(D3), mode: 'auto', stateDir: env.stateDir, deps: f.deps });
  assert.deepEqual([st.mode, f.calls.submit.length], ['dry-run', 0]);
});

test('stored-body re-draw: an evaluator.dryRun config never re-draws a body-only incumbent (redrawNotRehearsal)', async () => {
  const { env } = bootstrapped();
  env.config.evaluator.dryRun = true;
  const r = await run(env);
  assert.deepEqual([r.st.decision.reasons, r.calls.submit.length], [['redrawNotRehearsal'], 0]);
});

test('gate-only with a body-only incumbent: no GPU, no search, no re-draw, no POST; the decision keys are unchanged', async () => {
  const { env } = bootstrapped();
  const r = await run(env, {}, { policy: 'gate-only' });
  noGpu(r);
  assert.deepEqual([r.st.outcome, r.st.redraw, r.calls.render.length, r.calls.submit.length, 'policy' in r.st], ['no-candidate', undefined, 0, 0, false]);
  assert.deepEqual(Object.keys(r.st.flags), [...DECISION_KEYS]);
  assert.equal('kind' in r.st.decision, false);
  for (const k of ['candidatePresent', 'gatePromote']) assert.ok(r.st.decision.reasons.includes(k), String(r.st.decision.reasons));
});

// ---- the stored copy must be exactly the validated request, verified again at use time ----
const TAMPER = [
  ['content edited (perms restored to 0400)', ({ storedPath }) => {
    chmodSync(storedPath, 0o600);
    writeFileSync(storedPath, readFileSync(storedPath, 'utf8').replace('"rollout_wall_s":1200', '"rollout_wall_s":1300'));
    chmodSync(storedPath, 0o400);
  }, 'stored_request_digest_mismatch'],
  ['file missing', ({ storedPath }) => unlinkSync(storedPath), 'stored_request_missing'],
  ['perms changed to 0600', ({ storedPath }) => chmodSync(storedPath, 0o600), 'stored_request_perms_changed:600'],
  ['perms changed to 0444', ({ storedPath }) => chmodSync(storedPath, 0o444), 'stored_request_perms_changed:444'],
  ['replaced by a symlink to an identical copy', ({ storedPath, env }) => {
    const copy = join(env.home, 'copy.json');
    writeFileSync(copy, readFileSync(storedPath));
    chmodSync(copy, 0o400);
    unlinkSync(storedPath);
    symlinkSync(copy, storedPath);
  }, 'stored_request_not_a_regular_file'],
  ['store directory moved out of the state dir and symlinked back (identical bytes)', ({ env }) => {
    const dir = join(env.stateDir, 'validated-requests'), outside = join(env.home, 'outside-store');
    renameSync(dir, outside);
    symlinkSync(outside, dir);
  }, 'stored_request_dir_not_a_real_directory'],
  ['the record\'s path points outside its content address', ({ incPath }) => {
    const rec = readJson(incPath);
    writeFileSync(incPath, JSON.stringify({ ...rec, storedRequest: { ...rec.storedRequest, path: '../../elsewhere.json' } }));
  }, 'stored_request_path_not_content_addressed'],
];
for (const [name, tamper, problem] of TAMPER) {
  test(`stored copy ${name}: nothing is re-drawn (storedRequestIntact, needs-human, no POST)`, async () => {
    const ctx = bootstrapped();
    tamper(ctx);
    const r = await run(ctx.env);
    assert.equal(r.st.redraw.ok, false);
    assert.deepEqual(r.st.redraw.reasons, [`stored_request_unusable:${problem}`]);
    assert.equal(r.calls.render.length, 0, 'nothing rendered or checked from an unusable copy');
    assert.ok(r.st.decision.reasons.includes('storedRequestIntact'), String(r.st.decision.reasons));
    assert.deepEqual([r.st.decision.submit, r.calls.submit.length, r.st.outcome], [false, 0, 'needs-human']);
    assert.ok(r.st.notes.some(n => n.includes(problem)), String(r.st.notes));
  });
}

test('stored copy tampered AFTER today\'s checks: the decision re-hashes it and blocks (resumed render, no POST)', async () => {
  const ctx = bootstrapped();
  const a = await run(ctx.env, {}, { mode: 'dry-run' });
  assert.deepEqual(a.st.decision.reasons, ['modeAuto']);
  chmodSync(ctx.storedPath, 0o600);
  writeFileSync(ctx.storedPath, `${readFileSync(ctx.storedPath, 'utf8')} `); // one byte: still parses, no longer the validated bytes
  chmodSync(ctx.storedPath, 0o400);
  const b = await run(ctx.env);
  assert.deepEqual([b.calls.render.length, b.calls.submit.length, b.st.outcome, b.st.decision.reasons], [0, 0, 'needs-human', ['storedRequestIntact']]);
});

test('digest mismatch: incumbent.json names other bytes than its stored copy -> blocked', async () => {
  for (const edit of [rec => { rec.requestSha256 = 'e'.repeat(64); }, rec => { rec.storedRequest = { ...rec.storedRequest, sha256: 'e'.repeat(64) }; }]) {
    const { env, incPath } = bootstrapped();
    const rec = readJson(incPath);
    edit(rec);
    writeFileSync(incPath, JSON.stringify(rec));
    const r = await run(env);
    assert.ok(r.st.decision.reasons.includes('storedRequestIntact'), String(r.st.decision.reasons));
    assert.deepEqual([r.calls.submit.length, r.st.outcome], [0, 'needs-human']);
  }
});

test('a stored body of a DIFFERENT submission_id than the validated one -> blocked', async () => {
  const { env, req, incPath } = bootstrapped();
  const other = { ...req, submission_id: 'metaharness-someone-else-1' }; // same body, another submission's bytes
  const stored = storeRequest(env.stateDir, other, canonicalDigest(other));
  writeFileSync(incPath, JSON.stringify({ ...readJson(incPath), requestSha256: stored.sha256, storedRequest: stored }));
  const r = await run(env);
  assert.deepEqual(r.st.decision.reasons, ['storedRequestIntact', 'redrawIsIncumbentRequest']);
  assert.deepEqual([r.calls.submit.length, r.st.outcome], [0, 'needs-human']);
});

test('a re-draw the arena rejected (author origin) stops further re-draws of that stored body until a human acts', async () => {
  const { env, req, incPath } = bootstrapped();
  const before = readJson(incPath);
  const a = await run(env, { statusSeq: ['rejected'], errorOrigin: 'author' });
  assert.equal(a.st.outcome, 'submitted-rejected');
  const { lastRejected, ...rest } = readJson(incPath);
  assert.deepEqual(rest, before, 'pointer, stored copy and (absent) genome unchanged');
  assert.deepEqual(lastRejected, { submissionId: a.calls.submit[0].request.submission_id, date: D2, errorOrigin: 'author', requestBodySha256: requestBodyDigest(req) });
  const n = await run(env, {}, { date: D3 });
  assert.deepEqual(n.st.decision, { submit: false, reasons: ['incumbentBodyNotRejected'], kind: 'incumbent-redraw' });
  assert.deepEqual([n.calls.submit.length, n.st.outcome], [0, 'needs-human']);
  // re-running the bootstrap with --replace never clears the rejection silently (the board still agrees: mix8 is the
  // newest validated submission, so the next tick would POST the rejected body again)
  const boot = over => bootstrapIncumbent({ stateDir: env.stateDir, request: req, submissionId: MIX8_ID, requestSha256: canonicalDigest(req),
    receipt: receiptFor(req), evidence: evidenceFor(req), date: D1, replace: true, clock: () => `${D3}T23:00:00.000Z`, ...over });
  const recorded = readFileSync(incPath, 'utf8');
  assert.match(boot().reasons[0], /^last_rejected_present:/);
  assert.equal(readFileSync(incPath, 'utf8'), recorded, 'incumbent.json untouched');
  const again = await run(env, {}, { date: '2026-10-12' });
  assert.deepEqual([again.st.decision.reasons, again.calls.submit.length], [['incumbentBodyNotRejected'], 0]);
  // only an explicit --clear-rejection (a human decision) drops it, and the result names what it dropped
  const cleared = boot({ clearRejection: true });
  assert.deepEqual([cleared.ok, cleared.droppedLastRejected], [true, lastRejected]);
  const after = await run(env, { statusSeq: ['validating'] }, { date: '2026-10-13' });
  assert.deepEqual([after.st.decision.submit, after.calls.submit.length], [true, 1]);
});

test('a validated re-draw of a body-only incumbent is never recorded without its stored copy (fail closed, noted)', async () => {
  const { env, incPath } = bootstrapped();
  env.config.poll.attempts = 0;
  const a = await run(env, { statusSeq: ['validating'] });
  assert.equal(a.st.outcome, 'submitted-pending');
  const pendingPath = join(env.stateDir, 'pending-submission.json');
  const pending = readJson(pendingPath);
  assert.deepEqual(pending.storedRequest, { path: `validated-requests/${pending.requestSha256}.json`, sha256: pending.requestSha256 }, 'stored before the POST');
  assert.equal(pending.genome, null);
  delete pending.storedRequest; // e.g. a pending record written by an older flywheel
  writeFileSync(pendingPath, JSON.stringify(pending));
  const before = readFileSync(incPath, 'utf8');
  const b = await run(env, { statusSeq: ['validated'] }, { date: D3, mode: 'dry-run' });
  assert.equal(readFileSync(incPath, 'utf8'), before, 'incumbent.json untouched');
  assert.ok(b.st.notes.some(n => n.includes('was not recorded') && n.includes('redraw_without_stored_request')), String(b.st.notes));
});
