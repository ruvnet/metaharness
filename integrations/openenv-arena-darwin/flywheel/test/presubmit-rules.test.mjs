// Run: node --test integrations/openenv-arena-darwin/flywheel/test/presubmit-rules.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARENA_TASK_LIMITS, checkGateBinding, checkReplayReport, checkRequest, checkSchema, checkValidateReport,
  nativeTaskId, tasksFromScorecard } from '../presubmit-rules.mjs';

const ENV_DIR = '/home/ruvultra/projects/metaharness-arena-knobs/integrations/openenv-arena';
const LIVE = existsSync(ENV_DIR) ? JSON.parse(readFileSync(join(ENV_DIR, 'evidence/schema.json'), 'utf8'))
  : { action: { type: 'object' }, observation: { type: 'object' }, state: {} };
const LIMITS = { reset_wall_s: 180, rollout_wall_s: 1800, verifier_wall_s: 120, tool_wall_s: 120, tool_calls_total: 16,
  tool_calls_per_minute: 60, memory_gib: 2, cpu_floor_vcpus: 1, workspace_gib: 10 };
const task = (task_id, o = {}) => ({ task_id, split: 'train', completion_tokens: 8192, context_tokens: 16384, ...LIMITS, ...o });
const IMAGE = 'ghcr.io/ruvnet/metaharness-arena@sha256:' + '2'.repeat(64);
const REQ = { submission_id: 'flywheel-2026-10-09', name: 'MetaHarness', image: IMAGE, dataset: 'ruv/metaharness-arena-tasks',
  schema: { action: LIVE.action, observation: LIVE.observation }, tasks: [task('software_change-d2'), task('science_calibration-d1--sample_count_delta-m1')],
  example_actions: [{ op: 'read', path: '*' }, { op: 'submit', answer: {} }], finish_action: { op: 'submit', answer: {} } };
const with_ = (patch) => ({ ...structuredClone(REQ), ...patch });
const withTask = (o) => with_({ tasks: [task('software_change-d2', o)] });

test('a fully explicit request within every AGENTS.md limit passes; expectations are enforced', () => {
  assert.deepEqual(checkRequest(REQ, { image: IMAGE, dataset: REQ.dataset }), []);
  assert.deepEqual(checkRequest(REQ, { image: IMAGE.replace('2222', '3333') }), ['image_differs_from_expected']);
});

