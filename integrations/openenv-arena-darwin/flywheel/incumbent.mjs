// Incumbent state, pending-submission state, genome -> arena task mapping, and the cells-module wrapper that
// makes run-darwin.mjs start its search from the incumbent instead of lib/cells.mjs's v2 defaults.
//
//   <stateDir>/incumbent.json            written ONLY after a submission reaches state `validated`; a validated
//                                        re-draw (policy daily-best) moves only its submissionId/date (and stored
//                                        request), never the genome; a re-draw the arena REJECTED (author origin) adds
//                                        only `lastRejected`. `storedRequest` {path, sha256} names the immutable copy of
//                                        the exact validated request; `genome` is null for a body-only (bootstrapped)
//                                        incumbent, which a re-draw can still re-submit but no search can start from
//   <stateDir>/validated-requests/<sha256>.json  the exact POSTed bytes (canonical JSON), mode 0400, content-addressed,
//                                        of every request about to be POSTed (only a validated one is ever recorded);
//                                        the directory must be a real directory owned by this user, never a symlink
//   <stateDir>/pending-submission.json   written BEFORE the POST; reconciled by the next run, never re-POSTed
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync,
  unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalDigest, canonicalJson, sha256Hex, SHA256_RE } from './canonical-json.mjs';
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from './journal.mjs';

const fail = msg => { throw new Error(msg); };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasGenome = rec => rec?.genome !== null && rec?.genome !== undefined;

// Arena per-task limits (AGENTS.md table; same bounds as ENV submission.py LIMITS). min, max.
export const TASK_LIMITS = Object.freeze({
  reset_wall_s: [120, 300], rollout_wall_s: [1, 3600], verifier_wall_s: [1, 1800], tool_wall_s: [1, 120],
  tool_calls_total: [1, 1024], tool_calls_per_minute: [1, 60], completion_tokens: [1, 32768], context_tokens: [1, 32768],
  memory_gib: [1, 16], cpu_floor_vcpus: [1, 2], workspace_gib: [1, 44],
});
const CONFIG_LIMIT_KEYS = Object.keys(TASK_LIMITS).filter(k => k !== 'completion_tokens' && k !== 'context_tokens');

/** Explicit per-task limits from config (every non-token limit required, all in bounds). */
export function checkTaskLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) fail('taskLimits must be an object');
  for (const k of Object.keys(limits)) if (!CONFIG_LIMIT_KEYS.includes(k)) fail(`taskLimits.${k} is not a configurable limit`);
  for (const k of CONFIG_LIMIT_KEYS) {
    const v = limits[k], [lo, hi] = TASK_LIMITS[k];
    if (!Number.isSafeInteger(v) || v < lo || v > hi) fail(`taskLimits.${k}=${v} outside [${lo}, ${hi}]`);
  }
  if (limits.reset_wall_s + limits.rollout_wall_s + limits.verifier_wall_s > 3600) fail('taskLimits: reset+rollout+verifier > 3600 s');
  return limits;
}

/**
 * Genome -> submission tasks, in the cells contract's family order:
 *   task_id = "<family>-d<difficulty>", split train, completion_tokens = cell budget,
 *   context_tokens = the evaluator's context budget (provenance.contextTokens), other limits from config.
 * Cells with environment knobs are refused until lib/cells.mjs maps knobs to native task IDs.
 */
export function genomeToTasks(genome, { genomeToCells, contextTokens, taskLimits }) {
  checkTaskLimits(taskLimits);
  const [lo, hi] = TASK_LIMITS.context_tokens;
  if (!Number.isSafeInteger(contextTokens) || contextTokens < lo || contextTokens > hi) fail(`contextTokens ${contextTokens} out of range`);
  return genomeToCells(genome).map(c => {
    if (Object.keys(c.knobs ?? {}).length) fail(`knob cells are not mappable to task IDs yet (${c.family})`);
    if (!Number.isSafeInteger(c.budget) || c.budget < 1 || c.budget > TASK_LIMITS.completion_tokens[1]) fail(`budget ${c.budget} out of range`);
    return { task_id: `${c.family}-d${c.difficulty}`, split: 'train', ...taskLimits, completion_tokens: c.budget, context_tokens: contextTokens };
  });
}

