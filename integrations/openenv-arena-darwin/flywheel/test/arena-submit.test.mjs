// Run: node --test integrations/openenv-arena-darwin/flywheel/test/arena-submit.test.mjs
// Receipt-guarded submit against a local fake arena, the pure 24h slot logic, leaderboard standing, and
// byte-for-byte parity of canonical-json.mjs with the env lane's submission.py digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArenaClient, SubmitError, parseTimestampMs, slotStatus, userStanding } from '../arena-api.mjs';
import { CanonicalError, canonicalDigest, canonicalJson, sha256Hex } from '../canonical-json.mjs';
import { FAKE_BOARD, startFakeArena } from './arena-fakes/fake-arena-server.mjs';

const ENV_DIR = '/home/ruvultra/projects/metaharness-arena-knobs/integrations/openenv-arena';
const TOKEN = 'hf_' + randomBytes(30).toString('base64url');
const dir = () => mkdtempSync(join(tmpdir(), 'arena-submit-test-'));
const setup = async routes => {
  const d = dir();
  writeFileSync(join(d, 'token'), TOKEN, { mode: 0o600 });
  const fake = await startFakeArena(routes);
  const c = createArenaClient({ base: fake.base, env: { HOME: '/nonexistent', HF_HOME: d }, sleep: async () => {}, clock: () => '2026-10-09T12:00:00.000Z' });
  return { d, fake, c, receipt: join(d, 'state', 'receipt.json') };
};
const REQ = { submission_id: 'flywheel-test-1', name: 'MetaHarness test', image: 'ghcr.io/ruvnet/x@sha256:' + 'a'.repeat(64),
  dataset: 'ruv/metaharness-arena-tasks', schema: { action: { type: 'object' }, observation: { type: 'object' } },
  tasks: [{ task_id: 'software_change-d2', split: 'train', completion_tokens: 8192 }], example_actions: [{ op: 'submit', answer: {} }] };
const SHA = canonicalDigest(REQ);
const SUB = '/api/openenv/submissions';
const posts = fake => fake.requests.filter(r => r.method === 'POST');
const ok202 = { status: 202, json: { submission_id: REQ.submission_id, state: 'validating', slot: { state: 'held' },
  images: [{ submitted: REQ.image, resolved: REQ.image, compatibility: null }], dataset: { repo: REQ.dataset, revision: 'c'.repeat(40) } } };

test('submit happy path: preflight GET, `sending` persisted BEFORE the single POST of the approved bytes', async () => {
  const { fake, c, receipt } = await setup({
    [`POST ${SUB}`]: () => { const r = JSON.parse(readFileSync(receipt, 'utf8')); return r.state === 'sending' ? ok202 : { status: 500, json: {} }; },
  });
  try {
    const r = await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt });
    assert.equal(r.state, 'recorded');
    assert.equal(r.arena.slot_state, 'held');
    assert.equal(r.arena.images[0].resolved, REQ.image, 'the pinned digest is kept for post-submit verification');
    assert.deepEqual(fake.requests.map(q => `${q.method} ${q.path}`), [`GET ${SUB}/${REQ.submission_id}`, `POST ${SUB}`]);
    const [p] = posts(fake);
    assert.equal(sha256Hex(p.body), SHA, 'wire bytes hash to the approved digest');
    assert.equal(p.headers['content-type'], 'application/json');
    assert.ok(p.headers.authorization === 'Bearer ' + TOKEN);
    const text = readFileSync(receipt, 'utf8');
    assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(3)));
    assert.ok(!existsSync(receipt + '.lock'));
  } finally { await fake.close(); }
});

test('submit refuses before any network on digest mismatch, floats, or a bad id', async () => {
  const { fake, c, receipt } = await setup();
  try {
    await assert.rejects(c.submit({ request: { ...REQ, name: 'changed' }, approvedSha256: SHA, receiptPath: receipt }), SubmitError);
    await assert.rejects(c.submit({ request: { ...REQ, x: 1.5 }, approvedSha256: SHA, receiptPath: receipt }), CanonicalError);
    await assert.rejects(c.submit({ request: { ...REQ, submission_id: '../x' }, approvedSha256: SHA, receiptPath: receipt }), SubmitError);
    await assert.rejects(c.submit({ request: REQ, approvedSha256: SHA.toUpperCase(), receiptPath: receipt }), SubmitError);
    assert.equal(fake.requests.length, 0);
    assert.ok(!existsSync(receipt));
  } finally { await fake.close(); }
});

test('an id that already exists on the arena is recorded, never re-POSTed', async () => {
  const { fake, c, receipt } = await setup({ [`GET ${SUB}/${REQ.submission_id}`]: () => ({ status: 200, json: { ...ok202.json, state: 'validated' } }) });
  try {
    const r = await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt });
    assert.equal(r.state, 'recorded');
    assert.equal(r.post_attempted, false);
    assert.equal(posts(fake).length, 0);
  } finally { await fake.close(); }
});