test('each contract violation is named', () => {
  const cases = [
    [with_({ dataset: undefined }), 'dataset_invalid'],
    [with_({ extra: 1 }), 'unknown_field:extra'],
    [with_({ image: 'ghcr.io/ruvnet/metaharness-arena:latest' }), 'image_not_digest_pinned'],
    [with_({ image: 'quay.io/x/y@sha256:' + 'a'.repeat(64) }), 'image_not_digest_pinned'],
    [with_({ dataset: 'ruv/metaharness-arena-tasks@c359366' }), 'dataset_invalid'],
    [with_({ schema: LIVE }), 'schema_not_action_observation'],
    [withTask({ reset_wall_s: 100 }), 'task_0:reset_wall_s_out_of_range'],
    [withTask({ rollout_wall_s: 3400, reset_wall_s: 180, verifier_wall_s: 120 }), 'task_0:wall_sum_exceeds_3600'],
    [withTask({ completion_tokens: 40000 }), 'task_0:completion_tokens_out_of_range'],
    [withTask({ tool_wall_s: 121 }), 'task_0:tool_wall_s_out_of_range'],
    [withTask({ memory_gib: 17 }), 'task_0:memory_gib_out_of_range'],
    [withTask({ cpu_floor_vcpus: 3 }), 'task_0:cpu_floor_vcpus_out_of_range'],
    [withTask({ workspace_gib: 45 }), 'task_0:workspace_gib_out_of_range'],
    [withTask({ tool_calls_total: 1025 }), 'task_0:tool_calls_total_out_of_range'],
    [withTask({ tool_calls_per_minute: 61 }), 'task_0:tool_calls_per_minute_out_of_range'],
    [withTask({ completion_tokens: 8192.5 }), 'task_0:completion_tokens_out_of_range'],
    [withTask({ split: 'eval' }), 'task_0:split_invalid'],
    [withTask({ task_id: 'software_change' }), 'task_0:task_id_invalid'],
    [withTask({ task_id: 'software_change-d4' }), 'task_0:task_id_invalid'],
    [withTask({ verbose: true }), 'task_0:unknown_field:verbose'],
    [with_({ tasks: [] }), 'tasks_count_out_of_range'],
    [with_({ tasks: Array.from({ length: 51 }, (_, i) => task(`software_change-d${1 + (i % 3)}`)) }), 'tasks_count_out_of_range'],
    [with_({ tasks: [task('software_change-d2'), task('software_change-d2')] }), 'task_ids_not_unique'],
    [with_({ tasks: [task('software_change-d2', { split: 'test' })] }), 'no_train_task'],
    [with_({ example_actions: [{ finish: true }] }), 'example_action_reserved_or_not_object'],
    [with_({ example_actions: [{ action: { op: 'read' } }] }), 'example_action_reserved_or_not_object'],
    [with_({ example_actions: Array(17).fill({ op: 'read', path: '*' }) }), 'example_actions_count_out_of_range'],
    [with_({ finish_action: { finish: true } }), 'finish_action_reserved_or_not_object'],
    [with_({ server_port: 49983 }), 'server_port_invalid'],
    [with_({ source: 'http://github.com/ruvnet/metaharness' }), 'source_not_https'],
    [with_({ name: '' }), 'name_invalid'],
    [with_({ submission_id: 'bad id' }), 'submission_id_invalid'],
  ];
  for (const [req, reason] of cases) assert.ok(checkRequest(req).includes(reason), `${reason} not reported: ${checkRequest(req)}`);
  const missingLimit = withTask({});
  delete missingLimit.tasks[0].verifier_wall_s;
  assert.ok(checkRequest(missingLimit).includes('task_0:verifier_wall_s_out_of_range'), 'missing limits are never defaulted');
  assert.equal(Object.keys(ARENA_TASK_LIMITS).length, 11);
});

test('scorecard cells -> native task ids with measured tokens and explicit config budgets', () => {
  const card = { raw: { provenance: { contextTokens: 16384 }, cells: [
    { family: 'software_change', difficulty: 2, budget: 8192, knobs: {} },
    { family: 'science_calibration', difficulty: 1, budget: 4096, knobs: { 'science_calibration.sample_count_delta': -1 } },
    { family: 'software_change', difficulty: 3, budget: 16384, knobs: { suite_count_delta: 2, other: 0 } }] } };
  const tasks = tasksFromScorecard(card, LIMITS);
  assert.deepEqual(tasks.map(t => t.task_id), ['software_change-d2', 'science_calibration-d1--sample_count_delta-m1', 'software_change-d3--suite_count_delta-p2']);
  assert.deepEqual(tasks.map(t => [t.completion_tokens, t.context_tokens, t.split]), [[8192, 16384, 'train'], [4096, 16384, 'train'], [16384, 16384, 'train']]);
  assert.deepEqual(checkRequest(with_({ tasks })), []);
  const { workspace_gib, ...missing } = LIMITS;
  assert.throws(() => tasksFromScorecard(card, missing), /workspace_gib must be set explicitly/);
  assert.throws(() => tasksFromScorecard(card, { ...LIMITS, completion_tokens: 1 }), /not configurable/);
  assert.throws(() => nativeTaskId({ family: 'software_change', difficulty: 2, knobs: { a: 1, b: 1 } }), /at most one/);
  assert.throws(() => tasksFromScorecard({ raw: { cells: card.raw.cells } }, LIMITS), /contextTokens/);
});

