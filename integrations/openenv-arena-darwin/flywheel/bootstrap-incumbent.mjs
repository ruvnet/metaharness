#!/usr/bin/env node
// Bootstrap incumbent.json from an arena-VALIDATED request that no Darwin genome can express (a hand-curated request,
// e.g. math at d2 AND d3 with custom per-task budgets), so policy daily-best can re-draw exactly that request.
// Offline by construction: it never contacts the network and never reads a token (it imports no arena client). The
// operator supplies the arena's word as files they fetched read-only themselves.
//
//   node bootstrap-incumbent.mjs --request REQUEST.json --submission-id ID --request-sha256 HEX --receipt RECEIPT.json \
//     --validated-evidence STATUS.json --date YYYY-MM-DD [--state-dir DIR] [--replace [--clear-rejection]]
//
//   REQUEST.json  the exact request that was POSTed. Its canonical digest must equal --request-sha256 and its submission_id
//                 must be ID. It must pass the arena request rules under its own name AND under its re-draw name, and carry
//                 no per-task image (a re-draw's checks pull and run the top-level image only).
//   RECEIPT.json  the receipt written when it was POSTed (arena-api.mjs or the env lane's submission.py): submission_id ID,
//                 request_sha256 = --request-sha256, post_attempted true, state recorded. It is what ties REQUEST.json to
//                 the bytes that were sent: the arena never exposes a request body, so the body itself is not verifiable
//                 against the arena.
//   STATUS.json   that submission's status, e.g. `node arena-api.mjs submission --id ID > STATUS.json` (raw arena JSON or
//                 arena-api's summary): submission_id = ID, state validated, slot used (`slot.state` or `slot_state`),
//                 no error_origin; request_sha256, images and dataset, when present, must agree with the request.
//   --date        the Toronto date of that submission. It must equal the Toronto date of the receipt's (and the status's,
//                 when it has one) first of accepted_at / created_at / submitted_at / queued_at.
//   --replace     replace an existing incumbent.json. One that records an arena rejection of a re-draw (lastRejected), or
//                 cannot be read, is replaced only with --clear-rejection too: a dropped rejection is never silent (the
//                 next tick could POST the rejected body again), and the output and journal name it (droppedLastRejected).
//
// Refuses while a tick holds the flywheel lock and while a submission is pending. Writes the immutable stored copy
// <state>/validated-requests/<sha256>.json (canonical bytes, mode 0400) FIRST, then incumbent.json (genome null:
// nothing is searched from or promoted over this incumbent; it is only re-drawn), both atomically, and journals it.
// stdout: {ok, ...}. Exit: 0 written, 1 refused (reasons), 2 usage, 75 a tick holds the lock.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ACCEPTED_AT_FIELDS, parseTimestampMs } from './arena-slot.mjs';
import { canonicalDigest, SHA256_RE } from './canonical-json.mjs';
import { torontoDate } from './dates.mjs';
import { defaultStateDir } from './flywheel-config.mjs';
import { readPending, redrawName, requestBodyDigest, storeRequest, writeIncumbent } from './incumbent.mjs';
import { acquireLock, LockedError, openJournal, pidAlive, readJsonIfExists, redact } from './journal.mjs';
import { checkRequest } from './presubmit-rules.mjs';

export const VALIDATED_STATES = Object.freeze(['validated']); // the arena's own vocabulary (arena-api.mjs, arena-slot.mjs)
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const validDate = d => typeof d === 'string' && DATE_RE.test(d) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
const short = v => String(v).slice(0, 32);

