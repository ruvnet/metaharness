#!/usr/bin/env node
// Render the arena request with the env lane's own renderer (submission.py, as a subprocess) and run every
// pre-submit check against the EXACT image digest. Never submits, never reads or needs the HF token.
//
//   node render-and-check.mjs --out-dir DIR --submission-id ID --name NAME --image ghcr.io/o/r@sha256:HEX \
//     --dataset owner/name --tasks-json TASKS.json [--source https://..] [--server-port N] [--no-finish-action] \
//     [--env-dir ENV] [--python P] [--openenv P] [--docker P] [--expect-env-commit SHA] [--run-id ID] \
//     [--checked-at ISO] [--now-ms N] [--health-timeout-s 120] [--validate-timeout-s 10]
//
// Order (render needs the live /schema of the very container under test):
//   sweep expired check containers -> anonymous pull (empty DOCKER_CONFIG) -> inspect (linux/amd64, digest,
//   port, start command) -> run (--pull never, 127.0.0.1 ephemeral port, 2 vCPU/16 GiB like the sandbox) ->
//   /health within 120 s -> env source hash copied OUT of that container (image-source.mjs) -> submission.py render +
//   JS/Python digest equality -> arena limits -> example actions == replayed file -> openenv validate --url ->
//   /schema equality -> replay_native.py over EVERY task id in the request. The container is stopped on every exit path.
// The env lane's scripts run with HOME/HF_HOME/XDG_CACHE_HOME in an empty dir under --out-dir and the hub offline, so
// nothing they run can reach the HF token file; their `submit` path is never invoked (the JS digest check covers it).
// stdout: {ok, reasons, request_sha256, request_path, report_path}. Exit 0 ok, 1 a check failed, 2 usage.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalDigest, sha256Hex, SHA256_RE } from './canonical-json.mjs';
import { redactText } from './arena-token.mjs'; // the generic redactor only; this module never reads a token
import { childEnv, runCmd } from './child-proc.mjs';
import { imageEnvSource } from './image-source.mjs';

export { childEnv, runCmd } from './child-proc.mjs';
import { checkReplayReport, checkRequest, checkSchema, checkValidateReport, IMAGE_DIGEST_RE, sameCanonical } from './presubmit-rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULTS = Object.freeze({
  envDir: '/home/ruvultra/projects/metaharness-arena-knobs/integrations/openenv-arena',
  python: join(ROOT, 'packages/openenv-arena/.venv/bin/python'), // websockets 17.2; persistent (not /tmp)
  openenv: join(ROOT, 'packages/openenv-arena/.venv/bin/openenv'), // arena-pinned OpenEnv 86a180ed
  docker: 'docker', healthTimeoutS: 120, validateTimeoutS: 10, pullTimeoutS: 900, renderTimeoutS: 120,
  replayTimeoutS: 1800, includeFinishAction: true,
});
export const ACTIVE_CONTAINERS = new Map(); // name -> {argv, env}; emptied by stop; used by signal handlers
const REQUIRED_CHECKS = ['inputs', 'sweep', 'pull', 'inspect', 'run', 'health', 'env_source', 'render', 'limits', 'actions', 'openenv_validate', 'schema', 'replay'];
const argvOf = x => (Array.isArray(x) ? [...x] : [x]);
const tail = s => redactText(String(s ?? '').trim().split('\n').slice(-3).join(' | ')).slice(0, 300);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const parseOr = (text, d = null) => { try { return JSON.parse(text); } catch { return d; } };
const readJsonOr = (p, d = null) => { try { return parseOr(readFileSync(p, 'utf8'), d); } catch { return d; } };
const fileSha = p => sha256Hex(readFileSync(p));

async function stopContainer(docker, name) {
  await docker(['stop', '-t', '5', name], 60);
  await docker(['rm', '-f', name], 60); // --rm usually already removed it; errors are expected and ignored
  for (let i = 0; i < 20; i++) {
    const ps = await docker(['ps', '-a', '--filter', 'label=arena-flywheel.check=1', '--format', '{{.Names}}'], 30);
    if (ps.code === 0 && !ps.stdout.split('\n').map(s => s.trim()).includes(name)) { ACTIVE_CONTAINERS.delete(name); return { name, stopped: true }; }
    await sleep(500);
  }
  return { name, stopped: false };
}