/** Every expected task appears exactly once in the rendered request with every expected field unchanged. */
export function tasksMatch(requestTasks, expected) {
  if (!Array.isArray(requestTasks) || requestTasks.length !== expected.length) return false;
  const byId = new Map(requestTasks.map(t => [t?.task_id, t]));
  if (byId.size !== requestTasks.length) return false;
  return expected.every(e => {
    const t = byId.get(e.task_id);
    return t && Object.keys(e).every(k => canonicalJson(t[k] ?? null) === canonicalJson(e[k]));
  });
}

/** Deterministic, content-addressed submission ID: <prefix>-<date>[-<tag>]-<10 hex of {tasks,image}>. */
export function submissionIdFor({ prefix, date, tasks, image, tag = '' }) {
  const id = [prefix, date, tag, canonicalDigest({ tasks, image }).slice(0, 10)].filter(Boolean).join('-');
  if (!ID_RE.test(id)) fail(`invalid submission id: ${id}`);
  return id;
}

/** Incumbent for this run: the last validated submission, else (day 1) the cells contract's v2 defaults. A body-only
 *  incumbent (genome null, a stored validated request) has no genome: nothing can be searched from or promoted over it. */
export function loadIncumbent(stateDir, { baselineGenome, genomeToCells }) {
  const rec = readJsonIfExists(join(stateDir, 'incumbent.json'));
  if (!rec) {
    const genome = baselineGenome();
    return { day1: true, source: 'v2-defaults (lib/cells.mjs baselineGenome)', genome, genomeDigest: canonicalDigest(genome), submissionId: null };
  }
  if (!hasGenome(rec)) {
    if (!isObj(rec.storedRequest)) fail('incumbent_state_has_neither_genome_nor_stored_request');
    if (rec.genomeDigest !== null && rec.genomeDigest !== undefined) fail('incumbent_state_digest_mismatch');
    return { day1: false, source: 'validated-submission (stored request, no genome)', genome: null, genomeDigest: null,
      submissionId: rec.submissionId, requestSha256: rec.requestSha256, since: rec.date };
  }
  genomeToCells(rec.genome); // throws on a malformed stored genome: fail closed, never silently fall back
  if (rec.genomeDigest !== canonicalDigest(rec.genome)) fail('incumbent_state_digest_mismatch');
  return { day1: false, source: 'validated-submission', genome: rec.genome, genomeDigest: rec.genomeDigest,
    submissionId: rec.submissionId, requestSha256: rec.requestSha256, since: rec.date };
}

/** incumbent.json says the incumbent has no genome (a body-only record): no GPU search can start from it. */
export function genomeLessIncumbent(stateDir) {
  try { const rec = readJsonIfExists(join(stateDir, 'incumbent.json')); return isObj(rec) && !hasGenome(rec); } catch { return false; }
}

/** Digest of a request without its submission_id and name: equal bodies = the same submission drawn again. */
export function requestBodyDigest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
  const { submission_id: _id, name: _name, ...body } = request;
  return canonicalDigest(body);
}

// ---- the stored validated request: immutable, content-addressed, the exact bytes arena-api.mjs POSTs ----
export const STORED_REQUESTS_DIR = 'validated-requests';
export const STORED_REQUEST_MODE = 0o400;
const REDRAW_SUFFIX = ' (incumbent re-draw)';
/** The stored request's path relative to the state dir, derived from its digest alone (a recorded path is never trusted). */
export const storedRequestRelPath = sha256 => `${STORED_REQUESTS_DIR}/${sha256}.json`;
/** A re-draw's name: the stored name with ONE re-draw suffix (a re-drawn re-draw never accumulates suffixes). */
export function redrawName(name) {
  if (typeof name !== 'string') return null;
  let base = name;
  while (base.endsWith(REDRAW_SUFFIX)) base = base.slice(0, -REDRAW_SUFFIX.length);
  return `${base}${REDRAW_SUFFIX}`;
}

