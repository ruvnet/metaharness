// Pure pre-submit rules (no I/O): the AGENTS.md per-task limits table, scorecard cells -> arena tasks,
// openenv-validate / replay / schema report checks, and the gate-receipt request-digest binding.
// Every function returns a list of reasons; an empty list is the only "pass". Nothing fills defaults.
import { canonicalDigest, canonicalJson, SHA256_RE } from './canonical-json.mjs';

/** [min, max] per task, from https://openenvarena-arena.hf.space/AGENTS.md ("Limits per task"). */
export const ARENA_TASK_LIMITS = Object.freeze({
  reset_wall_s: [120, 300], rollout_wall_s: [1, 3600], verifier_wall_s: [1, 1800], tool_wall_s: [1, 120],
  tool_calls_total: [1, 1024], tool_calls_per_minute: [1, 60], completion_tokens: [1, 32768],
  context_tokens: [1, 32768], memory_gib: [1, 16], cpu_floor_vcpus: [1, 2], workspace_gib: [1, 44],
});
export const WALL_SUM_MAX = 3600;
/** Budget fields the flywheel config must set explicitly (tokens come from the measured scorecard). */
export const CONFIG_TASK_FIELDS = Object.freeze(Object.keys(ARENA_TASK_LIMITS).filter(k => !k.endsWith('_tokens')));
export const IMAGE_DIGEST_RE = /^(?:ghcr\.io|docker\.io)\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATASET_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/; // owner/name, no revision
const NATIVE_TASK_RE = /^[a-z_]+-d[123](?:--[a-z_]+-[pm][1-9][0-9]*)?$/; // arena_env.tasks.format_task_id grammar
const REQUIRED = ['submission_id', 'name', 'image', 'dataset', 'schema', 'tasks', 'example_actions'];
const OPTIONAL = ['source', 'server_port', 'finish_action'];
const TASK_KEYS = new Set(['task_id', 'split', 'image', ...Object.keys(ARENA_TASK_LIMITS)]);
const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isReservedAction = a => !isPlain(a) || (Object.keys(a).length === 1 && (a.finish === true || a.finish === 1 || isPlain(a.action)));

export function sameCanonical(a, b) {
  try { return canonicalJson(a) === canonicalJson(b); } catch { return false; }
}