test('schema check projects live {action, observation, state} and records the unresolved scope', () => {
  const ok = checkSchema(LIVE, REQ.schema);
  assert.deepEqual(ok.reasons, []);
  assert.equal(ok.liveHasState, 'state' in LIVE);
  assert.match(ok.liveSchemaSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(checkSchema({ ...LIVE, observation: { type: 'object' } }, REQ.schema).reasons, ['schema_mismatch']);
  assert.deepEqual(checkSchema(null, REQ.schema).reasons, ['live_schema_incomplete']);
});

test('openenv validate: exit code AND report must both pass', () => {
  const pass = { passed: true, summary: { failed_criteria: [] } };
  assert.deepEqual(checkValidateReport(pass, 0), []);
  assert.deepEqual(checkValidateReport(pass, 1), ['openenv_validate_exit:1']);
  assert.deepEqual(checkValidateReport({ passed: false, summary: { failed_criteria: ['mcp_endpoint'] } }, 0),
    ['openenv_validate_not_passed', 'openenv_validate_failed_criteria:mcp_endpoint']);
  assert.deepEqual(checkValidateReport(null, 0), ['openenv_validate_report_missing']);
});

test('replay report: examples must end done with reward in [0,1] for EVERY request task', () => {
  const ep = (c, o = {}) => ({ control: c, status: 'passed', terminal: true, reward: 0, ...o });
  const t = (id, o) => ({ task_id: id, status: 'passed', episodes: [ep('declared_examples', o), ep('observed_file_oracle', { reward: 1 })] });
  const rep = tasks => ({ status: 'passed', task_count: 2, episodes_expected: 8, episodes_passed: 8, tasks, source_sha256: { 'example-actions.json': 'e' } });
  assert.deepEqual(checkReplayReport(rep([t('software_change-d2'), t('science_calibration-d1--sample_count_delta-m1')]), REQ, { exampleActionsSha256: 'e' }), []);
  assert.ok(checkReplayReport(rep([t('software_change-d2'), t('science_calibration-d1--sample_count_delta-m1', { reward: 1.5 })]), REQ)
    .includes('replay_examples_not_terminal_in_range:science_calibration-d1--sample_count_delta-m1'));
  assert.ok(checkReplayReport(rep([t('software_change-d2'), t('science_calibration-d1--sample_count_delta-m1', { terminal: false })]), REQ).length > 0);
  assert.ok(checkReplayReport(rep([t('software_change-d2'), t('software_change-d3')]), REQ).includes('replay_task_ids_differ_from_request'));
  assert.ok(checkReplayReport(rep([t('software_change-d2'), t('science_calibration-d1--sample_count_delta-m1')]), REQ, { exampleActionsSha256: 'x' })
    .includes('replay_example_actions_source_differs'));
});

test('gate binding: today\'s v1 gate payload (no binding) fails closed; a bound, equal digest passes', () => {
  const sha = 'a'.repeat(64);
  const v1 = { kind: 'openenv_arena_darwin_submission_gate', version: 1, promote: true };
  assert.deepEqual(checkGateBinding({ verifiedPromote: true, payload: v1, requestSha256: sha }), ['gate_receipt_has_no_request_binding']);
  assert.deepEqual(checkGateBinding({ verifiedPromote: true, payload: { ...v1, binding: { requestSha256: sha } }, requestSha256: sha }), []);
  assert.deepEqual(checkGateBinding({ verifiedPromote: true, payload: { ...v1, binding: { requestSha256: 'b'.repeat(64) } }, requestSha256: sha }), ['gate_request_digest_mismatch']);
  assert.deepEqual(checkGateBinding({ verifiedPromote: false, payload: { ...v1, promote: false, binding: { requestSha256: sha } }, requestSha256: sha }),
    ['gate_not_verified_promote', 'gate_refused']);
});