const ownedByMe = st => typeof process.getuid !== 'function' || st.uid === process.getuid();
/** The store directory itself: a real directory (a symlink out of the state dir is refused) owned by this user, or a problem. */
function storeDirProblem(stateDir) {
  let st;
  try { st = lstatSync(join(stateDir, STORED_REQUESTS_DIR)); } catch { return 'stored_request_missing'; }
  if (!st.isDirectory()) return 'stored_request_dir_not_a_real_directory';
  return ownedByMe(st) ? null : 'stored_request_dir_owner_changed';
}
/** The bytes of exactly the inode `st` describes: opened without following a symlink, checked by fstat. null otherwise. */
function readSameFile(path, st) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const f = fstatSync(fd);
    return f.isFile() && f.ino === st.ino && f.dev === st.dev ? readFileSync(fd) : null;
  } finally { closeSync(fd); }
}

/**
 * Re-reads a stored request and reports raw facts; never throws. fileOk: the file sits at the content-addressed path the
 * recorded digest implies, inside a real (not symlinked) store directory owned by this user, is a regular file (not a
 * symlink), mode exactly 0400 and owned by this user; its bytes are read through a no-follow descriptor of that same
 * inode. The digests (bytes and canonical JSON), the canonical-bytes property and the request's own id/name/body
 * digest/image are returned for the caller to compare with incumbent.json (decide.mjs storedRequestIntact). ok = fileOk
 * + both digests equal the recorded sha256 + canonical bytes. `problem` names the first defect, for reports.
 */
export function readStoredRequest(stateDir, stored) {
  const out = { ok: false, fileOk: false, problem: null, recordedSha256: null, fileSha256: null, canonicalSha256: null, canonical: false,
    request: null, submissionId: null, name: null, bodySha256: null, image: null };
  const bad = problem => { out.problem ??= problem; return out; };
  if (!isObj(stored) || typeof stored.sha256 !== 'string' || !SHA256_RE.test(stored.sha256)) return bad('stored_request_record_invalid');
  out.recordedSha256 = stored.sha256;
  const rel = storedRequestRelPath(stored.sha256);
  if (stored.path !== rel) return bad('stored_request_path_not_content_addressed');
  const dirProblem = storeDirProblem(stateDir);
  if (dirProblem) return bad(dirProblem);
  const path = join(stateDir, rel);
  let st;
  try { st = lstatSync(path); } catch { return bad('stored_request_missing'); }
  if (!st.isFile()) return bad('stored_request_not_a_regular_file');
  if ((st.mode & 0o7777) !== STORED_REQUEST_MODE) bad(`stored_request_perms_changed:${(st.mode & 0o7777).toString(8)}`);
  else if (!ownedByMe(st)) bad('stored_request_owner_changed');
  else out.fileOk = true;
  let bytes = null;
  try { bytes = readSameFile(path, st); } catch { bytes = null; }
  if (bytes === null) { out.fileOk = false; return bad('stored_request_unreadable'); }
  out.fileSha256 = sha256Hex(bytes);
  try { out.request = JSON.parse(bytes.toString('utf8')); } catch { return bad('stored_request_unparseable'); }
  if (!isObj(out.request)) return bad('stored_request_not_an_object');
  try { out.canonical = canonicalJson(out.request) === bytes.toString('utf8'); out.canonicalSha256 = canonicalDigest(out.request); } catch { return bad('stored_request_not_canonical_json'); }
  out.submissionId = typeof out.request.submission_id === 'string' ? out.request.submission_id : null;
  out.name = typeof out.request.name === 'string' ? out.request.name : null;
  out.image = typeof out.request.image === 'string' ? out.request.image : null;
  out.bodySha256 = requestBodyDigest(out.request);
  if (out.fileSha256 !== stored.sha256 || out.canonicalSha256 !== stored.sha256) bad('stored_request_digest_mismatch');
  if (!out.canonical) bad('stored_request_not_canonical');
  out.ok = out.fileOk && out.problem === null;
  return out;
}

