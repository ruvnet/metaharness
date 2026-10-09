// Run: node --test integrations/openenv-arena-darwin/flywheel/test/render-and-check.test.mjs
// render-and-check with a fake docker CLI. The happy path runs the REAL env lane server from source
// (standing in for the container), the REAL `openenv validate`, REAL submission.py and REAL replay_native.py.
// Failure paths use a minimal fake env server plus fake openenv / replay tools.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest } from '../canonical-json.mjs';
import { renderAndCheck, toDecisionFacts } from '../render-and-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKES = join(HERE, 'arena-fakes');
const ENV_DIR = '/home/ruvultra/projects/metaharness-arena-knobs/integrations/openenv-arena';
// The arena-pinned OpenEnv venv (OpenEnv 86a180ed + websockets 17.2): $ARENA_VENV_BIN, else the repo-local venv, else the
// env lane's non-persistent /tmp/arena383venv. Tests that need its python skip when none exists.
const VENV = [process.env.ARENA_VENV_BIN, resolve(HERE, '../../../../packages/openenv-arena/.venv/bin'), '/tmp/arena383venv/bin']
  .find(d => d && existsSync(join(d, 'python')) && existsSync(join(d, 'openenv'))) ?? resolve(HERE, '../../../../packages/openenv-arena/.venv/bin');
const HAVE_PY = existsSync(join(VENV, 'python'));
const HAVE_REAL = existsSync(ENV_DIR) && HAVE_PY && existsSync(join(VENV, 'openenv'));
const IMAGE = 'ghcr.io/ruvnet/metaharness-arena@sha256:2f3f12b986574ac99ecae451f47408ea5c8cc12c4fa27bf1c5cafa6880676b37';
const NOW = Date.parse('2026-10-09T12:00:00Z');
const LIMITS = { reset_wall_s: 180, rollout_wall_s: 1800, verifier_wall_s: 120, tool_wall_s: 120, tool_calls_total: 16,
  tool_calls_per_minute: 60, memory_gib: 2, cpu_floor_vcpus: 1, workspace_gib: 10 };
const task = (task_id, budget = 8192) => ({ task_id, split: 'train', completion_tokens: budget, context_tokens: 16384, ...LIMITS });
const TASKS = [task('software_change-d2'), task('science_calibration-d1--sample_count_delta-m1', 4096), task('software_change-d3--suite_count_delta-p2', 16384)];
const FAKE_TOOL = [process.execPath, join(FAKES, 'fake-tool.mjs')];
const states = [];

