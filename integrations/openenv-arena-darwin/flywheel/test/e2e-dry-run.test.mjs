// End-to-end DRY RUN through the REAL wiring (wire.mjs) and every real module: gpu.mjs (fake vastai/gcloud/ssh on PATH;
// fake-ssh serves /v1/models as the model endpoint), run-darwin.mjs + evaluator.mjs --dry-run, gate.mjs v2 with a pinned
// key, render-and-check.mjs (fake docker running the REAL env server; real submission.py, openenv validate and
// replay_native.py), arena-api.mjs against a local fake arena. The evaluator is dry-run, so the GPU is rented only
// through the rehearsal knob evaluator.rentGpuInDryRun. Proves: no POST, GPU destroyed on success and on failure,
// journal + report written, report.mjs renders the real status.json, and the exact decideSubmit table.
// Set E2E_KEEP=1 to keep the state dir (printed as a diagnostic).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFlywheel } from '../flywheel.mjs';
import { wireDeps } from '../wire.mjs';
import { DECISION_KEYS } from '../decide.mjs';
import { defaultConfig, deepMerge, validateConfig } from '../flywheel-config.mjs';
import { fileSigner } from '../../gate.mjs';
import { assertNoSecrets, makeShims, SENTINEL_IAK } from './gpu-fakes/shims.mjs';
import { startFakeArena } from './arena-fakes/fake-arena-server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_DIR = '/home/ruvultra/projects/metaharness-arena-knobs/integrations/openenv-arena';
// The arena-pinned OpenEnv venv: $ARENA_VENV_BIN, else the repo-local venv, else the env lane's /tmp/arena383venv.
const VENV = [process.env.ARENA_VENV_BIN, resolve(HERE, '../../../../packages/openenv-arena/.venv/bin'), '/tmp/arena383venv/bin']
  .find(d => d && existsSync(join(d, 'python')) && existsSync(join(d, 'openenv')));
const HAVE_REAL = existsSync(ENV_DIR) && Boolean(VENV);
const DATE = '2026-10-09';
const HF_FAKE = 'hf_E2EfakeTokenNotReal0123456789';
const LABEL = `arena-flywheel-fw-${DATE}-g1`;
const ROW = { id: 4242, actual_status: 'running', intended_status: 'running', label: LABEL, dph_total: 1.6, public_ipaddr: '203.0.113.5',
  ports: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '40022' }] }, jupyter_token: 'SENTINEL-JUPYTER-TOKEN-55aa01', onstart: 'vllm serve' };
const SCENARIO = {
  user: [{ stdout: { id: 1, credit: 50 } }],
  search: [{ stdout: [{ id: 77, dph_total: 1.6, num_gpus: 1, gpu_ram: 81920 }] }],
  create: [{ stdout: { success: true, new_contract: 4242, instance_api_key: SENTINEL_IAK } }],
  attach: [{ stdout: "{'success': True}\n" }],
  show: [{ stdout: { ...ROW, actual_status: 'loading', public_ipaddr: null, ports: null } }, { stdout: ROW }, { stdout: { instances: null } }],
  destroy: [{ stdout: '' }],
  showAll: [{ stdout: [] }],
};
const readJsonl = p => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