/**
 * Store the exact request bytes (canonical JSON, no trailing newline: sha256 of the file = its request digest) under
 * <stateDir>/validated-requests/<sha256>.json, mode 0400. `expectSha256` must be its digest (the approved / receipt
 * digest). An existing file is never overwritten: it must already be that exact, intact copy. -> {path, sha256}
 */
export function storeRequest(stateDir, request, expectSha256) {
  if (!isObj(request)) fail('stored_request: request must be an object');
  const text = canonicalJson(request);
  const sha256 = sha256Hex(Buffer.from(text, 'utf8'));
  if (sha256 !== expectSha256) fail(`stored_request_digest_mismatch: the request hashes to ${sha256}, not ${expectSha256}`);
  const stored = { path: storedRequestRelPath(sha256), sha256 };
  const path = join(stateDir, stored.path);
  let exists = true;
  try { lstatSync(path); } catch { exists = false; }
  if (exists) {
    const v = readStoredRequest(stateDir, stored);
    if (!v.ok) fail(`stored_request_conflict: ${v.problem} (refusing to overwrite ${path})`);
    return stored;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const dirProblem = storeDirProblem(stateDir); // never write through a symlinked or foreign store directory
  if (dirProblem) fail(`stored_request_conflict: ${dirProblem} (refusing to write ${path})`);
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true }); // a crashed earlier write may have left a read-only tmp
  const fd = openSync(tmp, 'wx', STORED_REQUEST_MODE);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  const v = readStoredRequest(stateDir, stored);
  if (!v.ok) fail(`stored_request_write_unverified: ${v.problem}`);
  return stored;
}

/** A record's storedRequest must be an intact copy of exactly the validated request it names (else nothing is written). */
function checkStoredForRecord(stateDir, storedRequest, { submissionId, requestSha256, requestBodySha256, requestName }) {
  const v = readStoredRequest(stateDir, storedRequest);
  if (!v.ok) fail(`stored_request_unusable: ${v.problem}`);
  if (v.recordedSha256 !== requestSha256) fail('stored_request_is_not_the_validated_request: digest differs from requestSha256');
  if (v.submissionId !== submissionId || v.name !== requestName || v.bodySha256 !== requestBodySha256) {
    fail('stored_request_is_not_the_validated_request: submission_id, name or body differs from the record');
  }
  return { path: storedRequest.path, sha256: storedRequest.sha256 };
}

/** requestSha256 = canonical digest of the POSTed request; requestName = its `name`. With submissionId they rebuild
 *  those exact bytes from a re-rendered body, which is what binds a re-draw to what the arena validated. storedRequest
 *  (optional with a genome, required without one) = storeRequest()'s {path, sha256} of exactly those bytes: it is
 *  verified against the record before anything is written, so a record never points at a missing or foreign copy. */
export function writeIncumbent(stateDir, { genome = null, submissionId, requestSha256, requestBodySha256 = null, requestName = null, date, state,
  storedRequest = null }) {
  if (state !== 'validated') fail('incumbent may only be updated from a validated submission');
  if (genome === null && !storedRequest) fail('incumbent needs a genome or a stored validated request');
  const stored = storedRequest ? checkStoredForRecord(stateDir, storedRequest, { submissionId, requestSha256, requestBodySha256, requestName }) : null;
  return writeJsonAtomic(join(stateDir, 'incumbent.json'),
    { genome, genomeDigest: genome === null ? null : canonicalDigest(genome), submissionId, requestSha256, date, state, requestBodySha256, requestName,
      ...(stored ? { storedRequest: stored } : {}) });
}