/** Independent JS re-check of the rendered request (guards against renderer drift). */
export function checkRequest(r, expect = {}) {
  if (!isPlain(r)) return ['request_not_object'];
  const reasons = [];
  const bad = m => reasons.push(m);
  for (const k of REQUIRED) if (!(k in r)) bad(`missing_field:${k}`);
  for (const k of Object.keys(r)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k)) bad(`unknown_field:${k}`);
  for (const [k, v] of Object.entries(expect)) if (v !== undefined && r[k] !== v) bad(`${k}_differs_from_expected`);
  if (!ID_RE.test(String(r.submission_id))) bad('submission_id_invalid');
  if (typeof r.name !== 'string' || r.name.length < 1 || r.name.length > 200) bad('name_invalid');
  if (typeof r.image !== 'string' || !IMAGE_DIGEST_RE.test(r.image)) bad('image_not_digest_pinned');
  if (typeof r.dataset !== 'string' || !DATASET_RE.test(r.dataset)) bad('dataset_invalid');
  const s = r.schema;
  if (!isPlain(s) || Object.keys(s).sort().join() !== 'action,observation' || !isPlain(s.action) || !isPlain(s.observation)) bad('schema_not_action_observation');
  const tasks = Array.isArray(r.tasks) ? r.tasks : [];
  if (!Array.isArray(r.tasks) || tasks.length < 1 || tasks.length > 50) bad('tasks_count_out_of_range');
  tasks.forEach((t, i) => {
    if (!isPlain(t)) return bad(`task_${i}:not_object`);
    for (const k of Object.keys(t)) if (!TASK_KEYS.has(k)) bad(`task_${i}:unknown_field:${k}`);
    if (typeof t.task_id !== 'string' || !ID_RE.test(t.task_id) || !NATIVE_TASK_RE.test(t.task_id)) bad(`task_${i}:task_id_invalid`);
    if (!['train', 'validation', 'test'].includes(t.split)) bad(`task_${i}:split_invalid`);
    if ('image' in t && !IMAGE_DIGEST_RE.test(String(t.image))) bad(`task_${i}:image_not_digest_pinned`);
    for (const [k, [lo, hi]] of Object.entries(ARENA_TASK_LIMITS))
      if (!Number.isInteger(t[k]) || t[k] < lo || t[k] > hi) bad(`task_${i}:${k}_out_of_range`);
    if (t.reset_wall_s + t.rollout_wall_s + t.verifier_wall_s > WALL_SUM_MAX) bad(`task_${i}:wall_sum_exceeds_${WALL_SUM_MAX}`);
  });
  const ids = tasks.map(t => t?.task_id);
  if (new Set(ids).size !== ids.length) bad('task_ids_not_unique');
  if (!tasks.some(t => t?.split === 'train')) bad('no_train_task');
  if (new Set([r.image, ...tasks.filter(t => t?.image).map(t => t.image)]).size > 50) bad('too_many_images');
  const actions = r.example_actions;
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 16) bad('example_actions_count_out_of_range');
  else if (actions.some(isReservedAction)) bad('example_action_reserved_or_not_object');
  if ('finish_action' in r && isReservedAction(r.finish_action)) bad('finish_action_reserved_or_not_object');
  if ('server_port' in r && (!Number.isInteger(r.server_port) || r.server_port < 1 || r.server_port > 65535 || r.server_port === 49983)) bad('server_port_invalid');
  if ('source' in r) {
    let u = null;
    try { u = new URL(r.source); } catch { /* reported below */ }
    if (!u || u.protocol !== 'https:' || u.username || u.password) bad('source_not_https');
  }
  try { canonicalJson(r); } catch { bad('request_not_canonical_json'); }
  return reasons;
}

/** Native task id for one Darwin cell: family-dN, plus at most one non-default knob (`--key-p1` / `--key-m2`). */
export function nativeTaskId({ family, difficulty, knobs = {} }) {
  if (typeof family !== 'string' || !/^[a-z_]+$/.test(family)) throw new Error('cell family invalid');
  if (![1, 2, 3].includes(difficulty)) throw new Error('cell difficulty must be 1, 2 or 3');
  const set = Object.entries(knobs ?? {}).filter(([, v]) => v !== 0);
  if (set.length > 1) throw new Error('a native task id carries at most one non-default knob');
  if (!set.length) return `${family}-d${difficulty}`;
  let [key, value] = set[0];
  if (key.startsWith(family + '.')) key = key.slice(family.length + 1);
  if (!/^[a-z_]+$/.test(key) || !Number.isInteger(value)) throw new Error('knob must be a lowercase name with an integer value');
  return `${family}-d${difficulty}--${key}-${value > 0 ? 'p' : 'm'}${Math.abs(value)}`;
}

/** Scorecard (fitness.mjs) cells -> fully explicit arena tasks. Tokens come from the measured run;
 *  every other budget must be given explicitly (config), never defaulted. */
export function tasksFromScorecard(card, taskLimits) {
  const cells = card?.raw?.cells;
  const ctx = card?.raw?.provenance?.contextTokens;
  if (!Array.isArray(cells) || cells.length < 1 || cells.length > 50) throw new Error('scorecard has no usable raw.cells');
  if (!Number.isInteger(ctx)) throw new Error('scorecard raw.provenance.contextTokens missing');
  if (!isPlain(taskLimits)) throw new Error('task limits object required');
  for (const k of Object.keys(taskLimits)) if (!CONFIG_TASK_FIELDS.includes(k)) throw new Error(`task limit ${k} is not configurable here`);
  for (const k of CONFIG_TASK_FIELDS) if (!Number.isInteger(taskLimits[k])) throw new Error(`task limit ${k} must be set explicitly`);
  return cells.map(c => {
    if (!Number.isInteger(c?.budget)) throw new Error('cell budget missing');
    return { task_id: nativeTaskId(c), split: 'train', completion_tokens: c.budget, context_tokens: ctx, ...taskLimits };
  });
}

