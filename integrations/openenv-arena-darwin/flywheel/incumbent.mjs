// Incumbent state, pending-submission state, genome -> arena task mapping, and the cells-module wrapper that
// makes run-darwin.mjs start its search from the incumbent instead of lib/cells.mjs's v2 defaults.
//
//   <stateDir>/incumbent.json            written ONLY after a submission reaches state `validated`; a validated
//                                        re-draw (policy daily-best) moves only its submissionId/date, never the genome;
//                                        a re-draw the arena REJECTED (author origin) adds only `lastRejected`
//   <stateDir>/pending-submission.json   written BEFORE the POST; reconciled by the next run, never re-POSTed
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest, canonicalJson } from './canonical-json.mjs';
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from './journal.mjs';

const fail = msg => { throw new Error(msg); };
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

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

/** Incumbent for this run: the last validated submission, else (day 1) the cells contract's v2 defaults. */
export function loadIncumbent(stateDir, { baselineGenome, genomeToCells }) {
  const rec = readJsonIfExists(join(stateDir, 'incumbent.json'));
  if (!rec) {
    const genome = baselineGenome();
    return { day1: true, source: 'v2-defaults (lib/cells.mjs baselineGenome)', genome, genomeDigest: canonicalDigest(genome), submissionId: null };
  }
  genomeToCells(rec.genome); // throws on a malformed stored genome: fail closed, never silently fall back
  if (rec.genomeDigest !== canonicalDigest(rec.genome)) fail('incumbent_state_digest_mismatch');
  return { day1: false, source: 'validated-submission', genome: rec.genome, genomeDigest: rec.genomeDigest,
    submissionId: rec.submissionId, requestSha256: rec.requestSha256, since: rec.date };
}

/** Digest of a request without its submission_id and name: equal bodies = the same submission drawn again. */
export function requestBodyDigest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('request must be an object');
  const { submission_id: _id, name: _name, ...body } = request;
  return canonicalDigest(body);
}

/** requestSha256 = canonical digest of the POSTed request; requestName = its `name`. With submissionId they rebuild
 *  those exact bytes from a re-rendered body, which is what binds a re-draw to what the arena validated. */
export function writeIncumbent(stateDir, { genome, submissionId, requestSha256, requestBodySha256 = null, requestName = null, date, state }) {
  if (state !== 'validated') fail('incumbent may only be updated from a validated submission');
  return writeJsonAtomic(join(stateDir, 'incumbent.json'),
    { genome, genomeDigest: canonicalDigest(genome), submissionId, requestSha256, date, state, requestBodySha256, requestName });
}

/**
 * A validated incumbent RE-DRAW never replaces the incumbent genome. It only moves the record's pointer to the newest
 * validated own submission (the board check compares exactly that), keeping which submission set the genome in
 * `genomeFrom`. Fails closed, writing nothing, unless the re-drawn genome IS the validated incumbent's.
 */
export function recordRedraw(stateDir, { genome, submissionId, requestSha256, requestBodySha256 = null, requestName = null, date, state }) {
  if (state !== 'validated') fail('incumbent may only be updated from a validated submission');
  const cur = readJsonIfExists(join(stateDir, 'incumbent.json'));
  if (!cur || cur.state !== 'validated' || cur.genomeDigest !== canonicalDigest(cur.genome) || canonicalDigest(genome) !== cur.genomeDigest) {
    fail('redraw_genome_is_not_the_incumbent: a re-draw never replaces the incumbent genome');
  }
  return writeJsonAtomic(join(stateDir, 'incumbent.json'), { genome: cur.genome, genomeDigest: cur.genomeDigest, submissionId,
    requestSha256, date, state, requestBodySha256, requestName, lastKind: 'incumbent-redraw',
    genomeFrom: cur.genomeFrom ?? { submissionId: cur.submissionId, date: cur.date } });
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
