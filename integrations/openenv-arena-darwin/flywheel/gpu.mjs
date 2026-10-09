// Vast.ai GPU lifecycle for the daily flywheel: spend guard -> offer -> planned ledger row -> signal traps ->
// independent LABEL-mode watchdog (armed BEFORE create) -> create (pinned vLLM digest) -> attach ssh key -> running ->
// SSH tunnel -> /v1/models -> {baseUrl, instanceId, dphTotal}. From the planned row on, every path ends in exactly
// one terminal ledger row or a still-armed watchdog: a create in flight when a signal arrives is awaited and destroyed,
// an ambiguous create is looked up by its unique label for minutes, and the watchdog destroys by label at a hard
// deadline even if this process is SIGKILLed before it ever learns the instance id.
//
// Secrets: the Vast key is fetched from Secret Manager at use time, kept in a closure and handed only to vastai
// children as VAST_API_KEY. It is never in argv, process.env, a file, the journal or an error. Raw `create`
// output (it holds instance_api_key) and raw instance rows (jupyter_token, onstart) are never kept or logged.
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeVastCli, parseSshEndpoint, redact, fetchVastKey } from './gpu-vast-cli.mjs';
import { appendRow, checkSpend, loadLedger, precheckCaps, rentalsJournaled, SpendRefused } from './gpu-spend.mjs';
import { openTunnel, probeModels } from './gpu-tunnel.mjs';
import { actualCost, destroyConfirmed, launchWatchdog, staleOpenRuns, sweepStaleRuns } from './gpu-backstop.mjs';

export { fetchVastKey } from './gpu-vast-cli.mjs';
export { destroyConfirmed, destroyInstance, launchWatchdog, recoverStaleRuns, staleOpenRuns, sweepStaleRuns, WATCHDOG_PATH,
  WATCHDOG_SLACK_S } from './gpu-backstop.mjs';

export const VLLM_VERSION = '0.31.0';
/** Resolved 2026-10-09 from docker.io/vllm/vllm-openai:latest == :v0.31.0 (manifest list). */
export const VLLM_IMAGE_LIST_DIGEST = 'sha256:c1c9f6fd5c109ba7f0546a59f5b2f15fb87f64c77782e90a27b648b42a8e67c3';
/** linux/amd64 platform manifest inside that list (recorded for provenance). */
export const VLLM_IMAGE_AMD64_DIGEST = 'sha256:a4a4c0437bf7240089da5f08aa370c4aee17ae5290f7a3b468825ee26c4c3a6b';

export const GPU_DEFAULTS = Object.freeze({
  // gpu_ram is GB in the query (CLI multiplies by 1000); offer rows report MB. cuda_vers: the image needs CUDA 13.
  offerQuery: 'gpu_ram>=78 num_gpus=1 reliability>0.98 inet_down>500 disk_space>=150 rentable=true cuda_vers>=13.0',
  minGpuRamMb: 78000, diskGb: 150, maxDphUsd: 3.5, // 3.5 x (3 + 0.25) h = 11.38 <= the 12 USD daily cap
  maxGpuHours: 3, graceHours: 0.25, // watchdog deadline = create + maxGpuHours; plan = dph x (max + grace)
  dailyCapUsd: 12, totalCapUsd: 200,
  image: `vllm/vllm-openai@${VLLM_IMAGE_LIST_DIGEST}`,
  servedModelName: 'qwen38',
  onstartCmd: 'vllm serve Qwen/Qwen3.8-27B --host 0.0.0.0 --port 8000 --max-model-len 32768 --gpu-memory-utilization 0.92 --served-model-name qwen38 --reasoning-parser qwen3',
  sshKeyPath: '~/.ssh/id_ed25519', localPort: 0,
  bootTimeoutMin: 20, modelTimeoutMin: 50, pollSec: 15, tunnelSettleSec: 3,
  attachAttempts: 5, destroyAttempts: 6, destroyBackoffSec: 10,
  ambiguousRecheckSec: 240, ambiguousPollSec: 30, // a create that may have succeeded: look for its label this long
  watchdogLauncher: 'systemd-run', // 'detached' stays in this cgroup: a systemd stop of the flywheel kills it
});

