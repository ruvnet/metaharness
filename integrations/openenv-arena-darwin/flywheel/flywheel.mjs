#!/usr/bin/env node
// Daily OpenEnv Arena submission flywheel: a deterministic, journaled, resumable state machine.
//
//   node --experimental-strip-types flywheel/flywheel.mjs --date YYYY-MM-DD [--now ISO] [--mode dry-run|auto]
//        [--config ~/.config/arena-flywheel/config.json] [--state-dir ~/.local/state/arena-flywheel]
//
// preflight (orphan GPUs, stale ledger runs, pending submission, arena status + leaderboard, slot, spend) ->
// incumbent (day 1 = lib/cells.mjs defaults, and the public board must agree) -> gpu up -> search (run-darwin
// from the incumbent, its own confirmation off) -> PREREGISTERED paired confirmation (plan hash journaled before
// any rollout; both genomes on one fresh date-derived seed block) -> gpu down -> render + checks -> gate.mjs v2
// (--run search report + confirmation cards + Darwin-derived pairs; request digest bound when gate.mjs supports
// it) -> decide (facts re-derived from disk by recheck.mjs; pure decideSubmit, no LLM) -> submit (auto only) ->
// incumbent update only once `validated` -> report. gpu down also runs in `finally` on every path. Default mode is
// dry-run, which never POSTs; --mode can only downgrade (auto needs config.json mode "auto" too).
//
// deps (wire.mjs builds the real ones; tests inject fakes):
//   pid, isPidAlive(pid), clock() -> ISO, nowMs() -> epoch ms, sleep(ms), notify(summary)?   (only the CLI reads real time)
//   darwin: darwin-steps.mjs contract (cells, ready, expectedProvenance, search, evaluate, gate, verify, digestOf)
//   gpu:    precheck(nowMs) (throws SpendRefused), recover(nowMs)?, up({runId, journal}) -> {instanceId, baseUrl,
//           deadlineEpoch, ...}, down(handle) -> {confirmed}, destroy(instanceId) -> {confirmed}   (gpu.mjs)
//   renderCheck: run(opts) -> render-and-check.mjs report, toDecisionFacts(report)
//   arena:  status() -> {connected}, standing(user) -> arena-slot.mjs userStanding, slot(nowMs) -> {free, reasons,
//           freeAtMs}, getSubmission(id) -> summary|null, submit({request, approvedSha256, receiptPath}) -> receipt
// Exit: 0 run finished (any decision), 2 usage/config, 3 run error (GPU still torn down), 75 another run holds the lock.
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalDigest } from './canonical-json.mjs';
import { cardMatchesGenome, changedFamilies, confirmationPlan, confirmSeedBase, dayIndex, pairedOutcomes, pairedPower,
  preregistered, provenanceMatches } from './confirm.mjs';
import { decideAndSubmit, gatePhase, renderPhase } from './finish.mjs';
import { writeReport } from './flywheel-report.mjs';
import { loadIncumbent } from './incumbent.mjs';
import { acquireLock, LockedError, openJournal, readJson, redact, runStep, writeJsonAtomic } from './journal.mjs';
import { boardAgrees, preflight, rentsGpu } from './preflight.mjs';

export { orphanInstances } from './preflight.mjs';

export const EXIT = Object.freeze({ ok: 0, usage: 2, error: 3, locked: 75 });
const scoreOf = c => (c ? { primary: c.primary, noopRate: c.noopRate, costPerWin: c.costPerWin, regressed: c.regressed, evaluatorError: c.evaluatorError ?? null } : null);

/** --mode may only DOWNGRADE: auto needs config.json to say auto as well (the flag alone never enables a POST). */
export function effectiveMode(flag, configMode) {
  if (flag !== undefined && flag !== 'dry-run' && flag !== 'auto') throw new Error(`invalid mode: ${flag}`);
  if (configMode !== 'dry-run' && configMode !== 'auto') throw new Error(`invalid mode: ${configMode}`);
  return flag === 'dry-run' || configMode === 'dry-run' ? 'dry-run' : 'auto';
}