function harness(mode, { toolMode = '', ...extra } = {}) {
  const state = mkdtempSync(join(tmpdir(), 'render-check-test-'));
  states.push(state);
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_DOCKER_DIR: state, FAKE_DOCKER_MODE: mode, FAKE_ENV_DIR: ENV_DIR,
    FAKE_ENV_PYTHON: join(VENV, 'python'), FAKE_TOOL_MODE: toolMode, HF_TOKEN: 'hf_mustNeverReachAChildProcess', VAST_API_KEY: 'nope' };
  const opts = { outDir: join(state, 'out'), submissionId: 'flywheel-test-1', name: 'MetaHarness flywheel test', image: IMAGE,
    dataset: 'ruv/metaharness-arena-tasks', tasks: TASKS, envDir: ENV_DIR, python: join(VENV, 'python'), openenv: join(VENV, 'openenv'),
    docker: [process.execPath, join(FAKES, 'fake-docker.mjs')], nowMs: NOW, baseEnv, healthTimeoutS: 30, runId: `t${states.length}`, ...extra };
  const calls = () => (existsSync(join(state, 'calls.jsonl')) ? readFileSync(join(state, 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []);
  const live = () => readdirSync(join(state, 'containers')).filter(f => f.endsWith('.json'));
  return { state, opts, calls, live };
}

afterEach(() => { // safety net: never leave a fake container's server running
  for (const s of states.splice(0)) {
    const dir = join(s, 'containers');
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      const { pid } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  }
});

const gitState = () => spawnSync('git', ['-C', ENV_DIR, 'status', '--porcelain', '--ignored'], { encoding: 'utf8' }).stdout;

test('happy path: real server, real openenv validate, real submission.py render, real replay of every task id', { skip: !HAVE_REAL, timeout: 180_000 }, async () => {
  const h = harness('real-env', { expectEnvCommit: spawnSync('git', ['-C', ENV_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() });
  const before = gitState();
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  const py = spawnSync(join(VENV, 'python'), ['-c', 'import sys,json; sys.path.insert(0, sys.argv[1]); import submission; print(submission.digest(json.load(open(sys.argv[2]))))', ENV_DIR, r.request_path],
    { encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(py.stdout.trim(), r.request_sha256);
  const req = JSON.parse(readFileSync(r.request_path, 'utf8'));
  assert.deepEqual(req.tasks, TASKS);
  assert.deepEqual(Object.keys(req.schema).sort(), ['action', 'observation']);
  assert.deepEqual([r.checks.replay.episodesPassed, r.checks.replay.episodesExpected], [12, 12]);
  assert.deepEqual(r.checks.replay.taskIds.sort(), TASKS.map(t => t.task_id).sort());
  assert.equal(r.checks.schema.liveHasState, true);
  assert.equal(r.container.stopped, true);
  assert.deepEqual(h.live(), []);
  const calls = h.calls();
  const anon = join(h.opts.outDir, 'docker-config-anon');
  assert.ok(calls.every(c => c.dockerConfig === anon && c.dockerConfigEntries.length === 0), 'every docker call used the empty config');
  assert.ok(calls.every(c => c.secretEnv.length === 0), 'no HF_TOKEN / API key reached docker');
  const pull = calls.find(c => c.argv[0] === 'pull');
  assert.deepEqual(pull.argv, ['pull', '--platform', 'linux/amd64', IMAGE]);
  const run = calls.find(c => c.argv[0] === 'run').argv;
  for (const [f, v] of [['--pull', 'never'], ['-p', '127.0.0.1::8000'], ['--cpus', '2'], ['--memory', '16g'], ['--platform', 'linux/amd64']]) assert.equal(run[run.indexOf(f) + 1], v);
  assert.equal(run.at(-1), IMAGE);
  assert.ok(calls.findIndex(c => c.argv[0] === 'pull') < calls.findIndex(c => c.argv[0] === 'run'));
  assert.ok(!existsSync(join(h.opts.outDir, 'recheck-receipt.json')));
  assert.equal(gitState(), before, 'the env lane worktree was not touched (not even __pycache__)');
  const facts = toDecisionFacts(r);
  assert.deepEqual([facts.requestSha256, facts.image], [r.request_sha256, IMAGE]);
  assert.ok(['anonymousPull', 'openenvValidate', 'schemaEqual', 'limits', 'exampleReplay'].every(k => facts.checks[k].ok === true));
  const disk = JSON.parse(readFileSync(r.report_path, 'utf8'));
  assert.equal(disk.ok, true);
  // adv 3: the env source INSIDE the container under test, hashed like lib/provenance.mjs (tasks.py ‖ environment.py)
  const want = createHash('sha256').update(readFileSync(join(ENV_DIR, 'arena_env', 'tasks.py')))
    .update(readFileSync(join(ENV_DIR, 'arena_env', 'environment.py'))).digest('hex');
  assert.equal(r.checks.env_source.envSourceSha, want);
  assert.equal(facts.envSourceSha, want);
  assert.deepEqual([facts.envCommit, facts.envDirty], [h.opts.expectEnvCommit, false]);
  const cps = calls.filter(c => c.argv[0] === 'cp').map(c => c.argv[1]);
  assert.deepEqual(cps, ['arena-flywheel-check-t1:/app/arena_env/tasks.py', 'arena-flywheel-check-t1:/app/arena_env/environment.py']);
});

// Verbatim mode: a STORED, arena-validated request (here mix8-shaped: math_route at d2 AND d3, custom budgets) re-drawn
// under a fresh id is checked exactly as stored. submission.py never runs; every other check runs on the request's own
// image, tasks, schema and actions, which must still match the env lane and the live image (refused, never adjusted).
const MIX8_TASKS = ['finance_ledger-d3', 'math_route-d3', 'math_route-d2', 'science_calibration-d2'].map(task_id => ({ task_id, split: 'train',
  completion_tokens: 12288, context_tokens: 16384, cpu_floor_vcpus: 1, memory_gib: 2, reset_wall_s: 120, rollout_wall_s: 1200,
  tool_calls_per_minute: 60, tool_calls_total: 8, tool_wall_s: 20, verifier_wall_s: 30, workspace_gib: 2 }));
function storedRequest(over = {}) {
  const live = JSON.parse(readFileSync(join(ENV_DIR, 'evidence', 'schema.json'), 'utf8'));
  return { submission_id: 'metaharness-darwin-2026-10-10-redraw-0123456789', name: 'MetaHarness Procedural Reasoning (mixed-signal cells) (incumbent re-draw)',
    image: IMAGE, dataset: 'ruv/metaharness-arena-tasks', source: 'https://github.com/ruvnet/metaharness/pull/383',
    schema: { action: live.action, observation: live.observation }, tasks: MIX8_TASKS,
    example_actions: JSON.parse(readFileSync(join(ENV_DIR, 'example-actions.json'), 'utf8')),
    finish_action: JSON.parse(readFileSync(join(ENV_DIR, 'finish-action.json'), 'utf8')), ...over };
}
const verbatimOpts = (request, extra = {}) => ({ request, submissionId: request.submission_id, name: request.name, image: request.image,
  dataset: request.dataset, tasks: request.tasks, ...extra });

test('verbatim: a stored request is checked exactly as stored (no submission.py); every other check runs on it', async () => {
  const request = storedRequest();
  const h = harness('ok', verbatimOpts(request, { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL, python: '/nonexistent/python' }));
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  assert.equal(r.checks.render.verbatim, true);
  assert.equal(r.request_sha256, canonicalDigest(request), 'canonical digest of the stored body');
  assert.deepEqual(JSON.parse(readFileSync(r.request_path, 'utf8')), request);
  assert.ok(!existsSync(join(h.opts.outDir, 'tasks.json')), 'the env lane renderer never ran');
  assert.deepEqual(r.checks.replay.taskIds.sort(), MIX8_TASKS.map(t => t.task_id).sort(), 'every task id replayed, both math_route difficulties');
  for (const k of ['pull', 'inspect', 'env_source', 'limits', 'actions', 'openenv_validate', 'schema', 'replay']) assert.equal(r.checks[k].ok, true, k);
  assert.equal(r.container.stopped, true);
  const facts = toDecisionFacts(r);
  assert.deepEqual([facts.requestSha256, facts.image], [r.request_sha256, IMAGE]);
});

test('verbatim: a stored request the env lane or live image no longer matches is refused, never adjusted', async () => {
  const cases = [
    [{ example_actions: [{ op: 'read', path: 'other' }] }, 'example_actions_differ_from_replayed_file'],
    [{ finish_action: { op: 'finish-differently' } }, 'finish_action_differs_from_env_file'],
    [{ schema: { action: { type: 'object' }, observation: { type: 'object' } } }, 'schema_mismatch'],
    [{ tasks: [{ ...MIX8_TASKS[0], rollout_wall_s: 99999 }] }, 'task_0:rollout_wall_s_out_of_range'],
  ];
  for (const [over, reason] of cases) {
    const request = storedRequest(over);
    const h = harness('ok', verbatimOpts(request, { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL }));
    const r = await renderAndCheck(h.opts);
    assert.equal(r.ok, false, reason);
    assert.ok(r.reasons.includes(reason), `${reason}: ${r.reasons}`);
    assert.deepEqual(JSON.parse(readFileSync(r.request_path, 'utf8')), request, 'the stored bytes, unchanged');
    assert.equal(r.container.stopped, true);
  }
});

test('verbatim, real env: the mix8-shaped stored request passes real openenv validate and a real replay of every task id', { skip: !HAVE_REAL, timeout: 180_000 }, async () => {
  const request = storedRequest();
  const h = harness('real-env', verbatimOpts(request));
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.ok, true);
  assert.equal(r.checks.render.verbatim, true);
  assert.deepEqual([r.checks.replay.episodesPassed, r.checks.replay.episodesExpected], [MIX8_TASKS.length * 4, MIX8_TASKS.length * 4]);
  assert.deepEqual(r.checks.replay.taskIds.sort(), MIX8_TASKS.map(t => t.task_id).sort());
});

test('adv 3: an image whose env source cannot be read fails closed before render; the container is stopped', async () => {
  const h = harness('cp-fail');
  const r = await renderAndCheck(h.opts);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /^image_env_source_unreadable:tasks\.py:/);
  assert.equal(r.checks.render, undefined, 'nothing rendered');
  assert.equal(r.container.stopped, true);
  assert.equal(toDecisionFacts(r).envSourceSha, null);
});

test('adv 5: env-lane tools run with an empty HOME/HF_HOME, the hub offline, no token path; `submit` is never invoked', { skip: !HAVE_PY }, async () => {
  const h = harness('ok', { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL, toolMode: 'validate-fail' });
  h.opts.baseEnv.HF_TOKEN_PATH = join(h.state, 'would-be-token');
  h.opts.baseEnv.HF_HOME = join(h.state, 'real-hf-home');
  const r = await renderAndCheck(h.opts);
  const seen = JSON.parse(readFileSync(join(h.state, 'tool-env-validate.json'), 'utf8'));
  const sandbox = join(h.opts.outDir, 'tool-home');
  assert.deepEqual(seen, { HOME: sandbox, HF_HOME: join(sandbox, 'hf'), XDG_CACHE_HOME: join(sandbox, 'cache'), HF_HUB_OFFLINE: '1', secretShaped: [] });
  assert.deepEqual(readdirSync(join(sandbox, 'hf')), [], 'nothing (no token) in the HF home the tools see');
  assert.equal(r.container.stopped, true);
  const src = readFileSync(resolve(HERE, '../render-and-check.mjs'), 'utf8');
  assert.ok(!/'submit'/.test(src), 'the env lane submission.py submit path (which can POST) is never called');
});

test('anonymous pull failure: nothing runs, nothing to stop', async () => {
  const h = harness('pull-fail');
  const r = await renderAndCheck(h.opts);
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /^anonymous_pull_failed:.*denied/);
  assert.equal(h.calls().filter(c => c.argv[0] === 'run').length, 0);
  assert.equal(r.container, null);
});

test('non-amd64 image is refused before it runs', async () => {
  const h = harness('arm64');
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, ['platform_unsupported:linux/arm64']);
  assert.equal(h.calls().filter(c => c.argv[0] === 'run').length, 0);
});

test('no /health within the deadline: fails and the container is stopped', async () => {
  const h = harness('no-health', { healthTimeoutS: 2 });
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, ['health_not_ready_within_2s']);
  assert.equal(r.container.stopped, true);
  assert.deepEqual(h.live(), []);
});