test('429 SUBMISSION_QUOTA_EXCEEDED: refused, retry_after_s kept, slot not consumed; slotStatus honours it', async () => {
  const { fake, c, receipt } = await setup({ [`POST ${SUB}`]: () => ({ status: 429, json: { code: 'SUBMISSION_QUOTA_EXCEEDED', retry_after_s: 3600 } }) });
  try {
    const r = await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt });
    assert.deepEqual([r.state, r.error_code, r.http_status, r.retry_after_s, r.slot_consumed], ['refused', 'SUBMISSION_QUOTA_EXCEEDED', 429, 3600, false]);
    assert.equal(posts(fake).length, 1);
    const at = Date.parse(r.quota_observed_at);
    const s = slotStatus({ submissions: [], nowMs: at + 1000, quota: { retryAfterS: r.retry_after_s, observedAtMs: at } });
    assert.deepEqual([s.free, s.reasons, s.freeAtMs], [false, ['quota_exceeded'], at + 3600e3]);
    assert.equal(slotStatus({ submissions: [], nowMs: at + 3601e3, quota: { retryAfterS: 3600, observedAtMs: at } }).free, true);
    assert.deepEqual(slotStatus({ submissions: [], nowMs: at, quota: { retryAfterS: null, observedAtMs: at } }).reasons, ['quota_retry_after_unknown']);
  } finally { await fake.close(); }
});

test('503 IMAGE_UNAVAILABLE is a definite refusal; a bare proxy 502 is unknown and reconciled, never re-POSTed', async () => {
  let mode = '503';
  let visible = false;
  const { fake, c, receipt } = await setup({
    [`POST ${SUB}`]: () => (mode === '503' ? { status: 503, json: { code: 'IMAGE_UNAVAILABLE' } } : { status: 502, text: 'Bad Gateway' }),
    [`GET ${SUB}/${REQ.submission_id}`]: () => (visible ? { status: 200, json: ok202.json } : { status: 404, json: {} }),
  });
  try {
    assert.equal((await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt })).state, 'refused');
    mode = '502';
    const receipt2 = receipt.replace('receipt.json', 'receipt2.json');
    const r = await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt2 });
    assert.equal(r.state, 'unconfirmed');
    assert.equal(posts(fake).length, 2, 'one POST per receipt; the 502 was not retried');
    visible = true; // the arena did accept it after all: a rerun only reconciles
    const again = await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt2 });
    assert.equal(again.state, 'recorded');
    assert.equal(posts(fake).length, 2);
  } finally { await fake.close(); }
});

test('a receipt of a different request, or a held lock, refuses without sending', async () => {
  const { fake, c, receipt, d } = await setup();
  try {
    await c.submit({ request: REQ, approvedSha256: SHA, receiptPath: receipt });
    const other = { ...REQ, name: 'other' };
    await assert.rejects(c.submit({ request: other, approvedSha256: canonicalDigest(other), receiptPath: receipt }), /different request/);
    const locked = join(d, 'locked.json');
    writeFileSync(locked + '.lock', '');
    await assert.rejects(c.submit({ request: REQ, approvedSha256: SHA, receiptPath: locked }), /locked/);
    assert.equal(posts(fake).length, 1);
  } finally { await fake.close(); }
});