async function rehearse(t, darwinOver = {}, checksOver = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-e2e-'));
  const keyDir = mkdtempSync(join(tmpdir(), 'fw-e2e-key-'));
  const shims = makeShims({ scenario: SCENARIO });
  const arena = await startFakeArena();
  t.after(async () => {
    await arena.close();
    shims.cleanup();
    if (process.env.E2E_KEEP === '1') t.diagnostic(`kept state: ${home}`);
    else rmSync(home, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  });
  const tokenFile = join(home, 'hf-token');
  writeFileSync(tokenFile, `${HF_FAKE}\n`, { mode: 0o600 });
  const stateDir = join(home, 'state');
  const config = validateConfig(deepMerge(defaultConfig(home), {
    mode: 'dry-run',
    darwin: { generations: 2, children: 3, concurrency: 2, maxTotalNewCells: 20, seed: 6, evaluatorTimeoutMs: 120_000, searchTimeoutMs: 240_000, ...darwinOver },
    // ^ seed 6 found an improver in the dry-run landscape at Darwin 763bd802; the main test falls back to a seed scan
    evaluator: { dryRun: true, rentGpuInDryRun: true, cacheDir: join(home, 'cell-cache') },
    gate: { keyDir, expectPublicKey: fileSigner(keyDir).publicKey() },
    gpu: { localPort: 0, sshKeyPath: shims.keyPath, pollSec: 0.05, tunnelSettleSec: 0.3, destroyBackoffSec: 0.05, bootTimeoutMin: 1, modelTimeoutMin: 1 },
    arena: { base: arena.base },
    poll: { attempts: 0 },
  }), home);
  const launches = [];
  const dockerDir = join(home, 'docker');
  const deps = await wireDeps({ config, stateDir, env: { PATH: process.env.PATH, HOME: home, HF_TOKEN_PATH: tokenFile }, seams: {
    gpu: { pathEnv: shims.pathEnv, installTraps: false,
      launch: async a => { const l = { ...a, stopped: false }; launches.push(l); return { how: 'fake watchdog', stop: () => { l.stopped = true; } }; } },
    checks: { docker: [process.execPath, join(HERE, 'arena-fakes', 'fake-docker.mjs')], healthTimeoutS: 60,
      python: join(VENV, 'python'), openenv: join(VENV, 'openenv'),
      baseEnv: { PATH: process.env.PATH, HOME: home, FAKE_DOCKER_DIR: dockerDir, FAKE_DOCKER_MODE: 'real-env', FAKE_ENV_DIR: ENV_DIR,
        FAKE_ENV_PYTHON: join(VENV, 'python') }, ...checksOver },
  } });
  const st = await runFlywheel({ config, date: DATE, now: `${DATE}T14:17:00.000Z`, stateDir, deps }); // 10:17 Toronto on DATE
  const journal = readJsonl(join(stateDir, 'journal.jsonl'));
  return { st, home, stateDir, shims, arena, launches, journal, dockerDir, ledger: readJsonl(join(stateDir, 'spend.jsonl')) };
}

function assertGpuDestroyed(r) {
  const cmds = r.shims.vastCalls().map(c => c.cmd);
  assert.deepEqual(cmds.slice(0, 5), ['user', 'search', 'create', 'attach', 'show'], cmds.join(','));
  const d = cmds.indexOf('destroy');
  assert.ok(d > 0 && cmds[d + 1] === 'show', `destroy then show: ${cmds.join(',')}`);
  assert.equal(r.shims.vastCalls('destroy')[0].argv.includes('4242'), true);
  assert.equal(r.st.gpu.destroyed, true);
  assert.deepEqual(r.ledger.map(x => x.type), ['seed', 'planned', 'settled'], 'spend ledger closed at the actual estimate');
  assert.deepEqual(r.launches.map(l => [l.instanceId, l.label, l.stopped]), [[null, LABEL, true]],
    'label-mode watchdog armed before create, then stopped after the confirmed destroy');
  const ev = r.journal.filter(e => e.phase === 'gpu').map(e => e.event);
  assert.ok(ev.indexOf('gpu.watchdog_started') < ev.indexOf('gpu.created'), 'no instance ever existed without a watchdog');
  assert.ok(r.journal.some(e => e.event === 'gpu.destroyed' && e.instanceId === 4242));
  assert.equal(r.journal.filter(e => e.phase === 'gpu' && e.event === 'down').length, 1);
  assert.equal(r.shims.sshCalls().length >= 1, true, 'the tunnel (fake ssh serving /v1/models) was opened');
}

function assertNoPostAndNoLeak(r) {
  assert.equal(r.arena.requests.filter(q => q.method !== 'GET').length, 0, 'no POST (or any non-GET) reached the arena');
  for (const q of r.arena.requests) {
    const authed = q.path === '/api/openenv/submissions';
    assert.equal(Boolean(q.headers.authorization), authed, `${q.path}: token only on the authenticated list`);
    if (authed) assert.equal(q.headers.authorization, `Bearer ${HF_FAKE}`);
  }
  const texts = [JSON.stringify(r.journal), JSON.stringify(r.ledger)];
  for (const dir of [join(r.stateDir, 'reports', DATE)]) for (const f of readdirSync(dir)) texts.push(readFileSync(join(dir, f), 'utf8'));
  for (const t of texts) assert.ok(!t.includes(HF_FAKE.slice(3)), 'HF token leaked');
  assertNoSecrets(assert, ...texts);
  assert.equal(existsSync(join(r.stateDir, 'pending-submission.json')), false);
  assert.equal(existsSync(join(r.stateDir, 'incumbent.json')), false);
}

test('e2e dry run: real wiring, fake GPU + arena + docker, real Darwin/gate/checks -> needs-human, no POST, GPU destroyed', { skip: !HAVE_REAL, timeout: 900_000 }, async (t) => {
  // The dry-run landscape is the Darwin lane's toy (it moves with lib/fitness.mjs): find a search seed with an improver.
  let r = null;
  for (const seed of [6, ...Array.from({ length: 24 }, (_, i) => i)]) {
    r = await rehearse(t, { seed });
    assert.equal(r.st.error, undefined, r.st.error);
    assertGpuDestroyed(r);
    assertNoPostAndNoLeak(r);
    if (r.st.candidate) break;
    assert.equal(r.st.outcome, 'needs-human', 'day 1 without an improver: v2-defaults request for a human');
  }
  const { st } = r;
  assert.equal(st.error, undefined, st.error);
  assert.equal(st.mode, 'dry-run');
  assertGpuDestroyed(r);
  assertNoPostAndNoLeak(r);
  // preflight read the (fake) public board and the authenticated slot; day 1 agrees with the board
  assert.deepEqual([st.arena.connected, st.arena.hasIncumbent, st.incumbent.day1, st.incumbent.boardAgrees], [true, false, true, true]);
  assert.equal(st.slot.preflight.free, true);
  // search -> preregistered confirmation -> real gate v2 (verified against the pinned key) -> real checks
  assert.equal(st.darwin.evidence, 'evaluator_dry_run_fake_rows_not_model_rollouts');
  assert.ok(st.candidate, 'some search seed finds a one-param improvement in the dry-run landscape');
  assert.equal(st.confirmation.preregistered, true);
  assert.equal(st.confirmation.candidateBudget, st.darwin.selection.evaluated);
  assert.equal(st.gate.verified, true);
  assert.equal(st.gate.publicKeyPinned, true);
  assert.equal(st.gate.promote, false);
  assert.ok(st.gate.reasons.some(x => x.startsWith('confirmation_underpowered')), String(st.gate.reasons));
  assert.equal(st.gate.bindingSupported, false);
  assert.equal(st.request.ok, true, String(st.request.reasons));
  assert.equal(st.needsHuman.ok, true, String(st.needsHuman.reasons));
  assert.deepEqual(readJsonl(join(r.dockerDir, 'calls.jsonl')).filter(c => c.argv[0] === 'pull').length, 2);
  // the decideSubmit table: exactly these conditions fail; everything else holds on real (fake-backed) evidence
  // (no checks.expectEnvCommit in this config; a dry-run plan's envSourceSha is DRY_SHA, never the image's env source)
  assert.deepEqual(Object.keys(st.flags), [...DECISION_KEYS]);
  assert.deepEqual(st.decision.reasons, ['modeAuto', 'darwinEvidenceIsScorecards', 'confirmationNotDryRun', 'gatePromote',
    'requestDigestBoundInGateReceipt', 'envLaneCommitPinned', 'imageEnvSourceMatchesPlan']);
  // the real image-source step hashed the env source served by the (fake-docker) container: the knob worktree's
  const src = st.request.reportPath && JSON.parse(readFileSync(st.request.reportPath, 'utf8')).checks.env_source;
  assert.equal(src.ok, true);
  assert.match(src.envSourceSha, /^[0-9a-f]{64}$/);
  assert.equal(st.wouldSubmitInAuto, false);
  assert.equal(st.outcome, 'needs-human');
  // journal + reports, and the short reporter renders the real status.json
  for (const f of ['status.json', 'report.md']) assert.ok(existsSync(join(r.stateDir, 'reports', DATE, f)));
  assert.ok(r.journal.some(e => e.phase === 'confirm-plan' && e.event === 'registered' && e.planHash === st.confirmation.planHash));
  const rep = spawnSync(process.execPath, [join(HERE, '..', 'report.mjs'), '--state-dir', r.stateDir, '--date', DATE, '--today', DATE,
    '--now', new Date().toISOString(), '--format', 'both'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: r.home } });
  assert.equal(rep.status, 0, rep.stderr);
  assert.match(rep.stdout, /needs-human/);
  assert.match(rep.stdout, /requestDigestBoundInGateReceipt/);
  t.diagnostic(`decision: ${JSON.stringify(st.decision.reasons)}; gate: ${JSON.stringify(st.gate.reasons)}`);
});