export async function runFlywheel({ config, date, now, mode, stateDir, deps }) {
  const runMode = effectiveMode(mode, config.mode);
  dayIndex(date);
  if (!Number.isFinite(Date.parse(now))) throw new Error(`invalid --now: ${now}`);
  const lock = acquireLock(stateDir, { pid: deps.pid, date, startedAt: now, isPidAlive: deps.isPidAlive });
  const st = { kind: 'arena_flywheel_status', version: 1, date, mode: runMode, startedAt: now, outcome: null, notes: [], slot: {}, gpu: {} };
  if (mode === 'auto' && runMode !== 'auto') st.notes.push('--mode auto ignored: config.json says dry-run (the flag can only downgrade)');
  let j = null;
  const x = { config, date, now, stateDir, deps, st, gpu: null };
  try {
    j = x.j = openJournal({ stateDir, date, clock: deps.clock });
    x.runDir = j.runDir;
    j.append('run', 'start', { mode: runMode, startedAt: now, lockReclaimed: lock.reclaimed });
    await phases(x);
  } catch (e) {
    st.outcome = 'error';
    st.error = redact(e?.message ?? e);
    try { j?.append('run', 'error', { error: st.error }); } catch { /* journal unavailable: the report still says error */ }
  } finally {
    await gpuDown(x, 'finally');
    try { st.files = writeReport(stateDir, st); } catch (e) { st.reportError = redact(e?.message); }
    try { await deps.notify?.({ date, mode: runMode, outcome: st.outcome, submit: st.decision?.submit ?? false, reasons: st.decision?.reasons ?? [], report: st.files?.markdownPath ?? null }); }
    catch (e) { st.notes.push(`notify failed: ${redact(e?.message)}`); }
    try { j?.append('run', 'end', { outcome: st.outcome }); } catch { /* best effort */ }
    lock.release();
  }
  return st;
}

async function phases(x) {
  const { j, st, deps, config } = x;
  await preflight(x, { gpuWorkPending: gpuWorkPending(j) });
  if (st.outcome) return;
  const inc = await runStep(j, 'incumbent', () => loadIncumbent(x.stateDir, deps.darwin.cells));
  st.incumbent = { day1: inc.day1, source: inc.source, genomeDigest: inc.genomeDigest, submissionId: inc.submissionId };
  if (!j.last('submit', 'intent') && loadIncumbent(x.stateDir, deps.darwin.cells).genomeDigest !== inc.genomeDigest) {
    st.outcome = 'incumbent-changed'; // a pending submission was validated after this date's run stored its incumbent
    st.notes.push('incumbent changed since this date first ran: this date is skipped; the next date starts from the new incumbent');
    return;
  }
  st.incumbent.boardAgrees = boardAgrees(inc, st.arena);
  if (st.incumbent.boardAgrees === false && gpuWorkPending(j)) { // searching from the wrong incumbent wastes the GPU
    st.outcome = 'incumbent-mismatch';
    st.notes.push(`local incumbent (${inc.day1 ? 'day 1, v2 defaults' : `submission ${inc.submissionId}`}) disagrees with the public leaderboard for "${config.arena.user}" (listed: ${st.arena?.hasIncumbent}) or its newest validated own submission (${st.arena?.latestValidatedId ?? 'none'}): a human must reconcile ${x.stateDir}/incumbent.json`);
    return;
  }
  if (st.incumbent.boardAgrees === null) st.notes.push('leaderboard standing unknown (unreachable or truncated): auto-submit is blocked for this run');
  let search = j.done('search');
  if (gpuWorkPending(j)) {
    await deps.darwin.ready(); // the evaluator and the pre-submit check tools must be runnable BEFORE anything is rented
    await deps.renderCheck.ready?.();
    if (!rentsGpu(config)) st.notes.push('evaluator.dryRun: fake rows, no GPU rented (rehearsal only; can never submit)');
    else {
      if (config.evaluator.dryRun) st.notes.push('evaluator.dryRun + rentGpuInDryRun: GPU lifecycle rehearsal with fake rows (can never submit)');
      await gpuUp(x);
      if (!st.outcome) await verifyEndpoint(x);
    }
    if (st.outcome) return;
  }
  search ??= await runStep(j, 'search', () => searchPhase(x, inc));
  st.darwin = { evidence: search.evidence, improvedOverBaseline: search.improvedOverBaseline, winnerId: search.winnerId,
    reportPath: search.reportPath, selection: search.selection ?? null };
  const cand = search.candidate;
  let plan = null, conf = null;
  if (cand) {
    st.candidate = { variantId: cand.variantId, genomeDigest: cand.genomeDigest, lineage: cand.lineage };
    plan = await runStep(j, 'confirm-plan', () => planPhase(x, inc, cand, search));
    st.candidate.changedFamilies = plan.plan.changedFamilies;
    conf = await runStep(j, 'confirm', () => confirmPhase(x, plan));
    st.confirmation = { planHash: plan.planHash, seedRange: plan.plan.seedRange, attempts: plan.plan.attempts,
      candidateBudget: plan.plan.gate.candidateBudget, power: plan.power, ...conf };
    if (!plan.power.reachable) st.notes.push(`paired gate cannot reach significance: at most ${plan.power.maxDiscordant} paired blocks, ${plan.power.needed} needed at candidateBudget ${plan.plan.gate.candidateBudget} (needs >= ${plan.power.attemptsPerChangedCellNeeded ?? '?'} confirmation.attempts; otherwise needs-human)`);
  }
  await gpuDown(x, 'after-confirmation');
  const contextTokens = plan?.plan.expectedProvenance.contextTokens ?? config.evaluator.contextTokens;
  let req = null, gate = null;
  if (conf) {
    req = st.request = await renderPhase(x, 'candidate', cand.genome, contextTokens);
    const pg = plan.plan.gate; // the PREREGISTERED test: a config change after the cards were seen cannot loosen it
    gate = st.gate = await gatePhase(x, conf, req, { runPath: search.reportPath, candidateBudget: pg.candidateBudget,
      alpha: Number(pg.alpha), lambda: Number(pg.lambda) });
    if (!gate.bindingSupported) st.notes.push('gate.mjs cannot bind the request digest yet (Darwin-lane change request): auto-submit stays blocked');
  }
  if (inc.day1 && !(gate?.promote === true && gate?.verified === true)) {
    st.needsHuman = await renderPhase(x, 'needs-human', inc.genome, contextTokens);
  }
  await decideAndSubmit(x, { inc, search, cand, plan, conf, req, gate });
}