/** Pure: every reason these inputs cannot bootstrap an incumbent. [] is the only pass. */
export function bootstrapRefusals({ request, submissionId, requestSha256, receipt, evidence, date }) {
  const r = [];
  if (typeof submissionId !== 'string' || !ID_RE.test(submissionId)) r.push('submission_id_invalid');
  if (typeof requestSha256 !== 'string' || !SHA256_RE.test(requestSha256)) r.push('request_sha256_invalid');
  if (!validDate(date)) r.push('date_invalid');
  if (!isObj(request)) r.push('request_not_object');
  else {
    let digest = null;
    try { digest = canonicalDigest(request); } catch { r.push('request_not_canonical_json'); }
    if (digest !== null && digest !== requestSha256) r.push('request_digest_mismatch');
    if (request.submission_id !== submissionId) r.push('request_submission_id_mismatch');
    const own = checkRequest(request);
    r.push(...own.map(x => `request_invalid:${x}`));
    // every re-draw carries the re-draw name: a request that passes only under its own name could never be re-drawn
    r.push(...checkRequest({ ...request, name: redrawName(request.name) }).filter(x => !own.includes(x)).map(x => `redraw_request_invalid:${x}`));
    if (Array.isArray(request.tasks) && request.tasks.some(t => isObj(t) && Object.hasOwn(t, 'image'))) r.push('request_per_task_image_not_checked');
  }
  if (!isObj(receipt)) r.push('receipt_not_object');
  else {
    if (receipt.submission_id !== submissionId) r.push('receipt_submission_id_mismatch');
    if (receipt.request_sha256 !== requestSha256) r.push('receipt_request_sha256_mismatch');
    if (receipt.post_attempted !== true) r.push('receipt_post_not_attempted');
    if (receipt.state !== 'recorded') r.push(`receipt_state_not_recorded:${short(receipt.state)}`);
  }
  for (const [name, src] of [['receipt', receipt], ['evidence', evidence]]) { // --date is the Toronto date of the submission
    const field = isObj(src) ? ACCEPTED_AT_FIELDS.find(f => src[f] !== undefined && src[f] !== null) : undefined;
    if (field === undefined) continue;
    const ms = parseTimestampMs(src[field]);
    if (ms === null) r.push(`${name}_${field}_unparseable`);
    else if (validDate(date) && torontoDate(ms) !== date) r.push(`date_differs_from_${name}_${field}:${torontoDate(ms)}`);
  }
  if (!isObj(evidence)) return [...r, 'evidence_not_object'];
  if (evidence.submission_id !== submissionId) r.push('evidence_submission_id_mismatch');
  if (!VALIDATED_STATES.includes(evidence.state)) r.push(`evidence_state_not_validated:${short(evidence.state)}`);
  const slots = [isObj(evidence.slot) ? evidence.slot.state : undefined, evidence.slot_state].filter(v => v !== undefined);
  if (!slots.length || slots.some(s => s !== 'used')) r.push(`evidence_slot_not_used:${slots.map(String).join('/').slice(0, 32) || 'missing'}`);
  if (evidence.error_origin !== undefined && evidence.error_origin !== null) r.push('evidence_has_error_origin');
  for (const k of ['request_sha256', 'requestSha256']) if (evidence[k] !== undefined && evidence[k] !== requestSha256) r.push('evidence_request_sha256_mismatch');
  if (Array.isArray(evidence.images) && isObj(request)) {
    const submitted = evidence.images.map(i => i?.submitted ?? i?.image).filter(v => typeof v === 'string');
    if (submitted.length && !submitted.includes(request.image)) r.push('evidence_image_mismatch');
  }
  const repo = typeof evidence.dataset === 'string' ? evidence.dataset : isObj(evidence.dataset) ? evidence.dataset.repo : undefined;
  if (repo !== undefined && repo !== null && isObj(request) && repo !== request.dataset) r.push('evidence_dataset_mismatch');
  return r;
}

/**
 * Verify, then (under the flywheel lock) write the stored copy and incumbent.json. Never touches the network.
 * -> {ok: true, incumbentPath, storedRequest, droppedLastRejected, ...} | {ok: false, reasons}. Throws LockedError while a tick runs.
 */