/**
 * A validated incumbent RE-DRAW never replaces the incumbent genome (or its absence). It only moves the record's pointer
 * to the newest validated own submission (the board check compares exactly that) together with that submission's stored
 * request, keeping which submission set the incumbent in `genomeFrom`. Fails closed, writing nothing, unless the re-drawn
 * genome IS the validated incumbent's (both null for a body-only incumbent) and any stored request is an intact copy of
 * this re-draw with the incumbent's body. A body-only incumbent cannot be recorded without its stored request.
 */
export function recordRedraw(stateDir, { genome = null, submissionId, requestSha256, requestBodySha256 = null, requestName = null, date, state,
  storedRequest = null }) {
  if (state !== 'validated') fail('incumbent may only be updated from a validated submission');
  const cur = readJsonIfExists(join(stateDir, 'incumbent.json'));
  const sameGenome = cur && (hasGenome(cur)
    ? cur.genomeDigest === canonicalDigest(cur.genome) && genome !== null && canonicalDigest(genome) === cur.genomeDigest
    : genome === null && (cur.genomeDigest === null || cur.genomeDigest === undefined));
  if (!cur || cur.state !== 'validated' || !sameGenome) fail('redraw_genome_is_not_the_incumbent: a re-draw never replaces the incumbent genome');
  if (!hasGenome(cur) && !storedRequest) fail('redraw_without_stored_request: a body-only incumbent needs the re-draw\'s stored request');
  if (storedRequest && requestBodySha256 !== cur.requestBodySha256) fail('redraw_body_is_not_the_incumbent_body');
  const stored = storedRequest ? checkStoredForRecord(stateDir, storedRequest, { submissionId, requestSha256, requestBodySha256, requestName }) : null;
  return writeJsonAtomic(join(stateDir, 'incumbent.json'), { genome: hasGenome(cur) ? cur.genome : null, genomeDigest: hasGenome(cur) ? cur.genomeDigest : null,
    submissionId, requestSha256, date, state, requestBodySha256, requestName, lastKind: 'incumbent-redraw',
    genomeFrom: cur.genomeFrom ?? { submissionId: cur.submissionId, date: cur.date }, ...(stored ? { storedRequest: stored } : {}) });
}

/**
 * The arena REJECTED an incumbent re-draw (author origin; a platform-origin rejection returns the slot and is not
 * recorded). Adds `lastRejected` to incumbent.json and changes nothing else: decide.mjs incumbentBodyNotRejected then
 * blocks re-draws of that body until a promoted candidate is validated (writeIncumbent writes a fresh record) or a human
 * removes the field. -> the path written, or null when there is no incumbent.json (nothing to re-draw from).
 */
export function recordRedrawRejected(stateDir, { submissionId, date, errorOrigin = null, requestBodySha256 = null }) {
  const path = join(stateDir, 'incumbent.json');
  const cur = readJsonIfExists(path);
  if (!cur) return null;
  return writeJsonAtomic(path, { ...cur, lastRejected: { submissionId, date, errorOrigin, requestBodySha256 } });
}

const pendingPath = stateDir => join(stateDir, 'pending-submission.json');
export const readPending = stateDir => readJsonIfExists(pendingPath(stateDir));
export const writePending = (stateDir, rec) => writeJsonAtomic(pendingPath(stateDir), rec);
export function clearPending(stateDir) { if (existsSync(pendingPath(stateDir))) unlinkSync(pendingPath(stateDir)); }

/** A cells module = lib/cells.mjs with baselineGenome() returning `genome` (the local export wins over export *). */
export function writeCellsWrapper(path, genome, cellsUrl) {
  const text = `// Generated by the arena flywheel: lib/cells.mjs with the incumbent as Darwin's baseline.\n` +
    `export * from ${JSON.stringify(cellsUrl)};\n` +
    `const INCUMBENT = Object.freeze(${JSON.stringify(genome)});\n` +
    `export function baselineGenome() { return { ...INCUMBENT }; }\n`;
  return writeTextAtomic(path, text, 0o644);
}
