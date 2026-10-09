// Genome <-> calibration-cell mapping for Darwin evolution of the Arena environment knobs.
//
// A genome is a flat ADR-272 numeric vector. Every parameter is named "<family>.<param>":
//   "<family>.difficulty"  int 1..3            (task generator difficulty)
//   "<family>.budget"      int 6889..16384 log (per-episode Arena completion_tokens budget). The floor is
//                          8192/2^(1/4): with log scale and sigma 0.2 the one-param mutator then reaches exactly
//                          6889, 8192, 9742, 11585, 13777, 16384 (no near-duplicates). Below ~5.9k nearly every real
//                          v2 episode truncates (GRPO review finding 8), so those cells only burn GPU.
//   "<family>.<knob>"      future environment knobs (instance size, distractors, fault positions…)
// One family's params form one CELL = one runner invocation (one family x difficulty x budget x knobs).
import { createHash } from 'node:crypto';
import { canon } from '../../../packages/flywheel/src/receipts.ts';

export const FAMILIES = Object.freeze([
  'software_change', 'industrial_schedule', 'science_calibration', 'office_reconciliation',
  'finance_ledger', 'math_route', 'security_triage', 'media_timeline',
]);

export const DIFFICULTY_SPEC = Object.freeze({ min: 1, max: 3, scale: 'linear', type: 'int', default: 2 });
export const BUDGET_SPEC = Object.freeze({ min: 6889, max: 16384, scale: 'log', type: 'int', default: 8192 });

/**
 * TODO(env-knobs) hook. Knobs the runner can actually pass to the environment, as
 * name -> { spec: NumericParamSpec, flag: '--runner-flag' }. EMPTY TODAY: neither calibrate.py nor
 * tasks.make_task(family, seed, difficulty) exposes instance size / distractors / fault positions yet.
 * When the env grows a knob, add e.g.
 *   distractors: { spec: { min: 0, max: 8, scale: 'linear', type: 'int', default: 2 }, flag: '--distractors' }
 * Until then any "<family>.<knob>" param is rejected loudly (never silently dropped, which would
 * make two different genomes share one measurement and corrupt causal attribution).
 */
export const RUNNER_KNOBS = Object.freeze({});

const KNOB_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const CORE = new Set(['difficulty', 'budget']);
// serverSha = sha256(normalized base URL + the server's GET /v1/models identity); runnerArgsSha = sha256 of every fixed
// runner argument (max-total-tokens, tokenizer pin, max-steps, request timeout, max-tokens cap). Without them a ruvllm
// proxy and the A100 27B, or two runner settings, would share one cache key.
export const PROVENANCE_KEYS = Object.freeze(['envSourceSha', 'runnerSha', 'serverSha', 'runnerArgsSha', 'model', 'modelRevision',
  'contextTokens', 'seedBase', 'attempts']);

const fail = (msg) => { throw new Error(msg); };
const isInt = (v) => typeof v === 'number' && Number.isSafeInteger(v);

function checkFamilies(families) {
  if (!Array.isArray(families) || families.length === 0) fail('families must be a non-empty array');
  for (const f of families) if (!FAMILIES.includes(f)) fail(`unknown family "${f}"`);
  if (new Set(families).size !== families.length) fail('duplicate family');
  return families;
}

function knobEntry(name, runnerKnobs) {
  if (!KNOB_NAME.test(name)) fail(`invalid knob name "${name}"`);
  const entry = Object.hasOwn(runnerKnobs, name) ? runnerKnobs[name] : undefined;
  if (!entry) {
    fail(`unsupported knob "${name}": the environment/runner does not expose it yet ` +
      '(add it to RUNNER_KNOBS in lib/cells.mjs once calibrate.py/tasks.py accept it)');
  }
  return entry;
}

/** NumericGenomeSpec over the selected families (+ explicitly requested, runner-supported knobs). */
export function genomeSpec({ families = FAMILIES, knobs = [], runnerKnobs = RUNNER_KNOBS } = {}) {
  checkFamilies(families);
  const spec = {};
  for (const family of families) {
    spec[`${family}.difficulty`] = { ...DIFFICULTY_SPEC };
    spec[`${family}.budget`] = { ...BUDGET_SPEC };
    for (const knob of knobs) spec[`${family}.${knob}`] = { ...knobEntry(knob, runnerKnobs).spec };
  }
  return spec;
}

