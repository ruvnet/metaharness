// The write-time guards of incumbent.mjs, each driven directly: storeRequest, writeIncumbent, recordRedraw and
// loadIncumbent refuse (throw, write nothing) unless the stored copy is exactly the validated request the record names,
// and readStoredRequest refuses a store directory that is not a real directory inside the state dir. The decision-time
// checks (decide.mjs storedRequestIntact) would block a bad record later; these keep one from ever being written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineGenome, genomeToCells } from '../../lib/cells.mjs';
import { canonicalDigest, canonicalJson } from '../canonical-json.mjs';
import { loadIncumbent, readStoredRequest, recordRedraw, redrawName, requestBodyDigest, storeRequest, storedRequestRelPath,
  writeIncumbent } from '../incumbent.mjs';
import { mix8Request } from './fw-fakes.mjs';

const REQ = mix8Request();
const SHA = canonicalDigest(REQ);
const REDRAW = { ...REQ, submission_id: 'metaharness-darwin-2026-10-10-redraw-0123456789', name: redrawName(REQ.name) };
const OTHER = { ...REQ, submission_id: 'metaharness-someone-else-1' }; // the same body under another submission's id
const cells = { baselineGenome, genomeToCells };
const fresh = () => join(mkdtempSync(join(tmpdir(), 'fw-guards-')), 'state');
const incPath = dir => join(dir, 'incumbent.json');
/** The fields a record of `req` carries (writeIncumbent / recordRedraw input). */
const fieldsOf = (req, over = {}) => ({ submissionId: req.submission_id, requestSha256: canonicalDigest(req), requestBodySha256: requestBodyDigest(req),
  requestName: req.name, date: '2026-10-09', state: 'validated', ...over });
/** A state dir whose incumbent is the body-only mix8 record. */
function bodyOnly() {
  const dir = fresh();
  writeIncumbent(dir, { genome: null, ...fieldsOf(REQ), storedRequest: storeRequest(dir, REQ, SHA) });
  return dir;
}

test('storeRequest: refuses bytes that are not the expected digest, and never trusts or overwrites a file already at the address', () => {
  const dir = fresh();
  assert.throws(() => storeRequest(dir, REQ, 'e'.repeat(64)), /stored_request_digest_mismatch/);
  assert.equal(existsSync(join(dir, storedRequestRelPath(SHA))), false, 'nothing written');
  // a stray file with the right bytes but not read-only: a conflict, left untouched
  mkdirSync(join(dir, 'validated-requests'), { recursive: true, mode: 0o700 });
  const p = join(dir, storedRequestRelPath(SHA));
  writeFileSync(p, canonicalJson(REQ), { mode: 0o600 });
  assert.throws(() => storeRequest(dir, REQ, SHA), /stored_request_conflict: stored_request_perms_changed:600/);
  // a read-only file at the address with OTHER bytes: a conflict too (its digest is not its name)
  chmodSync(p, 0o600);
  writeFileSync(p, canonicalJson(OTHER));
  chmodSync(p, 0o400);
  assert.throws(() => storeRequest(dir, REQ, SHA), /stored_request_conflict: stored_request_digest_mismatch/);
  assert.equal(readFileSync(p, 'utf8'), canonicalJson(OTHER), 'never overwritten');
  // an intact copy is accepted as is (idempotent)
  const d2 = fresh();
  const first = storeRequest(d2, REQ, SHA);
  assert.deepEqual(storeRequest(d2, REQ, SHA), first);
});

test('the store directory must be a real directory in the state dir: a symlinked one is never read from or written through', () => {
  const dir = bodyOnly();
  const store = join(dir, 'validated-requests'), outside = join(dir, '..', 'outside-store');
  const rec = JSON.parse(readFileSync(incPath(dir), 'utf8'));
  assert.equal(readStoredRequest(dir, rec.storedRequest).ok, true);
  renameSync(store, outside);
  symlinkSync(outside, store); // identical bytes, now outside the state dir
  const r = readStoredRequest(dir, rec.storedRequest);
  assert.deepEqual([r.ok, r.fileOk, r.problem], [false, false, 'stored_request_dir_not_a_real_directory']);
  assert.throws(() => storeRequest(dir, REDRAW, canonicalDigest(REDRAW)), /stored_request_conflict: stored_request_dir_not_a_real_directory/);
  assert.equal(existsSync(join(outside, `${canonicalDigest(REDRAW)}.json`)), false, 'nothing written through the symlink');
  // a store directory that is a regular file
  const d2 = fresh();
  mkdirSync(d2, { recursive: true });
  writeFileSync(join(d2, 'validated-requests'), '');
  assert.equal(readStoredRequest(d2, { path: storedRequestRelPath(SHA), sha256: SHA }).problem, 'stored_request_dir_not_a_real_directory');
});