const sleepReal = (ms) => new Promise(r => setTimeout(r, ms));
const posNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const posInt = (v) => Number.isSafeInteger(v) && v > 0;

export function validateGpuConfig(cfg, runId) {
  const c = { ...GPU_DEFAULTS, ...cfg };
  if (!/^[A-Za-z0-9-]{1,48}$/.test(String(runId))) throw new Error('gpu config: runId must match [A-Za-z0-9-]{1,48}');
  for (const k of ['maxDphUsd', 'maxGpuHours', 'dailyCapUsd', 'totalCapUsd', 'minGpuRamMb', 'diskGb',
    'bootTimeoutMin', 'modelTimeoutMin', 'pollSec', 'tunnelSettleSec', 'destroyBackoffSec', 'ambiguousRecheckSec', 'ambiguousPollSec']) {
    if (!posNum(c[k])) throw new SpendRefused(`config ${k} must be a finite number > 0`);
  }
  if (!(typeof c.graceHours === 'number' && Number.isFinite(c.graceHours) && c.graceHours >= 0)) throw new SpendRefused('config graceHours invalid');
  if (c.maxGpuHours > 12) throw new SpendRefused('config maxGpuHours > 12 (watchdog horizon)');
  for (const k of ['attachAttempts', 'destroyAttempts']) if (!posInt(c[k])) throw new Error(`gpu config: ${k} must be a positive integer`);
  if (!/^vllm\/vllm-openai@sha256:[0-9a-f]{64}$/.test(c.image)) throw new Error('gpu config: image must be vllm/vllm-openai pinned by sha256 digest');
  if (typeof c.onstartCmd !== 'string' || !c.onstartCmd.trim() || /[\r\n]/.test(c.onstartCmd)) throw new Error('gpu config: onstartCmd invalid');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(c.servedModelName)) throw new Error('gpu config: servedModelName invalid');
  if (!['systemd-run', 'detached'].includes(c.watchdogLauncher)) throw new Error('gpu config: watchdogLauncher invalid');
  if (!(c.localPort === 0 || (Number.isInteger(c.localPort) && c.localPort >= 1024 && c.localPort <= 65535))) throw new Error('gpu config: localPort invalid');
  return { ...c, label: `arena-flywheel-${runId}` };
}

/** Cheapest offer that passes every local check (the server-side query is not trusted alone). */
export function selectOffer(offers, c) {
  const ok = offers.filter(o => o && posInt(o.id) && posNum(o.dph_total) && o.dph_total <= c.maxDphUsd &&
    o.num_gpus === 1 && posNum(o.gpu_ram) && o.gpu_ram >= c.minGpuRamMb);
  ok.sort((a, b) => a.dph_total - b.dph_total || a.id - b.id);
  return ok[0] ?? null;
}

/**
 * Rent one GPU and return a ready OpenAI-compatible endpoint.
 * @returns {Promise<{baseUrl:string, instanceId:number, dphTotal:number, label:string, offerId:number,
 *   deadlineEpoch:number, plannedUsd:number, teardown:() => Promise<{confirmed:boolean}>}>}
 */