test('a container that dies before /health fails fast instead of waiting out the deadline', async () => {
  const h = harness('dies', { healthTimeoutS: 60 });
  const t0 = Date.now();
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, ['container_exited_before_health']);
  assert.ok(Date.now() - t0 < 20_000);
  assert.equal(r.container.stopped, true);
});

test('schema that changes after render is a mismatch; container stopped; replay never ran', { skip: !HAVE_PY }, async () => {
  const h = harness('flaky-schema', { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL });
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, ['schema_mismatch']);
  assert.equal(r.checks.replay, undefined);
  assert.equal(r.container.stopped, true);
  assert.deepEqual(h.live(), []);
});

test('openenv validate failure fails the run and stops the container', { skip: !HAVE_PY }, async () => {
  const h = harness('ok', { openenv: FAKE_TOOL, toolMode: 'validate-fail' });
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, ['openenv_validate_exit:1', 'openenv_validate_not_passed', 'openenv_validate_failed_criteria:schema_endpoint']);
  assert.equal(r.container.stopped, true);
  const facts = toDecisionFacts(r);
  assert.ok(Object.values(facts.checks).every(c => c.ok === false), 'no check reads ok when the report is not ok');
});

test('replay that exits 0 but skips tasks, or lies about them, is caught', { skip: !HAVE_PY }, async () => {
  for (const toolMode of ['replay-subset', 'replay-lie', 'replay-fail']) {
    const h = harness('ok', { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL, toolMode });
    const r = await renderAndCheck(h.opts);
    assert.equal(r.ok, false, toolMode);
    assert.ok(r.reasons.some(x => /replay_(task_ids_differ|episodes_incomplete|exit|status)/.test(x)), `${toolMode}: ${r.reasons}`);
    assert.equal(r.container.stopped, true);
  }
});