function atomicWrite(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function renderAndCheck(opts) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts ?? {}).filter(([, v]) => v !== undefined)) };
  if (!Number.isFinite(o.nowMs)) throw new TypeError('nowMs (epoch ms) must be passed in');
  const outDir = resolve(o.outDir);
  if (existsSync(outDir) && readdirSync(outDir).length) throw new Error('out dir must be new or empty');
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const anonConfig = join(outDir, 'docker-config-anon');
  mkdirSync(anonConfig, { mode: 0o700 }); // stays empty: no credentials, no credential helpers
  const baseEnv = o.baseEnv ?? process.env;
  const dockerEnv = childEnv(baseEnv, { DOCKER_CONFIG: anonConfig });
  const docker = (args, timeoutS = 120) => runCmd([...argvOf(o.docker), ...args], { env: dockerEnv, timeoutMs: timeoutS * 1000 });
  const sandbox = join(outDir, 'tool-home'); // empty: no token file, no hub cache, no user config for the env lane's scripts
  for (const d of ['', 'hf', 'cache', 'config']) mkdirSync(join(sandbox, d), { recursive: true, mode: 0o700 });
  const toolEnv = childEnv(baseEnv, { HOME: sandbox, HF_HOME: join(sandbox, 'hf'), XDG_CACHE_HOME: join(sandbox, 'cache'),
    XDG_CONFIG_HOME: join(sandbox, 'config'), HF_HUB_OFFLINE: '1' });
  const tool = (argv, timeoutS, cwd) => runCmd(argv, { cwd, env: toolEnv, timeoutMs: timeoutS * 1000 });
  const env = resolve(o.envDir);
  const p = { tasks: join(outDir, 'tasks.json'), request: join(outDir, 'request.json'), validate: join(outDir, 'openenv-validate.json'),
    replay: join(outDir, 'replay-native.json'), report: join(outDir, 'presubmit-check.json') };
  const report = { kind: 'arena_flywheel_presubmit_check', version: 1, ok: false, reasons: [], checked_at: o.checkedAt ?? null,
    image: o.image, submission_id: o.submissionId, request_sha256: null, request_path: null, checks: {}, container: null };
  const tag = /^[A-Za-z0-9_.-]{1,40}$/.test(o.runId ?? '') ? o.runId : randomBytes(6).toString('hex');
  const name = `arena-flywheel-check-${tag}`;
  const s = {}; // state shared between steps
  let started = false;

  const steps = {
    inputs: async () => {
      const reasons = [];
      if (typeof o.image !== 'string' || !IMAGE_DIGEST_RE.test(o.image)) reasons.push('image_not_digest_pinned');
      if (!Array.isArray(o.tasks) || o.tasks.length < 1) reasons.push('tasks_missing');
      const files = ['submission.py', 'scripts/replay_native.py', 'example-actions.json', 'arena_env/tasks.py', ...(o.includeFinishAction ? ['finish-action.json'] : [])];
      const missing = files.filter(f => !existsSync(join(env, f)));
      reasons.push(...missing.map(f => `env_lane_missing:${f}`));
      const git = args => spawnSync('git', ['-C', env, ...args], { encoding: 'utf8' });
      const commit = git(['rev-parse', 'HEAD']).stdout?.trim() || null;
      const dirty = (git(['status', '--porcelain', '--untracked-files=no']).stdout ?? '').trim().length > 0;
      if (o.expectEnvCommit && commit !== o.expectEnvCommit) reasons.push('env_lane_commit_mismatch');
      if (o.expectEnvCommit && dirty) reasons.push('env_lane_worktree_dirty');
      const sources = missing.length ? {} : Object.fromEntries(files.map(f => [f, fileSha(join(env, f))]));
      return { ok: !reasons.length, reasons, envDir: env, envCommit: commit, envDirty: dirty, expectEnvCommit: o.expectEnvCommit ?? null, sources };
    },
    sweep: async () => { // remove check containers left by a killed run, but only once their deadline passed
      const ps = await docker(['ps', '-a', '--filter', 'label=arena-flywheel.check=1', '--format', '{{.Names}}\t{{.Label "arena-flywheel.deadline"}}']);
      if (ps.code !== 0) return { ok: false, reasons: [`docker_unavailable:${tail(ps.stderr)}`] };
      const removed = [];
      for (const [n, dl] of ps.stdout.split('\n').filter(Boolean).map(l => l.split('\t'))) {
        if (!(Number(dl) > o.nowMs / 1000)) { await docker(['rm', '-f', n.trim()], 60); removed.push(n.trim()); }
      }
      return { ok: true, removed };
    },
    pull: async () => {
      const r = await docker(['pull', '--platform', 'linux/amd64', o.image], o.pullTimeoutS);
      return r.code === 0 ? { ok: true, anonymous: true, dockerConfigEntries: readdirSync(anonConfig) }
        : { ok: false, reasons: [`anonymous_pull_failed:${tail(r.stderr)}`] };
    },
    inspect: async () => {
      const r = await docker(['image', 'inspect', '--format', '{{json .}}', o.image]);
      const info = r.code === 0 ? parseOr(r.stdout) : null;
      if (!info) return { ok: false, reasons: [`image_inspect_failed:${tail(r.stderr)}`] };
      const reasons = [];
      const platform = `${info.Os}/${info.Architecture}`;
      if (platform !== 'linux/amd64') reasons.push(`platform_unsupported:${platform}`);
      const digest = o.image.split('@')[1];
      if (!(info.RepoDigests ?? []).some(d => d === o.image || d.endsWith('@' + digest))) reasons.push('local_image_digest_not_requested_digest');
      const ports = Object.keys(info.Config?.ExposedPorts ?? {}).filter(k => k.endsWith('/tcp')).map(k => parseInt(k, 10));
      s.containerPort = o.serverPort ?? (ports.length === 1 ? ports[0] : null);
      s.envRoot = o.imageEnvRoot ?? `${(info.Config?.WorkingDir || '/app').replace(/\/+$/, '')}/arena_env`;
      if (!Number.isInteger(s.containerPort)) reasons.push('container_port_undecidable');
      const start = [...(info.Config?.Entrypoint ?? []), ...(info.Config?.Cmd ?? [])];
      if (!start.length) reasons.push('image_has_no_entrypoint_or_cmd');
      if (start.length > 32 || start.join(' ').length > 4096) reasons.push('image_start_command_too_long');
      return { ok: !reasons.length, reasons, platform, containerPort: s.containerPort, imageId: info.Id ?? null };
    },
    run: async () => {
      const deadlineS = Math.ceil(o.nowMs / 1000) + o.healthTimeoutS + o.replayTimeoutS + 900;
      started = true;
      ACTIVE_CONTAINERS.set(name, { argv: argvOf(o.docker), env: dockerEnv });
      const r = await docker(['run', '-d', '--rm', '--pull', 'never', '--platform', 'linux/amd64', '--name', name,
        '--label', 'arena-flywheel.check=1', '--label', `arena-flywheel.deadline=${deadlineS}`,
        '--cpus', '2', '--memory', '16g', '-p', `127.0.0.1::${s.containerPort}`, o.image]);
      if (r.code !== 0) return { ok: false, reasons: [`container_start_failed:${tail(r.stderr)}`] };
      const port = await docker(['port', name, `${s.containerPort}/tcp`]);
      const hostPort = Number(port.stdout.split('\n').map(l => /^127\.0\.0\.1:(\d+)$/.exec(l.trim())?.[1]).find(Boolean));
      if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) return { ok: false, reasons: ['container_port_unpublished'] };
      s.url = `http://127.0.0.1:${hostPort}`;
      return { ok: true, name, containerId: r.stdout.trim().split('\n').pop(), hostPort, deadlineS };
    },
    health: async () => {
      const t0 = performance.now();
      for (let i = 1; performance.now() - t0 < o.healthTimeoutS * 1000; i++) {
        try {
          const res = await fetch(s.url + '/health', { redirect: 'manual', signal: AbortSignal.timeout(5000) });
          await res.body?.cancel().catch(() => {});
          if (res.status === 200) return { ok: true, seconds: Math.round(performance.now() - t0) / 1000 };
        } catch { /* not up yet */ }
        if (i % 6 === 0) { // every ~3 s: a --rm container that crashed is gone; stop waiting for it
          const ps = await docker(['ps', '--filter', 'label=arena-flywheel.check=1', '--format', '{{.Names}}'], 30);
          if (ps.code === 0 && !ps.stdout.split('\n').map(x => x.trim()).includes(name)) return { ok: false, reasons: ['container_exited_before_health'] };
        }
        await sleep(500);
      }
      return { ok: false, reasons: [`health_not_ready_within_${o.healthTimeoutS}s`] };
    },
    env_source: () => imageEnvSource({ docker, container: name, root: s.envRoot, outDir, tail }),
    render: async () => {
      atomicWrite(p.tasks, JSON.stringify({ tasks: o.tasks }, null, 2) + '\n');
      const py = [...argvOf(o.python), join(env, 'submission.py')];
      const args = ['render', '--submission-id', o.submissionId, '--name', o.name, '--image', o.image, '--dataset', o.dataset,
        '--schema-url', `${s.url}/schema`, '--example-actions-json', join(env, 'example-actions.json'), '--tasks-json', p.tasks, '--out', p.request,
        ...(o.includeFinishAction ? ['--finish-action-json', join(env, 'finish-action.json')] : []),
        ...(o.source ? ['--source', o.source] : []), ...(o.serverPort ? ['--server-port', String(o.serverPort)] : [])];
      const r = await tool([...py, ...args], o.renderTimeoutS, env);
      const out = parseOr(r.stdout);
      if (r.code !== 0 || !out) return { ok: false, reasons: [`render_failed:${tail(r.stderr)}`] };
      const reasons = [];
      if (out.mode !== 'dry-run' || out.submitted !== false) reasons.push('render_not_dry_run');
      if (!SHA256_RE.test(out.request_sha256 ?? '')) reasons.push('render_digest_missing');
      if (out.tasks !== o.tasks.length) reasons.push('render_task_count_mismatch');
      s.request = readJsonOr(p.request);
      if (!s.request) return { ok: false, reasons: [...reasons, 'rendered_request_unreadable'] };
      let jsSha = null;
      try { jsSha = canonicalDigest(s.request); } catch { reasons.push('request_not_canonical_json'); }
      if (jsSha !== out.request_sha256) reasons.push('request_digest_js_python_mismatch');
      if (!sameCanonical(s.request.tasks, o.tasks)) reasons.push('rendered_tasks_differ_from_input');
      report.request_sha256 = out.request_sha256;
      report.request_path = p.request;
      return { ok: !reasons.length, reasons, requestSha256: out.request_sha256, jsSha256: jsSha, requestFileSha256: fileSha(p.request) };
    },
    limits: async () => {
      const reasons = checkRequest(s.request, { image: o.image, dataset: o.dataset, submission_id: o.submissionId, name: o.name });
      return { ok: !reasons.length, reasons };
    },
    actions: async () => { // replay_native.py hard-wires ENV/example-actions.json, so it must BE the request's
      const reasons = [];
      s.exampleSha = fileSha(join(env, 'example-actions.json'));
      if (!sameCanonical(s.request.example_actions, readJsonOr(join(env, 'example-actions.json')))) reasons.push('example_actions_differ_from_replayed_file');
      if (o.includeFinishAction && !sameCanonical(s.request.finish_action, readJsonOr(join(env, 'finish-action.json')))) reasons.push('finish_action_differs_from_env_file');
      return { ok: !reasons.length, reasons, exampleActionsSha256: s.exampleSha };
    },
    openenv_validate: async () => {
      const r = await tool([...argvOf(o.openenv), 'validate', '--url', s.url, '--json', '--output', p.validate, '--timeout', String(o.validateTimeoutS)], 300);
      const reasons = checkValidateReport(readJsonOr(p.validate), r.code);
      return { ok: !reasons.length, reasons, reportPath: p.validate };
    },
    schema: async () => {
      let live = null;
      try {
        const res = await fetch(s.url + '/schema', { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        live = res.status === 200 ? await res.json() : null;
      } catch { live = null; }
      const c = checkSchema(live, s.request.schema);
      return { ok: !c.reasons.length, ...c };
    },
    replay: async () => {
      const argv = o.replayArgv ? argvOf(o.replayArgv) : [...argvOf(o.python), join(env, 'scripts/replay_native.py')];
      const r = await tool([...argv, '--url', s.url, '--output', p.replay, '--tasks-json', p.request], o.replayTimeoutS, env);
      const rep = readJsonOr(p.replay);
      const reasons = [...(r.code === 0 ? [] : [`replay_exit:${r.code}`]), ...checkReplayReport(rep, s.request, { exampleActionsSha256: s.exampleSha })];
      const taskIds = Array.isArray(rep?.tasks) ? rep.tasks.map(t => t?.task_id) : [];
      return { ok: !reasons.length, reasons, reportPath: p.replay, taskIds, episodesPassed: rep?.episodes_passed ?? null, episodesExpected: rep?.episodes_expected ?? null };
    },
  };

  try {
    for (const key of REQUIRED_CHECKS) {
      let r;
      try { r = await steps[key](); } catch (e) { r = { ok: false, reasons: [`${key}_error:${tail(e?.message)}`] }; }
      report.checks[key] = r;
      if (!r.ok) { report.reasons.push(...(r.reasons?.length ? r.reasons : [`${key}_failed`])); break; }
    }
  } finally {
    if (started) {
      report.container = await stopContainer(docker, name).catch(() => ({ name, stopped: false }));
      if (!report.container.stopped) report.reasons.push('container_not_stopped');
    }
  }
  report.ok = report.reasons.length === 0 && REQUIRED_CHECKS.every(k => report.checks[k]?.ok === true) && report.container?.stopped === true;
  atomicWrite(p.report, JSON.stringify(report, null, 2) + '\n');
  return { ...report, report_path: p.report };
}

