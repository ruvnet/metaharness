// bootstrap-incumbent.mjs: incumbent.json from an arena-validated request no genome can express. It verifies the
// request digest against the receipt digest passed explicitly AND the receipt written when it was POSTed, the
// operator-fetched status evidence (validated, slot used, same id, same Toronto date), refuses over a pending submission,
// a running tick, (without --replace) an existing incumbent and (without --clear-rejection) a recorded rejection, writes
// the read-only stored copy before the record, and never contacts the network or reads a token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapIncumbent, bootstrapRefusals } from '../bootstrap-incumbent.mjs';
import { canonicalDigest, canonicalJson } from '../canonical-json.mjs';
import { readStoredRequest, requestBodyDigest } from '../incumbent.mjs';
import { LockedError } from '../journal.mjs';
import { mix8Request, receiptFor } from './fw-fakes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../bootstrap-incumbent.mjs');
const DATE = '2026-10-09';
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const REQ = mix8Request();
const SHA = canonicalDigest(REQ);
const RECEIPT = receiptFor(REQ); // POSTed 2026-10-09 18:40 UTC = 14:40 Toronto
const EVIDENCE = { submission_id: REQ.submission_id, state: 'validated', slot: { state: 'used' }, images: [{ submitted: REQ.image }],
  dataset: { repo: REQ.dataset, revision: 'abc' } };