test('e2e failure path: the real search fails after the rental -> error, GPU still destroyed, no POST', { skip: !HAVE_REAL, timeout: 600_000 }, async (t) => {
  const r = await rehearse(t, { maxTotalNewCells: 0 }); // the budget refuses even the baseline: run-darwin aborts (exit 3)
  assert.equal(r.st.outcome, 'error');
  assert.match(r.st.error, /darwin_search_failed/);
  assertGpuDestroyed(r);
  assertNoPostAndNoLeak(r);
  assert.equal(r.st.decision, undefined);
  assert.ok(existsSync(join(r.stateDir, 'reports', DATE, 'status.json')));
});

test('e2e: missing pre-submit check tools are refused BEFORE any rental (no vastai call, nothing planned)', { skip: !HAVE_REAL, timeout: 120_000 }, async (t) => {
  const r = await rehearse(t, {}, { python: '/nonexistent/arena-venv/bin/python' });
  assert.equal(r.st.outcome, 'error');
  assert.match(r.st.error, /render-and-check inputs missing.*\/nonexistent\/arena-venv\/bin\/python/);
  assert.deepEqual([r.shims.vastCalls().length, r.shims.gcloudCalls().length, r.launches.length], [0, 0, 0]);
  assert.deepEqual(r.ledger.map(x => x.type), ['seed'], 'no planned row: nothing was about to be rented');
  assert.equal(r.arena.requests.filter(q => q.method !== 'GET').length, 0);
});