const gpuWorkPending = j => { const s = j.done('search'); return !s || (Boolean(s.candidate) && !j.done('confirm')); };

async function gpuUp(x) {
  const { j, st, deps } = x;
  const runId = `fw-${x.date}-g${j.find('gpu', 'up-start').length + 1}`;
  j.append('gpu', 'up-start', { runId });
  let h;
  try { h = await deps.gpu.up({ runId, journal: e => j.append('gpu', String(e?.phase ?? 'event'), e) }); } catch (e) {
    if (e?.name !== 'SpendRefused') throw e;
    st.outcome = 'budget-refused';
    st.notes.push(redact(e.message));
    j.append('gpu', 'refused', { runId, reason: e.message });
    return;
  }
  x.gpu = h;
  st.gpu = { runId, instanceId: h.instanceId, baseUrl: h.baseUrl, deadlineEpoch: h.deadlineEpoch ?? null, plannedUsd: h.plannedUsd ?? null, destroyed: false };
  j.append('gpu', 'up', { runId, instanceId: h.instanceId, baseUrl: h.baseUrl, deadlineEpoch: h.deadlineEpoch ?? null, plannedUsd: h.plannedUsd ?? null });
}

async function gpuDown(x, why) {
  if (!x.gpu) return;
  const h = x.gpu;
  x.gpu = null;
  let confirmed = false, error = null;
  try { confirmed = (await x.deps.gpu.down(h))?.confirmed === true; } catch (e) { error = redact(e?.message ?? e); }
  x.st.gpu.destroyed = confirmed;
  if (error) x.st.gpu.downError = error;
  if (!confirmed) x.st.notes.push(`GPU ${h.instanceId} destroy NOT confirmed (watchdog + next run's orphan sweep will retry)`);
  try { x.j?.append('gpu', 'down', { instanceId: h.instanceId, why, confirmed, error }); } catch { /* journal unavailable */ }
}