test('writeIncumbent: the stored copy must be the validated request the record names (digest, id, name, body), else nothing is written', () => {
  const dir = fresh();
  const mine = storeRequest(dir, REQ, SHA), other = storeRequest(dir, OTHER, canonicalDigest(OTHER));
  const cases = [
    [{ genome: null, ...fieldsOf(REQ), storedRequest: other }, /stored_request_is_not_the_validated_request: digest differs/], // another submission's intact copy
    [{ genome: null, ...fieldsOf(REQ, { requestSha256: canonicalDigest(OTHER) }), storedRequest: other }, /submission_id, name or body differs/], // its digest, my id
    [{ genome: null, ...fieldsOf(REQ, { requestSha256: 'e'.repeat(64) }), storedRequest: mine }, /digest differs from requestSha256/], // the record names other bytes
    [{ genome: null, ...fieldsOf(REQ, { requestName: 'renamed' }), storedRequest: mine }, /submission_id, name or body differs/],
    [{ genome: null, ...fieldsOf(REQ, { requestBodySha256: 'c'.repeat(64) }), storedRequest: mine }, /submission_id, name or body differs/],
    [{ genome: null, ...fieldsOf(REQ) }, /needs a genome or a stored validated request/], // body-only without its copy
    [{ genome: null, ...fieldsOf(REQ), storedRequest: { path: '../x.json', sha256: SHA } }, /stored_request_unusable: stored_request_path_not_content_addressed/],
    [{ genome: baselineGenome(), ...fieldsOf(REQ, { state: 'validating' }), storedRequest: mine }, /only be updated from a validated submission/],
  ];
  for (const [rec, re] of cases) {
    assert.throws(() => writeIncumbent(dir, rec), re, String(re));
    assert.equal(existsSync(incPath(dir)), false, `nothing written: ${re}`);
  }
  chmodSync(join(dir, mine.path), 0o600); // the copy no longer read-only
  assert.throws(() => writeIncumbent(dir, { genome: null, ...fieldsOf(REQ), storedRequest: mine }), /stored_request_unusable: stored_request_perms_changed:600/);
  chmodSync(join(dir, mine.path), 0o400);
  writeIncumbent(dir, { genome: null, ...fieldsOf(REQ), storedRequest: mine });
  assert.equal(JSON.parse(readFileSync(incPath(dir), 'utf8')).submissionId, REQ.submission_id);
});

test('recordRedraw over a body-only incumbent: only the same body with its own stored copy and no genome moves the pointer', () => {
  const dir = bodyOnly();
  const before = readFileSync(incPath(dir), 'utf8');
  const redrawStored = storeRequest(dir, REDRAW, canonicalDigest(REDRAW));
  const otherBody = { ...REDRAW, tasks: REQ.tasks.slice(1) };
  const otherStored = storeRequest(dir, otherBody, canonicalDigest(otherBody));
  const cases = [
    [{ genome: baselineGenome(), ...fieldsOf(REDRAW), storedRequest: redrawStored }, /redraw_genome_is_not_the_incumbent/], // a genome over a body-only record
    [{ genome: null, ...fieldsOf(REDRAW) }, /redraw_without_stored_request/],
    [{ genome: null, ...fieldsOf(otherBody), storedRequest: otherStored }, /redraw_body_is_not_the_incumbent_body/], // intact copy, another body
    [{ genome: null, ...fieldsOf(REDRAW, { requestName: 'renamed' }), storedRequest: redrawStored }, /stored_request_is_not_the_validated_request/],
    [{ genome: null, ...fieldsOf(REDRAW, { state: 'rejected' }), storedRequest: redrawStored }, /only be updated from a validated submission/],
  ];
  for (const [rec, re] of cases) {
    assert.throws(() => recordRedraw(dir, rec), re, String(re));
    assert.equal(readFileSync(incPath(dir), 'utf8'), before, `incumbent.json untouched: ${re}`);
  }
  recordRedraw(dir, { genome: null, ...fieldsOf(REDRAW, { date: '2026-10-10' }), storedRequest: redrawStored });
  const after = JSON.parse(readFileSync(incPath(dir), 'utf8'));
  assert.deepEqual([after.genome, after.submissionId, after.storedRequest, after.genomeFrom], [null, REDRAW.submission_id, redrawStored,
    { submissionId: REQ.submission_id, date: '2026-10-09' }]);
});

test('loadIncumbent: a record with neither a genome nor a stored request, or a digest without a genome, fails closed', () => {
  const dir = bodyOnly();
  const rec = JSON.parse(readFileSync(incPath(dir), 'utf8'));
  assert.deepEqual([loadIncumbent(dir, cells).genome, loadIncumbent(dir, cells).submissionId], [null, REQ.submission_id]);
  writeFileSync(incPath(dir), JSON.stringify({ ...rec, storedRequest: undefined }));
  assert.throws(() => loadIncumbent(dir, cells), /incumbent_state_has_neither_genome_nor_stored_request/);
  writeFileSync(incPath(dir), JSON.stringify({ ...rec, genomeDigest: 'f'.repeat(64) }));
  assert.throws(() => loadIncumbent(dir, cells), /incumbent_state_digest_mismatch/);
});
