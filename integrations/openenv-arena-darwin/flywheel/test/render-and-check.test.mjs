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