test('a container that cannot be stopped is reported and fails the run', { timeout: 60_000 }, async () => {
  const h = harness('stop-fails', { openenv: FAKE_TOOL, toolMode: 'validate-fail' });
  const r = await renderAndCheck(h.opts);
  assert.equal(r.ok, false);
  assert.ok(r.reasons.includes('container_not_stopped'));
  assert.equal(r.container.stopped, false);
});

test('expired check containers from a killed run are swept; unexpired ones are kept', async () => {
  const h = harness('pull-fail');
  mkdirSync(join(h.state, 'containers'), { recursive: true });
  const put = (n, dl) => writeFileSync(join(h.state, 'containers', `${n}.json`), JSON.stringify({ pid: null, labels: { 'arena-flywheel.check': '1', 'arena-flywheel.deadline': String(dl) } }));
  put('arena-flywheel-check-old', NOW / 1000 - 10);
  put('arena-flywheel-check-live', NOW / 1000 + 1000);
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.checks.sweep.removed, ['arena-flywheel-check-old']);
  assert.deepEqual(h.live(), ['arena-flywheel-check-live.json']);
});

test('inputs: tag-only image, missing nowMs, non-empty out dir; module never touches the HF token', async () => {
  const h = harness('ok', { image: 'ghcr.io/ruvnet/metaharness-arena:latest' });
  const r = await renderAndCheck(h.opts);
  assert.deepEqual(r.reasons, ['image_not_digest_pinned']);
  assert.equal(h.calls().length, 0, 'no docker call at all');
  await assert.rejects(renderAndCheck({ ...harness('ok').opts, nowMs: undefined }), /nowMs/);
  const h2 = harness('ok');
  mkdirSync(h2.opts.outDir, { recursive: true });
  writeFileSync(join(h2.opts.outDir, 'x'), '');
  await assert.rejects(renderAndCheck(h2.opts), /new or empty/);
  const src = readFileSync(resolve(HERE, '../render-and-check.mjs'), 'utf8');
  assert.ok(!/readHfToken|hfTokenPath|createArenaClient|huggingface/.test(src));
});