/** One GET before any rollout: the rented endpoint serves the configured model and yields a provenance (serverSha). */
async function verifyEndpoint(x) {
  const d = x.config.darwin;
  const p = await x.deps.darwin.expectedProvenance({ seedBase: d.searchSeedBase, attempts: d.searchAttempts, baseUrl: x.gpu?.baseUrl });
  x.st.gpu.serverSha = p?.serverSha ?? null;
  x.j.append('gpu', 'endpoint-verified', { instanceId: x.gpu?.instanceId ?? null, serverSha: p?.serverSha ?? null, model: p?.model ?? null });
}

/** Remaining rented time for a GPU phase (the watchdog destroys at deadlineEpoch). */
function gpuTimeLeft(x, capMs) {
  const dl = x.gpu?.deadlineEpoch;
  if (!Number.isFinite(dl)) return capMs;
  const left = dl * 1000 - x.deps.nowMs() - x.config.darwin.gpuDeadlineMarginMs;
  if (left <= 0) throw new Error('gpu_deadline_reached: not enough rented time left for this phase');
  return Math.min(capMs, left);
}

async function searchPhase(x, inc) {
  const { j, deps, config } = x;
  const workRoot = join(x.runDir, `darwin-${j.find('search', 'start').length}`);
  const report = await deps.darwin.search({ workRoot, incumbentGenome: inc.genome, baseUrl: x.gpu?.baseUrl,
    seed: config.darwin.seed ?? dayIndex(x.date), timeoutMs: gpuTimeLeft(x, config.darwin.searchTimeoutMs) });
  if (report?.kind !== 'openenv_arena_darwin_run' || report.oneParamInvariant?.ok !== true) throw new Error('darwin_report_invalid');
  const w = report.winner;
  const better = w && w.variantId !== 'baseline' && w.improvedOverBaseline === true && canonicalDigest(w.genome) !== inc.genomeDigest;
  return { evidence: report.evidence, improvedOverBaseline: w?.improvedOverBaseline === true, winnerId: w?.variantId ?? null,
    reportPath: join(workRoot, 'reports', 'darwin-run.json'), selection: report.selection ?? null,
    budget: report.budget ?? null, baselineScore: report.baseline?.score ?? null,
    candidate: better ? { variantId: w.variantId, genome: w.genome, genomeDigest: canonicalDigest(w.genome), lineage: w.lineage ?? [], searchScore: w.score } : null };
}

async function planPhase(x, inc, cand, search) {
  const { j, deps, config } = x;
  const q = config.confirmation;
  // gate.mjs v2 splits alpha over candidateBudget; null in config = the gate's own default, the search's evaluated count.
  const candidateBudget = config.gate.candidateBudget ?? search.selection?.evaluated;
  if (!Number.isSafeInteger(candidateBudget) || candidateBudget < 1) throw new Error('candidate_budget_unknown: search report has no selection.evaluated');
  const g = { ...config.gate, candidateBudget };
  const seedBase = confirmSeedBase(x.date, q);
  const expectedProvenance = await deps.darwin.expectedProvenance({ seedBase, attempts: q.attempts, baseUrl: x.gpu?.baseUrl });
  const changed = changedFamilies(deps.darwin.cells.genomeToCells, inc.genome, cand.genome);
  const { plan, planHash } = confirmationPlan({ date: x.date, incumbent: inc, candidate: cand, seedBase, attempts: q.attempts,
    expectedProvenance, image: config.image, gate: g, changed });
  const power = pairedPower({ changedFamilies: changed.length, attempts: q.attempts, alpha: g.alpha, lambda: g.lambda, candidateBudget });
  const probed = j.last('gpu', 'endpoint-verified')?.serverSha;
  if (probed && expectedProvenance.serverSha && probed !== expectedProvenance.serverSha) {
    x.st.notes.push('search and confirmation endpoints differ (serverSha); the confirmation itself is internally consistent');
  }
  const planPath = writeJsonAtomic(join(x.runDir, 'confirm', 'plan.json'), plan);
  j.append('confirm-plan', 'registered', { planHash, seedBase, attempts: q.attempts, runnerSha: expectedProvenance.runnerSha,
    envSourceSha: expectedProvenance.envSourceSha, image: config.image, incumbent: inc.genomeDigest, candidate: cand.genomeDigest });
  return { plan, planHash, planPath, power };
}