const good = (over = {}) => ({ request: REQ, submissionId: REQ.submission_id, requestSha256: SHA, receipt: RECEIPT, evidence: EVIDENCE, date: DATE, ...over });
const fresh = () => join(mkdtempSync(join(tmpdir(), 'fw-bootstrap-')), 'state');
const journal = stateDir => readFileSync(join(stateDir, 'journal.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('bootstrapRefusals: the exact request, its receipt and validated evidence pass; every defect is named', () => {
  assert.deepEqual(bootstrapRefusals(good()), []);
  assert.deepEqual(bootstrapRefusals(good({ evidence: { submission_id: REQ.submission_id, state: 'validated', slot_state: 'used' } })), [],
    'arena-api summary shape (slot_state)');
  const cases = [
    [{ requestSha256: 'e'.repeat(64) }, 'request_digest_mismatch'],
    [{ requestSha256: 'not-hex' }, 'request_sha256_invalid'],
    [{ request: { ...REQ, name: `${REQ.name} ` } }, 'request_digest_mismatch'], // one byte off the receipt
    [{ submissionId: 'metaharness-other-1' }, 'request_submission_id_mismatch'],
    [{ submissionId: '../x' }, 'submission_id_invalid'],
    [{ request: { ...REQ, submission_id: 'metaharness-other-1' }, requestSha256: canonicalDigest({ ...REQ, submission_id: 'metaharness-other-1' }) }, 'request_submission_id_mismatch'],
    [{ request: [] }, 'request_not_object'],
    [{ date: '2026-02-30' }, 'date_invalid'],
    [{ date: 'today' }, 'date_invalid'],
    // the receipt written when it was POSTed
    [{ receipt: undefined }, 'receipt_not_object'],
    [{ receipt: { ...RECEIPT, submission_id: 'metaharness-other-1' } }, 'receipt_submission_id_mismatch'],
    [{ receipt: { ...RECEIPT, request_sha256: 'e'.repeat(64) } }, 'receipt_request_sha256_mismatch'],
    [{ receipt: { ...RECEIPT, post_attempted: false } }, 'receipt_post_not_attempted'],
    [{ receipt: { ...RECEIPT, state: 'sending' } }, 'receipt_state_not_recorded:sending'],
    [{ receipt: { ...RECEIPT, state: 'refused' } }, 'receipt_state_not_recorded:refused'],
    // --date is the Toronto date of the submission (receipt, and the status when it carries a time)
    [{ date: '2026-10-10' }, 'date_differs_from_receipt_accepted_at:2026-10-09'],
    [{ receipt: { ...RECEIPT, accepted_at: 'yesterday' } }, 'receipt_accepted_at_unparseable'],
    [{ evidence: { ...EVIDENCE, queued_at: Date.parse('2026-10-11T12:00:00Z') / 1000 } }, 'date_differs_from_evidence_queued_at:2026-10-11'],
    // the arena's word
    [{ evidence: null }, 'evidence_not_object'],
    [{ evidence: { ...EVIDENCE, submission_id: 'metaharness-other-1' } }, 'evidence_submission_id_mismatch'],
    [{ evidence: { ...EVIDENCE, state: 'validating' } }, 'evidence_state_not_validated:validating'],
    [{ evidence: { ...EVIDENCE, state: 'rejected' } }, 'evidence_state_not_validated:rejected'],
    [{ evidence: { ...EVIDENCE, state: 'done' } }, 'evidence_state_not_validated:done'], // not an arena state: the board check would never agree
    [{ evidence: RECEIPT }, 'evidence_state_not_validated:recorded'], // the receipt is not the arena's status
    [{ evidence: { ...EVIDENCE, slot: { state: 'held' } } }, 'evidence_slot_not_used:held'],
    [{ evidence: { ...EVIDENCE, slot: { state: 'returned' } } }, 'evidence_slot_not_used:returned'],
    [{ evidence: { submission_id: REQ.submission_id, state: 'validated' } }, 'evidence_slot_not_used:missing'],
    [{ evidence: { ...EVIDENCE, slot_state: 'held' } }, 'evidence_slot_not_used:used/held'], // two forms that disagree
    [{ evidence: { ...EVIDENCE, error_origin: 'author' } }, 'evidence_has_error_origin'],
    [{ evidence: { ...EVIDENCE, request_sha256: 'e'.repeat(64) } }, 'evidence_request_sha256_mismatch'],
    [{ evidence: { ...EVIDENCE, images: [{ submitted: 'ghcr.io/x/y@sha256:' + '1'.repeat(64) }] } }, 'evidence_image_mismatch'],
    [{ evidence: { ...EVIDENCE, dataset: { repo: 'someone/else' } } }, 'evidence_dataset_mismatch'],
  ];
  for (const [over, reason] of cases) assert.ok(bootstrapRefusals(good(over)).includes(reason), `${reason}: ${bootstrapRefusals(good(over))}`);
  // a request the arena rules would refuse is never made an incumbent (it could never pass the re-draw checks either)
  const withReceipt = req => good({ request: req, requestSha256: canonicalDigest(req), receipt: receiptFor(req) });
  const bad = { ...REQ, tasks: [{ ...REQ.tasks[0], rollout_wall_s: 99999 }] };
  assert.ok(bootstrapRefusals(withReceipt(bad)).some(r => r.startsWith('request_invalid:')));
  // ... nor one that passes only under its own name: every re-draw carries the suffix, and a 185-char name would exceed 200
  assert.deepEqual(bootstrapRefusals(withReceipt(mix8Request({ name: 'N'.repeat(185) }))), ['redraw_request_invalid:name_invalid']);
  // ... nor one whose task carries its own image: a re-draw's checks pull, run and replay the top-level image only
  const perTask = mix8Request({ tasks: REQ.tasks.map((t, i) => (i === 1 ? { ...t, image: 'ghcr.io/someone-else/x@sha256:' + '9'.repeat(64) } : t)) });
  assert.deepEqual(bootstrapRefusals(withReceipt(perTask)), ['request_per_task_image_not_checked']);
});

test('bootstrapRefusals: a request.json edited after its POST is refused by its receipt, even with its own digest passed', () => {
  const edited = mix8Request({ tasks: REQ.tasks.map(t => ({ ...t, completion_tokens: 24576 })) }); // never POSTed, never validated
  assert.deepEqual(bootstrapRefusals(good({ request: edited, requestSha256: canonicalDigest(edited) })), ['receipt_request_sha256_mismatch']);
  assert.deepEqual(bootstrapRefusals(good({ request: edited })), ['request_digest_mismatch']);
});

test('bootstrapRefusals: the real receipt shape (env lane submission.py), POSTed 00:40 UTC = the previous Toronto day', () => {
  const real = { ...receiptFor(REQ), created_at: '2026-10-09T00:40:52.652655+00:00', accepted_at: '2026-10-09T00:40:53.314134+00:00',
    arena_state: 'validating', slot_state: 'held' };
  assert.deepEqual(bootstrapRefusals(good({ receipt: real, date: '2026-10-08' })), []);
  assert.deepEqual(bootstrapRefusals(good({ receipt: real, date: '2026-10-09' })), ['date_differs_from_receipt_accepted_at:2026-10-08']);
});

