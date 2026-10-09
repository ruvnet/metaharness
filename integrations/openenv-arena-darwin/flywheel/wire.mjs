// The single integration seam: builds the real `deps` for flywheel.mjs from the sibling modules
// (arena-api.mjs, render-and-check.mjs, gpu.mjs, gpu-spend.mjs) and darwin-steps.mjs.
//
// `seams` exists only for the end-to-end rehearsal (test/e2e-dry-run.test.mjs): it routes the REAL modules to
// local fakes without changing any decision code. Production (flywheel.mjs main) never passes it.
//   seams.gpu:    {pathEnv, getKey, vastUrl, launch, installTraps, sleep}  -> provisionGpu/destroyInstance/recoverStaleRuns
//   seams.arena:  {fetchImpl, tokenPath, getRetries, sleep}               -> createArenaClient (base still from config.arena.base)
//   seams.checks: extra renderAndCheck options (docker, baseEnv, envDir, python, openenv, healthTimeoutS, ...)
//   seams.darwinConfig: config used for darwin-steps only (e.g. a dry-run evaluator while the GPU is still rented)
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeDarwinSteps } from './darwin-steps.mjs';
import { pidAlive, readJsonIfExists } from './journal.mjs';

export async function wireDeps({ config, stateDir, env = process.env, seams = {} }) {
  const [arenaMod, rc, gpuMod, spend] = await Promise.all([
    import('./arena-api.mjs'), import('./render-and-check.mjs'), import('./gpu.mjs'), import('./gpu-spend.mjs')]);
  const { user: _user, ...arenaOpts } = config.arena ?? {};
  const client = arenaMod.createArenaClient({ ...arenaOpts, env, ...(seams.arena ?? {}) });
  const gpuConfig = { dailyCapUsd: config.caps.dailyUsd, totalCapUsd: config.caps.totalUsd, ...config.gpu };
  const g = seams.gpu ?? {};
  const gpuIo = Object.fromEntries(Object.entries({ pathEnv: g.pathEnv, getKey: g.getKey, vastUrl: g.vastUrl, sleep: g.sleep })
    .filter(([, v]) => v !== undefined));
  const ledger = join(stateDir, 'spend.jsonl');
  const checkOpts = { ...rc.DEFAULTS, ...config.checks, ...(seams.checks ?? {}) };
  return {
    pid: process.pid, isPidAlive: pidAlive,
    clock: () => new Date().toISOString(), nowMs: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)),
    notify: null, // the report files + the unit's journal are the notification; Slack is never approval
    darwin: await makeDarwinSteps(seams.darwinConfig ?? config, { env }),
    renderCheck: {
      run: opts => rc.renderAndCheck({ ...config.checks, ...(seams.checks ?? {}), ...opts }), toDecisionFacts: rc.toDecisionFacts,
      /** Offline, before any rental: the check tools exist (a missing venv would otherwise surface only after GPU spend). */
      ready() {
        const bin = v => (Array.isArray(v) ? v[0] : v);
        const need = [bin(checkOpts.python), bin(checkOpts.openenv), join(checkOpts.envDir, 'submission.py'), join(checkOpts.envDir, 'scripts', 'replay_native.py')];
        const missing = need.filter(p => typeof p !== 'string' || !existsSync(p));
        if (missing.length) throw new Error(`render-and-check inputs missing (set checks.python / checks.openenv / checks.envDir): ${missing.join(', ')}`);
        return true;
      },
    },
    arena: {
      status: () => client.status(), // public
      async standing(user) { return arenaMod.userStanding(await client.leaderboard(), user); }, // public
      async slot(nowMs) {
        return arenaMod.slotStatus({ submissions: await client.listSubmissions(), nowMs, quota: currentQuota(stateDir, nowMs) });
      },
      async getSubmission(id) { const s = await client.getSubmission(id); return s ? arenaMod.summarizeSubmission(s, id) : null; },
      submit: args => client.submit(args),
    },
    gpu: {
      precheck(nowMs) { // seeds the 5.00 USD prior spend once, and never again once any rental was journaled
        const rows = spend.loadLedger(ledger, { nowIso: new Date(nowMs).toISOString(), seedIfMissing: !spend.rentalsJournaled(stateDir) });
        return spend.precheckCaps({ rows, nowMs, dailyCapUsd: gpuConfig.dailyCapUsd, totalCapUsd: gpuConfig.totalCapUsd });
      },
      // Runs every day, renting or not. No ledger yet = nothing was ever rented = nothing to sweep (and no seed write).
      recover: nowMs => (existsSync(ledger) ? gpuMod.recoverStaleRuns({ stateDir, now: () => nowMs, ...gpuIo }) : []),
      up: ({ runId, journal }) => gpuMod.provisionGpu({ runId, config: gpuConfig, stateDir, journal, ...gpuIo,
        ...(g.launch ? { launch: g.launch } : {}), ...(g.installTraps === undefined ? {} : { installTraps: g.installTraps }) }),
      down: handle => handle.teardown(),
      // by id; a ledger run still open for it is settled at its real duration (not its plan)
      destroy: (instanceId, { runId } = {}) => gpuMod.destroyInstance(instanceId, { ...gpuIo, runId, stateDir }),
    },
  };
}

/**
 * quota.json (a 429 seen at submit) for slotStatus: a missing retry_after_s means the arena's 24 h window from when
 * it was observed, and an expired record is deleted so it can never block a later day. Pure apart from that unlink.
 */
export function currentQuota(stateDir, nowMs) {
  const path = join(stateDir, 'quota.json');
  const q = readJsonIfExists(path);
  if (!q) return null;
  const at = q.observedAtMs;
  if (!Number.isFinite(at)) return q; // unreadable observation time: slotStatus reports it (fail closed, human fixes)
  const r = Number.isFinite(q.retryAfterS) && q.retryAfterS >= 0 ? q.retryAfterS : 24 * 3600;
  if (at + r * 1000 <= nowMs) { try { unlinkSync(path); } catch { /* already gone */ } return null; }
  return { ...q, retryAfterS: r };
}