test('slotStatus: rolling 24h from acceptance, returned/platform slots free, every ambiguity fails closed', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const sub = (o) => ({ submission_id: 's', state: 'validated', ...o });
  const at = h => (now - h * 3600e3) / 1000; // arena-style epoch seconds (float)
  const f = list => slotStatus({ submissions: list, nowMs: now });
  assert.equal(f([]).free, true);
  assert.deepEqual([f([sub({ slot: { state: 'held' }, accepted_at: at(2) })]).free, f([sub({ slot: { state: 'held' }, accepted_at: at(2) })]).freeAtMs], [false, now + 22 * 3600e3]);
  assert.equal(f([sub({ slot: { state: 'used' }, accepted_at: at(25) })]).free, true);
  assert.equal(f([sub({ slot: { state: 'returned' }, accepted_at: at(1) })]).free, true);
  assert.equal(f([sub({ state: 'rejected', error_origin: 'platform', created_at: at(1) })]).free, true);
  assert.equal(f([sub({ state: 'rejected', error_origin: 'author', created_at: at(1) })]).free, false);
  assert.equal(f([sub({ state: 'validating', created_at: new Date(now - 3600e3).toISOString() })]).free, false, 'ISO timestamps parse');
  assert.equal(f([sub({ slot: { state: 'used' }, accepted_at: at(-1) })]).free, false, 'future timestamp counts');
  assert.deepEqual(f([sub({ slot: { state: 'used' } })]).reasons, ['slot_timestamp_unknown:s']);
  assert.deepEqual(f([sub({ slot: { state: 'used' }, accepted_at: '2026-10-09T10:00:00' })]).reasons, ['slot_timestamp_unknown:s'], 'no timezone -> unknown');
  assert.deepEqual(slotStatus({ submissions: null, nowMs: now }).reasons, ['submissions_list_unavailable']);
  assert.throws(() => slotStatus({ submissions: [], nowMs: NaN }), TypeError);
  // the live shape (2026-10-09): queued_at + slot.window_ends_at, both epoch seconds; the arena's window end wins
  const live = (ends, queued) => sub({ slot: { state: 'used', window_ends_at: ends }, queued_at: queued });
  assert.deepEqual([f([live(at(-20), at(4))]).free, f([live(at(-20), at(4))]).freeAtMs], [false, now + 20 * 3600e3]);
  assert.equal(f([live(at(1), at(25))]).free, true, 'window over');
  assert.deepEqual([f([sub({ slot: { state: 'held' }, queued_at: at(3) })]).free, f([sub({ slot: { state: 'held' }, queued_at: at(3) })]).freeAtMs],
    [false, now + 21 * 3600e3], 'queued_at + 24 h when the window end is missing');
  assert.equal(parseTimestampMs(1791464238.1075242), 1791464238107.5242);
  assert.equal(parseTimestampMs(1791464238107), 1791464238107);
  assert.equal(parseTimestampMs(-1), null);
});

test('userStanding: Day 1 = no incumbent; a truncated board that hides the user is unknown, not "none"', () => {
  assert.deepEqual([userStanding(FAKE_BOARD, 'ruv').hasIncumbent, userStanding(FAKE_BOARD, 'someone-else').rank], [false, 1]);
  assert.equal(userStanding({ ...FAKE_BOARD, next_cursor: 'abc' }, 'ruv').hasIncumbent, null);
  assert.equal(userStanding({ ...FAKE_BOARD, entries: [], runs: [{ user: 'ruv' }] }, 'ruv').hasIncumbent, true);
  assert.throws(() => userStanding({ entries: [] }, 'ruv'));
});

test('canonical JSON is byte-identical to submission.py digest(), incl. non-ASCII, controls, DEL, astral keys', { skip: !existsSync(ENV_DIR) }, () => {
  const values = [
    JSON.parse(readFileSync(join(ENV_DIR, 'evidence/submission-candidate.json'), 'utf8')),
    { 'é': 'café 日本 😀', z: [-0, 0, -5, 9007199254740991, true, false, null, {}, []], '\u007f': '\u0000\u001f\b\f\n\r\t"\\/', b: { '😀': 1, '￿': 2, a: 'x' } },
    REQ,
  ];
  const py = spawnSync('python3', ['-c', 'import sys, json; sys.path.insert(0, sys.argv[1]); import submission\nfor line in sys.stdin: print(submission.digest(json.loads(line)))', ENV_DIR],
    { input: values.map(v => JSON.stringify(v)).join('\n') + '\n', encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(py.status, 0, py.stderr);
  assert.deepEqual(py.stdout.trim().split('\n'), values.map(canonicalDigest));
  assert.throws(() => canonicalJson({ a: 1.5 }), CanonicalError);
  assert.throws(() => canonicalJson({ a: Infinity }), CanonicalError);
  assert.throws(() => canonicalJson({ a: undefined }), CanonicalError);
});

test('adv 9: latestValidatedId = the newest validated OWN submission; none = null; an unreadable list = undefined (unknown)', async () => {
  const { latestValidatedId } = await import('../arena-slot.mjs');
  const sub = (id, state, accepted_at) => ({ submission_id: id, state, ...(accepted_at ? { accepted_at } : {}) });
  assert.equal(latestValidatedId([]), null);
  assert.equal(latestValidatedId([sub('a', 'rejected'), sub('b', 'validating')]), null);
  assert.equal(latestValidatedId([sub('new', 'validated'), sub('old', 'validated')]), 'new', 'documented newest first');
  assert.equal(latestValidatedId([sub('old', 'validated', '2026-10-01T10:00:00Z'), sub('new', 'validated', '2026-10-05T10:00:00Z')]), 'new', 'by time when all have one');
  for (const bad of [null, undefined, 'x', [null], [sub('', 'validated')], [{ state: 'validated' }]]) assert.equal(latestValidatedId(bad), undefined, JSON.stringify(bad));
  assert.equal(slotStatus({ submissions: [sub('v1', 'validated', '2026-10-01T10:00:00Z')], nowMs: Date.parse('2026-10-09T00:00:00Z') }).latestValidatedId, 'v1');
});