test('bootstrapIncumbent: stored copy (canonical bytes, 0400) first, then a genome-less record bound to it, then a journal row', () => {
  const stateDir = fresh();
  const r = bootstrapIncumbent({ stateDir, ...good(), clock: () => `${DATE}T23:00:00.000Z` });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.replaced, r.droppedLastRejected], [false, null]);
  const stored = join(stateDir, `validated-requests/${SHA}.json`);
  assert.equal(readFileSync(stored, 'utf8'), canonicalJson(REQ), 'the exact POST bytes; sha256(file) = request_sha256');
  assert.equal(statSync(stored).mode & 0o777, 0o400);
  assert.equal(readStoredRequest(stateDir, r.storedRequest).ok, true);
  const rec = readJson(join(stateDir, 'incumbent.json'));
  assert.deepEqual(rec, { genome: null, genomeDigest: null, submissionId: REQ.submission_id, requestSha256: SHA, date: DATE, state: 'validated',
    requestBodySha256: requestBodyDigest(REQ), requestName: REQ.name, storedRequest: { path: `validated-requests/${SHA}.json`, sha256: SHA } });
  assert.deepEqual(journal(stateDir).map(e => [e.date, e.phase, e.event, e.submissionId, e.replaced, e.receiptState, e.droppedLastRejected]),
    [[DATE, 'incumbent', 'bootstrapped', REQ.submission_id, false, 'recorded', null]]);
});

test('bootstrapIncumbent refuses over an existing incumbent (unless --replace), a recorded rejection (unless --clear-rejection), a pending submission or a running tick', () => {
  const stateDir = fresh();
  const incPath = join(stateDir, 'incumbent.json');
  assert.equal(bootstrapIncumbent({ stateDir, ...good() }).ok, true);
  const before = readFileSync(incPath, 'utf8');
  assert.deepEqual(bootstrapIncumbent({ stateDir, ...good() }).reasons, ['incumbent_exists: pass --replace to replace it']);
  assert.equal(readFileSync(incPath, 'utf8'), before);
  // --replace never drops a recorded arena rejection silently: the next tick would POST the rejected body again
  const lastRejected = { submissionId: 'metaharness-darwin-2026-10-10-redraw-0123456789', date: '2026-10-10', errorOrigin: 'author', requestBodySha256: requestBodyDigest(REQ) };
  writeFileSync(incPath, JSON.stringify({ ...JSON.parse(before), lastRejected }));
  const withRejection = readFileSync(incPath, 'utf8');
  const refused = bootstrapIncumbent({ stateDir, ...good(), replace: true });
  assert.equal(refused.ok, false);
  assert.match(refused.reasons[0], /^last_rejected_present:metaharness-darwin-2026-10-10-redraw-0123456789: .*--clear-rejection/);
  assert.equal(readFileSync(incPath, 'utf8'), withRejection, 'nothing written');
  // ... only with an explicit --clear-rejection, and the dropped record is named in the output and the journal
  const cleared = bootstrapIncumbent({ stateDir, ...good(), replace: true, clearRejection: true });
  assert.deepEqual([cleared.ok, cleared.replaced, cleared.droppedLastRejected], [true, true, lastRejected]);
  assert.equal('lastRejected' in readJson(incPath), false);
  assert.deepEqual(journal(stateDir).at(-1).droppedLastRejected, lastRejected);
  // a record that cannot be read may hold a rejection too
  writeFileSync(incPath, '{ not json');
  assert.match(bootstrapIncumbent({ stateDir, ...good(), replace: true }).reasons[0], /^incumbent_unreadable: .*--clear-rejection/);
  const again = bootstrapIncumbent({ stateDir, ...good(), replace: true, clearRejection: true });
  assert.deepEqual([again.ok, again.droppedLastRejected], [true, { unreadableIncumbent: true }]);
  // --replace over a record without a rejection drops nothing
  assert.deepEqual(bootstrapIncumbent({ stateDir, ...good(), replace: true }).droppedLastRejected, null);
  // a submission in flight must be reconciled by a tick first
  writeFileSync(join(stateDir, 'pending-submission.json'), JSON.stringify({ date: DATE, submissionId: 's', state: 'sending' }));
  assert.match(bootstrapIncumbent({ stateDir, ...good(), replace: true }).reasons[0], /^pending_submission_exists/);
  // a live tick holds the lock
  const s2 = fresh();
  mkdirSync(s2, { recursive: true });
  writeFileSync(join(s2, 'flywheel.lock'), JSON.stringify({ pid: 4242, date: DATE, startedAt: 'x', token: 't' }));
  assert.throws(() => bootstrapIncumbent({ stateDir: s2, ...good(), isPidAlive: () => true }), LockedError);
  assert.throws(() => readFileSync(join(s2, 'incumbent.json')), /ENOENT/, 'nothing written');
  // invalid inputs write nothing at all (not even the stored copy)
  const s3 = fresh();
  assert.equal(bootstrapIncumbent({ stateDir: s3, ...good({ requestSha256: 'e'.repeat(64) }) }).ok, false);
  assert.throws(() => statSync(s3), /ENOENT/);
});