export async function provisionGpu({ runId, config = {}, stateDir, journal = () => {}, now = Date.now, sleep = sleepReal,
  pathEnv = process.env.PATH, getKey, vastUrl, launch = launchWatchdog, installTraps = true, fetchImpl } = {}) {
  const c = validateGpuConfig(config, runId);
  const keyPath = String(c.sshKeyPath).replace(/^~(?=\/)/, os.homedir());
  let pub = '';
  try { pub = existsSync(keyPath) ? readFileSync(`${keyPath}.pub`, 'utf8') : ''; } catch { /* checked below */ }
  if (!/^ssh-/.test(pub)) throw new Error('gpu: ssh key pair missing (need the private key and its .pub)');
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new Error('gpu: stateDir must be an absolute path');
  const ledger = path.join(stateDir, 'spend.jsonl');
  const ev = (phase, extra = {}) => journal({ phase: `gpu.${phase}`, atMs: now(), runId, ...extra });
  const sub = (e) => journal({ ...e, atMs: now(), runId });
  const destroyOpts = { attempts: c.destroyAttempts, backoffMs: c.destroyBackoffSec * 1000, sleep, journal: sub };

  let rows = loadLedger(ledger, { nowIso: new Date(now()).toISOString(), seedIfMissing: !rentalsJournaled(stateDir) });
  if (rows.some(r => r.runId === runId)) throw new Error('gpu: runId already in the spend ledger (it must be unique per rental)');
  let cli = null;
  const getCli = async () => (cli ??= makeVastCli({ key: await (getKey ?? (() => fetchVastKey({ pathEnv })))(), pathEnv, url: vastUrl }));
  if (staleOpenRuns(rows, now()).length) { // sweeping only lowers spend, so it runs even when the caps would refuse
    const swept = await sweepStaleRuns(await getCli(), { ledger, rows, nowMs: now(), ...destroyOpts, stateDir });
    ev('swept', { runs: swept });
    rows = loadLedger(ledger, { seedIfMissing: false });
  }
  precheckCaps({ rows, nowMs: now(), dailyCapUsd: c.dailyCapUsd, totalCapUsd: c.totalCapUsd });
  await getCli();
  const { credit } = await cli.showUser();
  const offer = selectOffer(await cli.searchOffers(c.offerQuery, { storageGb: c.diskGb }), c);
  if (!offer) { ev('no_offer'); throw new SpendRefused('no offer passes the local checks'); }
  const plannedHours = c.maxGpuHours + c.graceHours;
  const plannedUsd = Math.round(offer.dph_total * plannedHours * 1e4) / 1e4;
  rows = loadLedger(ledger, { seedIfMissing: false });
  const sum = checkSpend({ rows, nowMs: now(), plannedUsd, dailyCapUsd: c.dailyCapUsd, totalCapUsd: c.totalCapUsd, credit });
  ev('spend_ok', { offerId: offer.id, dphTotal: offer.dph_total, plannedUsd, spentDaily: sum.spentDaily, spentTotal: sum.spentTotal, credit });
  const planned = { v: 1, type: 'planned', ts: new Date(now()).toISOString(), runId, usd: plannedUsd, dphTotal: offer.dph_total, hours: plannedHours, offerId: offer.id };
  appendRow(ledger, planned);

  // From the planned row on: exactly one terminal ledger row, traps before anything can be created, backstop before create.
  let terminal = false, stopping = false, instanceId = null, createdMs = null, creation = null, tunnel = null, watchdog = null, done = null;
  const close = (type, extra = {}) => { if (!terminal) { terminal = true; appendRow(ledger, { v: 1, type, ts: new Date(now()).toISOString(), runId, ...extra }); } };
  const traps = [];
  const teardown = () => (done ??= (async () => {
    for (const [sig, fn] of traps) process.off(sig, fn);
    tunnel?.close();
    const made = creation ? await creation : { kind: 'none' }; // a create in flight is awaited, never abandoned
    if (made.kind === 'none' || made.kind === 'rejected') { close('cancelled'); await watchdog?.stop(); return { confirmed: true }; }
    if (made.kind === 'ambiguous') return { confirmed: made.confirmed }; // the label watchdog stays armed unless confirmed
    const d = await destroyConfirmed(cli, instanceId, destroyOpts);
    if (d.confirmed) {
      const hours = Math.max(0, (now() - createdMs) / 3_600_000);
      close('settled', { usd: Math.round(offer.dph_total * hours * 1e4) / 1e4, hours, instanceId });
      await watchdog?.stop();
      ev('destroyed', { instanceId, destroyCalls: d.destroyCalls, hours });
    } else ev('destroy_unconfirmed', { instanceId, destroyCalls: d.destroyCalls, watchdog: watchdog?.how ?? 'none' });
    return { confirmed: d.confirmed };
  })());
  // Create; when it may have succeeded without telling us the id, look for its unique label for ambiguousRecheckSec.
  const createStep = async () => {
    try {
      instanceId = await cli.createInstance(offer.id, { image: c.image, diskGb: c.diskGb, label: c.label, onstartCmd: c.onstartCmd });
      createdMs = now();
      return { kind: 'created' };
    } catch (e) {
      if (e.definite) { close('cancelled'); ev('create_rejected', { error: e.message }); return { kind: 'rejected', error: e }; }
      ev('create_ambiguous', { error: e.message });
      let seen = 0, all = true;
      for (let waited = 0; ; waited += c.ambiguousPollSec) {
        const found = await cli.showInstancesByLabel(c.label).catch((le) => { ev('orphan_lookup_failed', { error: le.message }); return null; });
        for (const r of found ?? []) {
          const d = await destroyConfirmed(cli, r.id, destroyOpts);
          seen += 1; all &&= d.confirmed;
          ev('orphan_destroyed', { instanceId: r.id, confirmed: d.confirmed });
        }
        if (found?.length || waited >= c.ambiguousRecheckSec) break;
        await sleep(c.ambiguousPollSec * 1000);
      }
      const confirmed = seen > 0 && all;
      if (confirmed) { close('settled', { ...actualCost(planned, now()), ambiguous: true }); await watchdog?.stop(); }
      return { kind: 'ambiguous', error: e, confirmed }; // not confirmed: plan stays charged, watchdog stays armed
    }
  };

  try {
    if (installTraps) {
      for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
        const fn = () => { stopping = true; teardown().finally(() => process.exit(code)); };
        traps.push([sig, fn]); process.once(sig, fn);
      }
    }
    const deadlineEpoch = Math.ceil((now() + c.maxGpuHours * 3_600_000) / 1000);
    watchdog = await launch({ instanceId: null, deadlineEpoch, label: c.label, stateDir, launcher: c.watchdogLauncher, pathEnv, nowMs: now(), sleep });
    ev('watchdog_started', { how: watchdog.how, deadlineEpoch, mode: 'label' });
    if (stopping) throw new Error('gpu: signal before create (nothing rented)');
    creation = createStep();
    const made = await creation;
    if (made.kind !== 'created') throw made.error;
    ev('created', { instanceId, offerId: offer.id, dphTotal: offer.dph_total, image: c.image, vllmVersion: VLLM_VERSION,
      amd64Digest: c.image === GPU_DEFAULTS.image ? VLLM_IMAGE_AMD64_DIGEST : null, deadlineEpoch });
    if (stopping) throw new Error('gpu: signal during create');
    for (let i = 1; ; i += 1) {
      try { await cli.attachSsh(instanceId, `${keyPath}.pub`); break; } catch (e) {
        if (i >= c.attachAttempts) throw e;
        await sleep(c.pollSec * 1000);
      }
    }
    let endpoint = null;
    const bootUntil = now() + c.bootTimeoutMin * 60_000;
    while (!endpoint) {
      if (now() > bootUntil) throw new Error('gpu: instance not running before bootTimeoutMin');
      const row = await cli.showInstance(instanceId).catch(() => undefined);
      if (row === null) throw new Error('gpu: instance vanished while booting');
      if (row?.actual_status === 'running') endpoint = parseSshEndpoint(row);
      if (!endpoint) await sleep(c.pollSec * 1000);
    }
    ev('running', { instanceId, sshHost: endpoint.host, sshPort: endpoint.port });
    const knownHostsFile = path.join(stateDir, `known_hosts-${runId}`);
    const modelUntil = now() + c.modelTimeoutMin * 60_000;
    for (;;) {
      if (now() > modelUntil) throw new Error('gpu: /v1/models did not list the served model before modelTimeoutMin');
      if (!tunnel?.alive()) {
        tunnel = await openTunnel({ ...endpoint, keyPath, knownHostsFile, localPort: c.localPort, pathEnv, settleMs: c.tunnelSettleSec * 1000, sleep })
          .catch((e) => { ev('tunnel_retry', { error: redact(e.message) }); return null; });
      }
      if (tunnel && await probeModels(`http://127.0.0.1:${tunnel.localPort}/v1`, c.servedModelName, { fetchImpl })) break;
      await sleep(c.pollSec * 1000);
    }
    const baseUrl = `http://127.0.0.1:${tunnel.localPort}/v1`;
    ev('ready', { instanceId, baseUrl, model: c.servedModelName });
    return { baseUrl, instanceId, dphTotal: offer.dph_total, label: c.label, offerId: offer.id, deadlineEpoch, plannedUsd, teardown };
  } catch (e) {
    ev('provision_failed', { instanceId, error: redact(e.message) });
    await teardown();
    throw e;
  }
}