/** Shape decide.mjs buildDecisionFlags() reads as `checks`. Every check is also gated on the whole report being ok. */
export function toDecisionFacts(report) {
  const c = report?.checks ?? {};
  const ok = k => ({ ok: report?.ok === true && c[k]?.ok === true });
  const whole = report?.ok === true;
  return { requestSha256: report?.request_sha256 ?? null, image: report?.image ?? null,
    envSourceSha: whole && c.env_source?.ok === true ? c.env_source.envSourceSha ?? null : null,
    envCommit: whole ? c.inputs?.envCommit ?? null : null, envDirty: whole ? c.inputs?.envDirty ?? null : null, checks: {
    anonymousPull: ok('pull'), openenvValidate: ok('openenv_validate'), schemaEqual: ok('schema'), limits: ok('limits'),
    exampleReplay: { ...ok('replay'), taskIds: Array.isArray(c.replay?.taskIds) ? [...c.replay.taskIds] : [] } } };
}

function stopAllSync() {
  for (const [n, { argv, env }] of ACTIVE_CONTAINERS) spawnSync(argv[0], [...argv.slice(1), 'rm', '-f', n], { env, stdio: 'ignore', timeout: 30_000 });
}

async function main(argv) {
  const { values: v } = parseArgs({ args: argv, options: Object.fromEntries([
    ...['out-dir', 'submission-id', 'name', 'image', 'dataset', 'tasks-json', 'source', 'server-port', 'env-dir', 'python', 'openenv',
      'docker', 'expect-env-commit', 'run-id', 'checked-at', 'now-ms', 'health-timeout-s', 'validate-timeout-s'].map(k => [k, { type: 'string' }]),
    ['no-finish-action', { type: 'boolean' }]]) });
  const need = ['out-dir', 'submission-id', 'name', 'image', 'dataset', 'tasks-json'].filter(k => !v[k]);
  if (need.length) { process.stderr.write(`missing --${need.join(', --')}\n`); return 2; }
  const raw = readJsonOr(v['tasks-json']);
  const tasks = Array.isArray(raw) ? raw : raw?.tasks;
  if (!Array.isArray(tasks)) { process.stderr.write('--tasks-json must hold a list or {tasks:[...]}\n'); return 2; }
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.on(sig, () => { stopAllSync(); process.exit(code); });
  const num = k => (v[k] === undefined ? undefined : Number(v[k]));
  const opts = Object.fromEntries(Object.entries({ outDir: v['out-dir'], submissionId: v['submission-id'], name: v.name, image: v.image,
    dataset: v.dataset, tasks, source: v.source, serverPort: num('server-port'), envDir: v['env-dir'], python: v.python,
    openenv: v.openenv, docker: v.docker, expectEnvCommit: v['expect-env-commit'], runId: v['run-id'], checkedAt: v['checked-at'],
    nowMs: num('now-ms') ?? Date.now(), healthTimeoutS: num('health-timeout-s'), validateTimeoutS: num('validate-timeout-s'),
    includeFinishAction: v['no-finish-action'] ? false : undefined }).filter(([, x]) => x !== undefined));
  try {
    const r = await renderAndCheck(opts);
    process.stdout.write(JSON.stringify({ ok: r.ok, reasons: r.reasons, request_sha256: r.request_sha256, request_path: r.request_path, report_path: r.report_path }) + '\n');
    return r.ok ? 0 : 1;
  } catch (e) {
    stopAllSync();
    process.stderr.write(redactText(e?.message ?? e) + '\n');
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