async function confirmPhase(x, p) {
  const { j, deps, config } = x;
  if (!preregistered(j.entries(), p.planHash, readJson(p.planPath))) throw new Error('confirmation_plan_not_preregistered: refusing to roll out');
  const { plan } = p;
  const cells = deps.darwin.cells;
  const run = (genome, variantId) => deps.darwin.evaluate({ genome, variantId, seedBase: plan.seedBase, attempts: plan.attempts,
    maxNewCells: cells.FAMILIES.length, baseUrl: x.gpu?.baseUrl, timeoutMs: gpuTimeLeft(x, config.confirmation.evaluateTimeoutMs) });
  const incCard = await run(plan.incumbent.genome, 'incumbent');
  const candCard = await run(plan.candidate.genome, 'candidate');
  const dir = join(x.runDir, 'confirm');
  let paired = null, pairedError = null;
  try { paired = pairedOutcomes(incCard, candCard); } catch (e) { pairedError = redact(e?.message); } // = gate.mjs v2's derivation
  return {
    preregistered: true, incumbentCardPath: writeJsonAtomic(join(dir, 'incumbent-card.json'), incCard),
    candidateCardPath: writeJsonAtomic(join(dir, 'candidate-card.json'), candCard),
    pairedPath: paired ? writeJsonAtomic(join(dir, 'paired.json'), paired) : null, pairedCount: paired?.length ?? 0, pairedError,
    provenanceMatchesPlan: provenanceMatches(incCard, plan.expectedProvenance) && provenanceMatches(candCard, plan.expectedProvenance),
    cardsMatchGenomes: cardMatchesGenome(incCard, cells.genomeToCells, plan.incumbent.genome) && cardMatchesGenome(candCard, cells.genomeToCells, plan.candidate.genome),
    dryRun: incCard?.raw?.dryRun === false && candCard?.raw?.dryRun === false ? false : true,
    incumbentScore: scoreOf(incCard), candidateScore: scoreOf(candCard),
  };
}

async function main(argv, env = process.env) {
  let o;
  try {
    o = parseArgs({ args: argv, strict: true, options: { date: { type: 'string' }, now: { type: 'string' }, mode: { type: 'string' },
      config: { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean' } } }).values;
    if (o.help) { process.stdout.write('usage: flywheel.mjs --date YYYY-MM-DD [--now ISO] [--mode dry-run|auto] [--config P] [--state-dir D]\n'); return EXIT.ok; }
    if (!o.date) throw new Error('--date YYYY-MM-DD is required (from the shell)');
    dayIndex(o.date);
    if (o.mode !== undefined && o.mode !== 'dry-run' && o.mode !== 'auto') throw new Error('--mode must be dry-run or auto');
  } catch (e) { process.stderr.write(`flywheel: ${redact(e.message)}\n`); return EXIT.usage; }
  const { defaultConfigPath, defaultStateDir, loadConfig } = await import('./flywheel-config.mjs');
  let config, deps;
  const stateDir = resolve(o['state-dir'] ?? env.ARENA_FLYWHEEL_STATE_DIR ?? defaultStateDir(env));
  try {
    config = loadConfig(o.config ?? env.ARENA_FLYWHEEL_CONFIG ?? defaultConfigPath(env));
    deps = await (await import('./wire.mjs')).wireDeps({ config, stateDir, env });
  } catch (e) { process.stderr.write(`flywheel: ${redact(e.message)}\n`); return EXIT.usage; }
  try {
    const st = await runFlywheel({ config, date: o.date, now: o.now ?? deps.clock(), mode: o.mode, stateDir, deps });
    process.stdout.write(`${JSON.stringify({ date: st.date, mode: st.mode, outcome: st.outcome, submit: st.decision?.submit ?? false,
      reasons: st.decision?.reasons ?? [], report: st.files?.markdownPath ?? null, error: st.error ?? null })}\n`);
    return st.outcome === 'error' ? EXIT.error : EXIT.ok;
  } catch (e) {
    process.stderr.write(`flywheel: ${redact(e.message)}\n`);
    return e instanceof LockedError ? EXIT.locked : EXIT.error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