test('CLI: SIGTERM mid-check removes the container before exiting; usage errors exit 2', { timeout: 60_000 }, async () => {
  const h = harness('no-health');
  writeFileSync(join(h.state, 'tasks.json'), JSON.stringify({ tasks: TASKS }));
  const cli = resolve(HERE, '../render-and-check.mjs');
  const args = ['--out-dir', h.opts.outDir, '--submission-id', 'flywheel-test-1', '--name', 'x', '--image', IMAGE, '--dataset', 'ruv/metaharness-arena-tasks',
    '--tasks-json', join(h.state, 'tasks.json'), '--env-dir', ENV_DIR, '--docker', join(FAKES, 'fake-docker.mjs'), '--health-timeout-s', '60', '--now-ms', String(NOW)];
  const child = spawn(process.execPath, [cli, ...args], { env: h.opts.baseEnv, stdio: 'ignore' });
  const exited = new Promise(r => child.on('close', (code, signal) => r({ code, signal })));
  for (let i = 0; i < 100 && !(existsSync(join(h.state, 'containers')) && h.live().length); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(h.live().length, 1, 'container is running');
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  assert.deepEqual(h.live(), [], 'the signal handler removed it');
  const usage = spawnSync(process.execPath, [cli, '--out-dir', join(h.state, 'u')], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /missing --submission-id/);
});

// ---- verbatim mode: what it never takes from config, what it refuses, and its CLI ----
test('verbatim: a task carrying its own image is refused (only the top-level image is pulled, run and replayed)', async () => {
  const other = 'ghcr.io/someone-else/unrelated@sha256:' + '9'.repeat(64);
  const request = storedRequest({ tasks: MIX8_TASKS.map((t, i) => (i === 1 ? { ...t, image: other } : t)) });
  const h = harness('ok', verbatimOpts(request, { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL }));
  const r = await renderAndCheck(h.opts);
  assert.equal(r.ok, false);
  assert.deepEqual(r.checks.limits.reasons, ['per_task_image_not_checked']);
  assert.ok(!h.calls().some(c => c.argv.includes(other)), 'that image was never pulled or run');
  assert.equal(r.checks.replay, undefined, 'nothing replayed');
  assert.equal(r.container.stopped, true);
});

test('verbatim: the server port is the stored body\'s, never a configured one (wire.mjs spreads config.checks into every call)', async () => {
  const published = h => h.calls().filter(c => c.argv[0] === 'run').map(c => c.argv[c.argv.indexOf('-p') + 1]);
  const a = harness('ok', verbatimOpts(storedRequest({ server_port: 9000 }), { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL, serverPort: 8000 }));
  const ra = await renderAndCheck(a.opts);
  assert.deepEqual([ra.ok, ra.checks.inspect.containerPort, published(a)], [true, 9000, ['127.0.0.1::9000']]);
  const b = harness('ok', verbatimOpts(storedRequest(), { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL, serverPort: 9100 }));
  const rb = await renderAndCheck(b.opts);
  assert.deepEqual([rb.ok, rb.checks.inspect.containerPort, published(b)], [true, 8000, ['127.0.0.1::8000']], 'none in the body: the image\'s one exposed port');
});

test('verbatim: tasks other than the request\'s, or a request that does not survive its JSON round trip, are refused', async () => {
  const h = harness('ok', verbatimOpts(storedRequest(), { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL, tasks: MIX8_TASKS.slice(1) }));
  const r = await renderAndCheck(h.opts);
  assert.deepEqual([r.ok, r.checks.render.reasons], [false, ['rendered_tasks_differ_from_input']]);
  const sparse = storedRequest(); // in memory only (JSON.parse never makes one): a hole is written as null, so the digest changes
  sparse.example_actions = Object.assign([...sparse.example_actions], { length: sparse.example_actions.length + 1 });
  const h2 = harness('ok', verbatimOpts(sparse, { openenv: FAKE_TOOL, replayArgv: FAKE_TOOL }));
  const r2 = await renderAndCheck(h2.opts);
  assert.deepEqual([r2.ok, r2.checks.render.reasons], [false, ['verbatim_request_digest_changed_on_write']]);
  assert.equal(r2.container.stopped, true);
});

test('CLI --request-json: id, name, image, dataset, tasks and port come from the request file; mixing flags exits 2', { timeout: 60_000 }, async () => {
  const cli = resolve(HERE, '../render-and-check.mjs');
  const request = storedRequest({ server_port: 8000 });
  const h = harness('ok');
  const reqPath = join(h.state, 'stored-request.json'), listPath = join(h.state, 'list.json');
  writeFileSync(reqPath, JSON.stringify(request, null, 2));
  writeFileSync(listPath, '[]');
  const tool = join(FAKES, 'fake-tool.mjs'); // stands in for openenv and for python running replay_native.py
  const args = ['--request-json', reqPath, '--out-dir', h.opts.outDir, '--env-dir', ENV_DIR, '--docker', join(FAKES, 'fake-docker.mjs'),
    '--openenv', tool, '--python', tool, '--health-timeout-s', '30', '--now-ms', String(NOW)];
  const cliRun = a => spawnSync(process.execPath, [cli, ...a], { encoding: 'utf8', env: h.opts.baseEnv, timeout: 50_000 });
  for (const extra of [['--image', IMAGE], ['--submission-id', 'x'], ['--server-port', '9000'], ['--tasks-json', reqPath], ['--no-finish-action']]) {
    const mixed = cliRun([...args, ...extra]);
    assert.equal(mixed.status, 2, extra.join(' '));
    assert.match(mixed.stderr, /--request-json takes these from the request/);
  }
  assert.equal(cliRun(args.map(a => (a === reqPath ? listPath : a))).status, 2, 'not a request object');
  assert.ok(!existsSync(h.opts.outDir), 'usage errors write nothing');
  const ok = cliRun(args);
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.ok, out.reasons, out.request_sha256], [true, [], canonicalDigest(request)]);
  const report = JSON.parse(readFileSync(out.report_path, 'utf8'));
  assert.deepEqual([report.checks.render.verbatim, report.submission_id, report.image, report.checks.inspect.containerPort, report.container.stopped],
    [true, request.submission_id, IMAGE, 8000, true]);
  assert.deepEqual(JSON.parse(readFileSync(out.request_path, 'utf8')), request, 'the request file, unchanged');
});