export function checkValidateReport(report, exitCode) {
  const reasons = [];
  if (exitCode !== 0) reasons.push(`openenv_validate_exit:${exitCode}`);
  if (!isPlain(report)) return [...reasons, 'openenv_validate_report_missing'];
  if (report.passed !== true) reasons.push('openenv_validate_not_passed');
  const failed = report.summary?.failed_criteria;
  if (!Array.isArray(failed)) reasons.push('openenv_validate_summary_missing');
  else if (failed.length) reasons.push(`openenv_validate_failed_criteria:${failed.map(String).join(',').slice(0, 200)}`);
  return reasons;
}

/** Compare live /schema projected to {action, observation} with the request schema. Whether the arena
 *  compares the full object (live also has `state`) is unresolved; it is recorded, not guessed. */
export function checkSchema(live, requestSchema) {
  if (!isPlain(live) || !isPlain(live.action) || !isPlain(live.observation)) return { reasons: ['live_schema_incomplete'] };
  const reasons = sameCanonical({ action: live.action, observation: live.observation }, requestSchema) ? [] : ['schema_mismatch'];
  let liveSchemaSha256 = null;
  try { liveSchemaSha256 = canonicalDigest(live); } catch { /* floats in schema: digest left null */ }
  return { reasons, liveSchemaSha256, liveHasState: 'state' in live, comparison: 'projected:{action,observation}',
    unresolved: 'arena IMAGE_SCHEMA_MISMATCH may compare the full /schema including state' };
}

/** replay_native.py report: every request task, all four controls passed, examples terminal in [0,1]. */
export function checkReplayReport(report, request, { exampleActionsSha256 } = {}) {
  if (!isPlain(report)) return ['replay_report_missing'];
  const reasons = [];
  const ids = (request?.tasks ?? []).map(t => t.task_id);
  if (report.status !== 'passed') reasons.push(`replay_status:${String(report.status).slice(0, 32)}`);
  if (report.task_count !== ids.length) reasons.push('replay_task_count_mismatch');
  if (report.episodes_expected !== ids.length * 4 || report.episodes_passed !== ids.length * 4) reasons.push('replay_episodes_incomplete');
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  if (JSON.stringify(tasks.map(t => t?.task_id).sort()) !== JSON.stringify([...ids].sort())) reasons.push('replay_task_ids_differ_from_request');
  for (const t of tasks) {
    if (t?.status !== 'passed') reasons.push(`replay_task_failed:${t?.task_id}`);
    const ex = (Array.isArray(t?.episodes) ? t.episodes : []).find(e => e?.control === 'declared_examples');
    const inRange = typeof ex?.reward === 'number' && ex.reward >= 0 && ex.reward <= 1;
    if (!ex || ex.status !== 'passed' || ex.terminal !== true || !inRange) reasons.push(`replay_examples_not_terminal_in_range:${t?.task_id}`);
  }
  if (exampleActionsSha256 && report.source_sha256?.['example-actions.json'] !== exampleActionsSha256) reasons.push('replay_example_actions_source_differs');
  return reasons;
}

/** Policy (2)-last: the canonical request digest must equal the digest bound INTO the signed gate payload.
 *  gate.mjs v1 binds no request digest, so today this always fails closed with
 *  `gate_receipt_has_no_request_binding` until the Darwin lane adds payload.binding.requestSha256. */
export function checkGateBinding({ verifiedPromote, payload, requestSha256 }) {
  const reasons = [];
  if (typeof requestSha256 !== 'string' || !SHA256_RE.test(requestSha256)) reasons.push('request_sha256_invalid');
  if (verifiedPromote !== true) reasons.push('gate_not_verified_promote');
  if (!isPlain(payload)) return [...reasons, 'gate_payload_missing'];
  if (payload.promote !== true) reasons.push('gate_refused');
  const bound = payload.binding?.requestSha256;
  if (bound === undefined || bound === null) reasons.push('gate_receipt_has_no_request_binding');
  else if (bound !== requestSha256) reasons.push('gate_request_digest_mismatch');
  return reasons;
}