export function bootstrapIncumbent({ stateDir, request, submissionId, requestSha256, receipt, evidence, date, replace = false,
  clearRejection = false, pid = process.pid, isPidAlive = pidAlive, clock = () => new Date().toISOString() }) {
  const reasons = bootstrapRefusals({ request, submissionId, requestSha256, receipt, evidence, date });
  if (reasons.length) return { ok: false, reasons };
  const lock = acquireLock(stateDir, { pid, date, startedAt: clock(), isPidAlive });
  try {
    if (readPending(stateDir)) return { ok: false, reasons: ['pending_submission_exists: reconcile it with a tick first'] };
    const incumbentPath = join(stateDir, 'incumbent.json');
    const replaced = existsSync(incumbentPath);
    if (replaced && replace !== true) return { ok: false, reasons: ['incumbent_exists: pass --replace to replace it'] };
    // A recorded arena rejection (decide.mjs incumbentBodyNotRejected) is never dropped silently: the next tick could POST
    // the rejected body again. An unreadable record may hold one too.
    let cur;
    try { cur = replaced ? readJsonIfExists(incumbentPath) : null; } catch { cur = undefined; }
    const unreadable = replaced && !isObj(cur);
    const rejection = unreadable ? { unreadableIncumbent: true } : cur?.lastRejected ?? null;
    if (rejection !== null && clearRejection !== true) {
      return { ok: false, reasons: [unreadable ? 'incumbent_unreadable: it may record a rejection; pass --clear-rejection to replace it anyway'
        : `last_rejected_present:${String(rejection?.submissionId ?? 'unknown').slice(0, 128)}: the arena rejected a re-draw of the current incumbent; pass --clear-rejection to drop that record`] };
    }
    const storedRequest = storeRequest(stateDir, request, requestSha256); // first: the record never points at a missing copy
    const requestBodySha256 = requestBodyDigest(request);
    writeIncumbent(stateDir, { genome: null, submissionId, requestSha256, requestBodySha256, requestName: request.name, date,
      state: 'validated', storedRequest });
    const droppedLastRejected = rejection;
    openJournal({ stateDir, date, clock }).append('incumbent', 'bootstrapped', { submissionId, requestSha256, requestBodySha256,
      storedRequest: storedRequest.path, evidenceState: evidence.state, receiptState: receipt.state, replaced, droppedLastRejected });
    return { ok: true, incumbentPath, storedRequest, submissionId, requestSha256, requestBodySha256, date, replaced, droppedLastRejected };
  } finally {
    lock.release();
  }
}

const readJsonFile = path => { try { return { value: JSON.parse(readFileSync(path, 'utf8')) }; } catch (e) { return { error: e?.code ?? 'unparseable' }; } };
const USAGE = 'usage: bootstrap-incumbent.mjs --request REQUEST.json --submission-id ID --request-sha256 HEX --receipt RECEIPT.json '
  + '--validated-evidence STATUS.json --date YYYY-MM-DD [--state-dir DIR] [--replace [--clear-rejection]]\n';

async function main(argv, env = process.env) {
  let o;
  try {
    o = parseArgs({ args: argv, strict: true, options: { request: { type: 'string' }, 'submission-id': { type: 'string' },
      'request-sha256': { type: 'string' }, receipt: { type: 'string' }, 'validated-evidence': { type: 'string' }, date: { type: 'string' },
      'state-dir': { type: 'string' }, replace: { type: 'boolean' }, 'clear-rejection': { type: 'boolean' }, help: { type: 'boolean' } } }).values;
  } catch (e) { process.stderr.write(`bootstrap-incumbent: ${redact(e.message)}\n`); return 2; }
  if (o.help) { process.stdout.write(USAGE); return 0; }
  const need = ['request', 'submission-id', 'request-sha256', 'receipt', 'validated-evidence', 'date'].filter(k => !o[k]);
  if (need.length) { process.stderr.write(`bootstrap-incumbent: missing --${need.join(', --')}\n`); return 2; }
  const files = { request: readJsonFile(o.request), receipt: readJsonFile(o.receipt), evidence: readJsonFile(o['validated-evidence']) };
  const unreadable = Object.entries(files).filter(([, f]) => f.error).map(([k, f]) => `${k}_unreadable:${f.error}`);
  if (unreadable.length) { process.stderr.write(`${JSON.stringify({ ok: false, reasons: unreadable })}\n`); return 1; }
  const stateDir = resolve(o['state-dir'] ?? env.ARENA_FLYWHEEL_STATE_DIR ?? defaultStateDir(env));
  let r;
  try {
    r = bootstrapIncumbent({ stateDir, request: files.request.value, submissionId: o['submission-id'], requestSha256: o['request-sha256'],
      receipt: files.receipt.value, evidence: files.evidence.value, date: o.date, replace: o.replace === true, clearRejection: o['clear-rejection'] === true });
  } catch (e) {
    process.stderr.write(`bootstrap-incumbent: ${redact(e?.message ?? e)}\n`);
    return e instanceof LockedError ? 75 : 1;
  }
  (r.ok ? process.stdout : process.stderr).write(`${JSON.stringify(r)}\n`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