/** Hand-tuned v2 starting point: difficulty 2, budget 8192 for every family. */
export function baselineGenome({ families = FAMILIES } = {}) {
  checkFamilies(families);
  const genome = {};
  for (const family of families) {
    genome[`${family}.difficulty`] = DIFFICULTY_SPEC.default;
    genome[`${family}.budget`] = BUDGET_SPEC.default;
  }
  return genome;
}

function inBounds(name, value, spec) {
  if (spec.type === 'int' && !isInt(value)) fail(`param "${name}" must be an integer, got ${value}`);
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`param "${name}" must be a finite number`);
  if (value < spec.min || value > spec.max) fail(`param "${name}"=${value} outside [${spec.min}, ${spec.max}]`);
}

/**
 * Split a genome into per-family cells, sorted in FAMILIES order. Throws on anything malformed:
 * unknown family, missing difficulty/budget, non-integer or out-of-range values, unsupported knobs.
 */
export function genomeToCells(genome, { runnerKnobs = RUNNER_KNOBS } = {}) {
  if (!genome || typeof genome !== 'object' || Array.isArray(genome)) fail('genome must be an object');
  const byFamily = new Map();
  for (const [name, value] of Object.entries(genome)) {
    const dot = name.indexOf('.');
    if (dot <= 0) fail(`param "${name}" is not "<family>.<param>"`);
    const family = name.slice(0, dot);
    const param = name.slice(dot + 1);
    if (!FAMILIES.includes(family)) fail(`param "${name}" names unknown family "${family}"`);
    const cell = byFamily.get(family) ?? { family, knobs: {} };
    byFamily.set(family, cell);
    if (param === 'difficulty') { inBounds(name, value, DIFFICULTY_SPEC); cell.difficulty = value; }
    else if (param === 'budget') { inBounds(name, value, BUDGET_SPEC); cell.budget = value; }
    else { inBounds(name, value, knobEntry(param, runnerKnobs).spec); cell.knobs[param] = value; }
  }
  if (byFamily.size === 0) fail('genome has no parameters');
  const cells = [];
  for (const family of FAMILIES) {
    const cell = byFamily.get(family);
    if (!cell) continue;
    for (const p of CORE) if (cell[p] === undefined) fail(`family "${family}" is missing "${family}.${p}"`);
    cells.push({ family, difficulty: cell.difficulty, budget: cell.budget, knobs: cell.knobs });
  }
  return cells;
}

/** Runner argv fragment for a cell's knobs (empty today; see RUNNER_KNOBS). */
export function knobArgs(cell, { runnerKnobs = RUNNER_KNOBS } = {}) {
  const args = [];
  for (const name of Object.keys(cell.knobs ?? {}).sort()) {
    args.push(knobEntry(name, runnerKnobs).flag, String(cell.knobs[name]));
  }
  return args;
}

/** Validate provenance strictly: a key missing a field would silently collide across env/runner versions. */
export function checkProvenance(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) fail('provenance must be an object');
  const keys = Object.keys(p).sort();
  if (keys.join() !== [...PROVENANCE_KEYS].sort().join()) fail(`provenance must have exactly: ${PROVENANCE_KEYS.join(', ')}`);
  for (const k of ['envSourceSha', 'runnerSha', 'serverSha', 'runnerArgsSha']) if (!/^[a-f0-9]{64}$/.test(p[k])) fail(`provenance.${k} must be sha256 hex`);
  for (const k of ['model', 'modelRevision']) {
    if (typeof p[k] !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(p[k])) fail(`provenance.${k} invalid`);
  }
  if (!isInt(p.contextTokens) || p.contextTokens < 1 || p.contextTokens > 32768) fail('provenance.contextTokens invalid');
  if (!isInt(p.seedBase) || p.seedBase < 0) fail('provenance.seedBase invalid');
  if (!isInt(p.attempts) || p.attempts < 4 || p.attempts % 4 !== 0 || p.attempts > 64) {
    fail('provenance.attempts must be a multiple of 4 in 4..64 (the runner plays 4 attempts per call)');
  }
  return p;
}

/** Content address of one measured cell: sha256(canon({cell, provenance})). */
export function cellKey(cell, provenance) {
  checkProvenance(provenance);
  if (!cell || !FAMILIES.includes(cell.family)) fail('cellKey: invalid cell');
  inBounds('difficulty', cell.difficulty, DIFFICULTY_SPEC);
  inBounds('budget', cell.budget, BUDGET_SPEC);
  const canonical = { family: cell.family, difficulty: cell.difficulty, budget: cell.budget, knobs: { ...(cell.knobs ?? {}) } };
  return createHash('sha256').update(canon({ cell: canonical, provenance })).digest('hex');
}