test('CLI: offline (no token reachable, no network module imported), refuses bad evidence, writes on a match; no genome option', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-bootstrap-cli-'));
  const reqPath = join(dir, 'request.json'), evPath = join(dir, 'status.json'), rcPath = join(dir, 'receipt.json'), stateDir = join(dir, 'state');
  writeFileSync(reqPath, JSON.stringify(REQ, null, 2)); // a pretty file: the canonical digest is what counts
  writeFileSync(rcPath, JSON.stringify(RECEIPT));
  const env = { PATH: process.env.PATH, HOME: join(dir, 'empty-home'), HF_TOKEN_PATH: join(dir, 'no-token') };
  const cli = (args, ev = EVIDENCE) => { writeFileSync(evPath, JSON.stringify(ev)); return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env }); };
  const args = ['--request', reqPath, '--submission-id', REQ.submission_id, '--request-sha256', SHA, '--receipt', rcPath, '--validated-evidence', evPath,
    '--date', DATE, '--state-dir', stateDir];
  assert.equal(cli(['--request', reqPath]).status, 2, 'missing arguments');
  const noReceipt = cli(args.filter((a, i) => a !== '--receipt' && args[i - 1] !== '--receipt'));
  assert.equal(noReceipt.status, 2, 'the POST receipt is required');
  assert.match(noReceipt.stderr, /missing --receipt/);
  assert.equal(cli([...args, '--genome', 'g.json']).status, 2, 'a hand-curated request has no genome: there is no such option');
  const refused = cli(args, { ...EVIDENCE, state: 'validating' });
  assert.equal(refused.status, 1);
  assert.deepEqual(JSON.parse(refused.stderr).reasons, ['evidence_state_not_validated:validating']);
  assert.equal(cli(args.map(a => (a === SHA ? 'e'.repeat(64) : a))).status, 1);
  assert.equal(cli(args.map(a => (a === DATE ? '2026-10-10' : a))).status, 1, 'not the submission\'s Toronto date');
  assert.deepEqual(JSON.parse(cli(args.map(a => (a === rcPath ? join(dir, 'none.json') : a))).stderr).reasons, ['receipt_unreadable:ENOENT']);
  assert.throws(() => statSync(stateDir), /ENOENT/, 'nothing written on a refusal');
  const ok = cli(args);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([JSON.parse(ok.stdout).ok, readJson(join(stateDir, 'incumbent.json')).requestSha256], [true, SHA]);
  assert.equal(cli(args).status, 1, 'an existing incumbent needs --replace');
  assert.equal(cli([...args, '--replace']).status, 0);
  writeFileSync(join(stateDir, 'incumbent.json'), JSON.stringify({ ...readJson(join(stateDir, 'incumbent.json')), lastRejected: { submissionId: 'x' } }));
  assert.equal(cli([...args, '--replace']).status, 1, 'a recorded rejection needs --clear-rejection');
  const cleared = cli([...args, '--replace', '--clear-rejection']);
  assert.deepEqual([cleared.status, JSON.parse(cleared.stdout).droppedLastRejected], [0, { submissionId: 'x' }]);
  // no path to the network or a token: neither the CLI nor anything it imports (transitively) loads one
  const seen = new Set(), queue = [CLI];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /\bfetch\(|node:(https?|net|dns|tls)|createArenaClient|readHfToken/, file);
    for (const [, spec] of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'(\.[^']+)'/gm)) queue.push(resolve(dirname(file), spec));
  }
  for (const f of seen) assert.doesNotMatch(f, /arena-(api|token)\.mjs$/, f);
  assert.ok(seen.size >= 6, [...seen].join(', '));
});
